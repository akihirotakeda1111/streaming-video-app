//! In-memory ports for unit tests.  These fakes have no service dependencies,
//! record a shared call order, and allow each operation to fail once.

use std::{
    collections::VecDeque,
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use encoding::{Command, Execute, Output, ProcessError};
use persistence::{JobState, PersistenceError};
use queue::{Delete, Message, QueueError, Receive};
use storage::{ObjectError, Read, Write};

use crate::{Clock, Timestamp};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Call {
    Receive,
    Delete(String),
    Read {
        bucket: String,
        key: String,
    },
    Write {
        bucket: String,
        key: String,
        content_type: String,
        contents: Vec<u8>,
    },
    Claim {
        job_id: String,
        video_id: String,
    },
    MarkProcessing(String),
    MarkCompleted(String),
    MarkFailed {
        job_id: String,
        reason: String,
    },
    Now,
    Execute(Command),
    ReadSource {
        path: String,
        contents: Vec<u8>,
    },
}

#[derive(Clone, Default, Debug)]
pub struct CallLog(Arc<Mutex<Vec<Call>>>);

impl CallLog {
    pub fn calls(&self) -> Vec<Call> {
        self.0.lock().expect("call log lock poisoned").clone()
    }

    fn push(&self, call: Call) {
        self.0.lock().expect("call log lock poisoned").push(call);
    }
}

#[derive(Debug)]
pub struct FakeQueue {
    pub log: CallLog,
    messages: VecDeque<Message>,
    receive_failures: VecDeque<String>,
    delete_failures: VecDeque<String>,
}

impl FakeQueue {
    pub fn new(log: CallLog) -> Self {
        Self {
            log,
            messages: VecDeque::new(),
            receive_failures: VecDeque::new(),
            delete_failures: VecDeque::new(),
        }
    }
    pub fn push_message(&mut self, message: Message) {
        self.messages.push_back(message);
    }
    pub fn fail_receive(&mut self, message: impl Into<String>) {
        self.receive_failures.push_back(message.into());
    }
    pub fn fail_delete(&mut self, message: impl Into<String>) {
        self.delete_failures.push_back(message.into());
    }
}

impl Receive for FakeQueue {
    async fn receive(&mut self) -> Result<Option<Message>, QueueError> {
        self.log.push(Call::Receive);
        if let Some(error) = self.receive_failures.pop_front() {
            return Err(QueueError(error));
        }
        Ok(self.messages.front().cloned())
    }
}

impl Delete for FakeQueue {
    async fn delete(&mut self, receipt_handle: &str) -> Result<(), QueueError> {
        self.log.push(Call::Delete(receipt_handle.into()));
        if let Some(error) = self.delete_failures.pop_front() {
            return Err(QueueError(error));
        }
        self.messages
            .retain(|message| message.receipt_handle != receipt_handle);
        Ok(())
    }
}

#[derive(Debug)]
pub struct FakeStorage {
    pub log: CallLog,
    pub reads: Vec<(String, String, Vec<u8>)>,
    pub writes: Vec<(String, String, Vec<u8>)>,
    read_failures: VecDeque<String>,
    write_failures: VecDeque<String>,
    read_skip: usize,
    write_skip: usize,
}

impl FakeStorage {
    pub fn new(log: CallLog) -> Self {
        Self {
            log,
            reads: Vec::new(),
            writes: Vec::new(),
            read_failures: VecDeque::new(),
            write_failures: VecDeque::new(),
            read_skip: 0,
            write_skip: 0,
        }
    }
    pub fn add_read(&mut self, bucket: &str, key: &str, contents: Vec<u8>) {
        self.reads.push((bucket.into(), key.into(), contents));
    }
    pub fn fail_read(&mut self, message: impl Into<String>) {
        self.read_failures.push_back(message.into());
    }
    pub fn fail_read_after(&mut self, successful_calls: usize, message: impl Into<String>) {
        self.read_skip = successful_calls;
        self.fail_read(message);
    }
    pub fn fail_write(&mut self, message: impl Into<String>) {
        self.write_failures.push_back(message.into());
    }
    pub fn fail_write_after(&mut self, successful_calls: usize, message: impl Into<String>) {
        self.write_skip = successful_calls;
        self.fail_write(message);
    }
}

impl Read for FakeStorage {
    async fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError> {
        self.log.push(Call::Read {
            bucket: bucket.into(),
            key: key.into(),
        });
        if let Some(error) = take_skipped_failure(&mut self.read_skip, &mut self.read_failures) {
            return Err(ObjectError(error));
        }
        self.reads
            .iter()
            .find(|(b, k, _)| b == bucket && k == key)
            .map(|(_, _, bytes)| bytes.clone())
            .ok_or_else(|| ObjectError("object not found".into()))
    }
}

impl Write for FakeStorage {
    async fn write(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        contents: &[u8],
    ) -> Result<(), ObjectError> {
        self.log.push(Call::Write {
            bucket: bucket.into(),
            key: key.into(),
            content_type: content_type.into(),
            contents: contents.into(),
        });
        if let Some(error) = take_skipped_failure(&mut self.write_skip, &mut self.write_failures) {
            return Err(ObjectError(error));
        }
        self.writes
            .push((bucket.into(), key.into(), contents.into()));
        Ok(())
    }
}

#[derive(Debug)]
pub struct FakeJobState {
    pub log: CallLog,
    pub claims: Vec<(String, String, bool)>,
    claim_failures: VecDeque<String>,
    processing_failures: VecDeque<String>,
    completed_failures: VecDeque<String>,
    mark_failed_failures: VecDeque<String>,
    claim_skip: usize,
}

impl FakeJobState {
    pub fn new(log: CallLog) -> Self {
        Self {
            log,
            claims: Vec::new(),
            claim_failures: VecDeque::new(),
            processing_failures: VecDeque::new(),
            completed_failures: VecDeque::new(),
            mark_failed_failures: VecDeque::new(),
            claim_skip: 0,
        }
    }
    pub fn add_claim(&mut self, job_id: &str, video_id: &str, claimed: bool) {
        self.claims.push((job_id.into(), video_id.into(), claimed));
    }
    pub fn fail_claim(&mut self, message: impl Into<String>) {
        self.claim_failures.push_back(message.into());
    }
    pub fn fail_claim_after(&mut self, successful_calls: usize, message: impl Into<String>) {
        self.claim_skip = successful_calls;
        self.fail_claim(message);
    }
    pub fn fail_mark_processing(&mut self, message: impl Into<String>) {
        self.processing_failures.push_back(message.into());
    }
    pub fn fail_mark_completed(&mut self, message: impl Into<String>) {
        self.completed_failures.push_back(message.into());
    }
    pub fn fail_mark_failed(&mut self, message: impl Into<String>) {
        self.mark_failed_failures.push_back(message.into());
    }
}

fn take_skipped_failure(skip: &mut usize, failures: &mut VecDeque<String>) -> Option<String> {
    if *skip > 0 {
        *skip -= 1;
        return None;
    }
    failures.pop_front()
}

fn take_failure(failures: &mut VecDeque<String>) -> Result<(), PersistenceError> {
    failures
        .pop_front()
        .map_or(Ok(()), |e| Err(PersistenceError(e)))
}

fn take_failure_after(
    skip: &mut usize,
    failures: &mut VecDeque<String>,
) -> Result<(), PersistenceError> {
    take_skipped_failure(skip, failures).map_or(Ok(()), |e| Err(PersistenceError(e)))
}

impl JobState for FakeJobState {
    async fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError> {
        self.log.push(Call::Claim {
            job_id: job_id.into(),
            video_id: video_id.into(),
        });
        take_failure_after(&mut self.claim_skip, &mut self.claim_failures)?;
        let Some((_, _, claimed)) = self
            .claims
            .iter_mut()
            .find(|(id, vid, _)| id == job_id && vid == video_id)
        else {
            return Ok(false);
        };

        if *claimed {
            *claimed = false;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    async fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkProcessing(job_id.into()));
        take_failure(&mut self.processing_failures)
    }
    async fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkCompleted(job_id.into()));
        take_failure(&mut self.completed_failures)
    }
    async fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkFailed {
            job_id: job_id.into(),
            reason: reason.into(),
        });
        take_failure(&mut self.mark_failed_failures)
    }
}

