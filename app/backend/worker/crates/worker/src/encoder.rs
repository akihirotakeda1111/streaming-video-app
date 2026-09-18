//! The isolated, database-free single-rendition child encoder.

use encoding::{
    Execute,
    limits::BoundedExecutor,
    runtime::{JobDirectory, ProcessExecutor},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, path::Path, time::Duration};
use storage::{Read, Write, s3::S3Storage};

const PLAYLIST_TYPE: &str = "application/vnd.apple.mpegurl";
const SEGMENT_TYPE: &str = "video/mp2t";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChildPayload {
    pub video_id: String,
    pub job_id: String,
    pub attempt: u32,
    pub execution_id: String,
    pub rendition: String,
    pub source_key: String,
    pub output_prefix: String,
}

#[derive(Debug)]
pub enum EncoderError {
    InvalidPayload(&'static str),
    Input(String),
    Media(String),
    Storage(String),
    Json(String),
}
impl fmt::Display for EncoderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPayload(s) => write!(f, "invalid child payload: {s}"),
            Self::Input(s) | Self::Media(s) | Self::Storage(s) | Self::Json(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for EncoderError {}

#[derive(Serialize)]
struct ObjectDescriptor {
    key: String,
    size_bytes: u64,
    content_type: String,
}
#[derive(Serialize)]
struct ChildResult {
    #[serde(flatten)]
    payload: ChildPayload,
    schema_version: u8,
    media_playlist: ObjectDescriptor,
    segments: Vec<ObjectDescriptor>,
    width: u32,
    height: u32,
    bandwidth: u64,
    codecs: String,
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

/// Validate all derived identities before a source read or output write.
pub fn validate_payload(payload: &ChildPayload) -> Result<(), EncoderError> {
    if !canonical_uuid(&payload.video_id) || !canonical_uuid(&payload.job_id) {
        return Err(EncoderError::InvalidPayload("ids must be lowercase UUIDs"));
    }
    if payload.attempt == 0
        || payload.execution_id != format!("job-{}-a{}", payload.job_id, payload.attempt)
    {
        return Err(EncoderError::InvalidPayload("execution identity mismatch"));
    }
    if !matches!(payload.rendition.as_str(), "360p" | "720p") {
        return Err(EncoderError::InvalidPayload("unsupported rendition"));
    }
    let source = format!(
        "videos/{}/jobs/{}/source.mp4",
        payload.video_id, payload.job_id
    );
    if payload.source_key != source {
        return Err(EncoderError::InvalidPayload("source key mismatch"));
    }
    let prefix = format!(
        "videos/{}/jobs/{}/hls/attempts/{}/{}/{}",
        payload.video_id, payload.job_id, payload.attempt, payload.execution_id, payload.rendition
    );
    if payload.output_prefix != prefix {
        return Err(EncoderError::InvalidPayload("output prefix mismatch"));
    }
    Ok(())
}

fn ceiling(rendition: &str) -> (u32, u32) {
    if rendition == "360p" {
        (640, 360)
    } else {
        (1280, 720)
    }
}

async fn probe(path: &Path, ffprobe: &Path) -> Result<(u32, u32, String, bool), EncoderError> {
    let mut executor = ProcessExecutor;
    let command = encoding::Command::new(
        ffprobe,
        vec![
            "-v".into(),
            "error".into(),
            "-show_streams".into(),
            "-of".into(),
            "json".into(),
            path.to_string_lossy().into_owned(),
        ],
    );
    let output = executor
        .execute(command)
        .await
        .map_err(|e| EncoderError::Media(e.0))?;
    if output.status != 0 {
        return Err(EncoderError::Media(
            "source media is corrupt or unreadable".into(),
        ));
    }
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| EncoderError::Media("invalid ffprobe output".into()))?;
    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .ok_or(EncoderError::Media("source has no streams".into()))?;
    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or(EncoderError::Media("source has no video".into()))?;
    let width = video
        .get("width")
        .and_then(Value::as_u64)
        .ok_or(EncoderError::Media("video width missing".into()))? as u32;
    let height = video
        .get("height")
        .and_then(Value::as_u64)
        .ok_or(EncoderError::Media("video height missing".into()))? as u32;
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
        return Err(EncoderError::Media(
            "source dimensions must be positive and even".into(),
        ));
    }
    let has_audio = streams
        .iter()
        .any(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"));
    Ok((
        width,
        height,
        video
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .into(),
        has_audio,
    ))
}

pub async fn encode_child<S: Read + Write + Send>(
    storage: &mut S,
    input_bucket: &str,
    output_bucket: &str,
    payload: ChildPayload,
    ffmpeg: &Path,
    ffprobe: &Path,
    temp_root: &Path,
) -> Result<(), EncoderError> {
    validate_payload(&payload)?;
    let directory = JobDirectory::create(temp_root, &payload.job_id)
        .map_err(|e| EncoderError::Input(e.to_string()))?;
    let source = directory.path().join("source.mp4");
    let bytes = storage
        .read_bounded(
            input_bucket,
            &payload.source_key,
            encoding::limits::Limits::default().source_bytes,
        )
        .await
        .map_err(|e| EncoderError::Storage(e.0))?;
    tokio::fs::write(&source, &bytes)
        .await
        .map_err(|e| EncoderError::Input(e.to_string()))?;
    let (source_width, source_height, _codec, has_audio) = probe(&source, ffprobe).await?;
    let (max_width, max_height) = ceiling(&payload.rendition);
    let (width, height) = scaled_dimensions(source_width, source_height, max_width, max_height);
    let mut executor = BoundedExecutor {
        limits: encoding::limits::Limits::default(),
    };
    let playlist_path = directory.path().join("index.m3u8");
    let segment_pattern = directory.path().join("segment-%05d.ts");
    let command = encoding::Command::new(
        ffmpeg,
        vec![
            "-y".into(),
            "-i".into(),
            source.to_string_lossy().into_owned(),
            "-vf".into(),
            format!("scale={width}:{height}:flags=lanczos"),
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-sc_threshold".into(),
            "0".into(),
            "-force_key_frames".into(),
            "expr:gte(t,n_forced*6)".into(),
            "-c:a".into(),
            "aac".into(),
            "-f".into(),
            "hls".into(),
            "-start_number".into(),
            "0".into(),
            "-hls_time".into(),
            "6".into(),
            "-hls_playlist_type".into(),
            "vod".into(),
            "-hls_segment_filename".into(),
            segment_pattern.to_string_lossy().into_owned(),
            playlist_path.to_string_lossy().into_owned(),
        ],
    );
    let process = executor
        .execute(command)
        .await
        .map_err(|e| EncoderError::Media(e.0))?;
    if process.status != 0 {
        return Err(EncoderError::Media("FFmpeg failed".into()));
    }
    let output = encoding::validate_hls_output(directory.path())
        .map_err(|e| EncoderError::Media(e.to_string()))?;
    let playlist = tokio::fs::read(&output.playlist)
        .await
        .map_err(|e| EncoderError::Media(e.to_string()))?;
    let mut descriptors = Vec::with_capacity(output.segments.len());
    for (index, segment) in output.segments.iter().enumerate() {
        let contents = tokio::fs::read(segment)
            .await
            .map_err(|e| EncoderError::Media(e.to_string()))?;
        if contents.is_empty() {
            return Err(EncoderError::Media("empty segment".into()));
        }
        let key = format!("{}/segment-{index:05}.ts", payload.output_prefix);
        storage
            .write(output_bucket, &key, SEGMENT_TYPE, &contents)
            .await
            .map_err(|e| EncoderError::Storage(e.0))?;
        descriptors.push(ObjectDescriptor {
            key,
            size_bytes: contents.len() as u64,
            content_type: SEGMENT_TYPE.into(),
        });
    }
    let playlist_key = format!("{}/index.m3u8", payload.output_prefix);
    storage
        .write(output_bucket, &playlist_key, PLAYLIST_TYPE, &playlist)
        .await
        .map_err(|e| EncoderError::Storage(e.0))?;
    let result = ChildResult {
        payload,
        schema_version: 1,
        media_playlist: ObjectDescriptor {
            key: playlist_key,
            size_bytes: playlist.len() as u64,
            content_type: PLAYLIST_TYPE.into(),
        },
        segments: descriptors,
        width,
        height,
        bandwidth: peak_bandwidth(&playlist, &output),
        codecs: if has_audio {
            "avc1.64001f,mp4a.40.2".into()
        } else {
            "avc1.64001f".into()
        },
    };
    let result_bytes =
        serde_json::to_vec(&result).map_err(|e| EncoderError::Json(e.to_string()))?;
    storage
        .write(
            output_bucket,
            &format!("{}/result.json", result.payload.output_prefix),
            "application/json",
            &result_bytes,
        )
        .await
        .map_err(|e| EncoderError::Storage(e.0))?;
    Ok(())
}

fn scaled_dimensions(
    source_width: u32,
    source_height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32) {
    let scale = (max_width as f64 / source_width as f64)
        .min(max_height as f64 / source_height as f64)
        .min(1.0);
    let mut width = ((source_width as f64 * scale).floor() as u32) & !1;
    let mut height = ((source_height as f64 * scale).floor() as u32) & !1;
    width = width.max(2);
    height = height.max(2);
    (width, height)
}

fn peak_bandwidth(playlist: &[u8], output: &encoding::HlsOutput) -> u64 {
    let durations: Vec<f64> = String::from_utf8_lossy(playlist)
        .lines()
        .filter_map(|line| {
            line.strip_prefix("#EXTINF:")
                .and_then(|v| v.split(',').next())
                .and_then(|v| v.parse().ok())
        })
        .collect();
    output
        .segments
        .iter()
        .enumerate()
        .filter_map(|(i, path)| {
            let seconds = durations.get(i).copied().unwrap_or(6.0);
            (seconds > 0.0).then(|| {
                std::fs::metadata(path)
                    .ok()
                    .map(|metadata| metadata.len().saturating_mul(8) / seconds.ceil() as u64)
            }).flatten()
        })
        .max()
        .unwrap_or(1)
        .max(1)
}

pub async fn run_from_cli() -> Result<(), EncoderError> {
    let argument = std::env::args().nth(2).ok_or(EncoderError::InvalidPayload(
        "payload path or - is required",
    ))?;
    let text = if argument == "-" {
        tokio::fs::read_to_string("/dev/stdin")
            .await
            .map_err(|e| EncoderError::Input(e.to_string()))?
    } else {
        tokio::fs::read_to_string(argument)
            .await
            .map_err(|e| EncoderError::Input(e.to_string()))?
    };
    let payload: ChildPayload =
        serde_json::from_str(&text).map_err(|e| EncoderError::Json(e.to_string()))?;
    validate_payload(&payload)?;
    let region = std::env::var("AWS_REGION")
        .map_err(|_| EncoderError::Input("AWS_REGION is required".into()))?;
    let input = std::env::var("VIDEO_INPUT_BUCKET")
        .map_err(|_| EncoderError::Input("VIDEO_INPUT_BUCKET is required".into()))?;
    let output = std::env::var("VIDEO_OUTPUT_BUCKET")
        .map_err(|_| EncoderError::Input("VIDEO_OUTPUT_BUCKET is required".into()))?;
    let ffmpeg = std::env::var_os("FFMPEG_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "ffmpeg".into());
    let ffprobe = std::env::var_os("FFPROBE_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "ffprobe".into());
    let temp = std::env::var_os("TMPDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/tmp/video-worker".into());
    let mut storage = S3Storage::new(&region, input.clone(), output.clone())
        .await
        .map_err(|e| EncoderError::Storage(e.0))?;
    tokio::time::timeout(
        Duration::from_secs(7200),
        encode_child(
            &mut storage,
            &input,
            &output,
            payload,
            &ffmpeg,
            &ffprobe,
            &temp,
        ),
    )
    .await
    .map_err(|_| EncoderError::Media("child encode timed out".into()))??;
    Ok(())
}
