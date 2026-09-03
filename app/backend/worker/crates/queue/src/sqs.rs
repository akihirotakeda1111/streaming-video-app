//! Amazon SQS adapter using the configured region and queue URL.

use std::{future::Future, time::Duration};

use aws_sdk_sqs::{Client, types::MessageSystemAttributeName};

use crate::{ChangeVisibility, Delete, Message, QueueError, Receive};

const MAX_VISIBILITY_TIMEOUT_SECS: u64 = 43_200;

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
    fn change_visibility(
        &mut self,
        queue_url: &str,
        receipt_handle: &str,
        visibility_timeout_secs: i32,
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
            .message_system_attribute_names(MessageSystemAttributeName::ApproximateReceiveCount)
            .send()
            .await
            .map_err(|_| "receive request failed".to_string())?;
        response
            .messages
            .and_then(|messages| messages.into_iter().next())
            .map(|message| {
                let receipt_handle = message
                    .receipt_handle
                    .filter(|handle| !handle.is_empty())
                    .ok_or_else(|| "received message has no receipt".to_string())?;
                let receive_count = message
                    .attributes
                    .as_ref()
                    .and_then(|attributes| {
                        attributes.get(&MessageSystemAttributeName::ApproximateReceiveCount)
                    })
                    .ok_or_else(|| "received message has no delivery count".to_string())?
                    .parse::<u32>()
                    .ok()
                    .filter(|count| *count > 0)
                    .ok_or_else(|| "received message has invalid delivery count".to_string())?;
                Ok(Message {
                    receipt_handle,
                    body: message.body.unwrap_or_default(),
                    receive_count,
                })
            })
            .transpose()
    }

    async fn delete(&mut self, queue_url: &str, receipt_handle: &str) -> Result<(), String> {
        self.client
            .delete_message()
            .queue_url(queue_url)
            .receipt_handle(receipt_handle)
            .send()
            .await
            .map(|_| ())
            .map_err(|_| "delete request failed".to_string())
    }

    async fn change_visibility(
        &mut self,
        queue_url: &str,
        receipt_handle: &str,
        visibility_timeout_secs: i32,
    ) -> Result<(), String> {
        self.client
            .change_message_visibility()
            .queue_url(queue_url)
            .receipt_handle(receipt_handle)
            .visibility_timeout(visibility_timeout_secs)
            .send()
            .await
            .map(|_| ())
            .map_err(|_| "visibility request failed".to_string())
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

impl<A: SqsApi + Send> ChangeVisibility for SqsQueue<A> {
    async fn change_visibility(
        &mut self,
        receipt_handle: &str,
        visibility_timeout: Duration,
    ) -> Result<(), QueueError> {
        if receipt_handle.is_empty()
            || visibility_timeout.as_secs() > MAX_VISIBILITY_TIMEOUT_SECS
            || visibility_timeout.subsec_nanos() != 0
        {
            return Err(QueueError("invalid visibility request".into()));
        }
        self.api
            .change_visibility(
                &self.queue_url,
                receipt_handle,
                visibility_timeout.as_secs() as i32,
            )
            .await
            .map_err(QueueError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
                receive_count: 1,
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

        async fn change_visibility(
            &mut self,
            queue_url: &str,
            receipt_handle: &str,
            visibility_timeout_secs: i32,
        ) -> Result<(), String> {
            self.calls.push(vec![
                "visibility".into(),
                queue_url.into(),
                receipt_handle.into(),
                visibility_timeout_secs.to_string(),
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

    #[tokio::test]
    async fn visibility_uses_configured_queue_receipt_and_duration_without_aws() {
        let mut queue = SqsQueue {
            queue_url: "https://example.test/configured".into(),
            api: FakeApi::default(),
        };

        queue
            .change_visibility("current-receipt", Duration::from_secs(90))
            .await
            .unwrap();

        assert_eq!(
            queue.api.calls,
            vec![
                vec![
                    "visibility".to_string(),
                    "https://example.test/configured".to_string(),
                    "current-receipt".to_string(),
                    "90".to_string(),
                ],
            ]
        );
    }

    #[tokio::test]
    async fn visibility_rejects_unbounded_or_empty_requests_without_aws() {
        let mut queue = SqsQueue {
            queue_url: "https://example.test/configured".into(),
            api: FakeApi::default(),
        };

        assert!(queue
            .change_visibility("", Duration::from_secs(1))
            .await
            .is_err());
        assert!(queue
            .change_visibility("receipt", Duration::from_secs(43_201))
            .await
            .is_err());
        assert!(queue.api.calls.is_empty());
    }
}
