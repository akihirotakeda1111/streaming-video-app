//! Step Functions adapter for the parent execution client.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    future::Future,
    pin::Pin,
};

use aws_sdk_sfn::{Client, error::ProvideErrorMetadata, types::HistoryEvent};

use crate::orchestration::{
    ExecutionClient, ExecutionInput, ExecutionInspection, ExecutionStatus, OrchestrationError,
};

const ECS_DESCRIBE_BATCH: usize = 100;

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

struct DescribedTasks {
    tasks: Vec<(String, String)>,
    missing: Vec<String>,
}

#[derive(Default)]
struct HistoryTaskScan {
    arns: BTreeSet<String>,
    saw_ecs_task: bool,
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
    fn child_task_arns(
        &self,
        execution_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, SfnApiError>> + Send + '_>>;
}

trait EcsTaskApi: Send + Sync {
    fn describe_tasks(
        &self,
        cluster: &str,
        task_arns: &[String],
    ) -> Pin<Box<dyn Future<Output = Result<DescribedTasks, SfnApiError>> + Send + '_>>;
    fn stop_task(
        &self,
        cluster: &str,
        task_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SfnApiError>> + Send + '_>>;
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

    fn child_task_arns(
        &self,
        execution_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, SfnApiError>> + Send + '_>> {
        let execution_arn = execution_arn.to_owned();
        Box::pin(async move {
            let mut next_token = None;
            let mut scan = HistoryTaskScan::default();
            loop {
                let mut request = self
                    .client
                    .get_execution_history()
                    .execution_arn(&execution_arn)
                    .include_execution_data(true)
                    .max_results(1000);
                if let Some(token) = &next_token {
                    request = request.next_token(token);
                }
                let response = request.send().await.map_err(map_sdk_error)?;
                for event in response.events() {
                    scan_history_event(event, &mut scan);
                }
                next_token = response.next_token().map(str::to_owned);
                if next_token.is_none() {
                    break;
                }
            }
            finish_history_task_scan(scan)
        })
    }
}

#[derive(Clone)]
pub struct AwsEcsApi {
    client: aws_sdk_ecs::Client,
}

impl EcsTaskApi for AwsEcsApi {
    fn describe_tasks(
        &self,
        cluster: &str,
        task_arns: &[String],
    ) -> Pin<Box<dyn Future<Output = Result<DescribedTasks, SfnApiError>> + Send + '_>> {
        let cluster = cluster.to_owned();
        let task_arns = task_arns.to_vec();
        Box::pin(async move {
            let response = self
                .client
                .describe_tasks()
                .cluster(cluster)
                .set_tasks(Some(task_arns))
                .send()
                .await
                .map_err(map_ecs_sdk_error)?;
            let mut tasks = Vec::new();
            for task in response.tasks() {
                tasks.push((
                    task.task_arn().unwrap_or_default().to_owned(),
                    task.last_status().unwrap_or_default().to_owned(),
                ));
            }
            let mut missing = Vec::new();
            for failure in response.failures() {
                let arn = failure.arn().unwrap_or_default().to_owned();
                let reason = failure.reason().unwrap_or_default();
                if reason.eq_ignore_ascii_case("MISSING") {
                    missing.push(arn);
                } else {
                    return Err(SfnApiError::Unavailable);
                }
            }
            Ok(DescribedTasks { tasks, missing })
        })
    }

    fn stop_task(
        &self,
        cluster: &str,
        task_arn: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SfnApiError>> + Send + '_>> {
        let cluster = cluster.to_owned();
        let task_arn = task_arn.to_owned();
        Box::pin(async move {
            self.client
                .stop_task()
                .cluster(cluster)
                .task(task_arn)
                .reason("previous-attempt residual child")
                .send()
                .await
                .map(|_| ())
                .map_err(map_ecs_sdk_error)
        })
    }
}

/// Production Step Functions client. Start uses the caller-supplied name and
/// input only; recovery of ambiguous starts is owned by the orchestration bridge.
#[derive(Clone)]
pub struct SfnExecutionClient<S = AwsSfnApi, E = AwsEcsApi> {
    state_machine_arn: String,
    sfn: S,
    ecs: E,
}

impl SfnExecutionClient<AwsSfnApi, AwsEcsApi> {
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
            sfn: AwsSfnApi {
                client: Client::new(&config),
            },
            ecs: AwsEcsApi {
                client: aws_sdk_ecs::Client::new(&config),
            },
        })
    }
}

