//! Parse an SQS notification and atomically claim each eligible job.

use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use persistence::{JobState, PersistenceError};
use queue::Message;
use storage::{ObjectError, Read};
use tempfile::Builder;
use tracing::{info, warn};

use crate::event::parse_notification;
use crate::runtime::MessageProcessor;

pub const LOCAL_SOURCE_FILENAME: &str = "source.mp4";

#[derive(Debug)]
pub enum ProcessingError {
    Persistence(PersistenceError),
    Storage(ObjectError),
    Filesystem(io::Error),
}

impl fmt::Display for ProcessingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Persistence(error) => write!(formatter, "job state: {error}"),
            Self::Storage(error) => write!(formatter, "source download: {}", error.0),
            Self::Filesystem(error) => write!(formatter, "work directory: {error}"),
        }
    }
}

impl std::error::Error for ProcessingError {}

impl From<PersistenceError> for ProcessingError {
    fn from(error: PersistenceError) -> Self {
        Self::Persistence(error)
    }
}

impl From<ObjectError> for ProcessingError {
    fn from(error: ObjectError) -> Self {
        Self::Storage(error)
    }
}

impl From<io::Error> for ProcessingError {
    fn from(error: io::Error) -> Self {
        Self::Filesystem(error)
    }
}

/// Claims `UPLOADING` jobs from parsed S3 notifications. Downstream download
/// and encoding remain later tasks; this processor never deletes messages.
pub struct AtomicClaimProcessor<J> {
    jobs: Arc<Mutex<J>>,
    input_bucket: String,
}

impl<J> Clone for AtomicClaimProcessor<J> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
            input_bucket: self.input_bucket.clone(),
        }
    }
}

impl<J> AtomicClaimProcessor<J> {
    pub fn new(jobs: J, input_bucket: impl Into<String>) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(jobs)),
            input_bucket: input_bucket.into(),
        }
    }
}

impl<J: JobState + Send + 'static> MessageProcessor for AtomicClaimProcessor<J> {
    type Error = PersistenceError;

    async fn process(&self, message: Message) -> Result<(), Self::Error> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| PersistenceError("job state lock poisoned".into()))?;
        let owned = claim_notification(&mut *jobs, &message.body, &self.input_bucket)?;
        for item in owned {
            info!(job_id = %item.job_id, video_id = %item.video_id, "claimed job");
        }
        Ok(())
    }
}

/// Claims a notification, durably marks each owned job as processing, and
/// downloads its canonical source into an isolated temporary directory.
pub struct ProcessingDownloadProcessor<J, S> {
    jobs: Arc<Mutex<J>>,
    storage: Arc<Mutex<S>>,
    input_bucket: String,
    temporary_directory: PathBuf,
}

impl<J, S> Clone for ProcessingDownloadProcessor<J, S> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
            storage: self.storage.clone(),
            input_bucket: self.input_bucket.clone(),
            temporary_directory: self.temporary_directory.clone(),
        }
    }
}

impl<J, S> ProcessingDownloadProcessor<J, S> {
    pub fn new(
        jobs: J,
        storage: S,
        input_bucket: impl Into<String>,
        temporary_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(jobs)),
            storage: Arc::new(Mutex::new(storage)),
            input_bucket: input_bucket.into(),
            temporary_directory: temporary_directory.into(),
        }
    }
}

impl<J, S> MessageProcessor for ProcessingDownloadProcessor<J, S>
where
    J: JobState + Send + 'static,
    S: Read + Send + 'static,
{
    type Error = ProcessingError;

    async fn process(&self, message: Message) -> Result<(), Self::Error> {
        let owned = {
            let mut jobs = self.jobs.lock().map_err(|_| {
                ProcessingError::Persistence(PersistenceError("job state lock poisoned".into()))
            })?;
            claim_notification(&mut *jobs, &message.body, &self.input_bucket)?
        };

        for item in owned {
            {
                let mut jobs = self.jobs.lock().map_err(|_| {
                    ProcessingError::Persistence(PersistenceError("job state lock poisoned".into()))
                })?;
                jobs.mark_processing(&item.job_id)?;
            }

            let work_directory = JobDirectory::create(&self.temporary_directory, &item.job_id)?;
            let contents = {
                let mut storage = self.storage.lock().map_err(|_| {
                    ProcessingError::Storage(ObjectError("storage lock poisoned".into()))
                })?;
                storage.read(&item.bucket, &item.key)?
            };
            work_directory.write_source(&contents)?;
            info!(job_id = %item.job_id, bucket = %item.bucket, key = %item.key, "downloaded source");
        }
        Ok(())
    }
}

