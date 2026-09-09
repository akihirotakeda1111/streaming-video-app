//! Message-level orchestration for lease acquisition, processing, and acking.

use std::{convert::Infallible, path::PathBuf, sync::Arc, time::Duration};

use encoding::Execute;
use persistence::JobState;
use queue::{ChangeVisibility, Delete, Message};
use storage::{Read, Write};
use tokio::{
    sync::{Mutex, watch},
    time::Instant,
};
use tracing::Instrument;

use crate::{
    acquisition::{
        LeaseAcquisitionProcessor, NoWorkReason, RecordAcquisitionDisposition, WorkerIdentity,
    },
    heartbeat::{HeartbeatDeadlines, HeartbeatSettings},
    retry::{OwnedAttemptProcessor, ProcessingOutcome, RetrySettings},
    runtime::{MessageProcessor, cancellation_requested},
};

/// Coordinates all records in one queue message. A message is acknowledged
/// only when every record is either durably completed or already completed.
pub struct MessageCompletionProcessor<J, S, E, Q> {
    acquisition: LeaseAcquisitionProcessor<J>,
    processing: OwnedAttemptProcessor<J, S, E>,
    heartbeat_jobs: Arc<Mutex<J>>,
    queue: Arc<Mutex<Q>>,
    heartbeat: HeartbeatSettings,
    lease_seconds: u64,
    worker_id: WorkerIdentity,
}

impl<J, S, E, Q> Clone for MessageCompletionProcessor<J, S, E, Q> {
    fn clone(&self) -> Self {
        Self {
            acquisition: self.acquisition.clone(),
            processing: self.processing.clone(),
            heartbeat_jobs: self.heartbeat_jobs.clone(),
            queue: self.queue.clone(),
            heartbeat: self.heartbeat,
            lease_seconds: self.lease_seconds,
            worker_id: self.worker_id.clone(),
        }
    }
}

impl<J, S, E, Q> MessageCompletionProcessor<J, S, E, Q> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        jobs: J,
        storage: S,
        executor: E,
        queue: Q,
        worker_id: WorkerIdentity,
        input_bucket: impl Into<String>,
        output_bucket: impl Into<String>,
        ffmpeg_path: impl Into<PathBuf>,
        temporary_directory: impl Into<PathBuf>,
        lease_seconds: u64,
        maximum_attempts: u32,
        retry_delay_seconds: u64,
        heartbeat: HeartbeatSettings,
    ) -> Result<Self, crate::retry::RetrySettingsError> {
        let jobs = Arc::new(Mutex::new(jobs));
        let storage = Arc::new(Mutex::new(storage));
        let executor = Arc::new(Mutex::new(executor));
        let queue = Arc::new(Mutex::new(queue));
        let input_bucket = input_bucket.into();
        let settings = RetrySettings::new(maximum_attempts, retry_delay_seconds)?;
        Ok(Self {
            worker_id: worker_id.clone(),
            acquisition: LeaseAcquisitionProcessor::from_shared(
                jobs.clone(),
                worker_id,
                input_bucket.clone(),
                lease_seconds,
                maximum_attempts,
            ),
            processing: OwnedAttemptProcessor::from_shared(
                jobs.clone(),
                storage,
                executor,
                output_bucket,
                ffmpeg_path,
                temporary_directory,
                settings,
            ),
            heartbeat_jobs: jobs,
            queue,
            heartbeat,
            lease_seconds,
        })
    }

    // Only canonical IDs and fixed outcome labels enter this log. Never format
    // event bodies, receipt handles, or adapter error payloads here.
    fn log_record(
        &self,
        item: Option<&crate::event::WorkItem>,
        attempt: Option<u32>,
        outcome: &'static str,
    ) {
        tracing::info!(
            worker_id = %self.worker_id.as_str(),
            job_id = item.map(|item| item.job_id.as_str()),
            video_id = item.map(|item| item.video_id.as_str()),
            attempt,
            outcome,
            "record outcome"
        );
    }
}

impl<J, S, E, Q> MessageProcessor for MessageCompletionProcessor<J, S, E, Q>
where
    J: JobState + Send + 'static,
    S: Read + Write + Send + 'static,
    E: Execute + Send + 'static,
    Q: ChangeVisibility + Delete + Send + 'static,
{
    type Error = Infallible;

    async fn process(&self, message: Message) -> Result<(), Self::Error> {
        let (_stop, shutdown) = watch::channel(false);
        self.process_with_shutdown(message, shutdown).await
    }

    async fn process_with_shutdown(
        &self,
        message: Message,
        shutdown: watch::Receiver<bool>,
    ) -> Result<(), Self::Error> {
        let delivery = tracing::info_span!(
            "worker_delivery",
            message_id = message.message_id.as_deref().unwrap_or("unknown"),
            delivery_id = %message.delivery_id,
        );
        self.process_delivery(message, shutdown).instrument(delivery).await
    }
}

