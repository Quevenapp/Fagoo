import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import communication_runtime as runtime
from update_pipeline import Pipeline
from test_deploy_application import DEPLOY
from configure import configure


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BACKUP = load('cutover_backup', 'backup-communication.py')
RECOVERY = load('cutover_recovery', 'recover-update.py')


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = self.root / 'private/install/.env'
        self.env.parent.mkdir(parents=True)
        self.values = {'FAGOO_WEB_ORIGIN': 'https://fagoo.example.test', 'FAGOO_API_ORIGIN': 'https://api.example.test'}
        self.account = 'a' * 32
        self.backup = self.root / 'legacy-backup'
        self.backup.mkdir()
        (self.backup / 'database.sql').write_bytes(b'CREATE TABLE inbox(id TEXT);')
        runtime.private_write(self.backup / 'manifest.json', {'version': 2, 'complete': True, 'media': [],
            'sha256': {'database.sql': hashlib.sha256((self.backup / 'database.sql').read_bytes()).hexdigest()}})
        self.state = {'format': 1, 'origin': self.values['FAGOO_WEB_ORIGIN'], 'account_id': self.account,
            'worker': 'legacy-engine', 'database_name': 'legacy-data', 'database_id': '12345678-1234-4234-8234-123456789abc',
            'bucket': 'legacy-media', 'master_key': 'x' * 32, 'deployed': False, 'bucket_created': True, 'provisioning': False}
        self.state['adoption'] = {'reviewed': True, 'source_worker': self.state['worker'],
            'source_database_id': self.state['database_id'], 'source_bucket': self.state['bucket'],
            'source_master_key_sha256': hashlib.sha256(self.state['master_key'].encode()).hexdigest(),
            'old_writer_quiesced': True, 'durable_ingress_verified': True, 'restore_rehearsal_verified': True,
            'evidence_reference': 'synthetic-restore', 'backup_directory': str(self.backup),
            'backup_manifest_sha256': runtime.verify_backup(self.backup)}
        self.activation = {'import_reconciled': True, 'old_writer_stopped': True, 'archive_restore_verified': True,
            'single_channel_consumer_verified': True, 'd1_adoption_verified': True, 'source_sha256': 'b' * 64,
            'run_id': '23456789-1234-4234-8234-123456789abc', 'evidence_reference': 'synthetic-cutover'}
        self.versions = [{'version_id': '34567890-1234-4234-8234-123456789abc', 'percentage': 100}]
        self.marker = self.env.parent / 'communication-maintenance.json'
        self.paused, self.tables, self.queries = 0, False, []
        runtime.private_write(runtime.state_path(self.env), self.state)

    def cloudflare(self, method, path, token):
        self.assertEqual(method, 'GET')
        self.assertIn('/workers/scripts/legacy-engine/deployments', path)
        return {'deployments': [{'created_on': '2026-11-09', 'versions': self.versions}]}

    def query(self, state, token, sql, params=None):
        self.queries.append(sql)
        if 'sqlite_master' in sql:
            return [{'name': 'fagoo_runtime'}] if self.tables else []
        if sql.startswith('UPDATE'):
            self.paused = 1 if 'pause_outbound=1' in sql else params[0]
            return []
        return [{'pause_outbound': self.paused}]

    def prepare(self):
        with patch.object(BACKUP, 'query', side_effect=self.query), patch.object(BACKUP, 'cloudflare', side_effect=self.cloudflare):
            BACKUP.prepare_adoption(self.marker, self.state, self.values, 'synthetic')

    def test_legacy_checkpoint_survives_failure_and_resume_requires_explicit_activation(self):
        self.prepare()
        held = json.loads(self.marker.read_text())
        self.assertEqual(held['previous_versions'], self.versions)
        self.assertFalse(held['previous_state']['deployed'])
        self.assertFalse(held['pause_applied'])
        self.tables = True  # D1 migration completes before managed bootstrap.
        with patch.object(BACKUP, 'query', side_effect=self.query):
            BACKUP.hold_adoption(self.marker, self.state, 'synthetic')
            self.assertEqual(self.paused, 1)
            with self.assertRaisesRegex(ValueError, 'ACTIVATION_EVIDENCE_REQUIRED'):
                BACKUP.resume(self.marker, self.state, 'synthetic')
            self.assertTrue(self.marker.exists())
            self.assertEqual(self.paused, 1)
            self.state['adoption']['activation'] = self.activation
            BACKUP.resume(self.marker, self.state, 'synthetic')
        self.assertEqual(self.paused, 0)
        self.assertFalse(self.marker.exists())

    def test_adoption_cannot_overwrite_checkpoint_or_resume_corrupt_backup(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'MAINTENANCE_RECONCILIATION'):
            BACKUP.prepare_adoption(self.marker, self.state, self.values, 'synthetic')
        (self.backup / 'database.sql').write_bytes(b'corrupt')
        with patch.object(BACKUP, 'query', side_effect=self.query), self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
            BACKUP.resume(self.marker, self.state, 'synthetic')
        self.assertFalse(any(sql.startswith('UPDATE') for sql in self.queries))

    def test_rollback_fills_old_updater_gap_and_restores_legacy_state_without_restarting_writer(self):
        self.prepare()
        runtime.private_write(runtime.state_path(self.env), {**self.state, 'deployed': True})
        pipeline = SimpleNamespace(env_file=self.env, values=self.values, credentials={'account_id': self.account},
                                   run=lambda *args, **kwargs: self.fail('Legacy writer must remain quiesced'))
        recovery = {'cloudflare': {'fagoo-api-' + 'a' * 12: self.versions}, 'sha256': {}}
        state, versions, held = RECOVERY.communication_recovery(pipeline, self.backup, recovery)
        self.assertEqual(versions['legacy-engine'], self.versions)
        self.assertFalse(state['deployed'])
        RECOVERY.finish_communication_recovery(pipeline, self.backup, state, held)
        self.assertFalse(runtime.read_state(runtime.state_path(self.env), self.values, self.account)['deployed'])
        self.assertFalse(self.marker.exists())
        self.assertTrue((self.backup / 'communication-adoption-recovery.json').exists())
        self.assertEqual((self.backup / 'database.sql').read_bytes(), b'CREATE TABLE inbox(id TEXT);')

    def test_pipeline_captures_legacy_version_when_deployed_is_false(self):
        pipeline = Pipeline.__new__(Pipeline)
        pipeline.env_file, pipeline.values = self.env, self.values
        pipeline.credentials = {'account_id': self.account, 'zone_id': 'b' * 32, 'token': 'synthetic'}
        calls = []
        module = SimpleNamespace(communication_runtime=vars(runtime), configurations=lambda *args: ({'name': 'api'}, {'name': 'web'}),
            check_domains=lambda *args: None,
            cloudflare_get=lambda path, token: (calls.append(path) or {'result': {'deployments': [{'versions': self.versions}]}}))
        spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
        with patch('update_pipeline.importlib.util.spec_from_file_location', return_value=spec), patch('update_pipeline.importlib.util.module_from_spec', return_value=module):
            versions = pipeline.capture_cloudflare(self.root)
        self.assertIn('legacy-engine', versions)
        self.assertEqual(len(calls), 3)
        self.assertFalse(self.state['deployed'])

    def test_publication_requires_both_live_versions_and_rejects_stale_or_failed_api(self):
        expected = {'version': 'v1.0.0', 'revision': 'a' * 40}
        calls = []
        class Reply:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return json.dumps(expected).encode()
        def open_request(request, **kwargs):
            calls.append(request.full_url)
            return Reply()
        DEPLOY.verify_publication(self.values, expected, SimpleNamespace(open=open_request), attempts=1)
        self.assertEqual(len(calls), 2)
        self.assertIn('/fagoo-version.json?', calls[0])
        self.assertIn('/v1/system/version?', calls[1])
        class Stale(Reply):
            def read(self, limit): return b'{"version":"v0.3.1","revision":"old"}'
        with self.assertRaisesRegex(ValueError, 'VERSION_VERIFICATION_FAILED'):
            DEPLOY.verify_publication(self.values, expected, SimpleNamespace(open=lambda *args, **kwargs: Stale()), attempts=1)

    def test_full_candidate_workflow_holds_before_bootstrap_and_does_not_resume_failed_health(self):
        configure(self.env, self.values['FAGOO_WEB_ORIGIN'], 'https://backend.example.test', self.values['FAGOO_API_ORIGIN'])
        self.state['adoption']['activation'] = self.activation
        runtime.private_write(runtime.state_path(self.env), self.state)
        for relative in ('node_modules/wrangler/bin/wrangler.js', 'apps/erp/dist/index.html', 'workers/communication/dist/index.html'):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic public fixture')
        phases = []
        def run(command, phase, *args, **kwargs):
            phases.append(phase)
            if phase == 'COMMUNICATION_ADOPTION_CHECKPOINT': self.prepare()
            if phase == 'COMMUNICATION_DATABASE': self.tables = True
            if phase == 'COMMUNICATION_ADOPTION_PAUSE':
                with patch.object(BACKUP, 'query', side_effect=self.query):
                    BACKUP.hold_adoption(self.marker, self.state, 'synthetic')
            if phase in ('COMMUNICATION_BOOTSTRAP', 'API_DEPLOY', 'COMMUNICATION_DEPLOY', 'WEB_DEPLOY'):
                self.assertEqual(self.paused, 1)
                self.assertEqual(json.loads(Path(command[command.index('--config') + 1]).read_text())['routes'], [])
            if phase == 'COMMUNICATION_RESUME': self.fail('Health failed; must keep engine paused')
        def fail_health(*args):
            phases.append('PUBLIC_HEALTH')
            self.assertEqual(self.paused, 1)
            raise ValueError('PUBLISHED_VERSION_VERIFICATION_FAILED')
        argv = ['deploy-application.py', '--env-file', str(self.env), '--account-id', self.account,
                '--zone-id', 'b' * 32, '--deploy']
        with patch('sys.argv', argv), patch.object(DEPLOY, 'ROOT', self.root), patch.object(DEPLOY, 'run', side_effect=run), \
                patch.object(DEPLOY, 'read_token', return_value='synthetic-cloudflare-private-token'), \
                patch.object(DEPLOY, 'source_identity', return_value={'version': 'v1.0.0', 'revision': 'a' * 40}), \
                patch.object(DEPLOY, 'check_domains'), patch.object(DEPLOY, 'bind_domains'), patch.object(DEPLOY, 'verify_publication', side_effect=fail_health), \
                patch.dict(DEPLOY.communication_runtime, {'provision': lambda *args: self.state}):
            with self.assertRaisesRegex(ValueError, 'VERSION_VERIFICATION_FAILED'):
                DEPLOY.main()
        self.assertLess(phases.index('COMMUNICATION_ADOPTION_CHECKPOINT'), phases.index('COMMUNICATION_DATABASE'))
        self.assertLess(phases.index('COMMUNICATION_ADOPTION_PAUSE'), phases.index('COMMUNICATION_BOOTSTRAP'))
        self.assertLess(phases.index('WEB_DEPLOY'), phases.index('PUBLIC_HEALTH'))
        self.assertTrue(self.marker.exists())
        self.assertEqual(self.paused, 1)


if __name__ == '__main__':
    unittest.main()
