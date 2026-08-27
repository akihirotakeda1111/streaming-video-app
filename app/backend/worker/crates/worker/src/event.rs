//! Parsing and validation of direct S3 notifications delivered by SQS.

use serde_json::Value;
use std::fmt;

/// The source object and identifiers extracted from one S3 notification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkItem {
    pub bucket: String,
    pub key: String,
    pub video_id: String,
    pub job_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventParseError(&'static str);

impl fmt::Display for EventParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for EventParseError {}

/// Parse all eligible records in an S3 event notification.
///
/// Invalid records are ignored so one malformed notification cannot suppress
/// other records in the same SQS message.
pub fn parse_notification(
    body: &str,
    configured_input_bucket: &str,
) -> Result<Vec<WorkItem>, EventParseError> {
    let event: Value = serde_json::from_str(body).map_err(|_| EventParseError("invalid JSON"))?;
    let records = event
        .get("Records")
        .and_then(Value::as_array)
        .ok_or(EventParseError("S3 notification Records must be an array"))?;

    Ok(records
        .iter()
        .filter_map(|record| parse_record(record, configured_input_bucket))
        .collect())
}

fn parse_record(record: &Value, configured_input_bucket: &str) -> Option<WorkItem> {
    let event_name = record.get("eventName")?.as_str()?;
    if !event_name.starts_with("ObjectCreated:")
        || event_name["ObjectCreated:".len()..].is_empty()
    {
        return None;
    }

    let bucket = record.get("s3")?.get("bucket")?.get("name")?.as_str()?;
    if bucket != configured_input_bucket {
        return None;
    }
    let encoded_key = record.get("s3")?.get("object")?.get("key")?.as_str()?;
    let key = form_decode(encoded_key).ok()?;
    let parts: Vec<&str> = key.split('/').collect();
    if parts.len() != 5
        || parts[0] != "videos"
        || parts[2] != "jobs"
        || parts[4] != "source.mp4"
        || !canonical_uuid(parts[1])
        || !canonical_uuid(parts[3])
    {
        return None;
    }

    let video_id = parts[1].to_owned();
    let job_id = parts[3].to_owned();

    Some(WorkItem {
        bucket: bucket.to_owned(),
        key,
        video_id,
        job_id,
    })
}

fn form_decode(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let high = hex_digit(bytes[index + 1])?;
                let low = hex_digit(bytes[index + 2])?;
                decoded.push(high << 4 | low);
                index += 2;
            }
            b'%' => return Err(()),
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn hex_digit(byte: u8) -> Result<u8, ()> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(()),
    }
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str =
        include_str!("../../../../../contracts/examples/s3/object-created.json");
    const INPUT_BUCKET: &str = "streaming-video-input";
    const SOURCE_KEY: &str =
        "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4";

    fn expected_work_item() -> WorkItem {
        WorkItem {
            bucket: INPUT_BUCKET.to_owned(),
            key: SOURCE_KEY.to_owned(),
            video_id: "018f47a2-45c2-7a84-b84f-5f6dd7b5910a".into(),
            job_id: "018f47a2-4699-7892-9fc0-fbe46d3bbd67".into(),
        }
    }

    fn notification(event_name: &str) -> String {
        format!(
            r#"{{"Records":[{{"eventName":"{event_name}","s3":{{"bucket":{{"name":"{INPUT_BUCKET}"}},"object":{{"key":"{SOURCE_KEY}"}}}}}}]}}"#
        )
    }

    #[test]
    fn canonical_fixture_produces_the_expected_work_item() {
        assert_eq!(
            parse_notification(FIXTURE, INPUT_BUCKET).unwrap(),
            [expected_work_item()]
        );
    }

    #[test]
    fn accepts_delivered_object_created_event_names() {
        for event_name in [
            "ObjectCreated:Put",
            "ObjectCreated:Post",
            "ObjectCreated:Copy",
            "ObjectCreated:CompleteMultipartUpload",
        ] {
            assert_eq!(
                parse_notification(&notification(event_name), INPUT_BUCKET).unwrap(),
                [expected_work_item()],
                "{event_name}"
            );
        }
    }

    #[test]
    fn rejects_configuration_prefixed_and_non_created_event_names() {
        for event_name in [
            "s3:ObjectCreated:Put",
            "ObjectCreated:",
            "ObjectRemoved:Delete",
        ] {
            assert_eq!(
                parse_notification(&notification(event_name), INPUT_BUCKET).unwrap(),
                [],
                "{event_name}"
            );
        }
    }
}
