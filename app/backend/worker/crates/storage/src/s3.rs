//! Amazon S3 adapter using configured input and output buckets.

use aws_sdk_s3::{Client, primitives::ByteStream};

use crate::{ObjectError, Read, Write};

trait S3Api {
    fn get(
        &mut self,
        bucket: &str,
        key: &str,
    ) -> impl std::future::Future<Output = Result<Vec<u8>, String>> + Send;
    fn put(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        contents: &[u8],
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

pub struct AwsS3Api {
    client: Client,
}

impl S3Api for AwsS3Api {
    async fn get(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        response
            .body
            .collect()
            .await
            .map(|bytes| bytes.into_bytes().to_vec())
            .map_err(|error| error.to_string())
    }
    async fn put(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        contents: &[u8],
    ) -> Result<(), String> {
        let body = ByteStream::from(contents.to_vec());
        self.client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_type(content_type)
            .body(body)
            .send()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

pub struct S3Storage<A = AwsS3Api> {
    input_bucket: String,
    output_bucket: String,
    api: A,
}

impl S3Storage<AwsS3Api> {
    /// Loads credentials from AWS's standard provider chain for `region`.
    pub async fn new(
        region: &str,
        input_bucket: impl Into<String>,
        output_bucket: impl Into<String>,
    ) -> Result<Self, ObjectError> {
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_owned()))
            .load()
            .await;
        Ok(Self {
            input_bucket: input_bucket.into(),
            output_bucket: output_bucket.into(),
            api: AwsS3Api {
                client: Client::new(&config),
            },
        })
    }
}

impl<A: S3Api + Send> Read for S3Storage<A> {
    async fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError> {
        if bucket != self.input_bucket {
            return Err(ObjectError(
                "read bucket is not the configured input bucket".into(),
            ));
        }
        self.api.get(bucket, key).await.map_err(ObjectError)
    }
}
impl<A: S3Api + Send> Write for S3Storage<A> {
    async fn write(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        contents: &[u8],
    ) -> Result<(), ObjectError> {
        if bucket != self.output_bucket {
            return Err(ObjectError(
                "write bucket is not the configured output bucket".into(),
            ));
        }
        self.api
            .put(bucket, key, content_type, contents)
            .await
            .map_err(ObjectError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct FakeApi {
        calls: Vec<(String, String, String, Vec<u8>)>,
    }
    impl S3Api for FakeApi {
        async fn get(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
            self.calls
                .push(("get".into(), bucket.into(), key.into(), vec![]));
            Ok(b"input".to_vec())
        }
        async fn put(
            &mut self,
            bucket: &str,
            key: &str,
            content_type: &str,
            contents: &[u8],
        ) -> Result<(), String> {
            self.calls.push((
                content_type.into(),
                bucket.into(),
                key.into(),
                contents.into(),
            ));
            Ok(())
        }
    }
    #[tokio::test]
    async fn configured_buckets_are_enforced_without_aws() {
        let mut storage = S3Storage {
            input_bucket: "input".into(),
            output_bucket: "output".into(),
            api: FakeApi::default(),
        };
        assert_eq!(storage.read("input", "source").await.unwrap(), b"input");
        storage
            .write(
                "output",
                "manifest",
                "application/vnd.apple.mpegurl",
                b"hls",
            )
            .await
            .unwrap();
        assert!(storage.read("other", "source").await.is_err());
        assert!(
            storage
                .write("input", "manifest", "application/vnd.apple.mpegurl", b"hls")
                .await
                .is_err()
        );
        assert_eq!(storage.api.calls.len(), 2);
        assert_eq!(storage.api.calls[1].0, "application/vnd.apple.mpegurl");
    }
}
