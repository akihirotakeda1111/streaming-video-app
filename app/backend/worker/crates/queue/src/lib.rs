//! Queue ports.  The worker depends on these capabilities, not on an SQS SDK.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub receipt_handle: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueError(pub String);

pub trait Receive {
    fn receive(
        &mut self,
    ) -> impl std::future::Future<Output = Result<Option<Message>, QueueError>> + Send;
}

pub trait Delete {
    fn delete(
        &mut self,
        receipt_handle: &str,
    ) -> impl std::future::Future<Output = Result<(), QueueError>> + Send;
}

pub mod sqs;
