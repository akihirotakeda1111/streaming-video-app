//! Configuration and lifecycle support for the encoding worker.

pub mod acquisition;
pub mod completion;
pub mod event;
pub mod fakes;
pub mod heartbeat;
pub mod publish;
pub mod retry;
pub mod runtime;

use std::{env, fmt, path::PathBuf};

use url::Url;

const DATABASE_URL: &str = "DATABASE_URL";
const AWS_REGION: &str = "AWS_REGION";
const QUEUE_URL: &str = "VIDEO_ENCODING_QUEUE_URL";
const INPUT_BUCKET: &str = "VIDEO_INPUT_BUCKET";
const OUTPUT_BUCKET: &str = "VIDEO_OUTPUT_BUCKET";
const FFMPEG_PATH: &str = "FFMPEG_PATH";
const TEMPORARY_DIRECTORY: &str = "TMPDIR";
const HEARTBEAT_INTERVAL_SECONDS: &str = "WORKER_HEARTBEAT_INTERVAL_SECONDS";
const VISIBILITY_EXTENSION_SECONDS: &str = "WORKER_VISIBILITY_EXTENSION_SECONDS";
const LEASE_DURATION_SECONDS: &str = "WORKER_LEASE_DURATION_SECONDS";
const RETRY_DELAY_SECONDS: &str = "WORKER_RETRY_DELAY_SECONDS";
const MAXIMUM_ATTEMPTS: &str = "WORKER_MAXIMUM_ATTEMPTS";

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
    pub heartbeat_interval_seconds: u64,
    pub visibility_extension_seconds: u64,
    pub lease_duration_seconds: u64,
    pub retry_delay_seconds: u64,
    pub maximum_attempts: u32,
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
        let heartbeat_interval_seconds = positive_seconds(&lookup, HEARTBEAT_INTERVAL_SECONDS)?;
        let visibility_extension_seconds = positive_seconds(&lookup, VISIBILITY_EXTENSION_SECONDS)?;
        let lease_duration_seconds = positive_seconds(&lookup, LEASE_DURATION_SECONDS)?;
        let retry_delay_seconds = positive_seconds(&lookup, RETRY_DELAY_SECONDS)?;
        let maximum_attempts = positive_u32(&lookup, MAXIMUM_ATTEMPTS)?;
        if maximum_attempts > 10 {
            return Err(ConfigError::invalid(MAXIMUM_ATTEMPTS, "must not exceed 10"));
        }

        if visibility_extension_seconds > 43_200 {
            return Err(ConfigError::invalid(
                VISIBILITY_EXTENSION_SECONDS,
                "must not exceed 43200 seconds",
            ));
        }
        if lease_duration_seconds > heartbeat::MAX_LEASE_DURATION_SECONDS {
            return Err(ConfigError::invalid(
                LEASE_DURATION_SECONDS,
                "must not exceed 43200 seconds",
            ));
        }
        if heartbeat_interval_seconds > visibility_extension_seconds / 2
            || heartbeat_interval_seconds > lease_duration_seconds / 2
        {
            return Err(ConfigError::invalid(
                HEARTBEAT_INTERVAL_SECONDS,
                "must be at most half the lease duration and visibility extension",
            ));
        }
        if retry_delay_seconds > 43_200 {
            return Err(ConfigError::invalid(
                RETRY_DELAY_SECONDS,
                "must not exceed 43200 seconds",
            ));
        }

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
            heartbeat_interval_seconds,
            visibility_extension_seconds,
            lease_duration_seconds,
            retry_delay_seconds,
            maximum_attempts,
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
            .field(
                "heartbeat_interval_seconds",
                &self.heartbeat_interval_seconds,
            )
            .field(
                "visibility_extension_seconds",
                &self.visibility_extension_seconds,
            )
            .field("lease_duration_seconds", &self.lease_duration_seconds)
            .field("retry_delay_seconds", &self.retry_delay_seconds)
            .field("maximum_attempts", &self.maximum_attempts)
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

fn positive_seconds<F>(lookup: &F, variable: &'static str) -> Result<u64, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    let value = required(lookup, variable)?;
    let seconds = value
        .parse::<u64>()
        .map_err(|_| ConfigError::invalid(variable, "must be a positive integer"))?;
    if seconds == 0 {
        return Err(ConfigError::invalid(variable, "must be a positive integer"));
    }
    Ok(seconds)
}

