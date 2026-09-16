use persistence::postgres::PostgresJobState;

#[tokio::test]
#[ignore = "requires dedicated local TLS PostgreSQL; run tests/run-local.sh"]
async fn tls_database_validates_ca_hostname_and_expiration() {
    let url = std::env::var("TEST_TLS_DATABASE_URL").expect("explicit TLS test database required");
    let ca = std::env::var("TEST_TLS_CA_CERT").unwrap();
    PostgresJobState::connect_with_tls(&url, false, Some(&ca))
        .await
        .unwrap();
    let shared_url = format!(
        "{url}&sslrootcert={}",
        url::form_urlencoded::byte_serialize(ca.as_bytes()).collect::<String>()
    );
    PostgresJobState::connect_with_tls(&shared_url, false, Some(" "))
        .await
        .unwrap();
    let bundle = tempfile::NamedTempFile::new().unwrap();
    let cert = std::fs::read_to_string(&ca).unwrap();
    std::fs::write(bundle.path(), format!("{cert}\n{cert}")).unwrap();
    PostgresJobState::connect_with_tls(&url, false, bundle.path().to_str())
        .await
        .unwrap();
    for key in ["TEST_TLS_WRONG_HOST_URL", "TEST_TLS_EXPIRED_URL"] {
        let url = std::env::var(key).unwrap();
        assert!(
            PostgresJobState::connect_with_tls(&url, false, Some(&ca))
                .await
                .is_err(),
            "{key}"
        );
    }
    assert!(
        PostgresJobState::connect_with_tls(&url, false, None)
            .await
            .is_err(),
        "untrusted test CA"
    );
    let invalid = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(invalid.path(), "invalid CA").unwrap();
    assert!(
        PostgresJobState::connect_with_tls(&url, false, invalid.path().to_str())
            .await
            .is_err()
    );
    assert!(
        PostgresJobState::connect_with_tls(&url.replace("verify-full", "disable"), false, None)
            .await
            .is_err()
    );
}
