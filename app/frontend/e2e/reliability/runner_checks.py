"""Python entry-point regressions, invoked by the existing Vitest helper command."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import unittest
import tempfile
from unittest.mock import patch

SETTINGS = json.load(sys.stdin)
RUNNER = Path(__file__).resolve().parents[3] / "scripts/run_reliability_e2e.py"
MODULE = runpy.run_path(str(RUNNER), run_name="runner_checks")
GLOBALS = MODULE["main"].__globals__
NODE = shutil.which("node")
RUN = subprocess.run


class RunnerChecks(unittest.TestCase):
    def invoke(self, args, settings):
        calls = []

        def local_only(command, **kwargs):
            self.assertEqual(command[:2], [NODE, str(MODULE["SAFETY_CLI"])])
            self.assertIn(command[2], ("check", "validate", "authorize"))
            self.assertEqual(kwargs["timeout"], 130 if command[2] == "authorize" else 10)
            calls.append(command[2])
            return RUN(command, **kwargs)

        env = {key: value for key, value in os.environ.items() if not key.startswith("E2E_")}
        env.update(settings)
        output = io.StringIO()
        with patch.dict(os.environ, env, clear=True), \
                patch.dict(GLOBALS, {"_check_tools": lambda: []}), \
                patch("subprocess.run", side_effect=local_only), \
                patch.object(Path, "mkdir", side_effect=AssertionError("must not create evidence")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = MODULE["main"](args)
        return code, output.getvalue(), calls

    def test_offline_has_no_live_calls(self):
        for settings in ({}, SETTINGS):
            code, output, calls = self.invoke(["--check"], settings)
            self.assertEqual(code, 0)
            self.assertEqual(calls, ["check"])
            self.assertIn("not configured" if not settings else "live resources not verified", output)

    def test_missing_fields_rejected_before_authorization(self):
        for name in SETTINGS:
            with self.subTest(name=name):
                settings = {key: value for key, value in SETTINGS.items() if key != name}
                code, output, calls = self.invoke(["--scenario", "runtime-authorization"], settings)
                self.assertEqual(code, 2)
                self.assertIn(name, output)
                self.assertEqual(calls, ["validate"])

    def test_offline_status_and_unsafe_scopes(self):
        for name, value, expected in (
            ("E2E_ALARM_IDENTIFIERS", "", 0),
            ("E2E_LEASE_TIMEOUT_MS", "", 0),
            ("E2E_SOURCE_DLQ_RELATIONSHIP", "configured", 0),
            ("E2E_WORKER_CONTROL_SCOPE", "all", 2),
            ("E2E_DATABASE_CONTROL_SCOPE", "production", 2),
            ("E2E_API_URL", "https://user:private-value@example.test", 2),
        ):
            with self.subTest(name=name):
                code, output, calls = self.invoke(["--check"], {**SETTINGS, name: value})
                self.assertEqual(code, expected)
                self.assertIn("not configured" if expected == 0 else name, output)
                self.assertNotIn("private-value", output)
                self.assertEqual(calls, ["check"])

    def test_self_attested_relationship_never_dispatches(self):
        for scenario in MODULE["SCENARIOS"]:
            code, output, calls = self.invoke(["--scenario", scenario], SETTINGS)
            self.assertEqual(code, 2)
            evidence = json.loads(output)
            self.assertFalse(evidence["scenarioStarted"])
            self.assertFalse(evidence["liveResourcesVerified"])
            self.assertIn("full Docker container ID", evidence["message"])
            self.assertEqual(calls, ["validate", "authorize"])

    def test_list_has_no_validation_or_live_calls(self):
        code, output, calls = self.invoke(["--list"], {})
        self.assertEqual(code, 0)
        self.assertIn("runtime-authorization", output)
        self.assertIn("duplicate-delivery", output)
        self.assertIn("ffmpeg-exhaustion", output)
        self.assertIn("poison-isolation", output)
        self.assertIn("queue-monitoring", output)
        self.assertIn("active and completed redelivery", output)
        self.assertEqual(calls, [])
        with self.assertRaises(SystemExit) as error:
            self.invoke(["--scenario", "unimplemented"], {})
        self.assertEqual(error.exception.code, 2)

    def test_missing_tools_and_validator_timeout_are_safe(self):
        with patch.dict(GLOBALS, {"_check_tools": lambda: ["ffmpeg"]}), \
                patch("subprocess.run", side_effect=AssertionError("must not run")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(MODULE["_check"](), 2)
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("private-value", 10)):
            with self.assertRaisesRegex(ValueError, "^local safety validation could not complete$"):
                MODULE["_settings"]("check")

    def test_preflight_reuses_root_without_overwriting_or_dispatch(self):
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"E2E_EVIDENCE_DIR": root}), \
                patch.dict(GLOBALS, {"_settings": lambda mode: {"status": "verified", "verifiedAt": "test"}}), \
                patch("subprocess.run", side_effect=AssertionError("must not dispatch")), \
                contextlib.redirect_stdout(io.StringIO()):
            for _ in range(2):
                self.assertEqual(MODULE["main"](["--live-preflight"]), 0)
            records = list(Path(root).glob("preflight-*/live-preflight.json"))
            self.assertEqual(len(records), 2)
            self.assertTrue(all(not json.loads(p.read_text())["scenarioStarted"] for p in records))

    def test_failed_authorization_cannot_write_or_dispatch(self):
        for args in (["--live-preflight"], *(["--scenario", scenario] for scenario in MODULE["SCENARIOS"])):
            def settings(mode):
                if mode == "validate":
                    return {"configured": True}
                raise ValueError("worker attempts do not match queue and E2E settings")
            with patch.dict(os.environ, SETTINGS), patch.dict(GLOBALS, {"_settings": settings}), \
                    patch.object(Path, "mkdir", side_effect=AssertionError("must not write")), \
                    patch("subprocess.run", side_effect=AssertionError("must not dispatch")), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(MODULE["main"](args), 2)

    def test_duplicate_dispatch_and_failure_propagation(self):
        """Dispatch only the dedicated tag/project and preserve the scenario exit."""
        for scenario, returncode in ((scenario, code) for scenario in ("duplicate-delivery", "crash-recovery", "long-heartbeat", "ffmpeg-exhaustion", "poison-isolation", "queue-monitoring") for code in (0, 1)):
            with self.subTest(scenario=scenario, returncode=returncode), tempfile.TemporaryDirectory() as root:
                destination = Path(root) / "e2e-test"
                config = MODULE["LiveConfig"](destination, scenario)
                modes = []

                def authorize(mode):
                    self.assertFalse(destination.exists())
                    modes.append(mode)
                    return {"status": "verified"}

                def dispatch(command, **kwargs):
                    self.assertEqual(modes, ["authorize"])
                    self.assertTrue(destination.is_dir())
                    self.assertEqual(command, ["node-test", str(MODULE["SAFETY_CLI"].parents[2] / "node_modules/@playwright/test/cli.js"), "test",
                                               "--grep", "@" + scenario, "--project", "reliability"])
                    self.assertEqual(kwargs["cwd"], MODULE["SAFETY_CLI"].parents[2])
                    self.assertEqual(kwargs["env"]["E2E_RUN_ID"], destination.name)
                    self.assertEqual(kwargs["env"]["E2E_INCLUDE_RELIABILITY"], "true")
                    self.assertEqual(kwargs["env"]["E2E_EVIDENCE_DIR"], str(destination))
                    return subprocess.CompletedProcess(command, returncode)

                with patch.dict(GLOBALS, {"_settings": authorize}), \
                        patch("shutil.which", return_value="node-test"), \
                        patch("subprocess.run", side_effect=dispatch) as run:
                    self.assertEqual(MODULE["_run"](config), returncode)
                    run.assert_called_once()

    def test_preflight_filesystem_errors_are_redacted(self):
        output = io.StringIO()
        with patch.dict(os.environ, SETTINGS), \
                patch.dict(GLOBALS, {"_settings": lambda mode: {"status": "verified"}}), \
                patch.object(Path, "mkdir", side_effect=OSError("private-value")), \
                contextlib.redirect_stderr(output):
            self.assertEqual(MODULE["main"](["--live-preflight"]), 2)
        self.assertNotIn("private-value", output.getvalue())

    def test_live_modes_allow_the_shared_deadline_and_require_verified(self):
        for mode in ("preflight", "authorize"):
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, '{"status":"verified"}')) as run:
                self.assertEqual(MODULE["_settings"](mode)["status"], "verified")
                self.assertEqual(run.call_args.kwargs["timeout"], 130)
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, '{"status":"blocked"}')):
                with self.assertRaisesRegex(ValueError, "invalid live verification response"):
                    MODULE["_settings"](mode)


if __name__ == "__main__":
    unittest.main()
