"""Offline checks for the real HTTP acceptance runner; no external transport."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

import homologation_queues as qa


class QueueAcceptanceRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.run = object.__new__(qa.QueueRun)
        self.run.run_id = '9e786a54cb21'
        self.run.directory = Path(self.temp.name)
        self.run.path = self.run.directory / 'queues-state.json'
        self.run.report_path = self.run.directory / 'queues-report.json'
        self.run.state = {'run_id': self.run.run_id, 'commands': {}, 'checks': []}
        self.run.units = {'a': str(uuid.uuid4()), 'b': str(uuid.uuid4())}
        accounts = {name: {'id': str(uuid.uuid4()), 'email': 'qa-' + self.run.run_id + '-' + name.replace('_', '-') + '@synthetic.invalid'}
                    for name in ('admin', 'operator_a', 'operator_b')}
        self.run.auth = SimpleNamespace(state={'run_id': self.run.run_id, 'accounts': accounts,
            'unit_a': self.run.units['a'], 'unit_b': self.run.units['b']})

    def test_actor_guard_rejects_real_account_and_other_run(self):
        qa.validate_actors(self.run.auth.state, self.run.run_id)
        for change in ({'run_id': 'aaaaaaaaaaaa'}, {'accounts': {**self.run.auth.state['accounts'],
                      'admin': {'id': str(uuid.uuid4()), 'email': 'real@example.test'}}}):
            with self.assertRaises(qa.QaError):
                qa.validate_actors({**self.run.auth.state, **change}, self.run.run_id)

    def test_path_guard_refuses_external_url_before_http(self):
        with patch.object(qa.urllib.request, 'build_opener') as opener:
            with self.assertRaisesRegex(qa.QaError, 'PATH_DENIED'):
                qa.api_http('https://demo.fagoo.com.br/v1/queues')
            opener.assert_not_called()

    def test_default_preflight_never_logs_in_or_mutates(self):
        runner = Mock(report_path=Path('private/report.json'))
        with patch.object(qa.sys, 'argv', ['homologation_queues.py']), patch.object(qa.authqa, 'read_config', return_value={}), \
                patch.object(qa, 'QueueRun', return_value=runner), patch.object(qa, 'api_http', return_value={'version': '1.0.0'}) as http, contextlib.redirect_stdout(io.StringIO()):
            qa.main()
        runner.execute.assert_not_called()
        http.assert_called_once_with('/v1/system/version')

    def test_ambiguous_retry_keeps_same_command_before_sending(self):
        run = self.run
        intent = run.intent('issue', 'operator_a', run.base() + '/commands', 'ticket.issue', {'queue_id': str(uuid.uuid4()), 'print': False})
        observed = []
        def api(actor, path, method, payload, allowed):
            saved = json.loads(run.path.read_text(encoding='utf-8'))
            self.assertEqual(saved['commands']['issue']['command_id'], payload['command_id'])
            observed.append(copy.deepcopy(payload))
            if len(observed) == 1:
                raise qa.QaError('QA_QUEUE_HTTP_UNAVAILABLE')
            return {'ok': True}
        run.api = api
        with self.assertRaises(qa.QaError):
            run.send(intent)
        run.send(intent)
        self.assertEqual(observed[0], observed[1])
        with self.assertRaisesRegex(qa.QaError, 'INTENT_CHANGED'):
            run.intent('issue', 'operator_a', intent['path'], 'ticket.issue', {'queue_id': str(uuid.uuid4()), 'print': False})

    def test_twelve_requests_really_overlap_and_reuse_given_id(self):
        barrier = threading.Barrier(12, timeout=5)
        same = {'command_id': str(uuid.uuid4())}
        def send(intent):
            barrier.wait()
            return intent['command_id']
        self.run.send = send
        self.assertEqual(self.run.parallel([same] * 12), [same['command_id']] * 12)

    def test_external_device_prevents_membership_changes(self):
        run = self.run
        run.auth.report = {'checks': [{'name': 'https_identity_crm_phase_complete', 'status': 'passed'}]}
        run.auth.login = lambda *args, **kwargs: {'access_token': 'synthetic'}
        run.auth.auth = lambda *args, **kwargs: (200, {'user_metadata': {'qa_run': run.run_id}})
        setup = {'units': [{'id': unit, 'name': 'QA ' + run.run_id + ' ' + label, 'active': True}
                           for label, unit in run.units.items()],
                 'devices': [{'active': True, 'id': str(uuid.uuid4()), 'unit_id': run.units['a']}], 'members': []}
        run.api = Mock(return_value=setup)
        run.command = Mock()
        with self.assertRaisesRegex(qa.QaError, 'PHYSICAL_DEVICE_PRESENT'):
            run.prepare()
        run.command.assert_not_called()

    def effect_fixture(self, replay_unknown=False):
        run = self.run
        job = str(uuid.uuid4())
        physical = {'claimed': False, 'uncertain': False, 'claims': 0}
        mutex = threading.Lock()
        def command(key, actor, kind, payload, *args, **kwargs):
            if kind == 'device.save':
                self.assertEqual(payload['capabilities'], qa.DEVICE_CAPABILITIES)
                self.assertNotIn('audio.execute', payload['capabilities'])
                return {'id': payload['id']}
            if kind == 'device.issue':
                return {'token': 'fgd_' + 'a' * 64}
            self.assertEqual(kind, 'ticket.issue')
            self.assertNotIn('phone', payload)
            self.assertEqual(payload['print_device_id'], run.state['device_id'])
            return {'print_job_id': job}
        def api(actor, path, method='GET', payload=None, allowed=(200,)):
            if allowed == (403,):
                self.assertEqual(actor, 'device')
                return {'error': {'code': 'ERP_FORBIDDEN'}}
            if path == '/v1/fagoo/device':
                return {'id': run.state['device_id'], 'unit_id': run.units['a']}
            if path.endswith('/snapshot'):
                return {'effects': [] if actor == 'device' else [{'id': job, 'status': 'uncertain'}], 'devices': [], 'tickets': []}
            if path.endswith('/effects/claim'):
                with mutex:
                    physical['claims'] += 1
                    available = not physical['claimed'] or (physical['uncertain'] and replay_unknown)
                    physical['claimed'] = True
                    return {'jobs': [{'id': job, 'claim_id': payload['claim_id']}] if available else []}
            self.assertTrue(path.endswith('/effects/ack'))
            self.assertEqual(payload['result'], 'incerto')
            physical['uncertain'] = True
            return {'id': job, 'status': 'uncertain', 'result': 'incerto'}
        run.command, run.api = command, api
        return physical

    def test_unknown_print_is_terminal_and_http_only(self):
        fixture = self.effect_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            self.run.device_checks(str(uuid.uuid4()))
        self.assertEqual(fixture['claims'], 10)
        self.assertIn('uncertain_print_never_requeued', self.run.state['checks'])
        public_report = self.run.report_path.read_text(encoding='utf-8')
        self.assertNotIn(self.run.state['device_token'], public_report)

    def test_requeued_unknown_effect_fails_acceptance(self):
        self.effect_fixture(replay_unknown=True)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(qa.QaError, 'UNCERTAIN_PRINT_REPLAYED'):
            self.run.device_checks(str(uuid.uuid4()))


if __name__ == '__main__':
    unittest.main()
