//! Filesystem and child-process implementations of the encoding ports.

use std::{fs, io, path::Path, process::Command as ProcessCommand};

use tempfile::Builder;

use crate::{Command, Execute, Output, ProcessError};

/// Executes commands directly, without involving a command shell.
#[derive(Debug, Default)]
pub struct ProcessExecutor;

impl Execute for ProcessExecutor {
    fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
        let output = ProcessCommand::new(&command.executable)
            .args(&command.argv)
            .output()
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
    #[test]
    fn executor_passes_arguments_without_shell_interpolation() {
        let mut executor = ProcessExecutor;
        let output = executor
            .execute(Command::new(
                "/bin/printf",
                vec!["%s".into(), "hello; echo unsafe".into()],
            ))
            .unwrap();
        assert_eq!(output.status, 0);
        assert_eq!(output.stdout, b"hello; echo unsafe");
    }
}
