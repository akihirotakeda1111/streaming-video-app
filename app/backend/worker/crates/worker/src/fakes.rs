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
    Claim(String),
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
    fn receive(&mut self) -> Result<Option<Message>, QueueError> {
        self.log.push(Call::Receive);
        self.receive_failures
            .pop_front()
            .map_or_else(|| Ok(self.messages.pop_front()), |e| Err(QueueError(e)))
    }
}

impl Delete for FakeQueue {
    fn delete(&mut self, receipt_handle: &str) -> Result<(), QueueError> {
        self.log.push(Call::Delete(receipt_handle.into()));
        self.delete_failures
            .pop_front()
            .map_or(Ok(()), |e| Err(QueueError(e)))
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
    pub claims: Vec<(String, bool)>,
    failures: VecDeque<String>,
}

impl FakeJobState {
    pub fn new(log: CallLog) -> Self {
        Self {
            log,
            claims: Vec::new(),
            failures: VecDeque::new(),
        }
    }
    pub fn add_claim(&mut self, job_id: &str, claimed: bool) {
        self.claims.push((job_id.into(), claimed));
    }
    pub fn fail_next(&mut self, message: impl Into<String>) {
        self.failures.push_back(message.into());
    }
    fn result(&mut self) -> Result<(), PersistenceError> {
        self.failures
            .pop_front()
            .map_or(Ok(()), |e| Err(PersistenceError(e)))
    }
}

impl JobState for FakeJobState {
    fn claim(&mut self, job_id: &str) -> Result<bool, PersistenceError> {
        self.log.push(Call::Claim(job_id.into()));
        self.result()?;
        Ok(self
            .claims
            .iter()
            .find(|(id, _)| id == job_id)
            .map_or(true, |(_, claimed)| *claimed))
    }
    fn mark_processing(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkProcessing(job_id.into()));
        self.result()
    }
    fn mark_completed(&mut self, job_id: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkCompleted(job_id.into()));
        self.result()
    }
    fn mark_failed(&mut self, job_id: &str, reason: &str) -> Result<(), PersistenceError> {
        self.log.push(Call::MarkFailed {
            job_id: job_id.into(),
            reason: reason.into(),
        });
        self.result()
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
