//! Retry-safe processing for one already acquired lease.

use std::{fmt, path::PathBuf, sync::Arc, time::Duration};

use encoding::{Execute, HlsError, encode_hls, runtime::JobDirectory};
use persistence::{JobOperationOutcome, JobState, PersistenceError};
use storage::{ObjectError, Read, Write};
use tokio::sync::{Mutex, watch};

use crate::{
    acquisition::AcquiredJob,
    publish::{PublishError, publish_hls_with_checkpoint},
};

/// Runtime limits shared with the infrastructure contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetrySettings {
    pub maximum_attempts: u32,
    pub retry_delay: Duration,
}

impl RetrySettings {
    pub fn new(
        maximum_attempts: u32,
        retry_delay_seconds: u64,
    ) -> Result<Self, RetrySettingsError> {
        if maximum_attempts == 0 {
            return Err(RetrySettingsError::ZeroAttempts);
        }
        if maximum_attempts > 10 {
            return Err(RetrySettingsError::TooManyAttempts);
        }
        if retry_delay_seconds == 0 || retry_delay_seconds > 43_200 {
            return Err(RetrySettingsError::DelayOutOfRange);
        }
        Ok(Self {
            maximum_attempts,
            retry_delay: Duration::from_secs(retry_delay_seconds),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetrySettingsError {
    ZeroAttempts,
    TooManyAttempts,
    DelayOutOfRange,
}

impl fmt::Display for RetrySettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ZeroAttempts => "maximum attempts must be positive",
            Self::TooManyAttempts => "maximum attempts must not exceed 10",
            Self::DelayOutOfRange => "retry delay must be between 1 and 43200 seconds",
        })
    }
}
impl std::error::Error for RetrySettingsError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProcessingOutcome {
    Completed,
    RetryReleased { delay: Duration },
    FinalFailed,
    OwnershipLost,
    InfrastructureFailure,
}

#[derive(Debug)]
pub struct ProcessingError(pub String);
impl fmt::Display for ProcessingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ProcessingError {}

/// Processes only an `AcquiredJob`. It never acknowledges a queue message.
pub struct OwnedAttemptProcessor<J, S, E> {
    jobs: Arc<Mutex<J>>,
    storage: Arc<Mutex<S>>,
    executor: Arc<Mutex<E>>,
    output_bucket: String,
    ffmpeg_path: PathBuf,
    temporary_directory: PathBuf,
    settings: RetrySettings,
}

impl<J, S, E> Clone for OwnedAttemptProcessor<J, S, E> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
            storage: self.storage.clone(),
            executor: self.executor.clone(),
            output_bucket: self.output_bucket.clone(),
            ffmpeg_path: self.ffmpeg_path.clone(),
            temporary_directory: self.temporary_directory.clone(),
            settings: self.settings,
        }
    }
}

