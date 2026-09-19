//! Reliability bridge for a parent Step Functions execution.
//!
//! This module owns coordination only. Publication, child-result validation,
//! parent manifest assembly, and distributed completion belong to the finalizer
//! supplied by the later distributed-publication task.

use std::{fmt, future::Future, pin::Pin, time::Duration};

use persistence::JobMode;
use tokio::sync::watch;

use crate::acquisition::AcquiredJob;

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionInput {
    pub video_id: String,
    pub job_id: String,
    pub attempt: u32,
    pub execution_id: String,
    pub source_key: String,
    pub output_prefix: String,
    pub renditions: Vec<String>,
}

impl ExecutionInput {
    pub fn for_job(job: &AcquiredJob, renditions: Vec<String>) -> Self {
        let execution_id = execution_name(&job.item.job_id, job.attempt);
        Self {
            video_id: job.item.video_id.clone(),
            job_id: job.item.job_id.clone(),
            attempt: job.attempt,
            execution_id: execution_id.clone(),
            source_key: job.item.key.clone(),
            output_prefix: format!(
                "videos/{}/jobs/{}/hls/attempts/{}/{execution_id}",
                job.item.video_id, job.item.job_id, job.attempt
            ),
            renditions,
        }
    }
}

pub fn execution_name(job_id: &str, attempt: u32) -> String {
    format!("job-{job_id}-a{attempt}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionStatus {
    Running,
    Succeeded,
    Failed,
    TimedOut,
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
    fn cancel(&self, name: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

pub trait Finalizer: Send + Sync {
    fn finalize(
        &self,
        job: &AcquiredJob,
        input: &ExecutionInput,
        ownership: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>>;
}

pub struct OrchestrationBridge<C, F> {
    pub client: C,
    pub finalizer: F,
    pub poll_limit: usize,
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
    ) -> Result<(), OrchestrationError> {
        let name = execution_name(&job.item.job_id, job.attempt);
        self.client.start(&name, input).await?;
        let mut delay = self.poll_interval.max(Duration::from_millis(1));
        for _ in 0..self.poll_limit {
            if *ownership.borrow() {
                self.client.cancel(&name).await;
                return Err(OrchestrationError::OwnershipLost);
            }
            match self.client.status(&name).await? {
                ExecutionStatus::Running => {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {},
                        _ = ownership.changed() => {
                            if *ownership.borrow() { self.client.cancel(&name).await; return Err(OrchestrationError::OwnershipLost); }
                        }
                    }
                    delay = (delay * 2).min(MAX_POLL_INTERVAL);
                }
                ExecutionStatus::Succeeded => {
                    return self.finalizer.finalize(job, input, ownership).await;
                }
                ExecutionStatus::Failed => return Err(OrchestrationError::Failed),
                ExecutionStatus::TimedOut => return Err(OrchestrationError::TimedOut),
            }
        }
        self.client.cancel(&name).await;
        Err(OrchestrationError::TimedOut)
    }
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

    fn job() -> AcquiredJob {
        AcquiredJob {
            item: WorkItem {
                bucket: "in".into(),
                key: "source".into(),
                video_id: "video".into(),
                job_id: "job".into(),
            },
            worker_id: crate::acquisition::WorkerIdentity::from_value("worker").unwrap(),
            attempt: 1,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn succeeded_execution_is_handed_to_finalizer() {
        let client = FakeExecutionClient::new(vec![Ok(ExecutionStatus::Succeeded)]);
        let finalizer = FakeFinalizer::new(Ok(()));
        let calls = finalizer.calls.clone();
        let bridge = OrchestrationBridge {
            client,
            finalizer,
            poll_limit: 2,
            poll_interval: Duration::from_millis(1),
        };
        let (_stop, ownership) = watch::channel(false);
        bridge
            .run(
                &job(),
                &ExecutionInput::for_job(&job(), vec!["low".into()]),
                ownership,
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
            poll_limit: 2,
            poll_interval: Duration::from_secs(1),
        };
        let (stop, ownership) = watch::channel(false);
        stop.send(true).unwrap();
        assert_eq!(
            bridge
                .run(&job(), &ExecutionInput::for_job(&job(), vec![]), ownership)
                .await,
            Err(OrchestrationError::OwnershipLost)
        );
        assert_eq!(*calls.lock().unwrap(), 0);
        assert_eq!(cancellations.lock().unwrap().as_slice(), ["job-job-a1"]);
    }
}
