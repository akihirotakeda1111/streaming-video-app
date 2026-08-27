use std::convert::Infallible;

use queue::{Message, sqs::SqsQueue};
use tokio::sync::watch;
use tracing::{error, info, warn};
use worker::runtime::{MessageProcessor, PHASE1_MAX_CONCURRENCY};

#[derive(Clone)]
struct Phase1Processor;

impl MessageProcessor for Phase1Processor {
    type Error = Infallible;

    async fn process(&self, _message: Message) -> Result<(), Self::Error> {
        // Phase 1 task 23 intentionally stops at the replaceable dispatch
        // boundary. A later task owns parsing, processing, and deletion.
        warn!("message dispatched; processing pipeline is not installed");
        Ok(())
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
    let (stop, shutdown) = watch::channel(false);
    tokio::spawn(async move {
        if let Err(error) = tokio::signal::ctrl_c().await {
            error!(%error, "cancellation signal failed");
        }
        let _ = stop.send(true);
    });

    info!(region = %config.aws_region, queue_url = %config.queue_url, max_concurrency = PHASE1_MAX_CONCURRENCY, "worker started");
    if let Err(error) =
        worker::runtime::run(queue, Phase1Processor, shutdown, PHASE1_MAX_CONCURRENCY).await
    {
        error!(%error, "worker stopped with an error");
        std::process::exit(1);
    }
    info!("worker shut down");
}
