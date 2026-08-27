//! Job state ports.  State transitions are deliberately separate so callers
//! cannot accidentally treat a claim or failure as a successful completion.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistenceError(pub String);

impl fmt::Display for PersistenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PersistenceError {}

pub trait JobState {
    fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError>;
    fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError>;
    fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError>;
    fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError>;
}

pub mod postgres;
