use tracing::{error, info};

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

    info!(region = %config.aws_region, input_bucket = %config.input_bucket, output_bucket = %config.output_bucket, "worker started");
    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            if let Err(error) = result {
                error!(%error, "cancellation signal failed");
            }
            info!("worker shutting down");
        }
    }
}
