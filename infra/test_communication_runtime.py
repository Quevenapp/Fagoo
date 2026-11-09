import json
import hashlib
from pathlib import Path
import tempfile
import unittest
from communication_runtime import names, configuration, api_bindings, read_state, provision, state_path, private_write, verify_backup, verify_adoption


class CommunicationRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = Path(self.temp.name) / '.env'
        self.values = {'FAGOO_WEB_ORIGIN': 'https://fagoo.example.test'}
        self.account = 'a' * 32
        self.databases, self.buckets, self.writes = [], [], []

    def call(self, method, path, token, body=None):
        self.assertEqual(token, 'synthetic')
        if method == 'GET':
            return self.databases if '/d1/' in path else {'buckets': self.buckets}
        self.writes.append((path, body))
        if '/d1/' in path:
            result = {'name': body['name'], 'uuid': '10000000-0000-4000-8000-000000000001'}
            self.databases.append(result)
            return result
        self.buckets.append(body)
        return body

    def test_provision_is_installation_owned_idempotent_and_keeps_encryption_key_private(self):
        first = provision(self.env, self.values, self.account, 'synthetic', self.call)
        second = provision(self.env, self.values, self.account, 'synthetic', self.call)
        self.assertEqual(first, second)
        self.assertEqual(len(self.writes), 2)
        config = configuration('/source', self.values, self.account, first)
        self.assertNotIn(first['master_key'], json.dumps(config))
        self.assertEqual(config['d1_databases'][0]['database_id'], first['database_id'])
        self.assertFalse(config['workers_dev'])
        self.assertTrue(config['assets']['run_worker_first'])
        self.assertEqual(config['vars']['FAGOO_MANAGED'], 'true')
        self.assertEqual(api_bindings(self.values)[0]['service'], first['worker'])
        with self.assertRaisesRegex(ValueError, 'INSTALLATION_MISMATCH'):
            read_state(state_path(self.env), {'FAGOO_WEB_ORIGIN': 'https://other.example.test'}, self.account)

    def test_existing_resources_require_review_instead_of_silent_adoption(self):
        self.databases.append({'name': names(self.values)['database_name'], 'uuid': 'existing'})
        with self.assertRaisesRegex(ValueError, 'REVIEWED_ADOPTION'):
            provision(self.env, self.values, self.account, 'synthetic', self.call)
        self.assertEqual(self.writes, [])
        self.assertFalse(state_path(self.env).exists())

    def test_explicitly_disabled_engine_has_no_service_binding(self):
        self.assertEqual(api_bindings({**self.values, 'FAGOO_COMMUNICATION_ENABLED': 'false'}), [])

    def backup(self):
        destination = Path(self.temp.name) / 'checkpoint'
        (destination / 'media').mkdir(parents=True)
        (destination / 'database.sql').write_bytes(b'CREATE TABLE inbox(id TEXT);')
        (destination / 'media/photo').write_bytes(b'synthetic media')
        manifest = {'version': 2, 'complete': True, 'media': [{'id': 'photo', 'object_key': 'unit/photo'}],
                    'sha256': {name: hashlib.sha256((destination / name).read_bytes()).hexdigest() for name in ('database.sql', 'media/photo')}}
        private_write(destination / 'manifest.json', manifest)
        return destination

    def test_adoption_preserves_worker_durable_objects_key_and_verified_backup(self):
        state = provision(self.env, self.values, self.account, 'synthetic', self.call)
        state.update(worker='legacy-worker', database_name='legacy-database', bucket='legacy-media')
        with self.assertRaisesRegex(ValueError, 'VERIFIED_EVIDENCE'):
            verify_adoption(state, self.values)
        directory = self.backup()
        state['adoption'] = {'reviewed': True, 'source_worker': state['worker'], 'source_database_id': state['database_id'],
            'source_bucket': state['bucket'], 'source_master_key_sha256': hashlib.sha256(state['master_key'].encode()).hexdigest(),
            'old_writer_quiesced': True, 'durable_ingress_verified': True, 'restore_rehearsal_verified': True,
            'evidence_reference': 'synthetic-rehearsal', 'backup_directory': str(directory), 'backup_manifest_sha256': verify_backup(directory)}
        verify_adoption(state, self.values)
        self.assertEqual(api_bindings(self.values, state)[0]['service'], 'legacy-worker')
        self.assertEqual(configuration('/source', self.values, self.account, state)['name'], 'legacy-worker')
        (directory / 'media/photo').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
            verify_adoption(state, self.values)

    def test_backup_rejects_traversal_instead_of_reading_outside_checkpoint(self):
        directory = self.backup()
        manifest = json.loads((directory / 'manifest.json').read_text())
        manifest['media'][0]['id'] = '../private'
        private_write(directory / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'MEDIA_INVALID'):
            verify_backup(directory)


if __name__ == '__main__':
    unittest.main()
