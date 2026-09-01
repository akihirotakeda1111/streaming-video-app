//! Live PostgreSQL coverage for conditional job updates.
//!
//! Skips when the database is unreachable unless `TEST_DATABASE_URL` is set.

use std::{
    env,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use tokio_postgres::{Client, NoTls, Row, types::ToSql};

use super::{JobState, PostgresJobState};
use crate::{JobOperationOutcome, PersistenceError};

const SCHEMA_SQL: &str =
    include_str!("../../../../api/internal/persistence/migrations/0001_phase1_schema.up.sql");
const LEASE_SCHEMA_SQL: &str = include_str!(
    "../../../../api/internal/persistence/migrations/0002_job_lease_persistence.up.sql"
);
const DEFAULT_URL: &str = "postgres://streaming_video:streaming_video_dev_password@localhost:5432/streaming_video?sslmode=disable";
const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
const VIDEO_ID_2: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910b";
const JOB_ID_2: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd68";
const WORKER_A: &str = "worker-a";
const WORKER_B: &str = "worker-b";
const LEASE_SECONDS: u64 = 30;
const MAX_ATTEMPTS: u32 = 3;

static SCHEMA_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Live {
    url: String,
    schema: String,
    admin: Client,
}

impl Live {
    async fn job_state(&self) -> PostgresJobState<Client> {
        PostgresJobState::new(connect_on_schema(&self.url, &self.schema).await)
    }

    async fn cleanup(self) {
        let _ = self.admin.execute("SET search_path TO public", &[]).await;
        let _ = self
            .admin
            .execute(
                &format!("DROP SCHEMA IF EXISTS {} CASCADE", self.schema),
                &[],
            )
            .await;
    }
}

fn live_postgres_url() -> (String, bool) {
    match env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => return (url, true),
        _ => {}
    }
    match env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => (url, false),
        _ => (DEFAULT_URL.to_owned(), false),
    }
}

async fn connect(url: &str) -> Result<Client, tokio_postgres::Error> {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("test postgres connection stopped: {error}");
        }
    });
    Ok(client)
}

async fn connect_on_schema(url: &str, schema: &str) -> Client {
    let client = connect(url).await.expect("postgres reconnect");
    client
        .execute(&format!("SET search_path TO {schema}"), &[])
        .await
        .expect("set search_path");
    client
}

async fn setup() -> Option<Live> {
    let (url, required) = live_postgres_url();
    let admin = match connect(&url).await {
        Ok(client) => client,
        Err(error) if required => panic!("postgres is not available: {error}"),
        Err(error) => {
            eprintln!("skipping live postgres test: {error}");
            return None;
        }
    };

    let schema = format!(
        "worker_job_{}_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos(),
        SCHEMA_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    debug_assert!(
        schema
            .chars()
            .all(|character| character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '_')
    );

    admin
        .execute(&format!("CREATE SCHEMA {schema}"), &[])
        .await
        .expect("create schema");
    admin
        .execute(&format!("SET search_path TO {schema}"), &[])
        .await
        .expect("set search_path");
    for statement in SCHEMA_SQL.split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            admin.execute(statement, &[]).await.unwrap_or_else(|error| {
                panic!("apply schema statement {statement:?}: {error}");
            });
        }
    }
    for statement in LEASE_SCHEMA_SQL.split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            admin.execute(statement, &[]).await.unwrap_or_else(|error| {
                panic!("apply lease schema statement {statement:?}: {error}");
            });
        }
    }

    Some(Live { url, schema, admin })
}

async fn insert_job(admin: &Client, video_id: &str, job_id: &str, status: &str) {
    let key = format!("videos/{video_id}/jobs/{job_id}/source.mp4");
    let video_parameters: &[&(dyn ToSql + Sync)] = &[&video_id, &key];
    admin
        .execute(
            "INSERT INTO videos (video_id, file_name, content_type, size_bytes, upload_bucket, upload_key, upload_expires_at)
             VALUES ($1::text::uuid, 'source.mp4', 'video/mp4', 1, 'input', $2, NOW())",
            video_parameters,
        )
        .await
        .expect("insert video");
    let job_parameters: &[&(dyn ToSql + Sync)] = &[&job_id, &video_id, &status];
    admin
        .execute(
            "INSERT INTO jobs (id, video_id, status) VALUES ($1::text::uuid, $2::text::uuid, $3)",
            job_parameters,
        )
        .await
        .expect("insert job");
}

