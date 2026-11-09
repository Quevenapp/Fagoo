"""PostgREST 16 acceptance on fagoo-homolog only, after the Auth/CRM run.

Default is read-only runtime preflight. --execute authenticates synthetic actors
and sends deliberately rejected commands; it does not create business data.
Never run this probe against PostgREST 14, which retries SQLSTATE 40001 forever.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import homologation_auth_crm as qa
from homologation_queues import validate_actors

IMAGE = 'postgrest/postgrest:v16.5@sha256:1347d7552b88f17832912c06afbf7c43209af6eeeb60834b04aae12c9bd9d5cc'


def read_command(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    qa.require(result.returncode == 0, 'QA_REST_RUNTIME_COMMAND_FAILED')
    return result.stdout.strip()


def runtime_preflight(root):
    compose = ['docker', 'compose', '--project-name', 'fagoo-homolog', '--env-file',
               str(root / 'private/install/.env'), '-f', str(root / 'infra/compose.yaml')]
    identifiers = read_command(compose + ['ps', '-q', 'rest']).splitlines()
    qa.require(len(identifiers) == 1 and re.fullmatch('[a-f0-9]{12,64}', identifiers[0]),
               'QA_REST_CONTAINER_REQUIRED')
    actual = read_command(['docker', 'inspect', '--format',
        '{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{.State.Health.Status}}',
        identifiers[0]])
    qa.require(actual == IMAGE + '|fagoo-homolog|healthy', 'QA_REST_16_PIN_REQUIRED')
    version = read_command(compose + ['exec', '-T', 'rest', 'postgrest', '--version'])
    qa.require(re.search(r'\bPostgREST\s+16\.5\b', version, re.I), 'QA_REST_BINARY_VERSION_REQUIRED')
    return {'image': IMAGE, 'container_id': identifiers[0], 'version': '16.5'}


def probe_payload(record, command_id):
    qa.require(isinstance(record.get('version'), int) and 1 <= record['version'] <= 2147483647
               and isinstance(record.get('active'), bool), 'QA_REST_RECORD_INVALID')
    # A missing UUID exercises 404, not serialization failure. The existing QA row
    # plus a different version reaches the legacy check BEFORE any durable write.
    wrong_version = record['version'] + 1 if record['version'] < 2147483647 else 1
    return {'command_id': str(uuid.UUID(command_id)), 'expected_version': wrong_version,
            'active': record['active']}


class RestRun:
    def __init__(self, root, values, run_id):
        self.auth = qa.Run(root, values, run_id, 'https')
        self.run_id = run_id
        self.path = self.auth.directory / 'postgrest-state.json'
        self.report_path = self.auth.directory / 'postgrest-report.json'
        self.state = {'run_id': run_id, 'command_id': str(uuid.uuid4())}
        if self.path.exists():
            qa.require(not self.path.is_symlink() and (os.name == 'nt' or self.path.stat().st_mode & 0o077 == 0),
                       'QA_REST_STATE_NOT_PRIVATE')
            self.state = json.loads(self.path.read_text())
            qa.require(self.state.get('run_id') == run_id, 'QA_REST_RUN_MISMATCH')
        self.report = {'run_id': run_id, 'instance': 'fagoo-homolog', 'checks': []}

    def check(self, name, passed=True):
        qa.require(passed, 'QA_REST_ASSERT_' + name.upper())
        self.report['checks'].append(name)
        self.report['updated_at'] = datetime.now(timezone.utc).isoformat()
        qa.save_private(self.report_path, self.report)
        print('PASS ' + name, flush=True)

    def snapshot(self, contact_id):
        contact_id = str(uuid.UUID(contact_id))
        command_id = str(uuid.UUID(self.state['command_id']))
        unit_id = str(uuid.UUID(self.auth.state['unit_a']))
        # Explicit read-only transaction; only the synthetic row and its receipts.
        sql = "begin read only; select jsonb_build_object('record',to_jsonb(r),'contact',to_jsonb(c)," \
            "'audit_count',(select count(*) from erp_catalog.audit where record_id=r.id)," \
            "'command_count',(select count(*) from erp_catalog.command where command_id='" + command_id + "')," \
            "'synthetic',exists(select 1 from fagoo.contact_source where contact_id=r.id and unit_id='" + unit_id + \
            "' and source_namespace='qa' and source_id='" + self.run_id + "'))::text " \
            "from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id='" + contact_id + "'; commit;"
        return json.loads(self.auth.sql(sql))

    def execute(self, runtime):
        self.report['runtime'] = runtime
        validate_actors(self.auth.state, self.run_id)
        qa.require(any(c.get('name') == 'https_identity_crm_phase_complete' and c.get('status') == 'passed'
                       for c in self.auth.report['checks']), 'QA_REST_AUTH_CRM_PHASE_REQUIRED')
        self.auth.login('admin', elevate=True)
        self.auth.login('operator_a')
        self.check('auth_aal2_and_erp_membership',
                   self.auth.api('admin', '/v1/me')['role'] == 'admin')
        contact_id = str(uuid.UUID(self.auth.state['contact_id']))
        before = self.snapshot(contact_id)
        qa.require(before['synthetic'] and before['record']['name'] == 'QA contact ' + self.run_id
                   and before['record']['entity'] == 'contacts' and before['command_count'] == 0,
                   'QA_REST_SYNTHETIC_CONTACT_REQUIRED')
        body = probe_payload(before['record'], self.state['command_id'])
        if 'payload' in self.state:
            qa.require(self.state['payload'] == body and self.state['contact_id'] == contact_id,
                       'QA_REST_PROBE_CHANGED')
        self.state.update({'payload': body, 'contact_id': contact_id})
        qa.save_private(self.path, self.state)
        rpc_args = {'p_user_id': self.auth.state['accounts']['admin']['id'], 'p_entity': 'contacts',
                    'p_id': contact_id, 'p_expected_version': body['expected_version'],
                    'p_command_id': body['command_id'], 'p_active': body['active']}
        origin = qa.ORIGINS['FAGOO_BACKEND_ORIGIN']
        rpc_path = '/rest/v1/rpc/erp_catalog_set_active'
        for name, token in [('anon', self.auth.values['ANON_KEY']),
                            ('authenticated', self.auth.state['accounts']['admin']['session']['access_token'])]:
            _, denied = qa.http(origin, rpc_path, 'POST', rpc_args, token,
                                self.auth.values['ANON_KEY'], allowed=(401, 403))
            self.check(name + '_cannot_invoke_service_rpc', denied.get('code') == '42501')
        # One direct service request proves the underlying SQLSTATE stayed 40001;
        # the Worker request proves its public 409 mapping without leaking SQL.
        started = time.monotonic()
        _, problem = qa.http(origin, rpc_path, 'POST', rpc_args, self.auth.values['SERVICE_ROLE_KEY'],
                             self.auth.values['SERVICE_ROLE_KEY'], allowed=(500,))
        self.check('legacy_40001_returns_without_retry_loop', problem.get('code') == '40001'
                   and problem.get('message') == 'erp_catalog_version_conflict'
                   and time.monotonic() - started < 12)
        path = '/v1/cadastros/contacts/' + contact_id
        before_api = self.auth.api('admin', path)
        started = time.monotonic()
        conflict = self.auth.api('admin', path + '/active', 'PATCH', body, allowed=(409,))
        self.check('legacy_worker_conflict_is_bounded_409',
                   conflict.get('error', {}).get('code') == 'ERP_CONFLICT' and time.monotonic() - started < 12)
        self.auth.api('operator_a', path, allowed=(403,))
        self.check('operational_role_cannot_read_erp_catalog')
        self.check('rejected_probe_commits_no_business_write',
                   self.snapshot(contact_id) == before and self.auth.api('admin', path) == before_api)
        self.auth.api('operator_a', '/v1/crm/units/' + self.auth.state['unit_b'] + '/snapshot', allowed=(403,))
        self.check('crm_other_unit_still_denied')
        self.check('postgrest_acceptance_complete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=qa.ROOT)
    parser.add_argument('--run-id', default='9e786a54cb21')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    qa.require(re.fullmatch('[a-f0-9]{12}', args.run_id), 'QA_RUN_ID_INVALID')
    values = qa.read_config(args.root)
    runtime = runtime_preflight(args.root)  # Refuse v14 BEFORE any error-producing HTTP request.
    if not args.execute:
        print(json.dumps({'executed': False, **runtime}))
        return
    run = RestRun(args.root, values, args.run_id)
    lock = run.auth.directory / 'postgrest.lock'
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise qa.QaError('QA_REST_LOCK_REQUIRES_INSPECTION') from None
    try:
        run.execute(runtime)
    finally:
        lock.rmdir()
    print(json.dumps({'executed': True, 'report': str(run.report_path)}))


if __name__ == '__main__':
    try:
        main()
    except (qa.QaError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, qa.QaError) else 'QA_REST_FAILED_' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
