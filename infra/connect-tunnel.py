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
import stat
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
import warnings

from installation_scope import installation_scope
from update_config import read_values

SERVICE = 'fagoo-cloudflared.service'
TOKEN_DIR = Path('/etc/fagoo/cloudflared')
UNIT_PATH = Path('/etc/systemd/system') / SERVICE
METRICS_PORT = 20241


def configuration(env_file=None):
    # Older installs can run without a runtime file. An explicitly selected
    # missing file must fail, rather than silently target the default instance.
    path = Path(env_file if env_file is not None else 'private/install/.env')
    values = read_values(path) if env_file is not None or path.exists() else {}
    return installation_scope(values)


def extract_token(pasted, expected_id=None, expected_account=None):
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
        if expected_account is not None:
            if not isinstance(expected_account, str) or not re.fullmatch(r'[a-fA-F0-9]{32}', expected_account):
                raise ValueError('TUNNEL_ACCOUNT_INVALID')
            if data['a'].lower() != expected_account.lower():
                raise ValueError('TUNNEL_ACCOUNT_MISMATCH')
        return token, actual_id
    except (TypeError, KeyError, json.JSONDecodeError, binascii.Error, UnicodeDecodeError):
        raise ValueError('TUNNEL_TOKEN_INVALID') from None


def validate_token_file_stat(info):
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('TUNNEL_TOKEN_FILE_NOT_REGULAR')
    if info.st_uid != 0:
        raise ValueError('TUNNEL_TOKEN_FILE_OWNER')
    if stat.S_IMODE(info.st_mode) & ~0o600:
        raise ValueError('TUNNEL_TOKEN_FILE_PERMISSIONS')
    if not 80 <= info.st_size <= 12002:
        raise ValueError('TUNNEL_TOKEN_FILE_SIZE')


