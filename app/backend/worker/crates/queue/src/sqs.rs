//! Amazon SQS adapter using the configured region and queue URL.

use std::future::Future;

use aws_sdk_sqs::Client;

use crate::{Delete, Message, QueueError, Receive};

trait SqsApi {
    fn receive(
        &mut self,
        queue_url: &str,
        wait_time_seconds: i32,
    ) -> impl Future<Output = Result<Option<Message>, String>> + Send;
    fn delete(
        &mut self,
        queue_url: &str,
        receipt_handle: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

pub struct AwsSqsApi {
    client: Client,
}

impl SqsApi for AwsSqsApi {
    async fn receive(
        &mut self,
        queue_url: &str,
        wait_time_seconds: i32,
    ) -> Result<Option<Message>, String> {
        let response = self
            .client
            .receive_message()
            .queue_url(queue_url)
            .max_number_of_messages(1)
            .wait_time_seconds(wait_time_seconds)
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
    }

    async fn delete(&mut self, queue_url: &str, receipt_handle: &str) -> Result<(), String> {
        self.client
            .delete_message()
            .queue_url(queue_url)
            .receipt_handle(receipt_handle)
            .send()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

pub struct SqsQueue<A = AwsSqsApi> {
    queue_url: String,
    api: A,
}

impl SqsQueue<AwsSqsApi> {
    /// Loads the standard AWS credential chain and pins the requested region.
    pub async fn new(region: &str, queue_url: impl Into<String>) -> Result<Self, QueueError> {
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_owned()))
            .load()
            .await;
        Ok(Self {
            queue_url: queue_url.into(),
            api: AwsSqsApi {
                client: Client::new(&config),
            },
        })
    }
}

impl<A: SqsApi + Send> Receive for SqsQueue<A> {
    async fn receive(&mut self) -> Result<Option<Message>, QueueError> {
        self.api
            .receive(&self.queue_url, 20)
            .await
            .map_err(QueueError)
    }
}

impl<A: SqsApi + Send> Delete for SqsQueue<A> {
    async fn delete(&mut self, receipt_handle: &str) -> Result<(), QueueError> {
        self.api
            .delete(&self.queue_url, receipt_handle)
            .await
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
        async fn receive(
            &mut self,
            queue_url: &str,
            wait_time_seconds: i32,
        ) -> Result<Option<Message>, String> {
            self.calls.push(vec![
                "receive".into(),
                queue_url.into(),
                wait_time_seconds.to_string(),
            ]);
            Ok(Some(Message {
                receipt_handle: "receipt".into(),
                body: "body".into(),
            }))
        }
        async fn delete(&mut self, queue_url: &str, receipt_handle: &str) -> Result<(), String> {
            self.calls.push(vec![
                "delete".into(),
                queue_url.into(),
                receipt_handle.into(),
            ]);
            Ok(())
        }
    }

    #[tokio::test]
    async fn adapter_uses_configured_queue_and_long_polling_without_aws() {
        let mut queue = SqsQueue {
            queue_url: "https://example.test/configured".into(),
            api: FakeApi::default(),
        };
        assert_eq!(queue.receive().await.unwrap().unwrap().body, "body");
        queue.delete("receipt").await.unwrap();
        assert_eq!(
            queue.api.calls,
            vec![
                vec![
                    "receive".to_string(),
                    "https://example.test/configured".to_string(),
                    "20".to_string(),
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
