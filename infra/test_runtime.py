import base64
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
import unittest

from configure import configure, origin
from migrate import migration, program, ROOT


class ConfigurationTests(unittest.TestCase):
    def test_private_configuration_is_unique_and_cannot_overwrite_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            result = configure(path, 'https://erp.example.test', 'https://backend.example.test', 'https://api.example.test')
            self.assertGreaterEqual(len(result['POSTGRES_PASSWORD']), 64)
            for field, role in [('ANON_KEY', 'anon'), ('SERVICE_ROLE_KEY', 'service_role')]:
                header, body, signature = result[field].split('.')
                payload = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
                self.assertEqual(payload['role'], role)
                expected = hmac.new(result['JWT_SECRET'].encode(), (header + '.' + body).encode(), hashlib.sha256).digest()
                self.assertEqual(expected, base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)))
            before = path.read_bytes()
            frontend = path.with_name('frontend.env').read_text()
            self.assertIn('VITE_SUPABASE_DEPLOYMENT=self-hosted', frontend)
            self.assertIn(result['ANON_KEY'], frontend)
            for secret in ['JWT_SECRET', 'POSTGRES_PASSWORD', 'SERVICE_ROLE_KEY']:
                self.assertNotIn(result[secret], frontend)
            with self.assertRaises(FileExistsError):
                configure(path, 'https://erp.example.test', 'https://backend.example.test', 'https://api.example.test')
            self.assertEqual(path.read_bytes(), before)

    def test_existing_frontend_configuration_does_not_leave_partial_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            public = path.with_name('frontend.env')
            public.write_text('existing')
            with self.assertRaises(FileExistsError):
                configure(path, 'https://erp.example.test', 'https://backend.example.test', 'https://api.example.test')
            self.assertFalse(path.exists())
            self.assertEqual(public.read_text(), 'existing')

    def test_only_canonical_public_https_origins_are_accepted(self):
        for invalid in ['http://backend.example.test', 'https://localhost', 'https://127.0.0.1', 'https://u:p@backend.example.test', 'https://backend.example.test:443', 'https://backend.example.test/', 'https://backend.example.test?q=1', 'https://backend.example.test#fragment']:
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                origin(invalid)


class SchemaTests(unittest.TestCase):
    def test_every_original_migration_can_join_an_atomic_ledger_transaction(self):
        paths = sorted((ROOT / 'supabase/migrations').glob('*.sql'))
        self.assertEqual(len(paths), 311)
        self.assertEqual(len({migration(path)[0] for path in paths}), len(paths))
        sql = program(ROOT / 'supabase/migrations')
        self.assertEqual(sql.count('insert into fagoo_system.schema_migration(version,sha256)'), len(paths))
        self.assertIn('FAGOO_SCHEMA_VERSION_OR_HASH_CONFLICT', sql)
        self.assertIn('FAGOO_SCHEMA_LEDGER_GAP', sql)
        self.assertIn('FAGOO_RUNTIME_SCHEMAS_NOT_READY', sql)

    def test_missing_wrapper_or_psql_meta_commands_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '202611020001_invalid.sql'
            for body in ['create table x(id int);', 'begin;\n\\! echo unsafe\ncommit;']:
                path.write_text(body)
                with self.assertRaises(ValueError):
                    migration(path)

    def test_line_endings_do_not_create_a_different_release_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '202611020001_example.sql'
            path.write_bytes(b'-- schema only\nbegin;\ncreate table x(id int);\ncommit;\n')
            expected = migration(path)
            path.write_bytes(path.read_bytes().replace(b'\n', b'\r\n'))
            self.assertEqual(migration(path), expected)

    def test_sql_literal_carriage_return_is_not_changed_to_newline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '202611020001_literal.sql'
            path.write_bytes(b"begin;\nselect replace('example',E'\r','');\ncommit;\n")
            self.assertIn("E'\r'", migration(path)[2])


if __name__ == '__main__':
    unittest.main()
