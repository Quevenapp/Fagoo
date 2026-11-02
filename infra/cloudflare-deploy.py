#!/usr/bin/env python3
"""Deploy prebuilt web assets only after explicit client configuration."""
import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def configuration(home):
    config = json.loads((home / 'cloudflare.json').read_text())
    if not re.fullmatch('[a-f0-9]{32}', config.get('account_id', '')):
        raise ValueError('INVALID_CLOUDFLARE_ACCOUNT')
    if not re.fullmatch('[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]', config.get('hostname', '')) or '..' in config['hostname']:
        raise ValueError('INVALID_PUBLIC_HOSTNAME')
    origin = urlsplit(config.get('api_origin', ''))
    if origin.scheme != 'https' or not origin.hostname or origin.hostname == config['hostname'] or origin.path not in ('', '/') or origin.query or origin.fragment or origin.username or origin.password:
        raise ValueError('INVALID_API_ORIGIN')
    if not re.fullmatch('fagoo-web-[a-f0-9]{12}', config.get('worker_name', '')):
        raise ValueError('INVALID_WORKER_NAME')
    return config


def deploy(home, release, apply=False, image=None):
    config = configuration(home)
    source = release / 'apps/web'
    if not (source / 'dist/index.html').is_file() or not (source / 'worker.mjs').is_file():
        raise ValueError('BUILT_WEB_ARTIFACTS_MISSING')
    if image is None:
        values = dict(line.split('=', 1) for line in (home / 'config.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
        image = values['FAGOO_IMAGE']
    if not re.fullmatch(r'((?:ghcr\.io/quevenapp/fagoo@)?sha256:[a-f0-9]{64}|fagoo/local:source-[0-9TZ]+)', image):
        raise ValueError('INVALID_DEPLOYMENT_RUNTIME_IMAGE')
    token_file, secrets_file = home / 'secrets/cloudflare.env', home / 'secrets/cloudflare-worker.json'
    if not token_file.is_file() or not secrets_file.is_file():
        raise ValueError('CLOUDFLARE_CREDENTIALS_NOT_CONFIGURED')
    with tempfile.TemporaryDirectory(prefix='web-deploy-', dir=home / 'state') as folder:
        work = Path(folder)
        shutil.copytree(source / 'dist', work / 'dist')
        shutil.copyfile(source / 'worker.mjs', work / 'worker.mjs')
        shutil.copyfile(secrets_file, work / 'secrets.json')
        wrangler = {'name': config['worker_name'], 'account_id': config['account_id'], 'main': 'worker.mjs',
                    'compatibility_date': '2026-10-01', 'workers_dev': False,
                    'assets': {'directory': './dist', 'binding': 'ASSETS', 'not_found_handling': 'single-page-application', 'run_worker_first': True},
                    'routes': [{'pattern': config['hostname'], 'custom_domain': True}],
                    'vars': {'FAGOO_API_ORIGIN': config['api_origin']}}
        (work / 'wrangler.json').write_text(json.dumps(wrangler))
        command = ['docker', 'run', '--rm', '--user', '0', '--memory', '768m', '--cpus', '1', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                   '--env-file', str(token_file), '--mount', f'type=bind,source={work},target=/deployment', '--workdir', '/deployment', '--entrypoint', 'node', image,
                   '/opt/fagoo-deployer/node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', '/deployment/wrangler.json', '--secrets-file', '/deployment/secrets.json', '--no-bundle']
        if not apply:
            command.append('--dry-run')
        subprocess.run(command, check=True, timeout=600)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Client-configured Cloudflare deployment; defaults to dry run.')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--release', type=Path)
    arguments = parser.parse_args()
    installation = Path(os.environ.get('FAGOO_HOME', '/opt/fagoo')).resolve()
    deploy(installation, (arguments.release or installation / 'current').resolve(), arguments.apply, os.environ.get('FAGOO_IMAGE'))
