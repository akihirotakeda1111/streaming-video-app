//! PostgreSQL implementation of the job-state port.

use postgres::{Client, NoTls, types::ToSql};

use crate::{JobState, PersistenceError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Uploading,
    Queued,
    Processing,
    Completed,
    Failed,
}

impl JobStatus {
    pub const fn as_contract_value(self) -> &'static str {
        match self {
            Self::Uploading => "UPLOADING",
            Self::Queued => "QUEUED",
            Self::Processing => "PROCESSING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
        }
    }
}

trait Database {
    fn execute(
        &mut self,
        statement: &str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, postgres::Error>;
}

impl Database for Client {
    fn execute(
        &mut self,
        statement: &str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, postgres::Error> {
        Client::execute(self, statement, parameters)
    }
}

pub struct PostgresJobState<D = Client> {
    database: D,
}

impl PostgresJobState<Client> {
    pub fn connect(database_url: &str) -> Result<Self, PersistenceError> {
        Client::connect(database_url, NoTls)
            .map(|database| Self { database })
            .map_err(map_error)
    }
}

impl<D> PostgresJobState<D> {
    fn new(database: D) -> Self {
        Self { database }
    }
}

impl<D: Database> PostgresJobState<D> {
    fn set_status(&mut self, job_id: &str, status: JobStatus) -> Result<(), PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = $1, failure_code = NULL, failure_message = NULL, updated_at = NOW() WHERE id = $2::uuid",
            &[&status.as_contract_value(), &job_id],
        ).map_err(map_error)?;
        require_one(changed)
    }
}

impl<D: Database> JobState for PostgresJobState<D> {
    fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError> {
        let changed = self
            .database
            .execute(
                "UPDATE jobs SET status = 'QUEUED', updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid AND video_id = $2::uuid AND status = 'UPLOADING'",
                &[&job_id, &video_id],
            )
            .map_err(map_error)?;
        match changed {
            1 => Ok(true),
            0 => Ok(false),
            count => Err(PersistenceError(format!(
                "updated {count} jobs; expected one"
            ))),
        }
    }

    fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.set_status(job_id, JobStatus::Processing)
    }

    fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.set_status(job_id, JobStatus::Completed)
    }

    fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = $1, failure_code = $2, failure_message = $3, updated_at = NOW() WHERE id = $4::uuid",
            &[&JobStatus::Failed.as_contract_value(), &"ENCODING_FAILED", &reason, &job_id],
        ).map_err(map_error)?;
        require_one(changed)
    }
}

fn require_one(changed: u64) -> Result<(), PersistenceError> {
    match changed {
        1 => Ok(()),
        0 => Err(PersistenceError("job not found".into())),
        count => Err(PersistenceError(format!(
            "updated {count} jobs; expected one"
        ))),
    }
}

fn map_error(error: postgres::Error) -> PersistenceError {
    PersistenceError(format!("postgres operation failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeDatabase {
        statements: Vec<String>,
        changed: u64,
    }

    impl Default for FakeDatabase {
        fn default() -> Self {
            Self {
                statements: Vec::new(),
                changed: 1,
            }
        }
    }

    impl Database for FakeDatabase {
        fn execute(
            &mut self,
            statement: &str,
            _parameters: &[&(dyn ToSql + Sync)],
        ) -> Result<u64, postgres::Error> {
            self.statements.push(statement.into());
            Ok(self.changed)
        }
    }

    #[test]
    fn all_contract_statuses_have_exact_database_values() {
        assert_eq!(
            [
                JobStatus::Uploading,
                JobStatus::Queued,
                JobStatus::Processing,
                JobStatus::Completed,
                JobStatus::Failed
            ]
            .map(JobStatus::as_contract_value),
            ["UPLOADING", "QUEUED", "PROCESSING", "COMPLETED", "FAILED"]
        );
    }

    #[test]
    fn claim_uses_conditional_upload_to_queued_update() {
        let mut jobs = PostgresJobState::new(FakeDatabase::default());
        assert!(jobs.claim("job-id", "video-id").unwrap());
        let statement = &jobs.database.statements[0];
        assert!(statement.contains("UPDATE jobs SET status = 'QUEUED'"));
        assert!(statement.contains("updated_at = CURRENT_TIMESTAMP"));
        assert!(statement.contains("id = $1::uuid"));
        assert!(statement.contains("video_id = $2::uuid"));
        assert!(statement.contains("status = 'UPLOADING'"));
    }

    #[test]
    fn zero_row_claim_is_a_safe_no_op() {
        let mut jobs = PostgresJobState::new(FakeDatabase {
            changed: 0,
            ..FakeDatabase::default()
        });
        assert!(!jobs.claim("job-id", "video-id").unwrap());
    }

    #[test]
    fn failure_update_populates_contract_required_details() {
        let mut jobs = PostgresJobState::new(FakeDatabase::default());
        jobs.mark_failed("job-id", "ffmpeg exited").unwrap();
        let statement = &jobs.database.statements[0];
        assert!(statement.contains("failure_code = $2"));
        assert!(statement.contains("failure_message = $3"));
        assert!(statement.contains("id = $4::uuid"));
    }
}
