import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

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
            tunnel.unit_text = lambda binary, path, metrics_port=20241: original('/usr/bin/cloudflared', '/etc/fagoo/cloudflared/token', metrics_port)
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

    def test_runtime_scope_preserves_defaults_and_rejects_missing_explicit_file(self):
        with patch.object(Path, 'exists', return_value=False), patch.object(tunnel, 'read_values') as reader:
            scope = tunnel.configuration()
        reader.assert_not_called()
        self.assertEqual(scope['tunnel_service'], 'fagoo-cloudflared.service')
        self.assertEqual(scope['tunnel_token_dir'], '/etc/fagoo/cloudflared')
        self.assertEqual((scope['local_port'], scope['metrics_port']), (8081, 20241))
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(FileNotFoundError):
                tunnel.configuration(Path(temporary) / 'missing.env')

    def test_invalid_namespace_and_ports_are_rejected_before_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / 'runtime.env'
            for value in ['', '../fagoo', 'Fagoo', 'fagoo_prod', 'a' * 41, 'fagoo;id', '-fagoo']:
                runtime.write_text('FAGOO_INSTANCE_ID=' + value + '\n')
                with self.subTest(identity=value), self.assertRaisesRegex(ValueError, 'INSTALLATION_ID_INVALID'):
                    tunnel.configuration(runtime)
            for value in ['80', '65536', '20242 --token secret']:
                runtime.write_text('FAGOO_TUNNEL_METRICS_PORT=' + value + '\n')
                with self.subTest(port=value), self.assertRaisesRegex(ValueError, 'INSTALLATION_PORT_INVALID'):
                    tunnel.configuration(runtime)
                with self.assertRaisesRegex(ValueError, 'INSTALLATION_PORT_INVALID'):
                    tunnel.unit_text('/usr/bin/cloudflared', '/etc/fagoo/cloudflared/token', value)

    def test_preflight_uses_only_selected_service_and_gateway_port(self):
        scope = tunnel.installation_scope({'FAGOO_INSTANCE_ID': 'fagoo-homolog', 'FAGOO_LOCAL_PORT': '18081', 'FAGOO_TUNNEL_METRICS_PORT': '20242'})
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(tunnel, 'os', SimpleNamespace(name='posix', geteuid=lambda: 0)), \
             patch.object(tunnel.sys.stdin, 'isatty', return_value=True), \
             patch.object(Path, 'is_dir', return_value=True), \
             patch.object(Path, 'exists', return_value=False), \
             patch.object(Path, 'is_symlink', return_value=False), \
             patch.object(tunnel.shutil, 'which', return_value='/usr/bin/cloudflared'), \
             patch.object(tunnel, 'command', side_effect=[SimpleNamespace(stdout=b'--token-file'), SimpleNamespace(stdout=b'not-found')]) as run, \
             patch('socket.socket') as socket, \
             patch.object(tunnel.urllib.request, 'urlopen', return_value=response) as request:
            self.assertEqual(tunnel.preflight(scope), '/usr/bin/cloudflared')
        self.assertEqual(run.call_args_list[-1].args[0], ['systemctl', 'show', 'fagoo-homolog-cloudflared.service', '--property=LoadState', '--value'])
        socket.return_value.__enter__.return_value.bind.assert_called_once_with(('127.0.0.1', 20242))
        request.assert_called_once_with('http://127.0.0.1:18081/healthz', timeout=5)

    def test_two_namespaces_select_exclusive_files_services_and_ready_ports(self):
        with tempfile.TemporaryDirectory() as temporary:
            for identity, local_port, metrics_port in [('fagoo', 8081, 20241), ('fagoo-homolog', 18081, 20242)]:
                with self.subTest(identity=identity):
                    runtime = Path(temporary) / (identity + '.env')
                    runtime.write_text(f'FAGOO_INSTANCE_ID={identity}\nFAGOO_LOCAL_PORT={local_port}\nFAGOO_TUNNEL_METRICS_PORT={metrics_port}\n')
                    original = runtime.read_bytes()
                    response = MagicMock()
                    response.__enter__.return_value.status = 200
                    token = synthetic_token()
                    output = io.StringIO()
                    with patch.object(tunnel.sys, 'argv', ['connect-tunnel.py', '--env-file', str(runtime), '--tunnel-id', TEST_ID]), \
                         patch.object(tunnel, 'preflight', return_value='/usr/bin/cloudflared') as preflight, \
                         patch.object(tunnel.getpass, 'getpass', return_value=token), \
                         patch.object(tunnel, 'create_configuration') as create, \
                         patch.object(tunnel, 'command') as run, \
                         patch.object(tunnel.urllib.request, 'urlopen', return_value=response) as request, \
                         patch.object(tunnel.sys, 'stdout', output):
                        self.assertEqual(tunnel.main(), 0)
                    self.assertEqual(preflight.call_args.args[0]['instance_id'], identity)
                    create.assert_called_once_with(token, '/usr/bin/cloudflared', Path(f'/etc/{identity}/cloudflared'), Path(f'/etc/systemd/system/{identity}-cloudflared.service'), metrics_port)
                    self.assertEqual(run.call_args_list[1].args[0], ['systemctl', 'enable', '--now', identity + '-cloudflared.service'])
                    self.assertEqual(run.call_args_list[2].args[0], ['systemctl', 'is-active', '--quiet', identity + '-cloudflared.service'])
                    request.assert_called_once_with(f'http://127.0.0.1:{metrics_port}/ready', timeout=5)
                    self.assertEqual(runtime.read_bytes(), original)
                    self.assertNotIn(token, output.getvalue())
                    self.assertNotIn(token, repr(run.call_args_list))
                    self.assertIn(f'--metrics 127.0.0.1:{metrics_port}', tunnel.unit_text('/usr/bin/cloudflared', f'/etc/{identity}/cloudflared/token', metrics_port))


if __name__ == '__main__':
    unittest.main()
