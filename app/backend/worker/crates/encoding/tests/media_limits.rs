#![cfg(unix)]
use encoding::{
    Command, Execute, encode_hls,
    limits::{BoundedExecutor, Limits},
    runtime::ProcessExecutor,
};
use std::{path::Path, time::Duration};

async fn source(root: &Path) {
    let output = ProcessExecutor
        .execute(Command::new(
            "/usr/bin/ffmpeg",
            vec![
                "-v".into(),
                "error".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=size=64x64:rate=10".into(),
                "-t".into(),
                "4".into(),
                "-c:v".into(),
                "libx264".into(),
                "-threads".into(),
                "1".into(),
                root.join("source.mp4").to_string_lossy().into_owned(),
            ],
        ))
        .await
        .unwrap();
    assert_eq!(output.status, 0);
}
fn realtime(root: &Path) -> Command {
    Command::new(
        "/usr/bin/ffmpeg",
        vec![
            "-v".into(),
            "error".into(),
            "-re".into(),
            "-i".into(),
            root.join("source.mp4").to_string_lossy().into_owned(),
            "-f".into(),
            "hls".into(),
            root.join("index.m3u8").to_string_lossy().into_owned(),
        ],
    )
}
fn pid_for(root: &Path) -> Option<u32> {
    let needle = root.to_string_lossy();
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(Result::ok)
        .find_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
            let cmd = std::fs::read(entry.path().join("cmdline")).ok()?;
            let cmd = String::from_utf8_lossy(&cmd);
            (cmd.starts_with("/usr/bin/ffmpeg\0") && cmd.contains(needle.as_ref())).then_some(pid)
        })
}
async fn gone(pid: u32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while Path::new(&format!("/proc/{pid}")).exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("FFmpeg child must be terminated and reaped");
}

#[tokio::test]
#[ignore = "requires FFmpeg; run tests/run-local.sh"]
async fn real_media_success_and_duration_rejection() {
    let root = tempfile::tempdir().unwrap();
    source(root.path()).await;
    let mut executor = BoundedExecutor {
        limits: Limits::default(),
    };
    encode_hls(&mut executor, "/usr/bin/ffmpeg", root.path())
        .await
        .unwrap();
    executor.limits.duration_seconds = 1;
    assert!(
        encode_hls(&mut executor, "/usr/bin/ffmpeg", root.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("duration")
    );
}

#[tokio::test]
#[ignore = "requires FFmpeg and /proc; run tests/run-local.sh"]
async fn real_ffmpeg_timeout_and_cancellation_terminate_child() {
    for cancel in [false, true] {
        let root = tempfile::tempdir().unwrap();
        source(root.path()).await;
        let command = realtime(root.path());
        let task = tokio::spawn(async move {
            BoundedExecutor {
                limits: Limits {
                    wall_seconds: 1,
                    ..Limits::default()
                },
            }
            .execute(command)
            .await
        });
        let pid = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(pid) = pid_for(root.path()) {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        if cancel {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert!(task.await.unwrap().unwrap_err().0.contains("wall time"));
        }
        gone(pid).await;
    }
}

#[tokio::test]
#[ignore = "requires FFmpeg; run tests/run-local.sh"]
async fn real_media_disk_failure_is_not_success() {
    let root = tempfile::tempdir().unwrap();
    source(root.path()).await;
    let size = std::fs::metadata(root.path().join("source.mp4"))
        .unwrap()
        .len();
    let limits = Limits {
        source_bytes: size,
        temporary_bytes: size + 32,
        ..Limits::default()
    };
    assert!(
        encode_hls(
            &mut BoundedExecutor { limits },
            "/usr/bin/ffmpeg",
            root.path()
        )
        .await
        .is_err()
    );
}