impl<S: StepFunctionsApi, E: EcsTaskApi> ExecutionClient for SfnExecutionClient<S, E> {
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
                .sfn
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
            match self.sfn.describe_execution(&execution_arn).await {
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
                self.sfn.stop_execution(&execution_arn).await;
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
            let task_arns = match self.sfn.child_task_arns(&execution_arn).await {
                Ok(arns) => arns,
                Err(SfnApiError::Permission) => return Err(OrchestrationError::Permission),
                Err(_) => {
                    return Err(OrchestrationError::Describe(
                        "residual children could not be inspected".into(),
                    ));
                }
            };
            match confirm_residual_ecs_tasks(&self.ecs, &task_arns).await {
                Ok(count) => Ok(count),
                Err(SfnApiError::Permission) => Err(OrchestrationError::Permission),
                Err(_) => Err(OrchestrationError::Describe(
                    "residual children could not be inspected".into(),
                )),
            }
        })
    }
}

async fn confirm_residual_ecs_tasks<E: EcsTaskApi>(
    ecs: &E,
    task_arns: &[String],
) -> Result<usize, SfnApiError> {
    if task_arns.is_empty() {
        return Ok(0);
    }
    let mut by_cluster: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for arn in task_arns {
        let cluster = cluster_from_task_arn(arn)?;
        by_cluster.entry(cluster).or_default().push(arn.clone());
    }
    let mut residual = Vec::new();
    for (cluster, arns) in &by_cluster {
        for chunk in arns.chunks(ECS_DESCRIBE_BATCH) {
            let described = ecs.describe_tasks(cluster, chunk).await?;
            residual.extend(classify_live_tasks(cluster, chunk, described)?);
        }
    }
    for (cluster, arn) in &residual {
        let _ = ecs.stop_task(cluster, arn).await;
    }
    Ok(residual.len())
}

fn classify_live_tasks(
    cluster: &str,
    requested: &[String],
    described: DescribedTasks,
) -> Result<Vec<(String, String)>, SfnApiError> {
    let mut seen = HashSet::new();
    let mut residual = Vec::new();
    for (arn, last_status) in described.tasks {
        if arn.is_empty() || last_status.is_empty() {
            return Err(SfnApiError::Unavailable);
        }
        seen.insert(arn.clone());
        if !is_stopped_status(&last_status) {
            residual.push((cluster.to_owned(), arn));
        }
    }
    for arn in described.missing {
        seen.insert(arn);
    }
    for arn in requested {
        if !seen.contains(arn) {
            return Err(SfnApiError::Unavailable);
        }
    }
    Ok(residual)
}

fn scan_history_event(event: &HistoryEvent, scan: &mut HistoryTaskScan) {
    if let Some(details) = event.task_submitted_event_details() {
        take_ecs_output(details.resource_type(), details.output(), scan);
    }
    if let Some(details) = event.task_succeeded_event_details() {
        take_ecs_output(details.resource_type(), details.output(), scan);
    }
    if let Some(details) = event.task_scheduled_event_details() {
        take_ecs_output(details.resource_type(), None, scan);
    }
    if let Some(details) = event.task_started_event_details() {
        take_ecs_output(details.resource_type(), None, scan);
    }
    if let Some(details) = event.task_failed_event_details() {
        take_ecs_output(details.resource_type(), details.cause(), scan);
    }
    if let Some(details) = event.task_timed_out_event_details() {
        take_ecs_output(details.resource_type(), details.cause(), scan);
    }
}

