//! Convert S3 notification records into lease-backed ownership decisions.

use std::{fmt, sync::Arc, time::SystemTime};

use persistence::{JobState, LeaseAcquisitionOutcome, PersistenceError};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::event::{ParsedRecord, WorkItem, parse_notification_records};

/// An opaque identity created once and shared for the lifetime of a worker.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkerIdentity(String);

impl WorkerIdentity {
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn from_value(value: impl Into<String>) -> Result<Self, WorkerIdentityError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(WorkerIdentityError);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkerIdentityError;

impl fmt::Display for WorkerIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("worker identity must not be empty")
    }
}

impl std::error::Error for WorkerIdentityError {}

/// Ownership data required by heartbeat and processing tasks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcquiredJob {
    pub item: WorkItem,
    pub worker_id: WorkerIdentity,
    pub attempt: u32,
    pub lease_expires_at: SystemTime,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoWorkReason {
    Busy,
    Completed,
    Failed,
    UnknownOrMismatched,
    AttemptExhausted,
    PersistenceError(PersistenceError),
}

/// The decision for one delivered S3 record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordAcquisitionDisposition {
    Acquired(AcquiredJob),
    NotAcquired {
        item: WorkItem,
        reason: NoWorkReason,
    },
    InvalidEvent,
}

/// Performs only initial claim and atomic lease acquisition.
pub struct LeaseAcquisitionProcessor<J> {
    jobs: Arc<Mutex<J>>,
    worker_id: WorkerIdentity,
    input_bucket: String,
    lease_seconds: u64,
    max_attempts: u32,
}

impl<J> Clone for LeaseAcquisitionProcessor<J> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
            worker_id: self.worker_id.clone(),
            input_bucket: self.input_bucket.clone(),
            lease_seconds: self.lease_seconds,
            max_attempts: self.max_attempts,
        }
    }
}

impl<J> LeaseAcquisitionProcessor<J> {
    pub fn new(
        jobs: J,
        worker_id: WorkerIdentity,
        input_bucket: impl Into<String>,
        lease_seconds: u64,
        max_attempts: u32,
    ) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(jobs)),
            worker_id,
            input_bucket: input_bucket.into(),
            lease_seconds,
            max_attempts,
        }
    }
}

impl<J: JobState> LeaseAcquisitionProcessor<J> {
    pub async fn acquire_notification(&self, body: &str) -> Vec<RecordAcquisitionDisposition> {
        let records = match parse_notification_records(body, &self.input_bucket) {
            Ok(records) if !records.is_empty() => records,
            Ok(_) | Err(_) => return vec![RecordAcquisitionDisposition::InvalidEvent],
        };

        let mut dispositions = Vec::with_capacity(records.len());
        for record in records {
            let ParsedRecord::Work(item) = record else {
                dispositions.push(RecordAcquisitionDisposition::InvalidEvent);
                continue;
            };

            let outcome = {
                let mut jobs = self.jobs.lock().await;
                if let Err(error) = jobs.claim_upload(&item.job_id, &item.video_id).await {
                    dispositions.push(not_acquired(item, NoWorkReason::PersistenceError(error)));
                    continue;
                }
                jobs.acquire_lease(
                    &item.job_id,
                    &item.video_id,
                    self.worker_id.as_str(),
                    self.lease_seconds,
                    self.max_attempts,
                )
                .await
            };

            dispositions.push(match outcome {
                Ok(LeaseAcquisitionOutcome::Acquired {
                    attempt,
                    lease_expires_at,
                }) => RecordAcquisitionDisposition::Acquired(AcquiredJob {
                    item,
                    worker_id: self.worker_id.clone(),
                    attempt,
                    lease_expires_at,
                }),
                Ok(LeaseAcquisitionOutcome::Busy) => not_acquired(item, NoWorkReason::Busy),
                Ok(LeaseAcquisitionOutcome::Completed) => {
                    not_acquired(item, NoWorkReason::Completed)
                }
                Ok(LeaseAcquisitionOutcome::Failed) => not_acquired(item, NoWorkReason::Failed),
                Ok(LeaseAcquisitionOutcome::UnknownOrMismatched) => {
                    not_acquired(item, NoWorkReason::UnknownOrMismatched)
                }
                Ok(LeaseAcquisitionOutcome::AttemptExhausted) => {
                    not_acquired(item, NoWorkReason::AttemptExhausted)
                }
                Err(error) => not_acquired(item, NoWorkReason::PersistenceError(error)),
            });
        }
        dispositions
    }
}

