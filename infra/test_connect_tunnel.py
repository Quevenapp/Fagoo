import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('connect_tunnel', Path(__file__).with_name('connect-tunnel.py'))
tunnel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tunnel)

TEST_ID = 'a701e943-17bd-441b-a768-380b82eb1a82'


def synthetic_token():
    return base64.b64encode(json.dumps({'a': 'a' * 32, 't': TEST_ID, 's': base64.b64encode(b's' * 32).decode()}).encode()).decode()


class TunnelTests(unittest.TestCase):
    def test_accepts_only_token_or_documented_dashboard_commands(self):
        token = synthetic_token()
        for value in [token, f'sudo cloudflared service install {token}', f'cloudflared service install {token}', f'cloudflared tunnel run --token {token}']:
            self.assertEqual(tunnel.extract_token(value, TEST_ID), (token, TEST_ID))

    def test_never_accepts_shell_injection_or_extra_commands(self):
        token = synthetic_token()
        for value in [f'sudo cloudflared service install {token}; id', f'cloudflared service install $(cat secret)', f'echo {token}', f'cloudflared tunnel run --token {token} --url http://evil.test', 'unclosed "']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                tunnel.extract_token(value)

    def test_wrong_tunnel_or_malformed_payload_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'TUNNEL_ID_MISMATCH'):
            tunnel.extract_token(synthetic_token(), 'a701e943-17bd-441b-a768-380b82eb1a83')
        for value in ['not-a-token', base64.b64encode(b'{"a":"bad"}').decode(), base64.b64encode(b'[]' * 80).decode()]:
            with self.assertRaises(ValueError):
                tunnel.extract_token(value)

    def test_unit_contains_token_file_only_and_suppresses_connector_logs(self):
        content = tunnel.unit_text('/usr/bin/cloudflared', '/etc/fagoo/cloudflared/token')
        self.assertIn('--token-file /etc/fagoo/cloudflared/token', content)
        self.assertNotIn('--token ', content)
        self.assertNotRegex(content, r'(?m)^Environment=')
        self.assertIn('UnsetEnvironment=TUNNEL_TOKEN TUNNEL_TOKEN_FILE', content)
        self.assertIn('StandardOutput=null', content)
        self.assertIn('StandardError=null', content)
        self.assertIn('Type=notify', content)
        for value in ['/usr/bin/cloudflared --token bad', '/tmp/tool%name', '/tmp/tool\nExecStart=bad']:
            with self.assertRaises(ValueError):
                tunnel.unit_text(value, '/etc/fagoo/cloudflared/token')

    def test_exclusive_configuration_does_not_replace_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            token_dir, unit = base / 'private', base / 'test.service'
            token = synthetic_token()
            # Production systemd path validation is independent of this filesystem test.
            original = tunnel.unit_text
            tunnel.unit_text = lambda binary, path: original('/usr/bin/cloudflared', '/etc/fagoo/cloudflared/token')
            try:
                tunnel.create_configuration(token, '/usr/bin/cloudflared', token_dir, unit)
                self.assertEqual((token_dir / 'token').read_text().strip(), token)
                self.assertNotIn(token, unit.read_text())
                if os.name == 'posix':
                    self.assertEqual((token_dir / 'token').stat().st_mode & 0o777, 0o600)
                    self.assertEqual(token_dir.stat().st_mode & 0o777, 0o700)
                with self.assertRaisesRegex(ValueError, 'TUNNEL_CONFIGURATION_EXISTS'):
                    tunnel.create_configuration('replacement', '/usr/bin/cloudflared', token_dir, unit)
                self.assertEqual((token_dir / 'token').read_text().strip(), token)
            finally:
                tunnel.unit_text = original


if __name__ == '__main__':
    unittest.main()
