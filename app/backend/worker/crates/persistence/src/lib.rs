//! Job state ports.  State transitions are deliberately separate so callers
//! cannot accidentally treat a claim or failure as a successful completion.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistenceError(pub String);

pub trait JobState {
    fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError>;
    fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError>;
    fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError>;
    fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError>;
}
