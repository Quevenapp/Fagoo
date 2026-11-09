#!/usr/bin/env python3
"""Install the local update service after the runtime has been configured."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile

from release_protocol import atomic_json
from update_config import read_values, source_identity
from installation_scope import installation_scope

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = '''import argparse,json,os
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',required=True);a=p.parse_args()
r=Path(a.root).resolve();s=r/'private/updates/installed.json'
source=Path(json.loads(s.read_text())['source_dir']).resolve() if s.exists() else r
if source!=r and not source.is_relative_to(r/'private/updates/releases'):raise SystemExit('INVALID_UPDATE_SOURCE')
os.execv('/usr/bin/python3',['/usr/bin/python3',str(source/'infra/update_agent.py'),'--root',str(r)])
'''


def private_text(path, text):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            output.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def prepare(root):
    root = Path(root).resolve()
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(root)):
        raise ValueError('INSTALLATION_PATH_INVALID')
    env = root / 'private/install/.env'
    values = read_values(env)
    installation_scope(values)
    directory = root / 'private/update-service'
    run = directory / 'run'
    run.mkdir(parents=True, exist_ok=True, mode=0o700)
    text = env.read_text(encoding='utf-8')
    if 'FAGOO_UPDATE_AGENT_TOKEN' not in values:
        text += '\nFAGOO_UPDATE_AGENT_TOKEN=' + secrets.token_hex(32) + '\n'
    if 'FAGOO_UPDATE_SOCKET_DIR' not in values:
        text += 'FAGOO_UPDATE_SOCKET_DIR=' + str(run) + '\n'
    elif values['FAGOO_UPDATE_SOCKET_DIR'] != str(run):
        raise ValueError('UPDATE_SOCKET_ROOT_MISMATCH')
    private_text(env, text)
    public_key = directory / 'release-root.pem'
    source_key = root / 'infra/release-root.pem'
    if public_key.exists() and public_key.read_bytes() != source_key.read_bytes():
        raise ValueError('PINNED_RELEASE_KEY_CHANGED')
    if not public_key.exists():
        shutil.copyfile(source_key, public_key)
        os.chmod(public_key, 0o600)
    private_text(directory / 'launch.py', LAUNCHER)
    installed = root / 'private/updates/installed.json'
    if not installed.exists():
        atomic_json(installed, {**source_identity(root), 'source_dir': str(root), 'database_major': 17})
    quote = lambda path: json.dumps(str(path))
    return f'''[Unit]
Description=FAGOO signed release updater
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
UMask=0077
WorkingDirectory={root}
ExecStart=/usr/bin/python3 {quote(directory / 'launch.py')} --root {quote(root)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths={quote(root)}
Environment=NPM_CONFIG_CACHE={root}/private/updates/npm-cache
Environment=NPM_CONFIG_USERCONFIG=/dev/null
Environment=XDG_CONFIG_HOME={directory}/config
Nice=5

[Install]
WantedBy=multi-user.target
'''


def write_service_unit(path, content, root):
    """An existing service belongs to this exact installation, or it cannot be replaced."""
    path = Path(path)
    if path.is_symlink() or (path.exists() and '\nWorkingDirectory=' + str(root) + '\n' not in path.read_text(encoding='utf-8')):
        raise ValueError('UPDATE_SERVICE_BELONGS_TO_ANOTHER_INSTALLATION')
    private_text(path, content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(ROOT))
    args = parser.parse_args()
    if os.name != 'posix' or os.geteuid() != 0:
        raise SystemExit('Run with sudo on the Ubuntu server.')
    unit = prepare(args.root)
    root = Path(args.root).resolve()
    service = installation_scope(read_values(root / 'private/install/.env'))['updater_service']
    unit_path = Path('/etc/systemd/system') / service
    write_service_unit(unit_path, unit, root)
    subprocess.run(['systemd-analyze', 'verify', str(unit_path)], check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', service], check=True)
    subprocess.run(['systemctl', 'restart', service], check=True)
    subprocess.run(['systemctl', 'is-active', '--quiet', service], check=True)
    print('FAGOO update service installed. Publish the application to activate the administrator panel.')


if __name__ == '__main__':
    os.umask(0o077)
    main()
