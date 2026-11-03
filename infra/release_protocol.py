"""Public, signed FAGOO releases. This module never accepts an arbitrary download URL."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

PROTOCOL = 1
VERSION = re.compile(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-z0-9]+(?:[.-][a-z0-9]+)*))?\Z')
RELEASES = 'https://github.com/Quevenapp/Fagoo/releases'
HOSTS = {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
MAX_SOURCE = 64 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024


def digest_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def newer_version(candidate, current):
    if not isinstance(candidate, str) or not VERSION.fullmatch(candidate):
        raise ValueError('INVALID_RELEASE_VERSION')
    if not isinstance(current, str) or not VERSION.fullmatch(current):
        raise ValueError('INSTALLED_VERSION_UNKNOWN')
    def parts(version):
        numeric, _, suffix = version[1:].partition('-')
        return tuple(map(int, numeric.split('.'))), suffix.split('.') if suffix else None
    left, lp = parts(candidate)
    right, rp = parts(current)
    if left != right:
        return left > right
    if lp is None or rp is None:
        return lp is None and rp is not None
    for a, b in zip(lp, rp):
        if a == b:
            continue
        if a.isdigit() and b.isdigit():
            return int(a) > int(b)
        if a.isdigit() != b.isdigit():
            return not a.isdigit()
        return a > b
    return len(lp) > len(rp)


def validate_manifest(value):
    if not isinstance(value, dict) or value.get('format') != 2 or value.get('product') != 'fagoo':
        raise ValueError('UNSUPPORTED_RELEASE_FORMAT')
    if not isinstance(value.get('version'), str) or not VERSION.fullmatch(value['version']):
        raise ValueError('INVALID_RELEASE_VERSION')
    if value.get('minimum_updater') != PROTOCOL or value.get('platform') != 'ubuntu-24.04-amd64':
        raise ValueError('UPDATER_UPGRADE_REQUIRED')
    if type(value.get('database_major')) is not int or value['database_major'] != 17:
        raise ValueError('DATABASE_MAJOR_UPGRADE_REFUSED')
    if not re.fullmatch('[a-f0-9]{40}', str(value.get('source_commit', ''))):
        raise ValueError('INVALID_SOURCE_REVISION')
    if not isinstance(value.get('notes', ''), str) or len(value.get('notes', '')) > 6000:
        raise ValueError('INVALID_RELEASE_NOTES')
    artifact = value.get('artifact')
    if not isinstance(artifact, dict) or artifact.get('url') != f"{RELEASES}/download/{value['version']}/fagoo-source.tar.gz":
        raise ValueError('UNTRUSTED_ARTIFACT_URL')
    if not re.fullmatch('[a-f0-9]{64}', str(artifact.get('sha256', ''))) or type(artifact.get('size')) is not int or not 0 < artifact['size'] <= MAX_SOURCE:
        raise ValueError('INVALID_RELEASE_ARTIFACT')
    return value


def verify_manifest(manifest, signature, public_key):
    manifest, signature = Path(manifest), Path(signature)
    if manifest.stat().st_size > 16384 or signature.stat().st_size != 64:
        raise ValueError('INVALID_RELEASE_ENVELOPE')
    result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key),
                             '-rawin', '-in', str(manifest), '-sigfile', str(signature)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    if result.returncode:
        raise ValueError('INVALID_RELEASE_SIGNATURE')
    return validate_manifest(json.loads(manifest.read_text(encoding='utf-8')))


def validate_download_url(url):
    value = urllib.parse.urlsplit(url)
    if value.scheme != 'https' or value.hostname not in HOSTS or value.username or value.password or value.port not in (None, 443):
        raise ValueError('UNTRUSTED_DOWNLOAD_URL')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        validate_download_url(url)
        return super().redirect_request(request, response, code, message, headers, url)


def download(url, destination, limit):
    validate_download_url(url)
    started = time.monotonic()
    request = urllib.request.Request(url, headers={'User-Agent': 'FAGOO-updater/1', 'Accept': 'application/octet-stream'})
    with urllib.request.build_opener(SafeRedirect()).open(request, timeout=30) as response, Path(destination).open('wb') as output:
        size = 0
        while block := response.read(65536):
            size += len(block)
            if size > limit or time.monotonic() - started > 600:
                raise ValueError('RELEASE_DOWNLOAD_LIMIT')
            output.write(block)


def extract_release(archive, destination, manifest):
    archive, destination = Path(archive), Path(destination)
    artifact = manifest['artifact']
    if archive.stat().st_size != artifact['size'] or digest_file(archive) != artifact['sha256']:
        raise ValueError('INVALID_RELEASE_DIGEST')
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tarfile.open(archive, 'r:gz') as bundle:
        members, names, expanded = [], set(), 0
        for member in bundle:
            path = PurePosixPath(member.name)
            if (len(members) >= 20000 or path.is_absolute() or '..' in path.parts or '\\' in member.name or ':' in member.name
                    or not path.parts or path.parts[0] in ('.git', '.local', 'private', 'node_modules', '.cache', '.wrangler')
                    or not (member.isfile() or member.isdir()) or str(path) in names):
                raise ValueError('UNSAFE_RELEASE_PATH')
            expanded += member.size
            if expanded > MAX_EXPANDED:
                raise ValueError('RELEASE_EXPANSION_LIMIT')
            names.add(str(path))
            members.append(member)
        bundle.extractall(destination, members=members, filter='data')
    for required in ('infra/compose.yaml', 'infra/update_agent.py', 'infra/migrate.py', 'infra/deploy-application.py', 'package-lock.json', 'apps/erp/src/App.tsx'):
        if not (destination / required).is_file():
            raise ValueError('INCOMPLETE_RELEASE')
    package = json.loads((destination / 'package.json').read_text())
    if 'v' + package.get('version', '') != manifest['version']:
        raise ValueError('RELEASE_VERSION_MISMATCH')
    atomic_json(destination / '.fagoo-release.json', manifest)
    return destination
