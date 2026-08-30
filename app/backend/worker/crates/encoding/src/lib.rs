//! Process execution port.  An executable and argv are kept as separate
//! values so no shell command needs to be constructed.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub executable: PathBuf,
    pub argv: Vec<String>,
}

impl Command {
    pub fn new(executable: impl Into<PathBuf>, argv: Vec<String>) -> Self {
        Self {
            executable: executable.into(),
            argv,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessError(pub String);

pub trait Execute {
    fn execute(
        &mut self,
        command: Command,
    ) -> impl std::future::Future<Output = Result<Output, ProcessError>> + Send;
}

/// The files produced by one HLS encode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HlsOutput {
    pub playlist: PathBuf,
    pub segments: Vec<PathBuf>,
}

#[derive(Debug)]
pub enum HlsError {
    Process(ProcessError),
    Failed(i32),
    Filesystem(io::Error),
    InvalidPlaylist(String),
}

impl std::fmt::Display for HlsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Process(error) => write!(formatter, "run ffmpeg: {}", error.0),
            Self::Failed(status) => write!(formatter, "ffmpeg exited with status {status}"),
            Self::Filesystem(error) => write!(formatter, "HLS output: {error}"),
            Self::InvalidPlaylist(reason) => write!(formatter, "invalid HLS playlist: {reason}"),
        }
    }
}

impl std::error::Error for HlsError {}

impl From<ProcessError> for HlsError {
    fn from(error: ProcessError) -> Self {
        Self::Process(error)
    }
}

impl From<io::Error> for HlsError {
    fn from(error: io::Error) -> Self {
        Self::Filesystem(error)
    }
}

/// Run ffmpeg with the worker's fixed HLS output layout and verify the result.
pub async fn encode_hls<E: Execute>(
    executor: &mut E,
    ffmpeg_path: impl Into<PathBuf>,
    work_directory: impl AsRef<Path>,
) -> Result<HlsOutput, HlsError> {
    let work_directory = work_directory.as_ref();
    let source = work_directory.join("source.mp4");
    let playlist = work_directory.join("index.m3u8");
    let segments = work_directory.join("segment-%05d.ts");
    let command = Command::new(
        ffmpeg_path,
        vec![
            "-y".into(),
            "-i".into(),
            source.to_string_lossy().into_owned(),
            "-c:v".into(),
            "libx264".into(),
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
            segments.to_string_lossy().into_owned(),
            playlist.to_string_lossy().into_owned(),
        ],
    );

    let output = executor.execute(command).await?;
    if output.status != 0 {
        return Err(HlsError::Failed(output.status));
    }
    let validation_directory = work_directory.to_owned();
    tokio::task::spawn_blocking(move || validate_hls_output(validation_directory))
        .await
        .map_err(|error| {
            HlsError::Process(ProcessError(format!("validate HLS task failed: {error}")))
        })?
}

/// Validate an ffmpeg HLS result without trusting paths supplied by the playlist.
pub fn validate_hls_output(work_directory: impl AsRef<Path>) -> Result<HlsOutput, HlsError> {
    let work_directory = work_directory.as_ref();
    let playlist = work_directory.join("index.m3u8");
    let root = fs::canonicalize(work_directory)?;
    let playlist_text = fs::read_to_string(&playlist)?;
    let mut lines = playlist_text.lines();
    if lines.next().map(str::trim) != Some("#EXTM3U") {
        return Err(HlsError::InvalidPlaylist(
            "playlist must start with #EXTM3U".into(),
        ));
    }
    let mut segments = Vec::new();
    let mut expected_segment = 0_u32;

    for raw_line in lines {
        let reference = raw_line.trim();
        if reference.is_empty() {
            continue;
        }
        if reference.starts_with('#') {
            if tag_has_uri_attribute(reference) {
                return Err(HlsError::InvalidPlaylist(format!(
                    "unsupported URI-bearing tag: {reference:?}"
                )));
            }
            continue;
        }
        let path = Path::new(reference);
        if path.is_absolute()
            || reference.starts_with("//")
            || reference.contains("://")
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(HlsError::InvalidPlaylist(format!(
                "media reference is not a safe relative path: {reference:?}"
            )));
        }
        if !is_segment_filename(reference) {
            return Err(HlsError::InvalidPlaylist(format!(
                "unexpected media filename: {reference:?}"
            )));
        }
        let expected_reference = format!("segment-{expected_segment:05}.ts");
        if reference != expected_reference {
            return Err(HlsError::InvalidPlaylist(format!(
                "expected media segment {expected_reference:?}"
            )));
        }
        expected_segment += 1;

        let file = fs::canonicalize(work_directory.join(path)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                HlsError::InvalidPlaylist(format!("referenced segment is missing: {reference:?}"))
            } else {
                HlsError::Filesystem(error)
            }
        })?;
        if !file.starts_with(&root) {
            return Err(HlsError::InvalidPlaylist(format!(
                "media reference escapes work directory: {reference:?}"
            )));
        }
        if !file.is_file() {
            return Err(HlsError::InvalidPlaylist(format!(
                "media reference is not a file: {reference:?}"
            )));
        }
        segments.push(file);
    }

    if segments.is_empty() {
        return Err(HlsError::InvalidPlaylist(
            "playlist contains no media segments".into(),
        ));
    }
    Ok(HlsOutput { playlist, segments })
}