async fn job_row(admin: &Client, job_id: &str) -> Row {
    admin
        .query_one(
            "SELECT status, failure_code, failure_message FROM jobs WHERE id = $1::text::uuid",
            &[&job_id],
        )
        .await
        .expect("load job")
}

async fn job_status(admin: &Client, job_id: &str) -> String {
    job_row(admin, job_id).await.get(0)
}

async fn lease_row(admin: &Client, job_id: &str) -> Row {
    admin
        .query_one(
            "SELECT status, worker_id, lease_expires_at, attempt, failure_code, failure_message FROM jobs WHERE id = $1::text::uuid",
            &[&job_id],
        )
        .await
        .expect("load lease row")
}

async fn expire_lease(admin: &Client, job_id: &str) {
    admin
        .execute(
            "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1::text::uuid",
            &[&job_id],
        )
        .await
        .expect("expire lease");
}

#[tokio::test]
async fn production_connector_is_safe_inside_the_worker_runtime() {
    let (url, required) = live_postgres_url();
    match PostgresJobState::connect(&url).await {
        Ok(_) => {}
        Err(error) if required => panic!("postgres is not available: {error}"),
        Err(error) => eprintln!("skipping live postgres test: {error}"),
    }
}

#[tokio::test]
async fn claim_transitions_uploading_to_queued_once() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    let mut jobs = live.job_state().await;

    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    assert!(!jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    assert!(!jobs.claim(JOB_ID, VIDEO_ID_2).await.unwrap());
    assert_eq!(job_status(&live.admin, JOB_ID).await, "QUEUED");
    live.cleanup().await;
}

#[tokio::test]
async fn two_connections_only_one_claim_succeeds() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;

    let mut first = live.job_state().await;
    let mut second = live.job_state().await;
    let (first_result, second_result) = tokio::join!(
        first.claim(JOB_ID, VIDEO_ID),
        second.claim(JOB_ID, VIDEO_ID)
    );

    let owned = [first_result.unwrap(), second_result.unwrap()]
        .into_iter()
        .filter(|claimed| *claimed)
        .count();
    assert_eq!(owned, 1);
    assert_eq!(job_status(&live.admin, JOB_ID).await, "QUEUED");
    live.cleanup().await;
}

#[tokio::test]
async fn queued_to_processing_to_completed() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    let mut jobs = live.job_state().await;

    assert!(jobs.mark_processing(JOB_ID).await.is_err());
    assert_eq!(job_status(&live.admin, JOB_ID).await, "UPLOADING");

    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    jobs.mark_processing(JOB_ID).await.unwrap();
    assert_eq!(job_status(&live.admin, JOB_ID).await, "PROCESSING");

    jobs.mark_completed(JOB_ID).await.unwrap();
    let completed = job_row(&live.admin, JOB_ID).await;
    assert_eq!(completed.get::<_, String>(0), "COMPLETED");
    assert!(completed.get::<_, Option<String>>(1).is_none());
    assert!(completed.get::<_, Option<String>>(2).is_none());
    live.cleanup().await;
}

#[tokio::test]
async fn queued_or_processing_can_fail() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    insert_job(&live.admin, VIDEO_ID_2, JOB_ID_2, "UPLOADING").await;
    let mut jobs = live.job_state().await;

    assert!(jobs.mark_failed(JOB_ID, "too early").await.is_err());
    assert_eq!(job_status(&live.admin, JOB_ID).await, "UPLOADING");

    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    jobs.mark_failed(JOB_ID, "queued failed").await.unwrap();
    let queued_failed = job_row(&live.admin, JOB_ID).await;
    assert_eq!(queued_failed.get::<_, String>(0), "FAILED");
    assert_eq!(queued_failed.get::<_, String>(1), "ENCODING_FAILED");
    assert_eq!(queued_failed.get::<_, String>(2), "queued failed");

    assert!(jobs.claim(JOB_ID_2, VIDEO_ID_2).await.unwrap());
    jobs.mark_processing(JOB_ID_2).await.unwrap();
    jobs.mark_failed(JOB_ID_2, "processing failed")
        .await
        .unwrap();
    let processing_failed = job_row(&live.admin, JOB_ID_2).await;
    assert_eq!(processing_failed.get::<_, String>(0), "FAILED");
    assert_eq!(processing_failed.get::<_, String>(1), "ENCODING_FAILED");
    assert_eq!(processing_failed.get::<_, String>(2), "processing failed");
    live.cleanup().await;
}

