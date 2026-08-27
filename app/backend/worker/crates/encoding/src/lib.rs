//! Process execution port.  An executable and argv are kept as separate
//! values so no shell command needs to be constructed.

use std::path::PathBuf;

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
    fn execute(&mut self, command: Command) -> Result<Output, ProcessError>;
}
