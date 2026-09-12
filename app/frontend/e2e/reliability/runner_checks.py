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
    def full_suite(self, fault=None):
        """Exercise real dispatch and reporting with only external operations replaced."""
        with tempfile.TemporaryDirectory() as root:
            calls = []
            output = io.StringIO()

            def settings(mode):
                if fault == "config" and len(calls) == 1 and mode == "validate":
                    raise ValueError("private-value")
                if fault == "authorize" and len(calls) == 1 and mode == "authorize":
                    raise ValueError("private-value")
                return {"status": "verified"}

            def dispatch(command, **kwargs):
                env = kwargs["env"]
                name = command[command.index("--grep") + 1][1:]
                calls.append((name, env))
                if fault == "launch" and len(calls) == 2:
                    raise OSError("private-value")
                if fault == "exit" and len(calls) == 2:
                    return subprocess.CompletedProcess(command, 1)
                evidence = {"scenario": name, "runId": env["E2E_RUN_ID"], "status": "passed"}
                if name == "queue-monitoring":
                    evidence["outstanding"] = []
                    if fault == "outstanding":
                        evidence.update(status="outstanding", outstanding=["metric delayed"])
                    if fault == "contradictory":
                        evidence["outstanding"] = ["metric delayed"]
                    if fault == "run-mismatch":
                        evidence["runId"] = "another-run"
                    if fault == "scenario-mismatch":
                        evidence["scenario"] = "another-scenario"
                if name == "phase1-pipeline":
                    self.assertNotIn("E2E_INCLUDE_RELIABILITY", env)
                    self.assertEqual(env["E2E_PROJECT"], "chromium")
                    self.assertEqual(command[-2:], ["--retries", "0"])
                path = Path(env["E2E_EVIDENCE_DIR"]) / f"{name}-evidence.json"
                if not ((name == "queue-monitoring" and fault == "missing")
                        or (name == "phase1-pipeline" and fault == "playback-missing")):
                    path.write_text("invalid" if name == "queue-monitoring" and fault == "invalid"
                                    else json.dumps(evidence), encoding="utf-8")
                return subprocess.CompletedProcess(command, 0)

            with patch.dict(os.environ, {"E2E_EVIDENCE_DIR": root, "E2E_PROJECT": "firefox",
                                         "E2E_INCLUDE_RELIABILITY": "true"}), \
                    patch.dict(GLOBALS, {"_settings": settings}), \
                    patch("shutil.which", return_value="node-test"), \
                    patch("subprocess.run", side_effect=dispatch), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                code = MODULE["main"](["--full"])
            self.assertNotIn("private-value", output.getvalue())
            paths = list(Path(root).glob("full-suite-*.json"))
            self.assertEqual(len(paths), 1)
            report = json.loads(paths[0].read_text())
            if code == 0:
                self.assertTrue(all(Path(row["evidenceFile"]).is_file() for row in report["liveEvidence"]))
            return code, report, calls

    def test_full_suite_order_correlation_and_playback_evidence(self):
        code, report, calls = self.full_suite()
        self.assertEqual(code, 0)
        self.assertEqual(report["status"], "passed")
        self.assertEqual([name for name, _ in calls], [*MODULE["FULL_LIVE_SCENARIOS"], "phase1-pipeline"])
        self.assertEqual(len({env["E2E_RUN_ID"] for _, env in calls}), 7)
        monitoring = calls[5][1]
        self.assertEqual(monitoring["E2E_FFMPEG_EVIDENCE_RUN"], calls[3][1]["E2E_RUN_ID"])
        self.assertEqual(monitoring["E2E_POISON_EVIDENCE_RUN"], calls[4][1]["E2E_RUN_ID"])
        self.assertEqual(report["unexecutedLiveChecks"], [])

    def test_full_suite_rejects_incomplete_evidence_before_playback(self):
        for fault in ("outstanding", "contradictory", "missing", "invalid", "run-mismatch", "scenario-mismatch"):
            with self.subTest(fault=fault):
                code, report, calls = self.full_suite(fault)
                self.assertEqual(code, 1)
                self.assertEqual(report["status"], "failed")
                self.assertEqual(report["liveEvidence"][5]["status"], "failed")
                self.assertEqual(report["unexecutedLiveChecks"], ["phase1-pipeline"])
                self.assertEqual(len(calls), 6)

    def test_full_suite_requires_playback_artifact(self):
        code, report, calls = self.full_suite("playback-missing")
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 7)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["liveEvidence"][-1]["status"], "failed")

    def test_full_suite_preserves_partial_report_on_errors(self):
        for fault in ("config", "authorize", "launch", "exit"):
            with self.subTest(fault=fault):
                code, report, _ = self.full_suite(fault)
                blocked = fault != "exit"
                self.assertEqual(code, 2 if blocked else 1)
                self.assertEqual(report["status"], "blocked" if blocked else "failed")
                self.assertEqual(report["liveEvidence"][0]["status"], "passed")
                self.assertEqual(report["liveEvidence"][1]["status"], "blocked" if blocked else "failed")
                self.assertEqual(report["unexecutedLiveChecks"],
                                 [*MODULE["FULL_LIVE_SCENARIOS"][2:], "phase1-pipeline"])

    def test_preflight_selects_browser_project(self):
        for project in ("", "firefox"):
            for args in ([], ["--scenario", "preflight"]):
                with self.subTest(project=project, args=args), tempfile.TemporaryDirectory() as root, \
                        patch.dict(os.environ, {"E2E_EVIDENCE_DIR": root, "E2E_PROJECT": project,
                                                "E2E_INCLUDE_RELIABILITY": "true"}), \
                        patch.dict(GLOBALS, {"_settings": lambda mode: {}}), \
                        patch("shutil.which", return_value="node-test"), \
                        patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(MODULE["main"](args), 0)
                    self.assertEqual(run.call_args.args[0][-4:],
                                     ["--grep", "@preflight", "--project", project or "chromium"])
                    self.assertNotIn("E2E_INCLUDE_RELIABILITY", run.call_args.kwargs["env"])

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

    def test_monitoring_reference_arguments_dispatch_without_inheriting_old_values(self):
        first = "e2e-11111111-1111-4111-8111-111111111111"
        second = "e2e-22222222-2222-4222-8222-222222222222"
        for supplied in ([], ["--ffmpeg-evidence-run", first],
                         ["--ffmpeg-evidence-run", first, "--poison-evidence-run", second]):
            with self.subTest(supplied=supplied), tempfile.TemporaryDirectory() as root:
                def dispatch(command, **kwargs):
                    env = kwargs["env"]
                    self.assertEqual(env.get("E2E_FFMPEG_EVIDENCE_RUN"), first if supplied else None)
                    self.assertEqual(env.get("E2E_POISON_EVIDENCE_RUN"), second if len(supplied) == 4 else None)
                    self.assertEqual(Path(env["E2E_EVIDENCE_DIR"]).parent, Path(root).resolve())
                    self.assertNotIn(env["E2E_RUN_ID"], (first, second))
                    self.assertEqual(command[-4:], ["--grep", "@queue-monitoring", "--project", "reliability"])
                    return subprocess.CompletedProcess(command, 0)
                with patch.dict(os.environ, {"E2E_EVIDENCE_DIR": root,
                                             "E2E_FFMPEG_EVIDENCE_RUN": "old", "E2E_POISON_EVIDENCE_RUN": "old"}), \
                        patch.dict(GLOBALS, {"_settings": lambda mode: {"status": "verified"}}), \
                        patch("shutil.which", return_value="node-test"), \
                        patch("subprocess.run", side_effect=dispatch) as run, \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(MODULE["main"](["--scenario", "queue-monitoring", *supplied]), 0)
                    run.assert_called_once()

    def test_reference_arguments_reject_paths_and_other_modes_before_any_operation(self):
        valid = "e2e-11111111-1111-4111-8111-111111111111"
        cases = [["--scenario", "queue-monitoring", "--ffmpeg-evidence-run", value]
                 for value in ("../private-value", "C:/private-value", "", valid + "/child", "e2e-invalid")]
        cases += [["--scenario", "poison-isolation", "--poison-evidence-run", valid]]
        cases += [["--scenario", "queue-monitoring", mode, "--poison-evidence-run", valid]
                  for mode in ("--list", "--check", "--live-preflight")]
        for args in cases:
            with self.subTest(args=args), \
                    patch.dict(GLOBALS, {"_settings": lambda mode: self.fail("must not validate live settings")}), \
                    patch("subprocess.run", side_effect=AssertionError("must not dispatch")), \
                    patch.object(Path, "mkdir", side_effect=AssertionError("must not write")), \
                    contextlib.redirect_stderr(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as error:
                    MODULE["main"](args)
                self.assertEqual(error.exception.code, 2)
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
