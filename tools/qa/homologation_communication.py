"""Reviewed HTTPS communication race, exclusively in fagoo-homolog.

Default: report the concrete plan without any network request. --execute creates
dedicated synthetic users/units and a channel-free D1 fixture. --retire disables
only that fixture's units and memberships; it preserves receipts and R2 evidence.
Never reuse the browser/Auth/CRM run or connect a real provider.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

import homologation_auth_crm as qa

ACCOUNT = 'd534038b992cdfbb065cb97a81442afc'
ZONE = '7b7a1b39964797b972f25e4777fce738'
PROTECTED_RUNS = {'9e786a54cb21'}
CAPABILITIES = ['communication.read', 'communication.claim', 'communication.reply', 'communication.transfer']
PURPOSE = 'fagoo-https-communication-race-v1'


def validate_run(run_id):
    qa.require(re.fullmatch('[a-f0-9]{12}', run_id) and run_id not in PROTECTED_RUNS,
               'QA_COMM_DEDICATED_RUN_REQUIRED')


def api_http(unit, suffix, token, method='GET', body=None, key=None, raw=False, content_type=None):
    unit = str(uuid.UUID(unit))
    qa.require(suffix.startswith('/') and not any(c in suffix for c in ('\r', '\n', '#', '://')),
               'QA_COMM_PATH_DENIED')
    if method == 'GET':
        qa.require(re.fullmatch(r'/(?:queue|events\?after=[0-9]+|conversations/[a-f0-9-]{36}|media/[a-f0-9-]+/content)', suffix),
                   'QA_COMM_READ_ROUTE_DENIED')
    elif method == 'POST':
        if suffix == '/media':
            qa.require(isinstance(body, bytes) and str(content_type).startswith('multipart/form-data; boundary=fagoo-qa-'),
                       'QA_COMM_UPLOAD_REQUIRED')
        else:
            qa.require(re.fullmatch(r'/conversations/[a-f0-9-]{36}/actions', suffix)
                       and isinstance(body, dict) and body.get('action') in ('claim', 'tags', 'transfer'),
                       'QA_COMM_EXTERNAL_ACTION_DENIED')
    else:
        raise qa.QaError('QA_COMM_METHOD_DENIED')
    headers = {'Authorization': 'Bearer ' + token, 'Origin': qa.ORIGINS['FAGOO_WEB_ORIGIN'],
               'User-Agent': 'Fagoo-Homologation-QA/1.0', 'Accept': '*/*' if raw else 'application/json'}
    if key:
        headers['Idempotency-Key'] = str(uuid.UUID(key))
    data = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = content_type or 'application/json'
    request = urllib.request.Request(qa.ORIGINS['FAGOO_API_ORIGIN'] + '/v1/communication/units/' + unit + suffix,
                                     method=method, data=data, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), qa.NoRedirect())
    try:
        response = opener.open(request, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError:
        raise qa.QaError('QA_COMM_HTTP_UNKNOWN_USE_SAME_COMMAND') from None
    with response:
        status, data = response.code, response.read(2_000_001)
    qa.require(len(data) <= 2_000_000, 'QA_COMM_RESPONSE_TOO_LARGE')
    if raw:
        return status, data
    try:
        return status, json.loads(data) if data else None
    except ValueError:
        raise qa.QaError('QA_COMM_INVALID_RESPONSE') from None


def private_path(root, path):
    path = Path(path).absolute()
    qa.require(not path.is_symlink() and path.resolve().is_relative_to((root / 'private').resolve()),
               'QA_COMM_PRIVATE_PATH_DENIED')
    qa.require(path.is_file() and (os.name == 'nt' or path.stat().st_mode & 0o077 == 0),
               'QA_COMM_PRIVATE_FILE_REQUIRED')
    return path


class D1:
    def __init__(self, root, values, credentials_file):
        self.runtime = runpy.run_path(str(root / 'infra/communication_runtime.py'))
        credential = runpy.run_path(str(root / 'infra/update_config.py'))['cloudflare_credentials']
        self.credentials = credential(private_path(root, credentials_file), ACCOUNT, ZONE)
        path = private_path(root, root / 'private/install/communication.json')
        state = self.runtime['read_state'](path, values, ACCOUNT)
        qa.require(state and all(state[k] == v for k, v in self.runtime['names'](values).items()),
                   'QA_COMM_LEGACY_OR_OTHER_RESOURCES_DENIED')
        self.database_id = str(uuid.UUID(state['database_id']))

    def query(self, sql, params=()):
        result = self.runtime['cloudflare']('POST', f'/accounts/{ACCOUNT}/d1/database/{self.database_id}/query',
            self.credentials['token'], {'sql': sql, 'params': list(params)}, ip_family=self.credentials.get('ip_family'))
        qa.require(isinstance(result, list) and len(result) == 1 and result[0].get('success') is True,
                   'QA_COMM_D1_QUERY_FAILED')
        return result[0].get('results', [])


def assert_inert_counts(row):
    qa.require(row and all(row.get(k) == 0 for k in
        ('connections', 'webhooks', 'devices', 'bot_runs', 'router_routes', 'inbox')),
        'QA_COMM_EXTERNAL_ROUTE_OR_WORK_FOUND')


def race(send, commands):
    barrier = threading.Barrier(2, timeout=10)
    def invoke(command):
        barrier.wait()
        return send(command)
    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(invoke, commands))


def race_winner(results):
    winners = [i for i, result in enumerate(results) if result[0] == 200]
    qa.require(len(winners) == 1 and results[1 - winners[0]][0] in (403, 404, 409),
               'QA_COMM_RACE_NOT_EXCLUSIVE')
    return winners[0]


class CommunicationRun:
    def __init__(self, root, values, run_id, d1):
        validate_run(run_id)
        self.root, self.run_id, self.d1 = root, run_id, d1
        self.directory = root / 'private/qa' / run_id
        self.path = self.directory / 'communication-state.json'
        self.report_path = self.directory / 'communication-report.json'
        qa.require(self.path.exists() or not (self.directory / 'credentials.json').exists(),
                   'QA_COMM_EXISTING_OTHER_RUN_DENIED')
        self.state = {'purpose': PURPOSE, 'run_id': run_id, 'commands': {}, 'checks': [],
                      'conversation_id': str(uuid.uuid4()), 'message_id': str(uuid.uuid4()),
                      'attachment_message_id': str(uuid.uuid4()), 'stale_outbox_id': str(uuid.uuid4())}
        if self.path.exists():
            self.state = json.loads(private_path(root, self.path).read_text())
            qa.require(self.state.get('purpose') == PURPOSE and self.state.get('run_id') == run_id,
                       'QA_COMM_RUN_PURPOSE_DENIED')
        else:
            self.save()
        self.auth = qa.Run(root, values, run_id, 'https')

    def save(self):
        qa.save_private(self.path, self.state)

    def check(self, name, condition=True):
        qa.require(condition, 'QA_COMM_ASSERT_' + name.upper())
        if name not in self.state['checks']:
            self.state['checks'].append(name)
        self.save()
        qa.save_private(self.report_path, {'run_id': self.run_id, 'purpose': PURPOSE,
            'instance': 'fagoo-homolog', 'checks': self.state['checks'],
            'complete': self.state.get('complete', False), 'retired': self.state.get('retired', False),
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'limitations': ['Synthetic channel-free conversation; no provider/Hermes call or outbound message.',
                'Stale AI delivery is an epoch-fenced synthetic outbox entry, not an external AI completion.',
                'Cloud race checks exclusive ownership; it does not measure lock scheduling.',
                'Retirement preserves synthetic history, media bytes and receipts for review.']})
        print('PASS ' + name, flush=True)

    def token(self, actor):
        return self.auth.state['accounts'][actor]['session']['access_token']

    def api(self, actor, suffix, method='GET', body=None, key=None, allowed=(200,), **options):
        result = api_http(self.state['unit_id'], suffix, self.token(actor), method, body, key, **options)
        qa.require(result[0] in allowed, 'QA_COMM_HTTP_STATUS_' + str(result[0]))
        return result[1]

    def command(self, name, actor, action, payload=None):
        expected = {'actor': actor, 'body': {'action': action, **(payload or {})}}
        if name not in self.state['commands']:
            self.state['commands'][name] = {**expected, 'key': str(uuid.uuid4())}
            self.save()
        saved = self.state['commands'][name]
        qa.require(saved['actor'] == actor and saved['body'] == expected['body'], 'QA_COMM_INTENT_CHANGED')
        return saved

    def send(self, command):
        return api_http(self.state['unit_id'], '/conversations/' + self.state['conversation_id'] + '/actions',
                        self.token(command['actor']), 'POST', command['body'], command['key'])

    def inert(self):
        unit = self.state['unit_id']
        row = self.d1.query("SELECT (SELECT count(*) FROM connections WHERE profile_id=?) connections,"
            "(SELECT count(*) FROM webhook_subscriptions WHERE profile_id=?) webhooks,"
            "(SELECT count(*) FROM devices WHERE enabled=1 AND (json_array_length(profiles)=0 OR EXISTS(SELECT 1 FROM json_each(profiles) WHERE value=?))) devices,"
            "(SELECT count(*) FROM bot_runs WHERE profile_id=?) bot_runs,"
            "(SELECT count(*) FROM fagoo_queue_routes WHERE profile_id=?) router_routes,"
            "(SELECT count(*) FROM inbox WHERE profile_id=?) inbox", [unit] * 6)[0]
        assert_inert_counts(row)

    def prepare(self):
        qa.require(not self.state.get('retired'), 'QA_COMM_RUN_ALREADY_RETIRED')
        runtime = self.d1.query('SELECT pause_outbound FROM fagoo_runtime WHERE id=1')
        qa.require(len(runtime) == 1 and runtime[0]['pause_outbound'] == 0, 'QA_COMM_RUNTIME_PAUSED')
        if not any(check.get('name') == 'auth_phase_complete' for check in self.auth.report['checks']):
            self.auth.run_auth()  # Brand-new private QA administrator; never the browser account.
        else:
            for name in ('admin', 'operator_a', 'operator_b'):
                account = self.auth.state['accounts'][name]
                qa.require(account['email'] == 'qa-' + self.run_id + '-' + name.replace('_', '-') + '@synthetic.invalid',
                           'QA_COMM_NON_SYNTHETIC_ACCOUNT_DENIED')
                self.auth.login(name, elevate=name == 'admin')
        for label in ('primary', 'foreign'):
            payload = {'name': 'QA communication ' + self.run_id + ' ' + label,
                       'settings': {'qa': {'purpose': PURPOSE, 'run_id': self.run_id}}}
            result = self.auth.command('admin', 'communication_unit_' + label,
                                       '/v1/fagoo/commands', 'unit.save', payload)
            self.state['unit_id' if label == 'primary' else 'foreign_unit_id'] = result.get('result', result)['id']
            self.save()
        for name in ('operator_a', 'operator_b'):
            self.auth.command('admin', 'communication_member_' + name, '/v1/fagoo/commands', 'member.save',
                {'unit_id': self.state['unit_id'], 'user_id': self.auth.state['accounts'][name]['id'],
                 'capabilities': CAPABILITIES, 'team_ids': []})
            self.api(name, '/queue')  # Canonical delegated bootstrap, not an independent profile/login.
        self.inert()
        unit, conversation = self.state['unit_id'], self.state['conversation_id']
        existing = self.d1.query('SELECT id,profile_id,external_namespace,connection_id,phone FROM conversations WHERE id=?', [conversation])
        if not existing:
            self.d1.query("INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,state,owner,epoch,session,last_customer,created,updated) VALUES(?,?,?, ?,NULL,'waiting',NULL,0,?,?,?,?)",
                [conversation, unit, 'qa:' + self.run_id, conversation, str(uuid.uuid4()), 0, int(time.time()*1000), int(time.time()*1000)])
        current = self.d1.query('SELECT id,profile_id,external_namespace,connection_id,phone FROM conversations WHERE id=?', [conversation])
        qa.require(len(current) == 1 and current[0] == {'id': conversation, 'profile_id': unit,
            'external_namespace': 'qa:' + self.run_id, 'connection_id': None, 'phone': None}, 'QA_COMM_SOURCE_NOT_INERT')
        self.d1.query("INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','qa-synthetic',?,?) ON CONFLICT(id) DO NOTHING",
                      [self.state['message_id'], unit, conversation, 'QA private message ' + self.run_id, int(time.time()*1000)])
        self.check('dedicated_users_units_and_channel_free_fixture')

    def claims(self):
        if self.state.get('claims_done'):
            return
        if not self.state.get('claims_started'):
            for actor in ('operator_a', 'operator_b'):
                waiting = self.api(actor, '/queue')
                serialized = json.dumps(waiting)
                self.check(actor + '_queue_minimal', any(c['id'] == self.state['conversation_id'] for c in waiting['data'])
                           and 'QA private message' not in serialized)
        commands = [self.command('claim_' + actor, actor, 'claim') for actor in ('operator_a', 'operator_b')]
        self.state['claims_started'] = True
        self.save()
        results = race(self.send, commands)
        winner = race_winner(results)
        self.state['winner'], self.state['loser'] = [('operator_a', 'operator_b'), ('operator_b', 'operator_a')][winner]
        self.state['claim_statuses'] = [r[0] for r in results]
        self.save()
        row = self.d1.query('SELECT owner,state,epoch FROM conversations WHERE id=?', [self.state['conversation_id']])[0]
        self.check('two_concurrent_claims_exactly_one_owner', row == {
            'owner': self.auth.state['accounts'][self.state['winner']]['id'], 'state': 'human', 'epoch': 1})
        # Same IDs recover receipts and do not increment the epoch or create another owner.
        replay = [self.send(command) for command in commands]
        self.check('claim_receipts_replay_without_second_mutation', [r[0] for r in replay] == self.state['claim_statuses']
                   and self.d1.query('SELECT owner,state,epoch FROM conversations WHERE id=?', [self.state['conversation_id']])[0] == row)
        self.state['claims_done'] = True
        self.save()

    def attachments(self):
        winner, loser = self.state['winner'], self.state['loser']
        conversation = self.state['conversation_id']
        content = ('QA attachment ' + self.run_id + '\n').encode()
        if 'media_key' not in self.state:
            self.state['media_key'] = str(uuid.uuid4())
            self.save()
        boundary = 'fagoo-qa-' + self.run_id
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode()
                + content + f'\r\n--{boundary}--\r\n'.encode())
        if 'media_id' not in self.state:
            media = self.api(winner, '/media', 'POST', body, self.state['media_key'],
                             content_type='multipart/form-data; boundary=' + boundary)
            expected_id = hashlib.sha256((self.auth.state['accounts'][winner]['id'] + ':' +
                self.state['unit_id'] + ':' + self.state['media_key']).encode()).hexdigest()[:32]
            qa.require(media.get('id') == expected_id and media.get('size') == len(content),
                       'QA_COMM_MEDIA_RECEIPT_MISMATCH')
            self.state['media_id'] = media['id']
            self.save()
        self.d1.query("INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created) VALUES(?,?,?,'customer','qa-synthetic','QA attachment',?,?) ON CONFLICT(id) DO NOTHING",
            [self.state['attachment_message_id'], self.state['unit_id'], conversation,
             json.dumps([self.state['media_id']]), int(time.time()*1000)])
        detail = self.api(winner, '/conversations/' + conversation)
        self.api(loser, '/conversations/' + conversation, allowed=(404,))
        data = self.api(winner, '/media/' + self.state['media_id'] + '/content', raw=True)
        self.api(loser, '/media/' + self.state['media_id'] + '/content', allowed=(404,), raw=True)
        self.check('owner_reads_attachment_bytes_other_actor_denied', data == content
                   and any(m['id'] == self.state['media_id'] for m in detail['media']))
        before = self.api(winner, '/events?after=0')
        denied = self.api(loser, '/events?after=0')
        self.check('events_filtered_by_current_owner', any(e['resource_id'] == conversation for e in before['data'])
                   and not any(e['resource_id'] == conversation for e in denied['data']))

    def stale_delivery(self):
        self.inert()
        row = self.d1.query('SELECT epoch,state,connection_id FROM conversations WHERE id=?', [self.state['conversation_id']])[0]
        qa.require(row['epoch'] == 1 and row['state'] == 'human' and row['connection_id'] is None, 'QA_COMM_EPOCH_NOT_CLAIMED')
        # Seed only AFTER the claim; a pending synthetic AI answer cannot race ahead
        # of human ownership. No connection, recipient, credentials or provider URL exists.
        self.d1.query("INSERT INTO outbox(id,profile_id,conversation_id,epoch,kind,actor,payload,dedupe,created,updated) VALUES(?,?,?,0,'text','bot:attendant',?,?,?,?) ON CONFLICT(id) DO NOTHING",
            [self.state['stale_outbox_id'], self.state['unit_id'], self.state['conversation_id'],
             json.dumps({'text': 'QA stale answer ' + self.run_id}), 'qa:' + self.run_id + ':stale',
             int(time.time()*1000), int(time.time()*1000)])
        command = self.command('wake_stale', self.state['winner'], 'tags', {'tags': ['qa-epoch-check']})
        qa.require(self.send(command)[0] == 200, 'QA_COMM_WAKE_FAILED')
        status = None
        for _ in range(20):
            result = self.d1.query('SELECT status,external_id FROM outbox WHERE id=? AND profile_id=?',
                                   [self.state['stale_outbox_id'], self.state['unit_id']])[0]
            status = result['status']
            if status == 'cancelled':
                break
            qa.require(status == 'pending', 'QA_COMM_STALE_DELIVERY_NOT_FENCED')
            time.sleep(1)
        self.check('obsolete_ai_outbox_cancelled_before_transport', status == 'cancelled' and result['external_id'] is None)

    def transfer(self):
        old, new = self.state['winner'], self.state['loser']
        conversation, media = self.state['conversation_id'], self.state['media_id']
        command = self.command('transfer', old, 'transfer', {'target': self.auth.state['accounts'][new]['id']})
        qa.require(self.send(command)[0] == 200, 'QA_COMM_TRANSFER_FAILED')
        self.api(old, '/conversations/' + conversation, allowed=(404,))
        self.api(old, '/media/' + media + '/content', allowed=(404,), raw=True)
        detail = self.api(new, '/conversations/' + conversation)
        content = self.api(new, '/media/' + media + '/content', raw=True)
        old_events = self.api(old, '/events?after=0')
        new_events = self.api(new, '/events?after=0')
        self.check('transfer_revokes_previous_detail_media_and_events', detail['conversation']['owner'] == self.auth.state['accounts'][new]['id']
            and content == ('QA attachment ' + self.run_id + '\n').encode()
            and not any(e['resource_id'] == conversation for e in old_events['data'])
            and any(e['resource_id'] == conversation for e in new_events['data']))
        for actor in (old, new):
            status, _ = api_http(self.state['foreign_unit_id'], '/queue', self.token(actor))
            qa.require(status == 403, 'QA_COMM_OTHER_UNIT_NOT_DENIED')
        self.check('foreign_unit_denied_after_transfer')
        self.inert()
        self.check('no_external_channel_or_notification_registration')

    def execute(self):
        if self.state.get('complete'):
            print('Previously completed communication acceptance; no new login or mutation.')
            return
        self.prepare()
        self.claims()
        if not self.state.get('transfer_started'):
            self.attachments()
            self.stale_delivery()
            self.state['transfer_started'] = True
            self.save()
        self.transfer()
        self.state['complete'] = True
        self.check('https_communication_race_complete')

    def retire(self):
        qa.require(self.state.get('unit_id'), 'QA_COMM_NO_FIXTURE_TO_RETIRE')
        if self.state.get('retired'):
            return
        self.inert()
        self.auth.login('admin', elevate=True)
        setup = self.auth.api('admin', '/v1/fagoo/setup')
        for label, key in [('primary', 'unit_id'), ('foreign', 'foreign_unit_id')]:
            row = next((u for u in setup['units'] if u['id'] == self.state[key]), None)
            qa.require(row and row['name'] == 'QA communication ' + self.run_id + ' ' + label
                       and row['settings'].get('qa', {}).get('run_id') == self.run_id,
                       'QA_COMM_RETIRE_SCOPE_DENIED')
            if row['active']:
                self.auth.command('admin', 'retire_' + label, '/v1/fagoo/commands', 'unit.save',
                    {**{k: row[k] for k in ('id', 'name', 'timezone', 'settings')}, 'active': False,
                     'expected_version': row['version']})
        # Only the three accounts created for this run; never delete Auth history.
        for name, account in self.auth.state['accounts'].items():
            expected = 'qa-' + self.run_id + '-' + name.replace('_', '-') + '@synthetic.invalid'
            qa.require(account['email'] == expected, 'QA_COMM_RETIRE_ACTOR_DENIED')
            actor = str(uuid.UUID(account['id']))
            self.auth.sql("update erp_access.membership m set active=false where user_id='" + actor +
                "' and exists(select 1 from auth.users u where u.id=m.user_id and u.email='" + expected +
                "' and u.raw_user_meta_data->>'qa_run'='" + self.run_id + "');")
        self.state['retired'] = True
        self.check('synthetic_units_and_memberships_retired_history_preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=qa.ROOT)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--credentials-file', type=Path)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument('--execute', action='store_true')
    choice.add_argument('--retire', action='store_true')
    args = parser.parse_args()
    validate_run(args.run_id)
    if not args.execute and not args.retire:
        print(json.dumps({'run_id': args.run_id, 'purpose': PURPOSE, 'executed': False,
            'planned': {'accounts': 3, 'units': 2, 'conversations': 1, 'attachments': 1,
                        'channel_connections': 0, 'outbound_provider_calls': 0},
            'endpoint': qa.ORIGINS['FAGOO_API_ORIGIN'], 'account_id': ACCOUNT}))
        return
    qa.require(args.credentials_file is not None, 'QA_COMM_CREDENTIALS_FILE_REQUIRED')
    values = qa.read_config(args.root)
    d1 = D1(args.root, values, args.credentials_file)
    version = qa.http(qa.ORIGINS['FAGOO_API_ORIGIN'], '/v1/system/version')[1]
    qa.require(str(version.get('version', '')).lstrip('v').startswith('1.0.'), 'QA_COMM_VERSION_NOT_READY')
    run = CommunicationRun(args.root, values, args.run_id, d1)
    lock = run.directory / 'communication.lock'
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise qa.QaError('QA_COMM_LOCK_REQUIRES_INSPECTION') from None
    try:
        run.retire() if args.retire else run.execute()
    finally:
        lock.rmdir()
    print(json.dumps({'run_id': args.run_id, 'report': str(run.report_path), 'retired': run.state.get('retired', False)}))


if __name__ == '__main__':
    try:
        main()
    except (qa.QaError, KeyError, IndexError, TypeError, ValueError, OSError) as error:
        print(str(error) if isinstance(error, qa.QaError) else 'QA_COMM_FAILED_' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
