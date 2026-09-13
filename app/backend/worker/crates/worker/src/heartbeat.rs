//! Cancellable ownership renewal for one received message.

use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use persistence::{JobOperationOutcome, JobState, PersistenceError};
use queue::{ChangeVisibility, QueueError};
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior, interval_at, sleep_until},
};

use crate::acquisition::AcquiredJob;

/// Renew long-running work periodically rather than holding a lease for days.
pub const MAX_LEASE_DURATION_SECONDS: u64 = 43_200;

/// Runtime timing values used by the heartbeat loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeartbeatSettings {
    pub interval: Duration,
    pub lease_duration: Duration,
    pub visibility_extension: Duration,
}

impl HeartbeatSettings {
    pub fn from_seconds(
        interval: u64,
        lease_duration: u64,
        visibility_extension: u64,
    ) -> Result<Self, HeartbeatSettingsError> {
        if interval == 0 || lease_duration == 0 || visibility_extension == 0 {
            return Err(HeartbeatSettingsError::NonPositive);
        }
        if visibility_extension > 43_200 {
            return Err(HeartbeatSettingsError::VisibilityTooLong);
        }
        if lease_duration > MAX_LEASE_DURATION_SECONDS {
            return Err(HeartbeatSettingsError::LeaseTooLong);
        }
        if interval > lease_duration / 2 || interval > visibility_extension / 2 {
            return Err(HeartbeatSettingsError::IntervalTooLong);
        }
        Ok(Self {
            interval: Duration::from_secs(interval),
            lease_duration: Duration::from_secs(lease_duration),
            visibility_extension: Duration::from_secs(visibility_extension),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeartbeatSettingsError {
    NonPositive,
    VisibilityTooLong,
    LeaseTooLong,
    IntervalTooLong,
}

impl fmt::Display for HeartbeatSettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NonPositive => "heartbeat timing values must be positive",
            Self::VisibilityTooLong => "visibility extension must not exceed 43200 seconds",
            Self::LeaseTooLong => "lease duration must not exceed 43200 seconds",
            Self::IntervalTooLong => {
                "heartbeat interval must be at most half the lease and visibility durations"
            }
        })
    }
}

impl std::error::Error for HeartbeatSettingsError {}

#[test]
fn heartbeat_settings_require_half_duration_margin() {
    for (lease, visibility) in [(120, 300), (300, 120), (121, 121)] {
        assert!(HeartbeatSettings::from_seconds(60, lease, visibility).is_ok());
        for interval in [61, 119, u64::MAX] {
            assert_eq!(
                HeartbeatSettings::from_seconds(interval, lease, visibility),
                Err(HeartbeatSettingsError::IntervalTooLong)
            );
        }
    }
}

#[test]
fn heartbeat_settings_reject_unbounded_lease_durations() {
    for lease in [MAX_LEASE_DURATION_SECONDS + 1, u64::MAX] {
        assert_eq!(
            HeartbeatSettings::from_seconds(30, lease, 120),
            Err(HeartbeatSettingsError::LeaseTooLong)
        );
    }
    assert!(HeartbeatSettings::from_seconds(30, MAX_LEASE_DURATION_SECONDS, 120).is_ok());
    assert_eq!(
        HeartbeatSettings::from_seconds(30, 0, 120),
        Err(HeartbeatSettingsError::NonPositive)
    );
}

/// The first ownership failure observed by the heartbeat.
#[derive(Debug, PartialEq, Eq)]
pub enum HeartbeatLoss {
    LeaseLost { job_id: String },
    Database(PersistenceError),
    Visibility(QueueError),
    LeaseDeadlineExceeded { job_id: String },
    VisibilityDeadlineExceeded,
}

/// Conservative initial ownership deadlines, captured before heartbeat startup.
/// `lease` must be no later than the earliest acquired lease's expiry: callers
/// can use the earliest acquisition request start plus its lease duration.
/// `visibility` must account for time already spent receiving/acquiring work,
/// using the receive request start plus the initial queue visibility duration.
/// Do not derive either deadline as `now + duration` at heartbeat startup or
/// from a server timestamp without accounting for clock skew. These local
/// watchdogs never replace the database's conditional ownership checks.
#[derive(Clone, Copy, Debug)]
pub struct HeartbeatDeadlines {
    pub lease: Instant,
    pub visibility: Instant,
}

struct OwnershipDeadlines {
    leases: Vec<Instant>,
    active: Vec<Arc<AtomicBool>>,
    visibility: Instant,
}

impl OwnershipDeadlines {
    fn earliest(&self, acquired: &[AcquiredJob]) -> (Instant, HeartbeatLoss) {
        let Some((index, lease)) = self
            .leases
            .iter()
            .enumerate()
            .filter(|(index, _)| self.active[*index].load(Ordering::SeqCst))
            .min_by_key(|(_, d)| *d)
        else {
            return (self.visibility, HeartbeatLoss::VisibilityDeadlineExceeded);
        };
        if *lease <= self.visibility {
            (
                *lease,
                HeartbeatLoss::LeaseDeadlineExceeded {
                    job_id: acquired[index].item.job_id.clone(),
                },
            )
        } else {
            (self.visibility, HeartbeatLoss::VisibilityDeadlineExceeded)
        }
    }
}

async fn before_deadline<T>(
    deadlines: &OwnershipDeadlines,
    acquired: &[AcquiredJob],
    operation: impl std::future::Future<Output = Result<T, HeartbeatLoss>>,
) -> Result<T, HeartbeatLoss> {
    tokio::pin!(operation);
    loop {
        let deadline = deadlines.earliest(acquired);
        if Instant::now() >= deadline.0 {
            return Err(deadline.1);
        }
        tokio::select! {
            biased;
            _ = sleep_until(deadline.0) => {
                // A record may have retired while we were waiting. Recompute
                // its relevance without restarting an in-flight port call.
            }
            result = &mut operation => {
                let current = deadlines.earliest(acquired);
                return if Instant::now() >= current.0 { Err(current.1) } else { result };
            }
        }
    }
}

