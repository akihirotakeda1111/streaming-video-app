//! Message-level orchestration for lease acquisition, processing, and acking.

use std::{convert::Infallible, path::PathBuf, sync::Arc, time::SystemTime};

use encoding::Execute;
use persistence::JobState;
use queue::{ChangeVisibility, Delete, Message};
use storage::{Read, Write};
use tokio::{
    sync::{watch, Mutex},
    time::Instant,
};

use crate::{
    acquisition::{
        LeaseAcquisitionProcessor, NoWorkReason, RecordAcquisitionDisposition, WorkerIdentity,
    },
    heartbeat::{HeartbeatDeadlines, HeartbeatSettings},
    retry::{OwnedAttemptProcessor, ProcessingOutcome, RetrySettings},
    runtime::MessageProcessor,
};

/// Coordinates all records in one queue message. A message is acknowledged
/// only when every record is either durably completed or already completed.
pub struct MessageCompletionProcessor<J, S, E, Q> {
    acquisition: LeaseAcquisitionProcessor<J>,
    processing: OwnedAttemptProcessor<J, S, E>,
    heartbeat_jobs: Arc<Mutex<J>>,
    queue: Arc<Mutex<Q>>,
    heartbeat: HeartbeatSettings,
}

impl<J, S, E, Q> Clone for MessageCompletionProcessor<J, S, E, Q> {
    fn clone(&self) -> Self {
        Self {
            acquisition: self.acquisition.clone(),
            processing: self.processing.clone(),
            heartbeat_jobs: self.heartbeat_jobs.clone(),
            queue: self.queue.clone(),
            heartbeat: self.heartbeat,
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
        })
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
        let dispositions = self.acquisition.acquire_notification(&message.body).await;
        let acquired: Vec<_> = dispositions
            .iter()
            .filter_map(|disposition| match disposition {
                RecordAcquisitionDisposition::Acquired(job) => Some(job.clone()),
                _ => None,
            })
            .collect();

        let deadlines = HeartbeatDeadlines {
            lease: acquired
                .iter()
                .filter_map(|job| {
                    job.lease_expires_at
                        .duration_since(SystemTime::now())
                        .ok()
                        .map(|duration| Instant::now() + duration)
                })
                .min()
                .unwrap_or_else(Instant::now),
            visibility: Instant::now() + self.heartbeat.visibility_extension,
        };
        let (cancel, processing_cancel) = watch::channel(false);
        let heartbeat = crate::heartbeat::start(
            self.heartbeat_jobs.clone(),
            self.queue.clone(),
            message.receipt_handle.clone(),
            acquired,
            self.heartbeat,
            deadlines,
        );

        let mut acknowledge = true;
        for disposition in dispositions {
            match disposition {
                RecordAcquisitionDisposition::Acquired(job) => {
                    let mut cancelled = processing_cancel.clone();
                    match self.processing.process(&job, &mut cancelled).await {
                        Ok(ProcessingOutcome::Completed) => {}
                        Ok(ProcessingOutcome::RetryReleased { delay }) => {
                            acknowledge = false;
                            if let Err(error) = self
                                .queue
                                .lock()
                                .await
                                .change_visibility(&message.receipt_handle, delay)
                                .await
                            {
                                tracing::warn!(job_id = %job.item.job_id, error = %error.0, "retry visibility update failed");
                            }
                        }
                        Ok(outcome) => {
                            acknowledge = false;
                            tracing::warn!(job_id = %job.item.job_id, attempt = job.attempt, outcome = ?outcome, "record left for redrive");
                        }
                        Err(error) => {
                            acknowledge = false;
                            tracing::warn!(job_id = %job.item.job_id, error = %error, "record processing failed");
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

        let heartbeat_ok = if let Some(handle) = heartbeat {
            let _ = cancel.send(true);
            matches!(handle.join().await, Ok(Ok(())))
        } else {
            true
        };
        if acknowledge && heartbeat_ok {
            if let Err(error) = self
                .queue
                .lock()
                .await
                .delete(&message.receipt_handle)
                .await
            {
                tracing::warn!(error = %error.0, "completed message acknowledgement failed");
            }
        }
        Ok(())
    }
}
