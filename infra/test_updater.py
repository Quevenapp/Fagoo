import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('updater.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTests(unittest.TestCase):
    def test_version_comparison_prevents_signed_release_replay_downgrades(self):
        self.assertFalse(updater.newer_version('v0.1.0', 'v0.2.0'))
        self.assertFalse(updater.newer_version('v0.1.0-alpha.1', 'v0.1.0'))
        self.assertTrue(updater.newer_version('v0.1.0', 'v0.1.0-alpha.1'))
        self.assertTrue(updater.newer_version('v0.1.0-alpha.10', 'v0.1.0-alpha.2'))
        self.assertFalse(updater.newer_version('v0.1.0-alpha.2', 'v0.1.0-alpha.10'))
        self.assertTrue(updater.newer_version('v0.1.0', 'source'))
    def test_backup_failure_never_reports_a_successful_new_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            script = Path(__file__).with_name('backup-state.py')
            environment = {**os.environ, 'FAGOO_HOME': folder}
            subprocess.run([os.sys.executable, str(script), 'running'], env=environment, check=True)
            subprocess.run([os.sys.executable, str(script), 'failed'], env=environment, check=True)
            value = json.loads((Path(folder) / 'state/backup.json').read_text(encoding='utf-8'))
            self.assertEqual(value['status'], 'failed')
            self.assertIsNone(value['last_success_at'])
            self.assertFalse(value['offsite'])
            subprocess.run([os.sys.executable, str(script), 'local_only', 'verified.dump'], env=environment, check=True)
            local = json.loads((Path(folder) / 'state/backup.json').read_text(encoding='utf-8'))
            self.assertEqual(local['status'], 'local_only')
            self.assertFalse(local['offsite'])
            self.assertTrue(local['last_success_at'])

    def test_public_status_contract_does_not_invent_backup_or_release(self):
        with tempfile.TemporaryDirectory() as folder:
            state = updater.Updater(folder).snapshot()
            self.assertEqual(set(state), {'installed', 'latest', 'status', 'backup', 'update_available', 'message'})
            self.assertIsNone(state['latest'])
            self.assertEqual(state['backup']['status'], 'unknown')
            self.assertIsNone(state['backup']['last_success_at'])
    @unittest.skipUnless(shutil.which('openssl'), 'OpenSSL executable required')
    def test_ed25519_signature_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            private, public = root / 'private.pem', root / 'public.pem'
            manifest, signature = root / 'manifest.json', root / 'manifest.sig'
            value = {'schema': 1, 'product': 'fagoo', 'version': 'v0.1.0', 'platform': 'linux/amd64', 'minimum_updater': 1,
                     'image': 'ghcr.io/quevenapp/fagoo@sha256:' + 'a' * 64, 'database_version': 1, 'compatible_database_min': 1,
                     'artifact': {'url': 'https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0/deployment.tar.gz', 'sha256': 'b' * 64, 'size': 100}}
            manifest.write_text(json.dumps(value))
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(private)], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkey', '-in', str(private), '-pubout', '-out', str(public)], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(private), '-rawin', '-in', str(manifest), '-out', str(signature)], check=True, capture_output=True)
            self.assertEqual(updater.verify_manifest(manifest, signature, public)['version'], 'v0.1.0')
            manifest.write_text(json.dumps({**value, 'version': 'v0.2.0'}))
            with self.assertRaisesRegex(ValueError, 'INVALID_SIGNATURE'):
                updater.verify_manifest(manifest, signature, public)

    def test_image_is_loaded_only_after_hash_and_identity_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            (home / 'state').mkdir()
            payload, calls, loaded = b'image archive', [], False
            manifest = {'image': 'sha256:' + 'c' * 64, 'image_artifact': {'url': 'https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0/app-image.tar.gz', 'sha256': hashlib.sha256(payload).hexdigest(), 'size': len(payload)}}
            def fetch(url, path, limit):
                path.write_bytes(payload)
            def run(argv, env=None):
                nonlocal loaded
                calls.append(argv)
                if argv[1] == 'load':
                    loaded = True
                    return ''
                if not loaded:
                    raise RuntimeError('absent')
                return manifest['image'] + '\n'
            updater.ensure_image(manifest, home, fetch, run)
            self.assertTrue(loaded)
            loaded, calls = False, []
            manifest['image_artifact']['sha256'] = 'd' * 64
            with self.assertRaisesRegex(ValueError, 'INVALID_IMAGE_ARTIFACT_DIGEST'):
                updater.ensure_image(manifest, home, fetch, run)
            self.assertFalse(loaded)

    def test_archive_cannot_escape_release_or_create_links(self):
        for name, link in [('../escape', False), ('/absolute', False), ('infra/link', True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                archive = Path(folder) / 'archive.tar.gz'
                with tarfile.open(archive, 'w:gz') as bundle:
                    item = tarfile.TarInfo(name)
                    if link:
                        item.type, item.linkname = tarfile.SYMTYPE, '/etc'
                        bundle.addfile(item)
                    else:
                        item.size = 1
                        bundle.addfile(item, io.BytesIO(b'x'))
                payload = archive.read_bytes()
                with self.assertRaisesRegex(ValueError, 'UNSAFE_ARTIFACT_PATH'):
                    updater.extract_bundle(archive, Path(folder) / 'release', {'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})

    def test_verified_archive_extracts_regular_files(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'archive.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                for name in ['infra/compose.yaml', 'scripts/backup.sh']:
                    item = tarfile.TarInfo(name)
                    item.size = 2
                    bundle.addfile(item, io.BytesIO(b'ok'))
            payload = archive.read_bytes()
            updater.extract_bundle(archive, Path(folder) / 'release', {'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
            self.assertEqual((Path(folder) / 'release/infra/compose.yaml').read_text(), 'ok')

    def test_restart_marks_inflight_release_for_manual_recovery(self):
        with tempfile.TemporaryDirectory() as folder:
            service = updater.Updater(folder)
            service.save(state='running', phase='migrate')
            restarted = updater.Updater(folder)
            self.assertEqual(restarted.status()['state'], 'interrupted')
            with self.assertRaisesRegex(ValueError, 'RECOVERY_REQUIRED'):
                restarted.enqueue('v0.2.0')

    def test_url_and_command_input_are_restricted(self):
        for url in ['http://github.com/Quevenapp/Fagoo', 'https://example.com/x', 'https://user:pass@github.com/x', 'https://github.com:444/x']:
            with self.assertRaises(ValueError):
                updater.validate_download_url(url)
        with tempfile.TemporaryDirectory() as folder:
            service = updater.Updater(folder)
            for value in ['../../main', 'v1.0.0;rm', None, {'command': 'anything'}]:
                with self.assertRaisesRegex(ValueError, 'INVALID_VERSION'):
                    service.enqueue(value)


if __name__ == '__main__':
    unittest.main()
