//! The isolated, database-free single-rendition child encoder.

use encoding::{
    Execute,
    limits::BoundedExecutor,
    runtime::{JobDirectory, ProcessExecutor},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, future::Future, path::Path, time::Duration};
use storage::{Read, Write, s3::S3Storage};

const PLAYLIST_TYPE: &str = "application/vnd.apple.mpegurl";
const SEGMENT_TYPE: &str = "video/mp2t";
const SOURCE_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const ENCODED_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CHILD_ENCODE_TIMEOUT: Duration = Duration::from_secs(7200);

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

fn probe_command(ffprobe: &Path, path: &Path) -> encoding::Command {
    encoding::Command::new(
        ffprobe,
        vec![
            "-v".into(),
            "error".into(),
            "-show_streams".into(),
            "-of".into(),
            "json".into(),
            path.to_string_lossy().into_owned(),
        ],
    )
}

async fn ffprobe_json<E: Execute>(
    executor: &mut E,
    ffprobe: &Path,
    path: &Path,
    timeout: Duration,
    timeout_message: &'static str,
) -> Result<Value, EncoderError> {
    let output = tokio::time::timeout(timeout, executor.execute(probe_command(ffprobe, path)))
        .await
        .map_err(|_| EncoderError::Media(timeout_message.into()))?
        .map_err(|e| EncoderError::Media(e.0))?;
    if output.status != 0 {
        return Err(EncoderError::Media("media is corrupt or unreadable".into()));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| EncoderError::Media("invalid ffprobe output".into()))
}

fn streams_of(json: &Value) -> Result<&[Value], EncoderError> {
    json.get("streams")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(EncoderError::Media("source has no streams".into()))
}

async fn probe<E: Execute>(
    executor: &mut E,
    path: &Path,
    ffprobe: &Path,
) -> Result<(u32, u32, bool), EncoderError> {
    let json = ffprobe_json(
        executor,
        ffprobe,
        path,
        SOURCE_PROBE_TIMEOUT,
        "source probe timed out",
    )
    .await?;
    let streams = streams_of(&json)?;
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
    Ok((width, height, has_audio))
}

async fn encoded_codecs<E: Execute>(
    executor: &mut E,
    path: &Path,
    ffprobe: &Path,
) -> Result<String, EncoderError> {
    let json = ffprobe_json(
        executor,
        ffprobe,
        path,
        ENCODED_PROBE_TIMEOUT,
        "encoded stream probe timed out",
    )
    .await?;
    rfc6381_codecs(streams_of(&json)?)
}

fn stream_u8(stream: &Value, field: &str) -> Result<u8, EncoderError> {
    let value = stream
        .get(field)
        .ok_or_else(|| EncoderError::Media(format!("{field} missing")))?;
    let number = value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| EncoderError::Media(format!("{field} missing")))?;
    u8::try_from(number).map_err(|_| EncoderError::Media(format!("{field} missing")))
}

fn h264_avc1(stream: &Value) -> Result<String, EncoderError> {
    let profile = stream
        .get("profile")
        .and_then(Value::as_str)
        .ok_or(EncoderError::Media("H.264 profile missing".into()))?;
    let level = stream_u8(stream, "level")?;
    let (profile_idc, constraints) = match profile {
        "Baseline" => (0x42, 0x00),
        "Constrained Baseline" => (0x42, 0x40),
        "Main" => (0x4d, 0x00),
        "Extended" => (0x58, 0x00),
        "High" => (0x64, 0x00),
        "Constrained High" => (0x64, 0x0c),
        "High 10" => (0x6e, 0x00),
        "High 4:2:2" => (0x7a, 0x00),
        "High 4:4:4" | "High 4:4:4 Predictive" => (0xf4, 0x00),
        _ => {
            return Err(EncoderError::Media(format!(
                "unsupported H.264 profile: {profile}"
            )));
        }
    };
    Ok(format!(
        "avc1.{profile_idc:02x}{constraints:02x}{level:02x}"
    ))
}

