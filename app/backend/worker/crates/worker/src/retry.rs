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
    DelayOutOfRange,
}

impl fmt::Display for RetrySettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ZeroAttempts => "maximum attempts must be positive",
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
        if !Self::owned(cancelled) {
            return Ok(ProcessingOutcome::OwnershipLost);
        }
        let directory = JobDirectory::create(&self.temporary_directory, &acquired.item.job_id)
            .map_err(|e| ProcessingError(format!("create work directory: {e}")))?;
        let result = self.run_pipeline(acquired, cancelled, &directory).await;
        let cleanup = directory
            .remove()
            .map_err(|e| ProcessingError(format!("remove work directory: {e}")));
        if let Err(error) = cleanup {
            return Err(error);
        }
        match result {
            Ok(()) => {
                let outcome = match self
                    .jobs
                    .lock()
                    .await
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
            Err(failure) => self.resolve_failure(acquired, failure).await,
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
        let source = self
            .storage
            .lock()
            .await
            .read(&acquired.item.bucket, &acquired.item.key)
            .await
            .map_err(|e: ObjectError| format!("download source: {}", e.0))?;
        tokio::fs::write(directory.path().join("source.mp4"), source)
            .await
            .map_err(|e| format!("write source: {e}"))?;
        let output = encode_hls(
            &mut *self.executor.lock().await,
            self.ffmpeg_path.clone(),
            directory.path(),
        )
        .await
        .map_err(|e: HlsError| format!("encode HLS: {e}"))?;
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
        failure: String,
    ) -> Result<ProcessingOutcome, ProcessingError>
    where
        J: JobState,
    {
        if failure == "ownership lost" {
            return Ok(ProcessingOutcome::OwnershipLost);
        }
        let mut jobs = self.jobs.lock().await;
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
