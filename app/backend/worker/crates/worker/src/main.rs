use encoding::limits::BoundedExecutor;
use persistence::postgres::PostgresJobState;
use queue::sqs::SqsQueue;
use storage::s3::S3Storage;
use tokio::sync::watch;
use tracing::{error, info};
use worker::{
    acquisition::WorkerIdentityProvider, completion::MessageCompletionProcessor,
    heartbeat::HeartbeatSettings,
};

async fn shutdown_requested() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}

async fn supervise_database<T>(
    worker: impl std::future::Future<Output = T>,
    connection_stopped: impl std::future::Future<Output = ()>,
    stop: watch::Sender<bool>,
) -> Result<T, persistence::PersistenceError> {
    tokio::pin!(worker);
    tokio::select! {
        biased;
        _ = connection_stopped => {
            let _ = stop.send(true);
            // Let the runtime cancel and join in-flight work within its grace period.
            worker.await;
            Err(persistence::PersistenceError("postgres connection stopped; restart required".into()))
        }
        result = &mut worker => Ok(result),
    }
}

/// Starts the single bounded worker process.
#[tokio::main]
async fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .init();
    info!(
        duplicate_observation_schema = 1,
        heartbeat_observation_schema = 1,
        "worker observation capability"
    );

    let config = match worker::Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            error!(%error, "worker configuration rejected");
            std::process::exit(1);
        }
    };

    let queue = match SqsQueue::new(&config.aws_region, config.queue_url.clone()).await {
        Ok(queue) => queue,
        Err(error) => {
            error!(error = %error.0, "queue initialization failed");
            std::process::exit(1);
        }
    };
    let acknowledgements = match SqsQueue::new(&config.aws_region, config.queue_url.clone()).await {
        Ok(queue) => queue,
        Err(error) => {
            error!(error = %error.0, "queue acknowledgement initialization failed");
            std::process::exit(1);
        }
    };
    let jobs = match PostgresJobState::connect_with_tls(
        &config.database_url,
        config.runtime_mode == "local",
        std::env::var("DATABASE_CA_CERT_PATH").ok().as_deref(),
    )
    .await
    {
        Ok(jobs) => jobs,
        Err(error) => {
            error!(%error, "database initialization failed");
            std::process::exit(1);
        }
    };
    let connection_stopped = jobs.connection_stopped();
    let storage = match S3Storage::new(
        &config.aws_region,
        config.input_bucket.clone(),
        config.output_bucket.clone(),
    )
    .await
    {
        Ok(storage) => storage,
        Err(error) => {
            error!(error = %error.0, "storage initialization failed");
            std::process::exit(1);
        }
    };
    let heartbeat = match HeartbeatSettings::from_seconds(
        config.heartbeat_interval_seconds,
        config.lease_duration_seconds,
        config.visibility_extension_seconds,
    ) {
        Ok(settings) => settings,
        Err(error) => {
            error!(%error, "heartbeat configuration rejected");
            std::process::exit(1);
        }
    };
    let processor = match MessageCompletionProcessor::new(
        jobs,
        storage,
        BoundedExecutor {
            limits: config.limits.clone(),
        },
        acknowledgements,
        WorkerIdentityProvider::new().identity(),
        config.input_bucket.clone(),
        config.output_bucket.clone(),
        config.ffmpeg_path.clone(),
        config.temporary_directory.clone(),
        config.lease_duration_seconds,
        config.maximum_attempts,
        config.retry_delay_seconds,
        heartbeat,
    ) {
        Ok(processor) => processor.with_limits(config.limits.clone()),
        Err(error) => {
            error!(%error, "worker processing configuration rejected");
            std::process::exit(1);
        }
    };
    let (stop, shutdown) = watch::channel(false);
    let database_stop = stop.clone();
    tokio::spawn(async move {
        if let Err(error) = shutdown_requested().await {
            error!(%error, "cancellation signal failed");
            std::process::exit(1);
        }
        let _ = stop.send(true);
    });

    info!(region = %config.aws_region, queue_url = %config.queue_url, max_concurrency = config.max_concurrency, "worker started");
    let result = supervise_database(
        async {
            if config.runtime_mode == "local" {
                worker::runtime::run(queue, processor, shutdown, config.max_concurrency).await
            } else {
                let protection =
                    worker::protection::Agent::new(config.ecs_agent_uri.as_deref().unwrap())
                        .map_err(worker::runtime::RunError::Protection)?;
                worker::runtime::run_protected(
                    queue,
                    processor,
                    shutdown,
                    config.max_concurrency,
                    protection,
                )
                .await
            }
        },
        connection_stopped,
        database_stop,
    )
    .await;
    let result = result
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| error.to_string()));
    if let Err(error) = result {
        error!(%error, "worker stopped with an error");
        std::process::exit(1);
    }
    info!("worker shut down");
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "subprocess helper for real SIGTERM acceptance"]
    async fn signal_child() {
        use encoding::{Command, Execute, runtime::ProcessExecutor};
        use worker::runtime::MessageProcessor;
        #[derive(Clone)]
        struct Processor(String);
        impl MessageProcessor for Processor {
            type Error = std::convert::Infallible;
            async fn process(&self, _: queue::Message) -> Result<(), Self::Error> {
                ProcessExecutor
                    .execute(Command::new(
                        "/usr/bin/ffmpeg",
                        vec![
                            "-v".into(),
                            "error".into(),
                            "-re".into(),
                            "-f".into(),
                            "lavfi".into(),
                            "-i".into(),
                            "color=size=64x64:rate=10".into(),
                            "-t".into(),
                            "30".into(),
                            "-f".into(),
                            "null".into(),
                            self.0.clone(),
                        ],
                    ))
                    .await
                    .unwrap();
                panic!("unfinished encode must be cancelled");
            }
        }
        struct Receiver;
        impl queue::Receive for Receiver {
            async fn receive(&mut self) -> Result<Option<queue::Message>, queue::QueueError> {
                Ok(Some(queue::Message {
                    message_id: None,
                    delivery_id: String::new(),
                    receipt_handle: "unacked".into(),
                    body: String::new(),
                    receive_count: 1,
                    visibility_deadline: None,
                }))
            }
        }
        let (stop, shutdown) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            super::shutdown_requested().await.unwrap();
            stop.send_replace(true);
        });
        worker::runtime::run(
            Receiver,
            Processor(std::env::var("TEST_SIGNAL_OUTPUT").unwrap()),
            shutdown,
            1,
        )
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires FFmpeg and /proc; run tests/run-local.sh"]
    async fn sigterm_stops_receive_and_terminates_real_ffmpeg() {
        use std::{path::Path, time::Duration};
        let root = tempfile::tempdir().unwrap();
        let output_path = root.path().join("signal-output");
        let needle = output_path.to_string_lossy().into_owned();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "tests::signal_child"])
            .env("TEST_SIGNAL_OUTPUT", &output_path)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                for entry in std::fs::read_dir("/proc").unwrap().filter_map(Result::ok) {
                    if let Ok(cmd) = std::fs::read(entry.path().join("cmdline")) {
                        let cmd = String::from_utf8_lossy(&cmd);
                        if cmd.starts_with("/usr/bin/ffmpeg\0") && cmd.contains(&needle) {
                            return entry.file_name().to_string_lossy().parse::<u32>().unwrap();
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            std::process::Command::new("/bin/kill")
                .args(["-TERM", &child.id().unwrap().to_string()])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(6), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while Path::new(&format!("/proc/{pid}")).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("SIGTERM must terminate FFmpeg");
    }
    #[tokio::test]
    async fn normal_shutdown_does_not_require_database_disconnect() {
        let (stop, _) = tokio::sync::watch::channel(false);
        assert_eq!(
            super::supervise_database(async { 42 }, std::future::pending(), stop)
                .await
                .unwrap(),
            42
        );
    }

    #[tokio::test]
    async fn database_disconnect_cancels_work_and_returns_a_fatal_error() {
        let (stop, mut shutdown) = tokio::sync::watch::channel(false);
        let (disconnect, disconnected) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(super::supervise_database(
            async move {
                shutdown.changed().await.unwrap();
                assert!(*shutdown.borrow());
            },
            async move {
                let _ = disconnected.await;
            },
            stop,
        ));
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        disconnect.send(()).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }

    const DOCKERFILE: &str = include_str!("../../../Dockerfile");
    const README: &str = include_str!("../../../README.md");

    #[test]
    fn dockerfile_bundles_pinned_ffmpeg_and_ffprobe_for_an_unprivileged_worker() {
        assert!(DOCKERFILE.contains("FROM mwader/static-ffmpeg:7.1.1 AS media-tools"));
        assert!(DOCKERFILE.contains("COPY --from=media-tools /ffmpeg /usr/local/bin/ffmpeg"));
        assert!(DOCKERFILE.contains("COPY --from=media-tools /ffprobe /usr/local/bin/ffprobe"));
        assert!(DOCKERFILE.contains(
            "COPY --from=builder /source/target/release/worker /usr/local/bin/video-worker"
        ));
        assert!(DOCKERFILE.contains("ENV FFMPEG_PATH=/usr/local/bin/ffmpeg"));
        assert!(DOCKERFILE.contains("TMPDIR=/tmp/video-worker"));
        assert!(DOCKERFILE.contains("apt-get install -y --no-install-recommends ca-certificates"));
        assert!(DOCKERFILE.contains("/usr/local/bin/ffmpeg -version"));
        assert!(DOCKERFILE.contains("/usr/local/bin/ffprobe -version"));
        assert!(DOCKERFILE.contains("USER worker"));
        assert!(DOCKERFILE.contains("ENTRYPOINT [\"/usr/local/bin/video-worker\"]"));
    }

    #[test]
    fn documented_image_matches_startup_configuration() {
        assert!(README.contains("mwader/static-ffmpeg:7.1.1"));
        assert!(README.contains("/usr/local/bin/ffmpeg"));
        assert!(README.contains("ffprobe"));
        assert!(README.contains("FFMPEG_PATH"));
        assert!(README.contains("unprivileged `worker`"));
        let production = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source");
        assert!(production.contains("worker::Config::from_env"));
        assert!(production.contains("tracing_subscriber::fmt"));
        assert!(production.contains(".json()"));

        assert!(production.contains("MessageCompletionProcessor::new"));
        assert!(production.contains("BoundedExecutor"));
        assert!(production.contains("PostgresJobState::connect_with_tls"));
        assert!(!production.contains("block_on"));
        assert!(!production.contains("password"));
    }
}
