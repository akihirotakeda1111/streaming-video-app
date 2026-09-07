//! Cancellable ownership renewal for one received message.

use std::{fmt, sync::Arc, time::Duration};

use persistence::{JobOperationOutcome, JobState, PersistenceError};
use queue::{ChangeVisibility, QueueError};
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
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
    ) -> Option<HeartbeatHandle> {
        start(
            self.jobs.clone(),
            self.queue.clone(),
            receipt_handle,
            acquired,
            self.settings,
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
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = cancellation.changed() => return Ok(()),
                _ = tokio::time::sleep(settings.interval) => {}
            }

            let tick = renew_tick(
                jobs.clone(),
                queue.clone(),
                &receipt_handle,
                &acquired,
                settings,
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
) -> Result<(), HeartbeatLoss>
where
    J: JobState + Send + 'static,
    Q: ChangeVisibility + Send + 'static,
{
    for job in acquired {
        let outcome = jobs
            .lock()
            .await
            .renew_lease(
                &job.item.job_id,
                &job.item.video_id,
                job.worker_id.as_str(),
                settings.lease_duration.as_secs(),
            )
            .await
            .map_err(HeartbeatLoss::Database)?;
        if outcome != JobOperationOutcome::Applied {
            return Err(HeartbeatLoss::LeaseLost {
                job_id: job.item.job_id.clone(),
            });
        }
    }

    queue
        .lock()
        .await
        .change_visibility(receipt_handle, settings.visibility_extension)
        .await
        .map_err(HeartbeatLoss::Visibility)
}
