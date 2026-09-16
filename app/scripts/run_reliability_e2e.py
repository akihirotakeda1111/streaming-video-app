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
from datetime import datetime
import math

SUITE_ID = "phase3-cloudfront-delivery-e2e-regression"
SCENARIOS = {
    "delivery-preflight": ("@delivery-preflight", "read-only CloudFront/private S3 resource verification"),
    "preflight": ("@preflight", "local/browser/API readiness"),
    "runtime-authorization": ("@reliability", "reliability authorization"),
    "duplicate-delivery": ("@duplicate-delivery", "active and completed redelivery with correlated media and acknowledgement evidence"),
    "crash-recovery": ("@crash-recovery", "worker crash recovery after lease and visibility expiry"),
    "long-heartbeat": ("@long-heartbeat", "multiple correlated heartbeat lease and visibility renewals"),
    "ffmpeg-exhaustion": ("@ffmpeg-exhaustion", "invalid media FFmpeg exhaustion and run-owned DLQ isolation"),
    "poison-isolation": ("@poison-isolation", "malformed and unknown-job poison DLQ isolation with a concurrently valid job"),
    "queue-monitoring": ("@queue-monitoring", "read-only source backlog, DLQ depth, and alarm observation correlated with failure evidence"),
    "delivery-regression": ("@delivery-regression", "previously completed private output replay through CloudFront"),
}
FULL_LIVE_SCENARIOS = (
    "duplicate-delivery",
    "crash-recovery",
    "long-heartbeat",
    "ffmpeg-exhaustion",
    "poison-isolation",
    "queue-monitoring",
)
COMPONENT_CHECKS = (
    "cargo test --manifest-path app/backend/worker/Cargo.toml each_pipeline_failure_obeys_attempt_budget_and_cleans_up",
    "cargo test --manifest-path app/backend/worker/Cargo.toml partial_upload_redelivery_reacquires_and_publishes_before_acknowledgement",
    "cargo test --manifest-path app/backend/worker/Cargo.toml stale_owner_and_database_errors_never_report_terminal_success",
    "cargo test --manifest-path app/backend/worker/Cargo.toml delete_failure_redelivery_only_retries_acknowledgement",
)
TOOLS = ("node", "npm", "npx", "ffmpeg", "aws", "docker")
SAFETY_CLI = Path(__file__).resolve().parents[1] / "frontend/e2e/reliability/safety-cli.mjs"


@dataclass(frozen=True)
class LiveConfig:
    """The unique evidence destination and selected scenario for one run."""
    evidence_dir: Path
    scenario: str
    ffmpeg_evidence_run: str | None = None
    poison_evidence_run: str | None = None
    playback_evidence_run: str | None = None
    legacy_delivery_fixtures: str | None = None


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


def _live_config(scenario: str, ffmpeg_evidence_run: str | None = None, poison_evidence_run: str | None = None,
                 playback_evidence_run: str | None = None, legacy_delivery_fixtures: str | None = None) -> LiveConfig:
    """Validate settings without observing targets or creating directories."""
    _settings("validate")
    return LiveConfig(Path(os.environ["E2E_EVIDENCE_DIR"].strip()).resolve() / f"e2e-{uuid4()}", scenario,
                      ffmpeg_evidence_run, poison_evidence_run, playback_evidence_run, legacy_delivery_fixtures)


def _preflight() -> int:
    """Verify disposable targets and persist the read-only delivery gate evidence."""
    evidence = _settings("preflight")
    config = _live_config("delivery-preflight")
    code = _run(config)
    if code != 0:
        return code
    _validate_evidence(config, config.evidence_dir / "delivery-preflight-evidence.json")
    evidence["deliveryEvidenceDirectory"] = str(config.evidence_dir)
    record = {**evidence, "scenarioStarted": False}
    evidence_dir = Path(os.environ["E2E_EVIDENCE_DIR"].strip()) / f"preflight-{uuid4()}"
    evidence_dir.mkdir(parents=True, exist_ok=False)
    (evidence_dir / "live-preflight.json").write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(record, sort_keys=True))
    return 0


