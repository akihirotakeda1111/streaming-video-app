//! Validation and publication of the immutable result of a distributed run.

use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

use persistence::{JobOperationOutcome, JobState};
use serde::Deserialize;
use storage::{Read, Write};
use tokio::sync::{watch, Mutex};

use crate::{
    acquisition::AcquiredJob,
    orchestration::{ExecutionInput, Finalizer, OrchestrationError},
};

const PLAYLIST_TYPE: &str = "application/vnd.apple.mpegurl";
const SEGMENT_TYPE: &str = "video/mp2t";
const IMMUTABLE_CACHE: &str = "public,max-age=31536000,immutable";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ObjectDescriptor {
    key: String,
    size_bytes: u64,
    content_type: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildResult {
    video_id: String,
    job_id: String,
    attempt: u32,
    execution_id: String,
    rendition: String,
    source_key: String,
    output_prefix: String,
    schema_version: u8,
    media_playlist: ObjectDescriptor,
    segments: Vec<ObjectDescriptor>,
    width: u32,
    height: u32,
    bandwidth: u32,
    codecs: String,
}

pub struct DistributedFinalizer<J, S> {
    jobs: Arc<Mutex<J>>,
    storage: Arc<Mutex<S>>,
    output_bucket: String,
}

impl<J, S> DistributedFinalizer<J, S> {
    pub fn new(
        jobs: Arc<Mutex<J>>,
        storage: Arc<Mutex<S>>,
        output_bucket: impl Into<String>,
    ) -> Self {
        Self {
            jobs,
            storage,
            output_bucket: output_bucket.into(),
        }
    }
}

impl<J, S> Finalizer for DistributedFinalizer<J, S>
where
    J: JobState + Send + 'static,
    S: Read + Write + Send + 'static,
{
    fn finalize(
        &self,
        job: &AcquiredJob,
        input: &ExecutionInput,
        ownership: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>> {
        let job = job.clone();
        let input = input.clone();
        let jobs = self.jobs.clone();
        let storage = self.storage.clone();
        let bucket = self.output_bucket.clone();
        Box::pin(async move {
            if *ownership.borrow() {
                return Err(OrchestrationError::OwnershipLost);
            }
            let mut results = BTreeMap::new();
            {
                let mut store = storage.lock().await;
                for rendition in &input.renditions {
                    if *ownership.borrow() {
                        return Err(OrchestrationError::OwnershipLost);
                    }
                    let key = format!("{}/{}/result.json", input.output_prefix, rendition);
                    let bytes = store.read(&bucket, &key).await.map_err(storage_error)?;
                    let result: ChildResult = serde_json::from_slice(&bytes).map_err(|_| {
                        OrchestrationError::Finalizer("invalid child result".into())
                    })?;
                    validate_result(&result, &input, rendition, &key)?;
                    validate_objects(&mut *store, &bucket, &result).await?;
                    results.insert(rendition.clone(), result);
                }
                if results.len() != input.renditions.len() {
                    return Err(finalizer_error("missing rendition"));
                }
                if *ownership.borrow() {
                    return Err(OrchestrationError::OwnershipLost);
                }
                let master_key = format!("{}/index.m3u8", input.output_prefix);
                let master = build_master(&input.renditions, &results)?;
                store
                    .write_with_cache_control(
                        &bucket,
                        &master_key,
                        PLAYLIST_TYPE,
                        IMMUTABLE_CACHE,
                        master.as_bytes(),
                    )
                    .await
                    .map_err(storage_error)?;
            }
            if *ownership.borrow() {
                return Err(OrchestrationError::OwnershipLost);
            }
            let master_key = format!("{}/index.m3u8", input.output_prefix);
            let outcome = jobs
                .lock()
                .await
                .complete_distributed(
                    &job.item.job_id,
                    &job.item.video_id,
                    job.worker_id.as_str(),
                    input.attempt,
                    &master_key,
                )
                .await
                .map_err(|e| finalizer_error(&e.0))?;
            if outcome == JobOperationOutcome::Applied {
                Ok(())
            } else {
                Err(OrchestrationError::OwnershipLost)
            }
        })
    }
}

fn finalizer_error(message: &str) -> OrchestrationError {
    OrchestrationError::Finalizer(message.into())
}
fn storage_error(error: storage::ObjectError) -> OrchestrationError {
    finalizer_error(&error.0)
}

fn validate_result(
    result: &ChildResult,
    input: &ExecutionInput,
    rendition: &str,
    result_key: &str,
) -> Result<(), OrchestrationError> {
    let expected_prefix = format!("{}/{}", input.output_prefix, rendition);
    if result.schema_version != 1
        || result.video_id != input.video_id
        || result.job_id != input.job_id
        || result.attempt != input.attempt
        || result.execution_id != input.execution_id
        || result.source_key != input.source_key
        || result.rendition != rendition
        || result.output_prefix != expected_prefix
        || result_key != &format!("{expected_prefix}/result.json")
        || result.width == 0
        || result.height == 0
        || result.bandwidth == 0
        || result.codecs.is_empty()
        || (rendition == "360p" && (result.width > 640 || result.height > 360))
        || rendition == "720p" && (result.width > 1280 || result.height > 720)
    {
        return Err(finalizer_error(
            "child result identity or media claims are invalid",
        ));
    }
    if result.media_playlist.key != format!("{expected_prefix}/index.m3u8")
        || result.media_playlist.content_type != PLAYLIST_TYPE
    {
        return Err(finalizer_error("media playlist descriptor mismatch"));
    }
    Ok(())
}

async fn validate_objects<S: Read + Write>(
    store: &mut S,
    bucket: &str,
    result: &ChildResult,
) -> Result<(), OrchestrationError> {
    let playlist = read_descriptor(store, bucket, &result.media_playlist, PLAYLIST_TYPE).await?;
    let mut references = Vec::new();
    for line in String::from_utf8(playlist)
        .map_err(|_| finalizer_error("media playlist is not UTF-8"))?
        .lines()
    {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains('/')
            || line.contains(':')
            || line.starts_with('.')
            || line != format!("segment-{:05}.ts", references.len())
        {
            return Err(finalizer_error(
                "media playlist reference is outside its rendition",
            ));
        }
        references.push(line.to_owned());
    }
    if references.len() != result.segments.len() {
        return Err(finalizer_error("segment descriptor count mismatch"));
    }
    for (index, descriptor) in result.segments.iter().enumerate() {
        let expected = format!("{}/segment-{index:05}.ts", result.output_prefix);
        if descriptor.key != expected || descriptor.content_type != SEGMENT_TYPE {
            return Err(finalizer_error("segment descriptor mismatch"));
        }
        read_descriptor(store, bucket, descriptor, SEGMENT_TYPE).await?;
    }
    Ok(())
}

async fn read_descriptor<S: Read + Write>(
    store: &mut S,
    bucket: &str,
    descriptor: &ObjectDescriptor,
    content_type: &str,
) -> Result<Vec<u8>, OrchestrationError> {
    if descriptor.content_type != content_type || descriptor.size_bytes == 0 {
        return Err(finalizer_error("object descriptor metadata mismatch"));
    }
    let object = store
        .read_object(bucket, &descriptor.key)
        .await
        .map_err(storage_error)?;
    if mime_type(object.content_type.as_deref().unwrap_or("")) != content_type {
        return Err(finalizer_error("object MIME type mismatch"));
    }
    let stored_size = object
        .content_length
        .ok_or_else(|| finalizer_error("object size mismatch"))?;
    if stored_size != descriptor.size_bytes
        || object.contents.len() as u64 != descriptor.size_bytes
        || object.contents.is_empty()
    {
        return Err(finalizer_error("object size mismatch"));
    }
    Ok(object.contents)
}

fn mime_type(value: &str) -> &str {
    value.split(';').next().unwrap_or(value).trim()
}

fn build_master(
    renditions: &[String],
    results: &BTreeMap<String, ChildResult>,
) -> Result<String, OrchestrationError> {
    let mut master = String::from("#EXTM3U\n");
    for rendition in renditions {
        let result = results
            .get(rendition)
            .ok_or_else(|| finalizer_error("missing rendition"))?;
        master.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},CODECS=\"{}\"\n{}/index.m3u8\n",
            result.bandwidth, result.width, result.height, result.codecs, rendition
        ));
    }
    Ok(master)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        acquisition::{AcquiredJob, WorkerIdentity},
        event::WorkItem,
        fakes::{Call, CallLog, FakeJobState, FakeStorage},
        orchestration::canonical_renditions,
    };
    use persistence::JobOperationOutcome;
    use std::time::SystemTime;

    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const BUCKET: &str = "output";
    const DEADLINE: &str = "2099-01-01T00:00:00Z";
    const PLAYLIST: &[u8] = b"#EXTM3U\nsegment-00000.ts\n";
    const SEGMENT: &[u8] = b"ts-bytes";

    fn job(attempt: u32) -> AcquiredJob {
        AcquiredJob {
            item: WorkItem {
                bucket: "in".into(),
                key: format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/source.mp4"),
                video_id: VIDEO_ID.into(),
                job_id: JOB_ID.into(),
            },
            worker_id: WorkerIdentity::from_value("worker").unwrap(),
            attempt,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        }
    }

    fn input_for(job: &AcquiredJob) -> ExecutionInput {
        ExecutionInput::for_job(job, canonical_renditions(), DEADLINE).unwrap()
    }

    fn child_json(input: &ExecutionInput, rendition: &str, attempt: u32, video_id: &str) -> String {
        let (width, height) = if rendition == "360p" {
            (640, 360)
        } else {
            (1280, 720)
        };
        let prefix = format!("{}/{rendition}", input.output_prefix);
        serde_json::json!({
            "video_id": video_id,
            "job_id": input.job_id,
            "attempt": attempt,
            "execution_id": input.execution_id,
            "rendition": rendition,
            "source_key": input.source_key,
            "output_prefix": prefix,
            "schema_version": 1,
            "media_playlist": {
                "key": format!("{prefix}/index.m3u8"),
                "size_bytes": PLAYLIST.len() as u64,
                "content_type": PLAYLIST_TYPE,
            },
            "segments": [{
                "key": format!("{prefix}/segment-00000.ts"),
                "size_bytes": SEGMENT.len() as u64,
                "content_type": SEGMENT_TYPE,
            }],
            "width": width,
            "height": height,
            "bandwidth": 800_000,
            "codecs": "avc1.64001e,mp4a.40.2",
        })
        .to_string()
    }

    fn seed_rendition(
        storage: &mut FakeStorage,
        input: &ExecutionInput,
        rendition: &str,
        json: &str,
        playlist_type: &str,
        segment_type: &str,
    ) {
        let prefix = format!("{}/{rendition}", input.output_prefix);
        storage.add_read(
            BUCKET,
            &format!("{prefix}/result.json"),
            json.as_bytes().to_vec(),
        );
        storage.add_read_with_metadata(
            BUCKET,
            &format!("{prefix}/index.m3u8"),
            playlist_type,
            Some(PLAYLIST.len() as u64),
            PLAYLIST.to_vec(),
        );
        storage.add_read_with_metadata(
            BUCKET,
            &format!("{prefix}/segment-00000.ts"),
            segment_type,
            Some(SEGMENT.len() as u64),
            SEGMENT.to_vec(),
        );
    }

    fn seed_valid(storage: &mut FakeStorage, input: &ExecutionInput) {
        for rendition in &input.renditions {
            let json = child_json(input, rendition, input.attempt, &input.video_id);
            seed_rendition(
                storage,
                input,
                rendition,
                &json,
                PLAYLIST_TYPE,
                SEGMENT_TYPE,
            );
        }
    }

    async fn run(
        jobs: FakeJobState,
        storage: FakeStorage,
        job: &AcquiredJob,
        input: &ExecutionInput,
        lost: bool,
    ) -> Result<(), OrchestrationError> {
        let (_, ownership) = watch::channel(lost);
        DistributedFinalizer::new(
            Arc::new(Mutex::new(jobs)),
            Arc::new(Mutex::new(storage)),
            BUCKET,
        )
        .finalize(job, input, ownership)
        .await
    }

    fn master_written(log: &CallLog, input: &ExecutionInput) -> bool {
        let key = format!("{}/index.m3u8", input.output_prefix);
        log.calls().iter().any(|call| {
            matches!(
                call,
                Call::Write { key: written, content_type, .. }
                    if written == &key && content_type == PLAYLIST_TYPE
            )
        })
    }

    #[tokio::test]
    async fn publishes_master_then_commits_for_valid_children() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        seed_valid(&mut storage, &input);
        let jobs = FakeJobState::new(log.clone());
        run(jobs, storage, &job, &input, false).await.unwrap();
        assert!(master_written(&log, &input));
        assert!(log.calls().iter().any(|call| matches!(
            call,
            Call::CompleteDistributed {
                attempt: 1,
                published_manifest_key,
                ..
            } if published_manifest_key == &format!("{}/index.m3u8", input.output_prefix)
        )));
    }

    #[tokio::test]
    async fn missing_child_result_does_not_publish() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        let json = child_json(&input, "360p", 1, VIDEO_ID);
        seed_rendition(
            &mut storage,
            &input,
            "360p",
            &json,
            PLAYLIST_TYPE,
            SEGMENT_TYPE,
        );
        let error = run(FakeJobState::new(log.clone()), storage, &job, &input, false)
            .await
            .unwrap_err();
        assert!(matches!(error, OrchestrationError::Finalizer(_)));
        assert!(!master_written(&log, &input));
        assert!(!log
            .calls()
            .iter()
            .any(|call| matches!(call, Call::CompleteDistributed { .. })));
    }

    #[tokio::test]
    async fn wrong_child_identity_does_not_publish() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        for rendition in &input.renditions {
            let video_id = if rendition == "720p" {
                "018f47a2-45c2-7a84-b84f-5f6dd7b5910b"
            } else {
                VIDEO_ID
            };
            let json = child_json(&input, rendition, 1, video_id);
            seed_rendition(
                &mut storage,
                &input,
                rendition,
                &json,
                PLAYLIST_TYPE,
                SEGMENT_TYPE,
            );
        }
        let error = run(FakeJobState::new(log.clone()), storage, &job, &input, false)
            .await
            .unwrap_err();
        assert!(matches!(error, OrchestrationError::Finalizer(_)));
        assert!(!master_written(&log, &input));
    }

    #[tokio::test]
    async fn wrong_attempt_does_not_publish() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        for rendition in &input.renditions {
            let json = child_json(&input, rendition, 2, VIDEO_ID);
            seed_rendition(
                &mut storage,
                &input,
                rendition,
                &json,
                PLAYLIST_TYPE,
                SEGMENT_TYPE,
            );
        }
        let error = run(FakeJobState::new(log.clone()), storage, &job, &input, false)
            .await
            .unwrap_err();
        assert!(matches!(error, OrchestrationError::Finalizer(_)));
        assert!(!master_written(&log, &input));
    }

    #[tokio::test]
    async fn stored_mime_mismatch_does_not_publish() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        for rendition in &input.renditions {
            let json = child_json(&input, rendition, 1, VIDEO_ID);
            let segment_type = if rendition == "720p" {
                "application/octet-stream"
            } else {
                SEGMENT_TYPE
            };
            seed_rendition(
                &mut storage,
                &input,
                rendition,
                &json,
                PLAYLIST_TYPE,
                segment_type,
            );
        }
        let error = run(FakeJobState::new(log.clone()), storage, &job, &input, false)
            .await
            .unwrap_err();
        assert!(
            matches!(error, OrchestrationError::Finalizer(message) if message.contains("MIME"))
        );
        assert!(!master_written(&log, &input));
    }

    #[tokio::test]
    async fn ownership_loss_does_not_publish() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        seed_valid(&mut storage, &input);
        let error = run(FakeJobState::new(log.clone()), storage, &job, &input, true)
            .await
            .unwrap_err();
        assert!(matches!(error, OrchestrationError::OwnershipLost));
        assert!(!master_written(&log, &input));
        assert!(!log
            .calls()
            .iter()
            .any(|call| matches!(call, Call::CompleteDistributed { .. })));
    }

    #[tokio::test]
    async fn completion_not_owner_is_ownership_loss_after_master_put() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        seed_valid(&mut storage, &input);
        let mut jobs = FakeJobState::new(log.clone());
        jobs.complete_distributed_outcome(JobOperationOutcome::NotOwner);
        let error = run(jobs, storage, &job, &input, false).await.unwrap_err();
        assert!(matches!(error, OrchestrationError::OwnershipLost));
        assert!(master_written(&log, &input));
    }

    #[tokio::test]
    async fn database_completion_failure_leaves_unpublished_master() {
        let job = job(1);
        let input = input_for(&job);
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        seed_valid(&mut storage, &input);
        let mut jobs = FakeJobState::new(log.clone());
        jobs.fail_complete_distributed("commit failed");
        let error = run(jobs, storage, &job, &input, false).await.unwrap_err();
        assert!(
            matches!(error, OrchestrationError::Finalizer(message) if message.contains("commit failed"))
        );
        assert!(master_written(&log, &input));
    }
}
