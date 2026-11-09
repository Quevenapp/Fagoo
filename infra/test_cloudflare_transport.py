import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import urllib.request

import cloudflare_transport as transport
from update_config import cloudflare_credentials
from update_pipeline import Pipeline
from test_deploy_application import DEPLOY


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BACKUP = load('transport_backup', 'backup-communication.py')
RENEW = load('transport_renew', 'configure-updates.py')


class TransportTests(unittest.TestCase):
    def test_old_updater_loads_candidate_transport_without_candidate_on_import_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, candidate = root / 'old-infra', root / 'candidate/infra'
            old.mkdir(); candidate.mkdir(parents=True)
            (old / 'configure.py').write_text('def origin(value): return value\n')
            (old / 'update_config.py').write_text(
                'import json\nfrom pathlib import Path\n'
                'def cloudflare_credentials(path, account=None, zone=None): return json.loads(Path(path).read_text())\n'
                'def source_identity(root): return {"version":"v0.3.1","revision":"a"*40}\n')
            for filename in ('deploy-application.py', 'cloudflare_domains.py', 'communication_runtime.py',
                             'cloudflare_transport.py', 'integration_config.py', 'queue_push_config.py'):
                shutil.copyfile(Path(__file__).with_name(filename), candidate / filename)
            probe = root / 'probe.py'
            probe.write_text('''import importlib.util, pathlib, runpy, sys
root = pathlib.Path(__file__).parent
sys.path.insert(0, str(root / 'old-infra'))
assert importlib.util.find_spec('cloudflare_transport') is None
publish = runpy.run_path(str(root / 'candidate/infra/deploy-application.py'))
import update_config
assert pathlib.Path(update_config.__file__).parent == root / 'old-infra'
for api in (publish['cloudflare_transport'], publish['cloudflare_domains']['transport'], publish['communication_runtime']['transport']):
    assert pathlib.Path(api['opener'].__globals__['__file__']).parent == root / 'candidate/infra'
    assert api['options']('ipv4') == {'ip_family':'ipv4'}
assert str(root / 'candidate/infra') not in sys.path
print('candidate transport loaded beside candidate; old updater path preserved')
''')
            result = subprocess.run([sys.executable, '-I', str(probe)], cwd=root, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('old updater path preserved', result.stdout)

    def test_credential_opt_in_is_explicit_and_absence_remains_default(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.json'
            original = {'account_id': 'a' * 32, 'zone_id': 'b' * 32, 'token': 'synthetic-private-token'}
            for extra in ({}, {'ip_family': 'ipv4'}):
                path.write_text(json.dumps({**original, **extra}))
                path.chmod(0o600)
                self.assertEqual(cloudflare_credentials(path), {**original, **extra})
            for value in ('ipv6', 'auto', '', None, True, []):
                path.write_text(json.dumps({**original, 'ip_family': value}))
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'IP_FAMILY_INVALID'):
                    cloudflare_credentials(path)

    def test_default_handler_and_global_resolver_are_unchanged(self):
        resolver = socket.getaddrinfo
        default = transport.opener()
        self.assertFalse(any(isinstance(handler, transport.IPv4HTTPSHandler) for handler in default.handlers))
        opted_in = transport.opener('ipv4')
        self.assertTrue(any(isinstance(handler, transport.IPv4HTTPSHandler) for handler in opted_in.handlers))
        self.assertIs(socket.getaddrinfo, resolver)
        for handler in opted_in.handlers:
            if isinstance(handler, urllib.request.ProxyHandler):
                self.assertEqual(handler.proxies, {})
        with self.assertRaisesRegex(ValueError, 'IP_FAMILY_INVALID'):
            transport.opener('ipv6')

    def test_ipv4_socket_uses_only_allowed_origin_and_closes_failed_attempt(self):
        failed, connected = MagicMock(), MagicMock()
        failed.connect.side_effect = OSError('synthetic unavailable IPv4')
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.1', 443)),
                     (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.2', 443))]
        with patch.object(socket, 'getaddrinfo', return_value=addresses) as resolve, patch.object(socket, 'socket', side_effect=[failed, connected]):
            actual = transport._ipv4_connection(('api.cloudflare.com', 443), timeout=17)
        resolve.assert_called_once_with('api.cloudflare.com', 443, socket.AF_INET, socket.SOCK_STREAM)
        failed.close.assert_called_once()
        connected.connect.assert_called_once_with(('192.0.2.2', 443))
        connected.settimeout.assert_called_once_with(17)
        self.assertIs(actual, connected)
        for target in (('other.example', 443), ('api.cloudflare.com', 80)):
            with self.assertRaisesRegex(ValueError, 'ORIGIN_INVALID'):
                transport._ipv4_connection(target)

    def test_tls_trust_hostname_sni_and_certificate_failures_are_preserved(self):
        handler = transport.IPv4HTTPSHandler()
        self.assertTrue(handler._context.check_hostname)
        self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)
        connection = transport.IPv4HTTPSConnection('api.cloudflare.com', context=handler._context)
        sock = MagicMock()
        with patch.object(connection, '_create_connection', return_value=sock), patch.object(handler._context, 'wrap_socket', return_value=MagicMock()) as wrap:
            connection.connect()
        wrap.assert_called_once_with(sock, server_hostname='api.cloudflare.com')
        with patch.object(connection, '_create_connection', return_value=sock), patch.object(handler._context, 'wrap_socket', side_effect=ssl.SSLCertVerificationError('synthetic untrusted')):
            with self.assertRaises(ssl.SSLCertVerificationError):
                connection.connect()

    def test_redirect_is_refused_for_default_and_ipv4_without_forwarding_authorization(self):
        request = urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/' + 'a' * 32,
                                         headers={'Authorization': 'Bearer synthetic'})
        for family in (None, 'ipv4'):
            opener = transport.opener(family)
            redirect = next(handler for handler in opener.handlers if isinstance(handler, transport.NoRedirect))
            with self.assertRaisesRegex(ValueError, 'REDIRECT_REFUSED'):
                redirect.redirect_request(request, None, 302, 'redirect', {}, 'https://other.example/')

    def test_child_env_preserves_memory_option_and_does_not_mutate_other_installations(self):
        source = {'NODE_OPTIONS': '--max-old-space-size=1536 --dns-result-order=ipv6first', 'PATH': '/synthetic'}
        self.assertEqual(transport.node_environment(source), source)
        selected = transport.node_environment(source, 'ipv4')
        self.assertEqual(selected['NODE_OPTIONS'], source['NODE_OPTIONS'] + ' --dns-result-order=ipv4first')
        self.assertNotEqual(selected, source)
        self.assertNotIn('ipv4first', source['NODE_OPTIONS'])
        self.assertEqual(transport.node_environment(selected, 'ipv4'), selected)
        pipeline = Pipeline.__new__(Pipeline)
        pipeline.credentials = {'ip_family': 'ipv4'}
        with patch.dict(os.environ, {'NODE_OPTIONS': 'synthetic-inherited', 'CLOUDFLARE_API_TOKEN': 'secret'}, clear=True):
            env = pipeline.environment()
            self.assertEqual(env['NODE_OPTIONS'], '--max-old-space-size=1536 --dns-result-order=ipv4first')
            self.assertNotIn('CLOUDFLARE_API_TOKEN', env)
            self.assertEqual(os.environ['NODE_OPTIONS'], 'synthetic-inherited')

    def test_updater_capture_passes_policy_to_candidate_preflight_and_versions(self):
        pipeline = Pipeline.__new__(Pipeline)
        pipeline.values, pipeline.env_file = {}, Path('/synthetic')
        pipeline.credentials = {'account_id': 'a' * 32, 'zone_id': 'b' * 32, 'token': 'synthetic', 'ip_family': 'ipv4'}
        preflight = MagicMock()
        get = MagicMock(return_value={'result': {'deployments': [{'versions': [{'version_id': 'synthetic', 'percentage': 100}]}]}})
        module = SimpleNamespace(configurations=lambda *args: ({'name': 'api'}, {'name': 'web'}), check_domains=preflight, cloudflare_get=get)
        spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
        with patch('update_pipeline.importlib.util.spec_from_file_location', return_value=spec), patch('update_pipeline.importlib.util.module_from_spec', return_value=module):
            result = pipeline.capture_cloudflare('/synthetic')
        self.assertEqual(set(result), {'api', 'web'})
        self.assertEqual(preflight.call_args.kwargs, {'ip_family': 'ipv4'})
        self.assertEqual([call.kwargs for call in get.call_args_list], [{'ip_family': 'ipv4'}, {'ip_family': 'ipv4'}])

    def test_token_renewal_keeps_existing_ip_policy_and_private_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / 'private/install/cloudflare/credentials.json'
            destination.parent.mkdir(parents=True)
            original = {'account_id': 'a' * 32, 'zone_id': 'b' * 32, 'token': 'synthetic-old-private-token', 'ip_family': 'ipv4'}
            destination.write_text(json.dumps(original))
            destination.chmod(0o600)
            preflight = MagicMock()
            publish = SimpleNamespace(configurations=lambda *args: (), read_token=lambda: 'synthetic-new-private-token', check_domains=preflight)
            spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
            with patch('sys.argv', ['configure-updates.py', '--root', str(root)]), patch.object(RENEW, 'os', SimpleNamespace(name='posix', geteuid=lambda: 0)), \
                 patch.object(RENEW, 'read_values', return_value={}), patch.object(RENEW.importlib.util, 'spec_from_file_location', return_value=spec), \
                 patch.object(RENEW.importlib.util, 'module_from_spec', return_value=publish):
                RENEW.main()
            self.assertEqual(preflight.call_args.kwargs, {'ip_family': 'ipv4'})
            self.assertEqual(json.loads(destination.read_text()), {**original, 'token': 'synthetic-new-private-token'})

    def test_all_three_clients_select_transport_explicitly(self):
        import cloudflare_domains
        import communication_runtime
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{"success":true,"result":[]}'
        opened = MagicMock(return_value=SimpleNamespace(open=lambda *args, **kwargs: Response()))
        for module, member, invoke in (
            (DEPLOY, 'cloudflare_transport', lambda: DEPLOY.cloudflare_get('/accounts/' + 'a' * 32, 'synthetic', ip_family='ipv4')),
            (cloudflare_domains, 'transport', lambda: cloudflare_domains.cloudflare('GET', '/accounts/' + 'a' * 32, 'synthetic', ip_family='ipv4')),
            (communication_runtime, 'transport', lambda: communication_runtime.cloudflare('GET', '/accounts/' + 'a' * 32 + '/d1/database', 'synthetic', ip_family='ipv4')),
        ):
            with self.subTest(module=module.__name__), patch.dict(getattr(module, member), {'opener': opened}):
                invoke()
                self.assertEqual(opened.call_args.args[0], 'ipv4')

    def test_backup_uses_ipv4_for_d1_and_child_and_saves_private_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / 'install/.env'
            env_path.parent.mkdir()
            state = {'account_id': 'a' * 32, 'database_id': 'synthetic-db', 'deployed': True}
            credentials = {'account_id': 'a' * 32, 'zone_id': 'b' * 32, 'token': 'synthetic-private-token', 'ip_family': 'ipv4'}
            argv = ['backup-communication.py', '--env-file', str(env_path), '--credentials-file', '/synthetic', '--config', '/config', '--hold']
            with patch('sys.argv', argv), patch.object(BACKUP, 'read_values', return_value={}), patch.object(BACKUP, 'read_state', return_value=state), \
                 patch.object(BACKUP, 'cloudflare_credentials', return_value=credentials), patch.object(BACKUP, 'query', return_value=[{'pause_outbound': 0}]) as query, \
                 patch.object(BACKUP, 'quiescent', return_value=True) as quiescent, patch.object(BACKUP, 'verify_backup', return_value='synthetic-hash'), \
                 patch.object(BACKUP.subprocess, 'run') as run:
                BACKUP.main()
            for call in query.call_args_list:
                self.assertEqual(call.kwargs, {'ip_family': 'ipv4'})
            self.assertEqual(quiescent.call_args.kwargs, {'ip_family': 'ipv4'})
            self.assertTrue(run.call_args.kwargs['env']['NODE_OPTIONS'].endswith('--dns-result-order=ipv4first'))
            private = next((Path(directory) / 'backups').glob('*/cloudflare-credentials.json'))
            self.assertEqual(json.loads(private.read_text()), credentials)
            if os.name != 'nt':
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
