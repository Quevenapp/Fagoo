"""Connect a dashboard-managed tunnel with an exclusive private token file and systemd unit.

Official CLI contract (cloudflared >= 2025.4.0):
https://developers.cloudflare.com/tunnel/reference/run-parameters/
Token format: https://github.com/cloudflare/cloudflared/blob/master/connection/connection.go
No token is passed in process arguments, unit text, environment variables or logs.
"""
import argparse
import base64
import binascii
import getpass
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
import warnings

SERVICE = 'fagoo-cloudflared.service'
TOKEN_DIR = Path('/etc/fagoo/cloudflared')
UNIT_PATH = Path('/etc/systemd/system') / SERVICE
METRICS_PORT = 20241


def extract_token(pasted, expected_id=None):
    """Accept a token or the two exact dashboard command forms; never execute them."""
    if not isinstance(pasted, str) or len(pasted) > 16384:
        raise ValueError('TUNNEL_INPUT_INVALID')
    try:
        words = shlex.split(pasted.strip())
        if words[:1] == ['sudo']:
            words = words[1:]
        if len(words) == 1:
            token = words[0]
        elif len(words) == 4 and words[:3] == ['cloudflared', 'service', 'install']:
            token = words[3]
        elif len(words) == 5 and words[:4] == ['cloudflared', 'tunnel', 'run', '--token']:
            token = words[4]
        else:
            raise ValueError('TUNNEL_COMMAND_NOT_SUPPORTED')
        if not 80 <= len(token) <= 12000 or not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', token):
            raise ValueError('TUNNEL_TOKEN_INVALID')
        data = json.loads(base64.b64decode(token, validate=True))
        actual_id = str(uuid.UUID(data['t']))
        if actual_id == str(uuid.UUID(int=0)) or not re.fullmatch(r'[a-fA-F0-9]{32}', data['a']):
            raise ValueError('TUNNEL_TOKEN_INVALID')
        secret = base64.b64decode(data['s'], validate=True)
        if not 16 <= len(secret) <= 128:
            raise ValueError('TUNNEL_TOKEN_INVALID')
        if expected_id is not None and actual_id != str(uuid.UUID(expected_id)):
            raise ValueError('TUNNEL_ID_MISMATCH')
        return token, actual_id
    except (TypeError, KeyError, json.JSONDecodeError, binascii.Error, UnicodeDecodeError):
        raise ValueError('TUNNEL_TOKEN_INVALID') from None


def unit_text(binary, token_path):
    # Fixed paths in production. Refuse systemd expansion/control characters.
    if any(not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) for path in [binary, token_path]):
        raise ValueError('TUNNEL_PATH_INVALID')
    return f'''[Unit]
Description=FAGOO Cloudflare Tunnel connector
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
TimeoutStartSec=90
ExecStart={binary} --no-autoupdate tunnel --metrics 127.0.0.1:{METRICS_PORT} run --token-file {token_path}
Restart=on-failure
RestartSec=5
UMask=0077
UnsetEnvironment=TUNNEL_TOKEN TUNNEL_TOKEN_FILE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# Keep connector output out of the terminal and journal. Inspect status and /ready.
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
'''


def create_configuration(token, binary, token_dir=TOKEN_DIR, unit_path=UNIT_PATH):
    token_dir, unit_path = Path(token_dir), Path(unit_path)
    if token_dir.exists() or token_dir.is_symlink() or unit_path.exists() or unit_path.is_symlink():
        raise ValueError('TUNNEL_CONFIGURATION_EXISTS')
    content = unit_text(binary, token_dir / 'token')
    token_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_dir.mkdir(mode=0o700)
    # Keep partial files after an I/O failure for explicit inspection; never
    # overwrite/delete credentials or adopt somebody else's systemd unit.
    with os.fdopen(os.open(token_dir / 'token', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='ascii', newline='\n') as output:
        output.write(token + '\n')
    with os.fdopen(os.open(unit_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644), 'w', encoding='utf-8', newline='\n') as output:
        output.write(content)


def command(args, timeout=15, check=True):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise ValueError('TUNNEL_SERVICE_OPERATION_FAILED')
    return result


def preflight():
    if os.name != 'posix' or os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
        raise ValueError('ROOT_SYSTEMD_LINUX_REQUIRED')
    if not sys.stdin.isatty():
        raise ValueError('PRIVATE_TERMINAL_REQUIRED')
    if TOKEN_DIR.exists() or TOKEN_DIR.is_symlink() or UNIT_PATH.exists() or UNIT_PATH.is_symlink():
        raise ValueError('TUNNEL_CONFIGURATION_EXISTS')
    binary = shutil.which('cloudflared')
    if not binary or '--token-file' not in command([binary, 'tunnel', 'run', '--help']).stdout.decode('utf-8', errors='replace'):
        raise ValueError('CLOUDFLARED_TOKEN_FILE_REQUIRED')
    state = command(['systemctl', 'show', SERVICE, '--property=LoadState', '--value']).stdout.decode().strip()
    if state != 'not-found':
        raise ValueError('TUNNEL_SERVICE_EXISTS')
    # The metrics endpoint is loopback-only and used for a non-secret readiness check.
    import socket
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', METRICS_PORT))
        except OSError:
            raise ValueError('TUNNEL_METRICS_PORT_BUSY') from None
    with urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=5) as response:
        if response.status != 200:
            raise ValueError('FAGOO_LOCAL_GATEWAY_NOT_READY')
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tunnel-id', help='Optional UUID shown in the Cloudflare dashboard; never a token.')
    args = parser.parse_args()
    try:
        expected_id = str(uuid.UUID(args.tunnel_id)) if args.tunnel_id else None
        binary = preflight()
        warnings.simplefilter('error', getpass.GetPassWarning)
        pasted = getpass.getpass('Paste the tunnel token or the copied cloudflared command (hidden): ')
        token, _ = extract_token(pasted, expected_id)
        create_configuration(token, binary)
        del pasted, token
        command(['systemctl', 'daemon-reload'])
        print('Starting the tunnel connector. This can take up to 90 seconds.', flush=True)
        command(['systemctl', 'enable', '--now', SERVICE], timeout=100)
        command(['systemctl', 'is-active', '--quiet', SERVICE])
        with urllib.request.urlopen(f'http://127.0.0.1:{METRICS_PORT}/ready', timeout=5) as response:
            if response.status != 200:
                raise ValueError('TUNNEL_NOT_READY')
        print('Tunnel connected. Confirm Healthy in the dashboard and save its public hostname route.')
    except (ValueError, OSError, urllib.error.URLError, subprocess.TimeoutExpired, getpass.GetPassWarning) as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'TUNNEL_SETUP_FAILED'
        print(code + ': no secret was displayed. Existing files were preserved; inspect service state before recovery.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
