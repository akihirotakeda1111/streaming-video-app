#!/usr/bin/env python3
"""Fail-closed entry point for one distributed scalability workload.

Offline ``--check`` validates the handoff and the batch plan without calling
AWS. Live ``--full`` reads the deployed service, autoscaling policy, metric,
and images before dispatching the dedicated Playwright project. The runner
never provisions or updates AWS resources.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "app/frontend/node_modules/@playwright/test/cli.js"
CHECKPOINTS = (
    "parentScaleOut",
    "parentJobConcurrency",
    "childExecutionOverlap",
    "allJobsCompleted",
    "scaleIn",
    "abrPlayback",
)
REQUIRED = {
    "account_id", "region", "environment", "api_url", "frontend_url",
    "playback_base_url", "cluster", "api_service", "worker_service", "parent_service",
    "step_functions_arn", "api_image_digest", "worker_image_digest",
    "distributed_mode", "parent_min_capacity", "input_bucket", "worker_max_concurrency",
    "fixture_path", "fixture_duration_seconds", "worker_min_capacity",
    "worker_max_capacity", "backlog_per_worker_target", "processing_seconds",
    "scale_out_cooldown_seconds", "scale_in_cooldown_seconds", "runtime_budget_seconds",
}
BUCKET_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
METRIC_PERIOD_SECONDS = 60
DEFAULT_SCALE_OUT_EVALUATION_PERIODS = 3
DEFAULT_SCALE_IN_EVALUATION_PERIODS = 15
PLAYBACK_ALLOWANCE_SECONDS = 120
EVIDENCE_FLUSH_SECONDS = 120
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _config_path() -> Path | None:
    value = os.environ.get("SCALABILITY_E2E_CONFIG", "").strip()
    return Path(value).expanduser().resolve() if value else None


def _read_config() -> dict[str, Any]:
    path = _config_path()
    if path is None:
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read SCALABILITY_E2E_CONFIG: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("SCALABILITY_E2E_CONFIG must contain a JSON object")
    return value


def _is_loopback(hostname: str | None) -> bool:
    if not hostname:
        return False
    return hostname.strip("[]").lower().rstrip(".") in LOOPBACK_HOSTS


def _validate_endpoint(name: str, value: object) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an https URL")
    parsed = urlsplit(value.strip())
    if parsed.scheme == "https" and parsed.hostname:
        return
    if name == "frontend_url" and parsed.scheme == "http" and _is_loopback(parsed.hostname):
        return
    if name == "frontend_url":
        raise ValueError("frontend_url must be https, or http on localhost, 127.0.0.1, or ::1")
    raise ValueError(f"{name} must be an https URL")


def _validate(config: dict[str, Any], live: bool) -> None:
    missing = sorted(REQUIRED - config.keys())
    if missing:
        raise ValueError(f"missing scalability configuration: {', '.join(missing)}")
    if not str(config["environment"]).startswith("scalability-e2e-"):
        raise ValueError("environment must use the dedicated scalability-e2e- identity")
    if not isinstance(config["account_id"], str) or not config["account_id"].isdigit() or len(config["account_id"]) != 12:
        raise ValueError("account_id must contain 12 digits")
    if not isinstance(config["region"], str) or not config["region"].strip():
        raise ValueError("region is required")
    for name in ("api_url", "playback_base_url", "frontend_url"):
        _validate_endpoint(name, config[name])
    for name in ("worker_min_capacity", "worker_max_capacity", "parent_min_capacity", "worker_max_concurrency"):
        if not isinstance(config[name], int) or isinstance(config[name], bool) or config[name] < 1:
            raise ValueError(f"{name} must be a positive integer")
    if not isinstance(config["api_service"], str) or not config["api_service"].strip() or any(char.isspace() for char in config["api_service"]):
        raise ValueError("api_service must identify the dedicated API service")
    if not isinstance(config["input_bucket"], str) or BUCKET_NAME.fullmatch(config["input_bucket"]) is None:
        raise ValueError("input_bucket must be the dedicated DNS-compatible input bucket name")
    if config["worker_min_capacity"] != 1 or config["worker_max_capacity"] < 2:
        raise ValueError("worker capacity must support minimum 1 and scale-out to at least 2")
    if config["distributed_mode"] is not True or config["parent_min_capacity"] != 1:
        raise ValueError("distributed mode and parent minimum capacity 1 are required")
    for name in ("backlog_per_worker_target", "processing_seconds", "runtime_budget_seconds",
                 "scale_out_cooldown_seconds", "scale_in_cooldown_seconds", "fixture_duration_seconds"):
        if isinstance(config[name], bool) or not isinstance(config[name], (int, float)) or config[name] <= 0:
            raise ValueError(f"{name} must be positive")
    fixture = Path(str(config["fixture_path"])).expanduser()
    if live and (not fixture.is_file() or fixture.stat().st_size == 0):
        raise ValueError("fixture_path must identify a non-empty 720p-or-higher fixture")
    if live and os.environ.get("SCALABILITY_E2E_ALLOW_LIVE") != "true":
        raise ValueError("set SCALABILITY_E2E_ALLOW_LIVE=true for the dedicated live environment")


def _whole(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def fixture_record(path: Path, duration_seconds: float) -> dict[str, Any]:
    """Return a portable fixture identity. The filesystem path is omitted."""
    record: dict[str, Any] = {"name": path.name, "durationSeconds": duration_seconds}
    if path.is_file():
        data = path.read_bytes()
        record["sizeBytes"] = len(data)
        record["sha256"] = hashlib.sha256(data).hexdigest()
    return record


def _plan(config: dict[str, Any], scale_out_evaluation: float, scale_in_evaluation: float) -> dict[str, Any]:
    target = float(config["backlog_per_worker_target"])
    capacity = int(config["worker_min_capacity"])
    concurrency = config["worker_max_concurrency"]
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency < 1:
        raise ValueError("worker_max_concurrency must be a positive integer")
    processing = float(config["processing_seconds"])
    budget = float(config["runtime_budget_seconds"])
    scale_out_cooldown = float(config["scale_out_cooldown_seconds"])
    scale_in_cooldown = float(config["scale_in_cooldown_seconds"])
    # ApproximateNumberOfMessagesVisible excludes messages the initial workers
    # have already received. Each of those workers holds worker_max_concurrency
    # messages, so the visible remainder must stay strictly above the target.
    in_flight = capacity * concurrency
    visible = math.floor(target * capacity) + 1
    count = visible + in_flight
    sustained = visible / capacity
    if count < 2 or sustained <= target:
        raise ValueError("batch does not keep visible backlog per worker above the scaling target")
    if processing < scale_out_evaluation:
        raise ValueError(
            "processing time is shorter than the scale-out evaluation window; "
            f"need at least {scale_out_evaluation:g}s so backlog stays observable"
        )
    # The fixed batch is uploaded together, so the submission window is one
    # object upload. Scale-out is then sampled before a second worker joins.
    # The remaining jobs drain on at least two workers. Scale-in waits out its
    # own evaluation period and cooldown after that work finishes.
    drain = scale_out_evaluation + processing * math.ceil(count / 2)
    required = drain + scale_out_cooldown + scale_in_evaluation + scale_in_cooldown + PLAYBACK_ALLOWANCE_SECONDS
    if required > budget:
        raise ValueError(
            f"runtime budget {budget:g}s cannot observe scale-out and scale-in; "
            f"need at least {required:g}s for processing, cooldown, evaluation, and playback"
        )
    rationale = (
        f"floor(target {target:g} * initial workers {capacity}) + 1 + "
        f"in-flight {in_flight} (workers {capacity} * concurrency {concurrency}) = {count}; "
        f"after the initial workers receive {in_flight} messages, visible backlog/worker "
        f"{sustained:g} exceeds {target:g}; "
        f"the fixed batch is uploaded in parallel so the submission window is one object upload; "
        f"processing {processing:g}s covers scale-out evaluation {scale_out_evaluation:g}s; "
        f"required budget {required:g}s fits within {budget:g}s"
    )
    return {
        "batchSize": count,
        "requiredBudgetSeconds": _whole(required),
        "rationale": rationale,
        "target": target,
        "submissionMode": "parallel",
        "submissionWindow": "one concurrent upload of the predetermined batch",
        "inFlightMessages": in_flight,
        "sustainedVisibleBacklog": visible,
        "sustainedBacklogPerWorker": _whole(sustained),
        "workerMaxConcurrency": concurrency,
        "scaleOutEvaluationSeconds": _whole(scale_out_evaluation),
        "scaleInEvaluationSeconds": _whole(scale_in_evaluation),
        "scaleOutCooldownSeconds": scale_out_cooldown,
        "scaleInCooldownSeconds": scale_in_cooldown,
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _check() -> int:
    try:
        config = _read_config()
        if not config:
            print("offline check passed (SCALABILITY_E2E_CONFIG is not configured; no AWS calls made)")
            return 0
        _validate(config, False)
        plan = _plan(
            config,
            METRIC_PERIOD_SECONDS * DEFAULT_SCALE_OUT_EVALUATION_PERIODS,
            METRIC_PERIOD_SECONDS * DEFAULT_SCALE_IN_EVALUATION_PERIODS,
        )
        print(json.dumps({
            "status": "passed",
            "mode": "offline",
            "batchSize": plan["batchSize"],
            "inFlightMessages": plan["inFlightMessages"],
            "submissionMode": plan["submissionMode"],
            "sustainedBacklogPerWorker": plan["sustainedBacklogPerWorker"],
            "requiredBudgetSeconds": plan["requiredBudgetSeconds"],
            "rationale": plan["rationale"],
        }, sort_keys=True))
        return 0
    except ValueError as error:
        print(f"offline check failed: {error}", file=sys.stderr)
        return 2


def _aws(arguments: list[str]) -> Any:
    aws = shutil.which("aws")
    if aws is None:
        raise ValueError("aws CLI is required for live preflight")
    result = subprocess.run(
        [aws, *arguments],
        capture_output=True,
        text=True,
        check=False,
        timeout=45,
    )
    if result.returncode != 0:
        detail = " ".join(result.stderr.split())[:400]
        raise ValueError(f"live preflight {arguments[0]} {arguments[1] if len(arguments) > 1 else ''} failed: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("live preflight returned invalid observation data") from error


def _collect(arguments: list[str], key: str) -> list[Any]:
    items: list[Any] = []
    token: str | None = None
    for _ in range(20):
        page_args = [*arguments]
        if token:
            page_args.extend(["--next-token", token])
        page = _aws(page_args)
        if not isinstance(page, dict):
            raise ValueError("live preflight returned invalid observation data")
        value = page.get(key, [])
        if not isinstance(value, list):
            raise ValueError("live preflight returned invalid observation data")
        items.extend(value)
        next_token = page.get("nextToken") or page.get("NextToken")
        if not isinstance(next_token, str) or not next_token:
            return items
        token = next_token
    raise ValueError("live preflight observation was truncated")


def _tail_name(value: str, marker: str) -> str:
    if marker in value:
        return value.rsplit("/", 1)[-1]
    return value


def _close(left: object, right: object) -> bool:
    return isinstance(left, (int, float)) and isinstance(right, (int, float)) and abs(float(left) - float(right)) <= 1e-3


def _task_definition(arn: str, region: str) -> dict[str, Any]:
    body = _aws(["ecs", "describe-task-definition", "--task-definition", arn, "--region", region])
    definition = body.get("taskDefinition") if isinstance(body, dict) else None
    if not isinstance(definition, dict):
        raise ValueError("live preflight could not read a task definition")
    return definition


def _image_digest(image: object) -> str:
    if not isinstance(image, str) or "@" not in image:
        return ""
    return image.rsplit("@", 1)[1]


def _container_env(definition: dict[str, Any], name: str) -> str | None:
    containers = definition.get("containerDefinitions")
    if not isinstance(containers, list):
        return None
    for container in containers:
        if not isinstance(container, dict):
            continue
        environment = container.get("environment")
        if not isinstance(environment, list):
            continue
        for item in environment:
            if isinstance(item, dict) and item.get("name") == name and isinstance(item.get("value"), str):
                return str(item["value"])
    return None


def _definition_has_digest(definition: dict[str, Any], digest: str) -> bool:
    containers = definition.get("containerDefinitions")
    if not isinstance(containers, list):
        return False
    return any(_image_digest(container.get("image")) == digest for container in containers if isinstance(container, dict))


def _describe_named_service(cluster: str, region: str, service: str, label: str) -> dict[str, Any]:
    described = _aws(["ecs", "describe-services", "--cluster", cluster, "--services", service, "--region", region])
    failures = described.get("failures") if isinstance(described, dict) else None
    if not isinstance(described, dict) or (isinstance(failures, list) and failures):
        raise ValueError(f"{label} is not available in the dedicated cluster")
    services = described.get("services")
    current = services[0] if isinstance(services, list) and services and isinstance(services[0], dict) else None
    if not isinstance(current, dict) or current.get("status") != "ACTIVE":
        raise ValueError(f"{label} is not active")
    return current


def _require_worker_contract(definition: dict[str, Any], config: dict[str, Any], label: str) -> None:
    if not _definition_has_digest(definition, str(config["worker_image_digest"])):
        raise ValueError(f"{label} image does not match the worker image digest")
    if _container_env(definition, "WORKER_MAX_CONCURRENCY") != str(config["worker_max_concurrency"]):
        raise ValueError(f"{label} concurrency does not match the handoff")
    if _container_env(definition, "VIDEO_INPUT_BUCKET") != config["input_bucket"]:
        raise ValueError(f"{label} input bucket does not match the dedicated input bucket")


def _require_api_contract(service: dict[str, Any], definition: dict[str, Any], config: dict[str, Any]) -> None:
    running = service.get("runningCount")
    desired = service.get("desiredCount")
    if isinstance(running, bool) or not isinstance(running, int) or running < 1:
        raise ValueError("API service has no running task")
    if isinstance(desired, bool) or not isinstance(desired, int) or desired < 1:
        raise ValueError("API service has no desired task")
    if not _definition_has_digest(definition, str(config["api_image_digest"])):
        raise ValueError("API service image does not match the API image digest")
    if _container_env(definition, "VIDEO_INPUT_BUCKET") != config["input_bucket"]:
        raise ValueError("API service input bucket does not match the dedicated input bucket")


class _RejectRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        return None


def _api_health_url(api_base: str) -> str:
    parsed = urlsplit(api_base.strip())
    pathname = parsed.path.rstrip("/")
    prefix = pathname if pathname.endswith("/api/v1") else f"{pathname}/api/v1"
    full_path = f"{prefix}/health"
    while "//" in full_path:
        full_path = full_path.replace("//", "/")
    if not full_path.startswith("/"):
        full_path = "/" + full_path
    return f"{parsed.scheme}://{parsed.netloc}{full_path}"


def _reachable(url: str, name: str) -> tuple[int, bytes]:
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "scalability-e2e-preflight"})
    opener = urllib.request.build_opener(_RejectRedirect)
    try:
        with opener.open(request, timeout=20) as response:
            status = getattr(response, "status", 200)
            return int(status), response.read(1024)
    except urllib.error.HTTPError as error:
        return error.code, error.read(1024)
    except urllib.error.URLError as error:
        raise ValueError(f"{name} is not reachable") from error


def _require_reachability(config: dict[str, Any]) -> None:
    status, body = _reachable(_api_health_url(str(config["api_url"])), "API")
    if status != 200:
        raise ValueError("API health endpoint is not reachable")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("API health endpoint is not reachable") from error
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        raise ValueError("API health endpoint is not reachable")
    frontend_status, _body = _reachable(str(config["frontend_url"]).strip(), "frontend")
    if frontend_status < 200 or frontend_status >= 400:
        raise ValueError("frontend is not reachable")


def _require_input_bucket(name: str, region: str) -> None:
    location = _aws(["s3api", "get-bucket-location", "--bucket", name, "--region", region])
    if not isinstance(location, dict) or "LocationConstraint" not in location:
        raise ValueError("dedicated input bucket is not available")
    constraint = location.get("LocationConstraint")
    if constraint in (None, ""):
        actual_region = "us-east-1"
    elif isinstance(constraint, str):
        actual_region = constraint
    else:
        raise ValueError("dedicated input bucket is not available")
    if actual_region != region:
        raise ValueError("dedicated input bucket is not in the handoff region")


def _alarm_period(alarm: dict[str, Any]) -> int:
    """Read the sampling period from metric math, where top-level Period is absent."""
    metrics = alarm.get("Metrics")
    if isinstance(metrics, list):
        periods: list[int] = []
        for item in metrics:
            if not isinstance(item, dict):
                continue
            stat = item.get("MetricStat")
            if not isinstance(stat, dict):
                continue
            period = stat.get("Period")
            if isinstance(period, bool) or not isinstance(period, int) or period <= 0:
                raise ValueError("scaling alarm is missing its evaluation window")
            periods.append(period)
        if not periods:
            raise ValueError("scaling alarm is missing its evaluation window")
        if len(set(periods)) != 1:
            raise ValueError("scaling alarm metric periods disagree")
        return periods[0]
    period = alarm.get("Period")
    if isinstance(period, bool) or not isinstance(period, int) or period <= 0:
        raise ValueError("scaling alarm is missing its evaluation window")
    return period


def _alarm_window(alarm: dict[str, Any]) -> float:
    periods = alarm.get("EvaluationPeriods")
    if isinstance(periods, bool) or not isinstance(periods, int) or periods <= 0:
        raise ValueError("scaling alarm is missing its evaluation window")
    return float(_alarm_period(alarm) * periods)


def _policy_alarm_names(policy: dict[str, Any]) -> list[str]:
    alarms = policy.get("Alarms")
    if not isinstance(alarms, list) or len(alarms) < 2:
        raise ValueError("scaling policy does not reference its scale-out and scale-in alarms")
    names: list[str] = []
    for alarm in alarms:
        if not isinstance(alarm, dict):
            raise ValueError("scaling policy does not reference its scale-out and scale-in alarms")
        name = alarm.get("AlarmName")
        if not isinstance(name, str) or not name.strip():
            arn = alarm.get("AlarmARN")
            if isinstance(arn, str) and ":alarm:" in arn:
                name = arn.split(":alarm:", 1)[1]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("scaling policy does not reference its scale-out and scale-in alarms")
        names.append(name)
    if len(set(names)) != len(names):
        raise ValueError("scaling policy does not reference its scale-out and scale-in alarms")
    return names


def _scale_alarms(alarms: list[Any], target: float) -> tuple[dict[str, Any], dict[str, Any]]:
    high = [alarm for alarm in alarms if isinstance(alarm, dict) and "GreaterThan" in str(alarm.get("ComparisonOperator"))]
    low = [alarm for alarm in alarms if isinstance(alarm, dict) and "LessThan" in str(alarm.get("ComparisonOperator"))]
    if len(high) != 1 or len(low) != 1:
        raise ValueError("live preflight did not find the scale-out and scale-in alarms")
    threshold = low[0].get("Threshold")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or float(threshold) > target + 1e-3:
        raise ValueError("scale-in alarm threshold is not at or below the backlog-per-worker target")
    return high[0], low[0]


def _preflight(config: dict[str, Any]) -> dict[str, Any]:
    region = str(config["region"])
    cluster = _tail_name(str(config["cluster"]), ":cluster/")
    service = _tail_name(str(config["parent_service"]), ":service/")
    worker_service = _tail_name(str(config["worker_service"]), ":service/")
    identity = _aws(["sts", "get-caller-identity", "--query", "Account", "--output", "json"])
    if identity != config["account_id"]:
        raise ValueError("AWS account does not match the dedicated handoff")

    described = _aws(["ecs", "describe-services", "--cluster", cluster, "--services", service, "--region", region])
    failures = described.get("failures") if isinstance(described, dict) else None
    if not isinstance(described, dict) or (isinstance(failures, list) and failures):
        raise ValueError("parent service is not available in the dedicated cluster")
    services = described.get("services")
    current = services[0] if isinstance(services, list) and services else None
    if not isinstance(current, dict) or current.get("status") != "ACTIVE":
        raise ValueError("parent service is not active")
    minimum = int(config["parent_min_capacity"])
    if current.get("runningCount") != minimum or current.get("desiredCount") != minimum or current.get("pendingCount") not in (0, None):
        raise ValueError("parent service is not steady at its configured minimum")
    task_definition_arn = current.get("taskDefinition")
    if not isinstance(task_definition_arn, str):
        raise ValueError("parent service has no task definition")
    definition = _task_definition(task_definition_arn, region)
    _require_worker_contract(definition, config, "parent service")
    state_machine = _container_env(definition, "ORCHESTRATION_STATE_MACHINE_ARN")
    if state_machine != config["step_functions_arn"]:
        raise ValueError("parent task definition is not configured for the dedicated state machine")
    if worker_service != service:
        worker_current = _describe_named_service(cluster, region, worker_service, "worker service")
        worker_definition_arn = worker_current.get("taskDefinition")
        if not isinstance(worker_definition_arn, str):
            raise ValueError("worker service has no task definition")
        _require_worker_contract(_task_definition(worker_definition_arn, region), config, "worker service")
    api_name = _tail_name(str(config["api_service"]), ":service/")
    api_current = _describe_named_service(cluster, region, api_name, "API service")
    api_definition_arn = api_current.get("taskDefinition")
    if not isinstance(api_definition_arn, str):
        raise ValueError("API service has no task definition")
    _require_api_contract(api_current, _task_definition(api_definition_arn, region), config)
    _require_reachability(config)
    _require_input_bucket(str(config["input_bucket"]), region)

    machine = _aws(["stepfunctions", "describe-state-machine", "--state-machine-arn", str(config["step_functions_arn"]), "--region", region])
    if not isinstance(machine, dict) or machine.get("status") != "ACTIVE":
        raise ValueError("orchestration state machine is not active")
    definition_text = machine.get("definition")
    if not isinstance(definition_text, str) or any(token not in definition_text for token in ("360p", "720p", "runTask.sync")):
        raise ValueError("orchestration state machine is not the distributed rendition workflow")

    resource_id = f"service/{cluster}/{service}"
    targets = _collect([
        "application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs",
        "--resource-ids", resource_id, "--region", region,
    ], "ScalableTargets")
    target = next((item for item in targets if isinstance(item, dict) and item.get("ResourceId") == resource_id), None)
    if not isinstance(target, dict):
        raise ValueError("parent service has no autoscaling target")
    if target.get("MinCapacity") != minimum or target.get("MaxCapacity") != config["worker_max_capacity"]:
        raise ValueError("deployed autoscaling capacity does not match the handoff")
    if target.get("ScalableDimension") != "ecs:service:DesiredCount":
        raise ValueError("parent autoscaling target does not control desired count")

    policies = _collect([
        "application-autoscaling", "describe-scaling-policies", "--service-namespace", "ecs",
        "--resource-id", resource_id, "--scalable-dimension", "ecs:service:DesiredCount", "--region", region,
    ], "ScalingPolicies")
    policy = next((item for item in policies if isinstance(item, dict) and item.get("PolicyType") == "TargetTrackingScaling"), None)
    if not isinstance(policy, dict):
        raise ValueError("parent service has no target-tracking scaling policy")
    policy_config = policy.get("TargetTrackingScalingPolicyConfiguration")
    if not isinstance(policy_config, dict):
        raise ValueError("scaling policy has no target-tracking configuration")
    if not _close(policy_config.get("TargetValue"), config["backlog_per_worker_target"]):
        raise ValueError("deployed backlog-per-worker target does not match the handoff")
    if policy_config.get("ScaleOutCooldown") != config["scale_out_cooldown_seconds"]:
        raise ValueError("deployed scale-out cooldown does not match the handoff")
    if policy_config.get("ScaleInCooldown") != config["scale_in_cooldown_seconds"]:
        raise ValueError("deployed scale-in cooldown does not match the handoff")
    metrics = (policy_config.get("CustomizedMetricSpecification") or {}).get("Metrics")
    if not isinstance(metrics, list):
        raise ValueError("scaling policy does not publish the backlog-per-worker metric")
    expression = next((item.get("Expression") for item in metrics if isinstance(item, dict) and isinstance(item.get("Expression"), str)), None)
    names = {
        ((item.get("MetricStat") or {}).get("Metric") or {}).get("MetricName")
        for item in metrics if isinstance(item, dict)
    }
    normalized = "".join(str(expression).split()).lower() if isinstance(expression, str) else ""
    if normalized != "visible_backlog/running_tasks":
        raise ValueError("scaling metric is not visible backlog divided by running workers")
    if "ApproximateNumberOfMessagesVisible" not in names or "RunningTaskCount" not in names:
        raise ValueError("scaling metric does not use queue depth and running task count")

    alarm_names = _policy_alarm_names(policy)
    described_alarms = _aws(["cloudwatch", "describe-alarms", "--alarm-names", *alarm_names, "--region", region])
    found = described_alarms.get("MetricAlarms") if isinstance(described_alarms, dict) else None
    if not isinstance(found, list):
        raise ValueError("live preflight did not find the scale-out and scale-in alarms")
    by_name = {alarm.get("AlarmName"): alarm for alarm in found if isinstance(alarm, dict) and isinstance(alarm.get("AlarmName"), str)}
    selected = []
    for name in alarm_names:
        alarm = by_name.get(name)
        if not isinstance(alarm, dict):
            raise ValueError("live preflight did not find the scale-out and scale-in alarms")
        selected.append(alarm)
    high, low = _scale_alarms(selected, float(config["backlog_per_worker_target"]))
    scale_out_evaluation = _alarm_window(high)
    scale_in_evaluation = _alarm_window(low)
    return {
        "scaleOutEvaluationSeconds": scale_out_evaluation,
        "scaleInEvaluationSeconds": scale_in_evaluation,
        "summary": {
            "account": config["account_id"],
            "region": region,
            "service": {
                "name": service,
                "status": current.get("status"),
                "running": current.get("runningCount"),
                "desired": current.get("desiredCount"),
            },
            "apiService": {
                "name": api_name,
                "status": api_current.get("status"),
                "running": api_current.get("runningCount"),
                "desired": api_current.get("desiredCount"),
            },
            "reachability": {"api": "ok", "frontend": "ok"},
            "inputBucket": {"name": config["input_bucket"], "region": region},
            "workerMaxConcurrency": config["worker_max_concurrency"],
            "images": {"api": config["api_image_digest"], "worker": config["worker_image_digest"]},
            "stateMachine": {"status": machine.get("status"), "distributedRenditions": True},
            "scalableTarget": {
                "resourceId": resource_id,
                "min": target.get("MinCapacity"),
                "max": target.get("MaxCapacity"),
            },
            "metric": {
                "targetValue": policy_config.get("TargetValue"),
                "expression": expression,
                "scaleOutCooldown": policy_config.get("ScaleOutCooldown"),
                "scaleInCooldown": policy_config.get("ScaleInCooldown"),
            },
            "evaluation": {
                "scaleOutSeconds": scale_out_evaluation,
                "scaleInSeconds": scale_in_evaluation,
                "scaleOutThreshold": high.get("Threshold"),
                "scaleInThreshold": low.get("Threshold"),
            },
        },
    }


def _workload_fallback(batch_size: int, error: str) -> dict[str, Any]:
    checkpoints = {name: {"id": name, "status": "NOT RUN", "reason": error} for name in CHECKPOINTS}
    return {
        "scenario": "scalability",
        "status": "failed",
        "observedAt": _now(),
        "batchSize": batch_size,
        "jobs": [],
        "incompleteJobIds": [],
        "checkpoints": checkpoints,
        "summary": ", ".join(f"{name}=NOT RUN" for name in CHECKPOINTS),
        "samples": [],
        "parentActivities": [],
        "childIntervals": [],
        "observationErrors": [error],
        "finalized": False,
        "error": error,
    }


def _ensure_workload(evidence: Path, batch_size: int, error: str) -> None:
    target = evidence / "workload.json"
    if target.is_file():
        try:
            existing = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(existing, dict) and existing.get("status") == "passed":
            existing["status"] = "failed"
            existing["finalized"] = False
            existing["error"] = error
            target.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
        return
    target.write_text(json.dumps(_workload_fallback(batch_size, error), indent=2) + "\n", encoding="utf-8")


def _playwright(config: dict[str, Any], evidence: Path, plan: dict[str, Any], fixture: dict[str, Any]) -> int:
    node = shutil.which("node")
    if node is None or not CLI.is_file():
        raise ValueError("Playwright CLI is unavailable; install frontend dependencies")
    budget = float(config["runtime_budget_seconds"])
    env = os.environ.copy()
    env.update({
        "E2E_ENVIRONMENT": "disposable",
        "E2E_PROJECT": "chromium",
        "E2E_FRONTEND_URL": str(config["frontend_url"]),
        "E2E_API_URL": str(config["api_url"]),
        "E2E_INCLUDE_SCALABILITY": "true",
        "AWS_REGION": str(config["region"]),
        "AWS_DEFAULT_REGION": str(config["region"]),
        "SCALABILITY_BATCH_SIZE": str(plan["batchSize"]),
        "SCALABILITY_FIXTURE_PATH": str(Path(str(config["fixture_path"])).expanduser()),
        "SCALABILITY_FIXTURE_NAME": str(fixture["name"]),
        "SCALABILITY_FIXTURE_DURATION_SECONDS": str(config["fixture_duration_seconds"]),
        "SCALABILITY_RUNTIME_BUDGET_SECONDS": str(config["runtime_budget_seconds"]),
        "SCALABILITY_PLAYWRIGHT_TIMEOUT_MS": str(int((budget + EVIDENCE_FLUSH_SECONDS) * 1000)),
        "SCALABILITY_EVIDENCE_DIR": str(evidence),
        "SCALABILITY_REGION": str(config["region"]),
        "SCALABILITY_ACCOUNT_ID": str(config["account_id"]),
        "SCALABILITY_CLUSTER": _tail_name(str(config["cluster"]), ":cluster/"),
        "SCALABILITY_PARENT_SERVICE": _tail_name(str(config["parent_service"]), ":service/"),
        "SCALABILITY_STATE_MACHINE_ARN": str(config["step_functions_arn"]),
        "SCALABILITY_MIN_CAPACITY": str(config["parent_min_capacity"]),
        "SCALABILITY_INPUT_BUCKET": str(config["input_bucket"]),
        "PLAYBACK_BASE_URL": str(config["playback_base_url"]),
    })
    if "sizeBytes" in fixture:
        env["SCALABILITY_FIXTURE_BYTES"] = str(fixture["sizeBytes"])
    if "sha256" in fixture:
        env["SCALABILITY_FIXTURE_SHA256"] = str(fixture["sha256"])
    return subprocess.run(
        [node, str(CLI), "test", "--grep", "@scalability", "--project", "scalability", "--retries", "0"],
        cwd=ROOT / "app/frontend",
        env=env,
        check=False,
    ).returncode


def _full(config: dict[str, Any]) -> int:
    _validate(config, True)
    evidence = Path(os.environ.get("SCALABILITY_E2E_EVIDENCE_DIR", "artifacts/scalability-e2e")).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    batch_size = 0
    try:
        observed = _preflight(config)
        plan = _plan(config, float(observed["scaleOutEvaluationSeconds"]), float(observed["scaleInEvaluationSeconds"]))
        batch_size = int(plan["batchSize"])
        fixture = fixture_record(Path(str(config["fixture_path"])).expanduser(), float(config["fixture_duration_seconds"]))
        recorded = {
            **plan,
            "recordedAt": _now(),
            "fixture": fixture,
            "region": config["region"],
            "imageDigests": {"api": config["api_image_digest"], "worker": config["worker_image_digest"]},
            "observed": observed["summary"],
        }
        (evidence / "planned-workload.json").write_text(json.dumps(recorded, indent=2) + "\n", encoding="utf-8")
        (evidence / "preflight.json").write_text(json.dumps(observed["summary"], indent=2) + "\n", encoding="utf-8")
        code = _playwright(config, evidence, plan, fixture)
        if code != 0:
            _ensure_workload(evidence, batch_size, f"playwright exited {code}")
        return code
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        _ensure_workload(evidence, batch_size, str(error))
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="validate local configuration only")
    group.add_argument("--full", action="store_true", help="run the one opted-in distributed workload")
    args = parser.parse_args()
    if args.check:
        return _check()
    try:
        config = _read_config()
        if not config:
            raise ValueError("SCALABILITY_E2E_CONFIG is required for --full")
        return _full(config)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"scalability E2E blocked: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
