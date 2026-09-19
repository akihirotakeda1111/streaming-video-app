use crate::{
    protection::Protection,
    runtime::{MessageProcessor, run_protected},
};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<&'static str>>>);
impl Events {
    fn push(&self, event: &'static str) {
        self.0.lock().unwrap().push(event);
    }
}
struct Guard {
    events: Events,
    calls: usize,
    fail_on: usize,
}
impl Protection for Guard {
    async fn set(&mut self, enabled: bool) -> Result<Duration, String> {
        if enabled {
            self.calls += 1;
            self.events.push("protect");
            if self.calls == self.fail_on {
                return Err("unavailable".into());
            }
        } else {
            self.events.push("release");
        }
        Ok(Duration::from_secs(60))
    }
}
struct Receiver {
    events: Events,
    empty: bool,
    delivered: bool,
}
impl queue::Receive for Receiver {
    async fn receive(&mut self) -> Result<Option<queue::Message>, queue::QueueError> {
        self.events.push("receive");
        if self.empty {
            return Ok(None);
        }
        if self.delivered {
            return std::future::pending().await;
        }
        self.delivered = true;
        Ok(Some(queue::Message {
            message_id: None,
            delivery_id: String::new(),
            receipt_handle: "receipt".into(),
            body: String::new(),
            receive_count: 1,
            visibility_deadline: None,
            receive_started_at: None,
        }))
    }
}
#[derive(Clone)]
struct Processor(Events);
impl MessageProcessor for Processor {
    type Error = Infallible;
    async fn process(&self, _: queue::Message) -> Result<(), Infallible> {
        self.0.push("process");
        std::future::pending().await
    }
}

#[tokio::test(start_paused = true)]
async fn failed_acquisition_never_receives() {
    let events = Events::default();
    let (_stop, shutdown) = watch::channel(false);
    let result = run_protected(
        Receiver {
            events: events.clone(),
            empty: false,
            delivered: false,
        },
        Processor(events.clone()),
        shutdown,
        1,
        Guard {
            events: events.clone(),
            calls: 0,
            fail_on: 1,
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(*events.0.lock().unwrap(), ["protect"]);
}

#[tokio::test(start_paused = true)]
async fn renewal_failure_cancels_work_before_releasing() {
    for concurrency in [1, 2] {
        let events = Events::default();
        let (_stop, shutdown) = watch::channel(false);
        let result = run_protected(
            Receiver {
                events: events.clone(),
                empty: false,
                delivered: false,
            },
            Processor(events.clone()),
            shutdown,
            concurrency,
            Guard {
                events: events.clone(),
                calls: 0,
                fail_on: 2,
            },
        )
        .await;
        assert!(result.is_err());
        let events = events.0.lock().unwrap();
        assert_eq!(events.first(), Some(&"protect"));
        assert_eq!(events.last(), Some(&"release"));
        assert_eq!(events.iter().filter(|e| **e == "protect").count(), 2);
        assert_eq!(
            events.iter().filter(|e| **e == "receive").count(),
            concurrency
        );
        assert_eq!(events.iter().filter(|e| **e == "process").count(), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn empty_receive_releases_for_idle_interval_then_reacquires() {
    let events = Events::default();
    let (_stop, shutdown) = watch::channel(false);
    let started = tokio::time::Instant::now();
    let result = run_protected(
        Receiver {
            events: events.clone(),
            empty: true,
            delivered: false,
        },
        Processor(events.clone()),
        shutdown,
        1,
        Guard {
            events: events.clone(),
            calls: 0,
            fail_on: 2,
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(started.elapsed(), Duration::from_secs(10));
    assert_eq!(
        *events.0.lock().unwrap(),
        ["protect", "receive", "release", "protect"]
    );
}

#[tokio::test(start_paused = true)]
async fn pending_receive_retains_protection_and_shutdown_releases() {
    let events = Events::default();
    let (stop, shutdown) = watch::channel(false);
    let task = tokio::spawn(run_protected(
        Receiver {
            events: events.clone(),
            empty: false,
            delivered: true,
        },
        Processor(events.clone()),
        shutdown,
        1,
        Guard {
            events: events.clone(),
            calls: 0,
            fail_on: 0,
        },
    ));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::task::yield_now().await;
    assert_eq!(*events.0.lock().unwrap(), ["protect", "receive", "protect"]);
    stop.send_replace(true);
    task.await.unwrap().unwrap();
    assert_eq!(events.0.lock().unwrap().last(), Some(&"release"));
}
