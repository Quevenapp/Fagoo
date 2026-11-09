"""Back up Fagoo's internal engine while keeping durable webhook reception available."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone
from communication_runtime import read_state, state_path, cloudflare, private_write, verify_backup, verify_adoption, verify_activation, deployment_versions, adopting
from update_config import read_values, cloudflare_credentials
from cloudflare_transport import options, node_environment

ROOT = Path(__file__).resolve().parents[1]


def query(state, token, sql, params=None, *, ip_family=None):
    result = cloudflare('POST', f"/accounts/{state['account_id']}/d1/database/{state['database_id']}/query", token,
                        {'sql': sql, 'params': params or []}, **options(ip_family))
    if not isinstance(result, list) or any(row.get('success') is not True for row in result):
        raise ValueError('COMMUNICATION_QUERY_FAILED')
    return result[0].get('results', []) if result else []


def quiescent(state, token, *, ip_family=None):
    rows = query(state, token, """SELECT
     (SELECT COUNT(*) FROM outbox WHERE status='sending') +
     (SELECT COUNT(*) FROM bot_runs WHERE status IN ('starting','running','cancelling')) +
     (SELECT COUNT(*) FROM webhook_deliveries WHERE status='sending') +
     (SELECT COUNT(*) FROM group_operations WHERE status='sending') +
     (SELECT COUNT(*) FROM inbox WHERE status='processing') AS pending""", **options(ip_family))
    return len(rows) == 1 and rows[0]['pending'] == 0


def resume(marker, state, token, *, ip_family=None):
    held = json.loads(marker.read_text(encoding='utf-8'))
    if held.get('database_id') != state['database_id'] or held.get('account_id') != state['account_id'] or not held.get('backup_complete'):
        raise ValueError('COMMUNICATION_BACKUP_RECONCILIATION_REQUIRED')
    if verify_backup(held['backup']) != held.get('backup_manifest_sha256'):
        raise ValueError('COMMUNICATION_BACKUP_RECONCILIATION_REQUIRED')
    if held.get('kind') == 'legacy-adoption':
        verify_activation(state)
    query(state, token, 'UPDATE fagoo_runtime SET pause_outbound=?,updated=? WHERE id=1', [held['previous_pause'], int(time.time() * 1000)], **options(ip_family))
    marker.unlink()


def prepare_adoption(marker, state, values, token, *, ip_family=None):
    """Capture rollback even when called by the older updater, before D1/code mutations."""
    if marker.exists():
        raise ValueError('COMMUNICATION_MAINTENANCE_RECONCILIATION_REQUIRED')
    if not adopting(state, values):
        raise ValueError('COMMUNICATION_LEGACY_ADOPTION_REQUIRED')
    verify_adoption(state, values)
    evidence = state['adoption']
    versions = deployment_versions(cloudflare('GET', f"/accounts/{state['account_id']}/workers/scripts/{state['worker']}/deployments", token, **options(ip_family)))
    tables = query(state, token, "SELECT name FROM sqlite_master WHERE type='table' AND name='fagoo_runtime'", **options(ip_family))
    previous = query(state, token, 'SELECT pause_outbound FROM fagoo_runtime WHERE id=1', **options(ip_family)) if tables else [{'pause_outbound': 0}]
    if len(previous) != 1 or previous[0]['pause_outbound'] not in (0, 1):
        raise ValueError('COMMUNICATION_PAUSE_UNAVAILABLE')
    record = {'format': 1, 'kind': 'legacy-adoption', 'account_id': state['account_id'],
              'database_id': state['database_id'], 'worker': state['worker'], 'previous_versions': versions,
              'previous_state': state, 'previous_pause': previous[0]['pause_outbound'],
              'backup': evidence['backup_directory'], 'backup_manifest_sha256': evidence['backup_manifest_sha256'],
              'backup_complete': True, 'pause_applied': False, 'durable_webhooks': True}
    private_write(marker, record)


def hold_adoption(marker, state, token, *, ip_family=None):
    record = json.loads(marker.read_text(encoding='utf-8'))
    if record.get('kind') != 'legacy-adoption' or record.get('database_id') != state['database_id'] or record.get('account_id') != state['account_id']:
        raise ValueError('COMMUNICATION_BACKUP_RECONCILIATION_REQUIRED')
    query(state, token, 'UPDATE fagoo_runtime SET pause_outbound=1,updated=? WHERE id=1', [int(time.time() * 1000)], **options(ip_family))
    if query(state, token, 'SELECT pause_outbound FROM fagoo_runtime WHERE id=1', **options(ip_family)) != [{'pause_outbound': 1}]:
        raise ValueError('COMMUNICATION_PAUSE_UNAVAILABLE')
    record['pause_applied'] = True
    private_write(marker, record)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--credentials-file', required=True)
    parser.add_argument('--config')
    parser.add_argument('--hold', action='store_true', help='Keep outbound paused until the coordinated publication succeeds.')
    parser.add_argument('--resume-after-update', action='store_true')
    parser.add_argument('--prepare-adoption', action='store_true')
    parser.add_argument('--hold-adoption', action='store_true')
    args = parser.parse_args()
    values = read_values(args.env_file)
    credentials = cloudflare_credentials(args.credentials_file)
    state = read_state(state_path(args.env_file), values, credentials['account_id'])
    if not state or (not state.get('deployed') and not (args.prepare_adoption or args.hold_adoption)):
        raise ValueError('COMMUNICATION_NOT_INSTALLED')
    token = credentials['token']
    transport_options = options(credentials.get('ip_family'))
    marker = Path(args.env_file).resolve().parent / 'communication-maintenance.json'
    if args.prepare_adoption:
        prepare_adoption(marker, state, values, token, **transport_options)
        return
    if args.hold_adoption:
        hold_adoption(marker, state, token, **transport_options)
        return
    if args.resume_after_update:
        resume(marker, state, token, **transport_options)
        return
    if marker.exists():
        raise ValueError('COMMUNICATION_MAINTENANCE_RECONCILIATION_REQUIRED')
    if not args.config:
        raise ValueError('COMMUNICATION_BACKUP_CONFIG_REQUIRED')
    row = query(state, token, 'SELECT pause_outbound FROM fagoo_runtime WHERE id=1', **transport_options)
    if len(row) != 1 or row[0]['pause_outbound'] not in (0, 1):
        raise ValueError('COMMUNICATION_PAUSE_UNAVAILABLE')
    destination = Path(args.env_file).resolve().parent.parent / 'backups' / ('communication-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    destination.mkdir(parents=True, mode=0o700)
    record = {'format': 1, 'account_id': state['account_id'], 'database_id': state['database_id'],
              'previous_pause': row[0]['pause_outbound'], 'backup': str(destination), 'backup_complete': False,
              'durable_webhooks': True, 'engine_data_rollback': 'never-overwrite-live-database'}
    private_write(marker, record)
    query(state, token, 'UPDATE fagoo_runtime SET pause_outbound=1,updated=? WHERE id=1', [int(time.time() * 1000)], **transport_options)
    try:
        deadline = time.monotonic() + 180
        while not quiescent(state, token, **transport_options):
            if time.monotonic() > deadline:
                raise ValueError('COMMUNICATION_INFLIGHT_OPERATIONS_REQUIRE_RECONCILIATION')
            time.sleep(2)
        # Secrets are backed up privately, never placed in the signed public source archive.
        private_write(destination / 'installation.json', state)
        private_write(destination / 'cloudflare-credentials.json', credentials)
        env = node_environment({**os.environ, 'CLOUDFLARE_API_TOKEN': token, 'CLOUDFLARE_ACCOUNT_ID': state['account_id'], 'WRANGLER_SEND_METRICS': 'false'}, **transport_options)
        subprocess.run(['node', str(ROOT / 'workers/communication/scripts/backup.mjs'), args.config, str(destination)],
                       env=env, stdin=subprocess.DEVNULL, check=True, timeout=3600)
        record['backup_manifest_sha256'] = verify_backup(destination)
        record['backup_complete'] = True
        private_write(marker, record)
        private_write(destination / 'recovery.json', record)
        if not args.hold:
            resume(marker, state, token, **transport_options)
        print('Communication backup verified; durable webhook reception remains active.')
    except Exception:
        # Before an update starts, an incomplete copy must not strand a working installation.
        if not record['backup_complete']:
            query(state, token, 'UPDATE fagoo_runtime SET pause_outbound=?,updated=? WHERE id=1', [record['previous_pause'], int(time.time() * 1000)], **transport_options)
            marker.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    main()
