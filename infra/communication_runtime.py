"""Installation-owned communication resources. Never select a legacy installation by name alone."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import urllib.parse
import urllib.request


def names(values):
    suffix = hashlib.sha256(values['FAGOO_WEB_ORIGIN'].encode()).hexdigest()[:12]
    return {'worker': 'fagoo-communication-' + suffix, 'database_name': 'fagoo-communication-' + suffix,
            'bucket': 'fagoo-media-' + suffix, 'authority': 'fagoo-api-' + suffix}


def enabled(values):
    value = values.get('FAGOO_COMMUNICATION_ENABLED', 'true')
    if value not in ('true', 'false'):
        raise ValueError('COMMUNICATION_CONFIGURATION_INVALID')
    return value == 'true'


def private_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.new')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as out:
            json.dump(value, out, sort_keys=True)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def state_path(env_file):
    return Path(env_file).resolve().parent / 'communication.json'


def verify_backup(directory):
    """Verify every exported object before allowing adoption or claiming a recoverable checkpoint."""
    directory = Path(directory)
    if not directory.is_absolute() or directory.is_symlink():
        raise ValueError('COMMUNICATION_BACKUP_PATH_INVALID')
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('COMMUNICATION_BACKUP_MANIFEST_INVALID')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('version') != 2 or manifest.get('complete') is not True or not isinstance(manifest.get('media'), list):
        raise ValueError('COMMUNICATION_BACKUP_INCOMPLETE')
    expected = ['database.sql']
    for item in manifest['media']:
        if not re.fullmatch('[A-Za-z0-9_-]{1,128}', str(item.get('id', ''))):
            raise ValueError('COMMUNICATION_BACKUP_MEDIA_INVALID')
        expected.append('media/' + item['id'])
    hashes = manifest.get('sha256', {})
    if len(expected) != len(set(expected)):
        raise ValueError('COMMUNICATION_BACKUP_MEDIA_DUPLICATED')
    for name in expected:
        path = directory / name
        if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
            raise ValueError('COMMUNICATION_BACKUP_FILE_INVALID')
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != hashes.get(name):
            raise ValueError('COMMUNICATION_BACKUP_HASH_MISMATCH')
    return hashlib.sha256(manifest_path.read_bytes()).hexdigest()


def verify_adoption(state, values):
    """Legacy DO names and crypto keys require reviewed provenance and a verified restore rehearsal."""
    selected = names(values)
    legacy = any(state[key] != selected[key] for key in ('worker', 'database_name', 'bucket'))
    if state.get('deployed') or not legacy:
        return
    evidence = state.get('adoption', {})
    if (evidence.get('reviewed') is not True or evidence.get('source_worker') != state['worker']
            or evidence.get('source_database_id') != state['database_id'] or evidence.get('source_bucket') != state['bucket']
            or evidence.get('source_master_key_sha256') != hashlib.sha256(state['master_key'].encode()).hexdigest()
            or evidence.get('old_writer_quiesced') is not True or evidence.get('durable_ingress_verified') is not True
            or evidence.get('restore_rehearsal_verified') is not True or not evidence.get('evidence_reference')):
        raise ValueError('COMMUNICATION_LEGACY_ADOPTION_REQUIRES_VERIFIED_EVIDENCE')
    actual = verify_backup(evidence.get('backup_directory', ''))
    if actual != evidence.get('backup_manifest_sha256'):
        raise ValueError('COMMUNICATION_LEGACY_BACKUP_CHANGED')


def adopting(state, values):
    return bool(state and not state.get('deployed') and
                any(state[key] != names(values)[key] for key in ('worker', 'database_name', 'bucket')))


def verify_activation(state):
    """Operator attestations bind the cutover to a reconciled import; deployment cannot invent them."""
    evidence = state.get('adoption', {}).get('activation', {})
    if (not isinstance(evidence, dict) or
            any(evidence.get(key) is not True for key in ('import_reconciled', 'old_writer_stopped',
                'archive_restore_verified', 'single_channel_consumer_verified', 'd1_adoption_verified')) or
            not re.fullmatch('[a-f0-9]{64}', str(evidence.get('source_sha256', ''))) or
            not re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', str(evidence.get('run_id', ''))) or
            not isinstance(evidence.get('evidence_reference'), str) or not evidence['evidence_reference'].strip()):
        raise ValueError('COMMUNICATION_LEGACY_ACTIVATION_EVIDENCE_REQUIRED')


def deployment_versions(result):
    deployments = result.get('deployments', []) if isinstance(result, dict) else result
    if not isinstance(deployments, list) or not deployments:
        raise ValueError('COMMUNICATION_PREVIOUS_VERSION_UNAVAILABLE')
    versions = sorted(deployments, key=lambda value: value.get('created_on', ''), reverse=True)[0].get('versions')
    if not isinstance(versions, list) or not versions or any(
            not isinstance(item, dict) or not re.fullmatch('[a-f0-9-]{36}', str(item.get('version_id', ''))) or
            type(item.get('percentage')) not in (int, float) or not 0 <= item['percentage'] <= 100 for item in versions):
        raise ValueError('COMMUNICATION_PREVIOUS_VERSION_UNAVAILABLE')
    if sum(item['percentage'] for item in versions) != 100:
        raise ValueError('COMMUNICATION_PREVIOUS_VERSION_UNAVAILABLE')
    return [{'version_id': item['version_id'], 'percentage': item['percentage']} for item in versions]


def read_state(path, values, account):
    path = Path(path)
    if not path.exists():
        return None
    if path.is_symlink() or (os.name != 'nt' and path.stat().st_mode & 0o077) or path.stat().st_size > 32768:
        raise ValueError('COMMUNICATION_PRIVATE_STATE_INVALID')
    state = json.loads(path.read_text(encoding='utf-8'))
    if state.get('format') != 1 or state.get('origin') != values['FAGOO_WEB_ORIGIN'] or state.get('account_id') != account:
        raise ValueError('COMMUNICATION_INSTALLATION_MISMATCH')
    if not isinstance(state.get('master_key'), str) or not 32 <= len(state['master_key']) <= 512 or any(ord(c)<32 for c in state['master_key']):
        raise ValueError('COMMUNICATION_MASTER_KEY_INVALID')
    for field in ('worker', 'database_name', 'bucket'):
        if not re.fullmatch('[a-z0-9][a-z0-9-]{2,62}', str(state.get(field, ''))):
            raise ValueError('COMMUNICATION_RESOURCE_INVALID')
    if state.get('database_id') and not re.fullmatch('[a-f0-9-]{36}', state['database_id']):
        raise ValueError('COMMUNICATION_DATABASE_INVALID')
    for route in state.get('routes', []):
        if not isinstance(route, dict) or route.get('custom_domain') is not True or not re.fullmatch('[a-z0-9.-]+', str(route.get('pattern', ''))) or not re.fullmatch('[a-f0-9]{32}', str(route.get('zone_id', ''))):
            raise ValueError('COMMUNICATION_LEGACY_ROUTE_INVALID')
    return state


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('COMMUNICATION_CLOUDFLARE_REDIRECT_REFUSED')


def cloudflare(method, path, token, body=None):
    if not path.startswith('/accounts/') or '..' in path:
        raise ValueError('COMMUNICATION_CLOUDFLARE_PATH_INVALID')
    request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('COMMUNICATION_CLOUDFLARE_RESPONSE_TOO_LARGE')
    result = json.loads(raw)
    if result.get('success') is not True:
        raise ValueError('COMMUNICATION_CLOUDFLARE_OPERATION_FAILED')
    return result.get('result')


def provision(env_file, values, account, token, call=cloudflare):
    """Create resources only for a new installation; resumed calls preserve its private master key."""
    path = state_path(env_file)
    state = read_state(path, values, account)
    if state is not None:
        verify_adoption(state, values)
    if state is None:
        selected = names(values)
        databases = call('GET', f'/accounts/{account}/d1/database?name=' + urllib.parse.quote(selected['database_name']), token)
        buckets = call('GET', f'/accounts/{account}/r2/buckets?name=' + urllib.parse.quote(selected['bucket']), token)
        if any(item.get('name') == selected['database_name'] for item in databases or []) or any(item.get('name') == selected['bucket'] for item in (buckets or {}).get('buckets', [])):
            raise ValueError('COMMUNICATION_EXISTING_RESOURCES_REQUIRE_REVIEWED_ADOPTION')
        state = {'format': 1, 'origin': values['FAGOO_WEB_ORIGIN'], 'account_id': account,
                 **selected, 'master_key': secrets.token_hex(32), 'database_id': None, 'bucket_created': False,
                 'provisioning': True, 'deployed': False}
        # Record intent and encryption key before creating any persistent resource.
        private_write(path, state)
    if not state.get('database_id'):
        matches = call('GET', f'/accounts/{account}/d1/database?name=' + urllib.parse.quote(state['database_name']), token)
        matches = [item for item in matches or [] if item.get('name') == state['database_name']]
        if len(matches) > 1:
            raise ValueError('COMMUNICATION_AMBIGUOUS_DATABASE')
        database = matches[0] if matches else call('POST', f'/accounts/{account}/d1/database', token, {'name': state['database_name']})
        state['database_id'] = database['uuid']
        private_write(path, state)
    if not state.get('bucket_created'):
        buckets = call('GET', f'/accounts/{account}/r2/buckets?name=' + urllib.parse.quote(state['bucket']), token)
        if not any(item.get('name') == state['bucket'] for item in (buckets or {}).get('buckets', [])):
            call('POST', f'/accounts/{account}/r2/buckets', token, {'name': state['bucket']})
        state['bucket_created'] = True
        private_write(path, state)
    state['provisioning'] = False
    private_write(path, state)
    return state


def configuration(root, values, account, state=None):
    root = Path(root)
    selected = state or names(values)
    return {'name': selected['worker'], 'account_id': account, 'main': str(root / 'workers/communication/src/index.ts'),
        'compatibility_date': '2026-11-04', 'compatibility_flags': ['nodejs_compat'],
        'workers_dev': False, 'preview_urls': False, 'observability': {'enabled': False},
        'routes': selected.get('routes', []),
        'assets': {'directory': str(root / 'workers/communication/dist'), 'binding': 'ASSETS',
                   'not_found_handling': 'single-page-application', 'run_worker_first': True},
        'd1_databases': [{'binding': 'DB', 'database_name': selected['database_name'],
                         'database_id': selected.get('database_id') or '00000000-0000-0000-0000-000000000000',
                         'migrations_dir': str(root / 'workers/communication/migrations')}],
        'r2_buckets': [{'binding': 'MEDIA', 'bucket_name': selected['bucket']}],
        'durable_objects': {'bindings': [{'name': 'COORDINATOR', 'class_name': 'Coordinator'}]},
        'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['Coordinator']}],
        'services': [{'binding': 'FAGOO_AUTHORITY', 'service': names(values)['authority'], 'entrypoint': 'FagooCommunicationAuthority'}],
        'triggers': {'crons': ['*/5 * * * *']},
        'vars': {'APP_NAME': 'Fagoo', 'FAGOO_MANAGED': 'true'}}


def api_bindings(values, state=None):
    if not enabled(values):
        return []
    worker = state['worker'] if state else names(values)['worker']
    return [{'binding': 'COMMUNICATION', 'service': worker, 'entrypoint': 'FagooCommunication'},
            {'binding': 'COMMUNICATION_PUBLIC', 'service': worker}]
