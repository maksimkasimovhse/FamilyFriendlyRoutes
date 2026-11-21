import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from audit_runtime_data import mapped_store, summarize_state

spec = importlib.util.spec_from_file_location("seed_demo_users", Path(__file__).with_name("seed-demo-users.py"))
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class DemoDeploymentTests(unittest.TestCase):
    def test_existing_profile_is_never_overwritten(self):
        call = Mock(side_effect=[(200, {"csrf_token": "fixture"}), (200, {"version": 7, "wishes": "changed by user"})])
        result = seed.seed_user(call, {}, *seed.USERS[0])
        self.assertIn("без изменений", result)
        self.assertFalse(any(c.args[0] == "PUT" or c.args[1].endswith("/register") for c in call.call_args_list))

    def test_new_demo_gets_a_profile_only_when_missing(self):
        call = Mock(side_effect=[(401, {}), (201, {"csrf_token": "fixture"}), (404, {"error": {"code": "PROFILE_NOT_FOUND"}}), (201, {"version": 1})])
        seed.seed_user(call, {}, *seed.USERS[0])
        self.assertEqual(call.call_args.args[0], "PUT")
        self.assertEqual(call.call_args.args[2]["expected_version"], 0)

    def test_check_mode_never_creates_an_account(self):
        call = Mock(return_value=(401, {"error": {"code": "INVALID_CREDENTIALS"}}))
        with self.assertRaises(RuntimeError):
            seed.seed_user(call, {}, *seed.USERS[0], check_only=True)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.args[1], "/api/v1/auth/login")

    def test_missing_profile_check_and_failed_read_never_write(self):
        for status, value in [(404, {"error": {"code": "PROFILE_NOT_FOUND"}}), (503, {})]:
            with self.subTest(status=status):
                call = Mock(side_effect=[(200, {"csrf_token": "fixture"}), (status, value)])
                with self.assertRaises(RuntimeError):
                    seed.seed_user(call, {}, *seed.USERS[0], check_only=True)
                self.assertFalse(any(c.args[0] == "PUT" for c in call.call_args_list))

    def test_audit_never_includes_private_records_or_session_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            self.assertFalse(summarize_state(path)["exists"])
            data = dict(accounts={"user-a": {"user_id": "user-a", "email": "masha@example.com", "password_hash": "private-hash"}, "user-b": {"email": "private@example.org"}}, family_profiles={"user-a": {"wishes": "private-wish"}}, sessions={"private-cookie": {"csrf": "private-token"}}, trips={}, previews={}, receipts={})
            path.write_text(json.dumps(data))
            report = summarize_state(path)
            self.assertEqual(report["counts"]["accounts"], 2)
            self.assertTrue(report["demo_accounts"]["masha@example.com"]["has_profile"])
            encoded = json.dumps(report)
            self.assertNotIn("private", encoded)
            self.assertNotIn("user-a", encoded)

    def test_invalid_store_is_not_reported_as_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text("{}")
            self.assertIn("read_error", summarize_state(path))

    def test_actual_store_flag_and_most_specific_mount_are_resolved(self):
        container = dict(Config={"WorkingDir": "/app"}, Args=["-store=custom/state.json"], Mounts=[
            {"Destination": "/app", "Source": "/srv/repo", "Type": "bind", "RW": True},
            {"Destination": "/app/custom", "Source": "/srv/persistent", "Type": "bind", "RW": True},
        ])
        report = mapped_store(container)
        self.assertEqual(report["host_path"], "/srv/persistent/state.json")
        self.assertTrue(report["persistent_mount"])
        container["Mounts"] = []
        self.assertFalse(mapped_store(container)["persistent_mount"])


if __name__ == "__main__":
    unittest.main()
