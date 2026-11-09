"""Provisioning must preserve keys/channels and fail closed before exposure."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("prepare_hermes", Path(__file__).parents[1] / "scripts/prepare-hermes.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.multiplex = "true"
        self.make_profile("default")
        self.args = SimpleNamespace(hermes="hermes", profile="wabotia", create_profile=True,
            output=self.root / "private", api_port=8642, admin_port=9119,
            admin_hostname="hermes.example.com", api_hostname="api.example.com")

    def make_profile(self, profile):
        folder = self.root / profile
        folder.mkdir()
        (folder / "config.yaml").write_text("model: original\n")
        (folder / ".env").write_text("WHATSAPP_ACCESS_TOKEN=preserved-channel\n")

    def cli(self, executable, profile, *args, optional=False):
        self.calls.append((profile, args))
        folder = self.root / profile
        if args[0:2] == ("profile", "create"):
            self.assertNotIn("--clone", args)
            self.make_profile(args[2])
            (self.root / args[2] / ".env").write_text("")
            return "created"
        if not folder.exists():
            if optional:
                return None
            raise RuntimeError("absent")
        if args == ("config", "path"):
            return str(folder / "config.yaml")
        if args == ("config", "env-path"):
            return str(folder / ".env")
        if args == ("config", "get", "gateway.multiplex_profiles"):
            return self.multiplex
        if args[0:3] == ("config", "set", "API_SERVER_KEY"):
            path = folder / ".env"
            lines = [line for line in path.read_text().splitlines() if not line.startswith("API_SERVER_KEY=")]
            path.write_text("\n".join(lines + ["API_SERVER_KEY=" + args[3]]) + "\n")
        return "ok"

    def prepare(self):
        with patch.object(helper, "cli", self.cli), patch.object(helper.shutil, "which", return_value="/bin/hermes"), contextlib.redirect_stdout(io.StringIO()) as output:
            helper.prepare(self.args)
        return output.getvalue()

    def test_rerun_preserves_keys_channels_and_private_permissions(self):
        original = (self.root / "default/config.yaml").read_bytes()
        log = self.prepare()
        payload = (self.args.output / "connection.local.json").read_text()
        admin_env = (self.args.output / "backend.env").read_text()
        self.assertNotIn(json.loads(payload)["secrets"]["dashboard_token"], log)
        self.assertEqual((self.root / "default/config.yaml").read_bytes(), original)
        self.assertIn("WHATSAPP_ACCESS_TOKEN=preserved-channel", (self.root / "default/.env").read_text())
        self.assertNotIn("WHATSAPP", (self.root / "wabotia/.env").read_text())
        default_key = helper.read_key(self.root / "default/.env", "API_SERVER_KEY")
        self.assertNotEqual(default_key, json.loads(payload)["secrets"]["profile_keys"]["wabotia"])
        self.assertNotIn(default_key, payload)
        self.prepare()
        self.assertEqual(payload, (self.args.output / "connection.local.json").read_text())
        self.assertEqual(admin_env, (self.args.output / "backend.env").read_text())
        for path in self.args.output.rglob("*"):
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        manifests = list(self.args.output.glob("backups/*/manifest.json"))
        self.assertEqual(len(manifests), 2)

    def test_parked_profile_is_not_reactivated(self):
        self.make_profile("wabotia")
        (self.root / "wabotia/gateway.parked").touch()
        with self.assertRaisesRegex(RuntimeError, "pausado"):
            self.prepare()
        self.assertFalse(any(args[0:2] == ("config", "set") for _, args in self.calls))

    def test_nonmultiplex_gateway_is_not_reconfigured(self):
        self.make_profile("wabotia")
        self.multiplex = "false"
        with self.assertRaisesRegex(RuntimeError, "compartilhado"):
            self.prepare()
        self.assertFalse(any(args[0:2] == ("config", "set") for _, args in self.calls))

    def test_weak_existing_key_is_not_rotated(self):
        self.make_profile("wabotia")
        env = self.root / "wabotia/.env"
        env.write_text("API_SERVER_KEY=short\n")
        with self.assertRaisesRegex(RuntimeError, "Não foi substituída"):
            self.prepare()
        self.assertEqual(env.read_text(), "API_SERVER_KEY=short\n")


if __name__ == "__main__":
    unittest.main()