def _dispatch(config: LiveConfig, selector: str, project: str, reliability: bool) -> int:
    """Authorize before creating evidence or dispatching any scenario."""
    _settings("authorize")
    config.evidence_dir.mkdir(parents=True, exist_ok=False)
    node = shutil.which("node")
    if node is None:
        raise ValueError("required local tool missing: node")
    cli = SAFETY_CLI.parents[2] / "node_modules/@playwright/test/cli.js"
    args = [node, str(cli), "test", "--grep", selector, "--project", project]
    child_environment = os.environ.copy()
    if reliability:
        child_environment["E2E_INCLUDE_RELIABILITY"] = "true"
    else:
        child_environment.pop("E2E_INCLUDE_RELIABILITY", None)
        child_environment["E2E_PROJECT"] = project
    if config.scenario in ("phase1-pipeline", "delivery-regression", "delivery-preflight"):
        args.extend(["--retries", "0"])
    child_environment["E2E_RUN_ID"] = config.evidence_dir.name
    child_environment["E2E_EVIDENCE_DIR"] = str(config.evidence_dir)
    # A full suite must never pick up a historical selection from the parent shell.
    child_environment.pop("E2E_PLAYBACK_EVIDENCE_RUN", None)
    child_environment.pop("E2E_LEGACY_DELIVERY_FIXTURES", None)
    if config.scenario == "delivery-regression":
        if config.playback_evidence_run is not None:
            child_environment["E2E_PLAYBACK_EVIDENCE_RUN"] = config.playback_evidence_run
        if config.legacy_delivery_fixtures is not None:
            child_environment["E2E_LEGACY_DELIVERY_FIXTURES"] = config.legacy_delivery_fixtures
    # CLI arguments are authoritative; never inherit an earlier run's selection.
    for name, run_id in (("E2E_FFMPEG_EVIDENCE_RUN", config.ffmpeg_evidence_run),
                         ("E2E_POISON_EVIDENCE_RUN", config.poison_evidence_run)):
        child_environment.pop(name, None)
        if config.scenario == "queue-monitoring" and run_id is not None:
            child_environment[name] = run_id
    print(json.dumps({"scenario": config.scenario, "evidenceDirectory": str(config.evidence_dir)}), flush=True)
    return subprocess.run(args, cwd=SAFETY_CLI.parents[2], env=child_environment, check=False).returncode


def _run(config: LiveConfig) -> int:
    """Dispatch one registered reliability scenario."""
    if config.scenario in ("delivery-preflight", "delivery-regression"):
        return _dispatch(config, SCENARIOS[config.scenario][0], "chromium", False)
    if config.scenario == "preflight":
        return _dispatch(config, SCENARIOS[config.scenario][0],
                         os.environ.get("E2E_PROJECT", "").strip() or "chromium", False)
    return _dispatch(config, SCENARIOS[config.scenario][0], "reliability", True)


def _validate_evidence(config: LiveConfig, evidence_file: Path) -> None:
    """Require a completed artifact belonging to this scenario and run."""
    try:
        evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError("scenario evidence is missing or unreadable") from None
    if not isinstance(evidence, dict) or (
        evidence.get("scenario") != config.scenario
        or evidence.get("runId") != config.evidence_dir.name
        or evidence.get("status") != "passed"
    ):
        raise ValueError("scenario evidence is incomplete or does not match this run")
    if config.scenario == "queue-monitoring" and evidence.get("outstanding") != []:
        raise ValueError("queue monitoring evidence remains outstanding")


