//! Queue ports.  The worker depends on these capabilities, not on an SQS SDK.

use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub receipt_handle: String,
    pub body: String,
    pub receive_count: u32,
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

pub trait ChangeVisibility {
    fn change_visibility(
        &mut self,
        receipt_handle: &str,
        visibility_timeout: Duration,
    ) -> impl std::future::Future<Output = Result<(), QueueError>> + Send;
}

pub mod sqs;
