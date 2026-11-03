#!/usr/bin/env python3
"""Save or renew a scoped Cloudflare publication token without rebuilding the application."""
import argparse
import importlib.util
import os
from pathlib import Path

from release_protocol import atomic_json
from update_config import cloudflare_credentials, read_values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--account-id')
    parser.add_argument('--zone-id')
    args = parser.parse_args()
    if os.name != 'posix' or os.geteuid() != 0:
        raise SystemExit('Run with sudo on the Ubuntu server.')
    root = Path(args.root).resolve()
    destination = root / 'private/install/cloudflare/credentials.json'
    saved = cloudflare_credentials(destination) if destination.exists() else {}
    account, zone = args.account_id or saved.get('account_id'), args.zone_id or saved.get('zone_id')
    if not account or not zone:
        raise SystemExit('Supply --account-id and --zone-id from the installation Cloudflare account.')
    spec = importlib.util.spec_from_file_location('publication', Path(__file__).with_name('deploy-application.py'))
    publish = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publish)
    configs = publish.configurations(read_values(root / 'private/install/.env'), account, zone)
    token = publish.read_token()
    publish.check_domains(configs, account, zone, token)
    atomic_json(destination, {'account_id': account, 'zone_id': zone, 'token': token})
    print('Cloudflare publication credential validated and saved privately. No application was published.')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        raise SystemExit('UPDATE_CREDENTIAL_NOT_SAVED: check token permissions, account, zone and network.') from None