fn positive_u32<F>(lookup: &F, variable: &'static str) -> Result<u32, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    let value = required(lookup, variable)?;
    let attempts = value
        .parse::<u32>()
        .map_err(|_| ConfigError::invalid(variable, "must be a positive integer"))?;
    if attempts == 0 {
        return Err(ConfigError::invalid(variable, "must be a positive integer"));
    }
    Ok(attempts)
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
        && value
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
            (HEARTBEAT_INTERVAL_SECONDS, "30".into()),
            (VISIBILITY_EXTENSION_SECONDS, "120".into()),
            (LEASE_DURATION_SECONDS, "300".into()),
            (RETRY_DELAY_SECONDS, "900".into()),
            (MAXIMUM_ATTEMPTS, "5".into()),
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
    fn validates_retry_configuration_bounds() {
        for (variable, values) in [
            (
                MAXIMUM_ATTEMPTS,
                vec!["0", "11", "4294967295", "4294967296", "-1", "1.5"],
            ),
            (RETRY_DELAY_SECONDS, vec!["0", "43201", "-1"]),
        ] {
            for value in values {
                let mut config = valid();
                config.insert(variable, value.into());
                assert_eq!(load(&config).unwrap_err().variable, variable);
            }
        }
        for attempts in ["1", "10"] {
            for delay in ["1", "43200"] {
                let mut config = valid();
                config.insert(MAXIMUM_ATTEMPTS, attempts.into());
                config.insert(RETRY_DELAY_SECONDS, delay.into());
                load(&config).unwrap();
            }
        }
    }

    #[test]
    fn startup_requires_half_duration_heartbeat_margin() {
        for variable in [LEASE_DURATION_SECONDS, VISIBILITY_EXTENSION_SECONDS] {
            for (duration, accepted) in [(59, false), (60, true), (61, true)] {
                let mut values = valid();
                values.insert(variable, duration.to_string());
                assert_eq!(load(&values).is_ok(), accepted);
            }
        }
        let mut values = valid();
        values.insert(HEARTBEAT_INTERVAL_SECONDS, "119".into());
        values.insert(LEASE_DURATION_SECONDS, "120".into());
        values.insert(VISIBILITY_EXTENSION_SECONDS, "120".into());
        assert!(load(&values).is_err());
    }

    #[test]
    fn validates_heartbeat_configuration_without_exposing_values() {
        for variable in [
            HEARTBEAT_INTERVAL_SECONDS,
            VISIBILITY_EXTENSION_SECONDS,
            LEASE_DURATION_SECONDS,
        ] {
            for value in [
                "",
                "0",
                "-1",
                "1.5",
                "18446744073709551615",
                "18446744073709551616",
                "secret-invalid-value",
            ] {
                let mut values = valid();
                values.insert(variable, value.into());
                let error = load(&values).unwrap_err();
                assert_eq!(error.variable, variable);
                assert!(!error.to_string().contains("secret-invalid-value"));
                assert!(!format!("{error:?}").contains("password"));
            }
        }
        for lease in ["60", "43200"] {
            let mut values = valid();
            values.insert(LEASE_DURATION_SECONDS, lease.into());
            load(&values).unwrap();
        }
        for lease in ["30", "31", "59", "43201"] {
            let mut values = valid();
            values.insert(LEASE_DURATION_SECONDS, lease.into());
            assert!(load(&values).is_err());
        }
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
            HEARTBEAT_INTERVAL_SECONDS,
            VISIBILITY_EXTENSION_SECONDS,
            LEASE_DURATION_SECONDS,
            RETRY_DELAY_SECONDS,
            MAXIMUM_ATTEMPTS,
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

    fn load(values: &HashMap<&'static str, String>) -> Result<Config, ConfigError> {
        Config::from_lookup(|name| values.get(name).cloned())
    }

    #[test]
    fn trims_whitespace_and_rejects_blank_required_values() {
        let mut values = valid();
        values.insert(
            DATABASE_URL,
            "  postgres://user:password@localhost/video  ".into(),
        );
        values.insert(QUEUE_URL, "\thttps://sqs.example.test/queue\n".into());
        let config = load(&values).unwrap();
        assert_eq!(
            config.database_url,
            "postgres://user:password@localhost/video"
        );
        assert_eq!(config.queue_url, "https://sqs.example.test/queue");

        for variable in [
            DATABASE_URL,
            AWS_REGION,
            QUEUE_URL,
            INPUT_BUCKET,
            OUTPUT_BUCKET,
            FFMPEG_PATH,
            TEMPORARY_DIRECTORY,
        ] {
            let mut blank = valid();
            blank.insert(variable, "   ".into());
            let error = load(&blank).unwrap_err();
            assert_eq!(error.variable, variable, "{variable}");
            assert_eq!(error.reason, "is required");
        }
    }

    #[test]
    fn rejects_malformed_postgres_and_queue_urls() {
        for (variable, value, reason) in [
            (DATABASE_URL, "not-a-url", "is malformed"),
            (
                DATABASE_URL,
                "http://localhost/video",
                "must be a PostgreSQL URL",
            ),
            (DATABASE_URL, "postgres://", "must be a PostgreSQL URL"),
            (QUEUE_URL, "not-a-url", "is malformed"),
            (
                QUEUE_URL,
                "ftp://sqs.example.test/queue",
                "must be an HTTP(S) URL",
            ),
            (QUEUE_URL, "https://", "is malformed"),
            (QUEUE_URL, "file:///tmp/queue", "must be an HTTP(S) URL"),
        ] {
            let mut values = valid();
            values.insert(variable, value.into());
            let error = load(&values).unwrap_err();
            assert_eq!(error.variable, variable, "{variable}={value}");
            assert_eq!(error.reason, reason, "{variable}={value}");
        }

        let mut values = valid();
        values.insert(DATABASE_URL, "postgresql://localhost/video".into());
        load(&values).unwrap();
        values.insert(QUEUE_URL, "http://sqs.example.test/queue".into());
        load(&values).unwrap();
    }

    #[test]
    fn rejects_invalid_s3_bucket_names() {
        let too_long = "a".repeat(64);
        for bucket in [
            "ab",
            too_long.as_str(),
            "Video-input",
            "192.168.0.1",
            "foo..bar",
            "foo.-bar",
            "foo-.bar",
            "-leading",
            "trailing-",
            ".leading",
            "trailing.",
        ] {
            let mut values = valid();
            values.insert(INPUT_BUCKET, bucket.into());
            let error = load(&values).unwrap_err();
            assert_eq!(error.variable, INPUT_BUCKET, "{bucket}");
            assert_eq!(
                error.reason, "must be a valid lowercase S3 bucket name",
                "{bucket}"
            );
        }
    }
}
