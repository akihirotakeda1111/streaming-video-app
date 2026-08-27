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
    fn exists(
        &mut self,
        statement: &str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<bool, postgres::Error>;
}

impl Database for Client {
    fn execute(
        &mut self,
        statement: &str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, postgres::Error> {
        Client::execute(self, statement, parameters)
    }

    fn exists(
        &mut self,
        statement: &str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<bool, postgres::Error> {
        self.query_one(statement, parameters)?.try_get(0)
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
        self.database.exists(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE id = $1::uuid AND video_id = $2::uuid AND status = $3)",
            &[&job_id, &video_id, &JobStatus::Queued.as_contract_value()],
        ).map_err(map_error)
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

    #[derive(Default)]
    struct FakeDatabase {
        statements: Vec<String>,
        exists: bool,
    }

    impl Database for FakeDatabase {
        fn execute(
            &mut self,
            statement: &str,
            _parameters: &[&(dyn ToSql + Sync)],
        ) -> Result<u64, postgres::Error> {
            self.statements.push(statement.into());
            Ok(1)
        }

        fn exists(
            &mut self,
            statement: &str,
            _parameters: &[&(dyn ToSql + Sync)],
        ) -> Result<bool, postgres::Error> {
            self.statements.push(statement.into());
            Ok(self.exists)
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
    fn job_and_video_identifiers_are_both_used_for_claim_lookup() {
        let mut jobs = PostgresJobState::new(FakeDatabase {
            exists: true,
            ..Default::default()
        });
        assert!(jobs.claim("job-id", "video-id").unwrap());
        let statement = &jobs.database.statements[0];
        assert!(statement.contains("id = $1::uuid"));
        assert!(statement.contains("video_id = $2::uuid"));
        assert!(statement.contains("status = $3"));
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