#[tokio::test]
async fn completed_job_is_not_overwritten() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    let mut jobs = live.job_state().await;
    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    jobs.mark_processing(JOB_ID).await.unwrap();
    jobs.mark_completed(JOB_ID).await.unwrap();

    assert!(matches!(
        jobs.mark_processing(JOB_ID).await,
        Err(PersistenceError(message)) if message.contains("job not found")
    ));
    assert!(matches!(
        jobs.mark_completed(JOB_ID).await,
        Err(PersistenceError(message)) if message.contains("job not found")
    ));
    assert!(matches!(
        jobs.mark_failed(JOB_ID, "late failure").await,
        Err(PersistenceError(message)) if message.contains("job not found")
    ));
    assert!(!jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());

    let completed = job_row(&live.admin, JOB_ID).await;
    assert_eq!(completed.get::<_, String>(0), "COMPLETED");
    assert!(completed.get::<_, Option<String>>(1).is_none());
    assert!(completed.get::<_, Option<String>>(2).is_none());
    live.cleanup().await;
}

#[tokio::test]
async fn two_connections_only_one_lease_succeeds() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    let mut claimer = live.job_state().await;
    assert!(claimer.claim(JOB_ID, VIDEO_ID).await.unwrap());

    let mut first = live.job_state().await;
    let mut second = live.job_state().await;
    let (first_result, second_result) = tokio::join!(
        first.acquire_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS),
        second.acquire_lease(JOB_ID, VIDEO_ID, WORKER_B, LEASE_SECONDS, MAX_ATTEMPTS)
    );

    let owned = [first_result.unwrap(), second_result.unwrap()]
        .into_iter()
        .filter(|outcome| *outcome == JobOperationOutcome::Applied)
        .count();
    assert_eq!(owned, 1);
    let row = lease_row(&live.admin, JOB_ID).await;
    assert_eq!(row.get::<_, String>(0), "PROCESSING");
    assert_eq!(row.get::<_, i32>(3), 1);
    live.cleanup().await;
}