fn not_acquired(item: WorkItem, reason: NoWorkReason) -> RecordAcquisitionDisposition {
    RecordAcquisitionDisposition::NotAcquired { item, reason }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        event::{records_notification, source_key},
        fakes::{Call, CallLog, FakeJobState},
    };
    use std::{
        future::Future,
        sync::atomic::{AtomicBool, Ordering},
    };

    const FIXTURE: &str = include_str!("../../../../../contracts/examples/s3/object-created.json");
    const INPUT_BUCKET: &str = "streaming-video-input";
    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const LEASE_SECONDS: u64 = 30;
    const MAX_ATTEMPTS: u32 = 3;

    fn identity(value: &str) -> WorkerIdentity {
        WorkerIdentity::from_value(value).unwrap()
    }

    fn processor(jobs: FakeJobState, worker: &str) -> LeaseAcquisitionProcessor<FakeJobState> {
        LeaseAcquisitionProcessor::new(
            jobs,
            identity(worker),
            INPUT_BUCKET,
            LEASE_SECONDS,
            MAX_ATTEMPTS,
        )
    }

    fn expected_item(video_id: &str, job_id: &str) -> WorkItem {
        WorkItem {
            bucket: INPUT_BUCKET.into(),
            key: source_key(video_id, job_id),
            video_id: video_id.into(),
            job_id: job_id.into(),
        }
    }

    #[tokio::test]
    async fn newly_claimed_record_is_acquired_with_persisted_ownership_data_only() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, true);
        jobs.add_lease_acquisition(LeaseAcquisitionOutcome::Acquired {
            attempt: 1,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        });

        assert_eq!(
            processor(jobs, "worker-a")
                .acquire_notification(FIXTURE)
                .await,
            [RecordAcquisitionDisposition::Acquired(AcquiredJob {
                item: expected_item(VIDEO_ID, JOB_ID),
                worker_id: identity("worker-a"),
                attempt: 1,
                lease_expires_at: SystemTime::UNIX_EPOCH,
            })]
        );
        assert!(matches!(
            log.calls().as_slice(),
            [Call::Claim { .. }, Call::AcquireLease { .. }]
        ));
    }

    #[tokio::test]
    async fn zero_row_claim_still_acquires_recoverable_work_and_returns_later_attempt() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, false);
        jobs.add_lease_acquisition(LeaseAcquisitionOutcome::Acquired {
            attempt: 2,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        });

        let dispositions = processor(jobs, "worker-b")
            .acquire_notification(FIXTURE)
            .await;
        assert!(matches!(
            dispositions.as_slice(),
            [RecordAcquisitionDisposition::Acquired(AcquiredJob {
                attempt: 2,
                worker_id,
                ..
            })] if worker_id.as_str() == "worker-b"
        ));
        assert!(matches!(
            log.calls().as_slice(),
            [Call::Claim { .. }, Call::AcquireLease { .. }]
        ));
    }

    #[tokio::test]
    async fn all_safe_no_work_reasons_remain_distinct() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        let outcomes = [
            LeaseAcquisitionOutcome::Busy,
            LeaseAcquisitionOutcome::Completed,
            LeaseAcquisitionOutcome::Failed,
            LeaseAcquisitionOutcome::UnknownOrMismatched,
            LeaseAcquisitionOutcome::AttemptExhausted,
        ];
        for _ in &outcomes {
            jobs.add_claim(JOB_ID, VIDEO_ID, false);
        }
        for outcome in outcomes {
            jobs.add_lease_acquisition(outcome);
        }
        let acquisition = processor(jobs, "worker-a");

        let expected = [
            NoWorkReason::Busy,
            NoWorkReason::Completed,
            NoWorkReason::Failed,
            NoWorkReason::UnknownOrMismatched,
            NoWorkReason::AttemptExhausted,
        ];
        for reason in expected {
            assert!(matches!(
                acquisition.acquire_notification(FIXTURE).await.as_slice(),
                [RecordAcquisitionDisposition::NotAcquired {
                    reason: actual,
                    ..
                }] if *actual == reason
            ));
        }
        assert!(
            log.calls()
                .iter()
                .all(|call| matches!(call, Call::Claim { .. } | Call::AcquireLease { .. }))
        );
    }

    #[tokio::test]
    async fn claim_and_acquisition_errors_are_typed_and_never_start_side_effects() {
        let log = CallLog::default();
        let mut claim_failure = FakeJobState::new(log.clone());
        claim_failure.fail_claim("claim unavailable");
        assert!(matches!(
            processor(claim_failure, "worker-a")
                .acquire_notification(FIXTURE)
                .await
                .as_slice(),
            [RecordAcquisitionDisposition::NotAcquired {
                reason: NoWorkReason::PersistenceError(PersistenceError(message)),
                ..
            }] if message == "claim unavailable"
        ));

        let mut acquisition_failure = FakeJobState::new(log.clone());
        acquisition_failure.add_claim(JOB_ID, VIDEO_ID, false);
        acquisition_failure.fail_lease_acquisition("acquisition unavailable");
        assert!(matches!(
            processor(acquisition_failure, "worker-a")
                .acquire_notification(FIXTURE)
                .await
                .as_slice(),
            [RecordAcquisitionDisposition::NotAcquired {
                reason: NoWorkReason::PersistenceError(PersistenceError(message)),
                ..
            }] if message == "acquisition unavailable"
        ));
        assert!(
            log.calls()
                .iter()
                .all(|call| matches!(call, Call::Claim { .. } | Call::AcquireLease { .. }))
        );
    }

    #[tokio::test]
    async fn invalid_records_are_preserved_beside_valid_records() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB_ID, VIDEO_ID, false);
        jobs.add_lease_acquisition(LeaseAcquisitionOutcome::Completed);
        let body = records_notification(&[
            (
                "ObjectRemoved:Delete",
                INPUT_BUCKET,
                &source_key(VIDEO_ID, JOB_ID),
            ),
            (
                "ObjectCreated:Put",
                INPUT_BUCKET,
                &source_key(VIDEO_ID, JOB_ID),
            ),
        ]);

        let dispositions = processor(jobs, "worker-a")
            .acquire_notification(&body)
            .await;
        assert!(matches!(
            dispositions.as_slice(),
            [
                RecordAcquisitionDisposition::InvalidEvent,
                RecordAcquisitionDisposition::NotAcquired {
                    reason: NoWorkReason::Completed,
                    ..
                }
            ]
        ));
        assert_eq!(log.calls().len(), 2);
    }

    #[tokio::test]
    async fn worker_identity_is_stable_across_messages_and_fixture_workers_are_distinct() {
        let mut jobs = FakeJobState::new(CallLog::default());
        jobs.add_claim(JOB_ID, VIDEO_ID, false);
        jobs.add_claim(JOB_ID, VIDEO_ID, false);
        for attempt in [1, 2] {
            jobs.add_lease_acquisition(LeaseAcquisitionOutcome::Acquired {
                attempt,
                lease_expires_at: SystemTime::UNIX_EPOCH,
            });
        }
        let acquisition = processor(jobs, "worker-a");

        let first = acquisition.acquire_notification(FIXTURE).await;
        let second = acquisition.acquire_notification(FIXTURE).await;
        let worker = |result: &[RecordAcquisitionDisposition]| match &result[0] {
            RecordAcquisitionDisposition::Acquired(job) => job.worker_id.clone(),
            other => panic!("expected acquired job, got {other:?}"),
        };
        assert_eq!(worker(&first), worker(&second));
        assert_ne!(identity("worker-a"), identity("worker-b"));
        assert_ne!(WorkerIdentity::generate(), WorkerIdentity::generate());
        assert!(WorkerIdentity::from_value(" ").is_err());
    }

    #[derive(Clone)]
    struct CompetingJobs {
        available: Arc<AtomicBool>,
    }

    impl JobState for CompetingJobs {
        fn claim(
            &mut self,
            _job_id: &str,
            _video_id: &str,
        ) -> impl Future<Output = Result<bool, PersistenceError>> + Send {
            std::future::ready(Ok(false))
        }

        fn mark_processing(
            &mut self,
            _job_id: &str,
        ) -> impl Future<Output = Result<(), PersistenceError>> + Send {
            std::future::ready(Ok(()))
        }

        fn mark_completed(
            &mut self,
            _job_id: &str,
        ) -> impl Future<Output = Result<(), PersistenceError>> + Send {
            std::future::ready(Ok(()))
        }

        fn mark_failed(
            &mut self,
            _job_id: &str,
            _reason: &str,
        ) -> impl Future<Output = Result<(), PersistenceError>> + Send {
            std::future::ready(Ok(()))
        }

        fn acquire_lease(
            &mut self,
            _job_id: &str,
            _video_id: &str,
            _worker_id: &str,
            _lease_seconds: u64,
            _max_attempts: u32,
        ) -> impl Future<Output = Result<LeaseAcquisitionOutcome, PersistenceError>> + Send
        {
            let acquired = self
                .available
                .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
                .is_ok();
            std::future::ready(Ok(if acquired {
                LeaseAcquisitionOutcome::Acquired {
                    attempt: 1,
                    lease_expires_at: SystemTime::UNIX_EPOCH,
                }
            } else {
                LeaseAcquisitionOutcome::Busy
            }))
        }
    }

    #[tokio::test]
    async fn two_workers_produce_at_most_one_acquired_disposition() {
        let shared = CompetingJobs {
            available: Arc::new(AtomicBool::new(true)),
        };
        let first = LeaseAcquisitionProcessor::new(
            shared.clone(),
            identity("worker-a"),
            INPUT_BUCKET,
            LEASE_SECONDS,
            MAX_ATTEMPTS,
        );
        let second = LeaseAcquisitionProcessor::new(
            shared,
            identity("worker-b"),
            INPUT_BUCKET,
            LEASE_SECONDS,
            MAX_ATTEMPTS,
        );

        let (first, second) = tokio::join!(
            first.acquire_notification(FIXTURE),
            second.acquire_notification(FIXTURE)
        );
        let acquired = first
            .iter()
            .chain(second.iter())
            .filter(|result| matches!(result, RecordAcquisitionDisposition::Acquired(_)))
            .count();
        assert_eq!(acquired, 1);
    }

    #[tokio::test]
    async fn malformed_and_empty_notifications_are_invalid() {
        let acquisition = processor(FakeJobState::new(CallLog::default()), "worker-a");
        assert_eq!(
            acquisition.acquire_notification("not-json").await,
            [RecordAcquisitionDisposition::InvalidEvent]
        );
        assert_eq!(
            acquisition.acquire_notification(r#"{"Records":[]}"#).await,
            [RecordAcquisitionDisposition::InvalidEvent]
        );
    }
}
