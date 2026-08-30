//! Publication of a validated HLS rendition to the canonical output prefix.

use std::{fmt, io};

use encoding::HlsOutput;
use storage::{ObjectError, Write};

pub const HLS_PLAYLIST_CONTENT_TYPE: &str = "application/vnd.apple.mpegurl";
pub const HLS_SEGMENT_CONTENT_TYPE: &str = "video/mp2t";

#[derive(Debug)]
pub enum PublishError {
    Filesystem(io::Error),
    Storage(ObjectError),
    InvalidSegmentPath,
}

impl fmt::Display for PublishError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Filesystem(error) => write!(formatter, "read HLS output: {error}"),
            Self::Storage(error) => write!(formatter, "publish HLS object: {}", error.0),
            Self::InvalidSegmentPath => {
                formatter.write_str("validated HLS segment has no filename")
            }
        }
    }
}

impl std::error::Error for PublishError {}

impl From<io::Error> for PublishError {
    fn from(error: io::Error) -> Self {
        Self::Filesystem(error)
    }
}

impl From<ObjectError> for PublishError {
    fn from(error: ObjectError) -> Self {
        Self::Storage(error)
    }
}

/// Upload every playlist-referenced segment, in playlist order, before making
/// the manifest visible. The supplied output must come from HLS validation.
pub async fn publish_hls<W: Write>(
    storage: &mut W,
    output_bucket: &str,
    video_id: &str,
    job_id: &str,
    output: &HlsOutput,
) -> Result<(), PublishError> {
    let prefix = format!("videos/{video_id}/jobs/{job_id}/hls");

    for segment in &output.segments {
        let filename = segment
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(PublishError::InvalidSegmentPath)?;
        let contents = tokio::fs::read(segment).await?;
        storage
            .write(
                output_bucket,
                &format!("{prefix}/{filename}"),
                HLS_SEGMENT_CONTENT_TYPE,
                &contents,
            )
            .await?;
    }

    let playlist = tokio::fs::read(&output.playlist).await?;
    storage
        .write(
            output_bucket,
            &format!("{prefix}/index.m3u8"),
            HLS_PLAYLIST_CONTENT_TYPE,
            &playlist,
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fakes::{Call, CallLog, FakeStorage};
    use std::fs;

    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";

    fn output() -> (tempfile::TempDir, HlsOutput) {
        let directory = tempfile::tempdir().unwrap();
        let playlist = directory.path().join("index.m3u8");
        let segment_zero = directory.path().join("segment-00000.ts");
        let segment_one = directory.path().join("segment-00001.ts");
        fs::write(&playlist, b"#EXTM3U\nsegment-00000.ts\nsegment-00001.ts\n").unwrap();
        fs::write(&segment_zero, b"zero").unwrap();
        fs::write(&segment_one, b"one").unwrap();
        (
            directory,
            HlsOutput {
                playlist,
                segments: vec![segment_zero, segment_one],
            },
        )
    }

    #[tokio::test]
    async fn publishes_referenced_segments_then_manifest_with_canonical_metadata() {
        let (_directory, output) = output();
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());

        publish_hls(&mut storage, "video-output", VIDEO_ID, JOB_ID, &output)
            .await
            .unwrap();

        let writes: Vec<_> = log
            .calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Write {
                    key,
                    content_type,
                    contents,
                    ..
                } => Some((key, content_type, contents)),
                _ => None,
            })
            .collect();
        let prefix = format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/hls");
        assert_eq!(
            writes,
            [
                (
                    format!("{prefix}/segment-00000.ts"),
                    HLS_SEGMENT_CONTENT_TYPE.into(),
                    b"zero".to_vec()
                ),
                (
                    format!("{prefix}/segment-00001.ts"),
                    HLS_SEGMENT_CONTENT_TYPE.into(),
                    b"one".to_vec()
                ),
                (
                    format!("{prefix}/index.m3u8"),
                    HLS_PLAYLIST_CONTENT_TYPE.into(),
                    b"#EXTM3U\nsegment-00000.ts\nsegment-00001.ts\n".to_vec()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn segment_failure_prevents_manifest_publication() {
        let (_directory, output) = output();
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        storage.fail_write("segment upload failed");

        assert!(
            publish_hls(&mut storage, "video-output", VIDEO_ID, JOB_ID, &output)
                .await
                .is_err()
        );

        let writes: Vec<_> = log
            .calls()
            .into_iter()
            .filter(|call| matches!(call, Call::Write { .. }))
            .collect();
        assert_eq!(writes.len(), 1);
        assert!(
            matches!(&writes[0], Call::Write { key, .. } if key.ends_with("segment-00000.ts")),
            "{writes:?}"
        );
        assert!(
            !writes
                .iter()
                .any(|call| matches!(call, Call::Write { key, .. } if key.ends_with("index.m3u8")))
        );
    }

    #[tokio::test]
    async fn later_segment_failure_prevents_manifest_publication() {
        let (_directory, output) = output();
        let log = CallLog::default();
        let mut storage = FakeStorage::new(log.clone());
        storage.fail_write_after(1, "second segment upload failed");

        assert!(
            publish_hls(&mut storage, "video-output", VIDEO_ID, JOB_ID, &output)
                .await
                .is_err()
        );
        let keys: Vec<_> = storage
            .writes
            .iter()
            .map(|(_, key, _)| key.clone())
            .collect();
        assert_eq!(
            keys,
            [format!(
                "videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/segment-00000.ts"
            )]
        );
        assert!(
            log.calls().iter().all(
                |call| !matches!(call, Call::Write { key, .. } if key.ends_with("index.m3u8"))
            )
        );
    }

    #[tokio::test]
    async fn manifest_write_failure_does_not_publish_the_playlist() {
        let (_directory, output) = output();
        let mut storage = FakeStorage::new(CallLog::default());
        storage.fail_write_after(2, "manifest upload failed");

        assert!(
            publish_hls(&mut storage, "video-output", VIDEO_ID, JOB_ID, &output)
                .await
                .is_err()
        );
        let keys: Vec<_> = storage
            .writes
            .iter()
            .map(|(_, key, _)| key.clone())
            .collect();
        assert_eq!(
            keys,
            [
                format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/segment-00000.ts"),
                format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/hls/segment-00001.ts"),
            ]
        );
    }
}