fn aac_mp4a(stream: &Value) -> Result<String, EncoderError> {
    let profile = stream
        .get("profile")
        .and_then(Value::as_str)
        .unwrap_or("LC");
    let object_type = match profile {
        "Main" => 1,
        "LC" => 2,
        "SSR" => 3,
        "LTP" => 4,
        "HE-AAC" | "HE AAC" => 5,
        "HE-AACv2" | "HE AAC v2" => 29,
        _ => {
            return Err(EncoderError::Media(format!(
                "unsupported AAC profile: {profile}"
            )));
        }
    };
    Ok(format!("mp4a.40.{object_type}"))
}

fn rfc6381_codecs(streams: &[Value]) -> Result<String, EncoderError> {
    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or(EncoderError::Media("encoded output has no video".into()))?;
    let video_codec = match video.get("codec_name").and_then(Value::as_str) {
        Some("h264") => h264_avc1(video)?,
        Some(other) => {
            return Err(EncoderError::Media(format!(
                "unsupported encoded video codec: {other}"
            )));
        }
        None => return Err(EncoderError::Media("encoded video codec missing".into())),
    };
    let Some(audio) = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"))
    else {
        return Ok(video_codec);
    };
    let audio_codec = match audio.get("codec_name").and_then(Value::as_str) {
        Some("aac") => aac_mp4a(audio)?,
        Some(other) => {
            return Err(EncoderError::Media(format!(
                "unsupported encoded audio codec: {other}"
            )));
        }
        None => return Err(EncoderError::Media("encoded audio codec missing".into())),
    };
    Ok(format!("{video_codec},{audio_codec}"))
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
    let limits = encoding::limits::Limits::default();
    let source_bytes = limits.source_bytes;
    encode_child_with(
        storage,
        &mut ProcessExecutor,
        &mut BoundedExecutor { limits },
        source_bytes,
        input_bucket,
        output_bucket,
        payload,
        ffmpeg,
        ffprobe,
        temp_root,
    )
    .await
}

async fn encode_child_with<S, P, E>(
    storage: &mut S,
    probe_executor: &mut P,
    encode_executor: &mut E,
    source_bytes: u64,
    input_bucket: &str,
    output_bucket: &str,
    payload: ChildPayload,
    ffmpeg: &Path,
    ffprobe: &Path,
    temp_root: &Path,
) -> Result<(), EncoderError>
where
    S: Read + Write + Send,
    P: Execute,
    E: Execute,
{
    validate_payload(&payload)?;
    let directory = JobDirectory::create(temp_root, &payload.job_id)
        .map_err(|e| EncoderError::Input(e.to_string()))?;
    let source = directory.path().join("source.mp4");
    let bytes = storage
        .read_bounded(input_bucket, &payload.source_key, source_bytes)
        .await
        .map_err(|e| EncoderError::Storage(e.0))?;
    tokio::fs::write(&source, &bytes)
        .await
        .map_err(|e| EncoderError::Input(e.to_string()))?;
    let (source_width, source_height, has_audio) = probe(probe_executor, &source, ffprobe).await?;
    let (max_width, max_height) = ceiling(&payload.rendition);
    let (width, height) = scaled_dimensions(source_width, source_height, max_width, max_height);
    let playlist_path = directory.path().join("index.m3u8");
    let segment_pattern = directory.path().join("segment-%05d.ts");
    let mut argv = vec![
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
    ];
    if has_audio {
        argv.extend(["-c:a".into(), "aac".into()]);
    } else {
        argv.push("-an".into());
    }
    argv.extend([
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
    ]);
    let process = encode_executor
        .execute(encoding::Command::new(ffmpeg, argv))
        .await
        .map_err(|e| EncoderError::Media(e.0))?;
    if process.status != 0 {
        return Err(EncoderError::Media("FFmpeg failed".into()));
    }
    let output = encoding::validate_hls_output(directory.path())
        .map_err(|e| EncoderError::Media(e.to_string()))?;
    let codecs = encoded_codecs(
        probe_executor,
        output
            .segments
            .first()
            .ok_or(EncoderError::Media("encoded output has no video".into()))?,
        ffprobe,
    )
    .await?;
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
            .write_with_cache_control(
                output_bucket,
                &key,
                SEGMENT_TYPE,
                "public,max-age=31536000,immutable",
                &contents,
            )
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
        .write_with_cache_control(
            output_bucket,
            &playlist_key,
            PLAYLIST_TYPE,
            "public,max-age=31536000,immutable",
            &playlist,
        )
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
        codecs,
    };
    let result_bytes =
        serde_json::to_vec(&result).map_err(|e| EncoderError::Json(e.to_string()))?;
    storage
        .write_with_cache_control(
            output_bucket,
            &format!("{}/result.json", result.payload.output_prefix),
            "application/json",
            "public,max-age=31536000,immutable",
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
            (seconds.is_finite() && seconds > 0.0)
                .then(|| {
                    std::fs::metadata(path)
                        .ok()
                        .map(|metadata| ((metadata.len() as f64 * 8.0) / seconds).ceil() as u64)
                })
                .flatten()
        })
        .max()
        .unwrap_or(1)
        .max(1)
}

