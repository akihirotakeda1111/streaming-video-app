//! Bounded, cancellation-aware message dispatch for one Phase 1 worker.

use std::{error::Error, fmt, future::Future};

use queue::{Message, QueueError, Receive};
use tokio::{sync::watch, task::JoinSet};

/// The maximum number of messages processed by one Phase 1 deployment.
pub const PHASE1_MAX_CONCURRENCY: usize = 2;

/// Replaceable boundary between message receipt and the future job pipeline.
pub trait MessageProcessor: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn process(
        &self,
        message: Message,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static;
}

#[derive(Debug)]
pub enum RunError<E> {
    Receive(QueueError),
    Process(E),
    Task(tokio::task::JoinError),
}

impl<E: fmt::Display> fmt::Display for RunError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Receive(error) => write!(formatter, "receive message: {}", error.0),
            Self::Process(error) => write!(formatter, "process message: {error}"),
            Self::Task(error) => write!(formatter, "message task: {error}"),
        }
    }
}

impl<E: Error + 'static> Error for RunError<E> {}

/// Long-polls until cancellation or an error. Cancellation stops new receives,
/// then waits for the explicitly bounded set of in-flight tasks to finish.
/// Receipt never implies deletion; only the downstream processor receives the
/// message (including its receipt handle).
pub async fn run<R, P>(
    mut receiver: R,
    processor: P,
    mut shutdown: watch::Receiver<bool>,
    max_concurrency: usize,
) -> Result<(), RunError<P::Error>>
where
    R: Receive + Send,
    P: MessageProcessor,
{
    assert!(max_concurrency > 0, "worker concurrency must be nonzero");
    let mut tasks = JoinSet::new();
    let mut result = Ok(());

    'receiving: loop {
        if *shutdown.borrow() {
            break;
        }

        while tasks.len() >= max_concurrency {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break 'receiving,
                completed = tasks.join_next() => {
                    if let Some(completed) = completed {
                        record_completion(completed, &mut result);
                        if result.is_err() { break 'receiving; }
                    }
                }
            }
        }

        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            received = receiver.receive() => match received {
                Ok(Some(message)) => {
                    let message_processor = processor.clone();
                    tasks.spawn(async move { message_processor.process(message).await });
                }
                Ok(None) => tokio::task::yield_now().await,
                Err(error) => {
                    result = Err(RunError::Receive(error));
                    break;
                }
            }
        }
    }

    while let Some(completed) = tasks.join_next().await {
        record_completion(completed, &mut result);
    }
    result
}

fn record_completion<E>(
    completed: Result<Result<(), E>, tokio::task::JoinError>,
    result: &mut Result<(), RunError<E>>,
) {
    if result.is_ok() {
        *result = match completed {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(RunError::Process(error)),
            Err(error) => Err(RunError::Task(error)),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        convert::Infallible,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tokio::sync::Notify;

    struct ScriptedReceiver {
        replies: VecDeque<Result<Option<Message>, QueueError>>,
        calls: Arc<AtomicUsize>,
    }

    impl Receive for ScriptedReceiver {
        async fn receive(&mut self) -> Result<Option<Message>, QueueError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.replies.pop_front() {
                Some(reply) => reply,
                None => std::future::pending().await,
            }
        }
    }

    #[derive(Clone, Default)]
    struct RecordingProcessor(Arc<std::sync::Mutex<Vec<String>>>);

    impl MessageProcessor for RecordingProcessor {
        type Error = Infallible;

        async fn process(&self, message: Message) -> Result<(), Self::Error> {
            self.0.lock().unwrap().push(message.body);
            Ok(())
        }
    }

    fn message(body: &str) -> Message {
        Message {
            receipt_handle: format!("receipt-{body}"),
            body: body.into(),
        }
    }

    #[tokio::test]
    async fn empty_receives_continue_long_polling() {
        let calls = Arc::new(AtomicUsize::new(0));
        let receiver = ScriptedReceiver {
            replies: VecDeque::from([Ok(None)]),
            calls: calls.clone(),
        };
        let (_stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(run(receiver, RecordingProcessor::default(), shutdown, 1));
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
    }

    #[tokio::test]
    async fn dispatches_received_messages_without_deleting_them() {
        let receiver = ScriptedReceiver {
            replies: VecDeque::from([Ok(Some(message("one")))]),
            calls: Arc::new(AtomicUsize::new(0)),
        };
        let processor = RecordingProcessor::default();
        let recorded = processor.0.clone();
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(run(receiver, processor, shutdown, 1));
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while recorded.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(*recorded.lock().unwrap(), ["one"]);
    }

    #[tokio::test]
    async fn cancellation_stops_a_pending_receive() {
        let calls = Arc::new(AtomicUsize::new(0));
        let receiver = ScriptedReceiver {
            replies: VecDeque::new(),
            calls: calls.clone(),
        };
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(run(receiver, RecordingProcessor::default(), shutdown, 1));
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        stop.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn receive_failures_are_returned_without_retrying() {
        let calls = Arc::new(AtomicUsize::new(0));
        let receiver = ScriptedReceiver {
            replies: VecDeque::from([Err(QueueError("unavailable".into()))]),
            calls: calls.clone(),
        };
        let (_stop, shutdown) = watch::channel(false);
        let error = run(receiver, RecordingProcessor::default(), shutdown, 1)
            .await
            .unwrap_err();
        assert!(
            matches!(error, RunError::Receive(QueueError(message)) if message == "unavailable")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[derive(Clone)]
    struct GatedProcessor {
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
        gate: Arc<Notify>,
    }

    impl MessageProcessor for GatedProcessor {
        type Error = Infallible;
        async fn process(&self, _message: Message) -> Result<(), Self::Error> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            self.gate.notified().await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn concurrency_never_exceeds_the_configured_bound() {
        let calls = Arc::new(AtomicUsize::new(0));
        let receiver = ScriptedReceiver {
            replies: (0..5).map(|n| Ok(Some(message(&n.to_string())))).collect(),
            calls: calls.clone(),
        };
        let processor = GatedProcessor {
            active: Arc::new(AtomicUsize::new(0)),
            maximum: Arc::new(AtomicUsize::new(0)),
            gate: Arc::new(Notify::new()),
        };
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(run(receiver, processor.clone(), shutdown, 2));
        while processor.active.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(processor.maximum.load(Ordering::SeqCst), 2);
        stop.send(true).unwrap();
        processor.gate.notify_waiters();
        task.await.unwrap().unwrap();
    }
}
