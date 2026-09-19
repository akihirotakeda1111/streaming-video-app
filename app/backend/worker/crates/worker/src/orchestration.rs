//! Reliability bridge for a parent Step Functions execution.
//!
//! This module owns coordination only. Publication, child-result validation,
//! parent manifest assembly, and distributed completion belong to the finalizer
//! supplied by the later distributed-publication task.

use std::{fmt, future::Future, pin::Pin, sync::Arc, time::Duration};

use chrono::{DateTime, SecondsFormat, Utc};
use persistence::JobMode;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::acquisition::AcquiredJob;

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5);
pub const SQS_VISIBILITY_LIFETIME: Duration = Duration::from_secs(43_200);
pub const ALLOWED_RENDITIONS: [&str; 2] = ["360p", "720p"];

const START_RECOVERY_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionInput {
    pub video_id: String,
    pub job_id: String,
    pub attempt: u32,
    pub execution_id: String,
    pub source_key: String,
    pub output_prefix: String,
    pub renditions: Vec<String>,
    pub deadline_at: String,
}

impl ExecutionInput {
    pub fn for_job(
        job: &AcquiredJob,
        renditions: Vec<String>,
        deadline_at: impl Into<String>,
    ) -> Result<Self, OrchestrationError> {
        let execution_id = execution_name(&job.item.job_id, job.attempt);
        let source_key = canonical_source_key(&job.item.video_id, &job.item.job_id);
        let output_prefix = canonical_output_prefix(
            &job.item.video_id,
            &job.item.job_id,
            job.attempt,
            &execution_id,
        );
        if job.item.key != source_key {
            return Err(OrchestrationError::Start(
                "source key identity mismatch".into(),
            ));
        }
        let input = Self {
            video_id: job.item.video_id.clone(),
            job_id: job.item.job_id.clone(),
            attempt: job.attempt,
            execution_id,
            source_key,
            output_prefix,
            renditions,
            deadline_at: deadline_at.into(),
        };
        input.validate()?;
        Ok(input)
    }

    pub fn validate(&self) -> Result<(), OrchestrationError> {
        validate_renditions(&self.renditions)?;
        if self.execution_id != execution_name(&self.job_id, self.attempt) {
            return Err(OrchestrationError::Start(
                "execution_id identity mismatch".into(),
            ));
        }
        if self.source_key != canonical_source_key(&self.video_id, &self.job_id) {
            return Err(OrchestrationError::Start(
                "source key identity mismatch".into(),
            ));
        }
        if self.output_prefix
            != canonical_output_prefix(
                &self.video_id,
                &self.job_id,
                self.attempt,
                &self.execution_id,
            )
        {
            return Err(OrchestrationError::Start(
                "output prefix identity mismatch".into(),
            ));
        }
        parse_deadline(&self.deadline_at)?;
        Ok(())
    }

    pub fn payload_json(&self) -> Result<String, OrchestrationError> {
        serde_json::to_string(self)
            .map_err(|_| OrchestrationError::Start("invalid execution input".into()))
    }
}

pub fn execution_name(job_id: &str, attempt: u32) -> String {
    format!("job-{job_id}-a{attempt}")
}

pub fn canonical_renditions() -> Vec<String> {
    ALLOWED_RENDITIONS
        .iter()
        .map(|rendition| (*rendition).to_owned())
        .collect()
}

pub fn canonical_source_key(video_id: &str, job_id: &str) -> String {
    format!("videos/{video_id}/jobs/{job_id}/source.mp4")
}

pub fn canonical_output_prefix(
    video_id: &str,
    job_id: &str,
    attempt: u32,
    execution_id: &str,
) -> String {
    format!("videos/{video_id}/jobs/{job_id}/hls/attempts/{attempt}/{execution_id}")
}