#[tokio::test]
async fn unowned_processing_and_expired_leases_can_be_acquired() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    insert_job(&live.admin, VIDEO_ID_2, JOB_ID_2, "UPLOADING").await;
    let mut jobs = live.job_state().await;

    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    jobs.mark_processing(JOB_ID).await.unwrap();
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_B, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );

    expire_lease(&live.admin, JOB_ID).await;
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_B, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    let recovered = lease_row(&live.admin, JOB_ID).await;
    assert_eq!(recovered.get::<_, String>(0), "PROCESSING");
    assert_eq!(
        recovered.get::<_, Option<String>>(1).as_deref(),
        Some(WORKER_B)
    );
    assert_eq!(recovered.get::<_, i32>(3), 2);

    assert!(jobs.claim(JOB_ID_2, VIDEO_ID_2).await.unwrap());
    assert_eq!(
        jobs.acquire_lease(JOB_ID_2, VIDEO_ID_2, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    live.cleanup().await;
}

#[tokio::test]
async fn mismatched_active_terminal_and_unknown_jobs_are_not_acquired() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    let mut jobs = live.job_state().await;
    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID_2, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    assert_eq!(
        jobs.complete(JOB_ID, VIDEO_ID, WORKER_A).await.unwrap(),
        JobOperationOutcome::Applied
    );
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_B, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.acquire_lease(JOB_ID_2, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    live.cleanup().await;
}

#[tokio::test]
async fn owner_updates_require_unexpired_matching_lease() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    let mut jobs = live.job_state().await;
    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );

    assert_eq!(
        jobs.renew_lease(JOB_ID, VIDEO_ID, WORKER_B, LEASE_SECONDS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.release_for_retry(JOB_ID, VIDEO_ID, WORKER_B, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.complete(JOB_ID, VIDEO_ID_2, WORKER_A).await.unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.fail(JOB_ID, VIDEO_ID, WORKER_B, "stale", MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );

    expire_lease(&live.admin, JOB_ID).await;
    assert_eq!(
        jobs.renew_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.complete(JOB_ID, VIDEO_ID, WORKER_A).await.unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.fail(JOB_ID, VIDEO_ID, WORKER_A, "expired", MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        lease_row(&live.admin, JOB_ID).await.get::<_, String>(0),
        "PROCESSING"
    );
    live.cleanup().await;
}

#[tokio::test]
async fn retry_release_and_terminal_outcomes_clear_lease_fields() {
    let Some(live) = setup().await else {
        return;
    };
    insert_job(&live.admin, VIDEO_ID, JOB_ID, "UPLOADING").await;
    insert_job(&live.admin, VIDEO_ID_2, JOB_ID_2, "UPLOADING").await;
    let mut jobs = live.job_state().await;

    assert!(jobs.claim(JOB_ID, VIDEO_ID).await.unwrap());
    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    assert_eq!(
        jobs.fail(JOB_ID, VIDEO_ID, WORKER_A, "too early", MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.release_for_retry(JOB_ID, VIDEO_ID, WORKER_A, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    let retried = lease_row(&live.admin, JOB_ID).await;
    assert_eq!(retried.get::<_, String>(0), "QUEUED");
    assert!(retried.get::<_, Option<String>>(1).is_none());
    assert!(retried.get::<_, Option<SystemTime>>(2).is_none());
    assert_eq!(retried.get::<_, i32>(3), 1);
    assert!(retried.get::<_, Option<String>>(4).is_none());
    assert!(retried.get::<_, Option<String>>(5).is_none());

    assert_eq!(
        jobs.acquire_lease(JOB_ID, VIDEO_ID, WORKER_A, LEASE_SECONDS, MAX_ATTEMPTS)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    assert_eq!(
        jobs.complete(JOB_ID, VIDEO_ID, WORKER_A).await.unwrap(),
        JobOperationOutcome::Applied
    );
    let completed = lease_row(&live.admin, JOB_ID).await;
    assert_eq!(completed.get::<_, String>(0), "COMPLETED");
    assert!(completed.get::<_, Option<String>>(1).is_none());
    assert!(completed.get::<_, Option<SystemTime>>(2).is_none());

    assert!(jobs.claim(JOB_ID_2, VIDEO_ID_2).await.unwrap());
    assert_eq!(
        jobs.acquire_lease(JOB_ID_2, VIDEO_ID_2, WORKER_A, LEASE_SECONDS, 1)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    assert_eq!(
        jobs.release_for_retry(JOB_ID_2, VIDEO_ID_2, WORKER_A, 1)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.fail(JOB_ID_2, VIDEO_ID_2, WORKER_A, "", 1)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    assert_eq!(
        jobs.fail(JOB_ID_2, VIDEO_ID_2, WORKER_A, "exhausted", 1)
            .await
            .unwrap(),
        JobOperationOutcome::Applied
    );
    let failed = lease_row(&live.admin, JOB_ID_2).await;
    assert_eq!(failed.get::<_, String>(0), "FAILED");
    assert!(failed.get::<_, Option<String>>(1).is_none());
    assert!(failed.get::<_, Option<SystemTime>>(2).is_none());
    assert_eq!(failed.get::<_, String>(4), "ENCODING_FAILED");
    assert_eq!(failed.get::<_, String>(5), "exhausted");
    assert_eq!(
        jobs.acquire_lease(JOB_ID_2, VIDEO_ID_2, WORKER_B, LEASE_SECONDS, 1)
            .await
            .unwrap(),
        JobOperationOutcome::NotOwner
    );
    live.cleanup().await;
}
