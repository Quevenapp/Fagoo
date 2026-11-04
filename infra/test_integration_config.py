import base64
import json
import unittest
import importlib.util
from pathlib import Path
import tempfile
from integration_config import integration_settings
from test_deploy_application import DEPLOY

_spec = importlib.util.spec_from_file_location('configure_integration', Path(__file__).with_name('configure-integration.py'))
CONFIGURE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(CONFIGURE)


class IntegrationConfigurationTests(unittest.TestCase):
    def values(self, **patch):
        return {'FAGOO_INTEGRATION_ENABLED': 'true', 'FAGOO_INTEGRATION_MODE': 'bidirectional',
                'FAGOO_INTEGRATION_NAME': 'Fornecedor de teste', 'FAGOO_INTEGRATION_START_DATE': '2026-01-01',
                'FAGOO_WEB_ORIGIN': 'https://erp.example.test', 'FAGOO_API_ORIGIN': 'https://api.example.test',
                'FAGOO_BACKEND_ORIGIN': 'https://data.example.test',
                'ORIGIN_API_ORIGIN': 'https://api.provider.example',
                'ORIGIN_AUTHORIZATION_ENDPOINT': 'https://provider.example/oauth/authorize',
                'ORIGIN_TOKEN_ENDPOINT': 'https://api.provider.example/oauth/token',
                'ORIGIN_CLIENT_ID': 'synthetic-client', 'ORIGIN_CLIENT_SECRET': 'synthetic-client-secret',
                'TOKEN_ENCRYPTION_KEY': base64.b64encode(b'x' * 32).decode(),
                'INTEGRATION_ADMIN_TOKEN': 'synthetic-admin-token-for-tests-only', **patch}

    def test_fresh_and_legacy_flag_only_installations_remain_disconnected(self):
        for values in ({}, {'ORIGIN_ENABLED': 'true', 'ORIGIN_TWO_WAY_ENABLED': 'true'}):
            self.assertEqual(integration_settings(values), {'vars': {}, 'secrets': {}, 'scheduled': False})

    def test_update_retains_optional_connector_and_keeps_secrets_out_of_worker_vars(self):
        values = self.values()
        first = DEPLOY.configurations(values, 'a' * 32, 'b' * 32)
        second = DEPLOY.configurations(dict(values), 'a' * 32, 'b' * 32)
        self.assertEqual(first, second)
        api, web = first
        self.assertEqual(api['triggers']['crons'], ['*/2 * * * *'])
        self.assertEqual(api['vars']['ORIGIN_WRITE_ENABLED'], 'true')
        self.assertEqual(api['vars']['PUBLIC_BASE_URL'], values['FAGOO_API_ORIGIN'])
        for secret in integration_settings(values)['secrets'].values():
            self.assertNotIn(secret, json.dumps([api, web]))

    def test_receive_and_paused_modes_never_allow_writes(self):
        for mode in ('receive', 'paused'):
            result = integration_settings(self.values(FAGOO_INTEGRATION_MODE=mode))
            self.assertEqual(result['vars']['ORIGIN_WRITE_ENABLED'], 'false')
            self.assertEqual(result['scheduled'], mode == 'receive')
            self.assertEqual(result['vars']['SYNC_ENABLED'], 'true' if mode == 'receive' else 'false')

    def test_invalid_or_incomplete_config_is_refused(self):
        for patch in ({'FAGOO_INTEGRATION_MODE': 'other'}, {'ORIGIN_CLIENT_SECRET': ''},
                      {'TOKEN_ENCRYPTION_KEY': 'broken'}, {'FAGOO_INTEGRATION_START_DATE': '2026-02-30'},
                      {'ORIGIN_API_ORIGIN': 'http://api.provider.example'},
                      {'ORIGIN_TOKEN_ENDPOINT': 'https://secret@api.provider.example/oauth'},
                      {'ORIGIN_AUTHORIZATION_ENDPOINT': 'https://provider.example/oauth?token=bad'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                integration_settings(self.values(**patch))

    def test_invalid_endpoint_types_are_validation_errors(self):
        for value in (None, 123, {}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                integration_settings(self.values(ORIGIN_API_ORIGIN=value))

    def test_private_configuration_is_atomic_preserves_other_values_and_refuses_key_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            values = self.values()
            path.write_text('# preserved comment\nOTHER_SETTING=keep\n' + ''.join(f'{k}={v}\n' for k, v in values.items()), encoding='utf-8')
            CONFIGURE.save_configuration(path, {'FAGOO_INTEGRATION_MODE': 'receive'})
            saved = path.read_bytes()
            self.assertIn(b'FAGOO_INTEGRATION_MODE=receive', saved)
            self.assertIn(b'# preserved comment\nOTHER_SETTING=keep', saved)
            with self.assertRaisesRegex(ValueError, 'EXISTING_ENCRYPTION_KEY_MUST_BE_PRESERVED'):
                CONFIGURE.save_configuration(path, {'TOKEN_ENCRYPTION_KEY': base64.b64encode(b'z'*32).decode()})
            self.assertEqual(path.read_bytes(), saved)
            with self.assertRaises(ValueError):
                CONFIGURE.save_configuration(path, {'ORIGIN_CLIENT_SECRET': ''})
            self.assertEqual(path.read_bytes(), saved)
