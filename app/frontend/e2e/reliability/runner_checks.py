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
            self.assertEqual(kwargs["timeout"], 10)
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
            self.assertIn("AWS_REGION", evidence["message"])
            self.assertEqual(calls, ["validate", "authorize"])

    def test_list_has_no_validation_or_live_calls(self):
        code, output, calls = self.invoke(["--list"], {})
        self.assertEqual(code, 0)
        self.assertIn("runtime-authorization", output)
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


if __name__ == "__main__":
    unittest.main()
