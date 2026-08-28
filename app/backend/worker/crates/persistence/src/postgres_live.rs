//! Live PostgreSQL coverage for conditional job updates.
//!
//! Skips when the database is unreachable unless `TEST_DATABASE_URL` is set.

use std::{
    env,
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use postgres::{Client, NoTls, Row};

use super::{JobState, PostgresJobState};
use crate::PersistenceError;

const SCHEMA_SQL: &str =
    include_str!("../../../../api/internal/persistence/migrations/0001_phase1_schema.up.sql");
const DEFAULT_URL: &str = "postgres://streaming_video:streaming_video_dev_password@localhost:5432/streaming_video?sslmode=disable";
const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
const VIDEO_ID_2: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910b";
const JOB_ID_2: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd68";

static SCHEMA_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Live {
    url: String,
    schema: String,
    admin: Client,
}

impl Drop for Live {
    fn drop(&mut self) {
        let _ = self.admin.execute("SET search_path TO public", &[]);
        let _ = self.admin.execute(
            &format!("DROP SCHEMA IF EXISTS {} CASCADE", self.schema),
            &[],
        );
    }
}

impl Live {
    fn job_state(&self) -> PostgresJobState<Client> {
        PostgresJobState::new(connect_on_schema(&self.url, &self.schema))
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

fn connect_on_schema(url: &str, schema: &str) -> Client {
    let mut client = Client::connect(url, NoTls).expect("postgres reconnect");
    client
        .execute(&format!("SET search_path TO {schema}"), &[])
        .expect("set search_path");
    client
}

fn setup() -> Option<Live> {
    let (url, required) = live_postgres_url();
    let mut admin = match Client::connect(&url, NoTls) {
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
        .expect("create schema");
    admin
        .execute(&format!("SET search_path TO {schema}"), &[])
        .expect("set search_path");
    for statement in SCHEMA_SQL.split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            admin.execute(statement, &[]).unwrap_or_else(|error| {
                panic!("apply schema statement {statement:?}: {error}");
            });
        }
    }

    Some(Live { url, schema, admin })
}

fn insert_job(admin: &mut Client, video_id: &str, job_id: &str, status: &str) {
    let key = format!("videos/{video_id}/jobs/{job_id}/source.mp4");
    admin
        .execute(
            "INSERT INTO videos (video_id, file_name, content_type, size_bytes, upload_bucket, upload_key, upload_expires_at)
             VALUES ($1::text::uuid, 'source.mp4', 'video/mp4', 1, 'input', $2, NOW())",
            &[&video_id, &key],
        )
        .expect("insert video");
    admin
        .execute(
            "INSERT INTO jobs (id, video_id, status) VALUES ($1::text::uuid, $2::text::uuid, $3)",
            &[&job_id, &video_id, &status],
        )
        .expect("insert job");
}

fn job_row(admin: &mut Client, job_id: &str) -> Row {
    admin
        .query_one(
            "SELECT status, failure_code, failure_message FROM jobs WHERE id = $1::text::uuid",
            &[&job_id],
        )
        .expect("load job")
}

fn job_status(admin: &mut Client, job_id: &str) -> String {
    job_row(admin, job_id).get(0)
}

#[test]
fn claim_transitions_uploading_to_queued_once() {
    let Some(mut live) = setup() else {
        return;
    };
    insert_job(&mut live.admin, VIDEO_ID, JOB_ID, "UPLOADING");
    let mut jobs = live.job_state();

    assert!(jobs.claim(JOB_ID, VIDEO_ID).unwrap());
    assert!(!jobs.claim(JOB_ID, VIDEO_ID).unwrap());
    assert!(!jobs.claim(JOB_ID, VIDEO_ID_2).unwrap());
    assert_eq!(job_status(&mut live.admin, JOB_ID), "QUEUED");
}

#[test]
fn two_connections_only_one_claim_succeeds() {
    let Some(mut live) = setup() else {
        return;
    };
    insert_job(&mut live.admin, VIDEO_ID, JOB_ID, "UPLOADING");

    let mut first = live.job_state();
    let mut second = live.job_state();
    let barrier = Arc::new(Barrier::new(2));
    let job_id = JOB_ID.to_owned();
    let video_id = VIDEO_ID.to_owned();
    let spawned_barrier = barrier.clone();
    let first_claim = thread::spawn(move || {
        spawned_barrier.wait();
        first.claim(&job_id, &video_id)
    });

    barrier.wait();
    let second_result = second.claim(JOB_ID, VIDEO_ID);
    let first_result = first_claim.join().expect("claim thread");

    let owned = [first_result.unwrap(), second_result.unwrap()]
        .into_iter()
        .filter(|claimed| *claimed)
        .count();
    assert_eq!(owned, 1);
    assert_eq!(job_status(&mut live.admin, JOB_ID), "QUEUED");
}

#[test]
fn queued_to_processing_to_completed() {
    let Some(mut live) = setup() else {
        return;
    };
    insert_job(&mut live.admin, VIDEO_ID, JOB_ID, "UPLOADING");
    let mut jobs = live.job_state();

    assert!(jobs.mark_processing(JOB_ID).is_err());
    assert_eq!(job_status(&mut live.admin, JOB_ID), "UPLOADING");

    assert!(jobs.claim(JOB_ID, VIDEO_ID).unwrap());
    jobs.mark_processing(JOB_ID).unwrap();
    assert_eq!(job_status(&mut live.admin, JOB_ID), "PROCESSING");

    jobs.mark_completed(JOB_ID).unwrap();
    let completed = job_row(&mut live.admin, JOB_ID);
    assert_eq!(completed.get::<_, String>(0), "COMPLETED");
    assert!(completed.get::<_, Option<String>>(1).is_none());
    assert!(completed.get::<_, Option<String>>(2).is_none());
}

#[test]
fn queued_or_processing_can_fail() {
    let Some(mut live) = setup() else {
        return;
    };
    insert_job(&mut live.admin, VIDEO_ID, JOB_ID, "UPLOADING");
    insert_job(&mut live.admin, VIDEO_ID_2, JOB_ID_2, "UPLOADING");
    let mut jobs = live.job_state();

    assert!(jobs.mark_failed(JOB_ID, "too early").is_err());
    assert_eq!(job_status(&mut live.admin, JOB_ID), "UPLOADING");

    assert!(jobs.claim(JOB_ID, VIDEO_ID).unwrap());
    jobs.mark_failed(JOB_ID, "queued failed").unwrap();
    let queued_failed = job_row(&mut live.admin, JOB_ID);
    assert_eq!(queued_failed.get::<_, String>(0), "FAILED");
    assert_eq!(queued_failed.get::<_, String>(1), "ENCODING_FAILED");
    assert_eq!(queued_failed.get::<_, String>(2), "queued failed");

    assert!(jobs.claim(JOB_ID_2, VIDEO_ID_2).unwrap());
    jobs.mark_processing(JOB_ID_2).unwrap();
    jobs.mark_failed(JOB_ID_2, "processing failed").unwrap();
    let processing_failed = job_row(&mut live.admin, JOB_ID_2);
    assert_eq!(processing_failed.get::<_, String>(0), "FAILED");
    assert_eq!(processing_failed.get::<_, String>(1), "ENCODING_FAILED");
    assert_eq!(processing_failed.get::<_, String>(2), "processing failed");
}

#[test]
fn completed_job_is_not_overwritten() {
    let Some(mut live) = setup() else {
        return;
    };
    insert_job(&mut live.admin, VIDEO_ID, JOB_ID, "UPLOADING");
    let mut jobs = live.job_state();
    assert!(jobs.claim(JOB_ID, VIDEO_ID).unwrap());
    jobs.mark_processing(JOB_ID).unwrap();
    jobs.mark_completed(JOB_ID).unwrap();

    assert!(matches!(
        jobs.mark_processing(JOB_ID),
        Err(PersistenceError(message)) if message.contains("job not found")
    ));
    assert!(matches!(
        jobs.mark_completed(JOB_ID),
        Err(PersistenceError(message)) if message.contains("job not found")
    ));
    assert!(matches!(
        jobs.mark_failed(JOB_ID, "late failure"),
        Err(PersistenceError(message)) if message.contains("job not found")
    ));
    assert!(!jobs.claim(JOB_ID, VIDEO_ID).unwrap());

    let completed = job_row(&mut live.admin, JOB_ID);
    assert_eq!(completed.get::<_, String>(0), "COMPLETED");
    assert!(completed.get::<_, Option<String>>(1).is_none());
    assert!(completed.get::<_, Option<String>>(2).is_none());
}
