#!/usr/bin/env python3
"""Configure an existing private R2 bucket. Credentials are never command arguments."""
import argparse
import getpass
import json
import os
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--account-id', required=True)
parser.add_argument('--bucket', required=True)
args = parser.parse_args()
if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{32}', args.account_id) or not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', args.bucket):
    raise ValueError('ROOT_AND_VALID_ACCOUNT_BUCKET_REQUIRED')
home = Path(os.environ.get('FAGOO_HOME', '/opt/fagoo')).resolve()
if home != Path('/opt/fagoo') or not (home / 'config.env').is_file():
    raise ValueError('FAGOO_INSTALLATION_REQUIRED')
key = getpass.getpass('R2 access key ID: ')
secret = getpass.getpass('R2 secret access key: ')
if not key or not secret or any(c.isspace() for c in key + secret):
    raise ValueError('INVALID_R2_CREDENTIALS')
subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', 'rclone'], check=True)
path = home / 'secrets/rclone.conf'
path.write_text(f'[fagoo]\ntype = s3\nprovider = Cloudflare\naccess_key_id = {key}\nsecret_access_key = {secret}\nendpoint = https://{args.account_id}.r2.cloudflarestorage.com\nregion = auto\n')
path.chmod(0o600)
subprocess.run(['rclone', 'lsf', f'fagoo:{args.bucket}', '--max-depth', '1', '--config', str(path)], check=True, stdout=subprocess.DEVNULL)
settings = home / 'backup.json'
settings.write_text(json.dumps({'bucket': args.bucket}))
settings.chmod(0o600)
subprocess.run(['bash', str(home / 'current/scripts/backup.sh')], check=True)
print('Initial database backup uploaded to the configured private bucket.')
