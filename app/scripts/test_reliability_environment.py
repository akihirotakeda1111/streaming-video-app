"""Offline safety tests: no Docker daemon or AWS account is contacted."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import reliability_environment as r


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.p = patch.object(r, "STATE", self.state)
        self.p.start()
        self.addCleanup(self.p.stop)
        self.c = {"scope": "sv-e2e-1234567890abcdef", "account": "123456789012",
                  "region": "ap-northeast-1", "host": "unix:///var/run/docker.sock",
                  "fixture": str(self.state / "long.mp4")}
        self.outputs = {"E2E_SOURCE_QUEUE": "https://sqs.ap-northeast-1.amazonaws.com/123456789012/source",
                        "E2E_DLQ": "https://sqs.ap-northeast-1.amazonaws.com/123456789012/dlq",
                        "E2E_SOURCE_BUCKET": "input", "E2E_OUTPUT_BUCKET": "output",
                        "E2E_ALARM_IDENTIFIERS": "age,visible,dlq"}

    def test_generated_documents_do_not_contain_secrets(self):
        secrets = {key: f"private-{key}-$#'" for key in r.SECRETS}
        with patch.dict(os.environ, secrets):
            document = r.compose_document(self.c, self.outputs)
            settings = r.runtime_settings(self.c, self.outputs)
            serialized = json.dumps([document, settings])
        for value in secrets.values():
            self.assertNotIn(value, serialized)
        worker = document["services"]["worker"]
        self.assertEqual(worker["restart"], "no")
        self.assertNotIn("volumes", worker)
        self.assertEqual(document["services"]["postgres"]["volumes"], ["postgres:/var/lib/postgresql/data"])
        self.assertEqual(worker["labels"][r.LABEL + "scope"], self.c["scope"])
        self.assertEqual(settings["E2E_SOURCE_DLQ"], settings["E2E_DLQ"])
        api_env = document["services"]["api"]["environment"]
        self.assertTrue(api_env["OUTPUT_S3_ENDPOINT"].startswith("https://s3."))
        self.assertIn("FRONTEND_ORIGIN", api_env)

    def test_fixture_replacement_requires_explicit_option(self):
        target = Path(self.c["fixture"])
        target.write_bytes(b"original")
        with patch.object(r, "execute") as execute:
            with self.assertRaisesRegex(ValueError, "already exists"):
                r.generate_fixture(self.c)
        execute.assert_not_called()
        self.assertEqual(target.read_bytes(), b"original")

    def test_fixture_cli_passes_requested_duration_to_ffmpeg(self):
        r.write_json(self.state / "config.json", self.c)
        def encode(args):
            self.assertEqual(args[args.index("-t") + 1], "300")
            Path(args[-1]).write_bytes(b"mp4")
        with patch.object(r, "execute", side_effect=encode) as execute:
            self.assertEqual(r.main(["fixture", "--duration-seconds", "300"]), 0)
        execute.assert_called_once()

    def test_fixture_default_duration_remains_600_seconds(self):
        r.write_json(self.state / "config.json", self.c)
        with patch.object(r, "generate_fixture") as generate:
            self.assertEqual(r.main(["fixture"]), 0)
        generate.assert_called_once_with(self.c, replace=False, duration_seconds=600)

    def test_invalid_duration_is_rejected_before_generation(self):
        for value in ("0", "-1", "1.5", "abc"):
            with self.subTest(value=value), patch.object(r, "execute") as execute, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    r.main(["fixture", "--duration-seconds", value])
                self.assertEqual(error.exception.code, 2)
                execute.assert_not_called()

    def test_fixture_validated_before_replacing_original(self):
        target = Path(self.c["fixture"])
        target.write_bytes(b"original")
        def encode(args):
            self.assertEqual(target.read_bytes(), b"original")
            self.assertEqual(args[args.index("-maxrate") + 1], "8M")
            Path(args[-1]).write_bytes(b"new-mp4")
        with patch.object(r, "execute", side_effect=encode):
            r.generate_fixture(self.c, replace=True)
        self.assertEqual(target.read_bytes(), b"new-mp4")
        self.assertEqual(list(self.state.glob(".recovery-*.mp4")), [])

    def test_invalid_generated_fixture_preserves_original(self):
        target = Path(self.c["fixture"])
        target.write_bytes(b"original")
        with patch.object(r, "execute", side_effect=lambda args: Path(args[-1]).write_bytes(b"")):
            with self.assertRaisesRegex(ValueError, "outside"):
                r.generate_fixture(self.c, replace=True)
        self.assertEqual(target.read_bytes(), b"original")
        self.assertEqual(list(self.state.glob(".recovery-*.mp4")), [])

    def test_terraform_recreates_missing_inputs_and_passes_explicit_file(self):
        (self.state / "terraform").mkdir()
        e = r.Environment(self.c)
        inputs = self.state / "terraform/terraform.tfvars.json"
        for command in ("plan", "destroy"):
            inputs.unlink(missing_ok=True)
            with patch.object(r, "execute", return_value="") as execute:
                e.tf(command, "-input=false")
            self.assertEqual(json.loads(inputs.read_text()), {
                key: self.c[key] for key in ("scope", "account", "region")})
            self.assertIn(f"-var-file={inputs}", execute.call_args.args[0])

    def test_terraform_replaces_stale_inputs_with_current_config(self):
        (self.state / "terraform").mkdir()
        inputs = self.state / "terraform/terraform.tfvars.json"
        r.write_json(inputs, {"account": "999999999999", "unexpected": "stale"})
        with patch.object(r, "execute", return_value=""):
            r.Environment(self.c).tf("plan", "-input=false")
        self.assertEqual(json.loads(inputs.read_text()), {
            key: self.c[key] for key in ("scope", "account", "region")})

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI unavailable")
    def test_real_compose_parser_accepts_secret_placeholders(self):
        # Config parsing does not connect to the Docker daemon or AWS.
        document = r.compose_document(self.c, self.outputs)
        r.write_json(self.state / "compose.json", document)
        (self.state / "empty.env").write_text("")
        env = {**r.clean_env(), **dict.fromkeys(r.SECRETS, "private-$#'value"),
               "RECOVERY_DATABASE_URL": "postgres://u:p%40ss@postgres:5432/streaming_video"}
        output = r.execute(["docker", "compose", "--env-file", str(self.state / "empty.env"),
                            "--project-name", self.c["scope"], "-f", str(self.state / "compose.json"),
                            "config", "--format", "json"], env=env)
        parsed = json.loads(output)
        # Compose's serialized config escapes literal dollars for round-tripping.
        self.assertEqual(parsed["services"]["worker"]["environment"]["AWS_SECRET_ACCESS_KEY"], "private-$$#'value")
        self.assertEqual(parsed["services"]["postgres"]["environment"]["POSTGRES_PASSWORD"], "private-$$#'value")

    def test_partial_apply_failure_preserves_state_without_starting_docker(self):
        Path(self.c["fixture"]).write_bytes(b"mp4")
        (self.state / "terraform").mkdir()
        state = self.state / "terraform/terraform.tfstate"
        state.write_text("partial resource state")
        e = r.Environment(self.c)
        with patch.object(e, "secrets"), patch.object(e, "plan"), patch.object(e, "tf", side_effect=ValueError("failed")), patch.object(e, "compose") as compose:
            with self.assertRaises(ValueError):
                e.up()
        compose.assert_not_called()
        self.assertEqual(state.read_text(), "partial resource state")

    def test_teardown_uses_only_owned_exact_container_ids(self):
        e = r.Environment(self.c)
        c = {"Config": {"Labels": {r.LABEL + "scope": self.c["scope"], r.LABEL + "disposable": "true"}}, "Mounts": []}
        with patch.object(e, "identity"), patch.object(e, "docker", side_effect=["owned", json.dumps([c]), "", "", ""]) as docker, patch.object(e, "tf") as tf:
            e.down()
        self.assertIn(unittest.mock.call("container", "rm", "--force", "owned"), docker.call_args_list)
        tf.assert_called_with("destroy", "-input=false", "-auto-approve", "-no-color")

    def test_external_failure_does_not_disclose_secrets(self):
        with patch.object(r.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "password", "token")):
            with self.assertRaisesRegex(ValueError, "details suppressed") as error:
                r.execute(["docker", "compose", "up"])
        self.assertNotIn("password", str(error.exception))
        self.assertNotIn("token", str(error.exception))

    def test_inherited_target_overrides_are_removed(self):
        with patch.dict(os.environ, {"TF_CLI_ARGS": "-destroy", "COMPOSE_FILE": "shared.yaml",
                                     "DOCKER_HOST": "tcp://remote", "E2E_SOURCE_QUEUE": "shared",
                                     "AWS_PROFILE": "manual"}):
            e = r.Environment(self.c)
        for key in ("TF_CLI_ARGS", "COMPOSE_FILE", "DOCKER_HOST", "E2E_SOURCE_QUEUE"):
            self.assertNotIn(key, e.env)
        self.assertEqual(e.env["AWS_PROFILE"], "manual")

    def test_account_mismatch_blocks_before_docker(self):
        e = r.Environment(self.c)
        with patch.object(r, "execute", return_value='{"Account":"999999999999"}'), patch.object(e, "docker") as docker:
            with self.assertRaisesRegex(ValueError, "AWS account differs"):
                e.identity()
            docker.assert_not_called()

    def test_changed_engine_is_rejected(self):
        r.write_json(self.state / "engine.json", {"id": "original"})
        e = r.Environment(self.c)
        with patch.object(r, "execute", return_value=json.dumps({"Account": self.c["account"]})), patch.object(e, "docker", return_value='{"ID":"other","OSType":"linux","Plugins":{}}'):
            with self.assertRaisesRegex(ValueError, "Engine changed"):
                e.identity()

    def test_creation_cannot_delete_or_update_existing_resources(self):
        for actions in (["delete"], ["delete", "create"], ["update"]):
            e = r.Environment(self.c)
            with patch.object(e, "identity"), patch.object(e, "tf", side_effect=["", "", "", json.dumps({
                    "resource_changes": [{"address": "aws_sqs_queue.source", "change": {"actions": actions}}]})]):
                with self.assertRaisesRegex(ValueError, "modify existing"):
                    e.plan()

    def test_missing_manual_secret_blocks_before_provisioning(self):
        e = r.Environment(self.c)
        with patch.dict(os.environ, {}, clear=True), patch.object(e, "plan") as plan:
            with self.assertRaisesRegex(ValueError, "Manually set E2E_DB_PASSWORD"):
                e.up()
            plan.assert_not_called()

    def test_worker_credentials_are_separate_and_password_is_encoded(self):
        e = r.Environment(self.c)
        values = dict(zip(r.SECRETS, ["p@ss:/?#$", "worker-key", "worker-secret", "session"]))
        with patch.dict(os.environ, values), patch.object(r, "execute", return_value=json.dumps({"Account": self.c["account"]})) as execute:
            e.secrets()
        self.assertIn("p%40ss%3A%2F%3F%23%24", e.env["RECOVERY_DATABASE_URL"])
        self.assertEqual(execute.call_args.kwargs["env"]["AWS_ACCESS_KEY_ID"], "worker-key")

    def test_run_stops_after_first_failed_scenario(self):
        r.write_json(self.state / "config.json", self.c)
        with patch.object(r.Environment, "identity"), patch.object(r.Environment, "runner", side_effect=ValueError("failed")) as runner, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(r.main(["run"]), 2)
            runner.assert_called_once_with("--scenario", "long-heartbeat")
        self.assertFalse((self.state / "operation.lock").exists())

    def test_confirmation_is_required_before_up_and_down(self):
        r.write_json(self.state / "config.json", self.c)
        for command in ("up", "down"):
            with patch.object(r.Environment, command) as method, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(r.main([command, "--confirm-scope", "wrong"]), 2)
                method.assert_not_called()

    def test_concurrent_operations_are_blocked(self):
        with r.locked():
            with self.assertRaisesRegex(ValueError, "Another operation"):
                with r.locked():
                    self.fail("should not acquire a second lock")

    def test_shared_volume_blocks_all_teardown(self):
        e = r.Environment(self.c)
        c = {"Config": {"Labels": {r.LABEL + "scope": self.c["scope"], r.LABEL + "disposable": "true"}},
             "Mounts": [{"Type": "volume", "Name": "db"}]}
        volume = {"Labels": {r.LABEL + "scope": self.c["scope"]}}
        with patch.object(e, "identity"), patch.object(e, "docker", side_effect=["owned", json.dumps([c]), json.dumps([volume]), "owned\nforeign"]) as docker, patch.object(e, "tf") as tf:
            with self.assertRaisesRegex(ValueError, "Volume is shared"):
                e.down()
            tf.assert_not_called()
            self.assertFalse(any("rm" in call.args for call in docker.call_args_list))

    def test_up_collects_full_ids_and_keeps_dynamic_api_port(self):
        Path(self.c["fixture"]).write_bytes(b"mp4")
        e = r.Environment(self.c)
        with patch.object(e, "secrets"), patch.object(e, "plan"), patch.object(e, "tf", side_effect=["", json.dumps(self.outputs)]), patch.object(e, "compose", return_value="short-id"), patch.object(e, "port", side_effect=["http://127.0.0.1:40001", "http://127.0.0.1:40002"]), patch.object(e, "docker", side_effect=["a" * 64, "b" * 64]), patch.object(e, "runner") as runner:
            e.up()
        document = json.loads((self.state / "compose.json").read_text())
        env = json.loads((self.state / "environment.json").read_text())
        self.assertEqual(document["services"]["api"]["ports"], ["127.0.0.1:40001:8080"])
        self.assertEqual(document["services"]["api"]["environment"]["FRONTEND_ORIGIN"], env["E2E_FRONTEND_URL"])
        self.assertEqual(env["E2E_WORKER_OBSERVATION"], "docker:" + "a" * 64)
        self.assertEqual(env["E2E_DATABASE_PROCESS_CONTROL"], "docker:" + "b" * 64)
        runner.assert_called_once_with("--live-preflight")


if __name__ == "__main__":
    unittest.main()