#[derive(Debug)]
pub struct FakeClock {
    pub log: CallLog,
    pub current: Timestamp,
}
impl FakeClock {
    pub fn new(log: CallLog, current: Timestamp) -> Self {
        Self { log, current }
    }
}
impl Clock for FakeClock {
    fn now(&mut self) -> Timestamp {
        self.log.push(Call::Now);
        self.current
    }
}

#[derive(Debug)]
pub struct FakeProcessExecutor {
    pub log: CallLog,
    pub output: Output,
    failures: VecDeque<String>,
    write_hls: bool,
}
impl FakeProcessExecutor {
    pub fn new(log: CallLog, output: Output) -> Self {
        Self {
            log,
            output,
            failures: VecDeque::new(),
            write_hls: false,
        }
    }
    /// Records `Execute` and writes a minimal valid HLS layout next to the
    /// playlist path ffmpeg would have produced. Used so encode tests do not
    /// spawn a real process.
    pub fn stub_hls(log: CallLog) -> Self {
        Self {
            log,
            output: Output {
                status: 0,
                stdout: Vec::new(),
                stderr: Vec::new(),
            },
            failures: VecDeque::new(),
            write_hls: true,
        }
    }
    pub fn fail_next(&mut self, message: impl Into<String>) {
        self.failures.push_back(message.into());
    }
}
impl Execute for FakeProcessExecutor {
    async fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
        self.log.push(Call::Execute(command.clone()));
        if let Some(error) = self.failures.pop_front() {
            return Err(ProcessError(error));
        }
        if self.write_hls {
            let playlist = command
                .argv
                .last()
                .ok_or_else(|| ProcessError("ffmpeg argv is missing the playlist path".into()))?;
            let playlist_path = Path::new(playlist);
            let source = command
                .argv
                .windows(2)
                .find(|pair| pair[0] == "-i")
                .map(|pair| Path::new(pair[1].as_str()))
                .ok_or_else(|| ProcessError("ffmpeg argv is missing -i".into()))?;
            match fs::metadata(source) {
                Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
                Ok(_) => {
                    return Err(ProcessError(format!(
                        "source is not a readable video file: {}",
                        source.display()
                    )));
                }
                Err(_) => {
                    return Err(ProcessError(format!(
                        "source is missing: {}",
                        source.display()
                    )));
                }
            }
            let contents = fs::read(source).map_err(|error| ProcessError(error.to_string()))?;
            self.log.push(Call::ReadSource {
                path: source.to_string_lossy().into_owned(),
                contents,
            });
            let directory = playlist_path
                .parent()
                .ok_or_else(|| ProcessError("playlist path has no parent directory".into()))?;
            fs::write(
                playlist_path,
                "#EXTM3U\nsegment-00000.ts\nsegment-00001.ts\n",
            )
            .map_err(|error| ProcessError(error.to_string()))?;
            fs::write(directory.join("segment-00000.ts"), b"segment")
                .map_err(|error| ProcessError(error.to_string()))?;
            fs::write(directory.join("segment-00001.ts"), b"segment")
                .map_err(|error| ProcessError(error.to_string()))?;
        }
        Ok(self.output.clone())
    }
}
