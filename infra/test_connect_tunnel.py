import base64
import importlib.util
import io
import json
import os
import stat
import sys
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
    def test_optional_account_is_checked_without_exposing_token(self):
        token = synthetic_token()
        self.assertEqual(tunnel.extract_token(token, TEST_ID, 'A' * 32), (token, TEST_ID))
        for account, error in [('b' * 32, 'TUNNEL_ACCOUNT_MISMATCH'), ('bad', 'TUNNEL_ACCOUNT_INVALID')]:
            with self.assertRaisesRegex(ValueError, error) as result:
                tunnel.extract_token(token, TEST_ID, account)
            self.assertNotIn(token, str(result.exception))

    def test_token_file_requires_root_regular_private_bounded_file(self):
        def info(mode=0o600, uid=0, size=200, kind=stat.S_IFREG):
            return SimpleNamespace(st_mode=kind | mode, st_uid=uid, st_size=size)
        for mode in (0, 0o200, 0o400, 0o600):
            tunnel.validate_token_file_stat(info(mode=mode))
        for value, error in [(info(uid=1000), 'OWNER'), (info(mode=0o640), 'PERMISSIONS'), (info(mode=0o604), 'PERMISSIONS'), (info(mode=0o700), 'PERMISSIONS'), (info(mode=0o4600), 'PERMISSIONS'), (info(kind=stat.S_IFIFO), 'NOT_REGULAR'), (info(kind=stat.S_IFLNK), 'NOT_REGULAR'), (info(size=12003), 'SIZE'), (info(size=0), 'SIZE')]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                tunnel.validate_token_file_stat(value)

    def test_token_file_open_is_nofollow_checked_and_closed_on_error(self):
        token = synthetic_token()
        raw = (token + '\n').encode()
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_size=len(raw), st_mtime_ns=1, st_ctime_ns=2)
        fake = SimpleNamespace(name='posix', geteuid=lambda: 0, O_RDONLY=0, O_NOFOLLOW=1, O_NONBLOCK=2, O_CLOEXEC=4, O_DIRECTORY=8,
                               open=MagicMock(return_value=10), fstat=MagicMock(return_value=info), read=MagicMock(side_effect=[raw, b'']), close=MagicMock())
        path = Path('token-file').absolute()
        with patch.object(tunnel, 'os', fake), patch.object(tunnel.sys, 'platform', 'linux'), patch.object(Path, 'is_symlink', return_value=False), patch.object(Path, 'resolve', return_value=path):
            self.assertEqual(tunnel.read_token_file(path, TEST_ID, 'a' * 32), (token, TEST_ID))
            fake.read.side_effect = [raw, b'']
            with self.assertRaisesRegex(ValueError, 'ACCOUNT_MISMATCH'):
                tunnel.read_token_file(path, TEST_ID, 'b' * 32)
        self.assertTrue(all(call.args[1] & fake.O_NOFOLLOW for call in fake.open.call_args_list))
        self.assertEqual(fake.open.call_args_list[-1].kwargs, {'dir_fd': 10})
        self.assertGreaterEqual(fake.close.call_count, 2)
        self.assertNotIn(token, repr(fake.open.call_args_list))

    def test_token_file_rejects_symlink_nonlinux_nonroot_and_mutation(self):
        path = Path('token-file').absolute()
        fake = SimpleNamespace(name='posix', geteuid=lambda: 0, O_NOFOLLOW=1)
        with patch.object(tunnel, 'os', fake), patch.object(tunnel.sys, 'platform', 'linux'), patch.object(Path, 'is_symlink', return_value=True):
            with self.assertRaisesRegex(ValueError, 'FILE_PATH'):
                tunnel.read_token_file(path)
        for platform, uid in [('win32', 0), ('linux', 1000)]:
            fake.geteuid = lambda: uid
            with patch.object(tunnel, 'os', fake), patch.object(tunnel.sys, 'platform', platform):
                with self.assertRaisesRegex(ValueError, 'ROOT_LINUX'):
                    tunnel.read_token_file(path)
        raw = (synthetic_token() + '\n').encode()
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_size=len(raw), st_mtime_ns=1, st_ctime_ns=2)
        changed = SimpleNamespace(**{**vars(info), 'st_mtime_ns': 3})
        fake = SimpleNamespace(name='posix', geteuid=lambda: 0, O_RDONLY=0, O_NOFOLLOW=1, O_NONBLOCK=2, O_CLOEXEC=4, O_DIRECTORY=8,
                               open=MagicMock(return_value=10), fstat=MagicMock(side_effect=[info, changed]), read=MagicMock(side_effect=[raw, b'']), close=MagicMock())
        with patch.object(tunnel, 'os', fake), patch.object(tunnel.sys, 'platform', 'linux'), patch.object(Path, 'is_symlink', return_value=False), patch.object(Path, 'resolve', return_value=path):
            with self.assertRaisesRegex(ValueError, 'FILE_CHANGED'):
                tunnel.read_token_file(path)
        fake.close.assert_called_with(10)

    def test_private_file_main_avoids_prompt_and_preserves_all_runtime_checks(self):
        scope = tunnel.installation_scope({'FAGOO_INSTANCE_ID': 'fagoo-homolog', 'FAGOO_LOCAL_PORT': '18081', 'FAGOO_TUNNEL_METRICS_PORT': '20242'})
        token, output, errors = synthetic_token(), io.StringIO(), io.StringIO()
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(tunnel.sys, 'argv', ['connect-tunnel.py', '--token-file', '/root/private/tunnel.token', '--tunnel-id', TEST_ID, '--account-id', 'a' * 32]), \
             patch.object(tunnel, 'configuration', return_value=scope), \
             patch.object(tunnel, 'read_token_file', return_value=(token, TEST_ID)) as read, \
             patch.object(tunnel, 'preflight', return_value='/usr/bin/cloudflared') as preflight, \
             patch.object(tunnel.getpass, 'getpass') as prompt, \
             patch.object(tunnel, 'create_configuration') as create, \
             patch.object(tunnel, 'command') as command, \
             patch.object(tunnel.urllib.request, 'urlopen', return_value=response), \
             patch.object(tunnel.sys, 'stdout', output), patch.object(tunnel.sys, 'stderr', errors):
            self.assertEqual(tunnel.main(), 0)
        read.assert_called_once_with(Path('/root/private/tunnel.token'), TEST_ID, 'a' * 32)
        preflight.assert_called_once_with(scope, private_file=True)
        prompt.assert_not_called()
        create.assert_called_once()
        self.assertNotIn(token, output.getvalue() + errors.getvalue() + repr(command.call_args_list))

    def test_bad_file_prevents_any_configuration_or_service_mutation(self):
        token, errors = synthetic_token(), io.StringIO()
        with patch.object(tunnel.sys, 'argv', ['connect-tunnel.py', '--token-file', '/root/private/token']), \
             patch.object(tunnel, 'configuration', return_value=tunnel.installation_scope({})), \
             patch.object(tunnel, 'read_token_file', side_effect=ValueError('TUNNEL_TOKEN_FILE_PERMISSIONS')), \
             patch.object(tunnel, 'preflight') as preflight, patch.object(tunnel, 'create_configuration') as create, \
             patch.object(tunnel, 'command') as command, patch.object(tunnel.sys, 'stderr', errors):
            self.assertEqual(tunnel.main(), 1)
        for untouched in (preflight, create, command):
            untouched.assert_not_called()
        self.assertNotIn(token, errors.getvalue())
        self.assertIn('TUNNEL_TOKEN_FILE_PERMISSIONS', errors.getvalue())

    def test_no_tty_still_rejected_without_validated_private_file(self):
        with patch.object(tunnel, 'os', SimpleNamespace(name='posix', geteuid=lambda: 0)), \
             patch.object(Path, 'is_dir', return_value=True), patch.object(tunnel.sys.stdin, 'isatty', return_value=False):
            with self.assertRaisesRegex(ValueError, 'PRIVATE_TERMINAL_REQUIRED'):
                tunnel.preflight()

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
            original_directory = tunnel.secure_destination_directory
            tunnel.unit_text = lambda binary, path, metrics_port=20241: original('/usr/bin/cloudflared', '/etc/fagoo/cloudflared/token', metrics_port)
            # This case tests exclusive writes portably; actual directory trust
            # is exercised below on Linux, without mocking filesystem calls.
            def test_directory(path, create=False):
                if create:
                    Path(path).mkdir(parents=True, exist_ok=True)
                return os.open(path, os.O_RDONLY | os.O_DIRECTORY)
            tunnel.secure_destination_directory = test_directory
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
                tunnel.secure_destination_directory = original_directory

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
             patch.object(tunnel.sys.stdin, 'isatty', return_value=False), \
             patch.object(Path, 'is_dir', return_value=True), \
             patch.object(Path, 'exists', return_value=False), \
             patch.object(Path, 'is_symlink', return_value=False), \
             patch.object(tunnel.shutil, 'which', return_value='/usr/bin/cloudflared'), \
             patch.object(tunnel, 'command', side_effect=[SimpleNamespace(stdout=b'--token-file'), SimpleNamespace(stdout=b'not-found')]) as run, \
             patch('socket.socket') as socket, \
             patch.object(tunnel.urllib.request, 'urlopen', return_value=response) as request:
            self.assertEqual(tunnel.preflight(scope, private_file=True), '/usr/bin/cloudflared')
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


