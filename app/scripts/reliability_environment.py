#!/usr/bin/env python3
"""Explicit, isolated provisioning for the two live recovery scenarios.

No credentials are written to generated files. All external diagnostics are
captured: Docker and provider errors can otherwise contain expanded secrets.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import quote
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".reliability-local"
LABEL = "com.streaming-video.e2e."
SECRETS = ("E2E_DB_PASSWORD", "E2E_WORKER_AWS_ACCESS_KEY_ID",
           "E2E_WORKER_AWS_SECRET_ACCESS_KEY", "E2E_WORKER_AWS_SESSION_TOKEN")


def execute(args, *, env=None, cwd=ROOT, timeout=1800):
    try:
        result = subprocess.run(args, cwd=cwd, env=env, text=True,
                                capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError(f"{Path(args[0]).name} could not finish; details suppressed") from None
    if result.returncode:
        raise ValueError(f"{Path(args[0]).name} failed; details suppressed (may contain secrets)")
    return result.stdout.strip()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def clean_env():
    # Prevent unrelated shell configuration from changing project, state or targets.
    return {k: v for k, v in os.environ.items()
            if not k.startswith(("TF_", "COMPOSE_", "DOCKER_", "E2E_"))
            and k not in ("DATABASE_URL", "POSTGRES_PASSWORD")}


def load_config():
    c = json.loads((STATE / "config.json").read_text(encoding="utf-8"))
    if (set(c) != {"scope", "account", "region", "host", "fixture"}
            or not re.fullmatch(r"sv-e2e-[a-f0-9]{16}", c["scope"])
            or not re.fullmatch(r"[0-9]{12}", c["account"])
            or not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", c["region"])
            or not (re.fullmatch(r"unix:///[^\s]+", c["host"])
                    or c["host"] == "npipe:////./pipe/docker_engine")
            or not Path(c["fixture"]).is_absolute()):
        raise ValueError("Invalid local configuration")
    return c


@contextmanager
def locked():
    STATE.mkdir(exist_ok=True)
    lock = STATE / "operation.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError("Another operation holds operation.lock; do not run concurrently") from None
    try:
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        yield
    finally:
        lock.unlink()


class Environment:
    def __init__(self, config):
        self.c = config
        self.env = {**clean_env(), "AWS_REGION": config["region"],
                    "AWS_DEFAULT_REGION": config["region"], "AWS_PAGER": "",
                    "AWS_CLI_AUTO_PROMPT": "off", "AWS_EC2_METADATA_DISABLED": "true",
                    "TF_IN_AUTOMATION": "1"}
        self.tfdir = STATE / "terraform"

    def tf(self, *args):
        if args and args[0] in ("plan", "destroy"):
            # Recover missing/old generated inputs from the validated local config.
            # Credentials never belong in Terraform input variables.
            inputs = self.tfdir / "terraform.tfvars.json"
            write_json(inputs, {key: self.c[key] for key in ("scope", "account", "region")})
            args = (*args, f"-var-file={inputs}")
        return execute(["terraform", f"-chdir={self.tfdir}", *args], env=self.env)

    def docker(self, *args):
        return execute(["docker", "--host", self.c["host"], *args], env=self.env)

    def identity(self):
        data = json.loads(execute(["aws", "sts", "get-caller-identity", "--output", "json"], env=self.env))
        if data.get("Account") != self.c["account"]:
            raise ValueError("AWS account differs from the explicitly configured account")
        info = json.loads(self.docker("info", "--format", "{{json .}}"))
        if not info.get("ID") or info.get("OSType") != "linux" or info.get("Plugins", {}).get("Authorization"):
            raise ValueError("A direct local Linux Docker Engine without authorization plugins is required")
        record = STATE / "engine.json"
        if record.exists() and json.loads(record.read_text())["id"] != info["ID"]:
            raise ValueError("Docker Engine changed; restore the original endpoint")
        write_json(record, {"id": info["ID"]})

    def plan(self):
        self.identity()
        self.tf("init", "-input=false", "-no-color")
        self.tf("validate", "-no-color")
        self.tf("plan", "-input=false", "-no-color", "-out=create.tfplan")
        plan = json.loads(self.tf("show", "-json", "create.tfplan"))
        changes = []
        for change in plan.get("resource_changes", []):
            actions = change["change"]["actions"]
            if actions not in (["create"], ["no-op"], ["read"]):
                raise ValueError("Creation plan would modify existing resources; inspect local state")
            changes.append({"resource": change["address"], "actions": actions})
        write_json(STATE / "plan-summary.json", changes)
        print(json.dumps({"scope": self.c["scope"], "changes": changes}, indent=2))

    def secrets(self):
        for key in SECRETS[:-1]:
            if not os.environ.get(key) or "\n" in os.environ[key] or "\r" in os.environ[key]:
                raise ValueError(f"Manually set {key} (single-line value required)")
        self.env.update({key: os.environ.get(key, "") for key in SECRETS})
        password = quote(self.env["E2E_DB_PASSWORD"], safe="")
        self.env["RECOVERY_DATABASE_URL"] = f"postgres://streaming_video:{password}@postgres:5432/streaming_video?sslmode=disable"
        # Check the worker credentials separately; never silently reuse provisioner credentials.
        worker_env = {k: v for k, v in self.env.items() if not k.startswith("AWS_")}
        worker_env.update(AWS_ACCESS_KEY_ID=self.env[SECRETS[1]],
                          AWS_SECRET_ACCESS_KEY=self.env[SECRETS[2]],
                          AWS_SESSION_TOKEN=self.env[SECRETS[3]],
                          AWS_REGION=self.c["region"], AWS_PAGER="", AWS_EC2_METADATA_DISABLED="true")
        identity = json.loads(execute(["aws", "sts", "get-caller-identity", "--output", "json"], env=worker_env))
        if identity.get("Account") != self.c["account"]:
            raise ValueError("Worker credentials belong to a different AWS account")

    def compose(self, *args):
        # Disable implicit .env loading. The JSON contains only secret placeholders.
        return self.docker("compose", "--env-file", str(STATE / "empty.env"),
                           "--project-name", self.c["scope"], "--file", str(STATE / "compose.json"), *args)

    def up(self):
        self.secrets()  # Fail before paid resource creation if manual inputs are missing.
        fixture = Path(self.c["fixture"])
        if not fixture.is_file() or not 0 < fixture.stat().st_size <= 1024 ** 3:
            raise ValueError("Fixture must exist and be between 1 byte and 1 GiB; run fixture or supply an MP4 at init")
        self.plan()
        print("Creating the dedicated AWS resources...", flush=True)
        self.tf("apply", "-input=false", "-no-color", "create.tfplan")
        outputs = json.loads(self.tf("output", "-json", "environment"))
        document = compose_document(self.c, outputs)
        write_json(STATE / "compose.json", document)
        print("Building and starting the dedicated services...", flush=True)
        self.compose("up", "--build", "--detach", "--wait", "--wait-timeout", "180", "postgres")
        self.compose("run", "--rm", "migrate")
        self.compose("up", "--build", "--detach", "--wait", "--wait-timeout", "180", "api")
        api = self.port("api", "8080")
        self.env["RECOVERY_API_URL"] = api + "/api/v1"
        self.compose("up", "--build", "--detach", "--wait", "--wait-timeout", "180", "worker", "frontend")
        frontend = self.port("frontend", "5173")
        # Keep the allocated API port while updating its CORS origin.
        document["services"]["api"]["ports"] = [api.removeprefix("http://") + ":8080"]
        document["services"]["api"]["environment"]["FRONTEND_ORIGIN"] = frontend
        write_json(STATE / "compose.json", document)
        self.compose("up", "--detach", "--wait", "--wait-timeout", "180", "api")
        env = runtime_settings(self.c, outputs)
        env.update(E2E_API_URL=api, E2E_FRONTEND_URL=frontend)
        for role in ("worker", "database"):
            service = "postgres" if role == "database" else role
            cid = self.compose("ps", "--quiet", service)
            full = self.docker("inspect", "--format", "{{.Id}}", cid)
            if not re.fullmatch(r"[a-f0-9]{64}", full):
                raise ValueError("Could not resolve full container identity")
            env[f"E2E_{role.upper()}_OBSERVATION"] = f"docker:{full}"
            env[f"E2E_{role.upper()}_PROCESS_CONTROL"] = f"docker:{full}"
        write_json(STATE / "environment.json", env)
        self.runner("--live-preflight")

    def port(self, service, port):
        value = self.compose("port", service, port)
        if not re.fullmatch(r"127\.0\.0\.1:[0-9]+", value):
            raise ValueError("Expected a loopback-only published port")
        return "http://" + value

    def runner(self, *args):
        settings = json.loads((STATE / "environment.json").read_text(encoding="utf-8"))
        env = {**self.env, **settings, "PYTHON": sys.executable, "PLAYWRIGHT_HTML_OPEN": "never"}
        # The existing runner validates ownership immediately before every scenario.
        # Its output consists of the existing redacted preflight/test diagnostics.
        result = subprocess.run([sys.executable, str(ROOT / "app/scripts/run_reliability_e2e.py"), *args],
                                cwd=ROOT, env=env, check=False)
        if result.returncode:
            raise ValueError("Recovery runner failed; resources retained for investigation")

    def down(self):
        self.identity()
        # Refuse to destroy Docker storage shared with any non-project container.
        ids = self.docker("ps", "--all", "--quiet", "--no-trunc", "--filter",
                          f"label=com.docker.compose.project={self.c['scope']}").splitlines()
        for cid in ids:
            c = json.loads(self.docker("inspect", cid))[0]
            labels = c["Config"].get("Labels", {})
            if labels.get(LABEL + "scope") != self.c["scope"] or labels.get(LABEL + "disposable") != "true":
                raise ValueError("Container ownership changed; teardown refused")
            for mount in c.get("Mounts", []):
                if mount["Type"] != "volume":
                    raise ValueError("Unexpected container mount; teardown refused")
                volume = json.loads(self.docker("volume", "inspect", mount["Name"]))[0]
                if volume.get("Labels", {}).get(LABEL + "scope") != self.c["scope"]:
                    raise ValueError("Volume ownership changed; teardown refused")
                users = self.docker("ps", "--all", "--quiet", "--no-trunc", "--filter", f"volume={mount['Name']}").splitlines()
                if not set(users).issubset(ids):
                    raise ValueError("Volume is shared; teardown refused")
        # Exact IDs only. No compose expansion or secret values needed for teardown.
        for cid in ids:
            self.docker("container", "rm", "--force", cid)
        volume_name = self.c["scope"] + "-postgres"
        volumes = self.docker("volume", "ls", "--quiet", "--filter", f"label={LABEL}scope={self.c['scope']}").splitlines()
        if volumes:
            if volumes != [volume_name]:
                raise ValueError("Unexpected dedicated volumes; inspect before teardown")
            self.docker("volume", "rm", volume_name)
        networks = self.docker("network", "ls", "--quiet", "--filter", f"label=com.docker.compose.project={self.c['scope']}").splitlines()
        for network in networks:
            self.docker("network", "rm", network)
        self.tf("init", "-input=false", "-no-color")
        self.tf("destroy", "-input=false", "-auto-approve", "-no-color")
        (STATE / "environment.json").unlink(missing_ok=True)
        print("Dedicated resources deleted; local state and evidence retained.")


def compose_document(c, outputs):
    def labels(role):
        return {LABEL + "scope": c["scope"], LABEL + "disposable": "true", LABEL + "role": role}
    aws = {"AWS_REGION": c["region"], "AWS_EC2_METADATA_DISABLED": "true",
           "AWS_ACCESS_KEY_ID": "${E2E_WORKER_AWS_ACCESS_KEY_ID:?required}",
           "AWS_SECRET_ACCESS_KEY": "${E2E_WORKER_AWS_SECRET_ACCESS_KEY:?required}",
           "AWS_SESSION_TOKEN": "${E2E_WORKER_AWS_SESSION_TOKEN:-}",
           "DATABASE_URL": "${RECOVERY_DATABASE_URL:?required}",
           "VIDEO_INPUT_BUCKET": outputs["E2E_SOURCE_BUCKET"], "VIDEO_OUTPUT_BUCKET": outputs["E2E_OUTPUT_BUCKET"]}
    services = {
        "postgres": {"image": "postgres:16-alpine", "environment": {
            "POSTGRES_DB": "streaming_video", "POSTGRES_USER": "streaming_video",
            "POSTGRES_PASSWORD": "${E2E_DB_PASSWORD:?required}"},
            "volumes": ["postgres:/var/lib/postgresql/data"],
            "healthcheck": {"test": ["CMD", "pg_isready", "-U", "streaming_video", "-d", "streaming_video"],
                            "interval": "2s", "timeout": "5s", "retries": 30}},
        "migrate": {"image": "migrate/migrate:v4.19.1", "volumes": [
            str(ROOT / "app/backend/api/internal/persistence/migrations") + ":/migrations:ro"],
            "command": ["-path=/migrations", "-database=${RECOVERY_DATABASE_URL:?required}", "up"]},
        "worker": {"build": str(ROOT / "app/backend/worker"), "environment": {
            **aws, "VIDEO_ENCODING_QUEUE_URL": outputs["E2E_SOURCE_QUEUE"],
            "WORKER_HEARTBEAT_INTERVAL_SECONDS": "30", "WORKER_VISIBILITY_EXTENSION_SECONDS": "120",
            "WORKER_LEASE_DURATION_SECONDS": "300", "WORKER_RETRY_DELAY_SECONDS": "120",
            "WORKER_MAXIMUM_ATTEMPTS": "3", "TMPDIR": "/tmp/video-worker", "FFMPEG_PATH": "/usr/local/bin/ffmpeg"}},
        "api": {"build": str(ROOT / "app/backend/api"), "environment": {
            **aws, "HTTP_ADDR": "0.0.0.0:8080", "FRONTEND_ORIGIN": "http://127.0.0.1:5173",
            "OUTPUT_S3_ENDPOINT": f"https://s3.{c['region']}.amazonaws.com"},
            "ports": ["127.0.0.1::8080"], "healthcheck": {
                "test": ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8080/api/v1/health"],
                "interval": "2s", "timeout": "5s", "retries": 30}},
        "frontend": {"build": str(ROOT / "app/frontend"), "ports": ["127.0.0.1::5173"],
            "environment": {"VITE_API_BASE_URL": "${RECOVERY_API_URL:-http://127.0.0.1:8080/api/v1}"}},
    }
    for name, service in services.items():
        service.update(restart="no", labels=labels("database" if name == "postgres" else name))
    return {"services": services, "volumes": {"postgres": {
        "name": c["scope"] + "-postgres", "labels": labels("database")}}}


def runtime_settings(c, outputs):
    env = {**outputs, "AWS_REGION": c["region"], "E2E_AWS_ACCOUNT_ID": c["account"],
           "E2E_DOCKER_HOST": c["host"], "E2E_ENVIRONMENT": "disposable",
           "E2E_RELIABILITY_DISPOSABLE": "true", "E2E_RECOVERY_EXCLUSIVE": "true",
           "E2E_RECOVERY_FIXTURE": c["fixture"], "E2E_EVIDENCE_DIR": str(STATE / "evidence"),
           "E2E_SOURCE_DLQ": outputs["E2E_DLQ"], "E2E_SOURCE_DLQ_RELATIONSHIP": "verified",
           "E2E_MAX_ATTEMPTS": "3", "E2E_WORKER_CONTROL_SCOPE": c["scope"],
           "E2E_DATABASE_CONTROL_SCOPE": c["scope"]}
    for name, value in {"NAVIGATION": 30000, "UPLOAD": 120000, "PROCESSING": 900000,
                        "LEASE": 360000, "VISIBILITY": 240000, "DLQ": 900000, "PLAYBACK": 120000}.items():
        env[f"E2E_{name}_TIMEOUT_MS"] = str(value)
    return env


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["init", "fixture", "plan", "up", "check", "run", "down"])
    p.add_argument("--account")
    p.add_argument("--region")
    p.add_argument("--docker-host", default="unix:///var/run/docker.sock" if os.name != "nt" else "npipe:////./pipe/docker_engine")
    p.add_argument("--fixture", type=Path)
    p.add_argument("--confirm-scope", help="Explicitly authorize creation or deletion of this scope")
    args = p.parse_args(argv)
    try:
        with locked():
            if args.command == "init":
                if (STATE / "config.json").exists():
                    raise ValueError("Environment already initialized; keep its state to manage its resources")
                if not args.account or not args.region:
                    raise ValueError("init requires --account and --region")
                c = {"scope": "sv-e2e-" + uuid4().hex[:16], "account": args.account, "region": args.region,
                     "host": args.docker_host, "fixture": str((args.fixture or STATE / "long.mp4").resolve())}
                write_json(STATE / "config.json", c)
                try:
                    load_config()
                except ValueError:
                    (STATE / "config.json").unlink()
                    raise
                tfdir = STATE / "terraform"
                tfdir.mkdir(exist_ok=True)
                shutil.copyfile(ROOT / "app/infra/reliability/main.tf", tfdir / "main.tf")
                shutil.copyfile(ROOT / "app/infra/reliability/.terraform.lock.hcl", tfdir / ".terraform.lock.hcl")
                write_json(tfdir / "terraform.tfvars.json", {k: c[k] for k in ("scope", "account", "region")})
                (STATE / "empty.env").write_text("", encoding="utf-8")
                print(json.dumps(c, indent=2))
                return 0
            c = load_config()
            environment = Environment(c)
            if args.command in ("up", "down") and args.confirm_scope != c["scope"]:
                raise ValueError("Pass --confirm-scope " + c["scope"] + " to authorize this operation")
            if args.command == "fixture":
                print("Generating a 10-minute encode fixture...", flush=True)
                execute(["ffmpeg", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
                         "-t", "600", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", c["fixture"]])
            elif args.command == "check":
                environment.identity()
                environment.runner("--check")
                environment.runner("--live-preflight")
            elif args.command == "run":
                environment.identity()
                environment.runner("--scenario", "long-heartbeat")
                environment.runner("--scenario", "crash-recovery")
            else:
                getattr(environment, args.command)()
        return 0
    except (ValueError, OSError, KeyError, TypeError):
        # Only our ValueErrors contain safe fixed diagnostics.
        error = sys.exc_info()[1]
        message = str(error) if type(error) is ValueError else "Local configuration or file operation failed"
        print(message, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
