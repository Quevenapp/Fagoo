"""Private configuration shared by the installer, publisher and update service."""
import json
import os
from pathlib import Path
import re


def read_values(path):
    values = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in values or not re.fullmatch('[A-Z][A-Z0-9_]*', key):
            raise ValueError('RUNTIME_CONFIGURATION_INVALID')
        values[key] = value
    return values


def cloudflare_credentials(path, account=None, zone=None):
    path = Path(path)
    if path.is_symlink() or (os.name != 'nt' and path.stat().st_mode & 0o077):
        raise ValueError('CLOUDFLARE_CREDENTIAL_PERMISSIONS')
    value = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(value, dict) or not re.fullmatch('[a-f0-9]{32}', str(value.get('account_id', '')))
            or not re.fullmatch('[a-f0-9]{32}', str(value.get('zone_id', '')))
            or not isinstance(value.get('token'), str) or not 20 <= len(value['token']) <= 512 or re.search(r'\s', value['token'])):
        raise ValueError('CLOUDFLARE_CREDENTIALS_INVALID')
    if (account and value['account_id'] != account) or (zone and value['zone_id'] != zone):
        raise ValueError('CLOUDFLARE_CREDENTIAL_SCOPE_MISMATCH')
    return value


def source_identity(root):
    import subprocess
    root = Path(root)
    release = root / '.fagoo-release.json'
    if release.exists():
        value = json.loads(release.read_text())
        return {'version': value['version'], 'revision': value['source_commit']}
    version = 'v' + json.loads((root / 'package.json').read_text())['version']
    result = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=10)
    revision = result.stdout.strip()
    return {'version': version, 'revision': revision if re.fullmatch('[a-f0-9]{40}', revision) else None}
