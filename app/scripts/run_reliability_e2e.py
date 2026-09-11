#!/usr/bin/env python3
"""Offline configuration checks and fail-closed reliability scenario dispatch."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from dataclasses import dataclass
from uuid import uuid4

SCENARIOS = {
    "preflight": ("@preflight", "local/browser/API readiness"),
    "runtime-authorization": ("@reliability", "reliability authorization"),
    "duplicate-delivery": ("@duplicate-delivery", "active and completed redelivery with correlated media and acknowledgement evidence"),
    "crash-recovery": ("@crash-recovery", "worker crash recovery after lease and visibility expiry"),
    "long-heartbeat": ("@long-heartbeat", "multiple correlated heartbeat lease and visibility renewals"),
    "ffmpeg-exhaustion": ("@ffmpeg-exhaustion", "invalid media FFmpeg exhaustion and run-owned DLQ isolation"),
    "poison-isolation": ("@poison-isolation", "malformed and unknown-job poison DLQ isolation with a concurrently valid job"),
    "queue-monitoring": ("@queue-monitoring", "read-only source backlog, DLQ depth, and alarm observation correlated with failure evidence"),
}
TOOLS = ("node", "npm", "npx", "ffmpeg", "aws", "docker")
SAFETY_CLI = Path(__file__).resolve().parents[1] / "frontend/e2e/reliability/safety-cli.mjs"


@dataclass(frozen=True)
class LiveConfig:
    """The unique evidence destination and selected scenario for one run."""
    evidence_dir: Path
    scenario: str
    ffmpeg_evidence_run: str | None = None
    poison_evidence_run: str | None = None


def _settings(mode: str) -> dict:
    """Run the same pure validator as Playwright, without exposing child diagnostics."""
    node = shutil.which("node")
    if node is None:
        raise ValueError("required local tool missing: node")
    try:
        result = subprocess.run(
            [node, str(SAFETY_CLI), mode], capture_output=True, text=True,
            check=False, timeout=130 if mode in ("authorize", "preflight") else 10,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        raise ValueError("local safety validation could not complete") from error
    if not isinstance(payload, dict):
        raise ValueError("invalid safety validation response")
    if result.returncode != 0:
        # The shared validator emits only fixed messages and configuration names.
        raise ValueError(payload.get("error", "local safety validation failed"))
    if mode in ("authorize", "preflight"):
        if payload.get("status") != "verified":
            raise ValueError("invalid live verification response")
        return payload
    if not isinstance(payload.get("configured"), bool):
        raise ValueError("invalid safety validation response")
    return payload


def _check_tools() -> list[str]:
    """Check local executable availability without starting live dependencies."""
    return [tool for tool in TOOLS if shutil.which(tool) is None]


def _check() -> int:
    """Allow absent live settings, but reject malformed values and missing tools."""
    missing = _check_tools()
    if missing:
        print(f"offline check failed: required local tool(s) missing: {', '.join(missing)}", file=sys.stderr)
        return 2
    try:
        configured = _settings("check")["configured"]
    except ValueError as error:
        print(f"offline check failed: {error}", file=sys.stderr)
        return 2
    status = "configured; live resources not verified" if configured else "not configured"
    print(f"offline check passed (live configuration {status})")
    return 0


def _live_config(scenario: str, ffmpeg_evidence_run: str | None = None, poison_evidence_run: str | None = None) -> LiveConfig:
    """Validate settings without observing targets or creating directories."""
    _settings("validate")
    return LiveConfig(Path(os.environ["E2E_EVIDENCE_DIR"].strip()).resolve() / f"e2e-{uuid4()}", scenario,
                      ffmpeg_evidence_run, poison_evidence_run)


def _preflight() -> int:
    """Verify disposable targets without creating a run or dispatching Playwright."""
    evidence = _settings("preflight")
    record = {**evidence, "scenarioStarted": False}
    evidence_dir = Path(os.environ["E2E_EVIDENCE_DIR"].strip()) / f"preflight-{uuid4()}"
    evidence_dir.mkdir(parents=True, exist_ok=False)
    (evidence_dir / "live-preflight.json").write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(record, sort_keys=True))
    return 0


def _run(config: LiveConfig) -> int:
    """Authorize before creating evidence or dispatching any scenario."""
    _settings("authorize")
    config.evidence_dir.mkdir(parents=True, exist_ok=False)
    grep, _ = SCENARIOS[config.scenario]
    node = shutil.which("node")
    if node is None:
        raise ValueError("required local tool missing: node")
    cli = SAFETY_CLI.parents[2] / "node_modules/@playwright/test/cli.js"
    args = [node, str(cli), "test", "--grep", grep]
    if config.scenario in ("runtime-authorization", "duplicate-delivery", "crash-recovery", "long-heartbeat", "ffmpeg-exhaustion", "poison-isolation", "queue-monitoring"):
        args.extend(["--project", "reliability"])
    child_environment = os.environ.copy()
    if config.scenario in ("runtime-authorization", "duplicate-delivery", "crash-recovery", "long-heartbeat", "ffmpeg-exhaustion", "poison-isolation", "queue-monitoring"):
        child_environment["E2E_INCLUDE_RELIABILITY"] = "true"
    child_environment["E2E_RUN_ID"] = config.evidence_dir.name
    child_environment["E2E_EVIDENCE_DIR"] = str(config.evidence_dir)
    # CLI arguments are authoritative; never inherit an earlier run's selection.
    for name, run_id in (("E2E_FFMPEG_EVIDENCE_RUN", config.ffmpeg_evidence_run),
                         ("E2E_POISON_EVIDENCE_RUN", config.poison_evidence_run)):
        child_environment.pop(name, None)
        if config.scenario == "queue-monitoring" and run_id is not None:
            child_environment[name] = run_id
    print(json.dumps({"scenario": config.scenario, "evidenceDirectory": str(config.evidence_dir)}), flush=True)
    return subprocess.run(args, cwd=SAFETY_CLI.parents[2], env=child_environment, check=False).returncode


def _evidence_run(value: str) -> str:
    """Accept only generated run directory names, never arbitrary paths."""
    if not re.fullmatch(r"e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value):
        raise argparse.ArgumentTypeError("must be an e2e-<UUIDv4> run directory name")
    return value


def main(argv: list[str] | None = None) -> int:
    """List selectors, inspect local configuration, or request live authorization."""
    parser = argparse.ArgumentParser(description="Safe Phase 2 reliability E2E runner")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true", help="validate local tools and supplied settings only")
    modes.add_argument("--list", action="store_true", help="list implemented scenario selectors")
    modes.add_argument("--live-preflight", action="store_true", help="verify disposable resources without dispatching a scenario")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="preflight")
    parser.add_argument("--ffmpeg-evidence-run", type=_evidence_run, help="FFmpeg evidence run directory under E2E_EVIDENCE_DIR (queue-monitoring only)")
    parser.add_argument("--poison-evidence-run", type=_evidence_run, help="poison evidence run directory under E2E_EVIDENCE_DIR (queue-monitoring only)")
    args = parser.parse_args(argv)
    if (args.ffmpeg_evidence_run is not None or args.poison_evidence_run is not None) and (
            args.scenario != "queue-monitoring" or args.list or args.check or args.live_preflight):
        parser.error("evidence run arguments require --scenario queue-monitoring without offline/preflight modes")
    if args.list:
        for selector, (_, description) in SCENARIOS.items():
            print(f"{selector}\t{description}")
        return 0
    if args.check:
        return _check()
    if args.live_preflight:
        try:
            return _preflight()
        except (ValueError, OSError) as error:
            print(json.dumps({"status": "blocked", "message": str(error) if isinstance(error, ValueError) else "local preflight evidence could not be written", "scenarioStarted": False}), file=sys.stderr)
            return 2
    try:
        return _run(_live_config(args.scenario, args.ffmpeg_evidence_run, args.poison_evidence_run))
    except (ValueError, OSError) as error:
        # No environment values or unredacted service errors enter this evidence.
        print(json.dumps({"status": "blocked", "scenario": args.scenario,
                          "message": str(error) if isinstance(error, ValueError) else "local scenario dispatch failed", "liveResourcesVerified": False,
                          "scenarioStarted": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