def read_token_file(path, expected_id=None, expected_account=None):
    """Read only a root-owned private regular file, without following symlinks.

    Open/fstat/read share one descriptor so a path replacement cannot substitute
    an unchecked file. Ancestor symlinks are also refused. The supplied file is
    preserved; the caller can remove its private transfer copy after readiness.
    """
    if sys.platform != 'linux' or os.name != 'posix' or os.geteuid() != 0 or not hasattr(os, 'O_NOFOLLOW'):
        raise ValueError('ROOT_LINUX_TOKEN_FILE_REQUIRED')
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.resolve(strict=True) != path:
        raise ValueError('TUNNEL_TOKEN_FILE_PATH')
    # Walk directories by descriptor with NOFOLLOW too, avoiding a symlink swap
    # in any ancestor between the path check and opening the final file.
    directory_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC
    parent = os.open(path.anchor, directory_flags)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, directory_flags, dir_fd=parent)
            os.close(parent)
            parent = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(descriptor)
        validate_token_file_stat(info)
        chunks, length = [], 0
        while True:
            chunk = os.read(descriptor, min(4096, 12003 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > 12002:
                raise ValueError('TUNNEL_TOKEN_FILE_SIZE')
        after = os.fstat(descriptor)
        if length != info.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            raise ValueError('TUNNEL_TOKEN_FILE_CHANGED')
        try:
            token = b''.join(chunks).decode('ascii').strip()
        except UnicodeDecodeError:
            raise ValueError('TUNNEL_TOKEN_INVALID') from None
        if not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', token):
            raise ValueError('TUNNEL_TOKEN_FILE_CONTENT')
        return extract_token(token, expected_id, expected_account)
    finally:
        os.close(descriptor)


def unit_text(binary, token_path, metrics_port=METRICS_PORT):
    # Fixed paths in production. Refuse systemd expansion/control characters.
    if any(not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) for path in [binary, token_path]):
        raise ValueError('TUNNEL_PATH_INVALID')
    metrics_port = installation_scope({'FAGOO_TUNNEL_METRICS_PORT': str(metrics_port)})['metrics_port']
    return f'''[Unit]
Description=FAGOO Cloudflare Tunnel connector
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
TimeoutStartSec=90
ExecStart={binary} --no-autoupdate tunnel --metrics 127.0.0.1:{metrics_port} run --token-file {token_path}
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


def secure_destination_directory(path, create=False):
    """Anchor every destination component to an owned directory descriptor."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('TUNNEL_DESTINATION_UNSAFE')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open(path.anchor, flags)
    try:
        for part in (None, *path.parts[1:]):
            if part is not None:
                try:
                    child = os.open(part, flags, dir_fd=current)
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, mode=0o700, dir_fd=current)
                    child = os.open(part, flags, dir_fd=current)
                os.close(current)
                current = child
            info = os.fstat(current)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('TUNNEL_DESTINATION_UNSAFE')
        result, current = current, None
        return result
    except OSError:
        raise ValueError('TUNNEL_DESTINATION_UNSAFE') from None
    finally:
        if current is not None:
            os.close(current)


def create_configuration(token, binary, token_dir=TOKEN_DIR, unit_path=UNIT_PATH, metrics_port=METRICS_PORT):
    token_dir, unit_path = Path(token_dir), Path(unit_path)
    if token_dir.exists() or token_dir.is_symlink() or unit_path.exists() or unit_path.is_symlink():
        raise ValueError('TUNNEL_CONFIGURATION_EXISTS')
    content = unit_text(binary, token_dir / 'token', metrics_port)
    if os.name == 'posix':
        # Linux installation writes through checked descriptors only. Refuse
        # unsafe ancestors on both destinations before writing either secret.
        unit_parent = secure_destination_directory(unit_path.parent)
        token_parent = token_fd = None
        try:
            token_parent = secure_destination_directory(token_dir.parent, create=True)
            os.mkdir(token_dir.name, mode=0o700, dir_fd=token_parent)
            token_fd = os.open(token_dir.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=token_parent)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
            with os.fdopen(os.open('token', flags, 0o600, dir_fd=token_fd), 'w', encoding='ascii', newline='\n') as output:
                output.write(token + '\n')
            with os.fdopen(os.open(unit_path.name, flags, 0o644, dir_fd=unit_parent), 'w', encoding='utf-8', newline='\n') as output:
                output.write(content)
        finally:
            for descriptor in (token_fd, token_parent, unit_parent):
                if descriptor is not None:
                    os.close(descriptor)
        return
    # Portable unit-test path; the executable preflight requires root Linux.
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


def preflight(scope=None, private_file=False):
    scope = scope if scope is not None else installation_scope({})
    token_dir = Path(scope['tunnel_token_dir'])
    unit_path = Path('/etc/systemd/system') / scope['tunnel_service']
    if os.name != 'posix' or os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
        raise ValueError('ROOT_SYSTEMD_LINUX_REQUIRED')
    if not private_file and not sys.stdin.isatty():
        raise ValueError('PRIVATE_TERMINAL_REQUIRED')
    if token_dir.exists() or token_dir.is_symlink() or unit_path.exists() or unit_path.is_symlink():
        raise ValueError('TUNNEL_CONFIGURATION_EXISTS')
    binary = shutil.which('cloudflared')
    if not binary or '--token-file' not in command([binary, 'tunnel', 'run', '--help']).stdout.decode('utf-8', errors='replace'):
        raise ValueError('CLOUDFLARED_TOKEN_FILE_REQUIRED')
    state = command(['systemctl', 'show', scope['tunnel_service'], '--property=LoadState', '--value']).stdout.decode().strip()
    if state != 'not-found':
        raise ValueError('TUNNEL_SERVICE_EXISTS')
    # The metrics endpoint is loopback-only and used for a non-secret readiness check.
    import socket
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', scope['metrics_port']))
        except OSError:
            raise ValueError('TUNNEL_METRICS_PORT_BUSY') from None
    with urllib.request.urlopen(f"http://127.0.0.1:{scope['local_port']}/healthz", timeout=5) as response:
        if response.status != 200:
            raise ValueError('FAGOO_LOCAL_GATEWAY_NOT_READY')
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', help='Private runtime configuration (default: private/install/.env, when present).')
    parser.add_argument('--tunnel-id', help='Optional UUID shown in the Cloudflare dashboard; never a token.')
    parser.add_argument('--account-id', help='Optional Cloudflare account ID to verify against the token.')
    parser.add_argument('--token-file', type=Path, help='Root-owned private regular file (0600 or stricter); allows SSH without a TTY. Never pass the token itself.')
    args = parser.parse_args()
    try:
        expected_id = str(uuid.UUID(args.tunnel_id)) if args.tunnel_id else None
        if args.account_id is not None and not re.fullmatch(r'[a-fA-F0-9]{32}', args.account_id):
            raise ValueError('TUNNEL_ACCOUNT_INVALID')
        scope = configuration(args.env_file)
        if args.token_file is not None:
            token, _ = read_token_file(args.token_file, expected_id, args.account_id)
            binary = preflight(scope, private_file=True)
        else:
            binary = preflight(scope)
            warnings.simplefilter('error', getpass.GetPassWarning)
            pasted = getpass.getpass('Paste the tunnel token or the copied cloudflared command (hidden): ')
            token, _ = extract_token(pasted, expected_id, args.account_id)
            del pasted
        create_configuration(token, binary, Path(scope['tunnel_token_dir']),
                             Path('/etc/systemd/system') / scope['tunnel_service'], scope['metrics_port'])
        del token
        command(['systemctl', 'daemon-reload'])
        print('Starting the tunnel connector. This can take up to 90 seconds.', flush=True)
        command(['systemctl', 'enable', '--now', scope['tunnel_service']], timeout=100)
        command(['systemctl', 'is-active', '--quiet', scope['tunnel_service']])
        with urllib.request.urlopen(f"http://127.0.0.1:{scope['metrics_port']}/ready", timeout=5) as response:
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
