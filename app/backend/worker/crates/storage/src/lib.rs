//! Object storage ports.  Implementations may use S3, while the worker only
//! knows how to read and write objects.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectError(pub String);

pub trait Read {
    fn read_bounded(
        &mut self,
        bucket: &str,
        key: &str,
        maximum: u64,
    ) -> impl std::future::Future<Output = Result<Vec<u8>, ObjectError>> + Send {
        let read = self.read(bucket, key);
        async move {
            let bytes = read.await?;
            if bytes.len() as u64 > maximum {
                return Err(ObjectError("source size exceeds limit".into()));
            }
            Ok(bytes)
        }
    }
    fn read(
        &mut self,
        bucket: &str,
        key: &str,
    ) -> impl std::future::Future<Output = Result<Vec<u8>, ObjectError>> + Send;
}

pub trait Write {
    fn write(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        contents: &[u8],
    ) -> impl std::future::Future<Output = Result<(), ObjectError>> + Send;

    fn write_with_cache_control(
        &mut self,
        bucket: &str,
        key: &str,
        content_type: &str,
        cache_control: &str,
        contents: &[u8],
    ) -> impl std::future::Future<Output = Result<(), ObjectError>> + Send {
        let _ = cache_control;
        self.write(bucket, key, content_type, contents)
    }
}

pub mod s3;
