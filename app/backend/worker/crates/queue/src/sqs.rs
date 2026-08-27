//! Amazon SQS adapter using the configured region and queue URL.

use aws_sdk_sqs::Client;
use tokio::runtime::Runtime;

use crate::{Delete, Message, QueueError, Receive};

trait SqsApi {
    fn receive(&mut self, queue_url: &str) -> Result<Option<Message>, String>;
    fn delete(&mut self, queue_url: &str, receipt_handle: &str) -> Result<(), String>;
}

pub struct AwsSqsApi {
    client: Client,
    runtime: Runtime,
}

impl SqsApi for AwsSqsApi {
    fn receive(&mut self, queue_url: &str) -> Result<Option<Message>, String> {
        self.runtime.block_on(async {
            let response = self
                .client
                .receive_message()
                .queue_url(queue_url)
                .max_number_of_messages(1)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            Ok(response
                .messages
                .and_then(|messages| messages.into_iter().next())
                .map(|message| Message {
                    receipt_handle: message.receipt_handle.unwrap_or_default(),
                    body: message.body.unwrap_or_default(),
                }))
        })
    }

    fn delete(&mut self, queue_url: &str, receipt_handle: &str) -> Result<(), String> {
        self.runtime.block_on(async {
            self.client
                .delete_message()
                .queue_url(queue_url)
                .receipt_handle(receipt_handle)
                .send()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}

pub struct SqsQueue<A = AwsSqsApi> {
    queue_url: String,
    api: A,
}

impl SqsQueue<AwsSqsApi> {
    /// Loads the standard AWS credential chain and pins the requested region.
    pub fn new(region: &str, queue_url: impl Into<String>) -> Result<Self, QueueError> {
        let runtime = Runtime::new().map_err(|error| QueueError(error.to_string()))?;
        let config = runtime.block_on(
            aws_config::defaults(aws_config::BehaviorVersion::latest())
                .region(aws_config::Region::new(region.to_owned()))
                .load(),
        );
        Ok(Self {
            queue_url: queue_url.into(),
            api: AwsSqsApi {
                client: Client::new(&config),
                runtime,
            },
        })
    }
}

impl<A: SqsApi> Receive for SqsQueue<A> {
    fn receive(&mut self) -> Result<Option<Message>, QueueError> {
        self.api.receive(&self.queue_url).map_err(QueueError)
    }
}

impl<A: SqsApi> Delete for SqsQueue<A> {
    fn delete(&mut self, receipt_handle: &str) -> Result<(), QueueError> {
        self.api
            .delete(&self.queue_url, receipt_handle)
            .map_err(QueueError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeApi {
        calls: Vec<Vec<String>>,
    }
    impl SqsApi for FakeApi {
        fn receive(&mut self, queue_url: &str) -> Result<Option<Message>, String> {
            self.calls.push(vec!["receive".into(), queue_url.into()]);
            Ok(Some(Message {
                receipt_handle: "receipt".into(),
                body: "body".into(),
            }))
        }
        fn delete(&mut self, queue_url: &str, receipt_handle: &str) -> Result<(), String> {
            self.calls.push(vec![
                "delete".into(),
                queue_url.into(),
                receipt_handle.into(),
            ]);
            Ok(())
        }
    }

    #[test]
    fn adapter_always_uses_configured_queue_without_aws() {
        let mut queue = SqsQueue {
            queue_url: "https://example.test/configured".into(),
            api: FakeApi::default(),
        };
        assert_eq!(queue.receive().unwrap().unwrap().body, "body");
        queue.delete("receipt").unwrap();
        assert_eq!(
            queue.api.calls,
            vec![
                vec![
                    "receive".to_string(),
                    "https://example.test/configured".to_string()
                ],
                vec![
                    "delete".to_string(),
                    "https://example.test/configured".to_string(),
                    "receipt".to_string()
                ],
            ]
        );
    }
}
