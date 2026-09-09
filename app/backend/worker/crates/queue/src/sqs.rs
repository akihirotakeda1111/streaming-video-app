//! Amazon SQS adapter using the configured region and queue URL.

use std::{future::Future, time::Duration};

use aws_sdk_sqs::{
    Client,
    types::{Message as AwsMessage, MessageSystemAttributeName, QueueAttributeName},
};

use crate::{ChangeVisibility, Delete, Message, QueueError, Receive};

const MAX_VISIBILITY_TIMEOUT_SECS: u64 = 43_200;

trait SqsApi {
    fn visibility_timeout(
        &mut self,
        queue_url: &str,
    ) -> impl Future<Output = Result<u64, String>> + Send;
    fn receive(
        &mut self,
        queue_url: &str,
        wait_time_seconds: i32,
        visibility_timeout: i32,
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

fn normalize_received_message(message: AwsMessage) -> Result<Message, String> {
    let receipt_handle = message
        .receipt_handle
        .filter(|handle| !handle.is_empty())
        .ok_or_else(|| "received message has no receipt".to_string())?;
    let receive_count = message
        .attributes
        .as_ref()
        .and_then(|attributes| attributes.get(&MessageSystemAttributeName::ApproximateReceiveCount))
        .ok_or_else(|| "received message has no delivery count".to_string())?
        .parse::<u32>()
        .ok()
        .filter(|count| *count > 0)
        .ok_or_else(|| "received message has invalid delivery count".to_string())?;
    Ok(Message {
        message_id: message
            .message_id
            .filter(|id| !id.is_empty() && id.len() <= 128 && id.is_ascii()),
        delivery_id: String::new(),
        receipt_handle,
        body: message.body.unwrap_or_default(),
        receive_count,
        visibility_deadline: None,
    })
}

impl SqsApi for AwsSqsApi {
    async fn visibility_timeout(&mut self, queue_url: &str) -> Result<u64, String> {
        let attributes = self
            .client
            .get_queue_attributes()
            .queue_url(queue_url)
            .attribute_names(QueueAttributeName::VisibilityTimeout)
            .send()
            .await
            .map_err(|_| "queue visibility lookup failed".to_string())?;
        attributes
            .attributes
            .as_ref()
            .and_then(|values| values.get(&QueueAttributeName::VisibilityTimeout))
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "queue visibility timeout is invalid".to_string())
    }

    async fn receive(
        &mut self,
        queue_url: &str,
        wait_time_seconds: i32,
        visibility_timeout: i32,
    ) -> Result<Option<Message>, String> {
        let response = self
            .client
            .receive_message()
            .queue_url(queue_url)
            .max_number_of_messages(1)
            .wait_time_seconds(wait_time_seconds)
            .visibility_timeout(visibility_timeout)
            .message_system_attribute_names(MessageSystemAttributeName::ApproximateReceiveCount)
            .send()
            .await
            .map_err(|_| "receive request failed".to_string())?;
        response
            .messages
            .and_then(|messages| messages.into_iter().next())
            .map(normalize_received_message)
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
        let seconds = self
            .api
            .visibility_timeout(&self.queue_url)
            .await
            .map_err(QueueError)?;
        if seconds == 0 || seconds > MAX_VISIBILITY_TIMEOUT_SECS {
            return Err(QueueError("queue visibility timeout is invalid".into()));
        }
        // Pin the current queue timeout on the request and account for the
        // entire receive latency, including long polling and SDK retries.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        let mut message = self
            .api
            .receive(&self.queue_url, 20, seconds as i32)
            .await
            .map_err(QueueError)?;
        if let Some(message) = &mut message {
            message.visibility_deadline = Some(deadline);
        }
        Ok(message)
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

    fn aws_message(receipt_handle: Option<&str>, receive_count: Option<&str>) -> AwsMessage {
        let mut builder = AwsMessage::builder()
            .body("body")
            .set_receipt_handle(receipt_handle.map(str::to_owned));
        if let Some(receive_count) = receive_count {
            builder = builder.attributes(
                MessageSystemAttributeName::ApproximateReceiveCount,
                receive_count,
            );
        }
        builder.build()
    }

    #[test]
    fn normalization_maps_valid_received_metadata() {
        assert_eq!(
            normalize_received_message(aws_message(Some("receipt"), Some("2"))).unwrap(),
            Message {
                message_id: None,
                delivery_id: String::new(),
                receipt_handle: "receipt".into(),
                body: "body".into(),
                receive_count: 2,
                visibility_deadline: None,
            }
        );
    }

    #[test]
    fn normalization_rejects_missing_or_empty_receipts() {
        for receipt_handle in [None, Some("")] {
            assert_eq!(
                normalize_received_message(aws_message(receipt_handle, Some("1"))).unwrap_err(),
                "received message has no receipt"
            );
        }
    }

    #[test]
    fn normalization_rejects_missing_delivery_count() {
        assert_eq!(
            normalize_received_message(aws_message(Some("receipt"), None)).unwrap_err(),
            "received message has no delivery count"
        );
    }

    #[test]
    fn normalization_rejects_malformed_zero_or_negative_delivery_counts() {
        for receive_count in ["invalid", "0", "-1"] {
            assert_eq!(
                normalize_received_message(aws_message(Some("receipt"), Some(receive_count)))
                    .unwrap_err(),
                "received message has invalid delivery count"
            );
        }
    }

    #[derive(Default)]
    struct FakeApi {
        calls: Vec<Vec<String>>,
        receive_delay: Duration,
    }
    impl SqsApi for FakeApi {
        async fn visibility_timeout(&mut self, _: &str) -> Result<u64, String> {
            Ok(120)
        }
        async fn receive(
            &mut self,
            queue_url: &str,
            wait_time_seconds: i32,
            visibility_timeout: i32,
        ) -> Result<Option<Message>, String> {
            self.calls.push(vec![
                "receive".into(),
                queue_url.into(),
                wait_time_seconds.to_string(),
                visibility_timeout.to_string(),
            ]);
            tokio::time::sleep(self.receive_delay).await;
            Ok(Some(Message {
                message_id: None,
                delivery_id: String::new(),
                receipt_handle: "receipt".into(),
                body: "body".into(),
                receive_count: 1,
                visibility_deadline: None,
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
    async fn receive_deadline_includes_time_spent_waiting_for_sqs() {
        let mut queue = SqsQueue {
            queue_url: "queue".into(),
            api: FakeApi {
                receive_delay: Duration::from_millis(40),
                ..FakeApi::default()
            },
        };
        let start = tokio::time::Instant::now();
        let message = queue.receive().await.unwrap().unwrap();
        let deadline = message.visibility_deadline.unwrap();
        assert!(deadline >= start + Duration::from_secs(120));
        assert!(
            deadline
                < tokio::time::Instant::now() + Duration::from_secs(120)
                    - Duration::from_millis(20)
        );
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
                    "120".to_string(),
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
            vec![vec![
                "visibility".to_string(),
                "https://example.test/configured".to_string(),
                "current-receipt".to_string(),
                "90".to_string(),
            ],]
        );
    }

    #[tokio::test]
    async fn visibility_rejects_unbounded_or_empty_requests_without_aws() {
        let mut queue = SqsQueue {
            queue_url: "https://example.test/configured".into(),
            api: FakeApi::default(),
        };

        assert!(
            queue
                .change_visibility("", Duration::from_secs(1))
                .await
                .is_err()
        );
        assert!(
            queue
                .change_visibility("receipt", Duration::from_secs(43_201))
                .await
                .is_err()
        );
        assert!(queue.api.calls.is_empty());
    }
}
