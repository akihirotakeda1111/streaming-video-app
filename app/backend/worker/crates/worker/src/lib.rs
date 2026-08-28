//! Configuration and lifecycle support for the Phase 1 encoding worker.

pub mod claim;
pub mod event;
pub mod fakes;
pub mod publish;
pub mod runtime;
pub mod terminal;

/// A deterministic representation of wall-clock time used by worker ports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timestamp(pub u64);

pub trait Clock {
    fn now(&mut self) -> Timestamp;
}

use std::{env, fmt, path::PathBuf};

use url::Url;

const DATABASE_URL: &str = "DATABASE_URL";
const AWS_REGION: &str = "AWS_REGION";
const QUEUE_URL: &str = "VIDEO_ENCODING_QUEUE_URL";
const INPUT_BUCKET: &str = "VIDEO_INPUT_BUCKET";
const OUTPUT_BUCKET: &str = "VIDEO_OUTPUT_BUCKET";
const FFMPEG_PATH: &str = "FFMPEG_PATH";
const TEMPORARY_DIRECTORY: &str = "TMPDIR";

/// All runtime settings required by the worker.
#[derive(Clone, PartialEq, Eq)]
pub struct Config {
    pub database_url: String,
    pub aws_region: String,
    pub queue_url: String,
    pub input_bucket: String,
    pub output_bucket: String,
    pub ffmpeg_path: PathBuf,
    pub temporary_directory: PathBuf,
}

impl Config {
    /// Load and validate configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let database_url = required(&lookup, DATABASE_URL)?;
        let aws_region = required(&lookup, AWS_REGION)?;
        let queue_url = required(&lookup, QUEUE_URL)?;
        let input_bucket = required(&lookup, INPUT_BUCKET)?;
        let output_bucket = required(&lookup, OUTPUT_BUCKET)?;
        let ffmpeg_path = PathBuf::from(required(&lookup, FFMPEG_PATH)?);
        let temporary_directory = PathBuf::from(required(&lookup, TEMPORARY_DIRECTORY)?);

        validate_postgres_url(&database_url)?;
        validate_region(&aws_region)?;
        validate_http_url(QUEUE_URL, &queue_url)?;
        validate_bucket(INPUT_BUCKET, &input_bucket)?;
        validate_bucket(OUTPUT_BUCKET, &output_bucket)?;
        if input_bucket == output_bucket {
            return Err(ConfigError::invalid(
                OUTPUT_BUCKET,
                "must differ from VIDEO_INPUT_BUCKET",
            ));
        }

        Ok(Self {
            database_url,
            aws_region,
            queue_url,
            input_bucket,
            output_bucket,
            ffmpeg_path,
            temporary_directory,
        })
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("database_url", &"[REDACTED]")
            .field("aws_region", &self.aws_region)
            .field("queue_url", &self.queue_url)
            .field("input_bucket", &self.input_bucket)
            .field("output_bucket", &self.output_bucket)
            .field("ffmpeg_path", &self.ffmpeg_path)
            .field("temporary_directory", &self.temporary_directory)
            .finish()
    }
}

/// A safe configuration error containing only the affected variable name.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError {
    variable: &'static str,
    reason: &'static str,
}

impl ConfigError {
    const fn invalid(variable: &'static str, reason: &'static str) -> Self {
        Self { variable, reason }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "environment variable {:?} {}",
            self.variable, self.reason
        )
    }
}

impl std::error::Error for ConfigError {}

fn required<F>(lookup: &F, variable: &'static str) -> Result<String, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    lookup(variable)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .ok_or_else(|| ConfigError::invalid(variable, "is required"))
}

fn validate_postgres_url(value: &str) -> Result<(), ConfigError> {
    let parsed =
        Url::parse(value).map_err(|_| ConfigError::invalid(DATABASE_URL, "is malformed"))?;
    if matches!(parsed.scheme(), "postgres" | "postgresql") && parsed.host_str().is_some() {
        Ok(())
    } else {
        Err(ConfigError::invalid(
            DATABASE_URL,
            "must be a PostgreSQL URL",
        ))
    }
}

