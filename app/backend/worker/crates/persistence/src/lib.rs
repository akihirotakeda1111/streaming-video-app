//! Job state ports.  State transitions are deliberately separate so callers
//! cannot accidentally treat a claim or failure as a successful completion.

use std::{fmt, future::Future};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistenceError(pub String);

impl fmt::Display for PersistenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PersistenceError {}

/// The result of a conditional state transition.  A non-owner result is a
/// normal outcome: the row may be missing, terminal, or owned by another
/// worker.
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
    fn mark_completed(
        &mut self,
        job_id: &str,
    ) -> impl Future<Output = Result<(), PersistenceError>> + Send;
    fn mark_failed(
        &mut self,
        job_id: &str,
        reason: &str,
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
        worker_id: &str,
        lease_seconds: u64,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, worker_id, lease_seconds);
        async { Err(PersistenceError("lease acquisition is not implemented".into())) }
    }

    fn renew_lease(
        &mut self,
        job_id: &str,
        worker_id: &str,
        lease_seconds: u64,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, worker_id, lease_seconds);
        async { Err(PersistenceError("lease renewal is not implemented".into())) }
    }

    fn release_for_retry(
        &mut self,
        job_id: &str,
        worker_id: &str,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, worker_id);
        async { Err(PersistenceError("retry release is not implemented".into())) }
    }

    fn complete(
        &mut self,
        job_id: &str,
        worker_id: &str,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, worker_id);
        async { Err(PersistenceError("completion is not implemented".into())) }
    }

    fn fail(
        &mut self,
        job_id: &str,
        worker_id: &str,
        reason: &str,
    ) -> impl Future<Output = Result<JobOperationOutcome, PersistenceError>> + Send {
        let _ = (job_id, worker_id, reason);
        async { Err(PersistenceError("failure is not implemented".into())) }
    }
}

pub mod postgres;
