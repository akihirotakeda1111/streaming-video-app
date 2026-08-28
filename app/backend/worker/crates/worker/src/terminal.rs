//! End-to-end processing and terminal-state ordering for an owned notification.

use std::{
    fmt, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use encoding::{Execute, HlsError, encode_hls, runtime::JobDirectory};
use persistence::{JobState, PersistenceError};
use queue::{Delete, Message, QueueError};
use storage::{ObjectError, Read, Write};

use crate::{
    claim::claim_notification,
    publish::{PublishError, publish_hls},
    runtime::MessageProcessor,
};

#[derive(Debug)]
pub struct TerminalError(pub String);

impl fmt::Display for TerminalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for TerminalError {}

/// Owns every port needed to take a claimed job through durable completion.
/// Each port is shared because the runtime clones processors for bounded
/// concurrent message handling.
pub struct TerminalProcessor<J, S, E, Q> {
    jobs: Arc<Mutex<J>>,
    storage: Arc<Mutex<S>>,
    executor: Arc<Mutex<E>>,
    queue: Arc<Mutex<Q>>,
    input_bucket: String,
    output_bucket: String,
    ffmpeg_path: PathBuf,
    temporary_directory: PathBuf,
}

impl<J, S, E, Q> Clone for TerminalProcessor<J, S, E, Q> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
            storage: self.storage.clone(),
            executor: self.executor.clone(),
            queue: self.queue.clone(),
            input_bucket: self.input_bucket.clone(),
            output_bucket: self.output_bucket.clone(),
            ffmpeg_path: self.ffmpeg_path.clone(),
            temporary_directory: self.temporary_directory.clone(),
        }
    }
}

impl<J, S, E, Q> TerminalProcessor<J, S, E, Q> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        jobs: J,
        storage: S,
        executor: E,
        queue: Q,
        input_bucket: impl Into<String>,
        output_bucket: impl Into<String>,
        ffmpeg_path: impl Into<PathBuf>,
        temporary_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(jobs)),
            storage: Arc::new(Mutex::new(storage)),
            executor: Arc::new(Mutex::new(executor)),
            queue: Arc::new(Mutex::new(queue)),
            input_bucket: input_bucket.into(),
            output_bucket: output_bucket.into(),
            ffmpeg_path: ffmpeg_path.into(),
            temporary_directory: temporary_directory.into(),
        }
    }

    fn fail_owned(&self, job_id: &str, failure: String) -> Result<(), TerminalError>
    where
        J: JobState,
    {
        debug_assert!(!failure.trim().is_empty());
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| TerminalError("job state lock poisoned".into()))?;
        jobs.mark_failed(job_id, &failure).map_err(|error| {
            TerminalError(format!(
                "{failure}; additionally failed to persist FAILED: {error}"
            ))
        })
    }

    fn process_owned(&self, item: &crate::event::WorkItem) -> Result<(), String>
    where
        J: JobState,
        S: Read + Write,
        E: Execute,
    {
        self.jobs
            .lock()
            .map_err(|_| "job state lock poisoned".to_string())?
            .mark_processing(&item.job_id)
            .map_err(|e| format!("mark PROCESSING: {e}"))?;

        let directory = JobDirectory::create(&self.temporary_directory, &item.job_id)
            .map_err(|e| format!("create work directory: {e}"))?;
        let source = self
            .storage
            .lock()
            .map_err(|_| "storage lock poisoned".to_string())?
            .read(&item.bucket, &item.key)
            .map_err(|e: ObjectError| format!("download source: {}", e.0))?;
        fs::write(directory.path().join("source.mp4"), source)
            .map_err(|e| format!("write source: {e}"))?;
        let output = encode_hls(
            &mut *self
                .executor
                .lock()
                .map_err(|_| "executor lock poisoned".to_string())?,
            self.ffmpeg_path.clone(),
            directory.path(),
        )
        .map_err(|e: HlsError| format!("encode HLS: {e}"))?;
        publish_hls(
            &mut *self
                .storage
                .lock()
                .map_err(|_| "storage lock poisoned".to_string())?,
            &self.output_bucket,
            &item.video_id,
            &item.job_id,
            &output,
        )
        .map_err(|e: PublishError| format!("publish HLS: {e}"))?;

        // Cleanup is completed before the terminal transition so a cleanup
        // error can never cause an already-COMPLETED job to be overwritten.
        // Drop provides the same cleanup attempt on every earlier return path.
        directory
            .remove()
            .map_err(|e| format!("remove work directory: {e}"))?;

        // This transition is intentionally after publish_hls, whose final write
        // is the manifest.
        self.jobs
            .lock()
            .map_err(|_| "job state lock poisoned".to_string())?
            .mark_completed(&item.job_id)
            .map_err(|e| format!("mark COMPLETED: {e}"))?;
        Ok(())
    }
}

