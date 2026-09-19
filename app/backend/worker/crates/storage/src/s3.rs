//! Amazon S3 adapter using configured input and output buckets.

use aws_sdk_s3::{Client, primitives::ByteStream};

use crate::{ObjectError, Read, Write};

trait S3Api {
    fn get_bounded(
        &mut self,
        bucket: &str,
        key: &str,
        maximum: u64,
    ) -> impl std::future::Future<Output = Result<Vec<u8>, String>> + Send {
        let read = self.get(bucket, key);
        async move {
            let bytes = read.await?;
            if bytes.len() as u64 > maximum {
                return Err("source size exceeds limit".into());
            }
            Ok(bytes)
        }
    }
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
    fn put_with_cache_control(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        cache_control: &str,
        contents: &[u8],
    ) -> impl std::future::Future<Output = Result<(), String>> + Send {
        let _ = cache_control;
        self.put(bucket, key, content_type, contents)
    }
}

pub struct AwsS3Api {
    client: Client,
}

async fn sdk_configuration(region: &str) -> aws_config::SdkConfig {
    aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(region.to_owned()))
        .load()
        .await
}

impl S3Api for AwsS3Api {
    async fn get(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
        self.get_bounded(bucket, key, 64 * 1024 * 1024).await
    }
    async fn get_bounded(
        &mut self,
        bucket: &str,
        key: &str,
        maximum: u64,
    ) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|length| length < 0 || length as u64 > maximum)
        {
            return Err("source size exceeds limit".into());
        }
        let mut stream = response.body;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "source download failed")?;
            if bytes.len() as u64 + chunk.len() as u64 > maximum {
                return Err("source size exceeds limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
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
    async fn put_with_cache_control(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        cache_control: &str,
        contents: &[u8],
    ) -> Result<(), String> {
        self.client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_type(content_type)
            .cache_control(cache_control)
            .body(ByteStream::from(contents.to_vec()))
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
        let config = sdk_configuration(region).await;
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
    async fn read_bounded(
        &mut self,
        bucket: &str,
        key: &str,
        maximum: u64,
    ) -> Result<Vec<u8>, ObjectError> {
        if bucket != self.input_bucket && bucket != self.output_bucket {
            return Err(ObjectError(
                "read bucket is not the configured input bucket".into(),
            ));
        }
        self.api
            .get_bounded(bucket, key, maximum)
            .await
            .map_err(ObjectError)
    }
    async fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError> {
        if bucket != self.input_bucket && bucket != self.output_bucket {
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
    async fn write_with_cache_control(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        cache_control: &str,
        contents: &[u8],
    ) -> Result<(), ObjectError> {
        if bucket != self.output_bucket {
            return Err(ObjectError(
                "write bucket is not the configured output bucket".into(),
            ));
        }
        self.api
            .put_with_cache_control(bucket, key, content_type, cache_control, contents)
            .await
            .map_err(ObjectError)
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "subprocess helper for SDK task-role credentials test"]
    async fn task_role_child() {
        use aws_sdk_s3::config::ProvideCredentials;
        let config = sdk_configuration("us-east-1").await;
        let credentials = config
            .credentials_provider()
            .unwrap()
            .provide_credentials()
            .await
            .unwrap();
        assert_eq!(credentials.access_key_id(), "test-task-role-key");
        assert_eq!(credentials.session_token(), Some("test-task-role-token"));
    }

    #[tokio::test]
    async fn sdk_task_role_provider_uses_local_credential_boundary() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /credentials "));
            let body = r#"{"AccessKeyId":"test-task-role-key","SecretAccessKey":"test-task-role-secret","Token":"test-task-role-token","Expiration":"2099-01-01T00:00:00Z"}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "s3::tests::task_role_child"])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env(
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                format!("http://{address}/credentials"),
            )
            .env("AWS_EC2_METADATA_DISABLED", "true")
            .kill_on_drop(true);
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        server.await.unwrap();
    }
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
#[tokio::test]
async fn actual_s3_stream_rejects_oversize_without_content_length() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).await.unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n").await.unwrap();
    });
    let config = aws_sdk_s3::config::Builder::new()
        .behavior_version_latest()
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .credentials_provider(aws_sdk_s3::config::Credentials::new(
            "test", "test", None, None, "test",
        ))
        .endpoint_url(format!("http://{address}"))
        .force_path_style(true)
        .build();
    let mut api = AwsS3Api {
        client: Client::from_conf(config),
    };
    assert!(
        api.get_bounded("input", "key", 5)
            .await
            .unwrap_err()
            .contains("size exceeds")
    );
    server.await.unwrap();
}
