//! Queue ports.  The worker depends on these capabilities, not on an SQS SDK.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub receipt_handle: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueError(pub String);

pub trait Receive {
    fn receive(&mut self) -> Result<Option<Message>, QueueError>;
}

pub trait Delete {
    fn delete(&mut self, receipt_handle: &str) -> Result<(), QueueError>;
}
