"""HTTPS queue acceptance using the existing synthetic Auth/CRM run.

Default: public version preflight only. --execute creates synthetic queues and
one HTTP-only device, never connects a physical printer or registers a recipient.
Run after homologation_auth_crm.py finishes; do not run the two tools together.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
import uuid

import homologation_auth_crm as authqa

require = authqa.require
QaError = authqa.QaError
CAPABILITIES = ['crm.read', 'crm.write', 'queue.read', 'queue.operate', 'ticket.issue']
DEVICE_CAPABILITIES = ['panel.read', 'ticket.issue', 'print.execute']


def api_http(path, method='GET', payload=None, token=None, device=False, allowed=(200,)):
    require(path.startswith(('/v1/queues/', '/v1/fagoo/', '/v1/communication/', '/v1/system/'))
            and not any(c in path for c in ('\r', '\n', '#')), 'QA_QUEUE_PATH_DENIED')
    headers = {'Accept': 'application/json', 'Origin': authqa.ORIGINS['FAGOO_WEB_ORIGIN'],
               'User-Agent': 'Fagoo-Homologation-QA/1.0'}
    if token:
        headers['Authorization'] = ('FagooDevice ' if device else 'Bearer ') + token
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(authqa.ORIGINS['FAGOO_API_ORIGIN'] + path,
                                     data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), authqa.NoRedirect())
    try:
        response = opener.open(request, timeout=35)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError:
        raise QaError('QA_QUEUE_HTTP_UNAVAILABLE') from None
    with response:
        status, raw = response.code, response.read(2_000_001)
    require(len(raw) <= 2_000_000, 'QA_QUEUE_HTTP_TOO_LARGE')
    require(status in allowed, 'QA_QUEUE_HTTP_STATUS_' + str(status))
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        raise QaError('QA_QUEUE_HTTP_INVALID_JSON') from None


def validate_actors(state, run_id):
    require(state.get('run_id') == run_id, 'QA_QUEUE_RUN_MISMATCH')
    for name in ('admin', 'operator_a', 'operator_b'):
        account = state.get('accounts', {}).get(name, {})
        require(account.get('email') == 'qa-' + run_id + '-' + name.replace('_', '-') + '@synthetic.invalid',
                'QA_QUEUE_ACTOR_NOT_SYNTHETIC')
        uuid.UUID(account['id'])
    require(state.get('unit_a') != state.get('unit_b'), 'QA_QUEUE_DISTINCT_UNITS_REQUIRED')
    for key in ('unit_a', 'unit_b'):
        uuid.UUID(state[key])


class QueueRun:
    def __init__(self, root, values, run_id):
        self.auth = authqa.Run(root, values, run_id, 'https')
        validate_actors(self.auth.state, run_id)
        self.directory = self.auth.directory
        self.path = self.directory / 'queues-state.json'
        self.report_path = self.directory / 'queues-report.json'
        self.state = {'run_id': run_id, 'commands': {}, 'checks': []}
        if self.path.exists():
            require(not self.path.is_symlink() and (os.name == 'nt' or self.path.stat().st_mode & 0o077 == 0),
                    'QA_QUEUE_STATE_NOT_PRIVATE')
            self.state = json.loads(self.path.read_text(encoding='utf-8'))
            require(self.state.get('run_id') == run_id, 'QA_QUEUE_RUN_MISMATCH')
        self.run_id = run_id
        self.units = {label: self.auth.state['unit_' + label] for label in ('a', 'b')}

    def save(self):
        authqa.save_private(self.path, self.state)

    def check(self, name, passed=True):
        require(passed, 'QA_QUEUE_ASSERT_' + name.upper())
        if name not in self.state['checks']:
            self.state['checks'].append(name)
        self.save()
        authqa.save_private(self.report_path, {
            'run_id': self.run_id, 'instance': 'fagoo-homolog', 'checks': self.state['checks'],
            'complete': self.state.get('complete', False), 'updated_at': datetime.now(timezone.utc).isoformat(),
            'limitations': ['HTTP synthetic device only; no physical printing, audio, push or WhatsApp.',
                            'Uncertain receipt acknowledged explicitly; lost-ACK timeout is a separate test.',
                            'HTTP concurrency checks outcomes; they do not measure database lock wait times.'],
        })
        print('PASS ' + name, flush=True)

    def api(self, actor, path, method='GET', payload=None, allowed=(200,)):
        token = self.state['device_token'] if actor == 'device' else self.auth.state['accounts'][actor]['session']['access_token']
        return api_http(path, method, payload, token, actor == 'device', allowed)

    def base(self, label='a'):
        return '/v1/queues/units/' + self.units[label]

    def intent(self, key, actor, path, kind, payload, identity=False):
        # Persist the exact request before sending; concurrent workers never write state.
        expected = {'actor': actor, 'path': path, 'kind': kind, 'payload': payload, 'identity': identity}
        if key not in self.state['commands']:
            self.state['commands'][key] = {**expected, 'command_id': str(uuid.uuid4())}
            self.save()
        saved = self.state['commands'][key]
        require({k: saved[k] for k in expected} == expected, 'QA_QUEUE_INTENT_CHANGED')
        return saved

    def send(self, intent, allowed=(200,)):
        body = {'command_id': intent['command_id'], 'action' if intent['identity'] else 'type': intent['kind'], 'payload': intent['payload']}
        return self.api(intent['actor'], intent['path'], 'POST', body, allowed)

    def command(self, key, actor, kind, payload, label='a', identity=False):
        path = '/v1/fagoo/commands' if identity else self.base(label) + '/commands'
        result = self.send(self.intent(key, actor, path, kind, payload, identity))
        require(identity or result.get('ok') is True, 'QA_QUEUE_COMMAND_FAILED')
        return result.get('result', result) if identity else result['result']

    def parallel(self, intents):
        with ThreadPoolExecutor(max_workers=12) as workers:
            return list(workers.map(self.send, intents))

    def prepare(self):
        require(any(c.get('name') == 'https_identity_crm_phase_complete' and c.get('status') == 'passed'
                    for c in self.auth.report.get('checks', [])), 'QA_QUEUE_API_CRM_PHASE_REQUIRED')
        for name in ('admin', 'operator_a', 'operator_b'):
            session = self.auth.login(name, elevate=name == 'admin')
            user = self.auth.auth('/user', token=session['access_token'])[1]
            require(user.get('user_metadata', {}).get('qa_run') == self.run_id, 'QA_QUEUE_ACTOR_MARKER_REQUIRED')
        setup = self.api('admin', '/v1/fagoo/setup')
        for label, unit_id in self.units.items():
            unit = next((u for u in setup['units'] if u['id'] == unit_id), {})
            require(unit.get('name') == 'QA ' + self.run_id + ' ' + label and unit.get('active') is True,
                    'QA_QUEUE_UNIT_NOT_SYNTHETIC')
        own_device = self.state.get('device_id')
        require(not any(d['active'] and d['unit_id'] in self.units.values() and d['id'] != own_device
                        for d in setup['devices']), 'QA_QUEUE_PHYSICAL_DEVICE_PRESENT')
        for device in setup['devices']:
            if device['id'] == own_device:
                require(device.get('name') == 'QA HTTP only ' + self.run_id and device.get('unit_id') == self.units['a']
                        and device.get('active') is True and set(device.get('capabilities', [])) == set(DEVICE_CAPABILITIES),
                        'QA_QUEUE_SYNTHETIC_DEVICE_CHANGED')
        for label, unit_id in self.units.items():
            member_id = self.auth.state['accounts']['operator_' + label]['id']
            member = next((m for m in setup['members'] if m['user_id'] == member_id), {})
            require(member.get('role') == 'operacao' and member.get('active') is True, 'QA_QUEUE_OPERATOR_ROLE_CHANGED')
            membership = next((u for u in member.get('units', []) if u['unit_id'] == unit_id), {})
            require(set(membership.get('capabilities', [])) in (set(CAPABILITIES), {'crm.read', 'crm.write'})
                    and membership.get('team_ids') == [], 'QA_QUEUE_MEMBER_CHANGED')
            self.command('member_' + label, 'admin', 'member.save', {'unit_id': unit_id, 'user_id': member_id,
                         'capabilities': CAPABILITIES, 'team_ids': []}, identity=True)
        self.check('synthetic_actors_units_and_no_physical_devices')

    def execute(self):
        if self.state.get('complete'):
            print('Already complete; preserved previous acceptance report.', flush=True)
            return
        self.prepare()
        queues = {}
        for label in ('a', 'b'):
            queues[label] = self.command('queue_' + label, 'admin', 'queue.save', {
                'name': 'QA HTTP ' + self.run_id + ' ' + label, 'prefix': 'QA' if label == 'a' else 'QB',
                'regulars_per_priority': 1, 'active': True}, label)['queue']['id']
        issue_path = self.base() + '/commands'
        intents = [self.intent('issue_' + str(n), 'operator_a', issue_path, 'ticket.issue',
                              {'queue_id': queues['a'], 'print': False}) for n in range(12)]
        issued = self.parallel(intents)
        require(all(r.get('ok') is True for r in issued), 'QA_QUEUE_ISSUANCE_FAILED')
        tickets = [r['result']['ticket'] for r in issued]
        self.check('twelve_concurrent_numbers_unique_contiguous', sorted(t['number'] for t in tickets) == list(range(1, 13))
                   and len({t['id'] for t in tickets}) == 12 and len({r['revision'] for r in issued}) == 12)
        same = self.intent('same_issue', 'operator_a', issue_path, 'ticket.issue', {'queue_id': queues['a'], 'print': False})
        replays = self.parallel([same] * 12)
        require(replays[0].get('ok') is True, 'QA_QUEUE_REPLAY_FAILED')
        self.check('twelve_same_id_one_ticket_one_receipt', all(r == replays[0] for r in replays)
                   and replays[0]['result']['ticket']['number'] == 13)
        receipt = self.api('operator_a', self.base() + '/receipts/' + same['command_id'])
        self.check('receipt_recovers_committed_command', receipt.get('status') == 'confirmed' and receipt['response'] == replays[0])
        changed = {**same, 'payload': {**same['payload'], 'priority': True}}
        self.send(changed, allowed=(400, 409))
        self.check('same_id_different_payload_rejected')
        self.api('operator_a', self.base('b') + '/snapshot', allowed=(403,))
        self.api('operator_b', self.base() + '/commands', 'POST', {
            'command_id': same['command_id'], 'type': same['kind'], 'payload': same['payload']}, allowed=(403,))
        self.check('cross_unit_read_write_denied')
        b = self.command('other_unit_issue', 'operator_b', 'ticket.issue', {'queue_id': queues['b'], 'print': False}, 'b')['ticket']
        self.check('other_unit_counter_independent', b['number'] == 1 and b['id'] not in {t['id'] for t in tickets})
        calls = [self.intent('call_' + str(n), 'operator_a', issue_path, 'ticket.call_next',
                            {'desk': 'QA ' + str(n), 'queue_ids': [queues['a']]}) for n in range(16)]
        results = self.parallel(calls)
        called = [r for r in results if r.get('ok')]
        expected = {t['id'] for t in tickets} | {replays[0]['result']['ticket']['id']}
        self.check('concurrent_calls_take_each_ticket_once', len(called) == 13
                   and {r['result']['ticket']['id'] for r in called} == expected
                   and all(r.get('ok') or r.get('error', {}).get('code') == 'queue_empty' for r in results))
        self.device_checks(queues['a'])
        events = self.api('operator_a', self.base() + '/events?after=0')
        revisions = [e['revision'] for e in events['events']]
        self.check('committed_revision_cursor_unique_ordered', revisions == sorted(set(revisions))
                   and events['cursor'] <= events['revision'])
        self.state['complete'] = True
        self.check('https_queues_acceptance_complete')

    def device_checks(self, queue_id):
        if 'device_id' not in self.state:
            self.state['device_id'] = str(uuid.uuid4())
            self.save()
        device_id = self.state['device_id']
        self.command('device_save', 'admin', 'device.save', {'id': device_id, 'unit_id': self.units['a'],
                     'name': 'QA HTTP only ' + self.run_id, 'capabilities': DEVICE_CAPABILITIES}, identity=True)
        if 'device_token' not in self.state:
            issued = self.command('device_issue', 'admin', 'device.issue', {'id': device_id}, identity=True)
            require(re.fullmatch('fgd_[a-f0-9]{64}', issued.get('token', '')), 'QA_QUEUE_DEVICE_TOKEN_UNCERTAIN_REQUIRES_EXPLICIT_ROTATION')
            self.state['device_token'] = issued['token']
            self.save()
        context = self.api('device', '/v1/fagoo/device')
        require(context.get('id') == device_id and context.get('unit_id') == self.units['a'], 'QA_QUEUE_DEVICE_IDENTITY')
        public = self.api('device', self.base() + '/snapshot')
        self.check('device_snapshot_redacted', public.get('effects') == [] and public.get('devices') == []
                   and all(not {'phone', 'public_token', 'operator_user_id', 'operator_device_id', 'reason'} & set(t)
                           for t in public['tickets']))
        for path in ['/v1/fagoo/setup', '/v1/fagoo/context', self.base('b') + '/snapshot',
                     '/v1/communication/units/' + self.units['a'] + '/internal-chats',
                     '/v1/communication/units/' + self.units['a'] + '/team',
                     '/v1/communication/units/' + self.units['a'] + '/conversations']:
            self.api('device', path, allowed=(403,))
        self.check('device_has_no_people_chat_whatsapp_or_other_unit')
        printed = self.command('print_issue', 'operator_a', 'ticket.issue', {
            'queue_id': queue_id, 'print': True, 'print_device_id': device_id})
        job_id = printed['print_job_id']
        require(bool(job_id), 'QA_QUEUE_PRINT_JOB_MISSING')
        if 'print_claim' not in self.state:
            if 'claim_ids' not in self.state:
                self.state['claim_ids'] = [str(uuid.uuid4()) for _ in range(8)]
                self.save()
            def claim(claim_id):
                return self.api('device', self.base() + '/effects/claim', 'POST',
                                {'kind': 'print', 'claim_id': claim_id, 'after_revision': 0})
            with ThreadPoolExecutor(max_workers=8) as workers:
                claimed = list(workers.map(claim, self.state['claim_ids']))
            jobs = [job for response in claimed for job in response.get('jobs', [])]
            require(len(jobs) == 1 and jobs[0]['id'] == job_id, 'QA_QUEUE_CLAIM_UNCERTAIN_REQUIRES_INSPECTION')
            self.state['print_claim'] = {'job_id': job_id, 'claim_id': jobs[0]['claim_id'], 'result': 'incerto'}
            self.save()
        self.check('concurrent_print_claim_exactly_one_executor')
        ack = self.state['print_claim']
        require(ack['job_id'] == job_id, 'QA_QUEUE_PRINT_JOB_CHANGED')
        result = self.api('device', self.base() + '/effects/ack', 'POST', ack)
        replay = self.api('device', self.base() + '/effects/ack', 'POST', ack)
        self.check('uncertain_print_ack_idempotent', result == replay and result.get('status') == 'uncertain')
        for claim_id in [ack['claim_id'], str(uuid.uuid4())]:
            result = self.api('device', self.base() + '/effects/claim', 'POST', {'kind': 'print', 'claim_id': claim_id, 'after_revision': 0})
            require(result.get('jobs') == [], 'QA_QUEUE_UNCERTAIN_PRINT_REPLAYED')
        snapshot = self.api('operator_a', self.base() + '/snapshot')
        self.check('uncertain_print_never_requeued', any(j['id'] == job_id and j['status'] == 'uncertain' for j in snapshot['effects']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=authqa.ROOT)
    parser.add_argument('--run-id', default='9e786a54cb21')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch('[a-f0-9]{12}', args.run_id), 'QA_RUN_ID_INVALID')
    values = authqa.read_config(args.root)
    run = QueueRun(args.root, values, args.run_id)
    version = api_http('/v1/system/version')
    require(version.get('version', '').lstrip('v').startswith('1.0.'), 'QA_QUEUE_VERSION_NOT_READY')
    if args.execute:
        lock = run.directory / 'queues.lock'
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            raise QaError('QA_QUEUE_LOCK_REQUIRES_INSPECTION') from None
        try:
            run.execute()
        finally:
            lock.rmdir()
    print(json.dumps({'run_id': args.run_id, 'executed': args.execute, 'report': str(run.report_path)}))


if __name__ == '__main__':
    try:
        main()
    except (QaError, KeyError, ValueError, OSError) as error:
        print(str(error) if isinstance(error, QaError) else 'QA_QUEUE_FAILED_' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
