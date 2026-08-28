use encoding::runtime::ProcessExecutor;
use persistence::postgres::PostgresJobState;
use queue::sqs::SqsQueue;
use storage::s3::S3Storage;
use tokio::sync::watch;
use tracing::{error, info};
use worker::runtime::PHASE1_MAX_CONCURRENCY;
use worker::terminal::TerminalProcessor;

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

/// Starts the single bounded Phase 1 worker process.
#[tokio::main]
async fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .init();

    let config = match worker::Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            error!(%error, "worker configuration rejected");
            std::process::exit(1);
        }
    };

    let queue = match SqsQueue::new(&config.aws_region, config.queue_url.clone()) {
        Ok(queue) => queue,
        Err(error) => {
            error!(error = %error.0, "queue initialization failed");
            std::process::exit(1);
        }
    };
    let acknowledgements = match SqsQueue::new(&config.aws_region, config.queue_url.clone()) {
        Ok(queue) => queue,
        Err(error) => {
            error!(error = %error.0, "queue acknowledgement initialization failed");
            std::process::exit(1);
        }
    };
    let jobs = match PostgresJobState::connect(&config.database_url) {
        Ok(jobs) => jobs,
        Err(error) => {
            error!(%error, "database initialization failed");
            std::process::exit(1);
        }
    };
    let storage = match S3Storage::new(
        &config.aws_region,
        config.input_bucket.clone(),
        config.output_bucket.clone(),
    ) {
        Ok(storage) => storage,
        Err(error) => {
            error!(error = %error.0, "storage initialization failed");
            std::process::exit(1);
        }
    };
    let processor = TerminalProcessor::new(
        jobs,
        storage,
        ProcessExecutor,
        acknowledgements,
        config.input_bucket.clone(),
        config.output_bucket.clone(),
        config.ffmpeg_path.clone(),
        config.temporary_directory.clone(),
    );
    let (stop, shutdown) = watch::channel(false);
    tokio::spawn(async move {
        if let Err(error) = shutdown_requested().await {
            error!(%error, "cancellation signal failed");
            std::process::exit(1);
        }
        let _ = stop.send(true);
    });

    info!(region = %config.aws_region, queue_url = %config.queue_url, max_concurrency = PHASE1_MAX_CONCURRENCY, "worker started");
    if let Err(error) =
        worker::runtime::run(queue, processor, shutdown, PHASE1_MAX_CONCURRENCY).await
    {
        error!(%error, "worker stopped with an error");
        std::process::exit(1);
    }
    info!("worker shut down");
}

#[cfg(test)]
mod tests {
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
        assert!(
            DOCKERFILE
                .contains("/usr/local/bin/ffmpeg -version && /usr/local/bin/ffprobe -version")
        );
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
        assert!(production.contains("PHASE1_MAX_CONCURRENCY"));
        assert!(production.contains("TerminalProcessor::new"));
        assert!(production.contains("ProcessExecutor"));
        assert!(!production.contains("password"));
    }
}
