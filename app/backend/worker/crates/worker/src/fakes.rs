//! In-memory ports for unit tests.  These fakes have no service dependencies,
//! record a shared call order, and allow each operation to fail once.

use std::{
    collections::VecDeque,
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
    fn delete(&mut self, receipt_handle: &str) -> Result<(), QueueError> {
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
}

impl FakeStorage {
    pub fn new(log: CallLog) -> Self {
        Self {
            log,
            reads: Vec::new(),
            writes: Vec::new(),
            read_failures: VecDeque::new(),
            write_failures: VecDeque::new(),
        }
    }
    pub fn add_read(&mut self, bucket: &str, key: &str, contents: Vec<u8>) {
        self.reads.push((bucket.into(), key.into(), contents));
    }
    pub fn fail_read(&mut self, message: impl Into<String>) {
        self.read_failures.push_back(message.into());
    }
    pub fn fail_write(&mut self, message: impl Into<String>) {
        self.write_failures.push_back(message.into());
    }
}

impl Read for FakeStorage {
    fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError> {
        self.log.push(Call::Read {
            bucket: bucket.into(),
            key: key.into(),
        });
        if let Some(error) = self.read_failures.pop_front() {
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
    fn write(&mut self, bucket: &str, key: &str, contents: &[u8]) -> Result<(), ObjectError> {
        self.log.push(Call::Write {
            bucket: bucket.into(),
            key: key.into(),
            contents: contents.into(),
        });
        if let Some(error) = self.write_failures.pop_front() {
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
        }
    }
    pub fn add_claim(&mut self, job_id: &str, video_id: &str, claimed: bool) {
        self.claims.push((job_id.into(), video_id.into(), claimed));
    }
    pub fn fail_claim(&mut self, message: impl Into<String>) {
        self.claim_failures.push_back(message.into());
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

fn take_failure(failures: &mut VecDeque<String>) -> Result<(), PersistenceError> {
    failures
        .pop_front()
        .map_or(Ok(()), |e| Err(PersistenceError(e)))
}

impl JobState for FakeJobState {
    fn claim(&mut self, job_id: &str, video_id: &str) -> Result<bool, PersistenceError> {
        self.log.push(Call::Claim {
            job_id: job_id.into(),
            video_id: video_id.into(),
        });
        take_failure(&mut self.claim_failures)?;
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
    fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkProcessing(job_id.into()));
        take_failure(&mut self.processing_failures)
    }
    fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkCompleted(job_id.into()));
        take_failure(&mut self.completed_failures)
    }
    fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError> {
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
}
impl FakeProcessExecutor {
    pub fn new(log: CallLog, output: Output) -> Self {
        Self {
            log,
            output,
            failures: VecDeque::new(),
        }
    }
    pub fn fail_next(&mut self, message: impl Into<String>) {
        self.failures.push_back(message.into());
    }
}
impl Execute for FakeProcessExecutor {
    fn execute(&mut self, command: Command) -> Result<Output, ProcessError> {
        self.log.push(Call::Execute(command));
        self.failures
            .pop_front()
            .map_or_else(|| Ok(self.output.clone()), |e| Err(ProcessError(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::JobState;
    use queue::{Delete, Message, Receive};

    fn message(receipt_handle: &str) -> Message {
        Message {
            receipt_handle: receipt_handle.into(),
            body: "body".into(),
        }
    }

    #[tokio::test]
    async fn queue_redelivers_until_delete_succeeds() {
        let mut queue = FakeQueue::new(CallLog::default());
        queue.push_message(message("r1"));

        assert_eq!(queue.receive().await.unwrap().unwrap().receipt_handle, "r1");
        assert_eq!(queue.receive().await.unwrap().unwrap().receipt_handle, "r1");

        queue.fail_delete("delete failed");
        assert!(queue.delete("r1").is_err());
        assert_eq!(queue.receive().await.unwrap().unwrap().receipt_handle, "r1");

        queue.delete("r1").unwrap();
        assert!(queue.receive().await.unwrap().is_none());
    }

    #[test]
    fn claim_records_job_and_video_ids() {
        let log = CallLog::default();
        let mut jobs = FakeJobState::new(log.clone());
        jobs.add_claim("job-1", "video-1", true);

        assert!(jobs.claim("job-1", "video-1").unwrap());
        assert_eq!(
            log.calls(),
            [Call::Claim {
                job_id: "job-1".into(),
                video_id: "video-1".into(),
            }]
        );
    }

    #[test]
    fn job_state_failures_are_operation_specific() {
        let mut jobs = FakeJobState::new(CallLog::default());
        jobs.add_claim("job-1", "video-1", true);
        jobs.fail_mark_processing("processing failed");

        assert!(jobs.claim("job-1", "video-1").unwrap());
        assert!(jobs.mark_processing("job-1").is_err());
        jobs.mark_completed("job-1").unwrap();
    }

    #[test]
    fn duplicate_claims_and_missing_jobs_are_no_ops() {
        let mut jobs = FakeJobState::new(CallLog::default());
        jobs.add_claim("job-1", "video-1", true);

        assert!(jobs.claim("job-1", "video-1").unwrap());
        assert!(!jobs.claim("job-1", "video-1").unwrap());
        assert!(!jobs.claim("missing", "video-1").unwrap());
    }
}
