import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import warnings
from unittest.mock import patch

from configure import configure

SPEC = importlib.util.spec_from_file_location('deploy_application', Path(__file__).with_name('deploy-application.py'))
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / '.env'
        configure(self.path, 'https://erp.example.test', 'https://services.example.test', 'https://api.example.test')
        self.values = DEPLOY.configuration(self.path)
        self.account = 'a' * 32
        self.zone = 'b' * 32
        self.api, self.web = DEPLOY.configurations(self.values, self.account, self.zone)

    def test_public_build_and_worker_configs_never_contain_privileged_keys(self):
        public = DEPLOY.public_environment(self.values)
        serialized = json.dumps([public, self.api, self.web])
        for key in ('POSTGRES_PASSWORD', 'JWT_SECRET', 'SERVICE_ROLE_KEY'):
            self.assertNotIn(self.values[key], serialized)
        self.assertEqual(public['VITE_SUPABASE_ANON_KEY'], self.values['ANON_KEY'])
        self.assertEqual(self.api['vars']['ALLOWED_ORIGINS'], self.values['FAGOO_WEB_ORIGIN'])
        self.assertEqual(self.api['main'], str(DEPLOY.ROOT / 'workers/erp-api/src/index.mjs'))
        self.assertFalse(self.api['workers_dev'])
        self.assertNotIn('triggers', self.api)

    def test_worker_names_are_stable_per_installation(self):
        self.assertEqual((self.api, self.web), DEPLOY.configurations(self.values, self.account, self.zone))
        changed = {**self.values, 'FAGOO_WEB_ORIGIN': 'https://another.example.test'}
        self.assertNotEqual(self.api['name'], DEPLOY.configurations(changed, self.account, self.zone)[0]['name'])

    def test_swapped_public_and_privileged_keys_are_rejected(self):
        text = self.path.read_text()
        self.path.write_text(text.replace('ANON_KEY=' + self.values['ANON_KEY'], 'ANON_KEY=' + self.values['SERVICE_ROLE_KEY']))
        with self.assertRaisesRegex(ValueError, 'RUNTIME_KEY_ROLE_INVALID'):
            DEPLOY.configuration(self.path)

    def test_build_environment_discards_inherited_credentials_and_vite_overrides(self):
        result = DEPLOY.process_environment({'PATH': '/usr/bin', 'HOME': '/example', 'CLOUDFLARE_API_TOKEN': 'token',
                                             'SUPABASE_SERVICE_ROLE_KEY': 'secret', 'VITE_SUPABASE_URL': 'wrong',
                                             'FAGOO_PRIVATE': 'private', 'PGPASSWORD': 'password', 'NPM_TOKEN': 'npm',
                                             'WRANGLER_CI_OVERRIDE_NAME': 'other-worker', 'WORKERS_CI_BRANCH': 'other-branch',
                                             'WRANGLER_SEND_METRICS': 'true'})
        self.assertEqual(result['PATH'], '/usr/bin')
        self.assertEqual(result['HOME'], '/example')
        self.assertFalse(any('token' == value or value in ('secret', 'private', 'password', 'wrong', 'npm') for value in result.values()))
        self.assertNotIn('WRANGLER_CI_OVERRIDE_NAME', result)
        self.assertNotIn('WORKERS_CI_BRANCH', result)
        self.assertEqual(result['WRANGLER_SEND_METRICS'], 'false')

    def test_token_input_refuses_getpass_echo_fallback(self):
        def fallback(prompt):
            warnings.warn('Password input may be echoed.', DEPLOY.getpass.GetPassWarning)
            self.fail('The echoed fallback must never continue to read a token')
        with patch.object(DEPLOY.getpass, 'getpass', side_effect=fallback):
            with self.assertRaisesRegex(ValueError, 'CLOUDFLARE_TOKEN_REQUIRES_PRIVATE_TERMINAL'):
                DEPLOY.read_token()
        with patch.object(DEPLOY.getpass, 'getpass', return_value='synthetic-token-input-for-test'):
            self.assertEqual(DEPLOY.read_token(), 'synthetic-token-input-for-test')

    def getter(self, *, domains=(), records=(), account=None):
        def get(path, token):
            self.assertEqual(token, 'hidden-test-token')
            if path == '/zones/' + self.zone:
                return {'result': {'account': {'id': account or self.account}, 'name': 'example.test'}}
            if path == '/accounts/' + self.account + '/workers/domains':
                return {'result': list(domains)}
            self.assertIn('/dns_records?name=', path)
            return {'result': list(records)}
        return get

    def test_preflight_refuses_existing_dns_instead_of_wrangler_overwrite(self):
        with self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_DNS_CONFLICT'):
            DEPLOY.check_domains((self.api, self.web), self.account, self.zone, 'hidden-test-token',
                                 get=self.getter(records=[{'name': 'api.example.test', 'type': 'A'}]))

    def test_preflight_refuses_other_worker_and_wrong_account(self):
        with self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_BELONGS_TO_ANOTHER_WORKER'):
            DEPLOY.check_domains((self.api,), self.account, self.zone, 'hidden-test-token',
                                 get=self.getter(domains=[{'hostname': 'api.example.test', 'service': 'different-worker', 'zone_id': self.zone}]))
        with self.assertRaisesRegex(ValueError, 'CLOUDFLARE_ZONE_ACCOUNT_MISMATCH'):
            DEPLOY.check_domains((self.api,), self.account, self.zone, 'hidden-test-token', get=self.getter(account='c' * 32))

    def test_preflight_accepts_unused_domains_and_its_existing_owned_domain(self):
        DEPLOY.check_domains((self.api, self.web), self.account, self.zone, 'hidden-test-token', get=self.getter())
        DEPLOY.check_domains((self.api,), self.account, self.zone, 'hidden-test-token',
                             get=self.getter(domains=[{'hostname': 'api.example.test', 'service': self.api['name'], 'zone_id': self.zone}]))

    def test_build_inspection_detects_real_installation_secret(self):
        public = Path(self.temp.name) / 'dist'
        public.mkdir()
        (public / 'index.html').write_text('<html>public</html>')
        self.assertEqual(DEPLOY.inspect_build(public, [self.values['SERVICE_ROLE_KEY']]), 1)
        (public / 'leak.js').write_text(self.values['SERVICE_ROLE_KEY'])
        with self.assertRaisesRegex(ValueError, 'PRIVATE_VALUE_IN_PUBLIC_BUILD'):
            DEPLOY.inspect_build(public, [self.values['SERVICE_ROLE_KEY']])

    def test_child_failure_output_is_redacted_and_never_printed(self):
        log, visible = io.StringIO(), io.StringIO()
        result = type('Result', (), {'stdout': ('failure ' + self.values['SERVICE_ROLE_KEY']).encode(), 'returncode': 1})()
        with patch.object(DEPLOY.subprocess, 'run', return_value=result), patch('sys.stdout', visible):
            with self.assertRaisesRegex(ValueError, 'API_DEPLOY_FAILED'):
                DEPLOY.run(['test'], 'API_DEPLOY', {}, log, [self.values['SERVICE_ROLE_KEY']])
        self.assertNotIn(self.values['SERVICE_ROLE_KEY'], log.getvalue() + visible.getvalue())
        self.assertIn('[redacted]', log.getvalue())


if __name__ == '__main__':
    unittest.main()
