"""Safety and protocol primitives; real Auth/CRM checks require explicit remote execution."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('homologation_auth_crm', Path(__file__).with_name('homologation_auth_crm.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class QaSafetyTests(unittest.TestCase):
    def config(self):
        return {**qa.ORIGINS, 'FAGOO_INSTANCE_ID': 'fagoo-homolog', 'FAGOO_LOCAL_PORT': '18081', 'ANON_KEY': 'synthetic', 'SERVICE_ROLE_KEY': 'synthetic'}

    def test_exact_instance_and_root_required(self):
        qa.validate_config(qa.ROOT, self.config())
        for root, values in ((Path('/opt/fagoo'), self.config()), (qa.ROOT, {**self.config(), 'FAGOO_INSTANCE_ID': 'fagoo'}), (qa.ROOT, {**self.config(), 'FAGOO_LOCAL_PORT': '8081'})):
            with self.assertRaises(qa.QaError):
                qa.validate_config(root, values)

    def test_only_reviewed_homolog_origins(self):
        for key in qa.ORIGINS:
            with self.assertRaises(qa.QaError):
                qa.validate_config(qa.ROOT, {**self.config(), key: 'https://demo.fagoo.com.br'})
        with self.assertRaisesRegex(qa.QaError, 'QA_HTTP_ORIGIN_DENIED'):
            qa.http('https://api.fagoo.com.br', '/v1/me')
        with self.assertRaisesRegex(qa.QaError, 'QA_HTTP_ORIGIN_DENIED'):
            qa.http('https://api-fagoo-homolog.queven.app', '/v1/me')

    def test_redirect_never_forwards_credentials(self):
        with self.assertRaisesRegex(qa.QaError, 'QA_HTTP_REDIRECT_DENIED'):
            qa.NoRedirect().redirect_request(None, None, None, None, None, None)

    def test_rfc6238_totp_six_digit_vectors(self):
        secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        for at, expected in ((59, '287082'), (1111111109, '081804'), (1111111111, '050471'), (1234567890, '005924')):
            self.assertEqual(qa.totp(secret, at), expected)

    def test_private_state_is_atomic_and_cannot_follow_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private' / 'credentials.json'
            qa.save_private(path, {'password': 'synthetic-only'})
            self.assertIn('synthetic-only', path.read_text())
            self.assertFalse(path.with_suffix('.tmp').exists())
            with patch.object(Path, 'is_symlink', return_value=True):
                with self.assertRaises(qa.QaError):
                    qa.save_private(path, {})

    def test_uncertain_command_retry_preserves_id_and_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            run = qa.Run(Path(directory), self.config(), '123456789abc')
            received = []
            def api(name, path, method, payload):
                received.append(payload.copy())
                if len(received) == 1:
                    raise qa.QaError('QA_HTTP_UNAVAILABLE')
                return {'ok': True}
            run.api = api
            with self.assertRaises(qa.QaError):
                run.command('admin', 'x', '/v1/fagoo/commands', 'unit.save', {'name': 'QA'})
            run.command('admin', 'x', '/v1/fagoo/commands', 'unit.save', {'name': 'QA'})
            self.assertEqual(received[0], received[1])
            with self.assertRaisesRegex(qa.QaError, 'QA_COMMAND_PAYLOAD_CHANGED'):
                run.command('admin', 'x', '/v1/fagoo/commands', 'unit.save', {'name': 'different'})

    def test_api_phase_requires_https_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            run = qa.Run(Path(directory), self.config(), '123456789abc')
            with self.assertRaisesRegex(qa.QaError, 'QA_API_REQUIRES_HTTPS'):
                run.run_api()


if __name__ == '__main__':
    unittest.main()