def _historical_acceptance(parent: Path, run_id: str | None) -> dict:
    row = {"name": "historical-compatibility", "status": "unexecuted",
           "reason": "separate pre-cutover Phase 1/2 replay evidence is required"}
    if run_id is None:
        return row
    row.update(runId=run_id)
    try:
        _evidence_run(run_id)
        file = parent / run_id / "delivery-regression-evidence.json"
        if file.resolve() != file:
            raise ValueError("redirected evidence")
        _validate_evidence(LiveConfig(parent / run_id, "delivery-regression"), file)
        evidence = json.loads(file.read_text(encoding="utf-8"))
        replay = evidence["diagnostics"]["cloudfront-completed-replay"]
        expected = {"outputBucket": os.environ.get("E2E_OUTPUT_BUCKET"),
                    "account": os.environ.get("E2E_AWS_ACCOUNT_ID"),
                    "region": os.environ.get("AWS_REGION"),
                    "playbackOrigin": os.environ.get("PLAYBACK_BASE_URL", "").rstrip("/")}
        if (replay["evidenceVersion"] != 1 or replay["verificationScope"] != "pre-cutover-compatibility"
                or any(not value or replay.get(key) != value for key, value in expected.items())):
            raise ValueError("historical scope or target mismatch")
        captured, cutover, observed = (datetime.fromisoformat(value.replace("Z", "+00:00"))
                                       for value in (replay["capturedAt"], replay["cutoverAt"], evidence["observedAt"]))
        if any(value.tzinfo is None for value in (captured, cutover, observed)) or not (captured < cutover <= observed <= datetime.now(observed.tzinfo)):
            raise ValueError("invalid historical chronology")
        jobs = replay["checked"]
        if not isinstance(jobs, list) or not 2 <= len(jobs) <= 10:
            raise ValueError("missing historical jobs")
        phases, videos = set(), set()
        uuid = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        for job in jobs:
            video, job_id = job["videoId"], job["jobId"]
            advancement = job["advancement"]
            if (not re.fullmatch(uuid, video, re.I) or not re.fullmatch(uuid, job_id, re.I)
                    or video in videos or job["phase"] not in ("phase1", "phase2")
                    or job["path"] != f"/videos/{video}/jobs/{job_id}/hls/index.m3u8"
                    or not re.fullmatch(r'"[a-fA-F0-9]+(?:-\d+)?"', job["manifestETag"])
                    or type(advancement) not in (int, float) or not math.isfinite(advancement) or advancement <= 0.05):
                raise ValueError("invalid historical playback proof")
            phases.add(job["phase"])
            videos.add(video)
        if phases != {"phase1", "phase2"}:
            raise ValueError("both phases required")
        return {"name": "historical-compatibility", "status": "passed", "runId": run_id,
                "evidenceFile": str(file), "observedAt": evidence["observedAt"]}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, argparse.ArgumentTypeError):
        return {**row, "status": "blocked", "reason": "historical evidence is invalid, incomplete, or targets another deployment"}


