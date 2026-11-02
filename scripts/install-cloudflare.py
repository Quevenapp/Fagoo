#!/usr/bin/env python3
"""Client-side Cloudflare configuration. No remote mutation without --apply."""
import argparse
import base64
import getpass
import json
import os
import re
import secrets
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def write_private(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.new')
    temporary.write_text(content)
    temporary.chmod(0o600)
    os.replace(temporary, path)


def api(token, path, method='GET', value=None):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method=method,
                                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                                    data=None if value is None else json.dumps(value).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'CLOUDFLARE_HTTP_{error.code}') from None
    if not body.get('success'):
        raise RuntimeError('CLOUDFLARE_REQUEST_REJECTED')
    return body['result']


def configure(args):
    for value in (args.account_id, args.zone_id):
        if not re.fullmatch('[a-f0-9]{32}', value):
            raise ValueError('INVALID_ACCOUNT_OR_ZONE_ID')
    for hostname in (args.hostname, args.origin_hostname):
        if not re.fullmatch('[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]', hostname) or '..' in hostname:
            raise ValueError('INVALID_HOSTNAME')
    if args.hostname == args.origin_hostname:
        raise ValueError('PUBLIC_AND_ORIGIN_HOSTNAMES_MUST_DIFFER')
    if not args.apply:
        print(json.dumps({'apply': False, 'public_hostname': args.hostname, 'origin_hostname': args.origin_hostname,
                          'actions': ['Create dedicated tunnel', 'Configure ingress to api:3000', 'Create origin CNAME', 'Deploy prebuilt web Worker and public custom domain'],
                          'preserves_existing_services': True}, indent=2))
        return
    if os.geteuid() != 0:
        raise ValueError('ROOT_REQUIRED')
    home = Path(os.environ.get('FAGOO_HOME', '/opt/fagoo')).resolve()
    if home != Path('/opt/fagoo') or not (home / 'config.env').is_file():
        raise ValueError('FAGOO_INSTALLATION_REQUIRED')
    env_path = home / 'config.env'
    values = dict(line.split('=', 1) for line in env_path.read_text().splitlines() if '=' in line and not line.startswith('#'))
    if values.get('FAGOO_PUBLIC_URL') != 'https://' + args.hostname:
        raise ValueError('FAGOO_PUBLIC_URL_MUST_MATCH_PUBLIC_HOSTNAME')
    token = os.environ.get('CLOUDFLARE_API_TOKEN') or getpass.getpass('Cloudflare scoped API token: ')
    if not token or any(c.isspace() for c in token):
        raise ValueError('INVALID_TOKEN')
    zone = api(token, f'/zones/{args.zone_id}')
    if zone.get('account', {}).get('id') != args.account_id or not all(host.endswith('.' + zone['name']) or host == zone['name'] for host in (args.hostname, args.origin_hostname)):
        raise ValueError('ZONE_ACCOUNT_OR_HOSTNAME_MISMATCH')
    marker = home / 'cloudflare.json'
    if marker.exists():
        config = json.loads(marker.read_text())
        expected = (args.account_id, args.zone_id, args.hostname, 'https://' + args.origin_hostname)
        if tuple(config.get(k) for k in ('account_id', 'zone_id', 'hostname', 'api_origin')) != expected:
            raise ValueError('EXISTING_CLOUDFLARE_CONFIGURATION_DIFFERS')
    else:
        existing = api(token, f'/zones/{args.zone_id}/dns_records?name=' + urllib.parse.quote(args.origin_hostname))
        if existing:
            raise ValueError('ORIGIN_DNS_ALREADY_EXISTS_NOT_OWNED_BY_THIS_INSTALLATION')
        public_records = api(token, f'/zones/{args.zone_id}/dns_records?name=' + urllib.parse.quote(args.hostname))
        if public_records:
            raise ValueError('PUBLIC_DNS_ALREADY_EXISTS_REVIEW_BEFORE_CONFIGURING')
        identifier = secrets.token_hex(6)
        tunnel = api(token, f'/accounts/{args.account_id}/cfd_tunnel', 'POST', {'name': 'fagoo-' + identifier, 'config_src': 'cloudflare', 'tunnel_secret': base64.b64encode(secrets.token_bytes(32)).decode()})
        config = {'account_id': args.account_id, 'zone_id': args.zone_id, 'hostname': args.hostname, 'api_origin': 'https://' + args.origin_hostname,
                  'worker_name': 'fagoo-web-' + identifier, 'tunnel_id': tunnel['id'], 'status': 'configuring'}
        write_private(marker, json.dumps(config, indent=2))
    tunnel_id = config['tunnel_id']
    if not re.fullmatch('[a-f0-9-]{36}', tunnel_id):
        raise ValueError('INVALID_TUNNEL_ID')
    api(token, f'/accounts/{args.account_id}/cfd_tunnel/{tunnel_id}/configurations', 'PUT', {'config': {'ingress': [
        {'hostname': args.origin_hostname, 'service': 'http://api:3000'}, {'service': 'http_status:404'}]}})
    target = tunnel_id + '.cfargotunnel.com'
    records = api(token, f'/zones/{args.zone_id}/dns_records?name=' + urllib.parse.quote(args.origin_hostname))
    if records and not (len(records) == 1 and records[0]['type'] == 'CNAME' and records[0]['content'] == target):
        raise ValueError('ORIGIN_DNS_CONFLICT')
    if not records:
        api(token, f'/zones/{args.zone_id}/dns_records', 'POST', {'type': 'CNAME', 'name': args.origin_hostname, 'content': target, 'proxied': True, 'ttl': 1})
    tunnel_token = api(token, f'/accounts/{args.account_id}/cfd_tunnel/{tunnel_id}/token')
    if not isinstance(tunnel_token, str) or any(c.isspace() for c in tunnel_token):
        raise ValueError('INVALID_TUNNEL_TOKEN')
    proxy_secret = values.get('FAGOO_PROXY_SECRET') or secrets.token_hex(32)
    values.update(FAGOO_PROXY_SECRET=proxy_secret, CLOUDFLARE_TUNNEL_TOKEN=tunnel_token)
    write_private(env_path, '\n'.join(f'{key}={value}' for key, value in values.items()) + '\n')
    write_private(home / 'secrets/cloudflare.env', f'CLOUDFLARE_API_TOKEN={token}\nCLOUDFLARE_ACCOUNT_ID={args.account_id}\nWRANGLER_SEND_METRICS=false\n')
    write_private(home / 'secrets/cloudflare-worker.json', json.dumps({'FAGOO_PROXY_SECRET': proxy_secret}))
    compose = ['docker', 'compose', '--project-name', 'fagoo', '--env-file', str(env_path), '-f', str(home / 'current/infra/compose.yaml')]
    subprocess.run(compose + ['up', '-d', '--wait', 'api'], check=True)
    subprocess.run(compose + ['--profile', 'edge', 'up', '-d', 'cloudflared'], check=True)
    subprocess.run(['python3', str(home / 'current/infra/cloudflare-deploy.py'), '--apply'], check=True)
    config['status'] = 'configured'
    write_private(marker, json.dumps(config, indent=2))
    print('Cloudflare configured for this installation. Existing services were not modified.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--zone-id', required=True)
    parser.add_argument('--hostname', required=True)
    parser.add_argument('--origin-hostname', required=True)
    parser.add_argument('--apply', action='store_true')
    configure(parser.parse_args())
