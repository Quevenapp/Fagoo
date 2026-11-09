"""Offline safety/coordination checks; never calls the homologation installation."""
import contextlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

import homologation_communication as qa

ROOT = Path(__file__).resolve().parents[2]


class CommunicationAcceptanceTests(unittest.TestCase):
    def test_browser_run_is_never_reused(self):
        for invalid in ('9e786a54cb21', 'not-a-run', '../private', 'A' * 12):
            with self.subTest(invalid=invalid), self.assertRaises(qa.qa.QaError):
                qa.validate_run(invalid)
        qa.validate_run('c74ca003ce10')

    def test_default_plan_never_reads_credentials_or_uses_transport(self):
        with patch.object(qa.sys, 'argv', ['qa', '--run-id', 'c74ca003ce10']), \
                patch.object(qa.qa, 'read_config') as config, patch.object(qa, 'D1') as d1, \
                patch.object(qa, 'CommunicationRun') as run, contextlib.redirect_stdout(io.StringIO()) as out:
            qa.main()
        config.assert_not_called()
        d1.assert_not_called()
        run.assert_not_called()
        plan = json.loads(out.getvalue())
        self.assertFalse(plan['executed'])
        self.assertEqual(plan['planned']['channel_connections'], 0)

    def test_external_sends_and_configuration_are_rejected_before_http(self):
        unit, conversation = str(uuid.uuid4()), str(uuid.uuid4())
        routes = [('/connections', {'kind': 'meta'}), ('/inbound', {}),
                  ('/conversations/' + conversation + '/actions', {'action': 'reply', 'text': 'never'}),
                  ('/conversations/' + conversation + '/actions', {'action': 'resume'})]
        with patch.object(qa.urllib.request, 'build_opener') as opener:
            for suffix, body in routes:
                with self.subTest(suffix=suffix, body=body), self.assertRaises(qa.qa.QaError):
                    qa.api_http(unit, suffix, 'synthetic', 'POST', body)
            opener.assert_not_called()

    def test_registered_external_effect_prevents_fixture_execution(self):
        empty = dict.fromkeys(('connections', 'webhooks', 'devices', 'bot_runs', 'router_routes', 'inbox'), 0)
        qa.assert_inert_counts(empty)
        for key in empty:
            with self.subTest(key=key), self.assertRaisesRegex(qa.qa.QaError, 'EXTERNAL_ROUTE_OR_WORK_FOUND'):
                qa.assert_inert_counts({**empty, key: 1})

    def test_claim_threads_overlap_and_double_success_is_not_accepted(self):
        entered = threading.Barrier(2, timeout=3)
        def send(command):
            entered.wait()
            return (200 if command == 'a' else 404, {})
        results = qa.race(send, ['a', 'b'])
        self.assertEqual(qa.race_winner(results), 0)
        for bad in ([(200, {}), (200, {})], [(404, {}), (409, {})], [(200, {}), (503, {})]):
            with self.assertRaisesRegex(qa.qa.QaError, 'RACE_NOT_EXCLUSIVE'):
                qa.race_winner(bad)

    def test_ambiguous_command_persists_same_actor_body_and_key(self):
        with tempfile.TemporaryDirectory() as directory:
            run = object.__new__(qa.CommunicationRun)
            run.path = Path(directory) / 'state.json'
            run.state = {'commands': {}}
            first = run.command('claim_a', 'operator_a', 'claim')
            self.assertEqual(json.loads(run.path.read_text())['commands']['claim_a'], first)
            self.assertEqual(run.command('claim_a', 'operator_a', 'claim'), first)
            with self.assertRaisesRegex(qa.qa.QaError, 'INTENT_CHANGED'):
                run.command('claim_a', 'operator_b', 'claim')

    def test_completed_run_does_not_login_or_create_another_fixture(self):
        run = object.__new__(qa.CommunicationRun)
        run.state = {'complete': True}
        run.prepare = Mock()
        with contextlib.redirect_stdout(io.StringIO()):
            run.execute()
        run.prepare.assert_not_called()

    def test_seed_and_inert_query_use_real_distributed_d1_schema(self):
        database = sqlite3.connect(':memory:')
        self.addCleanup(database.close)
        database.row_factory = sqlite3.Row
        for path in sorted((ROOT / 'workers/communication/migrations').glob('*.sql')):
            database.executescript(path.read_text(encoding='utf-8'))
        unit, foreign = str(uuid.uuid4()), str(uuid.uuid4())
        run = object.__new__(qa.CommunicationRun)
        run.run_id = 'c74ca003ce10'
        run.state = {'unit_id': unit, 'foreign_unit_id': foreign, 'conversation_id': str(uuid.uuid4()),
                     'message_id': str(uuid.uuid4()), 'checks': []}
        run.save = Mock()
        run.check = Mock()
        def query(sql, params=()):
            cursor = database.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]
        run.d1 = SimpleNamespace(query=query)
        accounts = {name: {'id': str(uuid.uuid4()), 'email': 'qa-' + run.run_id + '-' + name.replace('_', '-') + '@synthetic.invalid'}
                    for name in ('admin', 'operator_a', 'operator_b')}
        run.auth = SimpleNamespace(state={'accounts': accounts}, report={'checks': [{'name': 'auth_phase_complete'}]}, login=Mock())
        def command(actor, key, path, action, payload):
            if action == 'unit.save':
                identifier = unit if key.endswith('primary') else foreign
                database.execute("insert or ignore into profiles(id,name,created) values(?,?,1)", (identifier, payload['name']))
                return {'id': identifier}
            return {'ok': True}
        run.auth.command = command
        run.api = Mock(return_value={'data': []})
        run.prepare()
        row = dict(database.execute('select connection_id,phone,state,epoch,external_namespace from conversations').fetchone())
        self.assertEqual(row, {'connection_id': None, 'phone': None, 'state': 'waiting', 'epoch': 0, 'external_namespace': 'qa:c74ca003ce10'})
        self.assertEqual(database.execute('select count(*) from messages').fetchone()[0], 1)
        run.prepare()
        self.assertEqual(database.execute('select count(*) from conversations').fetchone()[0], 1)
        # A device registered for all profiles must also block outbound-proof claims.
        actor = accounts['operator_a']['id']
        database.execute("insert into users(id,email,name,password,role,created) values(?,?,?,'x','operator',1)", (actor, 'synthetic@invalid.test', 'QA'))
        database.execute("insert into devices(id,user_id,platform,token,profiles,created,updated) values('device',?,'android','synthetic','[]',1,1)", (actor,))
        with self.assertRaisesRegex(qa.qa.QaError, 'EXTERNAL_ROUTE_OR_WORK_FOUND'):
            run.inert()


if __name__ == '__main__':
    unittest.main()