fn validate_region(value: &str) -> Result<(), ConfigError> {
    if is_aws_region(value) {
        Ok(())
    } else {
        Err(ConfigError::invalid(AWS_REGION, "is malformed"))
    }
}

fn is_aws_region(value: &str) -> bool {
    if !(2..=32).contains(&value.len()) {
        return false;
    }
    let Some((prefix, number)) = value.rsplit_once('-') else {
        return false;
    };
    if number.as_bytes().first() == Some(&b'0')
        || number.is_empty()
        || !number.bytes().all(|byte| byte.is_ascii_digit())
        || number.parse::<u32>().ok().is_none_or(|n| n == 0)
    {
        return false;
    }

    let mut parts = prefix.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty() || !first.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return false;
    }

    let mut extra_alpha_parts = 0;
    for part in parts {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_lowercase()) {
            return false;
        }
        extra_alpha_parts += 1;
    }
    extra_alpha_parts >= 1
}

fn validate_http_url(variable: &'static str, value: &str) -> Result<(), ConfigError> {
    let parsed = Url::parse(value).map_err(|_| ConfigError::invalid(variable, "is malformed"))?;
    if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some() {
        Ok(())
    } else {
        Err(ConfigError::invalid(variable, "must be an HTTP(S) URL"))
    }
}

fn validate_bucket(variable: &'static str, value: &str) -> Result<(), ConfigError> {
    let valid_length = (3..=63).contains(&value.len());
    let valid_chars = value.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
    });
    if valid_length
        && valid_chars
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
    {
        if value
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && !value.contains("..")
            && !value.contains(".-")
            && !value.contains("-.")
            && value.parse::<std::net::IpAddr>().is_err()
        {
            return Ok(());
        }
    }
    Err(ConfigError::invalid(
        variable,
        "must be a valid lowercase S3 bucket name",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn valid() -> HashMap<&'static str, String> {
        HashMap::from([
            (
                DATABASE_URL,
                "postgres://user:password@localhost/video".into(),
            ),
            (AWS_REGION, "ap-northeast-1".into()),
            (QUEUE_URL, "https://sqs.example.test/queue".into()),
            (INPUT_BUCKET, "video-input".into()),
            (OUTPUT_BUCKET, "video-output".into()),
            (FFMPEG_PATH, "/usr/bin/ffmpeg".into()),
            (TEMPORARY_DIRECTORY, "/tmp/video-worker".into()),
        ])
    }

    #[test]
    fn accepts_valid_configuration() {
        let values = valid();
        let config = Config::from_lookup(|name| values.get(name).cloned()).unwrap();
        assert_eq!(config.input_bucket, "video-input");
        assert!(!format!("{config:?}").contains("password"));
    }

    #[test]
    fn rejects_each_missing_required_value() {
        for variable in [
            DATABASE_URL,
            AWS_REGION,
            QUEUE_URL,
            INPUT_BUCKET,
            OUTPUT_BUCKET,
            FFMPEG_PATH,
            TEMPORARY_DIRECTORY,
        ] {
            let mut values = valid();
            values.remove(variable);
            let error = Config::from_lookup(|name| values.get(name).cloned()).unwrap_err();
            assert_eq!(error.variable, variable);
        }
    }

    #[test]
    fn rejects_equal_buckets() {
        let mut values = valid();
        values.insert(OUTPUT_BUCKET, "video-input".into());
        assert!(Config::from_lookup(|name| values.get(name).cloned()).is_err());
    }

    #[test]
    fn rejects_malformed_aws_regions() {
        for region in ["-", "123", "a", "---", "us--east-1", "us-east-0", "ap-1"] {
            let mut values = valid();
            values.insert(AWS_REGION, region.into());
            let error = Config::from_lookup(|name| values.get(name).cloned()).unwrap_err();
            assert_eq!(error.variable, AWS_REGION, "region {region:?}");
        }
    }

    #[test]
    fn accepts_structured_aws_regions() {
        for region in ["ap-northeast-1", "us-east-1", "us-gov-west-1"] {
            let mut values = valid();
            values.insert(AWS_REGION, region.into());
            Config::from_lookup(|name| values.get(name).cloned())
                .unwrap_or_else(|_| panic!("expected {region} to be accepted"));
        }
    }
}
