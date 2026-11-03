"""Build and publish the original ERP frontend/API using this installation's private configuration."""
import argparse
import base64
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import warnings

from configure import origin

ROOT = Path(__file__).resolve().parents[1]


def configuration(path):
    values = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in values or not re.fullmatch('[A-Z][A-Z0-9_]*', key):
            raise ValueError('RUNTIME_CONFIGURATION_INVALID')
        values[key] = value
    for key in ('FAGOO_WEB_ORIGIN', 'FAGOO_API_ORIGIN', 'FAGOO_BACKEND_ORIGIN'):
        values[key] = origin(values[key])
    if len({values[key] for key in ('FAGOO_WEB_ORIGIN', 'FAGOO_API_ORIGIN', 'FAGOO_BACKEND_ORIGIN')}) != 3:
        raise ValueError('THREE_DISTINCT_ORIGINS_REQUIRED')
    for key, role in (('ANON_KEY', 'anon'), ('SERVICE_ROLE_KEY', 'service_role')):
        parts = values[key].split('.')
        if len(parts) != 3 or any(not re.fullmatch('[A-Za-z0-9_-]+', part) for part in parts):
            raise ValueError('RUNTIME_KEY_INVALID')
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        if payload.get('role') != role:
            raise ValueError('RUNTIME_KEY_ROLE_INVALID')
    for key in ('JWT_SECRET', 'POSTGRES_PASSWORD'):
        if len(values.get(key, '')) < 32:
            raise ValueError('RUNTIME_SECRET_MISSING')
    return values


def public_environment(values):
    return {
        'VITE_SUPABASE_DEPLOYMENT': 'self-hosted',
        'VITE_SUPABASE_URL': values['FAGOO_BACKEND_ORIGIN'],
        'VITE_SUPABASE_ANON_KEY': values['ANON_KEY'],
        'VITE_SUPABASE_PUBLISHABLE_KEY': '',
        'VITE_ERP_API_URL': values['FAGOO_API_ORIGIN'],
        'VITE_A1_API_URL': '',
    }


def process_environment(source=None):
    # Build children never receive infrastructure credentials or inherited VITE overrides.
    source = os.environ if source is None else source
    blocked = re.compile(r'TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|^VITE_|^SUPABASE_|^CLOUDFLARE_|^CF_|^FAGOO_|^PG|^WRANGLER_|^WORKERS_CI_', re.I)
    result = {key: value for key, value in source.items() if not blocked.search(key)}
    result.update({'CI': 'true', 'NO_COLOR': '1', 'WRANGLER_SEND_METRICS': 'false'})
    return result


def read_token():
    # getpass normally falls back to an echoed input stream when no terminal is
    # available. Refuse that fallback, especially during recorded installation.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            value = getpass.getpass('Cloudflare API token (hidden; not saved): ').strip()
    except (getpass.GetPassWarning, EOFError):
        raise ValueError('CLOUDFLARE_TOKEN_REQUIRES_PRIVATE_TERMINAL') from None
    if not 20 <= len(value) <= 512 or re.search(r'\s', value):
        raise ValueError('CLOUDFLARE_TOKEN_INVALID')
    return value


def configurations(values, account_id, zone_id):
    if not re.fullmatch('[a-f0-9]{32}', account_id) or not re.fullmatch('[a-f0-9]{32}', zone_id):
        raise ValueError('CLOUDFLARE_IDENTIFIERS_INVALID')
    history_enabled = values.get('ORIGIN_HISTORY_ENABLED', 'false')
    if history_enabled not in ('true', 'false'):
        raise ValueError('ORIGIN_HISTORY_CONFIGURATION_INVALID')
    suffix = hashlib.sha256(values['FAGOO_WEB_ORIGIN'].encode()).hexdigest()[:12]
    common = {'account_id': account_id, 'compatibility_date': '2026-10-15',
              'workers_dev': False, 'preview_urls': False, 'observability': {'enabled': False}}
    api = {**common, 'name': 'fagoo-api-' + suffix,
           'main': str(ROOT / 'workers/erp-api/src/index.mjs'),
           'compatibility_flags': ['enable_request_signal'],
           'routes': [{'pattern': urllib.parse.urlsplit(values['FAGOO_API_ORIGIN']).hostname,
                       'custom_domain': True, 'zone_id': zone_id}],
           'vars': {'BACKUP_IMPORT_ENABLED': 'false', 'SUPABASE_DEPLOYMENT': 'self-hosted',
                    'SUPABASE_URL': values['FAGOO_BACKEND_ORIGIN'], 'ALLOWED_ORIGINS': values['FAGOO_WEB_ORIGIN'],
                    'ERP_SCHEDULED_TASKS_ENABLED': 'false', 'ORIGIN_ENABLED': 'false', 'ORIGIN_TWO_WAY_ENABLED': 'false',
                    'ORIGIN_HISTORY_ENABLED': history_enabled}}
    web = {**common, 'name': 'fagoo-web-' + suffix,
           'routes': [{'pattern': urllib.parse.urlsplit(values['FAGOO_WEB_ORIGIN']).hostname,
                       'custom_domain': True, 'zone_id': zone_id}],
           'assets': {'directory': str(ROOT / 'apps/erp/dist'), 'not_found_handling': 'single-page-application'}}
    return api, web