impl<J, S, E> OwnedAttemptProcessor<J, S, E> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        jobs: J,
        storage: S,
        executor: E,
        output_bucket: impl Into<String>,
        ffmpeg_path: impl Into<PathBuf>,
        temporary_directory: impl Into<PathBuf>,
        settings: RetrySettings,
    ) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(jobs)),
            storage: Arc::new(Mutex::new(storage)),
            executor: Arc::new(Mutex::new(executor)),
            output_bucket: output_bucket.into(),
            ffmpeg_path: ffmpeg_path.into(),
            temporary_directory: temporary_directory.into(),
            settings,
        }
    }

    fn owned(cancelled: &watch::Receiver<bool>) -> bool {
        !*cancelled.borrow()
    }

    pub async fn process(
        &self,
        acquired: &AcquiredJob,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<ProcessingOutcome, ProcessingError>
    where
        J: JobState,
        S: Read + Write,
        E: Execute,
    {
        self.process_with_cleanup(acquired, cancelled, JobDirectory::remove)
            .await
    }

    async fn process_with_cleanup(
        &self,
        acquired: &AcquiredJob,
        cancelled: &mut watch::Receiver<bool>,
        cleanup: impl FnOnce(JobDirectory) -> std::io::Result<()>,
    ) -> Result<ProcessingOutcome, ProcessingError>
    where
        J: JobState,
        S: Read + Write,
        E: Execute,
    {
        if !Self::owned(cancelled) {
            return Ok(ProcessingOutcome::OwnershipLost);
        }
        let directory = match JobDirectory::create(&self.temporary_directory, &acquired.item.job_id)
        {
            Ok(directory) => directory,
            Err(error) => {
                return self
                    .resolve_failure(
                        acquired,
                        cancelled,
                        format!("create work directory: {error}"),
                    )
                    .await;
            }
        };
        let result = self.run_pipeline(acquired, cancelled, &directory).await;
        if let Err(error) = cleanup(directory) {
            // Cleanup must not suppress the durable outcome of published work.
            tracing::warn!(job_id = %acquired.item.job_id, error_kind = ?error.kind(), "remove work directory failed");
        }
        match result {
            Ok(()) => {
                let mut jobs = self.jobs.lock().await;
                if !Self::owned(cancelled) {
                    return Ok(ProcessingOutcome::OwnershipLost);
                }
                let outcome = match jobs
                    .complete(
                        &acquired.item.job_id,
                        &acquired.item.video_id,
                        acquired.worker_id.as_str(),
                    )
                    .await
                {
                    Ok(outcome) => outcome,
                    Err(_) => return Ok(ProcessingOutcome::InfrastructureFailure),
                };
                Ok(if outcome == JobOperationOutcome::Applied {
                    ProcessingOutcome::Completed
                } else {
                    ProcessingOutcome::OwnershipLost
                })
            }
            Err(failure) => self.resolve_failure(acquired, cancelled, failure).await,
        }
    }

    async fn run_pipeline(
        &self,
        acquired: &AcquiredJob,
        cancelled: &mut watch::Receiver<bool>,
        directory: &JobDirectory,
    ) -> Result<(), String>
    where
        J: JobState,
        S: Read + Write,
        E: Execute,
    {
        if !Self::owned(cancelled) {
            return Err("ownership lost".into());
        }
        let mut storage = self.storage.lock().await;
        if !Self::owned(cancelled) {
            return Err("ownership lost".into());
        }
        let source = storage
            .read(&acquired.item.bucket, &acquired.item.key)
            .await
            .map_err(|e: ObjectError| format!("download source: {}", e.0))?;
        drop(storage);
        if !Self::owned(cancelled) {
            return Err("ownership lost".into());
        }
        tokio::fs::write(directory.path().join("source.mp4"), source)
            .await
            .map_err(|e| format!("write source: {e}"))?;
        let mut executor = self.executor.lock().await;
        if !Self::owned(cancelled) {
            return Err("ownership lost".into());
        }
        let output = encode_hls(&mut *executor, self.ffmpeg_path.clone(), directory.path())
            .await
            .map_err(|e: HlsError| format!("encode HLS: {e}"))?;
        drop(executor);
        if !Self::owned(cancelled) {
            return Err("ownership lost".into());
        }
        publish_hls_with_checkpoint(
            &mut *self.storage.lock().await,
            &self.output_bucket,
            &acquired.item.video_id,
            &acquired.item.job_id,
            &output,
            || Self::owned(cancelled),
        )
        .await
        .map_err(|e: PublishError| match e {
            PublishError::OwnershipLost => "ownership lost".into(),
            other => format!("publish HLS: {other}"),
        })
    }

    async fn resolve_failure(
        &self,
        acquired: &AcquiredJob,
        cancelled: &watch::Receiver<bool>,
        failure: String,
    ) -> Result<ProcessingOutcome, ProcessingError>
    where
        J: JobState,
    {
        if failure == "ownership lost" || !Self::owned(cancelled) {
            return Ok(ProcessingOutcome::OwnershipLost);
        }
        let mut jobs = self.jobs.lock().await;
        if !Self::owned(cancelled) {
            return Ok(ProcessingOutcome::OwnershipLost);
        }
        let operation = if acquired.attempt < self.settings.maximum_attempts {
            jobs.release_for_retry(
                &acquired.item.job_id,
                &acquired.item.video_id,
                acquired.worker_id.as_str(),
                self.settings.maximum_attempts,
            )
            .await
        } else {
            jobs.fail(
                &acquired.item.job_id,
                &acquired.item.video_id,
                acquired.worker_id.as_str(),
                &failure,
                self.settings.maximum_attempts,
            )
            .await
        }
        .map_err(|_: PersistenceError| ProcessingError("persist processing outcome".into()));
        let operation = match operation {
            Ok(operation) => operation,
            Err(_) => return Ok(ProcessingOutcome::InfrastructureFailure),
        };
        Ok(
            match (acquired.attempt < self.settings.maximum_attempts, operation) {
                (true, JobOperationOutcome::Applied) => ProcessingOutcome::RetryReleased {
                    delay: self.settings.retry_delay,
                },
                (false, JobOperationOutcome::Applied) => ProcessingOutcome::FinalFailed,
                (_, JobOperationOutcome::NotOwner) => ProcessingOutcome::OwnershipLost,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        acquisition::WorkerIdentity,
        event::WorkItem,
        fakes::{Call, CallLog, FakeProcessExecutor, FakeStorage},
    };
    use std::{io, time::SystemTime};

    struct Jobs {
        calls: Vec<&'static str>,
        failure: Option<String>,
        outcome: Result<JobOperationOutcome, PersistenceError>,
    }

    impl JobState for Jobs {
        async fn claim(&mut self, _: &str, _: &str) -> Result<bool, PersistenceError> {
            panic!("legacy claim")
        }
        async fn mark_processing(&mut self, _: &str) -> Result<(), PersistenceError> {
            panic!("legacy processing")
        }
        async fn mark_completed(&mut self, _: &str) -> Result<(), PersistenceError> {
            panic!("legacy completion")
        }
        async fn mark_failed(&mut self, _: &str, _: &str) -> Result<(), PersistenceError> {
            panic!("legacy failure")
        }
        async fn complete(
            &mut self,
            job: &str,
            video: &str,
            worker: &str,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            assert_eq!((job, video, worker), ("job", "video", "worker"));
            self.calls.push("complete");
            self.outcome.clone()
        }
        async fn release_for_retry(
            &mut self,
            _: &str,
            _: &str,
            _: &str,
            maximum: u32,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            assert_eq!(maximum, 5);
            self.calls.push("release");
            self.outcome.clone()
        }
        async fn fail(
            &mut self,
            _: &str,
            _: &str,
            _: &str,
            reason: &str,
            maximum: u32,
        ) -> Result<JobOperationOutcome, PersistenceError> {
            assert_eq!(maximum, 5);
            assert!(!reason.is_empty());
            self.calls.push("fail");
            self.failure = Some(reason.into());
            self.outcome.clone()
        }
    }

    struct Storage {
        inner: FakeStorage,
        cancel: watch::Sender<bool>,
        cancel_after_write: Option<usize>,
        cancel_after_read: bool,
        writes: usize,
    }
    impl Read for Storage {
        async fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError> {
            let result = self.inner.read(bucket, key).await;
            if self.cancel_after_read {
                self.cancel.send_replace(true);
            }
            result
        }
    }
    impl Write for Storage {
        async fn write(
            &mut self,
            bucket: &str,
            key: &str,
            kind: &str,
            bytes: &[u8],
        ) -> Result<(), ObjectError> {
            let result = self.inner.write(bucket, key, kind, bytes).await;
            self.writes += 1;
            if self.cancel_after_write == Some(self.writes) {
                self.cancel.send_replace(true);
            }
            result
        }
    }

    struct Fixture {
        root: tempfile::TempDir,
        processor: OwnedAttemptProcessor<Jobs, Storage, FakeProcessExecutor>,
        cancel: watch::Sender<bool>,
        receiver: watch::Receiver<bool>,
        log: CallLog,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let (cancel, receiver) = watch::channel(false);
            let log = CallLog::default();
            let mut storage = FakeStorage::new(log.clone());
            storage.add_read("input", "source", b"source".to_vec());
            let processor = OwnedAttemptProcessor::new(
                Jobs {
                    calls: vec![],
                    failure: None,
                    outcome: Ok(JobOperationOutcome::Applied),
                },
                Storage {
                    inner: storage,
                    cancel: cancel.clone(),
                    cancel_after_write: None,
                    cancel_after_read: false,
                    writes: 0,
                },
                FakeProcessExecutor::stub_hls(log.clone()),
                "output",
                "ffmpeg",
                root.path(),
                RetrySettings::new(5, 900).unwrap(),
            );
            Self {
                root,
                processor,
                cancel,
                receiver,
                log,
            }
        }
        async fn run(&mut self, attempt: u32) -> ProcessingOutcome {
            self.processor
                .process(&job(attempt), &mut self.receiver)
                .await
                .unwrap()
        }
    }
    fn job(attempt: u32) -> AcquiredJob {
        AcquiredJob {
            item: WorkItem {
                job_id: "job".into(),
                video_id: "video".into(),
                bucket: "input".into(),
                key: "source".into(),
            },
            worker_id: WorkerIdentity::from_value("worker").unwrap(),
            attempt,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        }
    }
    fn retry_outcome(attempt: u32) -> ProcessingOutcome {
        if attempt < 5 {
            ProcessingOutcome::RetryReleased {
                delay: Duration::from_secs(900),
            }
        } else {
            ProcessingOutcome::FinalFailed
        }
    }

    #[test]
    fn settings_enforce_infrastructure_bounds() {
        for attempts in [0, 11, u32::MAX] {
            assert!(RetrySettings::new(attempts, 900).is_err());
        }
        for delay in [0, 43_201, u64::MAX] {
            assert!(RetrySettings::new(5, delay).is_err());
        }
        for attempts in [1, 10] {
            for delay in [1, 43_200] {
                assert!(RetrySettings::new(attempts, delay).is_ok());
            }
        }
    }

    #[tokio::test]
    async fn directory_creation_failure_releases_or_finally_fails_without_pipeline_work() {
        for attempt in [1, 5] {
            let mut f = Fixture::new();
            let file = f.root.path().join("file");
            std::fs::write(&file, b"not a directory").unwrap();
            f.processor.temporary_directory = file;
            assert_eq!(f.run(attempt).await, retry_outcome(attempt));
            let jobs = f.processor.jobs.lock().await;
            assert_eq!(jobs.calls, [if attempt < 5 { "release" } else { "fail" }]);
            if attempt == 5 {
                assert!(
                    jobs.failure
                        .as_ref()
                        .unwrap()
                        .starts_with("create work directory:")
                );
            }
            assert!(f.log.calls().is_empty());
        }
    }

    #[tokio::test]
    async fn cleanup_failure_preserves_success_and_original_processing_failure() {
        for failed in [false, true] {
            for attempt in [1, 5] {
                let mut f = Fixture::new();
                if failed {
                    f.processor
                        .storage
                        .lock()
                        .await
                        .inner
                        .fail_read("original download failure");
                }
                let outcome = f
                    .processor
                    .process_with_cleanup(&job(attempt), &mut f.receiver, |directory| {
                        drop(directory);
                        Err(io::Error::other("injected cleanup failure"))
                    })
                    .await
                    .unwrap();
                assert_eq!(
                    outcome,
                    if failed {
                        retry_outcome(attempt)
                    } else {
                        ProcessingOutcome::Completed
                    }
                );
                let jobs = f.processor.jobs.lock().await;
                assert_eq!(
                    jobs.calls,
                    [if !failed {
                        "complete"
                    } else if attempt < 5 {
                        "release"
                    } else {
                        "fail"
                    }]
                );
                if failed && attempt == 5 {
                    assert_eq!(
                        jobs.failure.as_deref(),
                        Some("download source: original download failure")
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn each_pipeline_failure_obeys_attempt_budget_and_cleans_up() {
        for stage in 0..5 {
            for attempt in [1, 5] {
                let mut f = Fixture::new();
                match stage {
                    0 => f
                        .processor
                        .storage
                        .lock()
                        .await
                        .inner
                        .fail_read("download failed"),
                    1 => f.processor.executor.lock().await.fail_next("encode failed"),
                    _ => f
                        .processor
                        .storage
                        .lock()
                        .await
                        .inner
                        .fail_write_after(stage - 2, "upload failed"),
                }
                assert_eq!(f.run(attempt).await, retry_outcome(attempt));
                assert_eq!(
                    f.processor.jobs.lock().await.calls,
                    [if attempt < 5 { "release" } else { "fail" }]
                );
                assert_eq!(std::fs::read_dir(f.root.path()).unwrap().count(), 0);
            }
        }
    }

    #[tokio::test]
    async fn cancellation_during_each_upload_stops_later_output_and_state_updates() {
        for write in 1..=3 {
            let mut f = Fixture::new();
            f.processor.storage.lock().await.cancel_after_write = Some(write);
            assert_eq!(f.run(1).await, ProcessingOutcome::OwnershipLost);
            assert_eq!(f.processor.storage.lock().await.writes, write);
            assert!(f.processor.jobs.lock().await.calls.is_empty());
        }
    }

    #[tokio::test]
    async fn cancellation_before_work_and_during_download_prevents_encoding() {
        for before in [false, true] {
            let mut f = Fixture::new();
            if before {
                f.cancel.send_replace(true);
            } else {
                f.processor.storage.lock().await.cancel_after_read = true;
            }
            assert_eq!(f.run(1).await, ProcessingOutcome::OwnershipLost);
            assert!(f.processor.jobs.lock().await.calls.is_empty());
            assert!(
                !f.log
                    .calls()
                    .iter()
                    .any(|call| matches!(call, Call::Execute(_) | Call::Write { .. }))
            );
        }
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_database_prevents_every_transition() {
        for failed in [false, true] {
            for attempt in [1, 5] {
                let mut f = Fixture::new();
                if failed {
                    f.processor.storage.lock().await.inner.fail_read("failed");
                }
                let jobs = f.processor.jobs.lock().await;
                let cleaned = tokio::sync::Notify::new();
                let acquired = job(attempt);
                let future =
                    f.processor
                        .process_with_cleanup(&acquired, &mut f.receiver, |directory| {
                            let result = directory.remove();
                            cleaned.notify_one();
                            result
                        });
                tokio::pin!(future);
                tokio::select! {
                    biased;
                    _ = &mut future => panic!("must wait for database lock"),
                    _ = cleaned.notified() => {}
                }
                f.cancel.send_replace(true);
                drop(jobs);
                assert_eq!(future.await.unwrap(), ProcessingOutcome::OwnershipLost);
                assert!(f.processor.jobs.lock().await.calls.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn cancellation_during_cleanup_prevents_completion_release_and_failure() {
        for failed in [false, true] {
            for attempt in [1, 5] {
                let mut f = Fixture::new();
                if failed {
                    f.processor.storage.lock().await.inner.fail_read("failed");
                }
                let outcome = f
                    .processor
                    .process_with_cleanup(&job(attempt), &mut f.receiver, |directory| {
                        drop(directory);
                        f.cancel.send_replace(true);
                        Err(io::Error::other("cleanup failed"))
                    })
                    .await
                    .unwrap();
                assert_eq!(outcome, ProcessingOutcome::OwnershipLost);
                assert!(f.processor.jobs.lock().await.calls.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn stale_owner_and_database_errors_never_report_terminal_success() {
        for failed in [false, true] {
            for attempt in [1, 5] {
                for database_error in [false, true] {
                    let mut f = Fixture::new();
                    if failed {
                        f.processor.storage.lock().await.inner.fail_read("failed");
                    }
                    f.processor.jobs.lock().await.outcome = if database_error {
                        Err(PersistenceError("unavailable".into()))
                    } else {
                        Ok(JobOperationOutcome::NotOwner)
                    };
                    assert_eq!(
                        f.run(attempt).await,
                        if database_error {
                            ProcessingOutcome::InfrastructureFailure
                        } else {
                            ProcessingOutcome::OwnershipLost
                        }
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn successful_attempt_publishes_manifest_last_then_completes_and_cleans_up() {
        let mut f = Fixture::new();
        assert_eq!(f.run(1).await, ProcessingOutcome::Completed);
        let calls = f.log.calls();
        assert!(matches!(&calls[0], Call::Read { .. }));
        assert!(matches!(&calls[1], Call::Execute(_)));
        let keys: Vec<_> = calls
            .iter()
            .filter_map(|call| match call {
                Call::Write { key, .. } => Some(key.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            keys,
            [
                "videos/video/jobs/job/hls/segment-00000.ts",
                "videos/video/jobs/job/hls/segment-00001.ts",
                "videos/video/jobs/job/hls/index.m3u8"
            ]
        );
        assert_eq!(f.processor.jobs.lock().await.calls, ["complete"]);
        assert_eq!(std::fs::read_dir(f.root.path()).unwrap().count(), 0);
    }
}