impl<J, S, E, Q> MessageCompletionProcessor<J, S, E, Q>
where
    J: JobState + Send + 'static,
    S: Read + Write + Send + 'static,
    E: Execute + Send + 'static,
    Q: ChangeVisibility + Delete + Send + 'static,
{
    async fn process_delivery(
        &self,
        message: Message,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), Infallible> {
        if *shutdown.borrow() {
            return Ok(());
        }
        let Some(mut visibility) = message.visibility_deadline else {
            tracing::warn!(worker_id = %self.worker_id.as_str(), outcome = "missing_visibility_budget", "message has no initial visibility budget");
            return Ok(());
        };
        let lease = Instant::now() + Duration::from_secs(self.lease_seconds);
        let deadline = visibility.min(lease);
        if Instant::now() >= deadline {
            return Ok(());
        }
        // Acquisition cannot consume the initial budgets and then start work
        // under a freshly invented deadline. Unknown DB results stay undeleted.
        let acquisition = tokio::select! {
            biased;
            _ = cancellation_requested(&mut shutdown) => return Ok(()),
            result = tokio::time::timeout_at(
                deadline,
                self.acquisition.acquire_notification(&message.body),
            ) => result,
        };
        let dispositions = match acquisition {
            Ok(dispositions) if Instant::now() < deadline => dispositions,
            _ => {
                tracing::warn!(worker_id = %self.worker_id.as_str(), outcome = "acquisition_timeout", "acquisition exceeded ownership budget");
                return Ok(());
            }
        };
        for disposition in &dispositions {
            match disposition {
                RecordAcquisitionDisposition::Acquired(job) => {
                    self.log_record(Some(&job.item), Some(job.attempt), "acquired");
                }
                RecordAcquisitionDisposition::NotAcquired { item, reason } => {
                    let outcome = match reason {
                        NoWorkReason::Busy => "busy",
                        NoWorkReason::Completed => "already_completed",
                        NoWorkReason::Failed => "failed",
                        NoWorkReason::UnknownOrMismatched => "unknown_or_mismatched",
                        NoWorkReason::AttemptExhausted => "attempt_exhausted",
                        NoWorkReason::PersistenceError(_) => "persistence_error",
                    };
                    self.log_record(Some(item), None, outcome);
                }
                RecordAcquisitionDisposition::InvalidEvent => {
                    self.log_record(None, None, "invalid_event")
                }
            }
        }
        let acquired: Vec<_> = dispositions
            .iter()
            .filter_map(|disposition| match disposition {
                RecordAcquisitionDisposition::Acquired(job) => Some(job.clone()),
                _ => None,
            })
            .collect();
        let heartbeat = crate::heartbeat::start(
            self.heartbeat_jobs.clone(),
            self.queue.clone(),
            message.receipt_handle.clone(),
            acquired,
            self.heartbeat,
            HeartbeatDeadlines { lease, visibility },
        );

        let mut acknowledge = true;
        let mut retry_delay: Option<Duration> = None;
        let mut index = 0;
        for disposition in dispositions {
            if *shutdown.borrow() {
                acknowledge = false;
                break;
            }
            match disposition {
                RecordAcquisitionDisposition::Acquired(job) => {
                    let handle = heartbeat.as_ref().expect("acquired record has a heartbeat");
                    let mut lost = handle.ownership_lost();
                    if *lost.borrow() {
                        self.log_record(Some(&job.item), Some(job.attempt), "ownership_lost");
                        acknowledge = false;
                        break;
                    }
                    let processing = self
                        .processing
                        .clone()
                        .with_activity(handle.activity(index));
                    let attempt_span = tracing::info_span!(
                        "worker_attempt",
                        job_id = %job.item.job_id,
                        video_id = %job.item.video_id,
                        worker_id = %job.worker_id.as_str(),
                        attempt = job.attempt,
                    );
                    index += 1;
                    let mut cancelled = lost.clone();
                    let outcome = tokio::select! {
                        biased;
                        _ = cancellation_requested(&mut shutdown) => {
                            self.log_record(Some(&job.item), Some(job.attempt), "cancelled");
                            acknowledge = false;
                            break;
                        }
                        _ = lost.changed() => {
                            self.log_record(Some(&job.item), Some(job.attempt), "ownership_lost");
                            acknowledge = false;
                            break;
                        }
                        outcome = processing.process(&job, &mut cancelled).instrument(attempt_span) => outcome,
                    };
                    match outcome {
                        Ok(ProcessingOutcome::Completed) => {
                            self.log_record(Some(&job.item), Some(job.attempt), "completed");
                        }
                        Ok(ProcessingOutcome::RetryReleased { delay }) => {
                            self.log_record(Some(&job.item), Some(job.attempt), "retry_released");
                            acknowledge = false;
                            retry_delay =
                                Some(retry_delay.map_or(delay, |current| current.max(delay)));
                        }
                        Ok(outcome) => {
                            acknowledge = false;
                            let label = match outcome {
                                ProcessingOutcome::FinalFailed => "final_failed",
                                ProcessingOutcome::OwnershipLost => "ownership_lost",
                                ProcessingOutcome::InfrastructureFailure => {
                                    "infrastructure_failure"
                                }
                                ProcessingOutcome::Panicked => "panicked",
                                _ => unreachable!("completed and retry outcomes handled above"),
                            };
                            self.log_record(Some(&job.item), Some(job.attempt), label);
                            if matches!(
                                outcome,
                                ProcessingOutcome::OwnershipLost
                                    | ProcessingOutcome::InfrastructureFailure
                                    | ProcessingOutcome::Panicked
                            ) {
                                // An uncertain attempt must expire naturally;
                                // do not shorten visibility using an earlier record's retry delay.
                                retry_delay = None;
                                break;
                            }
                        }
                        Err(_) => {
                            self.log_record(Some(&job.item), Some(job.attempt), "processing_error");
                            acknowledge = false;
                            break;
                        }
                    }
                }
                RecordAcquisitionDisposition::NotAcquired { reason, .. } => {
                    if !matches!(reason, NoWorkReason::Completed) {
                        acknowledge = false;
                    }
                }
                RecordAcquisitionDisposition::InvalidEvent => acknowledge = false,
            }
        }
        let heartbeat_ok = match heartbeat {
            Some(handle) => {
                let lost = *handle.ownership_lost().borrow();
                visibility = handle.visibility_deadline();
                matches!(handle.cancel_and_join().await, Ok(Ok(()))) && !lost
            }
            None => Instant::now() < visibility,
        };
        if !*shutdown.borrow() && heartbeat_ok && Instant::now() < visibility {
            // The heartbeat must be joined before applying the final delay;
            // otherwise a later renewal can overwrite the retry schedule.
            let update = tokio::time::timeout_at(
                visibility.min(Instant::now() + self.heartbeat.interval),
                async {
                    let mut queue = self.queue.lock().await;
                    if let Some(delay) = retry_delay {
                        queue
                            .change_visibility(&message.receipt_handle, delay)
                            .await
                    } else if acknowledge {
                        queue.delete(&message.receipt_handle).await
                    } else {
                        Ok(())
                    }
                },
            );
            let result = tokio::select! {
                biased;
                _ = cancellation_requested(&mut shutdown) => return Ok(()),
                result = update => result,
            };
            if !matches!(result, Ok(Ok(()))) {
                tracing::warn!(worker_id = %self.worker_id.as_str(), receive_count = message.receive_count,
                    outcome = "queue_update_failed", "message disposition queue update failed");
            } else {
                tracing::info!(worker_id = %self.worker_id.as_str(), receive_count = message.receive_count,
                    outcome = if retry_delay.is_some() { "retry_scheduled" } else if acknowledge { "deleted" } else { "retained" },
                    "message outcome");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        event::{records_notification, source_key},
        fakes::{CallLog, FakeProcessExecutor, FakeStorage},
    };
    use encoding::{Command, Output, ProcessError};
    use persistence::{JobOperationOutcome, LeaseAcquisitionOutcome, PersistenceError};
    use queue::QueueError;
    use std::{collections::HashMap, sync::Mutex as StdMutex, time::SystemTime};

    #[derive(Clone, Default)]
    struct LogBuffer(Arc<StdMutex<Vec<u8>>>);
    impl std::io::Write for LogBuffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    const VIDEO: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const FIRST: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const SECOND: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd68";
    #[derive(Default)]
    struct State {
        jobs: HashMap<String, &'static str>,
        acquired_attempts: HashMap<String, u32>,
        output_log: CallLog,
        output_at_completion: Vec<crate::fakes::Call>,
        calls: Vec<String>,
        renewal_failure: bool,
        visibility_failure: bool,
        completion_failure: bool,
        delete_failure: bool,
        acquisition_delay: Duration,
        attempt: u32,
        panic_next_encode: bool,
        acquisition_failure: bool,
    }
    #[derive(Clone)]
    struct Jobs(Arc<StdMutex<State>>);
    impl JobState for Jobs {
        async fn claim(&mut self, id: &str, _: &str) -> Result<bool, PersistenceError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("claim:{id}"));
            Ok(false)
        }
        async fn mark_processing(&mut self, _: &str) -> Result<(), PersistenceError> {
            panic!("legacy")
        }
        async fn acquire_lease(
            &mut self,
            id: &str,
            _: &str,
            _: &str,
            _: u64,
            _: u32,
        ) -> Result<LeaseAcquisitionOutcome, PersistenceError> {
            let delay = self.0.lock().unwrap().acquisition_delay;
            tokio::time::sleep(delay).await;
            let mut s = self.0.lock().unwrap();
            if s.acquisition_failure {
                return Err(PersistenceError(
                    "postgres://user:secret-password@host/db?token=secret-token".into(),
                ));
            }
            let state = s.jobs.get(id).copied().unwrap_or("QUEUED");
            match state {
                "COMPLETED" => Ok(LeaseAcquisitionOutcome::Completed),
                "PROCESSING" => Ok(LeaseAcquisitionOutcome::Busy),
                "FAILED" => Ok(LeaseAcquisitionOutcome::Failed),
                "UNKNOWN" => Ok(LeaseAcquisitionOutcome::UnknownOrMismatched),
                "EXHAUSTED" => Ok(LeaseAcquisitionOutcome::AttemptExhausted),
                _ => {
                    s.jobs.insert(id.into(), "PROCESSING");
                    let initial_attempt = s.attempt.max(1);
                    let attempt = s
                        .acquired_attempts
                        .entry(id.into())
                        .and_modify(|attempt| *attempt += 1)
                        .or_insert(initial_attempt);
                    Ok(LeaseAcquisitionOutcome::Acquired {
                        attempt: *attempt,
                        lease_expires_at: SystemTime::UNIX_EPOCH,
                    })
                }
            }
        }
        async fn renew_lease(
            &mut self,
            id: &str,
            _: &str,
            _: &str,
            _: u64,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("renew:{id}"));
            Ok(
                if s.renewal_failure || s.jobs.get(id) != Some(&"PROCESSING") {
                    JobOperationOutcome::NotOwner
                } else {
                    JobOperationOutcome::Applied
                },
            )
        }
        async fn complete(
            &mut self,
            id: &str,
            _: &str,
            _: &str,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("complete:{id}"));
            if s.completion_failure {
                return Err(PersistenceError("uncertain".into()));
            }
            s.output_at_completion = s.output_log.calls();
            s.jobs.insert(id.into(), "COMPLETED");
            Ok(JobOperationOutcome::Applied)
        }
        async fn release_for_retry(
            &mut self,
            id: &str,
            _: &str,
            _: &str,
            _: u32,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("release:{id}"));
            s.jobs.insert(id.into(), "QUEUED");
            Ok(JobOperationOutcome::Applied)
        }
        async fn fail(
            &mut self,
            id: &str,
            _: &str,
            _: &str,
            _: &str,
            _: u32,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("fail:{id}"));
            s.jobs.insert(id.into(), "FAILED");
            Ok(JobOperationOutcome::Applied)
        }
    }
    struct Queue(Arc<StdMutex<State>>);
    impl ChangeVisibility for Queue {
        async fn change_visibility(
            &mut self,
            _: &str,
            duration: Duration,
        ) -> Result<(), QueueError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push(format!("visibility:{}", duration.as_millis()));
            if s.visibility_failure {
                Err(QueueError("unavailable".into()))
            } else {
                Ok(())
            }
        }
    }
    impl Delete for Queue {
        async fn delete(&mut self, _: &str) -> Result<(), QueueError> {
            let mut s = self.0.lock().unwrap();
            s.calls.push("delete".into());
            if s.delete_failure {
                Err(QueueError("unavailable".into()))
            } else {
                Ok(())
            }
        }
    }
    struct Executor {
        inner: FakeProcessExecutor,
        delay: Duration,
        state: Arc<StdMutex<State>>,
    }
    impl Execute for Executor {
        async fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
            self.state.lock().unwrap().calls.push("encode".into());
            tokio::time::sleep(self.delay).await;
            let should_panic = {
                let mut state = self.state.lock().unwrap();
                std::mem::take(&mut state.panic_next_encode)
            };
            assert!(!should_panic, "injected encoder panic");
            self.inner.execute(command).await
        }
    }
    struct Fixture {
        _root: tempfile::TempDir,
        processor: MessageCompletionProcessor<Jobs, FakeStorage, Executor, Queue>,
        state: Arc<StdMutex<State>>,
        log: CallLog,
    }
    impl Fixture {
        fn new(delay: Duration, fail_first: bool) -> Self {
            Self::with_storage(delay, |storage| {
                if fail_first {
                    storage.fail_read("download failed");
                }
            })
        }
        fn with_storage(delay: Duration, configure: impl FnOnce(&mut FakeStorage)) -> Self {
            let root = tempfile::tempdir().unwrap();
            let log = CallLog::default();
            let state = Arc::new(StdMutex::new(State {
                output_log: log.clone(),
                ..State::default()
            }));
            let mut storage = FakeStorage::new(log.clone());
            for id in [FIRST, SECOND] {
                storage.add_read("input", &source_key(VIDEO, id), b"source".to_vec());
            }
            configure(&mut storage);
            let processor = MessageCompletionProcessor::new(
                Jobs(state.clone()),
                storage,
                Executor {
                    inner: FakeProcessExecutor::stub_hls(log.clone()),
                    delay,
                    state: state.clone(),
                },
                Queue(state.clone()),
                WorkerIdentity::from_value("worker").unwrap(),
                "input",
                "output",
                "ffmpeg",
                root.path(),
                2,
                5,
                1,
                HeartbeatSettings {
                    interval: Duration::from_millis(20),
                    lease_duration: Duration::from_secs(2),
                    visibility_extension: Duration::from_millis(400),
                },
            )
            .unwrap();
            Self {
                _root: root,
                processor,
                state,
                log,
            }
        }
        fn message(ids: &[&str]) -> Message {
            let keys: Vec<_> = ids.iter().map(|id| source_key(VIDEO, id)).collect();
            Message {
                message_id: Some("message-test".into()),
                delivery_id: "delivery-test".into(),
                receipt_handle: "receipt".into(),
                receive_count: 1,
                visibility_deadline: Some(Instant::now() + Duration::from_secs(2)),
                body: records_notification(
                    &keys
                        .iter()
                        .map(|key| ("ObjectCreated:Put", "input", key.as_str()))
                        .collect::<Vec<_>>(),
                ),
            }
        }
        async fn run(&self, ids: &[&str]) {
            tokio::time::timeout(
                Duration::from_secs(3),
                self.processor.process(Self::message(ids)),
            )
            .await
            .unwrap()
            .unwrap();
        }
    }
    #[tokio::test]
    async fn partial_upload_redelivery_reacquires_and_publishes_before_acknowledgement() {
        use crate::fakes::Call;

        let f = Fixture::with_storage(Duration::ZERO, |storage| {
            storage.fail_write_after(1, "second segment upload failed");
        });
        let prefix = format!("videos/{VIDEO}/jobs/{FIRST}/hls");
        let write_keys = || {
            f.log
                .calls()
                .into_iter()
                .filter_map(|call| match call {
                    Call::Write { key, .. } => Some(key),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };

        f.run(&[FIRST]).await;
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.jobs.get(FIRST), Some(&"QUEUED"));
            assert_eq!(s.acquired_attempts.get(FIRST), Some(&1));
            assert!(s.calls.contains(&format!("release:{FIRST}")));
            assert_eq!(s.calls.last().unwrap(), "visibility:1000");
            assert!(!s.calls.iter().any(|call| call == "delete"
                || call.starts_with("complete:")
                || call.starts_with("fail:")));
        }
        assert_eq!(
            write_keys(),
            [
                format!("{prefix}/segment-00000.ts"),
                format!("{prefix}/segment-00001.ts"),
            ]
        );

        // Redeliver the same notification against the retained job and output state.
        let mut redelivery = Fixture::message(&[FIRST]);
        redelivery.receipt_handle = "redelivery-receipt".into();
        redelivery.receive_count = 2;
        f.processor.process(redelivery).await.unwrap();

        assert_eq!(
            write_keys(),
            [
                format!("{prefix}/segment-00000.ts"),
                format!("{prefix}/segment-00001.ts"),
                format!("{prefix}/segment-00000.ts"),
                format!("{prefix}/segment-00001.ts"),
                format!("{prefix}/index.m3u8"),
            ]
        );
        let s = f.state.lock().unwrap();
        assert_eq!(s.jobs.get(FIRST), Some(&"COMPLETED"));
        assert_eq!(s.acquired_attempts.get(FIRST), Some(&2));
        assert_eq!(s.output_at_completion, f.log.calls());
        assert_eq!(s.calls.iter().filter(|call| *call == "encode").count(), 2);
        assert_eq!(s.calls.iter().filter(|call| *call == "delete").count(), 1);
        assert_eq!(
            &s.calls[s.calls.len() - 2..],
            [format!("complete:{FIRST}"), "delete".into()]
        );
        assert!(std::fs::read_dir(f._root.path()).unwrap().next().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn runtime_shutdown_stops_processing_and_joins_heartbeat_without_ack() {
        let f = Fixture::new(Duration::from_secs(3600), false);
        let queue_log = CallLog::default();
        let mut receiver = crate::fakes::FakeQueue::new(queue_log.clone());
        receiver.push_message(Fixture::message(&[FIRST, SECOND]));
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(crate::runtime::run(
            receiver,
            f.processor.clone(),
            shutdown,
            1,
        ));
        while !f.state.lock().unwrap().calls.contains(&"encode".into()) {
            assert!(!task.is_finished());
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(20)).await;
        while !f
            .state
            .lock()
            .unwrap()
            .calls
            .contains(&"visibility:400".into())
        {
            assert!(!task.is_finished());
            tokio::task::yield_now().await;
        }
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        let calls = f.state.lock().unwrap().calls.clone();
        assert!(calls.contains(&format!("renew:{FIRST}")));
        assert!(calls.contains(&format!("renew:{SECOND}")));
        assert!(!calls.iter().any(|c| c == "delete"
            || c.starts_with("complete:")
            || c.starts_with("release:")
            || c.starts_with("fail:")));
        assert_eq!(calls.iter().filter(|c| *c == "encode").count(), 1);
        assert!(
            !f.log
                .calls()
                .iter()
                .any(|c| matches!(c, crate::fakes::Call::Write { .. }))
        );
        assert_eq!(queue_log.calls().len(), 1);
        assert!(std::fs::read_dir(f._root.path()).unwrap().next().is_none());
        assert!(f.processor.heartbeat_jobs.try_lock().is_ok());
        assert!(f.processor.queue.try_lock().is_ok());
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        assert_eq!(f.state.lock().unwrap().calls, calls);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_during_acquisition_never_starts_processing_or_heartbeat() {
        let f = Fixture::new(Duration::ZERO, false);
        f.state.lock().unwrap().acquisition_delay = Duration::from_secs(3600);
        let (stop, shutdown) = watch::channel(false);
        let processor = f.processor.clone();
        let task = tokio::spawn(async move {
            processor
                .process_with_shutdown(Fixture::message(&[FIRST]), shutdown)
                .await
        });
        while f.state.lock().unwrap().calls.is_empty() {
            tokio::task::yield_now().await;
        }
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(f.state.lock().unwrap().calls, [format!("claim:{FIRST}")]);
        assert!(f.log.calls().is_empty());
        assert!(f.processor.heartbeat_jobs.try_lock().is_ok());
    }

    #[tokio::test]
    async fn completion_stops_heartbeat_and_deletes_without_waiting_for_lease_loss() {
        let f = Fixture::new(Duration::ZERO, false);
        f.run(&[FIRST]).await;
        assert_eq!(f.state.lock().unwrap().calls.last().unwrap(), "delete");
        let calls = f.state.lock().unwrap().calls.clone();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(f.state.lock().unwrap().calls, calls);
    }

    #[tokio::test]
    async fn outcome_logs_include_available_context_and_exclude_sensitive_payloads() {
        use tracing_subscriber::prelude::*;
        let buffer = LogBuffer::default();
        let writer = buffer.clone();
        let layer = tracing_subscriber::fmt::layer()
            .json()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .with_filter(tracing_subscriber::filter::dynamic_filter_fn(|_, _| true));
        let subscriber = tracing_subscriber::registry().with(layer);
        // Install one dispatcher for this test binary so concurrent tests
        // cannot register these callsites against an empty dispatcher.
        tracing::subscriber::set_global_default(subscriber).unwrap();

        for expected in [
            "busy",
            "already_completed",
            "failed",
            "unknown_or_mismatched",
            "attempt_exhausted",
            "persistence_error",
            "invalid_event",
            "retry_released",
            "final_failed",
            "completed",
            "infrastructure_failure",
        ] {
            let mut f = Fixture::new(
                Duration::ZERO,
                matches!(expected, "retry_released" | "final_failed"),
            );
            let log_worker = format!("log-test-{expected}");
            f.processor.worker_id = WorkerIdentity::from_value(&log_worker).unwrap();
            {
                let mut state = f.state.lock().unwrap();
                let status = match expected {
                    "busy" => "PROCESSING",
                    "already_completed" => "COMPLETED",
                    "failed" => "FAILED",
                    "unknown_or_mismatched" => "UNKNOWN",
                    "attempt_exhausted" => "EXHAUSTED",
                    _ => "QUEUED",
                };
                state.jobs.insert(FIRST.into(), status);
                state.acquisition_failure = expected == "persistence_error";
                state.completion_failure = expected == "infrastructure_failure";
                state.attempt = if expected == "final_failed" { 5 } else { 1 };
            }
            // The adapter error and raw input deliberately contain values that
            // must not be copied into operator-facing logs.
            let mut message = Fixture::message(&[FIRST]);
            message.receipt_handle = "secret-receipt".into();
            if expected == "invalid_event" {
                message.body = "invalid secret-password secret-token".into();
            } else {
                let mut body: serde_json::Value = serde_json::from_str(&message.body).unwrap();
                body["debug"] = "https://example.test/?token=secret-token".into();
                message.body = body.to_string();
            }
            f.processor.process(message).await.unwrap();
            let logs = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
            for secret in [
                "secret-receipt",
                "secret-password",
                "secret-token",
                "postgres://",
                "https://example.test",
            ] {
                assert!(!logs.contains(secret), "{expected} leaked {secret}: {logs}");
            }
            let events: Vec<serde_json::Value> = logs
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let event = events
                .iter()
                .find(|event| {
                    event["fields"]["outcome"] == expected
                        && event["fields"]["worker_id"] == log_worker
                })
                .unwrap_or_else(|| panic!("missing {expected} outcome: {logs}"));
            let fields = &event["fields"];
            assert_eq!(fields["worker_id"], log_worker);
            if expected != "invalid_event" {
                assert_eq!(fields["job_id"], FIRST);
                assert_eq!(fields["video_id"], VIDEO);
            }
            if matches!(
                expected,
                "retry_released" | "final_failed" | "completed" | "infrastructure_failure"
            ) {
                assert_eq!(
                    fields["attempt"],
                    if expected == "final_failed" { 5 } else { 1 }
                );
            } else {
                assert!(
                    fields.get("attempt").is_none(),
                    "unacquired attempt must not be fabricated"
                );
            }
        }
    }

    #[tokio::test]
    async fn encoder_panic_keeps_the_whole_message_and_stops_heartbeat() {
        let f = Fixture::new(Duration::from_millis(60), false);
        f.state.lock().unwrap().panic_next_encode = true;
        f.run(&[FIRST, SECOND]).await;
        let calls = f.state.lock().unwrap().calls.clone();
        assert!(calls.contains(&format!("renew:{FIRST}")));
        assert_eq!(calls.iter().filter(|c| *c == "encode").count(), 1);
        assert!(!calls.iter().any(|c| c == "delete"
            || c.starts_with("complete:")
            || c.starts_with("fail:")
            || c.starts_with("release:")));
        assert!(
            !f.log
                .calls()
                .iter()
                .any(|c| matches!(c, crate::fakes::Call::Write { .. }))
        );
        assert!(std::fs::read_dir(f._root.path()).unwrap().next().is_none());
        assert!(f.processor.heartbeat_jobs.try_lock().is_ok());
        assert!(f.processor.queue.try_lock().is_ok());
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(f.state.lock().unwrap().calls, calls);
    }

    #[tokio::test]
    async fn encoder_panic_does_not_stop_receiving_and_processing_the_next_message() {
        struct Receiver(std::collections::VecDeque<Message>);
        impl queue::Receive for Receiver {
            async fn receive(&mut self) -> Result<Option<Message>, QueueError> {
                self.0
                    .pop_front()
                    .map(Some)
                    .ok_or_else(|| QueueError("end of test".into()))
            }
        }
        let f = Fixture::new(Duration::ZERO, false);
        f.state.lock().unwrap().panic_next_encode = true;
        let receiver = Receiver(std::collections::VecDeque::from([
            Fixture::message(&[FIRST]),
            Fixture::message(&[SECOND]),
        ]));
        let (_stop, shutdown) = watch::channel(false);
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            crate::runtime::run(receiver, f.processor.clone(), shutdown, 1),
        )
        .await
        .unwrap();
        // Both messages finished before the receive-level error still surfaces.
        assert!(
            matches!(result, Err(crate::runtime::RunError::Receive(QueueError(ref error)))
            if error == "end of test")
        );
        let state = f.state.lock().unwrap();
        assert_eq!(state.jobs.get(FIRST), Some(&"PROCESSING"));
        assert_eq!(state.jobs.get(SECOND), Some(&"COMPLETED"));
        assert_eq!(state.calls.iter().filter(|c| *c == "encode").count(), 2);
        assert_eq!(state.calls.iter().filter(|c| *c == "delete").count(), 1);
        assert!(!state.calls.contains(&format!("complete:{FIRST}")));
    }
    #[tokio::test]
    async fn finished_records_are_not_renewed_while_later_records_keep_running() {
        for first_fails in [false, true] {
            for attempt in [1, 5] {
                let f = Fixture::new(Duration::from_millis(100), first_fails);
                f.state.lock().unwrap().attempt = attempt;
                f.run(&[FIRST, SECOND]).await;
                let s = f.state.lock().unwrap();
                assert_eq!(s.jobs.get(SECOND), Some(&"COMPLETED"));
                let transition = format!(
                    "{}:{FIRST}",
                    if first_fails {
                        if attempt == 5 { "fail" } else { "release" }
                    } else {
                        "complete"
                    }
                );
                let index = s.calls.iter().position(|c| c == &transition).unwrap();
                assert!(!s.calls[index + 1..].contains(&format!("renew:{FIRST}")));
                assert!(s.calls[index + 1..].contains(&format!("renew:{SECOND}")));
                if first_fails {
                    assert!(!s.calls.contains(&"delete".into()));
                    if attempt == 1 {
                        assert_eq!(s.calls.last().unwrap(), "visibility:1000");
                    }
                } else {
                    assert_eq!(s.calls.last().unwrap(), "delete");
                }
            }
        }
    }
    #[tokio::test]
    async fn lease_or_visibility_loss_during_encoding_prevents_publication_and_ack() {
        for visibility in [false, true] {
            let f = Fixture::new(Duration::from_millis(150), false);
            {
                let mut s = f.state.lock().unwrap();
                s.renewal_failure = !visibility;
                s.visibility_failure = visibility;
            }
            f.run(&[FIRST]).await;
            assert!(
                !f.log
                    .calls()
                    .iter()
                    .any(|c| matches!(c, crate::fakes::Call::Write { .. }))
            );
            assert!(
                !f.state
                    .lock()
                    .unwrap()
                    .calls
                    .iter()
                    .any(|c| c == "delete" || c.starts_with("complete:"))
            );
        }
    }
    #[tokio::test]
    async fn database_uncertainty_stops_renewal_and_returns_without_ack() {
        let f = Fixture::new(Duration::ZERO, false);
        f.state.lock().unwrap().completion_failure = true;
        f.run(&[FIRST]).await;
        let calls = f.state.lock().unwrap().calls.clone();
        assert!(!calls.contains(&"delete".into()));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(f.state.lock().unwrap().calls, calls);
    }
    #[tokio::test]
    async fn delete_failure_redelivery_only_retries_acknowledgement() {
        let f = Fixture::new(Duration::ZERO, false);
        f.state.lock().unwrap().delete_failure = true;
        f.run(&[FIRST]).await;
        let output = f.log.calls();
        f.state.lock().unwrap().delete_failure = false;
        f.run(&[FIRST]).await;
        assert_eq!(f.log.calls(), output);
        assert_eq!(
            f.state
                .lock()
                .unwrap()
                .calls
                .iter()
                .filter(|c| *c == "delete")
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn expired_or_consumed_initial_visibility_never_starts_processing() {
        for expired in [false, true] {
            let f = Fixture::new(Duration::ZERO, false);
            f.state.lock().unwrap().acquisition_delay = Duration::from_millis(100);
            let mut message = Fixture::message(&[FIRST]);
            message.visibility_deadline = Some(if expired {
                Instant::now()
            } else {
                Instant::now() + Duration::from_millis(10)
            });
            f.processor.process(message).await.unwrap();
            assert!(f.log.calls().is_empty());
            assert!(!f.state.lock().unwrap().calls.contains(&"delete".into()));
        }
    }
    #[tokio::test]
    async fn busy_failed_and_invalid_records_keep_message_undeleted() {
        for status in ["PROCESSING", "FAILED"] {
            let f = Fixture::new(Duration::ZERO, false);
            f.state.lock().unwrap().jobs.insert(FIRST.into(), status);
            f.run(&[FIRST, SECOND]).await;
            assert_eq!(f.state.lock().unwrap().jobs.get(SECOND), Some(&"COMPLETED"));
            assert!(!f.state.lock().unwrap().calls.contains(&"delete".into()));
        }
        let f = Fixture::new(Duration::ZERO, false);
        let mut message = Fixture::message(&[FIRST]);
        message.body = "invalid".into();
        f.processor.process(message).await.unwrap();
        assert!(f.state.lock().unwrap().calls.is_empty());
    }
}
