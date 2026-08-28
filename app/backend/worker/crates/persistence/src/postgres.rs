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
    fn execute(&mut self, statement: &str, parameters: &[&str]) -> Result<u64, postgres::Error>;
}

impl Database for Client {
    fn execute(&mut self, statement: &str, parameters: &[&str]) -> Result<u64, postgres::Error> {
        let values: Vec<&(dyn ToSql + Sync)> = parameters
            .iter()
            .map(|value| value as &(dyn ToSql + Sync))
            .collect();
        Client::execute(self, statement, &values)
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
    fn set_status(
        &mut self,
        job_id: &str,
        status: JobStatus,
        required_status: &'static str,
    ) -> Result<(), PersistenceError> {
        let changed = self
            .database
            .execute(
                "UPDATE jobs SET status = $1, failure_code = NULL, failure_message = NULL, updated_at = NOW() WHERE id = $2::text::uuid AND status = $3",
                &[status.as_contract_value(), job_id, required_status],
            )
            .map_err(map_error)?;
        require_one(changed)
    }
}

impl<D: Database> JobState for PostgresJobState<D> {
    fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError> {
        let changed = self
            .database
            .execute(
                "UPDATE jobs SET status = 'QUEUED', updated_at = CURRENT_TIMESTAMP WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND status = 'UPLOADING'",
                &[job_id, video_id],
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
        self.set_status(
            job_id,
            JobStatus::Processing,
            JobStatus::Queued.as_contract_value(),
        )
    }

    fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.set_status(
            job_id,
            JobStatus::Completed,
            JobStatus::Processing.as_contract_value(),
        )
    }

    fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = $1, failure_code = $2, failure_message = $3, updated_at = NOW() WHERE id = $4::text::uuid AND status IN ('QUEUED', 'PROCESSING')",
            &[JobStatus::Failed.as_contract_value(), "ENCODING_FAILED", reason, job_id],
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
#[path = "postgres_live.rs"]
mod live;

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeDatabase {
        parameters: Vec<Vec<String>>,
        changed: u64,
    }

    impl Default for FakeDatabase {
        fn default() -> Self {
            Self {
                parameters: Vec::new(),
                changed: 1,
            }
        }
    }

    impl Database for FakeDatabase {
        fn execute(
            &mut self,
            _statement: &str,
            parameters: &[&str],
        ) -> Result<u64, postgres::Error> {
            self.parameters
                .push(parameters.iter().map(|value| (*value).to_owned()).collect());
            Ok(self.changed)
        }
    }

    fn jobs() -> PostgresJobState<FakeDatabase> {
        PostgresJobState::new(FakeDatabase::default())
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
    fn driver_bindings_use_contract_values_in_call_order() {
        let mut claim = jobs();
        assert!(claim.claim("job-id", "video-id").unwrap());
        assert_eq!(claim.database.parameters, [["job-id", "video-id"]]);

        let mut processing = jobs();
        processing.mark_processing("job-id").unwrap();
        assert_eq!(
            processing.database.parameters,
            [["PROCESSING", "job-id", "QUEUED"]]
        );

        let mut completed = jobs();
        completed.mark_completed("job-id").unwrap();
        assert_eq!(
            completed.database.parameters,
            [["COMPLETED", "job-id", "PROCESSING"]]
        );

        let mut failed = jobs();
        failed.mark_failed("job-id", "ffmpeg exited").unwrap();
        assert_eq!(
            failed.database.parameters,
            [["FAILED", "ENCODING_FAILED", "ffmpeg exited", "job-id"]]
        );
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
    fn zero_row_status_change_is_an_error() {
        let mut jobs = PostgresJobState::new(FakeDatabase {
            changed: 0,
            ..FakeDatabase::default()
        });
        assert!(jobs.mark_processing("job-id").is_err());
        assert!(jobs.mark_completed("job-id").is_err());
        assert!(jobs.mark_failed("job-id", "ffmpeg exited").is_err());
    }
}
