#!/usr/bin/env python3
"""Fail-closed entry point for the single distributed scalability workload.

This module only validates configuration and dispatches the dedicated Playwright
project. It never provisions, updates, or tears down AWS resources.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "app/frontend/node_modules/@playwright/test/cli.js"
REQUIRED = {
    "account_id", "region", "environment", "api_url", "frontend_url",
    "playback_base_url", "cluster", "worker_service", "parent_service",
    "step_functions_arn", "api_image_digest", "worker_image_digest",
    "distributed_mode", "parent_min_capacity",
    "fixture_path", "fixture_duration_seconds", "worker_min_capacity",
    "worker_max_capacity", "backlog_per_worker_target", "processing_seconds",
    "scale_out_cooldown_seconds", "scale_in_cooldown_seconds", "runtime_budget_seconds",
}


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
    for name in ("api_url", "frontend_url", "playback_base_url"):
        if not isinstance(config[name], str) or not config[name].startswith(("http://", "https://")):
            raise ValueError(f"{name} must be an HTTP(S) URL")
    for name in ("worker_min_capacity", "worker_max_capacity"):
        if not isinstance(config[name], int) or config[name] < 1:
            raise ValueError(f"{name} must be a positive integer")
    if config["worker_min_capacity"] != 1 or config["worker_max_capacity"] < 2:
        raise ValueError("worker capacity must support minimum 1 and scale-out to at least 2")
    if config["distributed_mode"] is not True or config["parent_min_capacity"] != 1:
        raise ValueError("live preflight requires distributed mode and parent minimum capacity 1")
    for name in ("backlog_per_worker_target", "processing_seconds", "runtime_budget_seconds",
                 "scale_out_cooldown_seconds", "scale_in_cooldown_seconds", "fixture_duration_seconds"):
        if not isinstance(config[name], (int, float)) or config[name] <= 0:
            raise ValueError(f"{name} must be positive")
    fixture = Path(str(config["fixture_path"])).expanduser()
    if live and (not fixture.is_file() or fixture.stat().st_size == 0):
        raise ValueError("fixture_path must identify a non-empty 720p-or-higher fixture")
    if live and not os.environ.get("SCALABILITY_E2E_ALLOW_LIVE") == "true":
        raise ValueError("set SCALABILITY_E2E_ALLOW_LIVE=true for the dedicated live environment")


def _batch(config: dict[str, Any]) -> tuple[int, str]:
    target = float(config["backlog_per_worker_target"])
    capacity = int(config["worker_min_capacity"])
    processing = float(config["processing_seconds"])
    budget = float(config["runtime_budget_seconds"])
    cooldown = float(config["scale_out_cooldown_seconds"])
    # The +1 is intentional: it puts visible backlog strictly above the target,
    # while the budget check prevents an unbounded workload.
    count = int(target * capacity) + 1
    if count <= target * capacity or processing + cooldown >= budget:
        raise ValueError("runtime budget cannot observe the configured scale-out target")
    return count, (f"ceil(target {target} * initial workers {capacity}) + 1; "
                   f"{count} jobs makes backlog/worker exceed {target} while "
                   f"processing ({processing}s) and scale-out cooldown ({cooldown}s) fit "
                   f"within the {budget}s budget")


def _check() -> int:
    try:
        config = _read_config()
        if config:
            _validate(config, False)
            count, rationale = _batch(config)
            print(json.dumps({"status": "passed", "mode": "offline", "batchSize": count,
                              "rationale": rationale}, sort_keys=True))
        else:
            print("offline check passed (SCALABILITY_E2E_CONFIG is not configured; no AWS calls made)")
        return 0
    except ValueError as error:
        print(f"offline check failed: {error}", file=sys.stderr)
        return 2


def _full(config: dict[str, Any]) -> int:
    _validate(config, True)
    _observe_parent_service(config)
    count, rationale = _batch(config)
    evidence = Path(os.environ.get("SCALABILITY_E2E_EVIDENCE_DIR", "artifacts/scalability-e2e")).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    (evidence / "planned-workload.json").write_text(json.dumps({
        "batchSize": count, "rationale": rationale, "target": config["backlog_per_worker_target"],
        "recordedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "fixture": config["fixture_path"], "region": config["region"],
        "imageDigests": {"api": config["api_image_digest"], "worker": config["worker_image_digest"]},
    }, indent=2) + "\n", encoding="utf-8")
    node = shutil.which("node")
    if node is None or not CLI.is_file():
        raise ValueError("Playwright CLI is unavailable; install frontend dependencies")
    env = os.environ.copy()
    env.update({"E2E_ENVIRONMENT": "disposable", "E2E_PROJECT": "chromium",
                "E2E_FRONTEND_URL": config["frontend_url"], "E2E_API_URL": config["api_url"],
                "E2E_INCLUDE_SCALABILITY": "true", "SCALABILITY_BATCH_SIZE": str(count),
                "SCALABILITY_FIXTURE_PATH": str(config["fixture_path"]),
                "SCALABILITY_RUNTIME_BUDGET_SECONDS": str(config["runtime_budget_seconds"]),
                "SCALABILITY_EVIDENCE_DIR": str(evidence), "PLAYBACK_BASE_URL": config["playback_base_url"]})
    return subprocess.run([node, str(CLI), "test", "--grep", "@scalability", "--project", "scalability",
                           "--retries", "0"], cwd=ROOT / "app/frontend", env=env, check=False).returncode


def _observe_parent_service(config: dict[str, Any]) -> None:
    """Read-only live gate: identity, region, and the current parent readiness."""
    aws = shutil.which("aws")
    if aws is None:
        raise ValueError("aws CLI is required for live preflight")

    def call(arguments: list[str]) -> Any:
        result = subprocess.run([aws, *arguments], capture_output=True, text=True, check=False,
                                timeout=30)
        if result.returncode != 0:
            raise ValueError("live preflight observation failed")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise ValueError("live preflight returned invalid observation data") from error

    identity = call(["sts", "get-caller-identity", "--query", "Account", "--output", "json"])
    if identity != config["account_id"]:
        raise ValueError("AWS account does not match the dedicated handoff")
    services = call(["ecs", "describe-services", "--region", config["region"],
                     "--cluster", config["cluster"], "--services", config["parent_service"],
                     "--query", "services[0].{running:runningCount,desired:desiredCount}", "--output", "json"])
    if not isinstance(services, dict) or services.get("running", 0) < 1 or services.get("desired", 0) < 1:
        raise ValueError("parent service is not ready at its configured minimum")


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
    except (OSError, ValueError) as error:
        print(f"scalability E2E blocked: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