async fn shutdown_requested() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}

async fn run_until_shutdown<F, S>(work: F, shutdown: S) -> Result<(), EncoderError>
where
    F: Future<Output = Result<(), EncoderError>>,
    S: Future<Output = Result<(), std::io::Error>>,
{
    tokio::pin!(work);
    tokio::select! {
        biased;
        result = &mut work => result,
        signal = shutdown => {
            signal.map_err(|e| EncoderError::Input(e.to_string()))?;
            Err(EncoderError::Media("child encode terminated".into()))
        }
    }
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
    run_until_shutdown(
        async {
            tokio::time::timeout(
                CHILD_ENCODE_TIMEOUT,
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
            .map_err(|_| EncoderError::Media("child encode timed out".into()))?
        },
        shutdown_requested(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fakes::{CallLog, FakeStorage};
    use encoding::{Command, HlsOutput, Output, ProcessError};
    use serde_json::json;
    use std::{
        collections::VecDeque,
        future,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";

    fn payload(rendition: &str, attempt: u32) -> ChildPayload {
        let execution_id = format!("job-{JOB_ID}-a{attempt}");
        ChildPayload {
            video_id: VIDEO_ID.into(),
            job_id: JOB_ID.into(),
            attempt,
            execution_id: execution_id.clone(),
            rendition: rendition.into(),
            source_key: format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/source.mp4"),
            output_prefix: format!(
                "videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/attempts/{attempt}/{execution_id}/{rendition}"
            ),
        }
    }

    fn source_streams(width: u32, height: u32, audio: bool) -> Value {
        let mut streams = vec![json!({
            "codec_type": "video",
            "codec_name": "h264",
            "width": width,
            "height": height,
        })];
        if audio {
            streams.push(json!({
                "codec_type": "audio",
                "codec_name": "aac",
                "profile": "LC",
            }));
        }
        json!({ "streams": streams })
    }

    fn encoded_streams(audio: bool, profile: &str, level: u64) -> Value {
        let mut streams = vec![json!({
            "codec_type": "video",
            "codec_name": "h264",
            "profile": profile,
            "level": level,
        })];
        if audio {
            streams.push(json!({
                "codec_type": "audio",
                "codec_name": "aac",
                "profile": "LC",
            }));
        }
        json!({ "streams": streams })
    }

    fn probe_output(json: &Value) -> Output {
        Output {
            status: 0,
            stdout: serde_json::to_vec(json).unwrap(),
            stderr: Vec::new(),
        }
    }

    struct FakeProbe {
        responses: VecDeque<Result<Output, ProcessError>>,
        hang: bool,
        commands: Vec<Command>,
    }

    impl FakeProbe {
        fn responses(items: impl IntoIterator<Item = Result<Output, ProcessError>>) -> Self {
            Self {
                responses: items.into_iter().collect(),
                hang: false,
                commands: Vec::new(),
            }
        }

        fn succeeding(source: Value, encoded: Value) -> Self {
            Self::responses([Ok(probe_output(&source)), Ok(probe_output(&encoded))])
        }

        fn hanging() -> Self {
            Self {
                responses: VecDeque::new(),
                hang: true,
                commands: Vec::new(),
            }
        }
    }

    impl Execute for FakeProbe {
        async fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
            self.commands.push(command);
            if self.hang {
                future::pending().await
            }
            self.responses
                .pop_front()
                .unwrap_or_else(|| Err(ProcessError("unexpected probe".into())))
        }
    }

    struct FakeEncode {
        hang: bool,
        error: Option<String>,
        status: i32,
        write_hls: bool,
        playlist: String,
        segments: Vec<Vec<u8>>,
        commands: Vec<Command>,
    }

    impl FakeEncode {
        fn succeeding() -> Self {
            Self {
                hang: false,
                error: None,
                status: 0,
                write_hls: true,
                playlist: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-00000.ts\n#EXT-X-ENDLIST\n".into(),
                segments: vec![b"segment-bytes".to_vec()],
                commands: Vec::new(),
            }
        }

        fn failing(message: impl Into<String>) -> Self {
            Self {
                hang: false,
                error: Some(message.into()),
                status: 0,
                write_hls: false,
                playlist: String::new(),
                segments: Vec::new(),
                commands: Vec::new(),
            }
        }

        fn hanging() -> Self {
            Self {
                hang: true,
                error: None,
                status: 0,
                write_hls: false,
                playlist: String::new(),
                segments: Vec::new(),
                commands: Vec::new(),
            }
        }
    }

    impl Execute for FakeEncode {
        async fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
            self.commands.push(command.clone());
            if self.hang {
                future::pending().await
            }
            if let Some(error) = self.error.clone() {
                return Err(ProcessError(error));
            }
            if self.write_hls {
                let playlist = Path::new(command.argv.last().expect("playlist path"));
                let directory = playlist.parent().expect("playlist directory");
                std::fs::write(playlist, &self.playlist).unwrap();
                for (index, contents) in self.segments.iter().enumerate() {
                    std::fs::write(directory.join(format!("segment-{index:05}.ts")), contents)
                        .unwrap();
                }
            }
            Ok(Output {
                status: self.status,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }

    async fn run_encode(
        storage: &mut FakeStorage,
        probe: &mut FakeProbe,
        encode: &mut FakeEncode,
        payload: ChildPayload,
        source_bytes: u64,
    ) -> Result<(), EncoderError> {
        let temp = tempfile::tempdir().unwrap();
        encode_child_with(
            storage,
            probe,
            encode,
            source_bytes,
            "in",
            "out",
            payload,
            Path::new("ffmpeg"),
            Path::new("ffprobe"),
            temp.path(),
        )
        .await
    }

    fn storage_with(payload: &ChildPayload, source: &[u8]) -> FakeStorage {
        let mut storage = FakeStorage::new(CallLog::default());
        storage.add_read("in", &payload.source_key, source.to_vec());
        storage
    }

    fn result_keys(storage: &FakeStorage) -> Vec<String> {
        storage
            .writes
            .iter()
            .filter(|(_, key, _)| key.ends_with("/result.json"))
            .map(|(_, key, _)| key.clone())
            .collect()
    }

    fn output_keys(storage: &FakeStorage) -> Vec<String> {
        storage
            .writes
            .iter()
            .map(|(_, key, _)| key.clone())
            .collect()
    }

    #[test]
    fn rejects_malformed_payload_json() {
        for text in [
            "",
            "{",
            "null",
            "[]",
            "{}",
            r#"{"video_id":1}"#,
            &{
                let mut value = serde_json::to_value(payload("360p", 1)).unwrap();
                value
                    .as_object_mut()
                    .unwrap()
                    .insert("receipt_handle".into(), json!("steal"));
                value.to_string()
            },
            &{
                let mut value = serde_json::to_value(payload("360p", 1)).unwrap();
                value.as_object_mut().unwrap().remove("rendition");
                value.to_string()
            },
        ] {
            assert!(
                serde_json::from_str::<ChildPayload>(text).is_err(),
                "{text}"
            );
        }
    }

    #[test]
    fn rejects_unsupported_rendition_before_any_io() {
        for rendition in ["1080p", "360P", "480p", "", "360p "] {
            let mut child = payload("360p", 1);
            child.rendition = rendition.into();
            child.output_prefix = format!(
                "videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/attempts/1/{}/{}",
                child.execution_id, rendition
            );
            match validate_payload(&child) {
                Err(EncoderError::InvalidPayload("unsupported rendition")) => {}
                other => panic!("{rendition:?} -> {other:?}"),
            }
        }
        validate_payload(&payload("360p", 1)).unwrap();
        validate_payload(&payload("720p", 1)).unwrap();
    }

    #[test]
    fn rejects_attempt_execution_and_output_prefix_mismatch() {
        let mut child = payload("360p", 1);
        child.attempt = 0;
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("execution identity mismatch"))
        ));

        child = payload("360p", 2);
        child.execution_id = format!("job-{JOB_ID}-a1");
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("execution identity mismatch"))
        ));

        child = payload("360p", 1);
        child.output_prefix = payload("720p", 1).output_prefix;
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("output prefix mismatch"))
        ));

        child = payload("360p", 1);
        child.output_prefix = payload("360p", 2).output_prefix;
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("output prefix mismatch"))
        ));
    }

    #[test]
    fn rejects_path_traversal_and_identity_boundary_escapes() {
        let mut child = payload("360p", 1);
        child.video_id = "018F47A2-45C2-7A84-B84F-5F6DD7B5910A".into();
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("ids must be lowercase UUIDs"))
        ));

        child = payload("360p", 1);
        child.source_key = format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/../source.mp4");
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("source key mismatch"))
        ));

        child = payload("360p", 1);
        child.source_key = format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/source.mp4/../../etc/passwd");
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("source key mismatch"))
        ));

        child = payload("360p", 1);
        child.output_prefix = format!(
            "videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/attempts/1/{}/360p/../720p",
            child.execution_id
        );
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("output prefix mismatch"))
        ));

        child = payload("360p", 1);
        child.output_prefix =
            format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/attempts/1/../../../other");
        assert!(matches!(
            validate_payload(&child),
            Err(EncoderError::InvalidPayload("output prefix mismatch"))
        ));
    }

    #[test]
    fn rfc6381_codecs_come_from_encoded_stream_profile_and_level() {
        assert_eq!(
            rfc6381_codecs(
                encoded_streams(true, "High", 31)["streams"]
                    .as_array()
                    .unwrap()
            )
            .unwrap(),
            "avc1.64001f,mp4a.40.2"
        );
        assert_eq!(
            rfc6381_codecs(
                encoded_streams(false, "Main", 40)["streams"]
                    .as_array()
                    .unwrap()
            )
            .unwrap(),
            "avc1.4d0028"
        );
        assert_eq!(
            rfc6381_codecs(
                encoded_streams(false, "Constrained Baseline", 30)["streams"]
                    .as_array()
                    .unwrap()
            )
            .unwrap(),
            "avc1.42401e"
        );
        assert!(
            rfc6381_codecs(&[json!({
                "codec_type": "video",
                "codec_name": "hevc",
                "profile": "Main",
                "level": 93
            })])
            .is_err()
        );
    }

    #[test]
    fn peak_bandwidth_uses_actual_seconds_not_ceiled_duration() {
        let directory = tempfile::tempdir().unwrap();
        let short = directory.path().join("segment-00000.ts");
        let long = directory.path().join("segment-00001.ts");
        std::fs::write(&short, vec![0u8; 100]).unwrap();
        std::fs::write(&long, vec![0u8; 1000]).unwrap();
        let playlist = b"#EXTM3U\n#EXTINF:1.5,\nsegment-00000.ts\n#EXTINF:0.5,\nsegment-00001.ts\n";
        let output = HlsOutput {
            playlist: directory.path().join("index.m3u8"),
            segments: vec![short, long],
        };
        // 100 bytes / 1.5s = 533.3... -> 534; 1000 bytes / 0.5s = 16000.
        // Ceil(duration) would have yielded 1000*8/1 = 8000 for the short segment.
        assert_eq!(peak_bandwidth(playlist, &output), 16000);
        assert_eq!(((100u64 as f64 * 8.0) / 1.5).ceil() as u64, 534);
        assert!(1000u64.saturating_mul(8) / 1 < 16000);
    }

    #[tokio::test]
    async fn source_probe_has_an_individual_timeout() {
        let err = ffprobe_json(
            &mut FakeProbe::hanging(),
            Path::new("ffprobe"),
            Path::new("source.mp4"),
            Duration::from_millis(20),
            "source probe timed out",
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("source probe timed out"), "{err}");
    }

    #[tokio::test]
    async fn invalid_payload_does_not_read_or_write() {
        let mut storage = FakeStorage::new(CallLog::default());
        let mut child = payload("360p", 1);
        child.rendition = "1080p".into();
        let err = run_encode(
            &mut storage,
            &mut FakeProbe::hanging(),
            &mut FakeEncode::hanging(),
            child,
            64,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            err,
            EncoderError::InvalidPayload("unsupported rendition")
        ));
        assert!(storage.reads.is_empty());
        assert!(output_keys(&storage).is_empty());
    }

    #[tokio::test]
    async fn missing_audio_is_encoded_without_aac_and_without_audio_codec() {
        let child = payload("360p", 1);
        let mut storage = storage_with(&child, b"source");
        let mut probe = FakeProbe::succeeding(
            source_streams(640, 360, false),
            encoded_streams(false, "High", 30),
        );
        let mut encode = FakeEncode::succeeding();
        run_encode(&mut storage, &mut probe, &mut encode, child.clone(), 64)
            .await
            .unwrap();
        assert!(
            encode.commands[0].argv.contains(&"-an".into()),
            "{:?}",
            encode.commands[0].argv
        );
        assert!(!encode.commands[0].argv.contains(&"-c:a".into()));
        let result = storage
            .writes
            .iter()
            .find(|(_, key, _)| key == &format!("{}/result.json", child.output_prefix))
            .map(|(_, _, body)| serde_json::from_slice::<Value>(body).unwrap())
            .unwrap();
        assert_eq!(result["codecs"], "avc1.64001e");
        assert!(!result["codecs"].as_str().unwrap().contains("mp4a"));
    }

    #[tokio::test]
    async fn invalid_media_does_not_write_result_json() {
        let child = payload("360p", 1);
        let mut storage = storage_with(&child, b"not a video");
        let mut probe = FakeProbe::responses([Ok(Output {
            status: 1,
            stdout: Vec::new(),
            stderr: b"invalid".to_vec(),
        })]);
        let err = run_encode(
            &mut storage,
            &mut probe,
            &mut FakeEncode::succeeding(),
            child.clone(),
            64,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("corrupt or unreadable"), "{err}");
        assert!(probe.commands.iter().any(|command| {
            command
                .argv
                .last()
                .is_some_and(|path| path.ends_with("source.mp4"))
        }));
        assert!(result_keys(&storage).is_empty());
        assert!(
            output_keys(&storage)
                .iter()
                .all(|key| !key.contains("/hls/"))
        );
    }

    #[tokio::test]
    async fn disk_exhaustion_does_not_write_result_json() {
        let child = payload("720p", 1);
        let mut storage = storage_with(&child, b"source");
        let mut probe = FakeProbe::succeeding(
            source_streams(1280, 720, true),
            encoded_streams(true, "High", 31),
        );
        let err = run_encode(
            &mut storage,
            &mut probe,
            &mut FakeEncode::failing("temporary disk limit exceeded"),
            child,
            64,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("temporary disk limit exceeded"));
        assert!(result_keys(&storage).is_empty());
        assert!(output_keys(&storage).is_empty());
    }

    #[tokio::test]
    async fn ffmpeg_failure_does_not_write_result_json() {
        let child = payload("360p", 1);
        let mut storage = storage_with(&child, b"source");
        let mut probe = FakeProbe::succeeding(
            source_streams(640, 360, true),
            encoded_streams(true, "High", 31),
        );
        let mut encode = FakeEncode::succeeding();
        encode.status = 1;
        encode.write_hls = false;
        run_encode(&mut storage, &mut probe, &mut encode, child, 64)
            .await
            .unwrap_err();
        assert!(result_keys(&storage).is_empty());
        assert!(output_keys(&storage).is_empty());
    }

    #[tokio::test]
    async fn writes_are_isolated_across_attempt_execution_and_rendition() {
        let mut storage = FakeStorage::new(CallLog::default());
        let cases = [("360p", 1u32), ("720p", 1u32), ("360p", 2u32)];
        for (rendition, attempt) in cases {
            let child = payload(rendition, attempt);
            storage.add_read("in", &child.source_key, b"source".to_vec());
            let mut probe = FakeProbe::succeeding(
                source_streams(1280, 720, true),
                encoded_streams(true, "High", 31),
            );
            run_encode(
                &mut storage,
                &mut probe,
                &mut FakeEncode::succeeding(),
                child,
                64,
            )
            .await
            .unwrap();
        }
        let prefixes: Vec<String> = cases
            .into_iter()
            .map(|(rendition, attempt)| payload(rendition, attempt).output_prefix)
            .collect();
        assert_eq!(prefixes.len(), 3);
        assert_eq!(
            prefixes
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
        for key in output_keys(&storage) {
            let owners = prefixes
                .iter()
                .filter(|prefix| key.starts_with(&format!("{prefix}/")))
                .count();
            assert_eq!(owners, 1, "{key} owned by {owners} prefixes");
        }
        for prefix in &prefixes {
            assert!(
                storage
                    .writes
                    .iter()
                    .any(|(_, key, _)| key == &format!("{prefix}/result.json"))
            );
            assert!(
                storage
                    .writes
                    .iter()
                    .any(|(_, key, _)| key == &format!("{prefix}/index.m3u8"))
            );
        }
    }

    #[tokio::test]
    async fn success_writes_probed_codecs_not_a_fixed_profile_string() {
        let child = payload("720p", 1);
        let mut storage = storage_with(&child, b"source");
        let mut probe = FakeProbe::succeeding(
            source_streams(1920, 1080, true),
            encoded_streams(true, "Main", 31),
        );
        run_encode(
            &mut storage,
            &mut probe,
            &mut FakeEncode::succeeding(),
            child.clone(),
            64,
        )
        .await
        .unwrap();
        let result = storage
            .writes
            .iter()
            .find(|(_, key, _)| key.ends_with("/result.json"))
            .map(|(_, _, body)| serde_json::from_slice::<Value>(body).unwrap())
            .unwrap();
        assert_eq!(result["codecs"], "avc1.4d001f,mp4a.40.2");
        assert_ne!(result["codecs"], "avc1.64001f,mp4a.40.2");
        assert_eq!(result["width"], 1280);
        assert_eq!(result["height"], 720);
        assert_eq!(result["output_prefix"], child.output_prefix);
    }

    #[tokio::test]
    async fn shutdown_drops_encode_future_without_result_json() {
        let dropped = Arc::new(AtomicBool::new(false));
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let child = payload("360p", 1);
        let mut storage = storage_with(&child, b"source");
        let work = {
            let dropped = dropped.clone();
            async move {
                let _guard = Guard(dropped);
                let mut probe = FakeProbe::succeeding(
                    source_streams(640, 360, true),
                    encoded_streams(true, "High", 31),
                );
                run_encode(
                    &mut storage,
                    &mut probe,
                    &mut FakeEncode::hanging(),
                    child,
                    64,
                )
                .await
            }
        };
        let err = run_until_shutdown(work, async { Ok(()) })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("terminated"), "{err}");
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "subprocess helper invoked by sigterm_stops_ffmpeg_without_result_json"]
    async fn encode_child_signal_helper() {
        let Some(marker) = std::env::args().skip_while(|arg| arg != "--skip").nth(1) else {
            return;
        };
        let output = marker.to_string() + "-ffmpeg";
        let result = run_until_shutdown(
            async {
                ProcessExecutor
                    .execute(Command::new(
                        "/usr/bin/ffmpeg",
                        vec![
                            "-v".into(),
                            "error".into(),
                            "-re".into(),
                            "-f".into(),
                            "lavfi".into(),
                            "-i".into(),
                            "color=size=64x64:rate=10".into(),
                            "-t".into(),
                            "30".into(),
                            "-f".into(),
                            "null".into(),
                            output,
                        ],
                    ))
                    .await
                    .map_err(|error| EncoderError::Media(error.0))?;
                std::fs::write(&marker, b"result")
                    .map_err(|error| EncoderError::Input(error.to_string()))?;
                Ok(())
            },
            shutdown_requested(),
        )
        .await;
        result.expect_err("unterminated encode must not succeed");
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires FFmpeg and /proc; run tests/run-local.sh"]
    async fn sigterm_stops_ffmpeg_without_result_json() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("result-marker");
        let needle = format!("{}-ffmpeg", marker.display());
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "encoder::tests::encode_child_signal_helper",
                "--skip",
                marker.to_string_lossy().as_ref(),
            ])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                for entry in std::fs::read_dir("/proc").unwrap().filter_map(Result::ok) {
                    if let Ok(cmd) = std::fs::read(entry.path().join("cmdline")) {
                        let cmd = String::from_utf8_lossy(&cmd);
                        if cmd.starts_with("/usr/bin/ffmpeg\0") && cmd.contains(&needle) {
                            return entry.file_name().to_string_lossy().parse::<u32>().unwrap();
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("encoder helper did not start FFmpeg");
        assert!(
            std::process::Command::new("/bin/kill")
                .args(["-TERM", &child.id().unwrap().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let status = tokio::time::timeout(Duration::from_secs(6), child.wait())
            .await
            .expect("helper did not exit after SIGTERM")
            .unwrap();
        assert!(status.success(), "{status:?}");
        tokio::time::timeout(Duration::from_secs(3), async {
            while Path::new(&format!("/proc/{pid}")).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("SIGTERM must terminate FFmpeg");
        assert!(!marker.exists(), "failure must not create a success marker");
    }

    #[test]
    fn encode_child_wires_signal_select_probed_codecs_and_probe_timeout() {
        let source = include_str!("encoder.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source");
        assert!(source.contains("run_until_shutdown"));
        assert!(source.contains("shutdown_requested"));
        assert!(source.contains("tokio::signal"));
        assert!(source.contains("metadata.len() as f64 * 8.0"));
        assert!(source.contains("SOURCE_PROBE_TIMEOUT"));
        assert!(source.contains("rfc6381_codecs"));
        assert!(!source.contains("avc1.64001f"));
        assert!(!source.contains("seconds.ceil()"));
    }
}
