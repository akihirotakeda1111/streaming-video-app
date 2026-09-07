//! Filesystem and child-process implementations of the encoding ports.

use std::{fs, io, path::Path};

use tempfile::Builder;

use crate::{Command, Execute, Output, ProcessError};

/// Executes commands directly, without involving a command shell.
#[derive(Debug, Default)]
pub struct ProcessExecutor;

impl Execute for ProcessExecutor {
    async fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
        let output = tokio::process::Command::new(&command.executable)
            .args(&command.argv)
            // Dropping the execution future on shutdown or lease loss must
            // also terminate FFmpeg instead of leaving it running in the background.
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| ProcessError(format!("execute {:?}: {error}", command.executable)))?;
        Ok(Output {
            status: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

/// A per-job directory whose contents are deleted when it is removed or dropped.
#[derive(Debug)]
pub struct JobDirectory {
    directory: Option<tempfile::TempDir>,
}

impl JobDirectory {
    /// Creates an isolated directory below `root`. The job id is used only as a
    /// readable prefix and is stripped of filesystem-significant characters.
    pub fn create(root: &Path, job_id: &str) -> io::Result<Self> {
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
        let directory = Builder::new()
            .prefix(&format!("job-{safe_id}-"))
            .tempdir_in(root)?;
        Ok(Self {
            directory: Some(directory),
        })
    }

    pub fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("job directory used after removal")
            .path()
    }

    /// Explicitly removes the directory. Drop provides the same cleanup if
    /// callers return early.
    pub fn remove(mut self) -> io::Result<()> {
        self.directory
            .take()
            .expect("job directory already removed")
            .close()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, time::Duration};

    // Run in a separate test process so cancellation exercises a real child
    // on Windows and Unix without depending on an installed FFmpeg or shell.
    #[test]
    #[ignore = "child process helper invoked by executor_cancellation_terminates_child"]
    fn cancellation_child() {
        let Some(marker) = std::env::args().skip_while(|arg| arg != "--skip").nth(1) else {
            return;
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        fs::write(marker, listener.local_addr().unwrap().to_string()).unwrap();
        // A finite lifetime also cleans up the helper if the regression test fails.
        std::thread::sleep(Duration::from_secs(10));
        drop(listener);
    }

    #[tokio::test]
    async fn executor_cancellation_terminates_child() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("child-address");
        let command = Command::new(
            std::env::current_exe().unwrap(),
            vec![
                "--ignored".into(),
                "--exact".into(),
                "runtime::tests::cancellation_child".into(),
                "--skip".into(),
                marker.to_string_lossy().into_owned(),
            ],
        );
        let task = tokio::spawn(async move { ProcessExecutor.execute(command).await });
        let address = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                assert!(!task.is_finished(), "child exited before cancellation");
                if let Ok(value) = fs::read_to_string(&marker) {
                    if let Ok(address) = value.parse::<std::net::SocketAddr>() {
                        break address;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("child did not start");
        assert!(
            TcpListener::bind(address).is_err(),
            "child must hold the port"
        );

        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                // Rebinding proves the OS released the child's resource,
                // rather than merely observing that the Rust future stopped.
                if let Ok(listener) = TcpListener::bind(address) {
                    drop(listener);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled executor left its child process running");
    }

    #[test]
    fn job_directories_are_isolated_under_root_and_removable() {
        let root = tempfile::tempdir().unwrap();
        let first = JobDirectory::create(root.path(), "job/one").unwrap();
        let second = JobDirectory::create(root.path(), "job/one").unwrap();
        let first_path = first.path().to_owned();
        assert_ne!(first.path(), second.path());
        assert!(first.path().starts_with(root.path()));
        assert!(!first.path().to_string_lossy().contains("job/one"));
        fs::write(first.path().join("artifact"), b"data").unwrap();

        first.remove().unwrap();
        assert!(!first_path.exists());
        assert!(second.path().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executor_passes_arguments_without_shell_interpolation() {
        let mut executor = ProcessExecutor;
        let output = executor
            .execute(Command::new(
                "/bin/printf",
                vec!["%s".into(), "hello; echo unsafe".into()],
            ))
            .await
            .unwrap();
        assert_eq!(output.status, 0);
        assert_eq!(output.stdout, b"hello; echo unsafe");
    }
}
