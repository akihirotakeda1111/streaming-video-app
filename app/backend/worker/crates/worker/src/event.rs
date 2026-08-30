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
    if !event_name.starts_with("ObjectCreated:") || event_name["ObjectCreated:".len()..].is_empty()
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

#[cfg(test)]
pub(crate) fn source_key(video_id: &str, job_id: &str) -> String {
    format!("videos/{video_id}/jobs/{job_id}/source.mp4")
}

#[cfg(test)]
pub(crate) fn records_notification(records: &[(&str, &str, &str)]) -> String {
    let encoded: Vec<String> = records
        .iter()
        .map(|(event_name, bucket, key)| {
            format!(
                r#"{{"eventName":"{event_name}","s3":{{"bucket":{{"name":"{bucket}"}},"object":{{"key":"{key}"}}}}}}"#
            )
        })
        .collect();
    format!(r#"{{"Records":[{}]}}"#, encoded.join(","))
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

    const FIXTURE: &str = include_str!("../../../../../contracts/examples/s3/object-created.json");
    const INPUT_BUCKET: &str = "streaming-video-input";
    const VIDEO_ID: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
    const JOB_ID: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
    const VIDEO_ID_2: &str = "018f47a2-45c2-7a84-b84f-5f6dd7b5910b";
    const JOB_ID_2: &str = "018f47a2-4699-7892-9fc0-fbe46d3bbd68";

    fn expected_work_item() -> WorkItem {
        work_item(VIDEO_ID, JOB_ID)
    }

    fn work_item(video_id: &str, job_id: &str) -> WorkItem {
        WorkItem {
            bucket: INPUT_BUCKET.to_owned(),
            key: source_key(video_id, job_id),
            video_id: video_id.into(),
            job_id: job_id.into(),
        }
    }

    fn notification(event_name: &str) -> String {
        records_notification(&[(event_name, INPUT_BUCKET, &source_key(VIDEO_ID, JOB_ID))])
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

    #[test]
    fn evaluates_every_record_independently() {
        let key = source_key(VIDEO_ID, JOB_ID);
        let key_2 = source_key(VIDEO_ID_2, JOB_ID_2);
        let body = records_notification(&[
            ("ObjectCreated:Put", INPUT_BUCKET, &key),
            ("ObjectCreated:Copy", INPUT_BUCKET, &key_2),
        ]);

        assert_eq!(
            parse_notification(&body, INPUT_BUCKET).unwrap(),
            [work_item(VIDEO_ID, JOB_ID), work_item(VIDEO_ID_2, JOB_ID_2)]
        );
    }

    #[test]
    fn invalid_records_do_not_suppress_later_valid_records() {
        let key = source_key(VIDEO_ID, JOB_ID);
        let key_2 = source_key(VIDEO_ID_2, JOB_ID_2);
        let malformed = "videos/not-a-uuid/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4";
        let extra = format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/extra/source.mp4");
        let wrong_suffix = format!("videos/{VIDEO_ID}/jobs/{JOB_ID}/source.mov");
        let body = records_notification(&[
            ("ObjectRemoved:Delete", INPUT_BUCKET, &key),
            ("ObjectCreated:Put", "other-bucket", &key),
            ("ObjectCreated:Put", INPUT_BUCKET, malformed),
            ("ObjectCreated:Put", INPUT_BUCKET, &extra),
            ("ObjectCreated:Put", INPUT_BUCKET, &wrong_suffix),
            ("ObjectCreated:Put", INPUT_BUCKET, &key),
            ("ObjectCreated:Post", INPUT_BUCKET, &key_2),
        ]);

        assert_eq!(
            parse_notification(&body, INPUT_BUCKET).unwrap(),
            [work_item(VIDEO_ID, JOB_ID), work_item(VIDEO_ID_2, JOB_ID_2)]
        );
    }

    #[test]
    fn rejects_malformed_uuids_wrong_prefix_suffix_and_extra_path_components() {
        for key in [
            "videos/018F47A2-45C2-7A84-B84F-5F6DD7B5910A/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4",
            "videos/not-a-uuid/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4",
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd6/source.mp4",
            "clips/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4",
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/job/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4",
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mov",
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4/extra",
            "videos/018f47a2-45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/extra/source.mp4",
        ] {
            assert_eq!(
                parse_notification(&notification_with_key(key), INPUT_BUCKET).unwrap(),
                [],
                "{key}"
            );
        }
    }

    fn notification_with_key(key: &str) -> String {
        records_notification(&[("ObjectCreated:Put", INPUT_BUCKET, key)])
    }

    #[test]
    fn form_decodes_plus_and_percent_encoding_before_validation() {
        let encoded = "videos/018f47a2%2d45c2%2d7a84%2db84f%2d5f6dd7b5910a/jobs/018f47a2%2d4699%2d7892%2d9fc0%2dfbe46d3bbd67/source%2emp4";
        assert_eq!(
            parse_notification(&notification_with_key(encoded), INPUT_BUCKET).unwrap(),
            [expected_work_item()]
        );

        let plus_rejected = "videos/018f47a2+45c2-7a84-b84f-5f6dd7b5910a/jobs/018f47a2-4699-7892-9fc0-fbe46d3bbd67/source.mp4";
        assert_eq!(
            parse_notification(&notification_with_key(plus_rejected), INPUT_BUCKET).unwrap(),
            []
        );
        assert_eq!(
            parse_notification(
                &notification_with_key("videos/%ZZ/jobs/x/source.mp4"),
                INPUT_BUCKET
            )
            .unwrap(),
            []
        );
    }

    #[test]
    fn test_event_is_not_an_encoding_request() {
        assert!(
            parse_notification(
                r#"{"Service":"Amazon S3","Event":"s3:TestEvent"}"#,
                INPUT_BUCKET
            )
            .is_err()
        );
    }
}
