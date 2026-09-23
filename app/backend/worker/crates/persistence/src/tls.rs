//! Parse the application's TLS policy before handing the URL to the driver.
use crate::PersistenceError;
use native_tls::{Certificate, TlsConnector};
use tokio_postgres::{Config, config::SslMode};

pub fn configuration(url: &str, local: bool) -> Result<(Config, Option<String>), PersistenceError> {
    let invalid = || PersistenceError("invalid database TLS configuration".into());
    let mut url = url::Url::parse(url).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "postgres" | "postgresql") || url.host_str().is_none() {
        return Err(invalid());
    }
    let mut mode = None;
    let mut ca = None;
    let mut remaining = Vec::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "sslmode" => {
                if mode.replace(value.into_owned()).is_some() {
                    return Err(invalid());
                }
            }
            "sslrootcert" => {
                if ca.replace(value.into_owned()).is_some() {
                    return Err(invalid());
                }
            }
            _ => remaining.push((key.into_owned(), value.into_owned())),
        }
    }
    let ssl = match mode.as_deref() {
        Some("disable") if local => SslMode::Disable,
        Some("verify-full") | Some("require") => SslMode::Require,
        _ => return Err(invalid()),
    };
    url.set_query(None);
    if !remaining.is_empty() {
        url.query_pairs_mut().extend_pairs(remaining);
    }
    let mut config: Config = url.as_str().parse().map_err(|_| invalid())?;
    config
        .ssl_mode(ssl)
        .connect_timeout(std::time::Duration::from_secs(10));
    Ok((config, ca))
}

pub fn connector(path: Option<&str>) -> Result<TlsConnector, PersistenceError> {
    let invalid = || PersistenceError("invalid database CA certificate".into());
    let mut builder = TlsConnector::builder();
    if let Some(path) = path.map(str::trim).filter(|p| !p.is_empty()) {
        let pem = std::fs::read_to_string(path).map_err(|_| invalid())?;
        // Parse every certificate: RDS bundles contain multiple trust roots.
        let mut remaining = pem.as_str();
        let mut count = 0;
        while !remaining.trim().is_empty() {
            remaining = remaining.trim_start();
            if !remaining.starts_with("-----BEGIN CERTIFICATE-----") {
                return Err(invalid());
            }
            let end = remaining
                .find("-----END CERTIFICATE-----")
                .ok_or_else(invalid)?
                + "-----END CERTIFICATE-----".len();
            builder.add_root_certificate(
                Certificate::from_pem(remaining[..end].as_bytes()).map_err(|_| invalid())?,
            );
            count += 1;
            remaining = &remaining[end..];
        }
        if count == 0 {
            return Err(invalid());
        }
    }
    builder.build().map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_policy_never_downgrades() {
        for mode in [
            "",
            "?sslmode=prefer",
            "?sslmode=disable",
            "?sslmode=verify-ca",
            "?sslmode=require&sslmode=disable",
        ] {
            assert!(
                configuration(&format!("postgres://user:secret@localhost/db{mode}"), false)
                    .is_err()
            );
        }
        for mode in ["require", "verify-full"] {
            let (config, ca) = configuration(
                &format!("postgres://localhost/db?sslmode={mode}&sslrootcert=%2Ftmp%2Fca.pem"),
                false,
            )
            .unwrap();
            assert_eq!(config.get_ssl_mode(), SslMode::Require);
            assert_eq!(ca.as_deref(), Some("/tmp/ca.pem"));
        }
        assert_eq!(
            configuration("postgres://localhost/db?sslmode=disable", true)
                .unwrap()
                .0
                .get_ssl_mode(),
            SslMode::Disable
        );
    }
    #[test]
    fn empty_ca_uses_system_roots_but_invalid_ca_fails() {
        for path in [None, Some(""), Some("  ")] {
            connector(path).unwrap();
        }
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(connector(file.path().to_str()).is_err());
        std::fs::write(file.path(), "not a certificate").unwrap();
        assert!(connector(file.path().to_str()).is_err());
    }
}
