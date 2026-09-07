//! Cancellable ownership renewal for one received message.

use std::{fmt, sync::Arc, time::Duration};

use persistence::{JobOperationOutcome, JobState, PersistenceError};
use queue::{ChangeVisibility, QueueError};
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior, interval_at, sleep_until},
};

use crate::acquisition::AcquiredJob;

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
        if interval >= lease_duration || interval >= visibility_extension {
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
    IntervalTooLong,
}

impl fmt::Display for HeartbeatSettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NonPositive => "heartbeat timing values must be positive",
            Self::VisibilityTooLong => "visibility extension must not exceed 43200 seconds",
            Self::IntervalTooLong => {
                "heartbeat interval must be shorter than lease and visibility durations"
            }
        })
    }
}

impl std::error::Error for HeartbeatSettingsError {}

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
    visibility: Instant,
}

impl OwnershipDeadlines {
    fn earliest(&self, acquired: &[AcquiredJob]) -> (Instant, HeartbeatLoss) {
        let (index, lease) = self
            .leases
            .iter()
            .enumerate()
            .min_by_key(|(_, d)| *d)
            .expect("heartbeat requires an acquired job");
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
    deadline: (Instant, HeartbeatLoss),
    operation: impl std::future::Future<Output = Result<T, HeartbeatLoss>>,
) -> Result<T, HeartbeatLoss> {
    if Instant::now() >= deadline.0 {
        return Err(deadline.1);
    }
    tokio::select! {
        biased;
        _ = sleep_until(deadline.0) => Err(deadline.1),
        result = operation => {
            // A ready operation must not win after its ownership budget expired.
            if Instant::now() >= deadline.0 { Err(deadline.1) } else { result }
        }
    }
}

/// A running heartbeat. Callers should cancel and join it during normal
/// completion and shutdown; dropping it aborts the task as a leak safeguard.
pub struct HeartbeatHandle {
    cancel: watch::Sender<bool>,
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
    if acquired.is_empty() {
        return None;
    }

    let receipt_handle = receipt_handle.into();
    let (cancel, mut cancellation) = watch::channel(false);
    let first_tick = Instant::now() + settings.interval;
    let task = tokio::spawn(async move {
        let mut cadence = interval_at(first_tick, settings.interval);
        cadence.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut deadlines = OwnershipDeadlines {
            leases: vec![initial_deadlines.lease; acquired.len()],
            visibility: initial_deadlines.visibility,
        };
        loop {
            tokio::select! {
                biased;
                _ = cancellation.changed() => return Ok(()),
                result = before_deadline(deadlines.earliest(&acquired), async {
                    cadence.tick().await;
                    Ok(())
                }) => result?,
            }

            let tick = renew_tick(
                jobs.clone(),
                queue.clone(),
                &receipt_handle,
                &acquired,
                settings,
                &mut deadlines,
            );
            tokio::pin!(tick);
            tokio::select! {
                biased;
                _ = cancellation.changed() => return Ok(()),
                result = &mut tick => result?,
            }
        }
    });

    Some(HeartbeatHandle {
        cancel,
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
) -> Result<(), HeartbeatLoss>
where
    J: JobState + Send + 'static,
    Q: ChangeVisibility + Send + 'static,
{
    for (index, job) in acquired.iter().enumerate() {
        let started = Instant::now();
        let outcome = before_deadline(deadlines.earliest(acquired), async {
            jobs.lock()
                .await
                .renew_lease(
                    &job.item.job_id,
                    &job.item.video_id,
                    job.worker_id.as_str(),
                    settings.lease_duration.as_secs(),
                )
                .await
                .map_err(HeartbeatLoss::Database)
        })
        .await?;
        if outcome != JobOperationOutcome::Applied {
            return Err(HeartbeatLoss::LeaseLost {
                job_id: job.item.job_id.clone(),
            });
        }
        // Start the budget before the request, never at response completion.
        // If a duration cannot be represented, retain the earlier safe deadline.
        deadlines.leases[index] = started
            .checked_add(settings.lease_duration)
            .unwrap_or(deadlines.leases[index]);
    }

    let started = Instant::now();
    before_deadline(deadlines.earliest(acquired), async {
        queue
            .lock()
            .await
            .change_visibility(receipt_handle, settings.visibility_extension)
            .await
            .map_err(HeartbeatLoss::Visibility)
    })
    .await?;
    deadlines.visibility = started
        .checked_add(settings.visibility_extension)
        .unwrap_or(deadlines.visibility);
    Ok(())
}

#[cfg(test)]
mod tests {
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
    }
    impl JobState for Jobs {
        async fn claim(&mut self, _: &str, _: &str) -> Result<bool, PersistenceError> {
            panic!("unexpected claim")
        }
        async fn mark_processing(&mut self, _: &str) -> Result<(), PersistenceError> {
            panic!("unexpected processing")
        }
        async fn mark_completed(&mut self, _: &str) -> Result<(), PersistenceError> {
            panic!("unexpected completion")
        }
        async fn mark_failed(&mut self, _: &str, _: &str) -> Result<(), PersistenceError> {
            panic!("unexpected failure")
        }
        async fn renew_lease(
            &mut self,
            job: &str,
            video: &str,
            worker: &str,
            seconds: u64,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            assert_eq!(video, "video");
            assert_eq!(worker, "worker-a");
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
            assert_eq!(receipt, "receipt");
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
        async fn loss(&self, handle: HeartbeatHandle, expected: HeartbeatLoss) {
            // A timeout makes failure bounded even if the watchdog regresses.
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), handle.join())
                    .await
                    .unwrap()
                    .unwrap(),
                Err(expected)
            );
            assert_eq!(self.active.load(Ordering::SeqCst), 0);
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