/// Immutable parent deadline from the ReceiveMessage start, the worker's finite
/// processing budget, and a positive completion margin. Heartbeats do not extend it.
pub fn deadline_from_receive(
    receive_started_at: Instant,
    processing_budget: Duration,
    completion_margin: Duration,
) -> Result<(String, Instant), OrchestrationError> {
    let budget = processing_budget.min(SQS_VISIBILITY_LIFETIME);
    if completion_margin.is_zero() || completion_margin >= budget {
        return Err(OrchestrationError::TimedOut);
    }
    let deadline = receive_started_at + (budget - completion_margin);
    if Instant::now() >= deadline {
        return Err(OrchestrationError::TimedOut);
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    let wall = std::time::SystemTime::now() + remaining;
    Ok((
        DateTime::<Utc>::from(wall).to_rfc3339_opts(SecondsFormat::Secs, true),
        deadline,
    ))
}

fn validate_renditions(renditions: &[String]) -> Result<(), OrchestrationError> {
    if renditions.is_empty() || renditions.len() > 2 {
        return Err(OrchestrationError::Start(
            "renditions must contain one or two allowed identifiers".into(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for rendition in renditions {
        if !ALLOWED_RENDITIONS.contains(&rendition.as_str()) || !seen.insert(rendition) {
            return Err(OrchestrationError::Start(
                "renditions must be unique 360p and/or 720p".into(),
            ));
        }
    }
    Ok(())
}

fn parse_deadline(value: &str) -> Result<DateTime<Utc>, OrchestrationError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| OrchestrationError::Start("invalid deadline_at".into()))
}

fn input_matches(expected: &ExecutionInput, json: &str) -> bool {
    let Ok(actual) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    let Ok(expected) = serde_json::to_value(expected) else {
        return false;
    };
    actual == expected
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionStatus {
    Running,
    Succeeded,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionInspection {
    NotFound,
    Found {
        status: ExecutionStatus,
        input_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrchestrationError {
    Permission,
    Start(String),
    Describe(String),
    Failed,
    TimedOut,
    OwnershipLost,
    Finalizer(String),
}

impl fmt::Display for OrchestrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Permission => "orchestration permission denied",
            Self::Start(_) => "orchestration start failed",
            Self::Describe(_) => "orchestration inspection failed",
            Self::Failed => "orchestration failed",
            Self::TimedOut => "orchestration timed out",
            Self::OwnershipLost => "orchestration ownership lost",
            Self::Finalizer(_) => "orchestration finalizer failed",
        })
    }
}
impl std::error::Error for OrchestrationError {}

fn describe_is_retryable(error: &OrchestrationError) -> bool {
    matches!(error, OrchestrationError::Describe(_))
}

pub trait ExecutionClient: Send + Sync {
    fn start(
        &self,
        name: &str,
        input: &ExecutionInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>>;
    fn status(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionStatus, OrchestrationError>> + Send + '_>>;
    fn inspect(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionInspection, OrchestrationError>> + Send + '_>>;
    fn cancel(&self, name: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

impl<T: ExecutionClient + ?Sized> ExecutionClient for Arc<T> {
    fn start(
        &self,
        name: &str,
        input: &ExecutionInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>> {
        (**self).start(name, input)
    }

    fn status(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionStatus, OrchestrationError>> + Send + '_>>
    {
        (**self).status(name)
    }

    fn inspect(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionInspection, OrchestrationError>> + Send + '_>>
    {
        (**self).inspect(name)
    }

    fn cancel(&self, name: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        (**self).cancel(name)
    }
}

pub trait Finalizer: Send + Sync {
    fn finalize(
        &self,
        job: &AcquiredJob,
        input: &ExecutionInput,
        ownership: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>>;
}

impl<T: Finalizer + ?Sized> Finalizer for Arc<T> {
    fn finalize(
        &self,
        job: &AcquiredJob,
        input: &ExecutionInput,
        ownership: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>> {
        (**self).finalize(job, input, ownership)
    }
}

/// Production stand-in until the distributed publication task supplies the
/// concrete finalizer. Succeeding here would skip master publication.
pub struct UnpublishedFinalizer;

impl Finalizer for UnpublishedFinalizer {
    fn finalize(
        &self,
        _: &AcquiredJob,
        _: &ExecutionInput,
        ownership: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>> {
        Box::pin(async move {
            if *ownership.borrow() {
                return Err(OrchestrationError::OwnershipLost);
            }
            Err(OrchestrationError::Finalizer(
                "distributed publication is not available".into(),
            ))
        })
    }
}

/// Used when no Step Functions adapter is configured. Distributed jobs fail
/// into the existing owned retry/failure path instead of skipping coordination.
pub struct UnavailableExecutionClient;

impl ExecutionClient for UnavailableExecutionClient {
    fn start(
        &self,
        _: &str,
        _: &ExecutionInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>> {
        Box::pin(async {
            Err(OrchestrationError::Start(
                "execution client is not configured".into(),
            ))
        })
    }

    fn status(
        &self,
        _: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionStatus, OrchestrationError>> + Send + '_>>
    {
        Box::pin(async {
            Err(OrchestrationError::Describe(
                "execution client is not configured".into(),
            ))
        })
    }

    fn inspect(
        &self,
        _: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionInspection, OrchestrationError>> + Send + '_>>
    {
        Box::pin(async {
            Err(OrchestrationError::Describe(
                "execution client is not configured".into(),
            ))
        })
    }

    fn cancel(&self, _: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
}

pub struct OrchestrationBridge<C, F> {
    pub client: C,
    pub finalizer: F,
    pub poll_interval: Duration,
}

impl<C, F> OrchestrationBridge<C, F>
where
    C: ExecutionClient,
    F: Finalizer,
{
    pub async fn run(
        &self,
        job: &AcquiredJob,
        input: &ExecutionInput,
        mut ownership: watch::Receiver<bool>,
        mut shutdown: watch::Receiver<bool>,
        deadline: Instant,
    ) -> Result<(), OrchestrationError> {
        input.validate()?;
        let name = execution_name(&job.item.job_id, job.attempt);
        if lost(&ownership, &shutdown) {
            self.client.cancel(&name).await;
            return Err(OrchestrationError::OwnershipLost);
        }
        if Instant::now() >= deadline {
            return Err(OrchestrationError::TimedOut);
        }
        self.establish_previous_bound(job, &mut ownership, &mut shutdown, deadline)
            .await?;
        self.start_or_attach(&name, input, &mut ownership, &mut shutdown, deadline)
            .await?;
        let mut delay = self.poll_interval.max(Duration::from_millis(1));
        let mut last_describe_error = None;
        let mut saw_running = false;
        loop {
            if lost(&ownership, &shutdown) {
                self.client.cancel(&name).await;
                return Err(OrchestrationError::OwnershipLost);
            }
            if let Some(error) = self
                .expire_if_deadline(&name, deadline, last_describe_error.as_ref(), saw_running)
                .await
            {
                return Err(error);
            }
            match until_deadline(deadline, self.client.status(&name)).await {
                Err(OrchestrationError::TimedOut) => {
                    return Err(self
                        .expire(&name, last_describe_error.as_ref(), saw_running)
                        .await);
                }
                Ok(Ok(ExecutionStatus::Running)) => {
                    saw_running = true;
                    last_describe_error = None;
                    if let Err(error) =
                        wait_or_signal(delay, deadline, &mut ownership, &mut shutdown).await
                    {
                        self.client.cancel(&name).await;
                        return Err(error);
                    }
                    delay = (delay * 2).min(MAX_POLL_INTERVAL);
                }
                Ok(Ok(ExecutionStatus::Succeeded)) => {
                    if lost(&ownership, &shutdown) {
                        self.client.cancel(&name).await;
                        return Err(OrchestrationError::OwnershipLost);
                    }
                    if Instant::now() >= deadline {
                        return Err(OrchestrationError::TimedOut);
                    }
                    return match until_deadline(
                        deadline,
                        self.finalizer.finalize(job, input, ownership),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => Err(OrchestrationError::TimedOut),
                    };
                }
                Ok(Ok(ExecutionStatus::Failed)) => return Err(OrchestrationError::Failed),
                Ok(Ok(ExecutionStatus::TimedOut)) => return Err(OrchestrationError::TimedOut),
                Ok(Err(error)) if describe_is_retryable(&error) => {
                    last_describe_error = Some(error);
                    if let Err(error) =
                        wait_or_signal(delay, deadline, &mut ownership, &mut shutdown).await
                    {
                        self.client.cancel(&name).await;
                        if matches!(error, OrchestrationError::TimedOut) {
                            if let Some(describe) = last_describe_error {
                                if !saw_running {
                                    return Err(describe);
                                }
                            }
                            return Err(OrchestrationError::TimedOut);
                        }
                        return Err(error);
                    }
                    delay = (delay * 2).min(MAX_POLL_INTERVAL);
                }
                Ok(Err(error)) => {
                    self.client.cancel(&name).await;
                    return Err(error);
                }
                Err(error) => {
                    self.client.cancel(&name).await;
                    return Err(error);
                }
            }
        }
    }

    async fn expire_if_deadline(
        &self,
        name: &str,
        deadline: Instant,
        last_describe_error: Option<&OrchestrationError>,
        saw_running: bool,
    ) -> Option<OrchestrationError> {
        if Instant::now() < deadline {
            return None;
        }
        Some(self.expire(name, last_describe_error, saw_running).await)
    }

    async fn expire(
        &self,
        name: &str,
        last_describe_error: Option<&OrchestrationError>,
        saw_running: bool,
    ) -> OrchestrationError {
        self.client.cancel(name).await;
        if !saw_running {
            if let Some(error) = last_describe_error {
                return error.clone();
            }
        }
        OrchestrationError::TimedOut
    }

    async fn establish_previous_bound(
        &self,
        job: &AcquiredJob,
        ownership: &mut watch::Receiver<bool>,
        shutdown: &mut watch::Receiver<bool>,
        deadline: Instant,
    ) -> Result<(), OrchestrationError> {
        if job.attempt <= 1 {
            return Ok(());
        }
        let previous = execution_name(&job.item.job_id, job.attempt - 1);
        let mut delay = self.poll_interval.max(Duration::from_millis(1));
        loop {
            if lost(ownership, shutdown) {
                self.client.cancel(&previous).await;
                return Err(OrchestrationError::OwnershipLost);
            }
            if Instant::now() >= deadline {
                return Err(self.fail_previous_bound(&previous).await);
            }
            let inspection = match until_deadline(deadline, self.client.inspect(&previous)).await {
                Ok(result) => result,
                Err(_) => return Err(self.fail_previous_bound(&previous).await),
            };
            match inspection {
                Ok(ExecutionInspection::NotFound) => return Ok(()),
                Ok(ExecutionInspection::Found { status, .. }) => match status {
                    ExecutionStatus::Failed
                    | ExecutionStatus::TimedOut
                    | ExecutionStatus::Succeeded => return Ok(()),
                    ExecutionStatus::Running => {
                        self.client.cancel(&previous).await;
                        match wait_or_signal(delay, deadline, ownership, shutdown).await {
                            Ok(()) => {}
                            Err(OrchestrationError::TimedOut) => {
                                return Err(self.fail_previous_bound(&previous).await);
                            }
                            Err(error) => {
                                self.client.cancel(&previous).await;
                                return Err(error);
                            }
                        }
                        delay = (delay * 2).min(MAX_POLL_INTERVAL);
                    }
                },
                Err(error) if describe_is_retryable(&error) => {
                    match wait_or_signal(delay, deadline, ownership, shutdown).await {
                        Ok(()) => {}
                        Err(OrchestrationError::TimedOut) => {
                            return Err(self.fail_previous_bound(&previous).await);
                        }
                        Err(wait_error) => {
                            self.client.cancel(&previous).await;
                            return Err(wait_error);
                        }
                    }
                    delay = (delay * 2).min(MAX_POLL_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn fail_previous_bound(&self, previous: &str) -> OrchestrationError {
        self.client.cancel(previous).await;
        OrchestrationError::Describe("previous execution bound not established".into())
    }

    async fn start_or_attach(
        &self,
        name: &str,
        input: &ExecutionInput,
        ownership: &mut watch::Receiver<bool>,
        shutdown: &mut watch::Receiver<bool>,
        deadline: Instant,
    ) -> Result<(), OrchestrationError> {
        let mut last_error = None;
        for _ in 0..START_RECOVERY_ATTEMPTS {
            if lost(ownership, shutdown) {
                self.client.cancel(name).await;
                return Err(OrchestrationError::OwnershipLost);
            }
            if Instant::now() >= deadline {
                self.client.cancel(name).await;
                return Err(OrchestrationError::TimedOut);
            }
            match until_deadline(deadline, self.client.start(name, input)).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(OrchestrationError::Permission)) => {
                    return Err(OrchestrationError::Permission);
                }
                Err(_) => {
                    self.client.cancel(name).await;
                    return Err(OrchestrationError::TimedOut);
                }
                Ok(Err(error)) => {
                    match until_deadline(deadline, self.resolve_existing(name, input)).await {
                        Ok(Ok(Attach::Ready)) => return Ok(()),
                        Ok(Ok(Attach::Terminal(error))) => return Err(error),
                        Ok(Err(inspect_error)) if describe_is_retryable(&inspect_error) => {
                            last_error = Some(inspect_error);
                        }
                        Ok(Err(OrchestrationError::Start(_))) => {
                            last_error = Some(error);
                        }
                        Ok(Err(inspect_error)) => return Err(inspect_error),
                        Err(_) => {
                            self.client.cancel(name).await;
                            return Err(OrchestrationError::TimedOut);
                        }
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            self.client.cancel(name).await;
            return Err(OrchestrationError::TimedOut);
        }
        match until_deadline(deadline, self.resolve_existing(name, input)).await {
            Ok(Ok(Attach::Ready)) => Ok(()),
            Ok(Ok(Attach::Terminal(error))) => Err(error),
            Ok(Err(_)) | Err(_) => Err(last_error.unwrap_or_else(|| {
                OrchestrationError::Start("execution start could not be resolved".into())
            })),
        }
    }

    async fn resolve_existing(
        &self,
        name: &str,
        input: &ExecutionInput,
    ) -> Result<Attach, OrchestrationError> {
        match self.client.inspect(name).await? {
            ExecutionInspection::NotFound => Err(OrchestrationError::Start(
                "execution was not found after an ambiguous start".into(),
            )),
            ExecutionInspection::Found { status, input_json } => {
                if !input_matches(input, &input_json) {
                    return Ok(Attach::Terminal(OrchestrationError::Start(
                        "conflicting execution input".into(),
                    )));
                }
                match status {
                    ExecutionStatus::Running | ExecutionStatus::Succeeded => Ok(Attach::Ready),
                    ExecutionStatus::Failed => Ok(Attach::Terminal(OrchestrationError::Failed)),
                    ExecutionStatus::TimedOut => Ok(Attach::Terminal(OrchestrationError::TimedOut)),
                }
            }
        }
    }
}

enum Attach {
    Ready,
    Terminal(OrchestrationError),
}

fn lost(ownership: &watch::Receiver<bool>, shutdown: &watch::Receiver<bool>) -> bool {
    *ownership.borrow() || *shutdown.borrow()
}

async fn until_deadline<T>(
    deadline: Instant,
    fut: impl Future<Output = T>,
) -> Result<T, OrchestrationError> {
    tokio::time::timeout_at(deadline, fut)
        .await
        .map_err(|_| OrchestrationError::TimedOut)
}

async fn wait_or_signal(
    delay: Duration,
    deadline: Instant,
    ownership: &mut watch::Receiver<bool>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), OrchestrationError> {
    if lost(ownership, shutdown) {
        return Err(OrchestrationError::OwnershipLost);
    }
    let now = Instant::now();
    if now >= deadline {
        return Err(OrchestrationError::TimedOut);
    }
    let wait = delay.min(deadline.saturating_duration_since(now));
    tokio::select! {
        _ = tokio::time::sleep(wait) => {}
        result = ownership.changed() => {
            if result.is_err() || *ownership.borrow() {
                return Err(OrchestrationError::OwnershipLost);
            }
        }
        result = shutdown.changed() => {
            if result.is_err() || *shutdown.borrow() {
                return Err(OrchestrationError::OwnershipLost);
            }
        }
    }
    if lost(ownership, shutdown) {
        return Err(OrchestrationError::OwnershipLost);
    }
    if Instant::now() >= deadline {
        return Err(OrchestrationError::TimedOut);
    }
    Ok(())
}

/// Marker used by the runtime to ensure this path cannot be selected by a
/// deployment until the concrete distributed finalizer is installed.
pub const DEPLOYMENT_MODE: JobMode = JobMode::Cli;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        event::WorkItem,
        fakes::{FakeExecutionClient, FakeFinalizer},
    };
    use std::time::SystemTime;

    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const DEADLINE: &str = "2026-08-25T03:04:00Z";

    fn job_with(attempt: u32) -> AcquiredJob {
        AcquiredJob {
            item: WorkItem {
                bucket: "in".into(),
                key: canonical_source_key(VIDEO_ID, JOB_ID),
                video_id: VIDEO_ID.into(),
                job_id: JOB_ID.into(),
            },
            worker_id: crate::acquisition::WorkerIdentity::from_value("worker").unwrap(),
            attempt,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        }
    }

    fn job() -> AcquiredJob {
        job_with(1)
    }

    fn input_for(job: &AcquiredJob) -> ExecutionInput {
        ExecutionInput::for_job(job, canonical_renditions(), DEADLINE).unwrap()
    }

    fn channels() -> (
        watch::Sender<bool>,
        watch::Receiver<bool>,
        watch::Sender<bool>,
        watch::Receiver<bool>,
    ) {
        let (stop, ownership) = watch::channel(false);
        let (shutdown_stop, shutdown) = watch::channel(false);
        (stop, ownership, shutdown_stop, shutdown)
    }

    fn far_deadline() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    #[test]
    fn parent_input_identities_match_task01_contract() {
        let input = input_for(&job());
        assert_eq!(
            input.execution_id,
            "job-018f47a2-4699-7892-9fc0-fbe46d3bbd67-a1"
        );
        assert_eq!(
            input.source_key,
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4"
        );
        assert_eq!(
            input.output_prefix,
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/hls/attempts/1/job-018f47a2-4699-7892-9fc0-fbe46d3bbd67-a1"
        );
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../contracts/examples/internal/parent-input.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(&input).unwrap(), fixture);
    }

    #[test]
    fn execution_input_rejects_invalid_renditions_and_mismatched_keys() {
        let job = job();
        assert!(ExecutionInput::for_job(&job, vec!["low".into()], DEADLINE).is_err());
        assert!(
            ExecutionInput::for_job(&job, vec!["360p".into(), "360p".into()], DEADLINE).is_err()
        );
        let mut mismatched = job.clone();
        mismatched.item.key = "videos/other/source.mp4".into();
        assert!(ExecutionInput::for_job(&mismatched, canonical_renditions(), DEADLINE).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn succeeded_execution_is_handed_to_finalizer() {
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Succeeded)]);
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        bridge
            .run(
                &job(),
                &input_for(&job()),
                ownership,
                shutdown,
                far_deadline(),
            )
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn ownership_loss_cancels_without_calling_finalizer() {
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Running)]);
        let cancellations = client.cancellations.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_secs(1),
        };
        let (stop, ownership, _shutdown_stop, shutdown) = channels();
        stop.send(true).unwrap();
        assert_eq!(
            bridge
                .run(
                    &job(),
                    &input_for(&job()),
                    ownership,
                    shutdown,
                    far_deadline()
                )
                .await,
            Err(OrchestrationError::OwnershipLost)
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert_eq!(
            cancellations.lock().unwrap().as_slice(),
            [execution_name(JOB_ID, 1)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn lost_start_response_attaches_to_the_same_execution_name() {
        let job = job();
        let input = input_for(&job);
        let name = execution_name(JOB_ID, 1);
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Succeeded)]);
        client.fail_start(OrchestrationError::Start("lost response".into()));
        client.seed_execution(&name, input.clone());
        let starts = client.starts.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        bridge
            .run(&job, &input, ownership, shutdown, far_deadline())
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), 1);
        let started = starts.lock().unwrap();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].0, name);
        assert_eq!(started[0].1, input);
    }

    #[tokio::test(start_paused = true)]
    async fn conflicting_existing_input_does_not_create_a_new_name() {
        let job = job();
        let input = input_for(&job);
        let name = execution_name(JOB_ID, 1);
        let mut conflicting = input.clone();
        conflicting.deadline_at = "2026-08-25T04:00:00Z".into();
        let client = FakeExecutionClient::new(vec![]);
        client.fail_start(OrchestrationError::Start("already exists".into()));
        client.seed_execution(&name, conflicting);
        let starts = client.starts.clone();
        let cancellations = client.cancellations.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        assert_eq!(
            bridge
                .run(&job, &input, ownership, shutdown, far_deadline())
                .await,
            Err(OrchestrationError::Start(
                "conflicting execution input".into()
            ))
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert!(cancellations.lock().unwrap().is_empty());
        assert!(
            starts
                .lock()
                .unwrap()
                .iter()
                .all(|(started, _)| started == &name)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn already_failed_execution_is_not_restarted_under_a_new_name() {
        let job = job();
        let input = input_for(&job);
        let name = execution_name(JOB_ID, 1);
        let client = FakeExecutionClient::new(vec![]);
        client.fail_start(OrchestrationError::Start("already exists".into()));
        client.seed_execution_with_status(&name, input.clone(), ExecutionStatus::Failed);
        let starts = client.starts.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        assert_eq!(
            bridge
                .run(&job, &input, ownership, shutdown, far_deadline())
                .await,
            Err(OrchestrationError::Failed)
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert!(
            starts
                .lock()
                .unwrap()
                .iter()
                .all(|(started, _)| started == &name)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn transient_describe_errors_retry_then_succeed() {
        let client = FakeExecutionClient::new(vec![
            Err(OrchestrationError::Describe("throttled".into())),
            Ok(ExecutionStatus::Succeeded),
        ]);
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let cancellations = client.cancellations.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        bridge
            .run(
                &job(),
                &input_for(&job()),
                ownership,
                shutdown,
                far_deadline(),
            )
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), 1);
        assert!(cancellations.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn unresolvable_describe_cancels_without_finalizer() {
        let client = FakeExecutionClient::new(vec![]);
        client.keep_failing_status(OrchestrationError::Describe("unavailable".into()));
        let cancellations = client.cancellations.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        assert_eq!(
            bridge
                .run(
                    &job(),
                    &input_for(&job()),
                    ownership,
                    shutdown,
                    far_deadline()
                )
                .await,
            Err(OrchestrationError::Describe("unavailable".into()))
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert_eq!(
            cancellations.lock().unwrap().as_slice(),
            [execution_name(JOB_ID, 1)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn non_retryable_status_error_cancels_without_finalizer() {
        let client = FakeExecutionClient::new(vec![Err(OrchestrationError::Permission)]);
        let cancellations = client.cancellations.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        assert_eq!(
            bridge
                .run(
                    &job(),
                    &input_for(&job()),
                    ownership,
                    shutdown,
                    far_deadline()
                )
                .await,
            Err(OrchestrationError::Permission)
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert_eq!(
            cancellations.lock().unwrap().as_slice(),
            [execution_name(JOB_ID, 1)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn later_attempt_cancels_the_previous_execution_name() {
        let job = job_with(2);
        let input = input_for(&job);
        let previous = execution_name(JOB_ID, 1);
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Succeeded)]);
        client.seed_execution(&previous, input_for(&job_with(1)));
        let cancellations = client.cancellations.clone();
        let starts = client.starts.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer: FakeFinalizer::new(Ok(())),
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        bridge
            .run(&job, &input, ownership, shutdown, far_deadline())
            .await
            .unwrap();
        assert_eq!(cancellations.lock().unwrap().as_slice(), [previous]);
        assert_eq!(starts.lock().unwrap()[0].0, execution_name(JOB_ID, 2));
    }

    #[test]
    fn deadline_uses_processing_budget_not_remaining_visibility() {
        let receive = Instant::now();
        let budget = Duration::from_secs(7_200);
        let margin = Duration::from_secs(30);
        let (rfc3339, instant) = deadline_from_receive(receive, budget, margin).unwrap();
        assert_eq!(
            instant.saturating_duration_since(receive),
            Duration::from_secs(7_170)
        );
        assert!(instant.saturating_duration_since(Instant::now()) > Duration::from_secs(7_000));
        let parsed = parse_deadline(&rfc3339).unwrap();
        let expected =
            DateTime::<Utc>::from(std::time::SystemTime::now() + Duration::from_secs(7_170));
        assert!((parsed - expected).num_seconds().abs() <= 1);
        assert!(
            deadline_from_receive(receive, Duration::from_secs(30), Duration::from_secs(30))
                .is_err()
        );
        assert!(deadline_from_receive(receive, Duration::from_secs(30), Duration::ZERO).is_err());
        let (_, capped) = deadline_from_receive(
            receive,
            Duration::from_secs(50_000),
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(
            capped.saturating_duration_since(receive),
            SQS_VISIBILITY_LIFETIME - Duration::from_secs(30)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn polling_stops_at_absolute_deadline_and_cancels() {
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Running)]);
        let cancellations = client.cancellations.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        let deadline = Instant::now() + Duration::from_millis(5);
        assert_eq!(
            bridge
                .run(&job(), &input_for(&job()), ownership, shutdown, deadline)
                .await,
            Err(OrchestrationError::TimedOut)
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert_eq!(
            cancellations.lock().unwrap().as_slice(),
            [execution_name(JOB_ID, 1)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn previous_running_execution_blocks_new_children_until_bound() {
        let job = job_with(2);
        let input = input_for(&job);
        let previous = execution_name(JOB_ID, 1);
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Succeeded)]);
        client.seed_execution(&previous, input_for(&job_with(1)));
        client.hold_running_after_cancel();
        let starts = client.starts.clone();
        let cancellations = client.cancellations.clone();
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership, _shutdown_stop, shutdown) = channels();
        let deadline = Instant::now() + Duration::from_millis(8);
        assert_eq!(
            bridge
                .run(&job, &input, ownership, shutdown, deadline)
                .await,
            Err(OrchestrationError::Describe(
                "previous execution bound not established".into()
            ))
        );
        assert!(starts.lock().unwrap().is_empty());
        assert_eq!(*calls.lock().unwrap(), 0);
        assert!(!cancellations.lock().unwrap().is_empty());
        assert!(
            cancellations
                .lock()
                .unwrap()
                .iter()
                .all(|name| name == &previous)
        );
    }
}