/// A running heartbeat. Callers should cancel and join it during normal
/// completion and shutdown; dropping it aborts the task as a leak safeguard.
pub struct HeartbeatHandle {
    cancel: watch::Sender<bool>,
    ownership_lost: watch::Receiver<bool>,
    active: Vec<Arc<AtomicBool>>,
    visibility_deadline: Arc<std::sync::Mutex<Instant>>,
    task: Option<JoinHandle<Result<(), HeartbeatLoss>>>,
}

impl Drop for HeartbeatHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.as_ref() {
            task.abort();
        }
    }
}

impl HeartbeatHandle {
    pub fn visibility_deadline(&self) -> Instant {
        *self
            .visibility_deadline
            .lock()
            .expect("visibility deadline lock poisoned")
    }
    pub fn ownership_lost(&self) -> watch::Receiver<bool> {
        self.ownership_lost.clone()
    }

    pub fn activity(&self, index: usize) -> Arc<AtomicBool> {
        self.active[index].clone()
    }

    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }

    pub async fn join(mut self) -> Result<Result<(), HeartbeatLoss>, tokio::task::JoinError> {
        self.task
            .take()
            .expect("heartbeat task already joined")
            .await
    }

    pub async fn cancel_and_join(
        self,
    ) -> Result<Result<(), HeartbeatLoss>, tokio::task::JoinError> {
        self.cancel();
        self.join().await
    }
}

/// Owns the shared persistence and queue ports for one message heartbeat.
pub struct HeartbeatCoordinator<J, Q> {
    jobs: Arc<Mutex<J>>,
    queue: Arc<Mutex<Q>>,
    settings: HeartbeatSettings,
}

#[derive(Clone, Debug)]
struct HeartbeatObservationContext {
    message_id: String,
    delivery_id: String,
}

impl<J, Q> HeartbeatCoordinator<J, Q> {
    pub fn new(jobs: Arc<Mutex<J>>, queue: Arc<Mutex<Q>>, settings: HeartbeatSettings) -> Self {
        Self {
            jobs,
            queue,
            settings,
        }
    }
}

impl<J, Q> HeartbeatCoordinator<J, Q>
where
    J: JobState + Send + 'static,
    Q: ChangeVisibility + Send + 'static,
{
    pub fn start(
        &self,
        receipt_handle: impl Into<String>,
        acquired: Vec<AcquiredJob>,
        deadlines: HeartbeatDeadlines,
    ) -> Option<HeartbeatHandle> {
        start(
            self.jobs.clone(),
            self.queue.clone(),
            receipt_handle,
            acquired,
            self.settings,
            deadlines,
        )
    }
}

/// Starts renewal only when at least one acquired job is present.
pub fn start<J, Q>(
    jobs: Arc<Mutex<J>>,
    queue: Arc<Mutex<Q>>,
    receipt_handle: impl Into<String>,
    acquired: Vec<AcquiredJob>,
    settings: HeartbeatSettings,
    initial_deadlines: HeartbeatDeadlines,
) -> Option<HeartbeatHandle>
where
    J: JobState + Send + 'static,
    Q: ChangeVisibility + Send + 'static,
{
    start_with_context(
        jobs,
        queue,
        receipt_handle,
        acquired,
        settings,
        initial_deadlines,
        "unknown",
        "unknown",
    )
}

/// Starts a heartbeat with the allowlisted identity of one queue delivery.
pub fn start_with_context<J, Q>(
    jobs: Arc<Mutex<J>>,
    queue: Arc<Mutex<Q>>,
    receipt_handle: impl Into<String>,
    acquired: Vec<AcquiredJob>,
    settings: HeartbeatSettings,
    initial_deadlines: HeartbeatDeadlines,
    message_id: impl Into<String>,
    delivery_id: impl Into<String>,
) -> Option<HeartbeatHandle>
where
    J: JobState + Send + 'static,
    Q: ChangeVisibility + Send + 'static,
{
    if acquired.is_empty() {
        return None;
    }

    let receipt_handle = receipt_handle.into();
    let observation = HeartbeatObservationContext {
        message_id: message_id.into(),
        delivery_id: delivery_id.into(),
    };
    let (cancel, mut cancellation) = watch::channel(false);
    let (lost, ownership_lost) = watch::channel(
        Instant::now() >= initial_deadlines.lease || Instant::now() >= initial_deadlines.visibility,
    );
    // Every exit, including panic or abort, revokes processing permission.
    struct RevokeOnDrop(watch::Sender<bool>);
    impl Drop for RevokeOnDrop {
        fn drop(&mut self) {
            self.0.send_replace(true);
        }
    }
    let revoke = RevokeOnDrop(lost);
    let active: Vec<_> = acquired
        .iter()
        .map(|_| Arc::new(AtomicBool::new(true)))
        .collect();
    let tracked = active.clone();
    let visibility_deadline = Arc::new(std::sync::Mutex::new(initial_deadlines.visibility));
    let current_visibility = visibility_deadline.clone();
    let first_tick = Instant::now() + settings.interval;
    let task = tokio::spawn(async move {
        let _revoke = revoke;
        let mut cadence = interval_at(first_tick, settings.interval);
        cadence.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut deadlines = OwnershipDeadlines {
            leases: vec![initial_deadlines.lease; acquired.len()],
            active: tracked,
            visibility: initial_deadlines.visibility,
        };
        let mut heartbeat_cycle = 0_u64;
        loop {
            tokio::select! {
                biased;
                _ = cancellation.changed() => return Ok(()),
                result = before_deadline(&deadlines, &acquired, async {
                    cadence.tick().await;
                    Ok(())
                }) => result?,
            }

            {
                heartbeat_cycle += 1;
                let tick = renew_tick(
                    jobs.clone(),
                    queue.clone(),
                    &receipt_handle,
                    &acquired,
                    settings,
                    &mut deadlines,
                    &observation,
                    heartbeat_cycle,
                );
                tokio::pin!(tick);
                tokio::select! {
                    biased;
                    _ = cancellation.changed() => return Ok(()),
                    result = &mut tick => result?,
                }
            }
            *current_visibility
                .lock()
                .expect("visibility deadline lock poisoned") = deadlines.visibility;
        }
    });

    Some(HeartbeatHandle {
        cancel,
        ownership_lost,
        active,
        visibility_deadline,
        task: Some(task),
    })
}

