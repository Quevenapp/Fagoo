"""Real HTTP QA for the isolated fagoo-homolog installation; never production.

Run on /opt/fagoo-homolog only. Default is read-only preflight. Explicit --execute
creates synthetic accounts, and --phase api requires the published HTTPS API.
Credentials and responses containing tokens stay in private/qa/<run>/ (0700/0600).
No signup, invite, password recovery, email, WhatsApp or notification endpoint is used.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path('/opt/fagoo-homolog')
ORIGINS = {
    'FAGOO_WEB_ORIGIN': 'https://homolog.fagoo.com.br',
    'FAGOO_API_ORIGIN': 'https://api-homolog.fagoo.com.br',
    'FAGOO_BACKEND_ORIGIN': 'https://services-homolog.fagoo.com.br',
}
LOCAL = 'http://127.0.0.1:18081'


class QaError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise QaError(code)


def validate_config(root, values):
    require(str(root) == str(ROOT), 'QA_ROOT_DENIED')
    require(values.get('FAGOO_INSTANCE_ID') == 'fagoo-homolog', 'QA_INSTANCE_DENIED')
    require(values.get('FAGOO_LOCAL_PORT') == '18081', 'QA_PORT_DENIED')
    for key, value in ORIGINS.items():
        require(values.get(key) == value, 'QA_ORIGIN_DENIED')
    require(all(values.get(key) for key in ('ANON_KEY', 'SERVICE_ROLE_KEY')), 'QA_KEYS_MISSING')


def read_config(root):
    path = root / 'private/install/.env'
    require(root.resolve() == ROOT and not root.is_symlink(), 'QA_ROOT_DENIED')
    require(not path.is_symlink() and path.resolve().is_relative_to(root), 'QA_CONFIG_PATH_DENIED')
    require(path.stat().st_mode & 0o077 == 0, 'QA_CONFIG_NOT_PRIVATE')
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        require(sep and key not in values, 'QA_CONFIG_INVALID')
        values[key] = value
    validate_config(root, values)
    return values


def save_private(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not path.is_symlink() and not path.parent.is_symlink(), 'QA_STATE_PATH_DENIED')
    require(os.name == 'nt' or path.parent.stat().st_mode & 0o077 == 0, 'QA_STATE_NOT_PRIVATE')
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise QaError('QA_HTTP_REDIRECT_DENIED')


def http(origin, path, method='GET', payload=None, token=None, key=None, allowed=(200,), web=False):
    require(origin in (LOCAL, *ORIGINS.values()), 'QA_HTTP_ORIGIN_DENIED')
    require(path.startswith('/') and not path.startswith('//'), 'QA_HTTP_PATH_DENIED')
    headers = {'Accept': 'application/json'}
    if key:
        headers['apikey'] = key
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if web:
        headers['Origin'] = ORIGINS['FAGOO_WEB_ORIGIN']
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(origin + path, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(request, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError:
        raise QaError('QA_HTTP_UNAVAILABLE') from None
    with response:
        status = response.code
        body = response.read(2_000_001)
    require(len(body) <= 2_000_000, 'QA_HTTP_TOO_LARGE')
    # Never include server bodies, URLs with query values or tokens in exceptions.
    require(status in allowed, 'QA_HTTP_STATUS_' + str(status))
    try:
        result = json.loads(body) if body else None
    except ValueError:
        raise QaError('QA_HTTP_INVALID_JSON') from None
    return status, result


def totp(secret, at=None):
    counter = int(time.time() if at is None else at) // 30
    key = base64.b32decode(secret.upper() + '=' * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1_000_000).zfill(6)


def claims(token):
    # Only inspect a token received directly from Auth over the verified transport.
    part = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


class Run:
    def __init__(self, root, values, run_id, transport='loopback'):
        self.root, self.values, self.run_id = root, values, run_id
        self.directory = root / 'private/qa' / run_id
        require(self.directory.resolve().is_relative_to(root.resolve()), 'QA_STATE_PATH_DENIED')
        self.state_file = self.directory / 'credentials.json'
        self.report_file = self.directory / 'report.json'
        self.state = {'run_id': run_id, 'accounts': {}, 'commands': {}}
        if self.state_file.exists():
            require(not self.state_file.is_symlink() and self.state_file.stat().st_mode & 0o077 == 0, 'QA_STATE_NOT_PRIVATE')
            self.state = json.loads(self.state_file.read_text())
            require(self.state['run_id'] == run_id, 'QA_STATE_INVALID')
        self.report = {'run_id': run_id, 'instance': 'fagoo-homolog', 'checks': [], 'limitations': []}
        if self.report_file.exists():
            self.report = json.loads(self.report_file.read_text())
        self.auth_origin = LOCAL if transport == 'loopback' else ORIGINS['FAGOO_BACKEND_ORIGIN']
        self.transport = transport

    def save(self):
        save_private(self.state_file, self.state)

    def check(self, name, condition=True):
        require(condition, 'QA_ASSERT_' + name.upper())
        self.report['checks'].append({'name': name, 'status': 'passed', 'at': datetime.now(timezone.utc).isoformat()})
        self.report['updated_at'] = datetime.now(timezone.utc).isoformat()
        save_private(self.report_file, self.report)
        print('PASS ' + name, flush=True)

    def sql(self, sql):
        command = ['docker', 'compose', '--project-name', 'fagoo-homolog', '--env-file', str(self.root / 'private/install/.env'), '-f', str(self.root / 'infra/compose.yaml'), 'exec', '-T', 'db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-']
        result = subprocess.run(command, input=sql, capture_output=True, text=True, timeout=45)
        require(result.returncode == 0, 'QA_DATABASE_FAILED')
        return result.stdout.strip()

    def auth(self, path, method='GET', payload=None, token=None, admin=False, allowed=(200,)):
        key = self.values['SERVICE_ROLE_KEY' if admin else 'ANON_KEY']
        return http(self.auth_origin, '/auth/v1' + path, method, payload, key if admin else token, key, allowed)

    def preflight(self):
        result = subprocess.run(['docker', 'ps', '--filter', 'label=com.docker.compose.project=fagoo-homolog', '--format', '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Status}}'], capture_output=True, text=True, timeout=15)
        require(result.returncode == 0, 'QA_DOCKER_UNAVAILABLE')
        rows = [line.split('|', 2) for line in result.stdout.splitlines()]
        require(len(rows) == 5 and all(len(row) == 3 and row[0] == 'fagoo-homolog' and 'healthy' in row[2] for row in rows), 'QA_RUNTIME_NOT_HEALTHY')
        self.auth('/health')
        require(self.sql("select count(*) from fagoo_system.schema_migration where version like '202611090010%';") == '1', 'QA_MIGRATIONS_NOT_READY')
        self.check('isolated_runtime_healthy')

    def login(self, name, elevate=False):
        account = self.state['accounts'][name]
        _, session = self.auth('/token?grant_type=password', 'POST', {'email': account['email'], 'password': account['password']})
        require(session.get('user', {}).get('id') == account['id'], 'QA_AUTH_ACTOR_MISMATCH')
        if elevate:
            require(account.get('totp_secret') and account.get('factor_id'), 'QA_MFA_NOT_ENROLLED')
            session = self.verify_mfa(account, session)
        account['session'] = session
        self.save()
        return session

    def verify_mfa(self, account, session, reject_invalid=False):
        if reject_invalid:
            valid_codes = {totp(account['totp_secret'], time.time() + offset) for offset in (-30, 0, 30)}
            invalid_code = next(str(n).zfill(6) for n in range(100) if str(n).zfill(6) not in valid_codes)
            _, challenge = self.auth('/factors/' + account['factor_id'] + '/challenge', 'POST', {}, session['access_token'])
            self.auth('/factors/' + account['factor_id'] + '/verify', 'POST', {'challenge_id': challenge['id'], 'code': invalid_code}, session['access_token'], allowed=(400, 422))
            self.check('totp_invalid_code_rejected')
        _, challenge = self.auth('/factors/' + account['factor_id'] + '/challenge', 'POST', {}, session['access_token'])
        _, verified = self.auth('/factors/' + account['factor_id'] + '/verify', 'POST', {'challenge_id': challenge['id'], 'code': totp(account['totp_secret'])}, session['access_token'])
        require(claims(verified['access_token']).get('aal') == 'aal2', 'QA_MFA_AAL2_MISSING')
        return verified

    def create_accounts(self):
        for name, role in (('admin', 'admin'), ('operator_a', 'operacao'), ('operator_b', 'operacao')):
            account = self.state['accounts'].setdefault(name, {'email': 'qa-' + self.run_id + '-' + name.replace('_', '-') + '@synthetic.invalid', 'password': secrets.token_urlsafe(30), 'role': role})
            self.save()  # Persist password BEFORE the request; ambiguous create must be recoverable.
            if not account.get('id'):
                _, existing = self.auth('/admin/users?page=1&per_page=1000', admin=True)
                candidates = [user for user in existing.get('users', []) if user.get('email') == account['email']]
                require(len(candidates) <= 1, 'QA_DUPLICATE_SYNTHETIC_ACCOUNT')
                if candidates:
                    user = candidates[0]
                    require(user.get('user_metadata', {}).get('qa_run') == self.run_id, 'QA_EXISTING_ACCOUNT_DENIED')
                else:
                    _, user = self.auth('/admin/users', 'POST', {'email': account['email'], 'password': account['password'], 'email_confirm': True, 'user_metadata': {'name': 'QA ' + name, 'qa_run': self.run_id}}, admin=True, allowed=(200, 201))
                account['id'] = str(uuid.UUID(user['id']))
                self.save()
            actor = str(uuid.UUID(account['id']))
            require(re.fullmatch(r'qa-[a-f0-9]{12}-(admin|operator-a|operator-b)@synthetic\.invalid', account['email']), 'QA_EMAIL_DENIED')
            self.sql("begin; do $qa$ begin if not exists(select 1 from auth.users where id='" + actor + "' and email='" + account['email'] + "' and raw_user_meta_data->>'qa_run'='" + self.run_id + "') then raise exception 'QA_ACTOR_DENIED'; end if; end $qa$; insert into erp_access.membership(user_id,role,active) values('" + actor + "','" + role + "',true) on conflict(user_id) do nothing; commit;")
            self.check(name + '_synthetic_account_ready')

    def run_auth(self):
        self.create_accounts()
        session = self.login('admin')
        self.check('password_login', claims(session['access_token']).get('aal') == 'aal1')
        _, refreshed = self.auth('/token?grant_type=refresh_token', 'POST', {'refresh_token': session['refresh_token']})
        self.check('refresh_session', refreshed.get('user', {}).get('id') == self.state['accounts']['admin']['id'])
        self.auth('/logout?scope=local', 'POST', token=refreshed['access_token'], allowed=(204,))
        self.auth('/token?grant_type=refresh_token', 'POST', {'refresh_token': refreshed['refresh_token']}, allowed=(400, 401))
        self.check('logout_revokes_refresh')
        account = self.state['accounts']['admin']
        session = self.login('admin')
        if not account.get('factor_id'):
            _, factor = self.auth('/factors', 'POST', {'factor_type': 'totp', 'friendly_name': 'QA ' + self.run_id, 'issuer': 'Fagoo homolog QA'}, session['access_token'])
            account['factor_id'] = factor['id']
            account['totp_secret'] = factor['totp']['secret']
            self.save()
        elevated = self.verify_mfa(account, session, reject_invalid=True)
        account['session'] = elevated
        self.save()
        self.check('totp_enroll_challenge_verify_aal2')
        session_id = str(uuid.UUID(claims(elevated['access_token'])['session_id']))
        self.check('erp_recognizes_auth_aal2', self.sql("select erp_access.session_aal2('" + account['id'] + "','" + session_id + "');") == 't')
        for name in ('operator_a', 'operator_b'):
            self.login(name)
            self.check(name + '_password_login')
        limitation = 'Auth HTTP verified over ' + self.transport + '; logout checks refresh revocation, not immediate expiry of already issued access JWTs. Global MFA policy was not changed.'
        if limitation not in self.report['limitations']:
            self.report['limitations'].append(limitation)
        self.check('auth_phase_complete')

    def api(self, name, path, method='GET', payload=None, allowed=(200,)):
        token = self.state['accounts'][name]['session']['access_token']
        return http(ORIGINS['FAGOO_API_ORIGIN'], path, method, payload, token, allowed=allowed, web=True)[1]

    def command(self, name, key, path, action, payload):
        commands = self.state['commands']
        if key not in commands:
            commands[key] = {'command_id': str(uuid.uuid4()), 'action': action, 'payload': payload}
            self.save()
        require(commands[key]['action'] == action and commands[key]['payload'] == payload, 'QA_COMMAND_PAYLOAD_CHANGED')
        return self.api(name, path, 'POST', commands[key])

    def run_api(self):
        require(self.transport == 'https', 'QA_API_REQUIRES_HTTPS')
        require(set(self.state['accounts']) == {'admin', 'operator_a', 'operator_b'}, 'QA_AUTH_PHASE_REQUIRED')
        for name in self.state['accounts']:
            self.login(name, elevate=name == 'admin')
        self.api('admin', '/v1/fagoo/setup')
        for label in ('a', 'b'):
            result = self.command('admin', 'unit_' + label, '/v1/fagoo/commands', 'unit.save', {'name': 'QA ' + self.run_id + ' ' + label, 'timezone': 'America/Sao_Paulo', 'settings': {'crm': {'shared_read': False}}})
            # Identity command returns its canonical resource under result.
            resource = result.get('result', result)
            self.state['unit_' + label] = resource['id']
            self.save()
            self.command('admin', 'member_' + label, '/v1/fagoo/commands', 'member.save', {'unit_id': resource['id'], 'user_id': self.state['accounts']['operator_' + label]['id'], 'capabilities': ['crm.read', 'crm.write'], 'team_ids': []})
        unit_a, unit_b = self.state['unit_a'], self.state['unit_b']
        context = self.api('operator_a', '/v1/fagoo/context')
        self.check('unit_scope_context', [unit['id'] for unit in context['units']] == [unit_a])
        self.api('operator_a', '/v1/fagoo/setup', allowed=(403,))
        self.api('operator_a', '/v1/crm/units/' + unit_b + '/snapshot', allowed=(403,))
        self.check('admin_and_other_unit_denied')
        snapshot = self.api('operator_a', '/v1/crm/units/' + unit_a + '/snapshot')
        self.check('crm_allowed_unit_snapshot', snapshot['unit_id'] == unit_a and bool(snapshot['funnels']))
        if not self.state.get('contact_id'):
            # Synthetic canonical contact uses the same service-only projection RPC,
            # not an automatic phone/email merge or direct business-table insertion.
            args = {'p_unit_id': unit_a, 'p_source_namespace': 'qa', 'p_source_id': self.run_id, 'p_name': 'QA contact ' + self.run_id, 'p_phone': None}
            projected = http(LOCAL, '/rest/v1/rpc/fagoo_contact_project', 'POST', args, self.values['SERVICE_ROLE_KEY'], self.values['SERVICE_ROLE_KEY'])[1]
            self.state['contact_id'] = projected['contact_id']
            self.save()
        contact = self.state['contact_id']
        path = '/v1/crm/units/' + unit_a + '/commands'
        payload = {'title': 'QA opportunity ' + self.run_id, 'contact_id': contact, 'funnel_id': snapshot['funnels'][0]['id'], 'stage': 'new', 'amount': 12.34}
        opportunity = self.command('operator_a', 'opportunity', path, 'opportunity.save', payload)
        replay = self.command('operator_a', 'opportunity', path, 'opportunity.save', payload)
        self.check('crm_command_idempotent', replay.get('replayed') is True and replay['id'] == opportunity['id'])
        receipt = self.api('operator_a', path + '/' + self.state['commands']['opportunity']['command_id'])
        self.check('crm_receipt_recovery', receipt.get('replayed') is True and receipt['id'] == opportunity['id'])
        self.api('operator_b', path, 'POST', self.state['commands']['opportunity'], allowed=(403,))
        self.check('crm_cross_unit_write_denied')
        if 'task_due' not in self.state:
            self.state['task_due'] = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
            self.save()
        self.command('operator_a', 'task', path, 'task.save', {'title': 'QA follow-up', 'contact_id': contact, 'opportunity_id': opportunity['id'], 'due_at': self.state['task_due']})
        financial_counts = "select jsonb_build_array((select count(*) from erp_finance.title),(select count(*) from erp_finance.settlement),(select count(*) from erp_finance.movement),(select count(*) from erp_finance.document_posting),(select count(*) from erp_finance.cash_entry))::text;"
        before = self.sql(financial_counts)
        self.command('operator_a', 'won', path, 'opportunity.move', {'id': opportunity['id'], 'stage': 'won', 'expected_version': 1})
        self.check('crm_won_does_not_post_finance', self.sql(financial_counts) == before)
        self.api('operator_a', path, 'POST', {'command_id': str(uuid.uuid4()), 'action': 'opportunity.move', 'payload': {'id': opportunity['id'], 'stage': 'lost', 'expected_version': 1}}, allowed=(409,))
        self.check('crm_version_conflict')
        final = self.api('operator_a', '/v1/crm/units/' + unit_a + '/snapshot?contact_id=' + contact)
        self.check('crm_opportunity_task_visible', len(final['opportunities']) == 1 and final['opportunities'][0]['stage'] == 'won' and len(final['tasks']) == 1)
        history = self.api('operator_a', '/v1/crm/units/' + unit_a + '/history?contact_id=' + contact)
        self.check('crm_relationship_history', bool(history.get('events', history.get('data'))))
        self.check('https_identity_crm_phase_complete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--run-id', default=secrets.token_hex(6))
    parser.add_argument('--phase', choices=('auth', 'api'), default='auth')
    parser.add_argument('--auth-transport', choices=('loopback', 'https'), default='loopback')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch('[a-f0-9]{12}', args.run_id), 'QA_RUN_ID_INVALID')
    values = read_config(args.root)
    run = Run(args.root, values, args.run_id, args.auth_transport)
    run.preflight()
    if args.execute:
        run.run_auth() if args.phase == 'auth' else run.run_api()
    print(json.dumps({'run_id': args.run_id, 'executed': args.execute, 'phase': args.phase, 'report': str(run.report_file), 'credentials': str(run.state_file)}))


if __name__ == '__main__':
    try:
        main()
    except (QaError, KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, QaError) else 'QA_FAILED_' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