fn is_segment_filename(reference: &str) -> bool {
    let Some(number) = reference
        .strip_prefix("segment-")
        .and_then(|value| value.strip_suffix(".ts"))
    else {
        return false;
    };
    number.len() == 5 && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn tag_has_uri_attribute(tag: &str) -> bool {
    tag.to_ascii_uppercase().contains("URI=")
}

pub mod runtime;

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeProcess {
        commands: Vec<Command>,
        status: i32,
        write_hls: bool,
    }

    impl FakeProcess {
        fn succeeding() -> Self {
            Self {
                commands: Vec::new(),
                status: 0,
                write_hls: true,
            }
        }

        fn exiting(status: i32) -> Self {
            Self {
                commands: Vec::new(),
                status,
                write_hls: false,
            }
        }
    }

    impl Execute for FakeProcess {
        async fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
            if self.write_hls {
                let playlist = Path::new(command.argv.last().expect("playlist path"));
                fs::write(playlist, "#EXTM3U\nsegment-00000.ts\n").unwrap();
                fs::write(playlist.parent().unwrap().join("segment-00000.ts"), b"ts").unwrap();
            }
            self.commands.push(command);
            Ok(Output {
                status: self.status,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }

    fn expected_hls_argv(work_directory: &Path) -> Vec<String> {
        vec![
            "-y".into(),
            "-i".into(),
            work_directory
                .join("source.mp4")
                .to_string_lossy()
                .into_owned(),
            "-c:v".into(),
            "libx264".into(),
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
            work_directory
                .join("segment-%05d.ts")
                .to_string_lossy()
                .into_owned(),
            work_directory
                .join("index.m3u8")
                .to_string_lossy()
                .into_owned(),
        ]
    }

    fn layout(playlist: &str, segments: &[&str]) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("index.m3u8"), playlist).unwrap();
        for segment in segments {
            fs::write(directory.path().join(segment), b"ts").unwrap();
        }
        directory
    }

    fn invalid_reason(directory: impl AsRef<Path>) -> String {
        match validate_hls_output(directory.as_ref()) {
            Err(HlsError::InvalidPlaylist(reason)) => reason,
            other => panic!("expected invalid playlist, got {other:?}"),
        }
    }

    fn symlink_file(original: &Path, link: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(original, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(original, link)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (original, link);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "symlinks are not supported",
            ))
        }
    }

    #[test]
    fn accepts_zero_based_sequential_segments() {
        let directory = layout(
            "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-00000.ts\n#EXTINF:6.0,\nsegment-00001.ts\n#EXT-X-ENDLIST\n",
            &["segment-00000.ts", "segment-00001.ts"],
        );
        let output = validate_hls_output(directory.path()).unwrap();
        assert_eq!(output.segments.len(), 2);
    }

    #[test]
    fn rejects_duplicate_skipped_and_out_of_order_segments() {
        for playlist in [
            "#EXTM3U\nsegment-00000.ts\nsegment-00000.ts\n",
            "#EXTM3U\nsegment-00000.ts\nsegment-00002.ts\n",
            "#EXTM3U\nsegment-00001.ts\n",
        ] {
            let directory = layout(
                playlist,
                &["segment-00000.ts", "segment-00001.ts", "segment-00002.ts"],
            );
            let reason = invalid_reason(&directory);
            assert!(
                reason.contains("expected media segment"),
                "{playlist:?} -> {reason}"
            );
        }
    }

    #[test]
    fn rejects_uri_bearing_tags() {
        let directory = layout(
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://example.com/key\"\nsegment-00000.ts\n",
            &["segment-00000.ts"],
        );
        let reason = invalid_reason(&directory);
        assert!(reason.contains("unsupported URI-bearing tag"), "{reason}");
    }

    #[test]
    fn rejects_playlists_that_do_not_start_with_extm3u() {
        let directory = layout("segment-00000.ts\n", &["segment-00000.ts"]);
        let reason = invalid_reason(&directory);
        assert!(
            reason.contains("playlist must start with #EXTM3U"),
            "{reason}"
        );
    }

    #[tokio::test]
    async fn encode_hls_passes_fixed_argv_paths_and_segment_pattern() {
        let work = tempfile::tempdir().unwrap();
        fs::write(work.path().join("source.mp4"), b"video").unwrap();
        let mut executor = FakeProcess::succeeding();

        let output = encode_hls(&mut executor, "ffmpeg", work.path())
            .await
            .unwrap();
        assert_eq!(executor.commands.len(), 1);
        assert_eq!(executor.commands[0].executable, PathBuf::from("ffmpeg"));
        assert_eq!(executor.commands[0].argv, expected_hls_argv(work.path()));
        assert_eq!(output.playlist, work.path().join("index.m3u8"));
        assert_eq!(output.segments.len(), 1);
    }

    #[tokio::test]
    async fn encode_hls_rejects_nonzero_ffmpeg_status() {
        let work = tempfile::tempdir().unwrap();
        let mut executor = FakeProcess::exiting(1);

        match encode_hls(&mut executor, "ffmpeg", work.path()).await {
            Err(HlsError::Failed(1)) => {}
            other => panic!("expected Failed(1), got {other:?}"),
        }
        assert_eq!(executor.commands[0].executable, PathBuf::from("ffmpeg"));
        assert_eq!(executor.commands[0].argv, expected_hls_argv(work.path()));
        assert!(!work.path().join("index.m3u8").exists());
    }

    #[test]
    fn rejects_absolute_paths_urls_and_parent_traversal() {
        let absolute = if cfg!(windows) {
            r"C:\segment-00000.ts"
        } else {
            "/segment-00000.ts"
        };
        for reference in [
            absolute,
            "https://example.com/segment-00000.ts",
            "file:///segment-00000.ts",
            "//cdn.example/segment-00000.ts",
            "../segment-00000.ts",
            "foo/../segment-00000.ts",
        ] {
            let directory = layout(&format!("#EXTM3U\n{reference}\n"), &[]);
            let reason = invalid_reason(&directory);
            assert!(
                reason.contains("not a safe relative path"),
                "{reference:?} -> {reason}"
            );
        }
    }

    #[test]
    fn rejects_symlink_escaping_work_directory() {
        let work = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("outside.ts");
        fs::write(&target, b"ts").unwrap();
        if let Err(error) = symlink_file(&target, &work.path().join("segment-00000.ts")) {
            eprintln!("skipping symlink test: {error}");
            return;
        }
        fs::write(
            work.path().join("index.m3u8"),
            "#EXTM3U\nsegment-00000.ts\n",
        )
        .unwrap();
        let reason = invalid_reason(work.path());
        assert!(reason.contains("escapes work directory"), "{reason}");
    }

    #[test]
    fn rejects_missing_empty_and_non_file_segments() {
        let missing = layout("#EXTM3U\nsegment-00000.ts\n", &[]);
        let missing_reason = invalid_reason(&missing);
        assert!(
            missing_reason.contains("referenced segment is missing"),
            "{missing_reason}"
        );

        for playlist in ["#EXTM3U\n", "#EXTM3U\n#EXT-X-ENDLIST\n"] {
            let empty = layout(playlist, &[]);
            let reason = invalid_reason(&empty);
            assert!(
                reason.contains("playlist contains no media segments"),
                "{playlist:?} -> {reason}"
            );
        }

        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("index.m3u8"),
            "#EXTM3U\nsegment-00000.ts\n",
        )
        .unwrap();
        fs::create_dir(directory.path().join("segment-00000.ts")).unwrap();
        let reason = invalid_reason(&directory);
        assert!(reason.contains("media reference is not a file"), "{reason}");
    }
}