def _full(historical_evidence_run: str | None = None) -> int:
    """Gate delivery resources, run all reliability scenarios, then verify playback."""
    _settings("validate")
    parent = Path(os.environ["E2E_EVIDENCE_DIR"].strip()).resolve()
    report_path = parent / f"full-suite-{uuid4()}.json"
    rows: list[dict[str, object]] = []
    completed: dict[str, str] = {}

    def run_row(name: str, selector: str, project: str, reliability: bool,
                ffmpeg_evidence_run: str | None = None,
                poison_evidence_run: str | None = None,
                playback_evidence_run: str | None = None, **extra: object) -> int:
        row = {"name": name, "selector": selector, "project": project,
               "status": "unexecuted", **extra}
        rows.append(row)
        try:
            config = _live_config(name, ffmpeg_evidence_run, poison_evidence_run, playback_evidence_run)
            evidence_file = config.evidence_dir / f"{name}-evidence.json"
            row.update(runId=config.evidence_dir.name, evidenceDirectory=str(config.evidence_dir),
                       evidenceFile=str(evidence_file))
            code = _dispatch(config, selector, project, reliability)
        except (ValueError, OSError):
            # Do not copy arbitrary process/filesystem diagnostics into the report.
            row.update(status="blocked", reason="scenario configuration, authorization or dispatch failed")
            return 2
        row["status"] = "passed" if code == 0 else "failed"
        if code == 0:
            try:
                _validate_evidence(config, evidence_file)
            except ValueError as error:
                row.update(status="failed", reason=str(error))
                return 1
            completed[name] = config.evidence_dir.name
        return code

    failed = run_row("delivery-preflight", "@delivery-preflight", "chromium", False) != 0
    for name in FULL_LIVE_SCENARIOS:
        if failed:
            break
        if name == "queue-monitoring":
            code = run_row(
                name, SCENARIOS[name][0], "reliability", True,
                ffmpeg_evidence_run=completed.get("ffmpeg-exhaustion"),
                poison_evidence_run=completed.get("poison-isolation"),
                ffmpegEvidenceRun=completed.get("ffmpeg-exhaustion"),
                poisonEvidenceRun=completed.get("poison-isolation"),
            )
        else:
            code = run_row(name, SCENARIOS[name][0], "reliability", True)
        if code != 0:
            failed = True
            break

    if not failed:
        run_row("phase1-pipeline", "@phase1-pipeline", "chromium", False)
        failed = rows[-1]["status"] != "passed"

    if not failed:
        run_row("delivery-regression", "@delivery-regression", "chromium", False,
                playback_evidence_run=completed["phase1-pipeline"],
                playbackEvidenceRun=completed["phase1-pipeline"],
                verificationScope="completed-job-replay")
        failed = rows[-1]["status"] != "passed"

    for name in FULL_LIVE_SCENARIOS:
        if not any(row["name"] == name for row in rows):
            rows.append({"name": name, "selector": SCENARIOS[name][0], "project": "reliability",
                         "status": "unexecuted", "reason": "earlier full-suite scenario failed"})
    if not any(row["name"] == "phase1-pipeline" for row in rows):
        rows.append({"name": "phase1-pipeline", "selector": "@phase1-pipeline", "project": "chromium",
                     "status": "unexecuted", "reason": "failure or missing scenario prevented final upload"})
    if not any(row["name"] == "delivery-regression" for row in rows):
        rows.append({"name": "delivery-regression", "selector": "@delivery-regression", "project": "chromium",
                     "status": "unexecuted", "reason": "failure prevented completed-output replay"})

    historical = _historical_acceptance(parent, historical_evidence_run)
    execution_status = "blocked" if any(row["status"] == "blocked" for row in rows) else "failed" if failed else "passed"
    acceptance_status = ("blocked" if historical["status"] == "blocked" else
                         execution_status if execution_status != "passed" else
                         "passed" if historical["status"] == "passed" else "incomplete")
    report = {
        "suite": SUITE_ID,
        "status": "blocked" if historical["status"] == "blocked" else execution_status,
        "statusScope": "current-regression",
        "executionStatus": execution_status,
        "acceptanceStatus": acceptance_status,
        "acceptanceChecks": [historical],
        "componentChecks": [{"command": command, "status": "declared; run by offline validation"}
                            for command in COMPONENT_CHECKS],
        "liveEvidence": rows,
        "unexecutedLiveChecks": [row["name"] for row in [*rows, historical] if row["status"] == "unexecuted"],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "executionStatus": execution_status,
                      "acceptanceStatus": acceptance_status, "report": str(report_path)}, sort_keys=True), flush=True)
    return 2 if report["status"] == "blocked" else 1 if failed else 0


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
    modes.add_argument("--full", "--full-suite", action="store_true", help="run all reliability scenarios serially and finish with Phase 1 playback")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="preflight")
    parser.add_argument("--historical-evidence-run", type=_evidence_run,
                        help="completed pre-cutover replay evidence to aggregate (full-suite only)")
    parser.add_argument("--ffmpeg-evidence-run", type=_evidence_run, help="FFmpeg evidence run directory under E2E_EVIDENCE_DIR (queue-monitoring only)")
    parser.add_argument("--poison-evidence-run", type=_evidence_run, help="poison evidence run directory under E2E_EVIDENCE_DIR (queue-monitoring only)")
    delivery_source = parser.add_mutually_exclusive_group()
    delivery_source.add_argument("--playback-evidence-run", type=_evidence_run,
                                 help="successful Phase 1 playback run under E2E_EVIDENCE_DIR (delivery-regression only)")
    delivery_source.add_argument("--legacy-delivery-fixtures", type=lambda value: str(Path(value).resolve()),
                                 help="pre-cutover Phase 1/2 inventory JSON (delivery-regression only)")
    args = parser.parse_args(argv)
    if args.historical_evidence_run is not None and not args.full:
        parser.error("historical evidence requires --full-suite")
    if (args.playback_evidence_run is not None or args.legacy_delivery_fixtures is not None) and (
            args.scenario != "delivery-regression" or args.list or args.check or args.live_preflight or args.full):
        parser.error("delivery source arguments require --scenario delivery-regression without other modes")
    if (args.ffmpeg_evidence_run is not None or args.poison_evidence_run is not None) and (
            args.scenario != "queue-monitoring" or args.list or args.check or args.live_preflight or args.full):
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
    if args.full:
        try:
            return _full(args.historical_evidence_run) if args.historical_evidence_run else _full()
        except (ValueError, OSError) as error:
            print(json.dumps({"status": "blocked", "suite": SUITE_ID,
                              "statusScope": "current-regression", "executionStatus": "blocked", "acceptanceStatus": "blocked",
                              "message": str(error) if isinstance(error, ValueError) else "full-suite dispatch failed",
                              "liveResourcesVerified": False}), file=sys.stderr)
            return 2
    try:
        return _run(_live_config(args.scenario, args.ffmpeg_evidence_run, args.poison_evidence_run,
                                 args.playback_evidence_run, args.legacy_delivery_fixtures))
    except (ValueError, OSError) as error:
        # No environment values or unredacted service errors enter this evidence.
        print(json.dumps({"status": "blocked", "scenario": args.scenario,
                          "message": str(error) if isinstance(error, ValueError) else "local scenario dispatch failed", "liveResourcesVerified": False,
                          "scenarioStarted": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
