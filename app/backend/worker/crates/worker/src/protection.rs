//! ECS agent task protection. No AWS keys are sent to the agent endpoint.
use std::time::Duration;
use tokio::time::Instant;

pub trait Protection: Send {
    fn enabled(&self) -> bool {
        true
    }
    fn set(
        &mut self,
        enabled: bool,
    ) -> impl std::future::Future<Output = Result<Duration, String>> + Send;
}

pub struct Local;
impl Protection for Local {
    fn enabled(&self) -> bool {
        false
    }
    async fn set(&mut self, _: bool) -> Result<Duration, String> {
        Ok(Duration::from_secs(120))
    }
}

pub struct Agent {
    client: reqwest::Client,
    endpoint: url::Url,
}
impl Agent {
    pub fn new(uri: &str) -> Result<Self, String> {
        let mut endpoint = url::Url::parse(uri).map_err(|_| "invalid ECS_AGENT_URI")?;
        // ECS injects a link-local HTTP agent URI. Loopback supports local component tests.
        if endpoint.scheme() != "http"
            || !matches!(
                endpoint.host_str(),
                Some("169.254.170.2" | "127.0.0.1" | "localhost")
            )
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("invalid ECS_AGENT_URI".into());
        }
        // ECS_AGENT_URI includes the container-specific /api/<id> prefix.
        // Append segments rather than replacing the path or resolving an absolute URL.
        endpoint
            .path_segments_mut()
            .map_err(|_| "invalid ECS_AGENT_URI")?
            .pop_if_empty()
            .extend(["task-protection", "v1", "state"]);
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| "cannot initialize ECS protection")?;
        Ok(Self { client, endpoint })
    }
}
impl Protection for Agent {
    async fn set(&mut self, enabled: bool) -> Result<Duration, String> {
        let started = Instant::now();
        let mut response = self
            .client
            .put(self.endpoint.clone())
            .json(&serde_json::json!({"ProtectionEnabled": enabled, "ExpiresInMinutes": 2}))
            .send()
            .await
            .map_err(|_| "ECS protection request failed")?
            .error_for_status()
            .map_err(|_| "ECS protection HTTP failure")?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "ECS protection response failed")?
        {
            if bytes.len() + chunk.len() > 16384 {
                return Err("ECS protection response too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid ECS protection response")?;
        if value.get("error").is_some()
            || value.get("failure").is_some()
            || value["protection"]["ProtectionEnabled"].as_bool() != Some(enabled)
        {
            return Err("ECS protection was not confirmed".into());
        }
        if !enabled {
            return Ok(Duration::ZERO);
        }
        let expiry = value["protection"]["ExpirationDate"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .ok_or("invalid ECS protection expiration")?;
        let remaining = (expiry.with_timezone(&chrono::Utc) - chrono::Utc::now())
            .to_std()
            .map_err(|_| "ECS protection already expired")?;
        // Never trust an expiry longer than what this request asked for.
        let remaining = remaining.min(Duration::from_secs(120).saturating_sub(started.elapsed()));
        if remaining < Duration::from_secs(20) {
            return Err("ECS protection expiration too close".into());
        }
        Ok(remaining)
    }
}

pub async fn update<P: Protection>(protection: &mut P, enabled: bool) -> Result<Instant, String> {
    let remaining = tokio::time::timeout(Duration::from_secs(4), protection.set(enabled))
        .await
        .map_err(|_| "ECS protection timed out")??;
    if enabled && remaining < Duration::from_secs(20) {
        return Err("protection lifetime too short".into());
    }
    Ok(Instant::now() + remaining / 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn endpoint_preserves_agent_prefix_and_handles_trailing_slash() {
        for (base, expected) in [
            ("", "/task-protection/v1/state"),
            ("/", "/task-protection/v1/state"),
            ("/api/test-id", "/api/test-id/task-protection/v1/state"),
            ("/api/test-id/", "/api/test-id/task-protection/v1/state"),
        ] {
            let agent = Agent::new(&format!("http://169.254.170.2{base}")).unwrap();
            assert_eq!(agent.endpoint.path(), expected);
        }
    }

    #[test]
    fn prefixed_uri_retains_endpoint_validation() {
        for uri in [
            "https://169.254.170.2/api/test-id",
            "http://example.com/api/test-id",
            "http://user:password@169.254.170.2/api/test-id",
            "http://169.254.170.2/api/test-id?query=value",
            "http://169.254.170.2/api/test-id#fragment",
        ] {
            assert!(Agent::new(uri).is_err());
        }
    }
    #[tokio::test]
    async fn agent_validates_http_confirmation_and_expiry() {
        for (status, body, accepted) in [
            (
                200,
                serde_json::json!({"protection": {"ProtectionEnabled": true, "ExpirationDate": (chrono::Utc::now() + chrono::Duration::seconds(110)).to_rfc3339()}}),
                true,
            ),
            (
                200,
                serde_json::json!({"protection": {"ProtectionEnabled": true, "ExpirationDate": "2000-01-01T00:00:00Z"}}),
                false,
            ),
            (
                200,
                serde_json::json!({"failure": {"Reason": "TASK_NOT_VALID"}}),
                false,
            ),
            (500, serde_json::json!({}), false),
            (
                200,
                serde_json::json!({"protection": {"ProtectionEnabled": false}}),
                false,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 2048];
                loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                    if request.ends_with(b"}") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with("PUT /api/test-id/task-protection/v1/state HTTP/1.1"));
                assert!(request.contains("\"ProtectionEnabled\":true"));
                assert!(!request.to_lowercase().contains("authorization:"));
                let body = body.to_string();
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            assert_eq!(
                Agent::new(&format!("http://{address}/api/test-id"))
                    .unwrap()
                    .set(true)
                    .await
                    .is_ok(),
                accepted
            );
            server.await.unwrap();
        }
    }
}
