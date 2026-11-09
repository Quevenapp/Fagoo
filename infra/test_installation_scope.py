import importlib.util
import json
from pathlib import Path
import runpy
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from configure import configure
from installation_scope import installation_scope, project_for
from release_protocol import atomic_json
from update_pipeline import Pipeline
from update_config import read_values


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


INSTALL = module('scoped_install_updater', 'install-updater.py')
RECOVERY = module('scoped_recover_updater', 'recover-update.py')
ADMIN = module('scoped_create_admin', 'create-admin.py')


class InstallationScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def config(self, identity, local_port=8081, metrics_port=20241):
        root = self.base / identity
        env = root / 'private/install/.env'
        configure(env, f'https://{identity}.example.test', f'https://backend-{identity}.example.test',
                  f'https://api-{identity}.example.test', local_port, identity, metrics_port)
        atomic_json(env.parent / 'cloudflare/credentials.json', {'account_id': 'a' * 32, 'zone_id': 'b' * 32,
                                                               'token': 'synthetic-cloudflare-token-for-tests'})
        return root, env, read_values(env)

    def test_two_installations_select_separate_compose_projects_ports_private_roots_and_secrets(self):
        calls = []
        for identity, port, metrics in [('fagoo', 8081, 20241), ('fagoo-homolog', 18081, 20242)]:
            root, env, values = self.config(identity, port, metrics)
            pipeline = Pipeline(SimpleNamespace(root=root, current=lambda: {'source_dir': str(root)}))
            pipeline.run = lambda argv, **kwargs: calls.append(argv)
            pipeline.compose(root, 'stop', 'auth')
            self.assertEqual(calls[-1][calls[-1].index('--project-name') + 1], identity)
            self.assertEqual(calls[-1][calls[-1].index('--env-file') + 1], env)
            self.assertEqual(pipeline.scope['local_port'], port)
            self.assertEqual(pipeline.scope['metrics_port'], metrics)
            self.assertEqual(values['FAGOO_UPDATE_SOCKET_DIR'], str(root / 'private/update-service/run'))
        prod = read_values(self.base / 'fagoo/private/install/.env')
        homolog = read_values(self.base / 'fagoo-homolog/private/install/.env')
        for key in ('POSTGRES_PASSWORD', 'JWT_SECRET', 'SERVICE_ROLE_KEY', 'FAGOO_UPDATE_AGENT_TOKEN'):
            self.assertNotEqual(prod[key], homolog[key])
        self.assertEqual(installation_scope({})['updater_service'], 'fagoo-updater.service')
        self.assertEqual(installation_scope({})['tunnel_token_dir'], '/etc/fagoo/cloudflared')

    def test_persisted_identity_rejects_cli_mismatch_before_database_or_admin_mutation(self):
        root, env, values = self.config('fagoo-homolog', 18081, 20242)
        with self.assertRaisesRegex(ValueError, 'PROJECT_MISMATCH'):
            project_for(values, 'fagoo')
        with patch.object(ADMIN, 'psql') as database:
            with self.assertRaisesRegex(ValueError, 'PROJECT_MISMATCH'):
                ADMIN.create(env, 'fagoo', 'synthetic@example.test', 'Synthetic', 'synthetic-password-12345')
            database.assert_not_called()
        calls = []
        with patch('sys.argv', ['bootstrap-owner.py', '--env-file', str(env)]), patch('subprocess.run', side_effect=lambda argv, **kwargs: (calls.append(argv) or SimpleNamespace(returncode=0))):
            runpy.run_path(str(Path(__file__).with_name('bootstrap-owner.py')), run_name='__main__')
        self.assertEqual(calls[0][calls[0].index('--project-name') + 1], 'fagoo-homolog')

    def test_scope_validation_precedes_private_file_creation(self):
        for invalid in ('../fagoo', 'fagoo;id', 'UPPERCASE', '', 'a' * 41, 'fagoo\nother'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'ID_INVALID'):
                configure(self.base / 'bad/.env', 'https://web.example.test', 'https://backend.example.test',
                          'https://api.example.test', 18081, invalid, 20242)
        self.assertFalse((self.base / 'bad').exists())
        for bad in ('80', '65536', '20 242', '../port'):
            with self.assertRaisesRegex(ValueError, 'PORT_INVALID'):
                installation_scope({'FAGOO_TUNNEL_METRICS_PORT': bad})
        with self.assertRaisesRegex(ValueError, 'PORT_CONFLICT'):
            installation_scope({'FAGOO_LOCAL_PORT': '18081', 'FAGOO_TUNNEL_METRICS_PORT': '18081'})

    def test_updater_unit_refuses_another_root_and_keeps_production_service_untouched(self):
        units = self.base / 'units'
        units.mkdir()
        prod = units / 'fagoo-updater.service'
        prod.write_text('[Service]\nWorkingDirectory=/opt/fagoo\n')
        before = prod.read_bytes()
        target = units / installation_scope({'FAGOO_INSTANCE_ID': 'fagoo-homolog'})['updater_service']
        content = '[Service]\nWorkingDirectory=/opt/fagoo-homolog\n'
        INSTALL.write_service_unit(target, content, '/opt/fagoo-homolog')
        INSTALL.write_service_unit(target, content, '/opt/fagoo-homolog')
        self.assertEqual(prod.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'ANOTHER_INSTALLATION'):
            INSTALL.write_service_unit(prod, content, '/opt/fagoo-homolog')
        self.assertEqual(prod.read_bytes(), before)

    def test_recovery_refuses_a_backup_from_the_other_installation_before_stopping_services(self):
        prod_root, prod_env, _ = self.config('fagoo')
        root, env, _ = self.config('fagoo-homolog', 18081, 20242)
        backup = root / 'private/backups/synthetic'
        backup.mkdir(parents=True)
        (backup / 'runtime.env').write_bytes(prod_env.read_bytes())
        with self.assertRaisesRegex(ValueError, 'SCOPE_MISMATCH'):
            RECOVERY.recovery_scope(root, backup, {'backup_complete': True})
        (backup / 'runtime.env').write_bytes(env.read_bytes())
        scope = RECOVERY.recovery_scope(root, backup, {'backup_complete': True})
        self.assertEqual(scope['updater_service'], 'fagoo-homolog-updater.service')
        self.assertEqual(scope['project'], 'fagoo-homolog')


if __name__ == '__main__':
    unittest.main()
