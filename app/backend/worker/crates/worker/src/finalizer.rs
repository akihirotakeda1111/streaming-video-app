//! Validation and publication of the immutable result of a distributed run.

use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

use persistence::{JobOperationOutcome, JobState};
use serde::Deserialize;
use storage::{Read, Write};
use tokio::sync::{Mutex, watch};

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
        mut ownership: watch::Receiver<bool>,
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
    let bytes = store
        .read(bucket, &descriptor.key)
        .await
        .map_err(storage_error)?;
    if bytes.len() as u64 != descriptor.size_bytes || bytes.is_empty() {
        return Err(finalizer_error("object size mismatch"));
    }
    Ok(bytes)
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
