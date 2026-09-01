//! PostgreSQL implementation of the job-state port.

use std::future::Future;

use tokio_postgres::{Client, NoTls, types::ToSql};

use crate::{JobClaimOutcome, JobOperationOutcome, JobState, PersistenceError};

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
        parameters: &[&str],
    ) -> impl Future<Output = Result<u64, tokio_postgres::Error>> + Send;
}

impl Database for Client {
    async fn execute(
        &mut self,
        statement: &str,
        parameters: &[&str],
    ) -> Result<u64, tokio_postgres::Error> {
        let values: Vec<&(dyn ToSql + Sync)> = parameters
            .iter()
            .map(|value| value as &(dyn ToSql + Sync))
            .collect();
        Client::execute(self, statement, &values).await
    }
}

pub struct PostgresJobState<D = Client> {
    database: D,
}

impl PostgresJobState<Client> {
    pub async fn connect(database_url: &str) -> Result<Self, PersistenceError> {
        let (database, connection) = tokio_postgres::connect(database_url, NoTls)
            .await
            .map_err(map_error)?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::error!(%error, "postgres connection stopped");
            }
        });
        Ok(Self { database })
    }
}

#[cfg(test)]
impl<D> PostgresJobState<D> {
    fn new(database: D) -> Self {
        Self { database }
    }
}

#[allow(private_bounds)]
impl<D: Database> PostgresJobState<D> {
    async fn set_status(
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
            .await
            .map_err(map_error)?;
        require_one(changed)
    }
}

impl<D: Database + Send> JobState for PostgresJobState<D> {
    async fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError> {
        let changed = self
            .database
            .execute(
                "UPDATE jobs SET status = 'QUEUED', updated_at = CURRENT_TIMESTAMP WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND status = 'UPLOADING'",
                &[job_id, video_id],
            )
            .await
            .map_err(map_error)?;
        match changed {
            1 => Ok(true),
            0 => Ok(false),
            count => Err(PersistenceError(format!(
                "updated {count} jobs; expected one"
            ))),
        }
    }

    async fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.set_status(
            job_id,
            JobStatus::Processing,
            JobStatus::Queued.as_contract_value(),
        )
        .await
    }

    async fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.set_status(
            job_id,
            JobStatus::Completed,
            JobStatus::Processing.as_contract_value(),
        )
        .await
    }

    async fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = $1, failure_code = $2, failure_message = $3, updated_at = NOW() WHERE id = $4::text::uuid AND status IN ('QUEUED', 'PROCESSING')",
            &[JobStatus::Failed.as_contract_value(), "ENCODING_FAILED", reason, job_id],
        ).await.map_err(map_error)?;
        require_one(changed)
    }

    async fn claim_upload(&mut self, job_id: &str, video_id: &str) -> Result<JobClaimOutcome, PersistenceError> {
        Ok(if self.claim(job_id, video_id).await? {
            JobClaimOutcome::Claimed
        } else {
            JobClaimOutcome::NotClaimed
        })
    }

    async fn acquire_lease(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        lease_seconds: u64,
        max_attempts: u32,
    ) -> Result<JobOperationOutcome, PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = 'PROCESSING', worker_id = $3, lease_expires_at = NOW() + ($4::text || ' seconds')::interval, attempt = attempt + 1, updated_at = NOW() WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND status IN ('QUEUED', 'PROCESSING') AND attempt < $5::text::int AND ((worker_id IS NULL AND lease_expires_at IS NULL) OR lease_expires_at <= NOW())",
            &[job_id, video_id, worker_id, &lease_seconds.to_string(), &max_attempts.to_string()],
        ).await.map_err(map_error)?;
        atomic_outcome(changed)
    }

    async fn renew_lease(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<JobOperationOutcome, PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET lease_expires_at = NOW() + ($4::text || ' seconds')::interval, updated_at = NOW() WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND worker_id = $3 AND status = 'PROCESSING' AND lease_expires_at > NOW()",
            &[job_id, video_id, worker_id, &lease_seconds.to_string()],
        ).await.map_err(map_error)?;
        atomic_outcome(changed)
    }

    async fn release_for_retry(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        max_attempts: u32,
    ) -> Result<JobOperationOutcome, PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = 'QUEUED', worker_id = NULL, lease_expires_at = NULL, failure_code = NULL, failure_message = NULL, updated_at = NOW() WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND worker_id = $3 AND status = 'PROCESSING' AND lease_expires_at > NOW() AND attempt < $4::text::int",
            &[job_id, video_id, worker_id, &max_attempts.to_string()],
        ).await.map_err(map_error)?;
        atomic_outcome(changed)
    }

    async fn complete(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
    ) -> Result<JobOperationOutcome, PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = 'COMPLETED', worker_id = NULL, lease_expires_at = NULL, failure_code = NULL, failure_message = NULL, updated_at = NOW() WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND worker_id = $3 AND status = 'PROCESSING' AND lease_expires_at > NOW()",
            &[job_id, video_id, worker_id],
        ).await.map_err(map_error)?;
        atomic_outcome(changed)
    }

    async fn fail(
        &mut self,
        job_id: &str,
        video_id: &str,
        worker_id: &str,
        reason: &str,
        max_attempts: u32,
    ) -> Result<JobOperationOutcome, PersistenceError> {
        let changed = self.database.execute(
            "UPDATE jobs SET status = 'FAILED', worker_id = NULL, lease_expires_at = NULL, failure_code = 'ENCODING_FAILED', failure_message = $4, updated_at = NOW() WHERE id = $1::text::uuid AND video_id = $2::text::uuid AND worker_id = $3 AND status = 'PROCESSING' AND lease_expires_at > NOW() AND attempt >= $5::text::int AND $4 <> ''",
            &[job_id, video_id, worker_id, reason, &max_attempts.to_string()],
        ).await.map_err(map_error)?;
        atomic_outcome(changed)
    }
}