struct JobDirectory {
    directory: tempfile::TempDir,
}

impl JobDirectory {
    fn create(root: &Path, job_id: &str) -> io::Result<Self> {
        fs::create_dir_all(root)?;
        let safe_id: String = job_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        Ok(Self {
            directory: Builder::new()
                .prefix(&format!("job-{safe_id}-"))
                .tempdir_in(root)?,
        })
    }

    fn write_source(&self, contents: &[u8]) -> io::Result<()> {
        fs::write(self.directory.path().join(LOCAL_SOURCE_FILENAME), contents)
    }
}

/// Claim every eligible record. Invalid notifications and zero-row claims are
/// skipped so later work never starts without ownership.
pub fn claim_notification<J: JobState>(
    jobs: &mut J,
    body: &str,
    configured_input_bucket: &str,
) -> Result<Vec<crate::event::WorkItem>, PersistenceError> {
    let items = match parse_notification(body, configured_input_bucket) {
        Ok(items) => items,
        Err(error) => {
            warn!(%error, "notification is not an encoding request");
            return Ok(Vec::new());
        }
    };

    let mut owned = Vec::new();
    for item in items {
        if jobs.claim(&item.job_id, &item.video_id)? {
            owned.push(item);
        }
    }
    Ok(owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{WorkItem, records_notification, source_key};
    use crate::fakes::{Call, CallLog, FakeJobState, FakeStorage};
    use crate::runtime::MessageProcessor;

    const FIXTURE: &str = include_str!("../../../../../contracts/examples/s3/object-created.json");
    const INPUT_BUCKET: &str = "streaming-video-input";
    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const VIDEO_ID_2: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910b";
    const JOB_ID_2: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd68";
    const VIDEO_ID_3: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910c";
    const JOB_ID_3: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd69";
    const SOURCE_KEY: &str = "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4";

    fn expected_work_item() -> WorkItem {
        WorkItem {
            bucket: INPUT_BUCKET.to_owned(),
            key: SOURCE_KEY.to_owned(),
            video_id: VIDEO_ID.into(),
            job_id: JOB_ID.into(),
        }
    }

    fn uploading_jobs(log: CallLog) -> FakeJobState {
        let mut jobs = FakeJobState::new(log);
        jobs.add_claim(JOB_ID, VIDEO_ID, true);
        jobs
    }

    fn fixture_message() -> Message {
        Message {
            receipt_handle: "receipt".into(),
            body: FIXTURE.into(),
        }
    }

    #[test]
    fn canonical_fixture_claims_an_uploading_job_once() {
        let log = CallLog::default();
        let mut jobs = uploading_jobs(log.clone());

        assert_eq!(
            claim_notification(&mut jobs, FIXTURE, INPUT_BUCKET).unwrap(),
            [expected_work_item()]
        );
        assert_eq!(
            claim_notification(&mut jobs, FIXTURE, INPUT_BUCKET).unwrap(),
            []
        );
        assert_eq!(
            log.calls(),
            [
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
            ]
        );
    }

    #[test]
    fn missing_mismatched_and_non_uploading_jobs_are_zero_row_no_ops() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, false);

        assert!(
            claim_notification(&mut jobs, FIXTURE, INPUT_BUCKET)
                .unwrap()
                .is_empty()
        );
        assert!(
            claim_notification(&mut jobs, FIXTURE, "other-bucket")
                .unwrap()
                .is_empty()
        );
        assert!(
            claim_notification(
                &mut FakeJobState::new(CallLog::default()),
                FIXTURE,
                INPUT_BUCKET
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            log.calls(),
            [Call::Claim {
                job_id: JOB_ID.into(),
                video_id: VIDEO_ID.into(),
            }]
        );
    }

    #[test]
    fn zero_row_claims_do_not_download_process_upload_or_delete() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, false);
        let storage = FakeStorage::new(log.clone());

        assert!(
            claim_notification(&mut jobs, FIXTURE, INPUT_BUCKET)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            log.calls(),
            [Call::Claim {
                job_id: JOB_ID.into(),
                video_id: VIDEO_ID.into(),
            }]
        );
        assert!(storage.reads.is_empty());
        assert!(storage.writes.is_empty());
    }

    #[test]
    fn ignored_notifications_never_touch_job_state() {
        let log = CallLog::default();
        let mut jobs = uploading_jobs(log.clone());
        let test_event = r#"{"Service":"Amazon S3","Event":"s3:TestEvent"}"#;

        assert!(
            claim_notification(&mut jobs, test_event, INPUT_BUCKET)
                .unwrap()
                .is_empty()
        );
        assert!(
            claim_notification(&mut jobs, "not-json", INPUT_BUCKET)
                .unwrap()
                .is_empty()
        );
        assert!(log.calls().is_empty());
    }

    #[tokio::test]
    async fn duplicate_completed_notifications_are_no_ops_on_the_processor() {
        let log = CallLog::default();
        let processor = AtomicClaimProcessor::new(uploading_jobs(log.clone()), INPUT_BUCKET);

        processor.process(fixture_message()).await.unwrap();
        processor.process(fixture_message()).await.unwrap();

        assert_eq!(
            log.calls(),
            [
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn exactly_one_concurrent_claimant_owns_the_job() {
        let log = CallLog::default();
        let processor = AtomicClaimProcessor::new(uploading_jobs(log.clone()), INPUT_BUCKET);
        let message = fixture_message();

        let first_processor = processor.clone();
        let second_processor = processor.clone();
        let first_message = message.clone();
        let (first, second) = tokio::join!(
            first_processor.process(first_message),
            second_processor.process(message)
        );
        first.unwrap();
        second.unwrap();

        let claims: Vec<_> = log
            .calls()
            .into_iter()
            .filter(|call| matches!(call, Call::Claim { .. }))
            .collect();
        assert_eq!(claims.len(), 2);

        let remaining = {
            let jobs = processor.jobs.lock().expect("job state lock");
            jobs.claims.clone()
        };
        assert_eq!(remaining, [(JOB_ID.to_owned(), VIDEO_ID.to_owned(), false)]);
    }

    fn work_item(video_id: &str, job_id: &str) -> WorkItem {
        WorkItem {
            bucket: INPUT_BUCKET.to_owned(),
            key: source_key(video_id, job_id),
            video_id: video_id.into(),
            job_id: job_id.into(),
        }
    }

    fn two_record_body() -> String {
        let key_2 = source_key(VIDEO_ID_2, JOB_ID_2);
        records_notification(&[
            ("ObjectCreated:Put", INPUT_BUCKET, SOURCE_KEY),
            ("ObjectCreated:Put", INPUT_BUCKET, &key_2),
        ])
    }

    #[test]
    fn claims_every_uploading_job_in_a_multi_record_notification() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, true);
        jobs.add_claim(JOB_ID_2, VIDEO_ID_2, true);
        let body = two_record_body();

        assert_eq!(
            claim_notification(&mut jobs, &body, INPUT_BUCKET).unwrap(),
            [work_item(VIDEO_ID, JOB_ID), work_item(VIDEO_ID_2, JOB_ID_2)]
        );
        assert_eq!(
            claim_notification(&mut jobs, &body, INPUT_BUCKET).unwrap(),
            []
        );
        assert_eq!(
            log.calls(),
            [
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
                Call::Claim {
                    job_id: JOB_ID_2.into(),
                    video_id: VIDEO_ID_2.into(),
                },
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
                Call::Claim {
                    job_id: JOB_ID_2.into(),
                    video_id: VIDEO_ID_2.into(),
                },
            ]
        );
    }

    #[test]
    fn skips_invalid_and_already_claimed_records_and_owns_the_rest() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, false);
        jobs.add_claim(JOB_ID_2, VIDEO_ID_2, true);
        let key_2 = source_key(VIDEO_ID_2, JOB_ID_2);
        let body = records_notification(&[
            ("ObjectRemoved:Delete", INPUT_BUCKET, SOURCE_KEY),
            ("ObjectCreated:Put", INPUT_BUCKET, SOURCE_KEY),
            ("ObjectCreated:Put", "other-bucket", &key_2),
            ("ObjectCreated:Put", INPUT_BUCKET, &key_2),
        ]);

        assert_eq!(
            claim_notification(&mut jobs, &body, INPUT_BUCKET).unwrap(),
            [work_item(VIDEO_ID_2, JOB_ID_2)]
        );
        assert_eq!(
            log.calls(),
            [
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
                Call::Claim {
                    job_id: JOB_ID_2.into(),
                    video_id: VIDEO_ID_2.into(),
                },
            ]
        );
        assert_eq!(
            jobs.claims,
            [
                (JOB_ID.to_owned(), VIDEO_ID.to_owned(), false),
                (JOB_ID_2.to_owned(), VIDEO_ID_2.to_owned(), false),
            ]
        );
    }

    #[test]
    fn database_error_on_a_later_claim_stops_without_claiming_remaining_jobs() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, true);
        jobs.add_claim(JOB_ID_2, VIDEO_ID_2, true);
        jobs.add_claim(JOB_ID_3, VIDEO_ID_3, true);
        jobs.fail_claim_after(1, "connection reset");
        let key_2 = source_key(VIDEO_ID_2, JOB_ID_2);
        let key_3 = source_key(VIDEO_ID_3, JOB_ID_3);
        let body = records_notification(&[
            ("ObjectCreated:Put", INPUT_BUCKET, SOURCE_KEY),
            ("ObjectCreated:Put", INPUT_BUCKET, &key_2),
            ("ObjectCreated:Put", INPUT_BUCKET, &key_3),
        ]);

        assert_eq!(
            claim_notification(&mut jobs, &body, INPUT_BUCKET)
                .unwrap_err()
                .0,
            "connection reset"
        );
        assert_eq!(
            log.calls(),
            [
                Call::Claim {
                    job_id: JOB_ID.into(),
                    video_id: VIDEO_ID.into(),
                },
                Call::Claim {
                    job_id: JOB_ID_2.into(),
                    video_id: VIDEO_ID_2.into(),
                },
            ]
        );
        assert_eq!(
            jobs.claims,
            [
                (JOB_ID.to_owned(), VIDEO_ID.to_owned(), false),
                (JOB_ID_2.to_owned(), VIDEO_ID_2.to_owned(), true),
                (JOB_ID_3.to_owned(), VIDEO_ID_3.to_owned(), true),
            ]
        );
    }

    #[test]
    fn work_directory_source_is_exactly_source_mp4_with_downloaded_bytes() {
        let root = tempfile::tempdir().unwrap();
        let work = JobDirectory::create(root.path(), JOB_ID).unwrap();
        work.write_source(b"exact-source-bytes").unwrap();
        let path = work.directory.path().join(LOCAL_SOURCE_FILENAME);
        assert_eq!(path.file_name().unwrap(), "source.mp4");
        assert_eq!(fs::read(&path).unwrap(), b"exact-source-bytes");
        assert!(path.starts_with(work.directory.path()));
        assert!(path.starts_with(root.path()));
    }

    #[tokio::test]
    async fn processing_download_claims_then_marks_processing_then_reads_canonical_object() {
        let log = CallLog::default();
        let root = tempfile::tempdir().unwrap();
        let mut storage = FakeStorage::new(log.clone());
        storage.add_read(INPUT_BUCKET, SOURCE_KEY, b"exact-source-bytes".to_vec());
        let processor = ProcessingDownloadProcessor::new(
            uploading_jobs(log.clone()),
            storage,
            INPUT_BUCKET,
            root.path(),
        );

        processor.process(fixture_message()).await.unwrap();
        let calls = log.calls();
        let claim = calls
            .iter()
            .position(|call| matches!(call, Call::Claim { job_id, .. } if job_id == JOB_ID))
            .unwrap();
        let processing = calls
            .iter()
            .position(|call| matches!(call, Call::MarkProcessing(id) if id == JOB_ID))
            .unwrap();
        let download = calls
            .iter()
            .position(
                |call| matches!(call, Call::Read { bucket, key } if bucket == INPUT_BUCKET && key == SOURCE_KEY),
            )
            .unwrap();
        assert!(claim < processing && processing < download, "{calls:?}");
    }
}