async fn renew_tick<J, Q>(
    jobs: Arc<Mutex<J>>,
    queue: Arc<Mutex<Q>>,
    receipt_handle: &str,
    acquired: &[AcquiredJob],
    settings: HeartbeatSettings,
    deadlines: &mut OwnershipDeadlines,
    observation: &HeartbeatObservationContext,
    heartbeat_cycle: u64,
) -> Result<(), HeartbeatLoss>
where
    J: JobState + Send + 'static,
    Q: ChangeVisibility + Send + 'static,
{
    for (index, job) in acquired.iter().enumerate() {
        if !deadlines.active[index].load(Ordering::SeqCst) {
            continue;
        }
        let started = Instant::now();
        let mut called = false;
        let mut request_started_at_unix_ms = 0_u64;
        let mut response_observed_at_unix_ms = 0_u64;
        let mut response_elapsed = Duration::ZERO;
        let outcome = before_deadline(deadlines, acquired, async {
            let mut jobs = jobs.lock().await;
            // The attempt retires under this same lock after its state update.
            if !deadlines.active[index].load(Ordering::SeqCst) {
                return Ok(JobOperationOutcome::Applied);
            }
            called = true;
            let request_started = Instant::now();
            request_started_at_unix_ms = unix_ms();
            let result = jobs
                .renew_lease(
                    &job.item.job_id,
                    &job.item.video_id,
                    job.worker_id.as_str(),
                    settings.lease_duration.as_secs(),
                )
                .await;
            response_elapsed = request_started.elapsed();
            response_observed_at_unix_ms = unix_ms();
            result.map_err(HeartbeatLoss::Database)
        })
        .await?;
        if outcome != JobOperationOutcome::Applied {
            return Err(HeartbeatLoss::LeaseLost {
                job_id: job.item.job_id.clone(),
            });
        }
        if called {
            log_heartbeat_success(
                "lease_renewal",
                observation,
                heartbeat_cycle,
                job,
                settings.lease_duration,
                request_started_at_unix_ms,
                response_observed_at_unix_ms,
                response_elapsed,
            );
        }
        // Start the budget before the request, never at response completion.
        // If a duration cannot be represented, retain the earlier safe deadline.
        deadlines.leases[index] = started
            .checked_add(settings.lease_duration)
            .unwrap_or(deadlines.leases[index]);
    }

    let started = Instant::now();
    let mut called = false;
    let mut request_started_at_unix_ms = 0_u64;
    let mut response_observed_at_unix_ms = 0_u64;
    let mut response_elapsed = Duration::ZERO;
    before_deadline(deadlines, acquired, async {
        let mut queue = queue.lock().await;
        called = true;
        let request_started = Instant::now();
        request_started_at_unix_ms = unix_ms();
        let result = queue
            .change_visibility(receipt_handle, settings.visibility_extension)
            .await;
        response_elapsed = request_started.elapsed();
        response_observed_at_unix_ms = unix_ms();
        result.map_err(HeartbeatLoss::Visibility)
    })
    .await?;
    if called {
        // Unix timestamps are local wall-clock observations in milliseconds;
        // elapsed_ms is monotonic request timing. Neither is a database lease
        // expiry or an authoritative SQS visibility expiry.
        tracing::info!(
            operation = "visibility_extension",
            outcome = "success",
            message_id = %observation.message_id,
            delivery_id = %observation.delivery_id,
            heartbeat_cycle,
            duration_seconds = settings.visibility_extension.as_secs(),
            request_started_at_unix_ms,
            response_observed_at_unix_ms,
            elapsed_ms = response_elapsed.as_millis() as u64,
            "worker heartbeat observation",
        );
    }
    deadlines.visibility = started
        .checked_add(settings.visibility_extension)
        .unwrap_or(deadlines.visibility);
    Ok(())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn log_heartbeat_success(
    operation: &'static str,
    observation: &HeartbeatObservationContext,
    heartbeat_cycle: u64,
    job: &AcquiredJob,
    duration: Duration,
    request_started_at_unix_ms: u64,
    response_observed_at_unix_ms: u64,
    elapsed: Duration,
) {
    tracing::info!(
        operation,
        outcome = "success",
        message_id = %observation.message_id,
        delivery_id = %observation.delivery_id,
        heartbeat_cycle,
        video_id = %job.item.video_id,
        job_id = %job.item.job_id,
        worker_id = %job.worker_id.as_str(),
        attempt = job.attempt,
        duration_seconds = duration.as_secs(),
        request_started_at_unix_ms,
        response_observed_at_unix_ms,
        elapsed_ms = elapsed.as_millis() as u64,
        "worker heartbeat observation",
    );
}

#[cfg(test)]
pub(crate) mod observation_test_support {
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::prelude::*;

    #[derive(Clone, Default)]
    pub(crate) struct Capture(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Capture {
        // Only used by current-thread Tokio tests: spawned tasks are polled
        // on the guarded thread. No second global subscriber is installed.
        pub(crate) fn install(enabled: bool) -> (Self, tracing::subscriber::DefaultGuard) {
            let capture = Self::default();
            let writer = capture.clone();
            let layer = tracing_subscriber::fmt::layer()
                .json()
                .without_time()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .with_filter(tracing_subscriber::filter::dynamic_filter_fn(
                    move |_, _| enabled,
                ));
            let guard =
                tracing::subscriber::set_default(tracing_subscriber::registry().with(layer));
            (capture, guard)
        }

        pub(crate) fn events(&self) -> Vec<serde_json::Value> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            for secret in ["secret-receipt", "secret-db", "secret-sqs", "secret-source"] {
                assert!(!text.contains(secret), "observation leaked {secret}");
            }
            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        pub(crate) fn heartbeats(&self) -> Vec<serde_json::Value> {
            self.events()
                .into_iter()
                .map(|event| event["fields"].clone())
                .filter(|fields| fields["message"] == "worker heartbeat observation")
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::observation_test_support::Capture;
    use super::*;
    use crate::{acquisition::WorkerIdentity, event::WorkItem};
    use std::{
        collections::VecDeque,
        future::pending,
        sync::{
            Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::SystemTime,
    };

    type Log = Arc<StdMutex<Vec<(Instant, String)>>>;
    struct Step<T> {
        delay: Option<Duration>,
        result: T,
    }
    impl<T> Step<T> {
        fn after(seconds: u64, result: T) -> Self {
            Self {
                delay: Some(Duration::from_secs(seconds)),
                result,
            }
        }
        fn pending(result: T) -> Self {
            Self {
                delay: None,
                result,
            }
        }
    }
    struct Active(Arc<AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    async fn execute<T>(step: Step<T>, active: Arc<AtomicUsize>) -> T {
        active.fetch_add(1, Ordering::SeqCst);
        let _guard = Active(active);
        match step.delay {
            Some(delay) if !delay.is_zero() => tokio::time::sleep(delay).await,
            Some(_) => {}
            None => pending::<()>().await,
        }
        step.result
    }
    struct Jobs {
        log: Log,
        steps: VecDeque<Step<Result<JobOperationOutcome, PersistenceError>>>,
        active: Arc<AtomicUsize>,
        expected_worker: String,
    }
    impl JobState for Jobs {
        async fn claim(&mut self, _: &str, _: &str) -> Result<bool, PersistenceError> {
            panic!("unexpected claim")
        }
        async fn mark_processing(&mut self, _: &str) -> Result<(), PersistenceError> {
            panic!("unexpected processing")
        }
        async fn renew_lease(
            &mut self,
            job: &str,
            video: &str,
            worker: &str,
            seconds: u64,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            assert_eq!(video, "video");
            assert_eq!(worker, self.expected_worker);
            assert_eq!(seconds, 300);
            self.log.lock().unwrap().push((Instant::now(), job.into()));
            let step = self
                .steps
                .pop_front()
                .unwrap_or_else(|| Step::after(0, Ok(JobOperationOutcome::Applied)));
            execute(step, self.active.clone()).await
        }
    }
    struct Queue {
        log: Log,
        steps: VecDeque<Step<Result<(), QueueError>>>,
        active: Arc<AtomicUsize>,
    }
    impl ChangeVisibility for Queue {
        async fn change_visibility(
            &mut self,
            receipt: &str,
            duration: Duration,
        ) -> Result<(), QueueError> {
            assert!(matches!(receipt, "receipt" | "secret-receipt"));
            assert_eq!(duration, Duration::from_secs(120));
            self.log
                .lock()
                .unwrap()
                .push((Instant::now(), "visibility".into()));
            let step = self
                .steps
                .pop_front()
                .unwrap_or_else(|| Step::after(0, Ok(())));
            execute(step, self.active.clone()).await
        }
    }
    struct Fixture {
        jobs: Arc<Mutex<Jobs>>,
        queue: Arc<Mutex<Queue>>,
        log: Log,
        active: Arc<AtomicUsize>,
        epoch: Instant,
    }
    impl Fixture {
        fn new() -> Self {
            let log = Log::default();
            let active = Arc::new(AtomicUsize::new(0));
            Self {
                jobs: Arc::new(Mutex::new(Jobs {
                    log: log.clone(),
                    steps: VecDeque::new(),
                    active: active.clone(),
                    expected_worker: "worker-a".into(),
                })),
                queue: Arc::new(Mutex::new(Queue {
                    log: log.clone(),
                    steps: VecDeque::new(),
                    active: active.clone(),
                })),
                log,
                active,
                epoch: Instant::now(),
            }
        }
        fn start(&self, count: usize, lease: u64, visibility: u64) -> Option<HeartbeatHandle> {
            let acquired = (0..count)
                .map(|i| AcquiredJob {
                    item: WorkItem {
                        job_id: format!("job-{i}"),
                        video_id: "video".into(),
                        bucket: "input".into(),
                        key: "source".into(),
                    },
                    worker_id: WorkerIdentity::from_value("worker-a").unwrap(),
                    attempt: 1,
                    // Deliberately unrelated to the local clock; supplied monotonic
                    // budgets avoid interpreting database timestamps on this machine.
                    lease_expires_at: SystemTime::UNIX_EPOCH,
                })
                .collect();
            HeartbeatCoordinator::new(
                self.jobs.clone(),
                self.queue.clone(),
                HeartbeatSettings::from_seconds(30, 300, 120).unwrap(),
            )
            .start(
                "receipt",
                acquired,
                HeartbeatDeadlines {
                    lease: self.epoch + Duration::from_secs(lease),
                    visibility: self.epoch + Duration::from_secs(visibility),
                },
            )
        }
        fn calls(&self) -> Vec<(u64, String)> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .map(|(t, name)| (t.duration_since(self.epoch).as_secs(), name.clone()))
                .collect()
        }
        fn observed(&self, delivery: &str, count: usize, attempt: u32) -> HeartbeatHandle {
            self.observed_identity("same-message", delivery, count, attempt, "worker-a")
        }
        fn observed_identity(
            &self,
            message: &str,
            delivery: &str,
            count: usize,
            attempt: u32,
            worker: &str,
        ) -> HeartbeatHandle {
            self.jobs.try_lock().unwrap().expected_worker = worker.into();
            start_with_context(
                self.jobs.clone(),
                self.queue.clone(),
                "secret-receipt",
                (0..count)
                    .map(|i| AcquiredJob {
                        item: WorkItem {
                            job_id: format!("job-{i}"),
                            video_id: "video".into(),
                            bucket: "input".into(),
                            key: "secret-source".into(),
                        },
                        worker_id: WorkerIdentity::from_value(worker).unwrap(),
                        attempt,
                        lease_expires_at: SystemTime::UNIX_EPOCH,
                    })
                    .collect(),
                HeartbeatSettings::from_seconds(30, 300, 120).unwrap(),
                HeartbeatDeadlines {
                    lease: self.epoch + Duration::from_secs(300),
                    visibility: self.epoch + Duration::from_secs(120),
                },
                message,
                delivery,
            )
            .unwrap()
        }
        async fn loss(&self, handle: HeartbeatHandle, expected: HeartbeatLoss) {
            let cancelled = handle.ownership_lost();
            // A timeout makes failure bounded even if the watchdog regresses.
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), handle.join())
                    .await
                    .unwrap()
                    .unwrap(),
                Err(expected)
            );
            assert_eq!(self.active.load(Ordering::SeqCst), 0);
            assert!(
                *cancelled.borrow(),
                "heartbeat failure must reach processing"
            );
            let calls = self.calls();
            advance(400).await;
            assert_eq!(self.calls(), calls);
        }
    }
    async fn advance(seconds: u64) {
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(seconds)).await;
        tokio::task::yield_now().await;
    }
    fn lease_loss(job: &str) -> HeartbeatLoss {
        HeartbeatLoss::LeaseDeadlineExceeded { job_id: job.into() }
    }

    #[tokio::test(start_paused = true)]
    async fn observations_emit_nothing_without_jobs_or_before_an_expired_initial_deadline() {
        let (capture, _guard) = Capture::install(true);
        let empty = Fixture::new();
        assert!(empty.start(0, 300, 120).is_none());
        advance(30).await;
        assert!(empty.calls().is_empty());
        for (lease, visibility, expected) in [
            (0, 120, lease_loss("job-0")),
            (300, 0, HeartbeatLoss::VisibilityDeadlineExceeded),
            (5, 120, lease_loss("job-0")),
        ] {
            let f = Fixture::new();
            let h = f.start(1, lease, visibility).unwrap();
            advance(5).await;
            f.loss(h, expected).await;
            assert!(f.calls().is_empty());
        }
        assert!(capture.heartbeats().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn observations_measure_real_calls_across_two_multi_record_cycles() {
        let (capture, _guard) = Capture::install(true);
        let f = Fixture::new();
        f.jobs
            .lock()
            .await
            .steps
            .extend((0..4).map(|_| Step::after(2, Ok(JobOperationOutcome::Applied))));
        f.queue
            .lock()
            .await
            .steps
            .extend((0..2).map(|_| Step::after(3, Ok(()))));
        let wall_before = unix_ms();
        let h = f.observed("timed-delivery", 2, 4);
        advance(30).await;
        for cycle in 0..2 {
            advance(2).await;
            advance(2).await;
            advance(3).await;
            if cycle == 0 {
                advance(23).await;
            }
        }
        assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
        let wall_after = unix_ms();
        let events = capture.heartbeats();
        assert_eq!(events.len(), 6);
        assert_eq!(
            f.calls(),
            [
                (30, "job-0".into()),
                (32, "job-1".into()),
                (34, "visibility".into()),
                (60, "job-0".into()),
                (62, "job-1".into()),
                (64, "visibility".into())
            ]
        );
        for (index, event) in events.iter().enumerate() {
            let lease = index % 3 < 2;
            assert_eq!(
                event["operation"],
                if lease {
                    "lease_renewal"
                } else {
                    "visibility_extension"
                }
            );
            assert_eq!(event["outcome"], "success");
            assert_eq!(event["message_id"], "same-message");
            assert_eq!(event["delivery_id"], "timed-delivery");
            assert_eq!(event["heartbeat_cycle"], index / 3 + 1);
            assert_eq!(event["duration_seconds"], if lease { 300 } else { 120 });
            assert_eq!(event["elapsed_ms"], if lease { 2000 } else { 3000 });
            // Paused Tokio time advances seconds; wall timestamps stay within
            // the real test interval and must not be fabricated from it.
            for field in ["request_started_at_unix_ms", "response_observed_at_unix_ms"] {
                let value = event[field]
                    .as_u64()
                    .expect("integer wall time in milliseconds");
                assert!((wall_before..=wall_after).contains(&value));
            }
            if lease {
                assert_eq!(event["job_id"], format!("job-{}", index % 3));
                assert_eq!(event["video_id"], "video");
                assert_eq!(event["worker_id"], "worker-a");
                assert_eq!(event["attempt"], 4);
            } else {
                for field in ["job_id", "video_id", "worker_id", "attempt"] {
                    assert!(event.get(field).is_none());
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn observations_keep_concurrent_and_redelivered_message_contexts_separate() {
        let (capture, _guard) = Capture::install(true);
        let a = Fixture::new();
        let b = Fixture::new();
        let first = a.observed("delivery-a", 1, 2);
        let second = b.observed_identity("other-message", "delivery-b", 2, 3, "worker-b");
        advance(30).await;
        assert_eq!(first.cancel_and_join().await.unwrap(), Ok(()));
        assert_eq!(second.cancel_and_join().await.unwrap(), Ok(()));
        let c = Fixture::new();
        let redelivered = c.observed_identity("same-message", "delivery-c", 1, 4, "worker-c");
        advance(30).await;
        assert_eq!(redelivered.cancel_and_join().await.unwrap(), Ok(()));
        let events = capture.heartbeats();
        assert_eq!(events.len(), 7);
        for (delivery, count, attempt) in [
            ("delivery-a", 1, 2),
            ("delivery-b", 2, 3),
            ("delivery-c", 1, 4),
        ] {
            let own: Vec<_> = events
                .iter()
                .filter(|e| e["delivery_id"] == delivery)
                .collect();
            assert_eq!(own.len(), count + 1);
            for (index, event) in own.iter().enumerate() {
                assert_eq!(
                    event["message_id"],
                    if delivery == "delivery-b" {
                        "other-message"
                    } else {
                        "same-message"
                    }
                );
                assert_eq!(event["heartbeat_cycle"], 1);
                if index < count {
                    assert_eq!(event["operation"], "lease_renewal");
                    assert_eq!(event["job_id"], format!("job-{index}"));
                    assert_eq!(event["attempt"], attempt);
                    assert_eq!(
                        event["worker_id"],
                        match delivery {
                            "delivery-a" => "worker-a",
                            "delivery-b" => "worker-b",
                            _ => "worker-c",
                        }
                    );
                } else {
                    assert_eq!(event["operation"], "visibility_extension");
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn observations_exclude_retired_records_including_lock_wait_short_circuit() {
        let (capture, _guard) = Capture::install(true);
        let f = Fixture::new();
        let h = f.observed("retired", 3, 1);
        h.activity(0).store(false, Ordering::SeqCst);
        let lock = f.jobs.lock().await;
        advance(30).await;
        h.activity(1).store(false, Ordering::SeqCst);
        drop(lock);
        advance(1).await;
        assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
        let events = capture.heartbeats();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["job_id"], "job-2");
        assert_eq!(events[1]["operation"], "visibility_extension");
        assert_eq!(f.calls(), [(30, "job-2".into()), (30, "visibility".into())]);
    }

    #[tokio::test(start_paused = true)]
    async fn observations_suppress_failures_and_late_results_but_preserve_partial_success() {
        for case in [
            "not-owner",
            "db-error",
            "sqs-error",
            "db-timeout",
            "sqs-timeout",
            "db-late",
            "sqs-late",
            "later-job",
        ] {
            let (capture, _guard) = Capture::install(true);
            let f = Fixture::new();
            match case {
                "not-owner" => f
                    .jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(0, Ok(JobOperationOutcome::NotOwner))),
                "db-error" => f
                    .jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(0, Err(PersistenceError("secret-db".into())))),
                "sqs-error" => f
                    .queue
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(0, Err(QueueError("secret-sqs".into())))),
                "db-timeout" => f
                    .jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::pending(Ok(JobOperationOutcome::Applied))),
                "sqs-timeout" => f.queue.lock().await.steps.push_back(Step::pending(Ok(()))),
                "db-late" => f
                    .jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(90, Ok(JobOperationOutcome::Applied))),
                "sqs-late" => f
                    .queue
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(90, Ok(()))),
                "later-job" => f.jobs.lock().await.steps.extend([
                    Step::after(0, Ok(JobOperationOutcome::Applied)),
                    Step::after(0, Ok(JobOperationOutcome::NotOwner)),
                ]),
                _ => unreachable!(),
            }
            let h = f.observed(case, if case == "later-job" { 2 } else { 1 }, 1);
            advance(30).await;
            if case.ends_with("timeout") || case.ends_with("late") {
                advance(90).await;
            }
            let expected = match case {
                "not-owner" | "later-job" => HeartbeatLoss::LeaseLost {
                    job_id: if case == "later-job" {
                        "job-1"
                    } else {
                        "job-0"
                    }
                    .into(),
                },
                "db-error" => HeartbeatLoss::Database(PersistenceError("secret-db".into())),
                "sqs-error" => HeartbeatLoss::Visibility(QueueError("secret-sqs".into())),
                _ => HeartbeatLoss::VisibilityDeadlineExceeded,
            };
            f.loss(h, expected).await;
            let events = capture.heartbeats();
            let partial = case.starts_with("sqs") || case == "later-job";
            assert_eq!(events.len(), usize::from(partial), "{case}: {events:?}");
            if partial {
                assert_eq!(events[0]["operation"], "lease_renewal");
                assert_eq!(events[0]["job_id"], "job-0");
                assert_eq!(events[0]["heartbeat_cycle"], 1);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn observations_suppress_cancelled_calls_and_disabled_logging_preserves_behavior() {
        for stage in 0..3 {
            let mut baseline = None;
            for enabled in [true, false] {
                let (capture, _guard) = Capture::install(enabled);
                let f = Fixture::new();
                if stage == 1 {
                    f.jobs
                        .lock()
                        .await
                        .steps
                        .push_back(Step::pending(Ok(JobOperationOutcome::Applied)));
                }
                f.queue.lock().await.steps.push_back(Step::pending(Ok(())));
                let h = f.observed("cancelled", 1, 2);
                let lost = h.ownership_lost();
                if stage > 0 {
                    advance(30).await;
                }
                assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
                assert!(*lost.borrow());
                assert_eq!(f.active.load(Ordering::SeqCst), 0);
                assert!(f.jobs.try_lock().is_ok());
                assert!(f.queue.try_lock().is_ok());
                let calls = f.calls();
                advance(400).await;
                assert_eq!(f.calls(), calls);
                if let Some(expected) = &baseline {
                    assert_eq!(&calls, expected);
                } else {
                    baseline = Some(calls);
                }
                let events = capture.heartbeats();
                assert_eq!(events.len(), usize::from(enabled && stage == 2));
                if enabled && stage == 2 {
                    assert_eq!(events[0]["operation"], "lease_renewal");
                }
                if !enabled {
                    assert!(capture.events().is_empty());
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn retiring_a_record_while_renewal_waits_for_the_database_skips_it() {
        let f = Fixture::new();
        let h = f.start(2, 300, 120).unwrap();
        let guard = f.jobs.lock().await;
        advance(30).await;
        h.activity(0).store(false, Ordering::SeqCst);
        drop(guard);
        advance(1).await;
        assert_eq!(
            f.calls()
                .into_iter()
                .map(|(_, name)| name)
                .collect::<Vec<_>>(),
            ["job-1", "visibility"]
        );
        assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
    }

    #[tokio::test(start_paused = true)]
    async fn retired_deadline_does_not_cancel_a_pending_visibility_update() {
        let acquired = vec![AcquiredJob {
            item: WorkItem {
                job_id: "job-0".into(),
                video_id: "video".into(),
                bucket: "input".into(),
                key: "key".into(),
            },
            worker_id: WorkerIdentity::from_value("worker").unwrap(),
            attempt: 1,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        }];
        let active = Arc::new(AtomicBool::new(true));
        let deadlines = OwnershipDeadlines {
            leases: vec![Instant::now() + Duration::from_secs(5)],
            active: vec![active.clone()],
            visibility: Instant::now() + Duration::from_secs(30),
        };
        let operation = before_deadline(&deadlines, &acquired, async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok(())
        });
        tokio::pin!(operation);
        tokio::select! {
            biased;
            _ = &mut operation => panic!("operation must still be pending"),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
        active.store(false, Ordering::SeqCst);
        assert_eq!(operation.await, Ok(()));
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_during_cadence_wait_wins_over_overdue_tick() {
        let f = Fixture::new();
        let h = f.start(1, 300, 120).unwrap();
        advance(30).await;
        assert_eq!(f.calls().len(), 2);
        // Simulate a delayed executor: both the next tick and expiry are ready.
        advance(120).await;
        f.loss(h, HeartbeatLoss::VisibilityDeadlineExceeded).await;
        assert_eq!(f.calls().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_handle_aborts_pending_work_and_releases_port_lock() {
        let f = Fixture::new();
        f.jobs
            .lock()
            .await
            .steps
            .push_back(Step::pending(Ok(JobOperationOutcome::Applied)));
        let h = f.start(1, 300, 120).unwrap();
        advance(30).await;
        assert_eq!(f.active.load(Ordering::SeqCst), 1);
        drop(h);
        tokio::task::yield_now().await;
        assert_eq!(f.active.load(Ordering::SeqCst), 0);
        assert!(f.jobs.try_lock().is_ok());
        advance(400).await;
        assert_eq!(f.calls().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn no_owned_records_starts_no_task() {
        let f = Fixture::new();
        assert!(f.start(0, 300, 120).is_none());
        advance(500).await;
        assert!(f.calls().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn initial_deadlines_apply_before_first_tick_including_already_expired() {
        for (lease, visibility, expected) in [
            (5, 120, lease_loss("job-0")),
            (300, 5, HeartbeatLoss::VisibilityDeadlineExceeded),
            (0, 120, lease_loss("job-0")),
            (300, 0, HeartbeatLoss::VisibilityDeadlineExceeded),
        ] {
            let f = Fixture::new();
            let h = f.start(1, lease, visibility).unwrap();
            advance(5).await;
            f.loss(h, expected).await;
            assert!(f.calls().is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn hanging_database_and_visibility_calls_lose_ownership_at_deadline() {
        for database in [true, false] {
            let f = Fixture::new();
            if database {
                f.jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::pending(Ok(JobOperationOutcome::Applied)));
            } else {
                f.queue.lock().await.steps.push_back(Step::pending(Ok(())));
            }
            let h = f.start(1, 300, 120).unwrap();
            advance(30).await;
            assert_eq!(f.active.load(Ordering::SeqCst), 1);
            advance(90).await;
            f.loss(h, HeartbeatLoss::VisibilityDeadlineExceeded).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pending_database_detects_lease_deadline() {
        let f = Fixture::new();
        f.jobs
            .lock()
            .await
            .steps
            .push_back(Step::pending(Ok(JobOperationOutcome::Applied)));
        let h = f.start(1, 45, 120).unwrap();
        advance(30).await;
        advance(15).await;
        f.loss(h, lease_loss("job-0")).await;
    }

    #[tokio::test(start_paused = true)]
    async fn shared_port_lock_waits_are_bounded() {
        for database in [true, false] {
            let f = Fixture::new();
            let jobs_guard = if database {
                Some(f.jobs.lock().await)
            } else {
                None
            };
            let queue_guard = if database {
                None
            } else {
                Some(f.queue.lock().await)
            };
            let h = f.start(1, 300, 120).unwrap();
            advance(30).await;
            advance(90).await;
            f.loss(h, HeartbeatLoss::VisibilityDeadlineExceeded).await;
            drop((jobs_guard, queue_guard));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn multiple_leases_renew_individually_but_unrenewed_job_still_expires() {
        let f = Fixture::new();
        f.jobs.lock().await.steps.extend([
            Step::after(0, Ok(JobOperationOutcome::Applied)),
            Step::pending(Ok(JobOperationOutcome::Applied)),
        ]);
        let h = f.start(2, 45, 120).unwrap();
        advance(30).await;
        advance(15).await;
        f.loss(h, lease_loss("job-1")).await;
        assert_eq!(f.calls(), [(30, "job-0".into()), (30, "job-1".into())]);
    }

    #[tokio::test(start_paused = true)]
    async fn successful_lease_renewal_replaces_old_deadline_while_visibility_is_pending() {
        let f = Fixture::new();
        f.queue
            .lock()
            .await
            .steps
            .push_back(Step::after(20, Ok(())));
        let h = f.start(1, 40, 120).unwrap();
        advance(30).await;
        advance(20).await;
        assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_ticks_keep_fixed_cadence_and_renew_every_owned_job() {
        let f = Fixture::new();
        f.jobs
            .lock()
            .await
            .steps
            .extend((0..6).map(|_| Step::after(5, Ok(JobOperationOutcome::Applied))));
        let h = f.start(2, 300, 120).unwrap();
        advance(30).await;
        for i in 0..3 {
            advance(5).await;
            advance(5).await;
            if i < 2 {
                advance(20).await;
            }
        }
        assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
        assert_eq!(
            f.calls(),
            [
                (30, "job-0".into()),
                (35, "job-1".into()),
                (40, "visibility".into()),
                (60, "job-0".into()),
                (65, "job-1".into()),
                (70, "visibility".into()),
                (90, "job-0".into()),
                (95, "job-1".into()),
                (100, "visibility".into()),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn missed_ticks_skip_backlog_without_overlapping_calls() {
        let f = Fixture::new();
        f.jobs
            .lock()
            .await
            .steps
            .push_back(Step::after(65, Ok(JobOperationOutcome::Applied)));
        let h = f.start(1, 300, 120).unwrap();
        advance(30).await;
        advance(65).await;
        assert_eq!(
            f.calls(),
            [
                (30, "job-0".into()),
                (95, "visibility".into()),
                (95, "job-0".into()),
                (95, "visibility".into()),
            ]
        );
        advance(25).await;
        assert_eq!(f.calls().last(), Some(&(120, "visibility".into())));
        assert_eq!(h.cancel_and_join().await.unwrap(), Ok(()));
        assert_eq!(f.active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_success_at_deadline_is_rejected() {
        let f = Fixture::new();
        f.queue
            .lock()
            .await
            .steps
            .push_back(Step::after(90, Ok(())));
        let h = f.start(1, 300, 120).unwrap();
        advance(30).await;
        advance(90).await;
        f.loss(h, HeartbeatLoss::VisibilityDeadlineExceeded).await;
    }

    #[tokio::test(start_paused = true)]
    async fn renewed_visibility_budget_starts_before_response_not_after_it() {
        let f = Fixture::new();
        f.queue
            .lock()
            .await
            .steps
            .extend([Step::after(80, Ok(())), Step::pending(Ok(()))]);
        let h = f.start(1, 300, 120).unwrap();
        advance(30).await;
        advance(80).await;
        advance(40).await; // First request at 30 + 120; not response at 110 + 120.
        f.loss(h, HeartbeatLoss::VisibilityDeadlineExceeded).await;
    }

    #[tokio::test(start_paused = true)]
    async fn typed_port_failures_stop_all_later_ticks() {
        for expected in [
            HeartbeatLoss::LeaseLost {
                job_id: "job-0".into(),
            },
            HeartbeatLoss::Database(PersistenceError("db unavailable".into())),
            HeartbeatLoss::Visibility(QueueError("sqs unavailable".into())),
        ] {
            let f = Fixture::new();
            match &expected {
                HeartbeatLoss::LeaseLost { .. } => f
                    .jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(0, Ok(JobOperationOutcome::NotOwner))),
                HeartbeatLoss::Database(error) => f
                    .jobs
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(0, Err(error.clone()))),
                HeartbeatLoss::Visibility(error) => f
                    .queue
                    .lock()
                    .await
                    .steps
                    .push_back(Step::after(0, Err(error.clone()))),
                _ => unreachable!(),
            }
            let h = f.start(1, 300, 120).unwrap();
            advance(30).await;
            f.loss(h, expected).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_before_tick_and_during_each_port_call_joins_and_drops_work() {
        for stage in 0..3 {
            let f = Fixture::new();
            f.jobs.lock().await.steps.push_back(if stage == 1 {
                Step::pending(Ok(JobOperationOutcome::Applied))
            } else {
                Step::after(0, Ok(JobOperationOutcome::Applied))
            });
            f.queue.lock().await.steps.push_back(Step::pending(Ok(())));
            let h = f.start(1, 300, 120).unwrap();
            if stage > 0 {
                advance(30).await;
            }
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), h.cancel_and_join())
                    .await
                    .unwrap()
                    .unwrap(),
                Ok(())
            );
            assert_eq!(f.active.load(Ordering::SeqCst), 0);
            let calls = f.calls();
            advance(400).await;
            assert_eq!(f.calls(), calls);
        }
    }
}
