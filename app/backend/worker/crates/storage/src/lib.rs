//! Object storage ports.  Implementations may use S3, while the worker only
//! knows how to read and write objects.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectError(pub String);

pub trait Read {
    fn read(&mut self, bucket: &str, key: &str) -> Result<Vec<u8>, ObjectError>;
}

pub trait Write {
    fn write(&mut self, bucket: &str, key: &str, contents: &[u8]) -> Result<(), ObjectError>;
}
