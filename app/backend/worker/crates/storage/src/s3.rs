//! Amazon S3 adapter using configured input and output buckets.

use std::future::Future;

use aws_sdk_s3::{Client, primitives::ByteStream};
use tokio::runtime::{Handle, Runtime};

use crate::{ObjectError, Read, Write};

enum BlockingRuntime {
    Current,
    Owned(Runtime),
}

impl BlockingRuntime {
    fn connect() -> Result<Self, String> {
        if Handle::try_current().is_ok() {
            Ok(Self::Current)
        } else {
            Runtime::new()
                .map(Self::Owned)
                .map_err(|error| error.to_string())
        }
    }

    fn block_on<T>(&self, future: impl Future<Output = T>) -> T {
        match self {
            Self::Current => {
                let handle = Handle::current();
                tokio::task::block_in_place(|| handle.block_on(future))
            }
            Self::Owned(runtime) => runtime.block_on(future),
        }
    }
}

trait S3Api {
    fn get(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, String>;
    fn put(&mut self, bucket: &str, key: &str, contents: &[u8]) -> Result<(), String>;
}

pub struct AwsS3Api {
    client: Client,
    runtime: BlockingRuntime,
}

impl S3Api for AwsS3Api {
    fn get(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
        self.runtime.block_on(async {
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
        })
    }
    fn put(&mut self, bucket: &str, key: &str, contents: &[u8]) -> Result<(), String> {
        let body = ByteStream::from(contents.to_vec());
        self.runtime.block_on(async {
            self.client
                .put_object()
                .bucket(bucket)
                .key(key)
                .body(body)
                .send()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}

pub struct S3Storage<A = AwsS3Api> {
    input_bucket: String,
    output_bucket: String,
    api: A,
}

impl S3Storage<AwsS3Api> {
    /// Loads credentials from AWS's standard provider chain for `region`.
    pub fn new(
        region: &str,
        input_bucket: impl Into<String>,
        output_bucket: impl Into<String>,
    ) -> Result<Self, ObjectError> {
        let runtime = BlockingRuntime::connect().map_err(ObjectError)?;
        let config = runtime.block_on(
            aws_config::defaults(aws_config::BehaviorVersion::latest())
                .region(aws_config::Region::new(region.to_owned()))
                .load(),
        );
        Ok(Self {
            input_bucket: input_bucket.into(),
            output_bucket: output_bucket.into(),
            api: AwsS3Api {
                client: Client::new(&config),
                runtime,
            },
        })
    }
}

impl<A: S3Api> Read for S3Storage<A> {
    fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError> {
        if bucket != self.input_bucket {
            return Err(ObjectError(
                "read bucket is not the configured input bucket".into(),
            ));
        }
        self.api.get(bucket, key).map_err(ObjectError)
    }
}
impl<A: S3Api> Write for S3Storage<A> {
    fn write(&mut self, bucket: &str, key: &str, contents: &[u8]) -> Result<(), ObjectError> {
        if bucket != self.output_bucket {
            return Err(ObjectError(
                "write bucket is not the configured output bucket".into(),
            ));
        }
        self.api.put(bucket, key, contents).map_err(ObjectError)
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
        fn get(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
            self.calls
                .push(("get".into(), bucket.into(), key.into(), vec![]));
            Ok(b"input".to_vec())
        }
        fn put(&mut self, bucket: &str, key: &str, contents: &[u8]) -> Result<(), String> {
            self.calls
                .push(("put".into(), bucket.into(), key.into(), contents.into()));
            Ok(())
        }
    }
    #[test]
    fn configured_buckets_are_enforced_without_aws() {
        let mut storage = S3Storage {
            input_bucket: "input".into(),
            output_bucket: "output".into(),
            api: FakeApi::default(),
        };
        assert_eq!(storage.read("input", "source").unwrap(), b"input");
        storage.write("output", "manifest", b"hls").unwrap();
        assert!(storage.read("other", "source").is_err());
        assert!(storage.write("input", "manifest", b"hls").is_err());
        assert_eq!(storage.api.calls.len(), 2);
    }

    #[test]
    fn block_on_creates_a_runtime_outside_tokio() {
        let runtime = BlockingRuntime::connect().unwrap();
        assert!(matches!(runtime, BlockingRuntime::Owned(_)));
        assert_eq!(runtime.block_on(async { 7 }), 7);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn block_on_reuses_the_current_runtime() {
        let runtime = BlockingRuntime::connect().unwrap();
        assert!(matches!(runtime, BlockingRuntime::Current));
        assert_eq!(runtime.block_on(async { 7 }), 7);
    }
}
