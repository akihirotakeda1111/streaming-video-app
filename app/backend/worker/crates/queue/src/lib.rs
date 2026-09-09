//! Queue ports.  The worker depends on these capabilities, not on an SQS SDK.

use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    /// SQS identity used only to correlate repeated deliveries.
    pub message_id: Option<String>,
    /// Fresh identifier for this receive, never used for queue operations.
    pub delivery_id: String,
    pub receipt_handle: String,
    pub body: String,
    pub receive_count: u32,
    /// Conservative deadline captured before the receive request, not dispatch.
    pub visibility_deadline: Option<tokio::time::Instant>,
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
