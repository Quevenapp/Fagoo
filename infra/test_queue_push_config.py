import json
import unittest
from queue_push_config import queue_push_settings
from test_deploy_application import DEPLOY


class QueuePushConfigurationTests(unittest.TestCase):
    def test_unconfigured_provider_stays_optional(self):
        self.assertEqual(queue_push_settings({}), {'vars': {}, 'secrets': {}})

    def test_legacy_credentials_are_preserved_as_secrets_and_excluded_from_build(self):
        account = json.dumps({'type': 'service_account', 'project_id': 'synthetic-project', 'client_email': 'synthetic@example.test',
                              'private_key': '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'})
        values = {'FCM_CONTA_SERVICO': account, 'APNS_CHAVE_P8': '-----BEGIN PRIVATE KEY-----\\nsynthetic\\n-----END PRIVATE KEY-----',
                  'APNS_KEY_ID': 'SYNTHETIC1', 'APNS_TEAM_ID': 'SYNTHETIC2', 'APNS_TOPICO': 'br.com.example.consumer'}
        config = queue_push_settings(values)
        self.assertEqual(config['secrets']['FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON'], account)
        self.assertIn('\n', config['secrets']['FAGOO_QUEUE_APNS_PRIVATE_KEY'])
        self.assertNotIn('PRIVATE KEY', json.dumps(config['vars']))
        sanitized = DEPLOY.process_environment({**values, 'MASTER_KEY': 'sensitive', 'PATH': 'synthetic-path'})
        self.assertNotIn('FCM_CONTA_SERVICO', sanitized)
        self.assertNotIn('APNS_CHAVE_P8', sanitized)
        self.assertNotIn('MASTER_KEY', sanitized)

    def test_partial_or_invalid_provider_is_not_silently_dropped(self):
        for values in ({'APNS_KEY_ID': 'ONLYONEKEY'}, {'FCM_CONTA_SERVICO': '{}'}, {'FCM_CONTA_SERVICO': '[]'}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                queue_push_settings(values)


if __name__ == '__main__':
    unittest.main()