impl<J, S, E, Q> MessageProcessor for TerminalProcessor<J, S, E, Q>
where
    J: JobState + Send + 'static,
    S: Read + Write + Send + 'static,
    E: Execute + Send + 'static,
    Q: Delete + Send + 'static,
{
    type Error = TerminalError;

    async fn process(&self, message: Message) -> Result<(), Self::Error> {
        let owned = {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| TerminalError("job state lock poisoned".into()))?;
            claim_notification(&mut *jobs, &message.body, &self.input_bucket)
                .map_err(|e: PersistenceError| TerminalError(format!("claim notification: {e}")))?
        };
        if owned.is_empty() {
            return Ok(());
        }

        let mut failed = false;
        for item in &owned {
            if let Err(failure) = self.process_owned(item) {
                self.fail_owned(&item.job_id, failure)?;
                failed = true;
            }
        }
        if failed {
                // Do not acknowledge, and do not fail the worker process. Phase 1
                // has no retry policy; visibility timeout redelivers the message.
                return Ok(());
        }

        // Acknowledgement is last. In particular, a delete failure must not
        // turn an already-COMPLETED job into FAILED.
        self.queue
            .lock()
            .map_err(|_| TerminalError("queue lock poisoned".into()))?
            .delete(&message.receipt_handle)
            .map_err(|e: QueueError| TerminalError(format!("delete completed message: {}", e.0)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fakes::{Call, CallLog, FakeJobState, FakeProcessExecutor, FakeQueue, FakeStorage};

    const EVENT: &str = include_str!("../../../../../contracts/examples/s3/object-created.json");
    const INPUT: &str = "streaming-video-input";
    const OUTPUT_BUCKET: &str = "streaming-video-output";
    const VIDEO: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const KEY: &str = "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4";

    fn message() -> Message {
        Message {
            receipt_handle: "receipt".into(),
            body: EVENT.into(),
        }
    }

    fn processor(
        log: CallLog,
        root: &std::path::Path,
    ) -> TerminalProcessor<FakeJobState, FakeStorage, FakeProcessExecutor, FakeQueue> {
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB, VIDEO, true);
        let mut storage = FakeStorage::new(log.clone());
        storage.add_read(INPUT, KEY, b"video".to_vec());
        TerminalProcessor::new(
            jobs,
            storage,
            FakeProcessExecutor::stub_hls(log.clone()),
            FakeQueue::new(log),
            INPUT,
            OUTPUT_BUCKET,
            "ffmpeg",
            root,
        )
    }

    fn call_index(calls: &[Call], predicate: impl Fn(&Call) -> bool) -> usize {
        calls
            .iter()
            .position(predicate)
            .unwrap_or_else(|| panic!("missing expected call in {calls:?}"))
    }

    #[tokio::test]
    async fn full_order_is_claim_through_delete_and_cleans_up() {
        let log = CallLog::default();
        let root = tempfile::tempdir().unwrap();
        let p = processor(log.clone(), root.path());

        p.process(message()).await.unwrap();
        let calls = log.calls();
        let claim = call_index(
            &calls,
            |c| matches!(c, Call::Claim { job_id, video_id } if job_id == JOB && video_id == VIDEO),
        );
        let processing = call_index(
            &calls,
            |c| matches!(c, Call::MarkProcessing(id) if id == JOB),
        );
        let download = call_index(
            &calls,
            |c| matches!(c, Call::Read { bucket, key } if bucket == INPUT && key == KEY),
        );
        let encode = call_index(&calls, |c| matches!(c, Call::Execute(_)));
        let segment = call_index(
            &calls,
            |c| matches!(c, Call::Write { key, .. } if key.ends_with("segment-00000.ts")),
        );
        let manifest = call_index(
            &calls,
            |c| matches!(c, Call::Write { key, .. } if key.ends_with("index.m3u8")),
        );
        let completed = call_index(
            &calls,
            |c| matches!(c, Call::MarkCompleted(id) if id == JOB),
        );
        let deleted = call_index(
            &calls,
            |c| matches!(c, Call::Delete(handle) if handle == "receipt"),
        );
        assert!(
            claim < processing
                && processing < download
                && download < encode
                && encode < segment
                && segment < manifest
                && manifest < completed
                && completed < deleted,
            "{calls:?}"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn duplicate_zero_row_claim_is_a_no_op_without_delete() {
        let log = CallLog::default();
        let root = tempfile::tempdir().unwrap();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim(JOB, VIDEO, false);
        let p = TerminalProcessor::new(
            jobs,
            FakeStorage::new(log.clone()),
            FakeProcessExecutor::stub_hls(log.clone()),
            FakeQueue::new(log.clone()),
            INPUT,
            OUTPUT_BUCKET,
            "ffmpeg",
            root.path(),
        );
        p.process(message()).await.unwrap();
        assert!(log.calls().iter().all(|c| matches!(c, Call::Claim { .. })));
    }

    #[tokio::test]
    async fn every_pipeline_failure_marks_failed_without_completion_or_delete_and_cleans_up() {
        for boundary in ["processing", "download", "encode", "publish", "complete"] {
            let log = CallLog::default();
            let root = tempfile::tempdir().unwrap();
            let p = processor(log.clone(), root.path());
            match boundary {
                "processing" => p.jobs.lock().unwrap().fail_mark_processing("no processing"),
                "download" => p.storage.lock().unwrap().fail_read("no source"),
                "encode" => p.executor.lock().unwrap().fail_next("no ffmpeg"),
                "publish" => p.storage.lock().unwrap().fail_write("no upload"),
                "complete" => p.jobs.lock().unwrap().fail_mark_completed("no completion"),
                _ => unreachable!(),
            }
            assert!(p.process(message()).await.is_ok(), "{boundary}");
            let calls = log.calls();
            assert!(
                calls
                    .iter()
                    .any(|c| matches!(c, Call::MarkFailed { reason, .. } if !reason.is_empty())),
                "{boundary}: {calls:?}"
            );
            assert!(
                !calls.iter().any(|c| matches!(c, Call::Delete(_))),
                "{boundary}: {calls:?}"
            );
            if boundary != "complete" {
                assert!(
                    !calls.iter().any(|c| matches!(c, Call::MarkCompleted(_))),
                    "{boundary}: {calls:?}"
                );
            }
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0, "{boundary}");
        }
    }

    #[tokio::test]
    async fn delete_failure_does_not_overwrite_completed_state() {
        let log = CallLog::default();
        let root = tempfile::tempdir().unwrap();
        let p = processor(log.clone(), root.path());
        p.queue.lock().unwrap().fail_delete("SQS unavailable");
        assert!(p.process(message()).await.is_err());
        let calls = log.calls();
        assert!(calls.iter().any(|c| matches!(c, Call::MarkCompleted(_))));
        assert!(!calls.iter().any(|c| matches!(c, Call::MarkFailed { .. })));
    }
}