fn atomic_outcome(changed: u64) -> Result<JobOperationOutcome, PersistenceError> {
    match changed {
        0 => Ok(JobOperationOutcome::NotOwner),
        1 => Ok(JobOperationOutcome::Applied),
        count => Err(PersistenceError(format!("updated {count} jobs; expected one"))),
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

fn map_error(error: tokio_postgres::Error) -> PersistenceError {
    PersistenceError(format!("postgres operation failed: {error}"))
}

#[cfg(test)]
#[path = "postgres_live.rs"]
mod live;

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeDatabase {
        statements: Vec<String>,
        parameters: Vec<Vec<String>>,
        changed: u64,
    }

    impl Default for FakeDatabase {
        fn default() -> Self {
            Self {
                statements: Vec::new(),
                parameters: Vec::new(),
                changed: 1,
            }
        }
    }

    impl Database for FakeDatabase {
        fn execute(
            &mut self,
            statement: &str,
            parameters: &[&str],
        ) -> impl Future<Output = Result<u64, tokio_postgres::Error>> + Send {
            let result = {
                self.statements.push(statement.to_owned());
                self.parameters
                    .push(parameters.iter().map(|value| (*value).to_owned()).collect());
                Ok(self.changed)
            };
            std::future::ready(result)
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

    #[tokio::test]
    async fn driver_bindings_use_contract_values_in_call_order() {
        let mut claim = jobs();
        assert!(claim.claim("job-id", "video-id").await.unwrap());
        assert_eq!(claim.database.parameters, [["job-id", "video-id"]]);

        let mut processing = jobs();
        processing.mark_processing("job-id").await.unwrap();
        assert_eq!(
            processing.database.parameters,
            [["PROCESSING", "job-id", "QUEUED"]]
        );

        let mut completed = jobs();
        completed.mark_completed("job-id").await.unwrap();
        assert_eq!(
            completed.database.parameters,
            [["COMPLETED", "job-id", "PROCESSING"]]
        );

        let mut failed = jobs();
        failed.mark_failed("job-id", "ffmpeg exited").await.unwrap();
        assert_eq!(
            failed.database.parameters,
            [["FAILED", "ENCODING_FAILED", "ffmpeg exited", "job-id"]]
        );
    }

    #[tokio::test]
    async fn zero_row_claim_is_a_safe_no_op() {
        let mut jobs = PostgresJobState::new(FakeDatabase {
            changed: 0,
            ..FakeDatabase::default()
        });
        assert!(!jobs.claim("job-id", "video-id").await.unwrap());
    }

    #[tokio::test]
    async fn zero_row_status_change_is_an_error() {
        let mut jobs = PostgresJobState::new(FakeDatabase {
            changed: 0,
            ..FakeDatabase::default()
        });
        assert!(jobs.mark_processing("job-id").await.is_err());
        assert!(jobs.mark_completed("job-id").await.is_err());
        assert!(jobs.mark_failed("job-id", "ffmpeg exited").await.is_err());
    }

    #[tokio::test]
    async fn lease_operations_bind_canonical_ids_and_attempt_budget() {
        let mut jobs = jobs();
        assert_eq!(
            jobs.acquire_lease("job-id", "video-id", "worker-a", 30, 3)
                .await
                .unwrap(),
            JobOperationOutcome::Applied
        );
        assert_eq!(
            jobs.renew_lease("job-id", "video-id", "worker-a", 30)
                .await
                .unwrap(),
            JobOperationOutcome::Applied
        );
        assert_eq!(
            jobs.release_for_retry("job-id", "video-id", "worker-a", 3)
                .await
                .unwrap(),
            JobOperationOutcome::Applied
        );
        assert_eq!(
            jobs.complete("job-id", "video-id", "worker-a")
                .await
                .unwrap(),
            JobOperationOutcome::Applied
        );
        assert_eq!(
            jobs.fail("job-id", "video-id", "worker-a", "ffmpeg exited", 3)
                .await
                .unwrap(),
            JobOperationOutcome::Applied
        );

        assert_eq!(
            jobs.database.parameters[0],
            ["job-id", "video-id", "worker-a", "30", "3"]
        );
        assert_eq!(
            jobs.database.parameters[1],
            ["job-id", "video-id", "worker-a", "30"]
        );
        assert_eq!(
            jobs.database.parameters[2],
            ["job-id", "video-id", "worker-a", "3"]
        );
        assert_eq!(jobs.database.parameters[3], ["job-id", "video-id", "worker-a"]);
        assert_eq!(
            jobs.database.parameters[4],
            ["job-id", "video-id", "worker-a", "ffmpeg exited", "3"]
        );

        let acquire = &jobs.database.statements[0];
        assert!(acquire.contains("video_id = $2::text::uuid"));
        assert!(acquire.contains("attempt < $5::text::int"));
        assert!(acquire.contains("worker_id IS NULL AND lease_expires_at IS NULL"));
        assert!(acquire.contains("status IN ('QUEUED', 'PROCESSING')"));

        assert!(jobs.database.statements[1].contains("lease_expires_at > NOW()"));
        assert!(jobs.database.statements[2].contains("lease_expires_at > NOW()"));
        assert!(jobs.database.statements[2].contains("attempt < $4::text::int"));
        assert!(jobs.database.statements[3].contains("lease_expires_at > NOW()"));
        assert!(jobs.database.statements[4].contains("lease_expires_at > NOW()"));
        assert!(jobs.database.statements[4].contains("attempt >= $5::text::int"));
    }

    #[tokio::test]
    async fn zero_row_lease_operation_is_not_owner() {
        let mut jobs = PostgresJobState::new(FakeDatabase {
            changed: 0,
            ..FakeDatabase::default()
        });
        assert_eq!(
            jobs.acquire_lease("job-id", "video-id", "worker-a", 30, 3)
                .await
                .unwrap(),
            JobOperationOutcome::NotOwner
        );
        assert_eq!(
            jobs.complete("job-id", "video-id", "worker-a")
                .await
                .unwrap(),
            JobOperationOutcome::NotOwner
        );
        assert_eq!(
            jobs.fail("job-id", "video-id", "worker-a", "ffmpeg exited", 3)
                .await
                .unwrap(),
            JobOperationOutcome::NotOwner
        );
    }
}
