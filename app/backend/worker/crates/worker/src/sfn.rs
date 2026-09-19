//! Step Functions adapter for the parent execution client.

use std::{future::Future, pin::Pin};

use aws_sdk_sfn::{
    Client, error::ProvideErrorMetadata, types::ExecutionStatus as AwsExecutionStatus,
    types::HistoryEventType,
};

use crate::orchestration::{
    ExecutionClient, ExecutionInput, ExecutionInspection, ExecutionStatus, OrchestrationError,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum SfnApiError {
    AlreadyExists,
    NotFound,
    Permission,
    Unavailable,
}

#[derive(Clone)]
struct DescribedExecution {
    status: ExecutionStatus,
    input_json: String,
}

trait StepFunctionsApi: Send + Sync {
    fn start_execution(
        &self,
        state_machine_arn: &str,
        name: &str,
        input: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SfnApiError>> + Send + '_>>;
    fn describe_execution(
        &self,
        execution_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<DescribedExecution, SfnApiError>> + Send + '_>>;
    fn stop_execution(&self, execution_arn: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    fn running_child_count(
        &self,
        execution_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<usize, SfnApiError>> + Send + '_>>;
}

#[derive(Clone)]
pub struct AwsSfnApi {
    client: Client,
}

impl StepFunctionsApi for AwsSfnApi {
    fn start_execution(
        &self,
        state_machine_arn: &str,
        name: &str,
        input: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SfnApiError>> + Send + '_>> {
        let state_machine_arn = state_machine_arn.to_owned();
        let name = name.to_owned();
        let input = input.to_owned();
        Box::pin(async move {
            self.client
                .start_execution()
                .state_machine_arn(state_machine_arn)
                .name(name)
                .input(input)
                .send()
                .await
                .map(|_| ())
                .map_err(map_sdk_error)
        })
    }

    fn describe_execution(
        &self,
        execution_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<DescribedExecution, SfnApiError>> + Send + '_>> {
        let execution_arn = execution_arn.to_owned();
        Box::pin(async move {
            let response = self
                .client
                .describe_execution()
                .execution_arn(execution_arn)
                .send()
                .await
                .map_err(map_sdk_error)?;
            Ok(DescribedExecution {
                status: map_status(response.status),
                input_json: response.input.unwrap_or_default(),
            })
        })
    }

    fn stop_execution(&self, execution_arn: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let execution_arn = execution_arn.to_owned();
        Box::pin(async move {
            let _ = self
                .client
                .stop_execution()
                .execution_arn(execution_arn)
                .send()
                .await;
        })
    }

    fn running_child_count(
        &self,
        execution_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<usize, SfnApiError>> + Send + '_>> {
        let execution_arn = execution_arn.to_owned();
        Box::pin(async move {
            let mut next_token = None;
            let mut started = 0usize;
            let mut confirmed_stopped = 0usize;
            loop {
                let mut request = self
                    .client
                    .get_execution_history()
                    .execution_arn(&execution_arn)
                    .include_execution_data(false)
                    .max_results(1000);
                if let Some(token) = &next_token {
                    request = request.next_token(token);
                }
                let response = request.send().await.map_err(map_sdk_error)?;
                for event in response.events() {
                    account_task_event(event.r#type(), &mut started, &mut confirmed_stopped);
                }
                next_token = response.next_token().map(str::to_owned);
                if next_token.is_none() {
                    break;
                }
            }
            Ok(started.saturating_sub(confirmed_stopped))
        })
    }
}

/// Production Step Functions client. Start uses the caller-supplied name and
/// input only; recovery of ambiguous starts is owned by the orchestration bridge.
#[derive(Clone)]
pub struct SfnExecutionClient<A = AwsSfnApi> {
    state_machine_arn: String,
    api: A,
}

impl SfnExecutionClient<AwsSfnApi> {
    pub async fn new(
        region: &str,
        state_machine_arn: impl Into<String>,
    ) -> Result<Self, OrchestrationError> {
        let state_machine_arn = state_machine_arn.into();
        execution_arn(&state_machine_arn, "probe")?;
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_owned()))
            .load()
            .await;
        Ok(Self {
            state_machine_arn,
            api: AwsSfnApi {
                client: Client::new(&config),
            },
        })
    }
}

impl<A: StepFunctionsApi> ExecutionClient for SfnExecutionClient<A> {
    fn start(
        &self,
        name: &str,
        input: &ExecutionInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), OrchestrationError>> + Send + '_>> {
        let name = name.to_owned();
        let payload = match input.payload_json() {
            Ok(payload) => payload,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        Box::pin(async move {
            match self
                .api
                .start_execution(&self.state_machine_arn, &name, &payload)
                .await
            {
                Ok(()) => Ok(()),
                Err(SfnApiError::AlreadyExists) => {
                    Err(OrchestrationError::Start("already exists".into()))
                }
                Err(SfnApiError::Permission) => Err(OrchestrationError::Permission),
                Err(_) => Err(OrchestrationError::Start("unavailable".into())),
            }
        })
    }

    fn status(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionStatus, OrchestrationError>> + Send + '_>>
    {
        let name = name.to_owned();
        Box::pin(async move {
            match self.inspect(&name).await? {
                ExecutionInspection::Found { status, .. } => Ok(status),
                ExecutionInspection::NotFound => Err(OrchestrationError::Describe(
                    "execution was not found".into(),
                )),
            }
        })
    }

    fn inspect(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<ExecutionInspection, OrchestrationError>> + Send + '_>>
    {
        let name = name.to_owned();
        Box::pin(async move {
            let execution_arn = execution_arn(&self.state_machine_arn, &name)?;
            match self.api.describe_execution(&execution_arn).await {
                Ok(described) => Ok(ExecutionInspection::Found {
                    status: described.status,
                    input_json: described.input_json,
                }),
                Err(SfnApiError::NotFound) => Ok(ExecutionInspection::NotFound),
                Err(SfnApiError::Permission) => Err(OrchestrationError::Permission),
                Err(_) => Err(OrchestrationError::Describe("unavailable".into())),
            }
        })
    }

    fn cancel(&self, name: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let name = name.to_owned();
        Box::pin(async move {
            if let Ok(execution_arn) = execution_arn(&self.state_machine_arn, &name) {
                self.api.stop_execution(&execution_arn).await;
            }
        })
    }

    fn residual_running_children(
        &self,
        name: &str,
    ) -> Pin<Box<dyn Future<Output = Result<usize, OrchestrationError>> + Send + '_>> {
        let name = name.to_owned();
        Box::pin(async move {
            let execution_arn = execution_arn(&self.state_machine_arn, &name)?;
            match self.api.running_child_count(&execution_arn).await {
                Ok(count) => Ok(count),
                Err(SfnApiError::NotFound) => Ok(0),
                Err(SfnApiError::Permission) => Err(OrchestrationError::Permission),
                Err(_) => Err(OrchestrationError::Describe(
                    "residual children could not be inspected".into(),
                )),
            }
        })
    }
}

fn account_task_event(
    event_type: &HistoryEventType,
    started: &mut usize,
    confirmed_stopped: &mut usize,
) {
    match event_type {
        HistoryEventType::TaskStarted => *started += 1,
        HistoryEventType::TaskSucceeded | HistoryEventType::TaskFailed => {
            *confirmed_stopped += 1;
        }
        _ => {}
    }
}

#[cfg(test)]
fn residual_running_from_task_events<'a>(
    types: impl IntoIterator<Item = &'a HistoryEventType>,
) -> usize {
    let mut started = 0usize;
    let mut confirmed_stopped = 0usize;
    for event_type in types {
        account_task_event(event_type, &mut started, &mut confirmed_stopped);
    }
    started.saturating_sub(confirmed_stopped)
}

fn execution_arn(state_machine_arn: &str, name: &str) -> Result<String, OrchestrationError> {
    let Some((prefix, state_machine_name)) = state_machine_arn.rsplit_once(":stateMachine:") else {
        return Err(OrchestrationError::Start(
            "invalid state machine arn".into(),
        ));
    };
    Ok(format!("{prefix}:execution:{state_machine_name}:{name}"))
}

fn map_status(status: AwsExecutionStatus) -> ExecutionStatus {
    match status {
        AwsExecutionStatus::Succeeded => ExecutionStatus::Succeeded,
        AwsExecutionStatus::Failed | AwsExecutionStatus::Aborted => ExecutionStatus::Failed,
        AwsExecutionStatus::TimedOut => ExecutionStatus::TimedOut,
        AwsExecutionStatus::Running | AwsExecutionStatus::PendingRedrive => {
            ExecutionStatus::Running
        }
        _ => ExecutionStatus::Failed,
    }
}

fn map_sdk_error<E, R>(error: aws_sdk_sfn::error::SdkError<E, R>) -> SfnApiError
where
    E: ProvideErrorMetadata + std::fmt::Debug,
{
    let code = error.code().unwrap_or_default();
    if code == "ExecutionAlreadyExists" {
        SfnApiError::AlreadyExists
    } else if code == "ExecutionDoesNotExist" {
        SfnApiError::NotFound
    } else if code == "AccessDeniedException" || code == "AccessDenied" {
        SfnApiError::Permission
    } else {
        SfnApiError::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acquisition::{AcquiredJob, WorkerIdentity};
    use crate::event::WorkItem;
    use crate::orchestration::{canonical_renditions, canonical_source_key, execution_name};
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;

    #[derive(Clone, Default)]
    struct FakeSfnApi {
        starts: Arc<Mutex<Vec<(String, String, String)>>>,
        start_results: Arc<Mutex<VecDeque<Result<(), SfnApiError>>>>,
        descriptions: Arc<Mutex<HashMap<String, Result<DescribedExecution, SfnApiError>>>>,
        stops: Arc<Mutex<Vec<String>>>,
        running_children: Arc<Mutex<HashMap<String, Result<usize, SfnApiError>>>>,
    }

    impl StepFunctionsApi for FakeSfnApi {
        fn start_execution(
            &self,
            state_machine_arn: &str,
            name: &str,
            input: &str,
        ) -> Pin<Box<dyn Future<Output = Result<(), SfnApiError>> + Send + '_>> {
            let state_machine_arn = state_machine_arn.to_owned();
            let name = name.to_owned();
            let input = input.to_owned();
            Box::pin(async move {
                self.starts
                    .lock()
                    .unwrap()
                    .push((state_machine_arn, name, input));
                self.start_results
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(Ok(()))
            })
        }

        fn describe_execution(
            &self,
            execution_arn: &str,
        ) -> Pin<Box<dyn Future<Output = Result<DescribedExecution, SfnApiError>> + Send + '_>>
        {
            let execution_arn = execution_arn.to_owned();
            Box::pin(async move {
                self.descriptions
                    .lock()
                    .unwrap()
                    .get(&execution_arn)
                    .cloned()
                    .unwrap_or(Err(SfnApiError::NotFound))
            })
        }

        fn stop_execution(
            &self,
            execution_arn: &str,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            let execution_arn = execution_arn.to_owned();
            Box::pin(async move {
                self.stops.lock().unwrap().push(execution_arn);
            })
        }

        fn running_child_count(
            &self,
            execution_arn: &str,
        ) -> Pin<Box<dyn Future<Output = Result<usize, SfnApiError>> + Send + '_>> {
            let execution_arn = execution_arn.to_owned();
            Box::pin(async move {
                self.running_children
                    .lock()
                    .unwrap()
                    .get(&execution_arn)
                    .cloned()
                    .unwrap_or(Ok(0))
            })
        }
    }

    fn job() -> AcquiredJob {
        let video_id = "018f47a2-45c2-7a84-b84f-5f6dd7b5910a";
        let job_id = "018f47a2-4699-7892-9fc0-fbe46d3bbd67";
        AcquiredJob {
            item: WorkItem {
                bucket: "in".into(),
                key: canonical_source_key(video_id, job_id),
                video_id: video_id.into(),
                job_id: job_id.into(),
            },
            worker_id: WorkerIdentity::from_value("worker").unwrap(),
            attempt: 1,
            lease_expires_at: SystemTime::UNIX_EPOCH,
        }
    }

    fn client(api: FakeSfnApi) -> SfnExecutionClient<FakeSfnApi> {
        SfnExecutionClient {
            state_machine_arn: "arn:aws:states:ap-northeast-1:123:stateMachine:orchestration"
                .into(),
            api,
        }
    }

    #[tokio::test]
    async fn start_uses_the_supplied_name_and_identical_payload() {
        let api = FakeSfnApi::default();
        let starts = api.starts.clone();
        let client = client(api);
        let input = ExecutionInput::for_job(&job(), canonical_renditions(), "2026-08-25T03:04:00Z")
            .unwrap();
        client
            .start(&execution_name(&job().item.job_id, 1), &input)
            .await
            .unwrap();
        let recorded = starts.lock().unwrap();
        assert_eq!(recorded[0].1, execution_name(&job().item.job_id, 1));
        assert_eq!(recorded[0].2, input.payload_json().unwrap());
    }

    #[tokio::test]
    async fn already_exists_and_permission_are_typed() {
        let api = FakeSfnApi::default();
        api.start_results
            .lock()
            .unwrap()
            .push_back(Err(SfnApiError::AlreadyExists));
        api.start_results
            .lock()
            .unwrap()
            .push_back(Err(SfnApiError::Permission));
        let client = client(api);
        let input = ExecutionInput::for_job(&job(), canonical_renditions(), "2026-08-25T03:04:00Z")
            .unwrap();
        let name = execution_name(&job().item.job_id, 1);
        assert_eq!(
            client.start(&name, &input).await,
            Err(OrchestrationError::Start("already exists".into()))
        );
        assert_eq!(
            client.start(&name, &input).await,
            Err(OrchestrationError::Permission)
        );
    }

    #[tokio::test]
    async fn describe_not_found_is_inspection_not_found() {
        let client = client(FakeSfnApi::default());
        assert_eq!(
            client.inspect("job-x-a1").await.unwrap(),
            ExecutionInspection::NotFound
        );
    }

    #[tokio::test]
    async fn cancel_targets_the_derived_execution_arn() {
        let api = FakeSfnApi::default();
        let stops = api.stops.clone();
        let client = client(api);
        client.cancel("job-x-a1").await;
        assert_eq!(
            stops.lock().unwrap().as_slice(),
            ["arn:aws:states:ap-northeast-1:123:execution:orchestration:job-x-a1"]
        );
    }

    #[tokio::test]
    async fn residual_children_are_counted_from_the_execution_history() {
        let api = FakeSfnApi::default();
        let arn = "arn:aws:states:ap-northeast-1:123:execution:orchestration:job-x-a1";
        api.running_children
            .lock()
            .unwrap()
            .insert(arn.to_owned(), Ok(2));
        let client = client(api);
        assert_eq!(
            client.residual_running_children("job-x-a1").await.unwrap(),
            2
        );
    }

    #[test]
    fn timed_out_tasks_are_residual_until_succeeded_or_failed() {
        assert_eq!(
            residual_running_from_task_events([
                &HistoryEventType::TaskStarted,
                &HistoryEventType::TaskSucceeded,
                &HistoryEventType::TaskStarted,
                &HistoryEventType::TaskFailed,
            ]),
            0
        );
        assert_eq!(
            residual_running_from_task_events([
                &HistoryEventType::TaskStarted,
                &HistoryEventType::TaskTimedOut,
                &HistoryEventType::TaskStarted,
            ]),
            2
        );
    }

    #[test]
    fn execution_arn_is_derived_from_the_state_machine() {
        assert_eq!(
            execution_arn(
                "arn:aws:states:ap-northeast-1:123:stateMachine:orchestration",
                "job-x-a1"
            )
            .unwrap(),
            "arn:aws:states:ap-northeast-1:123:execution:orchestration:job-x-a1"
        );
    }
}