def write_private(path, value):
    # Replace only this helper's generated files; never the runtime configuration.
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            json.dump(value, output, indent=2)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ValueError('CLOUDFLARE_REDIRECT_REFUSED')


def cloudflare_get(path, token):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path,
                                     headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=30) as response:
        raw = response.read(3 * 1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 3 * 1024 * 1024:
            raise ValueError('CLOUDFLARE_PREFLIGHT_FAILED')
        result = json.loads(raw)
    if result.get('success') is not True or 'result' not in result:
        raise ValueError('CLOUDFLARE_PREFLIGHT_FAILED')
    return result


def check_domains(configs, account_id, zone_id, token, get=cloudflare_get):
    # Wrangler's non-interactive deploy replaces conflicting DNS automatically.
    # Refuse that situation before upload instead of relying on a hidden prompt.
    zone = get('/zones/' + zone_id, token)['result']
    if zone.get('account', {}).get('id') != account_id or not zone.get('name'):
        raise ValueError('CLOUDFLARE_ZONE_ACCOUNT_MISMATCH')
    domain_response = get('/accounts/' + account_id + '/workers/domains', token)
    domains = domain_response['result']
    if not isinstance(domains, list) or domain_response.get('result_info', {}).get('total_count', len(domains)) > len(domains):
        raise ValueError('CLOUDFLARE_DOMAIN_LIST_INCOMPLETE')
    for config in configs:
        hostname = config['routes'][0]['pattern']
        if hostname != zone['name'] and not hostname.endswith('.' + zone['name']):
            raise ValueError('APPLICATION_HOST_OUTSIDE_ZONE')
        linked = [domain for domain in domains if domain.get('hostname') == hostname]
        if len(linked) > 1 or any(domain.get('service') != config['name'] or domain.get('zone_id') != zone_id for domain in linked):
            raise ValueError('CUSTOM_DOMAIN_BELONGS_TO_ANOTHER_WORKER')
        if not linked:
            query = urllib.parse.urlencode({'name': hostname, 'per_page': 100, 'page': 1})
            records = get('/zones/' + zone_id + '/dns_records?' + query, token)['result']
            if not isinstance(records, list):
                raise ValueError('CLOUDFLARE_DNS_RESPONSE_INVALID')
            if records:
                raise ValueError('CUSTOM_DOMAIN_DNS_CONFLICT: remove only the intended web/API DNS records in the dashboard, then retry')


def inspect_build(directory, secrets):
    directory = Path(directory)
    if not (directory / 'index.html').is_file():
        raise ValueError('PUBLIC_BUILD_ENTRY_MISSING')
    count = 0
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('PUBLIC_BUILD_SYMLINK_REFUSED')
        if path.is_file():
            count += 1
            content = path.read_bytes()
            if any(value and len(value) >= 12 and value.encode() in content for value in secrets):
                raise ValueError('PRIVATE_VALUE_IN_PUBLIC_BUILD')
    return count


def run(command, phase, env, log, secrets, cwd=ROOT):
    print(phase + '...', flush=True)
    result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=1800, check=False)
    text = result.stdout.decode('utf-8', errors='replace')
    for value in secrets:
        if value and len(value) >= 12:
            text = text.replace(value, '[redacted]')
    log.write('\n' + phase + '\n' + text)
    log.flush()
    if result.returncode:
        raise ValueError(phase + '_FAILED')
    print(phase + ': OK', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--zone-id', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--deploy', action='store_true')
    args = parser.parse_args()
    values = configuration(args.env_file)
    api, web = configurations(values, args.account_id, args.zone_id)
    directory = ROOT / 'private/install/cloudflare'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / 'deploy.lock'
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise ValueError('APPLICATION_DEPLOY_LOCK_EXISTS: inspect the running process before recovering a stale lock') from None
    secrets_path = None
    token = ''
    private_values = [values[key] for key in ('SERVICE_ROLE_KEY', 'JWT_SECRET', 'POSTGRES_PASSWORD')]
    log_path = directory / ('deploy-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.log')
    try:
        api_path, web_path = directory / 'erp-api.json', directory / 'erp-web.json'
        write_private(api_path, api)
        write_private(web_path, web)
        node, npm = 'node', ('npm.cmd' if os.name == 'nt' else 'npm')
        wrangler = ROOT / 'node_modules/wrangler/bin/wrangler.js'
        if not wrangler.is_file():
            raise ValueError('DEPENDENCIES_REQUIRED: run npm run install:deployment in the repository first')
        env = process_environment()
        public = {**env, **public_environment(values)}
        with os.fdopen(os.open(log_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w', encoding='utf-8') as log:
            try:
                run([node, str(ROOT / 'tools/deployment/install-dependencies.mjs'), '--check'], 'DEPENDENCIES_CHECK', env, log, private_values)
            except ValueError:
                raise ValueError('DEPENDENCIES_REQUIRED: run npm run install:deployment in the repository first') from None
            run([npm, 'run', 'build:erp'], 'ERP_BUILD', public, log, private_values)
            run([npm, 'run', 'check:erp:build'], 'ERP_BUILD_CHECK', env, log, private_values)
            count = inspect_build(ROOT / 'apps/erp/dist', private_values)
            print(f'Public build checked: {count} files; no installation secrets found.', flush=True)
            for path, name in ((api_path, 'API_PACKAGE'), (web_path, 'WEB_PACKAGE')):
                run([node, str(wrangler), 'deploy', '--config', str(path), '--dry-run', '--outdir', str(directory / name.lower())], name, env, log, private_values)
            if args.deploy:
                token = read_token()
                private_values.append(token)
                check_domains((api, web), args.account_id, args.zone_id, token)
                descriptor, temporary = tempfile.mkstemp(prefix='api-secrets-', suffix='.json', dir=directory)
                secrets_path = Path(temporary)
                with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                    json.dump({'SUPABASE_SERVICE_ROLE_KEY': values['SERVICE_ROLE_KEY']}, output)
                deploy_env = {**env, 'CLOUDFLARE_API_TOKEN': token, 'CLOUDFLARE_ACCOUNT_ID': args.account_id}
                run([node, str(wrangler), 'deploy', '--config', str(api_path), '--secrets-file', str(secrets_path)], 'API_DEPLOY', deploy_env, log, private_values)
                check_domains((web,), args.account_id, args.zone_id, token)
                run([node, str(wrangler), 'deploy', '--config', str(web_path)], 'WEB_DEPLOY', deploy_env, log, private_values)
        print(('Application published.' if args.deploy else 'Dry run passed; nothing was published.') + ' Fiscal runtime and SMTP are separate setup steps.')
        print('Web: ' + values['FAGOO_WEB_ORIGIN'])
        print('API: ' + values['FAGOO_API_ORIGIN'])
        print('Private diagnostic log: ' + str(log_path))
    except Exception:
        print('Application workflow did not complete. A successful earlier deployment is not rolled back automatically.')
        print('Private diagnostic log: ' + str(log_path))
        raise
    finally:
        if secrets_path is not None:
            secrets_path.unlink(missing_ok=True)
        lock.rmdir()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, urllib.error.URLError, subprocess.SubprocessError) as error:
        # Standard-library errors may contain input fragments. Only our fixed
        # upper-case diagnostic codes are eligible for display.
        message = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z][A-Z0-9_]+(?:: [a-zA-Z0-9 /:;,.-]+)?', str(error)) else 'APPLICATION_DEPLOY_FAILED: inspect the private log and configuration'
        raise SystemExit(message)
