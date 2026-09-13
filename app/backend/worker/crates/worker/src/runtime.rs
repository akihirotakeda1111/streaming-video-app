//! Bounded, cancellation-aware message dispatch for one Phase 1 worker.

use std::{error::Error, fmt, future::Future, time::Duration};

use queue::{Message, QueueError, Receive};
use tokio::{sync::watch, task::JoinSet};
use uuid::Uuid;

/// The maximum number of messages processed by one Phase 1 deployment.
pub const PHASE1_MAX_CONCURRENCY: usize = 2;

/// Time allowed for processors to cancel and join their owned tasks.
pub const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(5);

pub(crate) async fn cancellation_requested(shutdown: &mut watch::Receiver<bool>) {
    while !*shutdown.borrow_and_update() {
        if shutdown.changed().await.is_err() {
            return;
        }
    }
}

/// Replaceable boundary between message receipt and the future job pipeline.
pub trait MessageProcessor: Clone + Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn process(&self, message: Message) -> impl Future<Output = Result<(), Self::Error>> + Send;

    fn process_with_shutdown(
        &self,
        message: Message,
        mut shutdown: watch::Receiver<bool>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async move {
            tokio::select! {
                biased;
                _ = cancellation_requested(&mut shutdown) => Ok(()),
                result = self.process(message) => result,
            }
        }
    }
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
/// then cancels in-flight work and bounds the time allowed for cleanup.
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
    let (stop_processing, processing_shutdown) = watch::channel(false);

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

        // A successful processor completion must not cancel ReceiveMessage:
        // SQS may already have counted the receive and hidden the message.
        // Keep the same request alive while reaping completed processors.
        // Shutdown or a fatal error still cancels it; any accepted message
        // remains undeleted and becomes available after visibility expires.
        let receive = receiver.receive();
        tokio::pin!(receive);
        let received = loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break 'receiving,
                completed = tasks.join_next(), if !tasks.is_empty() => {
                    if let Some(completed) = completed {
                        record_completion(completed, &mut result);
                        if result.is_err() {
                            break 'receiving;
                        }
                    }
                }
                received = &mut receive => break received,
            }
        };
        match received {
            Ok(Some(message)) => {
                let mut message = message;
                message.delivery_id = Uuid::new_v4().to_string();
                let message_processor = processor.clone();
                let shutdown = processing_shutdown.clone();
                tasks.spawn(async move {
                    message_processor
                        .process_with_shutdown(message, shutdown)
                        .await
                });
            }
            Ok(None) => tokio::task::yield_now().await,
            Err(error) => {
                result = Err(RunError::Receive(error));
                break;
            }
        }
    }

    stop_processing.send_replace(true);
    let drained = tokio::time::timeout(SHUTDOWN_GRACE_PERIOD, async {
        while let Some(completed) = tasks.join_next().await {
            record_completion(completed, &mut result);
        }
    })
    .await;
    if drained.is_err() {
        tracing::warn!("worker shutdown grace period exceeded; aborting remaining messages");
        tasks.abort_all();
        while let Some(completed) = tasks.join_next().await {
            if matches!(&completed, Err(error) if error.is_cancelled()) {
                continue;
            }
            record_completion(completed, &mut result);
        }
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
        error::Error,
        fmt,
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
            message_id: None,
            delivery_id: "delivery-test".into(),
            receipt_handle: format!("receipt-{body}"),
            body: body.into(),
            receive_count: 1,
            visibility_deadline: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn completed_processor_does_not_cancel_an_in_flight_receive() {
        struct PendingReceive(Option<Arc<AtomicUsize>>);
        impl Drop for PendingReceive {
            fn drop(&mut self) {
                if let Some(cancelled) = &self.0 {
                    cancelled.fetch_add(1, Ordering::SeqCst);
                }
            }
        }

        struct DelayedReceiver {
            calls: usize,
            first_can_finish: Arc<Notify>,
            cancelled: Arc<AtomicUsize>,
        }
        impl Receive for DelayedReceiver {
            async fn receive(&mut self) -> Result<Option<Message>, QueueError> {
                self.calls += 1;
                match self.calls {
                    1 => Ok(Some(message("first"))),
                    2 => {
                        // SQS has accepted this request, but its response has
                        // not arrived when the previous processor completes.
                        let mut pending = PendingReceive(Some(self.cancelled.clone()));
                        self.first_can_finish.notify_one();
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        pending.0 = None;
                        Ok(Some(message("second")))
                    }
                    _ => std::future::pending().await,
                }
            }
        }

        #[derive(Clone)]
        struct Processor {
            first_can_finish: Arc<Notify>,
            recorded: Arc<std::sync::Mutex<Vec<String>>>,
            second_processed: Arc<Notify>,
        }
        impl MessageProcessor for Processor {
            type Error = Infallible;
            async fn process(&self, message: Message) -> Result<(), Self::Error> {
                if message.body == "first" {
                    self.first_can_finish.notified().await;
                }
                self.recorded.lock().unwrap().push(message.body.clone());
                if message.body == "second" {
                    self.second_processed.notify_one();
                }
                Ok(())
            }
        }

        let first_can_finish = Arc::new(Notify::new());
        let cancelled = Arc::new(AtomicUsize::new(0));
        let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
        let second_processed = Arc::new(Notify::new());
        let receiver = DelayedReceiver {
            calls: 0,
            first_can_finish: first_can_finish.clone(),
            cancelled: cancelled.clone(),
        };
        let processor = Processor {
            first_can_finish,
            recorded: recorded.clone(),
            second_processed: second_processed.clone(),
        };
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(run(receiver, processor, shutdown, 2));
        let delivered =
            tokio::time::timeout(Duration::from_secs(2), second_processed.notified()).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert_eq!(cancelled.load(Ordering::SeqCst), 0);
        assert!(
            delivered.is_ok(),
            "the pending response must reach its processor"
        );
        assert_eq!(*recorded.lock().unwrap(), ["first", "second"]);
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

    #[tokio::test(start_paused = true)]
    async fn shutdown_aborts_and_joins_a_processor_that_ignores_cancellation() {
        #[derive(Clone)]
        struct StuckProcessor(Arc<AtomicUsize>);
        struct Active(Arc<AtomicUsize>);
        impl Drop for Active {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        impl MessageProcessor for StuckProcessor {
            type Error = Infallible;

            async fn process(&self, _: Message) -> Result<(), Self::Error> {
                self.0.fetch_add(1, Ordering::SeqCst);
                let _active = Active(self.0.clone());
                std::future::pending().await
            }

            async fn process_with_shutdown(
                &self,
                message: Message,
                _: watch::Receiver<bool>,
            ) -> Result<(), Self::Error> {
                self.process(message).await
            }
        }

        let active = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let receiver = ScriptedReceiver {
            replies: VecDeque::from([Ok(Some(message("one")))]),
            calls: calls.clone(),
        };
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(run(receiver, StuckProcessor(active.clone()), shutdown, 1));
        while active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        stop.send(true).unwrap();
        let started = tokio::time::Instant::now();
        tokio::time::timeout(SHUTDOWN_GRACE_PERIOD + Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(started.elapsed(), SHUTDOWN_GRACE_PERIOD);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn process_failures_are_returned_below_the_concurrency_limit() {
        #[derive(Clone, Debug)]
        struct ProcessFailure(&'static str);

        impl fmt::Display for ProcessFailure {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.0)
            }
        }

        impl Error for ProcessFailure {}

        #[derive(Clone)]
        struct FailingProcessor;

        impl MessageProcessor for FailingProcessor {
            type Error = ProcessFailure;

            async fn process(&self, _message: Message) -> Result<(), Self::Error> {
                Err(ProcessFailure("encode failed"))
            }
        }

        let receiver = ScriptedReceiver {
            replies: VecDeque::from([Ok(Some(message("one")))]),
            calls: Arc::new(AtomicUsize::new(0)),
        };
        let (_stop, shutdown) = watch::channel(false);
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            run(receiver, FailingProcessor, shutdown, 2),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(
            matches!(error, RunError::Process(ProcessFailure(message)) if message == "encode failed")
        );
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

    #[tokio::test]
    async fn panicking_task_is_returned_as_a_task_error() {
        #[derive(Clone)]
        struct PanicProcessor;

        impl MessageProcessor for PanicProcessor {
            type Error = Infallible;

            async fn process(&self, _message: Message) -> Result<(), Self::Error> {
                panic!("encode task panicked");
            }
        }

        let receiver = ScriptedReceiver {
            replies: VecDeque::from([Ok(Some(message("one")))]),
            calls: Arc::new(AtomicUsize::new(0)),
        };
        let (_stop, shutdown) = watch::channel(false);
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            run(receiver, PanicProcessor, shutdown, 1),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(
            matches!(error, RunError::Task(ref join) if join.is_panic()),
            "{error}"
        );
    }
}
