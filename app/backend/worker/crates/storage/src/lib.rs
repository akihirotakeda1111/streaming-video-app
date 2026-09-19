//! Object storage ports.  Implementations may use S3, while the worker only
//! knows how to read and write objects.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectError(pub String);

/// Bytes plus the GetObject metadata used to verify descriptors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectRead {
    pub contents: Vec<u8>,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
}

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

    fn read_object(
        &mut self,
        bucket: &str,
        key: &str,
    ) -> impl std::future::Future<Output = Result<ObjectRead, ObjectError>> + Send {
        let read = self.read(bucket, key);
        async move {
            let contents = read.await?;
            Ok(ObjectRead {
                content_length: Some(contents.len() as u64),
                content_type: None,
                contents,
            })
        }
    }
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
