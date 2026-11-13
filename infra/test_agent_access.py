import hashlib
import importlib.util
import io
import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('agent_access', Path(__file__).with_name('agent-access.py'))
AGENTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AGENTS)

AGENT = '10000000-0000-4000-8000-000011130001'
TOKEN_ID = '20000000-0000-4000-8000-000011130001'


class Response(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(json.dumps(body).encode())
        self.status = status


class AgentAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = Path(self.temp.name) / '.env'
        self.env.write_text('FAGOO_LOCAL_PORT=8000\nSERVICE_ROLE_KEY=synthetic-service-key\n', encoding='utf-8')
        self.sql = []
        self.requests = []

    def run_sql(self, env_file, project, sql, variables=None):
        self.sql.append((sql, variables or {}))
        if 'to_regprocedure' in sql:
            return 't'
        if 'agent_token_revoke' in sql:
            return 't'
        return '\n' + TOKEN_ID

    def auth(self, status=200, body=None):
        def request(req, timeout):
            self.requests.append(req)
            return Response(status, body or {'id': AGENT})
        return request

    def test_tokens_have_the_worker_format_and_only_their_hash_is_kept(self):
        token, digest, hint = AGENTS.new_token()
        self.assertRegex(token, r'\Afagoo_agt_[A-Za-z0-9_-]{43}\Z')
        self.assertEqual(digest, hashlib.sha256(token.encode()).hexdigest())
        self.assertEqual(hint, token[-4:])
        self.assertNotEqual(token, AGENTS.new_token()[0])

    def test_expiry_is_bounded_and_optional(self):
        now = datetime(2026, 11, 13, tzinfo=timezone.utc)
        self.assertEqual(AGENTS.expiry(None), '')
        self.assertEqual(AGENTS.expiry(90, now), '2027-02-11T00:00:00+00:00')
        for invalid in (0, -1, 3651, '90', 1.5, True):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'AGENT_INPUT_INVALID'):
                AGENTS.expiry(invalid)

    def test_create_makes_a_passwordless_banned_account_then_registers_and_issues_in_one_transaction(self):
        result = AGENTS.create(self.env, 'fagoo', 'Hermes', 'consulta', 90, request_impl=self.auth(), run=self.run_sql)
        self.assertEqual((result['agent'], result['token_id']), (AGENT, TOKEN_ID))
        request = self.requests[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8000/auth/v1/admin/users')
        self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-service-key')
        payload = json.loads(request.data)
        self.assertNotIn('password', payload)
        self.assertRegex(payload['email'], r'\Aagente-[0-9a-f-]{36}@agentes\.fagoo\.invalid\Z')
        self.assertEqual((payload['ban_duration'], payload['email_confirm']), ('876000h', True))
        sql, variables = self.sql[-1]
        self.assertTrue(sql.startswith('begin;') and sql.rstrip().endswith('commit;'))
        self.assertIn('agent_register', sql)
        self.assertIn('agent_token_issue', sql)
        self.assertEqual(variables['hash'], hashlib.sha256(result['token'].encode()).hexdigest())
        self.assertEqual((variables['agent'], variables['name'], variables['role']), (AGENT, 'Hermes', 'consulta'))
        # Neither the token nor any value appears in the SQL text: values are psql variables.
        serialized = json.dumps(self.sql)
        self.assertNotIn(result['token'], serialized)
        self.assertNotIn('Hermes', sql)

    def test_create_refuses_invalid_input_before_touching_auth(self):
        for name, role, days in (('', 'consulta', 90), (' Hermes', 'consulta', 90), ('x' * 121, 'consulta', 90), ('a\nb', 'consulta', 90),
                                 ('Hermes', 'admin', 90), ('Hermes', 'financeiro', 90), ('Hermes', 'consulta', 0)):
            with self.subTest(name=name, role=role, days=days), self.assertRaisesRegex(ValueError, 'AGENT_INPUT_INVALID'):
                AGENTS.create(self.env, 'fagoo', name, role, days, request_impl=self.auth(), run=self.run_sql)
        self.assertEqual(self.requests, [])

    def test_create_stops_when_the_schema_or_auth_is_not_ready(self):
        with self.assertRaisesRegex(ValueError, 'AGENT_SCHEMA_NOT_READY'):
            AGENTS.create(self.env, 'fagoo', 'Hermes', 'consulta', 90, request_impl=self.auth(), run=lambda *a, **k: 'f')
        self.assertEqual(self.requests, [])
        with self.assertRaisesRegex(ValueError, 'AGENT_AUTH_CREATION_FAILED'):
            AGENTS.create(self.env, 'fagoo', 'Hermes', 'consulta', 90, request_impl=self.auth(status=422), run=self.run_sql)

    def test_a_failed_registration_names_the_orphan_account(self):
        def failing(env_file, project, sql, variables=None):
            if 'to_regprocedure' in sql:
                return 't'
            raise ValueError('AGENT_DATABASE_OPERATION_FAILED')
        with self.assertRaisesRegex(ValueError, 'AGENT_NOT_REGISTERED:' + AGENT):
            AGENTS.create(self.env, 'fagoo', 'Hermes', 'consulta', None, request_impl=self.auth(), run=failing)

    def test_issue_and_revoke_validate_identifiers(self):
        issued = AGENTS.issue(self.env, 'fagoo', AGENT, None, run=self.run_sql)
        self.assertEqual((issued['token_id'], issued['expires'], self.sql[-1][1]['expires']), (TOKEN_ID, '', ''))
        self.assertTrue(AGENTS.revoke(self.env, 'fagoo', TOKEN_ID, run=self.run_sql))
        self.assertEqual(self.sql[-1][1], {'token': TOKEN_ID})
        for invalid in ('x', '', "'; drop table erp_access.agent; --", None):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'AGENT_INPUT_INVALID'):
                AGENTS.issue(self.env, 'fagoo', invalid, None, run=self.run_sql)
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'AGENT_INPUT_INVALID'):
                AGENTS.revoke(self.env, 'fagoo', invalid, run=self.run_sql)


if __name__ == '__main__':
    unittest.main()
