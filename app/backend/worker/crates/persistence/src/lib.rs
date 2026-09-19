//! Job state ports.  State transitions are deliberately separate so callers
//! cannot accidentally treat a claim or failure as a successful completion.

use std::{fmt, future::Future, time::SystemTime};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistenceError(pub String);

impl fmt::Display for PersistenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PersistenceError {}

/// The result of a conditional owner-only state transition after acquisition.
/// A non-owner result is a normal outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobOperationOutcome {
    Applied,
    NotOwner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobClaimOutcome {
    Claimed,
    NotClaimed,
}

/// The immutable execution path selected for a job at first acquisition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobMode {
    Cli,
    Distributed,
}

impl JobMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Distributed => "distributed",
        }
    }
}

/// The complete result of one atomic lease-acquisition attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseAcquisitionOutcome {
    Acquired {
        attempt: u32,
        lease_expires_at: SystemTime,
    },
    AcquiredWithMode {
        attempt: u32,
        lease_expires_at: SystemTime,
        mode: JobMode,
    },
    Busy,
    Completed,
    Failed,
    UnknownOrMismatched,
    AttemptExhausted,
}

pub trait JobState: Send {
    fn claim(
        &mut self,
        job_id: &str,
        video_id: &str,
    ) -> impl Future<Output = Result<bool, PersistenceError>> + Send;
    fn mark_processing(
        &mut self,
        job_id: &str,
    ) -> impl Future<Output = Result<(), PersistenceError>> + Send;
    fn claim_upload(
        &mut self,
        job_id: &str,
        video_id: &str,
    ) -> impl Future<Output = Result<JobClaimOutcome, PersistenceError>> + Send {
        async move {
            Ok(if self.claim(job_id, video_id).await? {
                JobClaimOutcome::Claimed
            } else {
                JobClaimOutcome::NotClaimed
            })
        }
    }

    fn acquire_lease(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        lease_seconds: u64,
        max_attempts: u32,
    ) -> impl Future<Output = Result<LeaseAcquisitionOutcome, PersistenceError>> + Send {
        let _ = (job_id, video_id, worker_id, lease_seconds, max_attempts);
        async {
            Err(PersistenceError(
                "lease acquisition is not implemented".into(),
            ))
        }
    }

    /// Acquire using the deployment-selected mode. Implementations that do not
    /// support distributed selection fail closed instead of running the CLI
    /// acquire path.
    fn acquire_lease_with_mode(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        lease_seconds: u64,
        max_attempts: u32,
        mode: JobMode,
    ) -> impl Future<Output = Result<LeaseAcquisitionOutcome, PersistenceError>> + Send {
        async move {
            match mode {
                JobMode::Cli => {
                    self.acquire_lease(job_id, video_id, worker_id, lease_seconds, max_attempts)
                        .await
                }
                JobMode::Distributed => Err(PersistenceError(
                    "distributed lease acquisition is not implemented".into(),
                )),
            }
        }
    }

    fn renew_lease(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        lease_seconds: u64,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, video_id, worker_id, lease_seconds);
        async { Err(PersistenceError("lease renewal is not implemented".into())) }
    }

    fn release_for_retry(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        max_attempts: u32,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, video_id, worker_id, max_attempts);
        async { Err(PersistenceError("retry release is not implemented".into())) }
    }

    fn complete(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, video_id, worker_id);
        async { Err(PersistenceError("completion is not implemented".into())) }
    }

    fn complete_distributed(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        attempt: u32,
        published_manifest_key: &str,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, video_id, worker_id, attempt, published_manifest_key);
        async {
            Err(PersistenceError(
                "distributed completion is not implemented".into(),
            ))
        }
    }

    fn fail(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        reason: &str,
        max_attempts: u32,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, video_id, worker_id, reason, max_attempts);
        async { Err(PersistenceError("failure is not implemented".into())) }
    }
}

pub mod postgres;
pub mod tls;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    struct UnsupportedJobs;

    impl JobState for UnsupportedJobs {
        fn claim(
            &mut self,
            _job_id: &str,
            _video_id: &str,
        ) -> impl Future<Output = Result<bool, PersistenceError>> + Send {
            std::future::ready(Ok(false))
        }

        fn mark_processing(
            &mut self,
            _job_id: &str,
        ) -> impl Future<Output = Result<(), PersistenceError>> + Send {
            std::future::ready(Ok(()))
        }

        fn acquire_lease(
            &mut self,
            _job_id: &str,
            _video_id: &str,
            _worker_id: &str,
            _lease_seconds: u64,
            _max_attempts: u32,
        ) -> impl Future<Output = Result<LeaseAcquisitionOutcome, PersistenceError>> + Send
        {
            std::future::ready(Ok(LeaseAcquisitionOutcome::Acquired {
                attempt: 1,
                lease_expires_at: SystemTime::UNIX_EPOCH,
            }))
        }
    }

    #[tokio::test]
    async fn default_distributed_acquisition_fails_closed() {
        let mut jobs = UnsupportedJobs;
        let error = jobs
            .acquire_lease_with_mode("job", "video", "worker", 30, 3, JobMode::Distributed)
            .await
            .unwrap_err();
        assert!(error.0.contains("distributed"));
        assert!(matches!(
            jobs.acquire_lease_with_mode("job", "video", "worker", 30, 3, JobMode::Cli)
                .await
                .unwrap(),
            LeaseAcquisitionOutcome::Acquired { attempt: 1, .. }
        ));
    }
}