fn take_ecs_output(resource_type: &str, output: Option<&str>, scan: &mut HistoryTaskScan) {
    let is_ecs = resource_type.eq_ignore_ascii_case("ecs");
    if is_ecs {
        scan.saw_ecs_task = true;
    }
    if let Some(output) = output {
        let before = scan.arns.len();
        collect_ecs_task_arns_from_json(output, &mut scan.arns);
        if scan.arns.len() > before {
            scan.saw_ecs_task = true;
        }
    }
}

fn finish_history_task_scan(scan: HistoryTaskScan) -> Result<Vec<String>, SfnApiError> {
    if scan.saw_ecs_task && scan.arns.is_empty() {
        return Err(SfnApiError::Unavailable);
    }
    Ok(scan.arns.into_iter().collect())
}

fn collect_ecs_task_arns_from_json(raw: &str, arns: &mut BTreeSet<String>) {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => walk_json(&value, arns),
        Err(_) => collect_ecs_task_arns_from_text(raw, arns),
    }
}

fn walk_json(value: &serde_json::Value, arns: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::String(text) => collect_ecs_task_arns_from_text(text, arns),
        serde_json::Value::Array(items) => {
            for item in items {
                walk_json(item, arns);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                if key.eq_ignore_ascii_case("TaskArn") {
                    if let serde_json::Value::String(text) = item {
                        if is_ecs_task_arn(text) {
                            arns.insert(text.clone());
                            continue;
                        }
                    }
                }
                walk_json(item, arns);
            }
        }
        _ => {}
    }
}

fn collect_ecs_task_arns_from_text(raw: &str, arns: &mut BTreeSet<String>) {
    for token in raw.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '\\' | '[' | ']' | '{' | '}')
    }) {
        if is_ecs_task_arn(token) {
            arns.insert(token.to_owned());
        }
    }
}

fn is_ecs_task_arn(value: &str) -> bool {
    value.starts_with("arn:aws:ecs:") && value.contains(":task/")
}

fn cluster_from_task_arn(arn: &str) -> Result<String, SfnApiError> {
    let Some((_, rest)) = arn.split_once(":task/") else {
        return Err(SfnApiError::Unavailable);
    };
    let Some((cluster, _)) = rest.split_once('/') else {
        return Err(SfnApiError::Unavailable);
    };
    if cluster.is_empty() {
        return Err(SfnApiError::Unavailable);
    }
    Ok(cluster.to_owned())
}

fn is_stopped_status(status: &str) -> bool {
    status.eq_ignore_ascii_case("STOPPED")
}

fn execution_arn(state_machine_arn: &str, name: &str) -> Result<String, OrchestrationError> {
    let Some((prefix, state_machine_name)) = state_machine_arn.rsplit_once(":stateMachine:") else {
        return Err(OrchestrationError::Start(
            "invalid state machine arn".into(),
        ));
    };
    Ok(format!("{prefix}:execution:{state_machine_name}:{name}"))
}

fn map_status(status: aws_sdk_sfn::types::ExecutionStatus) -> ExecutionStatus {
    match status {
        aws_sdk_sfn::types::ExecutionStatus::Succeeded => ExecutionStatus::Succeeded,
        aws_sdk_sfn::types::ExecutionStatus::Failed
        | aws_sdk_sfn::types::ExecutionStatus::Aborted => ExecutionStatus::Failed,
        aws_sdk_sfn::types::ExecutionStatus::TimedOut => ExecutionStatus::TimedOut,
        aws_sdk_sfn::types::ExecutionStatus::Running
        | aws_sdk_sfn::types::ExecutionStatus::PendingRedrive => ExecutionStatus::Running,
        _ => ExecutionStatus::Failed,
    }
}

fn map_sdk_error<E, R>(error: aws_sdk_sfn::error::SdkError<E, R>) -> SfnApiError
where
    E: ProvideErrorMetadata + std::fmt::Debug,
{
    map_aws_error_code(error.code().unwrap_or_default())
}

fn map_ecs_sdk_error<E, R>(error: aws_sdk_ecs::error::SdkError<E, R>) -> SfnApiError
where
    E: aws_sdk_ecs::error::ProvideErrorMetadata + std::fmt::Debug,
{
    map_aws_error_code(error.code().unwrap_or_default())
}