@unittest.skipUnless(sys.platform == 'linux' and getattr(os, 'geteuid', lambda: -1)() == 0 and os.environ.get('FAGOO_TUNNEL_TEST_ROOT'),
                     'Explicit root-owned Linux QA directory required for real filesystem checks')
class LinuxFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tunnel-fs-', dir=os.environ['FAGOO_TUNNEL_TEST_ROOT'])
        self.base = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_real_source_rejects_symlinks_fifo_owner_and_permissions(self):
        token = synthetic_token()
        source = self.base / 'source'
        source.write_text(token + '\n')
        source.chmod(0o600)
        self.assertEqual(tunnel.read_token_file(source, TEST_ID, 'a' * 32), (token, TEST_ID))
        for mode in (0o640, 0o604, 0o700):
            source.chmod(mode)
            with self.assertRaisesRegex(ValueError, 'PERMISSIONS'):
                tunnel.read_token_file(source)
        source.chmod(0o600)
        os.chown(source, 65534, 65534)
        with self.assertRaisesRegex(ValueError, 'OWNER'):
            tunnel.read_token_file(source)
        os.chown(source, 0, 0)
        link = self.base / 'link'
        link.symlink_to(source)
        with self.assertRaisesRegex(ValueError, 'FILE_PATH'):
            tunnel.read_token_file(link)
        fifo = self.base / 'fifo'
        os.mkfifo(fifo, 0o600)
        with self.assertRaisesRegex(ValueError, 'NOT_REGULAR'):
            tunnel.read_token_file(fifo)

    def test_real_destination_rejects_symlink_unsafe_owner_or_write(self):
        for target in ('token', 'unit'):
            for fault in ('symlink', 'owner', 'group-write', 'world-write'):
                case = self.base / (target + '-' + fault)
                case.mkdir(mode=0o700)
                real = case / 'real'
                real.mkdir(mode=0o700)
                unsafe = real
                if fault == 'symlink':
                    unsafe = case / 'alias'
                    unsafe.symlink_to(real, target_is_directory=True)
                elif fault == 'owner':
                    os.chown(real, 65534, 65534)
                else:
                    real.chmod(0o720 if fault == 'group-write' else 0o702)
                token_dir = (unsafe if target == 'token' else case) / 'cloudflared'
                unit_path = (unsafe if target == 'unit' else case) / 'connector.service'
                with self.subTest(target=target, fault=fault), self.assertRaisesRegex(ValueError, 'DESTINATION_UNSAFE'):
                    tunnel.create_configuration(synthetic_token(), '/usr/bin/cloudflared', token_dir, unit_path)
                self.assertFalse(token_dir.exists())
                self.assertFalse(unit_path.exists())
                if fault == 'owner':
                    os.chown(real, 0, 0)

    def test_real_destination_private_exclusive_files(self):
        token = synthetic_token()
        token_dir, unit = self.base / 'instance' / 'cloudflared', self.base / 'connector.service'
        tunnel.create_configuration(token, '/usr/bin/cloudflared', token_dir, unit)
        self.assertEqual((token_dir / 'token').read_text().strip(), token)
        self.assertEqual((token_dir / 'token').stat().st_mode & 0o777, 0o600)
        self.assertEqual(token_dir.stat().st_mode & 0o777, 0o700)
        self.assertNotIn(token, unit.read_text())
        with self.assertRaisesRegex(ValueError, 'CONFIGURATION_EXISTS'):
            tunnel.create_configuration('replacement', '/usr/bin/cloudflared', token_dir, unit)
        self.assertEqual((token_dir / 'token').read_text().strip(), token)


if __name__ == '__main__':
    unittest.main()
