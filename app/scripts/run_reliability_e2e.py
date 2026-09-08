#!/usr/bin/env python3
"""Safe entry point for the Phase 2 reliability browser checks.

This module deliberately keeps the preflight independent of AWS, Docker, and
the application.  A live run is an explicit, disposable opt-in followed by
the same validation against the exact targets that the scenario will use.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from uuid import uuid4
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


SCENARIOS = {
    "preflight": ("@preflight", "local/browser/API readiness"),
    "runtime-authorization": ("@reliability", "reliability runtime authorization"),
}
TOOLS = ("node", "npm", "npx", "ffmpeg")
URL_NAMES = ("E2E_FRONTEND_URL", "E2E_API_URL")
IDENTITY_NAMES = (
    "E2E_SOURCE_QUEUE",
    "E2E_DLQ",
    "E2E_SOURCE_BUCKET",
    "E2E_OUTPUT_BUCKET",
    "E2E_WORKER_OBSERVATION",
    "E2E_DATABASE_OBSERVATION",
    "E2E_WORKER_PROCESS_CONTROL",
    "E2E_DATABASE_PROCESS_CONTROL",
)
TIMING_NAMES = (
    "E2E_NAVIGATION_TIMEOUT_MS",
    "E2E_UPLOAD_TIMEOUT_MS",
    "E2E_PROCESSING_TIMEOUT_MS",
    "E2E_LEASE_TIMEOUT_MS",
    "E2E_VISIBILITY_TIMEOUT_MS",
    "E2E_DLQ_TIMEOUT_MS",
    "E2E_PLAYBACK_TIMEOUT_MS",
)


@dataclass(frozen=True)
class LiveConfig:
    evidence_dir: Path
    scenario: str


def _value(name: str, *, required: bool = False) -> str | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        if required:
            raise ValueError(f"{name} is required")
        return None
    return value.strip()


def _validate_url(name: str, value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{name} must be a valid http or https URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{name} must not contain credentials or a query")


def _validate_identity(name: str, value: str) -> None:
    # Resource names/ARNs are identifiers, not connection strings.  This also
    # prevents accidental logging or acceptance of a secret as a target.
    if len(value) > 512 or any(char.isspace() for char in value):
        raise ValueError(f"{name} must be a non-secret resource identifier")
    if "://" in value or "?" in value or "&" in value or "=" in value:
        raise ValueError(f"{name} must be a non-secret resource identifier")
    if re.search(r"(password|passwd|secret|token|credential|receipt)", value, re.I):
        raise ValueError(f"{name} must be a non-secret resource identifier")


def _validate_timeout(name: str, value: str) -> None:
    try:
        milliseconds = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer in milliseconds") from exc
    if milliseconds <= 0 or milliseconds > 900_000:
        raise ValueError(f"{name} must be a positive integer in milliseconds")


def _validate_common_inputs(*, live: bool) -> None:
    environment = _value("E2E_ENVIRONMENT")
    if environment is not None and environment != "disposable":
        raise ValueError("E2E_ENVIRONMENT must be disposable")
    disposable = _value("E2E_RELIABILITY_DISPOSABLE")
    if disposable is not None and disposable != "true":
        raise ValueError("E2E_RELIABILITY_DISPOSABLE must be true")

    for name in URL_NAMES:
        value = _value(name)
        if value is None:
            if live:
                raise ValueError(f"{name} is required")
            continue
        _validate_url(name, value)

    for name in IDENTITY_NAMES:
        value = _value(name)
        if value is None:
            if live:
                raise ValueError(f"{name} is required")
            continue
        _validate_identity(name, value)

    for name in TIMING_NAMES:
        value = _value(name)
        if value is not None:
            _validate_timeout(name, value)

    attempts = _value("E2E_MAX_ATTEMPTS")
    if attempts is not None:
        try:
            parsed = int(attempts)
        except ValueError as exc:
            raise ValueError("E2E_MAX_ATTEMPTS must be a positive integer") from exc
        if not 1 <= parsed <= 10:
            raise ValueError("E2E_MAX_ATTEMPTS must be between 1 and 10")
    elif live:
        raise ValueError("E2E_MAX_ATTEMPTS is required")

    alarms = _value("E2E_ALARM_IDENTIFIERS")
    if alarms is not None:
        alarm_values = [item.strip() for item in alarms.split(",") if item.strip()]
        if not alarm_values:
            raise ValueError("E2E_ALARM_IDENTIFIERS must contain at least one identifier")
        for item in alarm_values:
            _validate_identity("E2E_ALARM_IDENTIFIERS", item)
    elif live:
        raise ValueError("E2E_ALARM_IDENTIFIERS is required")

    source_dlq = _value("E2E_SOURCE_DLQ")
    declared_dlq = _value("E2E_DLQ")
    if source_dlq is not None:
        _validate_identity("E2E_SOURCE_DLQ", source_dlq)
        if declared_dlq is not None and source_dlq != declared_dlq:
            raise ValueError("E2E_SOURCE_DLQ must match E2E_DLQ")
    elif live:
        raise ValueError("E2E_SOURCE_DLQ is required to verify the source-to-DLQ relationship")

    relationship = _value("E2E_SOURCE_DLQ_RELATIONSHIP")
    if relationship is not None and relationship.lower() not in {"configured", "verified"}:
        raise ValueError("E2E_SOURCE_DLQ_RELATIONSHIP must be configured or verified")
    if live and relationship != "verified":
        raise ValueError("E2E_SOURCE_DLQ_RELATIONSHIP=verified is required")

    for name in ("E2E_WORKER_CONTROL_SCOPE", "E2E_DATABASE_CONTROL_SCOPE"):
        value = _value(name)
        if value is not None:
            _validate_identity(name, value)

    evidence = _value("E2E_EVIDENCE_DIR")
    if evidence is not None:
        path = Path(evidence)
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError("E2E_EVIDENCE_DIR must be an absolute run-owned path")


def _check_tools() -> list[str]:
    return [tool for tool in TOOLS if shutil.which(tool) is None]


def _check() -> int:
    missing = _check_tools()
    try:
        _validate_common_inputs(live=False)
    except ValueError as error:
        print(f"offline check failed: {error}", file=sys.stderr)
        return 2
    if missing:
        print(f"offline check failed: required local tool(s) missing: {', '.join(missing)}", file=sys.stderr)
        return 2
    configured = all(_value(name) is not None for name in (
        *URL_NAMES,
        *IDENTITY_NAMES,
        "E2E_SOURCE_DLQ",
        "E2E_SOURCE_DLQ_RELATIONSHIP",
        "E2E_MAX_ATTEMPTS",
        "E2E_WORKER_CONTROL_SCOPE",
        "E2E_DATABASE_CONTROL_SCOPE",
        "E2E_EVIDENCE_DIR",
    )) and _value("E2E_ENVIRONMENT") == "disposable" and _value("E2E_RELIABILITY_DISPOSABLE") == "true"
    print("offline check passed" + (" (live configuration not configured)" if not configured else ""))
    return 0


def _live_config(scenario: str) -> LiveConfig:
    if _value("E2E_ENVIRONMENT") != "disposable":
        raise ValueError("E2E_ENVIRONMENT=disposable is required")
    if _value("E2E_RELIABILITY_DISPOSABLE") != "true":
        raise ValueError("E2E_RELIABILITY_DISPOSABLE=true is required")
    _validate_common_inputs(live=True)
    for name in ("E2E_WORKER_CONTROL_SCOPE", "E2E_DATABASE_CONTROL_SCOPE"):
        value = _value(name, required=True)
        assert value is not None
        _validate_identity(name, value)
        if value.lower() in {"all", "host", "shared", "production"}:
            raise ValueError(f"{name} must identify only the disposable test-owned boundary")
    evidence_root = Path(_value("E2E_EVIDENCE_DIR", required=True) or "")
    run_id = f"e2e-{uuid4()}"
    return LiveConfig(evidence_root / run_id, scenario)


def _run(config: LiveConfig) -> int:
    config.evidence_dir.mkdir(parents=True, exist_ok=True)
    grep, _ = SCENARIOS[config.scenario]
    args = ["npm", "run", "test:e2e", "--", "--grep", grep]
    if config.scenario == "runtime-authorization":
        args.extend(["--project", "reliability"])
    child_environment = os.environ.copy()
    child_environment["E2E_RUN_ID"] = config.evidence_dir.name
    child_environment["E2E_EVIDENCE_DIR"] = str(config.evidence_dir)
    result = subprocess.run(
        args,
        cwd=Path(__file__).parents[1] / "frontend",
        env=child_environment,
        check=False,
    )
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Safe Phase 2 reliability E2E runner")
    parser.add_argument("--check", action="store_true", help="validate local tools and supplied settings only")
    parser.add_argument("--list", action="store_true", help="list implemented scenario selectors")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="preflight")
    args = parser.parse_args(argv)
    if args.list:
        for selector, (_, description) in SCENARIOS.items():
            print(f"{selector}\t{description}")
        return 0
    if args.check:
        return _check()
    try:
        return _run(_live_config(args.scenario))
    except (OSError, ValueError) as error:
        print(f"live preflight failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