fn map_aws_error_code(code: &str) -> SfnApiError {
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
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;

    #[derive(Clone, Default)]
    struct FakeSfnApi {
        starts: Arc<Mutex<Vec<(String, String, String)>>>,
        start_results: Arc<Mutex<VecDeque<Result<(), SfnApiError>>>>,
        descriptions: Arc<Mutex<HashMap<String, Result<DescribedExecution, SfnApiError>>>>,
        stops: Arc<Mutex<Vec<String>>>,
        child_task_arns: Arc<Mutex<HashMap<String, Result<Vec<String>, SfnApiError>>>>,
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

        fn child_task_arns(
            &self,
            execution_arn: &str,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, SfnApiError>> + Send + '_>> {
            let execution_arn = execution_arn.to_owned();
            Box::pin(async move {
                self.child_task_arns
                    .lock()
                    .unwrap()
                    .get(&execution_arn)
                    .cloned()
                    .unwrap_or(Ok(Vec::new()))
            })
        }
    }

    #[derive(Clone, Default)]
    struct FakeEcsApi {
        statuses: Arc<Mutex<HashMap<String, String>>>,
        missing: Arc<Mutex<HashSet<String>>>,
        describe_errors: Arc<Mutex<HashMap<String, SfnApiError>>>,
        stops: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl EcsTaskApi for FakeEcsApi {
        fn describe_tasks(
            &self,
            cluster: &str,
            task_arns: &[String],
        ) -> Pin<Box<dyn Future<Output = Result<DescribedTasks, SfnApiError>> + Send + '_>>
        {
            let cluster = cluster.to_owned();
            let task_arns = task_arns.to_vec();
            Box::pin(async move {
                if let Some(error) = self.describe_errors.lock().unwrap().get(&cluster).cloned() {
                    return Err(error);
                }
                let statuses = self.statuses.lock().unwrap();
                let missing_set = self.missing.lock().unwrap();
                let mut tasks = Vec::new();
                let mut missing = Vec::new();
                for arn in task_arns {
                    if missing_set.contains(&arn) {
                        missing.push(arn);
                    } else if let Some(status) = statuses.get(&arn) {
                        tasks.push((arn, status.clone()));
                    } else {
                        missing.push(arn);
                    }
                }
                Ok(DescribedTasks { tasks, missing })
            })
        }

        fn stop_task(
            &self,
            cluster: &str,
            task_arn: &str,
        ) -> Pin<Box<dyn Future<Output = Result<(), SfnApiError>> + Send + '_>> {
            let cluster = cluster.to_owned();
            let task_arn = task_arn.to_owned();
            Box::pin(async move {
                self.stops.lock().unwrap().push((cluster, task_arn));
                Ok(())
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

    fn client(sfn: FakeSfnApi) -> SfnExecutionClient<FakeSfnApi, FakeEcsApi> {
        client_with_ecs(sfn, FakeEcsApi::default())
    }

    fn client_with_ecs(
        sfn: FakeSfnApi,
        ecs: FakeEcsApi,
    ) -> SfnExecutionClient<FakeSfnApi, FakeEcsApi> {
        SfnExecutionClient {
            state_machine_arn: "arn:aws:states:ap-northeast-1:123:stateMachine:orchestration"
                .into(),
            sfn,
            ecs,
        }
    }

    fn execution_arn_for(name: &str) -> String {
        format!("arn:aws:states:ap-northeast-1:123:execution:orchestration:{name}")
    }

    fn task_arn(id: &str) -> String {
        format!("arn:aws:ecs:ap-northeast-1:123:task/streaming-cluster/{id}")
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
    async fn residual_children_are_counted_from_ecs_live_state() {
        let sfn = FakeSfnApi::default();
        let running = task_arn("running");
        let stopped = task_arn("stopped");
        let pending = task_arn("pending");
        sfn.child_task_arns.lock().unwrap().insert(
            execution_arn_for("job-x-a1"),
            Ok(vec![running.clone(), stopped.clone(), pending.clone()]),
        );
        let ecs = FakeEcsApi::default();
        ecs.statuses
            .lock()
            .unwrap()
            .insert(running.clone(), "RUNNING".into());
        ecs.statuses
            .lock()
            .unwrap()
            .insert(stopped.clone(), "STOPPED".into());
        ecs.statuses
            .lock()
            .unwrap()
            .insert(pending.clone(), "PENDING".into());
        let stops = ecs.stops.clone();
        let client = client_with_ecs(sfn, ecs);
        assert_eq!(
            client.residual_running_children("job-x-a1").await.unwrap(),
            2
        );
        let mut stopped_tasks = stops.lock().unwrap().clone();
        stopped_tasks.sort();
        assert_eq!(
            stopped_tasks,
            vec![
                ("streaming-cluster".into(), pending),
                ("streaming-cluster".into(), running),
            ]
        );
    }

    #[tokio::test]
    async fn missing_ecs_tasks_are_treated_as_stopped() {
        let sfn = FakeSfnApi::default();
        let missing = task_arn("gone");
        sfn.child_task_arns
            .lock()
            .unwrap()
            .insert(execution_arn_for("job-x-a1"), Ok(vec![missing.clone()]));
        let ecs = FakeEcsApi::default();
        ecs.missing.lock().unwrap().insert(missing);
        let stops = ecs.stops.clone();
        let client = client_with_ecs(sfn, ecs);
        assert_eq!(
            client.residual_running_children("job-x-a1").await.unwrap(),
            0
        );
        assert!(stops.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unresolved_ecs_history_fails_closed() {
        let sfn = FakeSfnApi::default();
        sfn.child_task_arns
            .lock()
            .unwrap()
            .insert(execution_arn_for("job-x-a1"), Err(SfnApiError::Unavailable));
        let client = client(sfn);
        assert_eq!(
            client.residual_running_children("job-x-a1").await,
            Err(OrchestrationError::Describe(
                "residual children could not be inspected".into()
            ))
        );
    }

    #[tokio::test]
    async fn ecs_describe_permission_fails_closed() {
        let sfn = FakeSfnApi::default();
        sfn.child_task_arns
            .lock()
            .unwrap()
            .insert(execution_arn_for("job-x-a1"), Ok(vec![task_arn("running")]));
        let ecs = FakeEcsApi::default();
        ecs.describe_errors
            .lock()
            .unwrap()
            .insert("streaming-cluster".into(), SfnApiError::Permission);
        let client = client_with_ecs(sfn, ecs);
        assert_eq!(
            client.residual_running_children("job-x-a1").await,
            Err(OrchestrationError::Permission)
        );
    }

    #[test]
    fn ecs_task_arns_are_collected_from_task_output_json() {
        let mut arns = BTreeSet::new();
        collect_ecs_task_arns_from_json(
            r#"{"TaskArn":"arn:aws:ecs:ap-northeast-1:123:task/streaming-cluster/abc","ClusterArn":"arn:aws:ecs:ap-northeast-1:123:cluster/streaming-cluster"}"#,
            &mut arns,
        );
        assert_eq!(arns.into_iter().collect::<Vec<_>>(), vec![task_arn("abc")]);
    }

    #[test]
    fn ecs_activity_without_a_task_arn_is_unresolved() {
        let mut scan = HistoryTaskScan::default();
        take_ecs_output("ecs", None, &mut scan);
        assert_eq!(
            finish_history_task_scan(scan),
            Err(SfnApiError::Unavailable)
        );
    }

    #[test]
    fn history_without_ecs_activity_has_no_children() {
        assert_eq!(
            finish_history_task_scan(HistoryTaskScan::default()),
            Ok(Vec::new())
        );
    }

    #[test]
    fn cluster_is_parsed_from_the_task_arn() {
        assert_eq!(
            cluster_from_task_arn(&task_arn("abc")).unwrap(),
            "streaming-cluster"
        );
        assert_eq!(
            cluster_from_task_arn("arn:aws:ecs:ap-northeast-1:123:task/abc"),
            Err(SfnApiError::Unavailable)
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
