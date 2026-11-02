#!/usr/bin/env python3
"""Root-owned, local-only updater. Application requests never become shell commands."""
import argparse
import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

VERSION = re.compile(r"v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?\Z")
IMAGE = re.compile(r"(?:ghcr\.io/quevenapp/fagoo@)?sha256:[a-f0-9]{64}\Z")
MAX_BUNDLE = 50 * 1024 * 1024
DOWNLOAD_HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}


def newer_version(candidate, current):
    if not VERSION.fullmatch(current):
        return True
    def split(value):
        main, _, pre = value[1:].partition('-')
        return tuple(map(int, main.split('.'))), pre.split('.') if pre else None
    target, target_pre = split(candidate)
    present, present_pre = split(current)
    if target != present:
        return target > present
    if target_pre is None or present_pre is None:
        return target_pre is None and present_pre is not None
    for left, right in zip(target_pre, present_pre):
        if left == right:
            continue
        if left.isdigit() and right.isdigit():
            return int(left) > int(right)
        if left.isdigit() != right.isdigit():
            return not left.isdigit()
        return left > right
    return len(target_pre) > len(present_pre)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def validate_manifest(value):
    if not isinstance(value, dict) or value.get('schema') != 1 or value.get('product') != 'fagoo' or not VERSION.fullmatch(value.get('version', '')):
        raise ValueError('INVALID_RELEASE')
    if value.get('platform') != 'linux/amd64' or value.get('minimum_updater') != 1 or not IMAGE.fullmatch(value.get('image', '')):
        raise ValueError('UNSUPPORTED_RELEASE')
    db, compatible = value.get('database_version'), value.get('compatible_database_min')
    if type(db) is not int or type(compatible) is not int or not 1 <= compatible <= db:
        raise ValueError('INVALID_DATABASE_COMPATIBILITY')
    artifact = value.get('artifact', {})
    if artifact.get('url') != f"https://github.com/Quevenapp/Fagoo/releases/download/{value['version']}/deployment.tar.gz":
        raise ValueError('INVALID_ARTIFACT_URL')
    if not re.fullmatch('[a-f0-9]{64}', artifact.get('sha256', '')) or type(artifact.get('size')) is not int or not 0 < artifact['size'] <= MAX_BUNDLE:
        raise ValueError('INVALID_ARTIFACT')
    if value['image'].startswith('sha256:') or 'image_artifact' in value:
        image_archive = value.get('image_artifact', {})
        if not value['image'].startswith('sha256:') or image_archive.get('url') != f"https://github.com/Quevenapp/Fagoo/releases/download/{value['version']}/app-image.tar.gz":
            raise ValueError('INVALID_IMAGE_ARTIFACT_URL')
        if not re.fullmatch('[a-f0-9]{64}', image_archive.get('sha256', '')) or type(image_archive.get('size')) is not int or not 0 < image_archive['size'] <= 2 * 1024 ** 3:
            raise ValueError('INVALID_IMAGE_ARTIFACT')
    return value


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        validate_download_url(url)
        return super().redirect_request(request, response, code, message, headers, url)


def validate_download_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in DOWNLOAD_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('UNTRUSTED_DOWNLOAD_URL')


def download(url, target, limit):
    validate_download_url(url)
    opener = urllib.request.build_opener(SafeRedirect())
    request = urllib.request.Request(url, headers={'User-Agent': 'FAGOO-updater/1'})
    with opener.open(request, timeout=12 if limit <= 65536 else 30) as response, open(target, 'wb') as stream:
        size = 0
        while block := response.read(65536):
            size += len(block)
            if size > limit:
                raise ValueError('DOWNLOAD_TOO_LARGE')
            stream.write(block)


def verify_manifest(manifest_path, signature_path, public_key):
    manifest_path, signature_path = Path(manifest_path), Path(signature_path)
    if manifest_path.stat().st_size > 65536 or signature_path.stat().st_size != 64:
        raise ValueError('INVALID_ENVELOPE')
    result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key), '-rawin', '-in', str(manifest_path), '-sigfile', str(signature_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    if result.returncode:
        raise ValueError('INVALID_SIGNATURE')
    return validate_manifest(json.loads(manifest_path.read_text(encoding='utf-8')))


def extract_bundle(archive, destination, artifact):
    archive, destination = Path(archive), Path(destination)
    if archive.stat().st_size != artifact['size'] or hashlib.sha256(archive.read_bytes()).hexdigest() != artifact['sha256']:
        raise ValueError('INVALID_ARTIFACT_DIGEST')
    destination.mkdir(parents=True, exist_ok=False)
    base, expanded = destination.resolve(), 0
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) > 5000:
            raise ValueError('TOO_MANY_ARTIFACT_FILES')
        for member in members:
            target = (base / member.name).resolve()
            if not target.is_relative_to(base) or '\\' in member.name or not (member.isfile() or member.isdir()):
                raise ValueError('UNSAFE_ARTIFACT_PATH')
            expanded += member.size
            if expanded > 100 * 1024 * 1024:
                raise ValueError('EXPANDED_ARTIFACT_TOO_LARGE')
        bundle.extractall(base, members=members, filter='data')
    if not (base / 'infra/compose.yaml').is_file() or not (base / 'scripts/backup.sh').is_file():
        raise ValueError('INCOMPLETE_DEPLOYMENT_BUNDLE')


def verify_file(path, artifact):
    digest = hashlib.sha256()
    size = 0
    with open(path, 'rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
            size += len(block)
    if size != artifact['size'] or digest.hexdigest() != artifact['sha256']:
        raise ValueError('INVALID_IMAGE_ARTIFACT_DIGEST')


def ensure_image(manifest, home, fetch=download, run=None):
    if run is None:
        def run(argv, environment=None):
            process = subprocess.run(argv, capture_output=True, text=True, check=True, timeout=900)
            return process.stdout
    if 'image_artifact' not in manifest:
        run(['docker', 'pull', manifest['image']])
        return
    try:
        existing = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', manifest['image']])
        if existing and existing.strip() == manifest['image']:
            return
    except (RuntimeError, subprocess.CalledProcessError):
        pass
    with tempfile.TemporaryDirectory(prefix='image-', dir=Path(home) / 'state') as folder:
        archive = Path(folder) / 'app-image.tar.gz'
        fetch(manifest['image_artifact']['url'], archive, manifest['image_artifact']['size'])
        verify_file(archive, manifest['image_artifact'])
        run(['docker', 'load', '--input', str(archive)])
    actual = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', manifest['image']])
    if not actual or actual.strip() != manifest['image']:
        raise ValueError('LOADED_IMAGE_ID_MISMATCH')


class Updater:
    def __init__(self, home, runner=None, fetch=download):
        self.home = Path(home).resolve()
        self.state_path = self.home / 'state/update.json'
        self.checked_dir = self.home / 'state/checked'
        self.public_key = self.home / 'updater/release-root.pem'
        self.runner = runner or self.run_command
        self.fetch = fetch
        self.lock = threading.Lock()
        self.home.joinpath('state').mkdir(parents=True, exist_ok=True)
        self.checked_dir.mkdir(parents=True, exist_ok=True)
        if not self.state_path.exists():
            self.save(state='idle', phase=None)
        elif self.status().get('state') in ('queued', 'running'):
            self.save(state='interrupted', phase='recovery_required', message='Updater stopped during a release. Inspect logs and database before retrying.')

    def status(self):
        return json.loads(self.state_path.read_text(encoding='utf-8'))

    def save(self, **values):
        previous = self.status() if self.state_path.exists() else {}
        previous.update(values, updated_at=stamp())
        atomic_json(self.state_path, previous)
        return previous

    def current(self):
        path = self.home / 'state/installed.json'
        return json.loads(path.read_text()) if path.exists() else {'version': 'source', 'database_version': 1}

    def snapshot(self):
        latest = None
        try:
            latest = verify_manifest(self.checked_dir / 'manifest.json', self.checked_dir / 'manifest.sig', self.public_key)
        except (FileNotFoundError, ValueError):
            pass
        backup_path = self.home / 'state/backup.json'
        backup = json.loads(backup_path.read_text(encoding='utf-8')) if backup_path.exists() else {'status': 'unknown', 'last_success_at': None, 'offsite': False, 'message': 'Nenhum backup verificado foi registrado nesta instalação.'}
        return {'installed': self.current(), 'latest': latest, 'status': self.status(), 'backup': backup,
                'update_available': latest is not None and newer_version(latest['version'], self.current()['version']), 'message': self.status().get('message')}

    def run_command(self, argv, environment=None):
        result = subprocess.run(argv, env={**os.environ, **(environment or {})}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
        if result.returncode:
            raise RuntimeError(f'COMMAND_FAILED:{Path(argv[0]).name}:{result.returncode}')
        return result.stdout.decode('utf-8', errors='replace')

    def compose(self, release, args, image=None, version=None):
        self.runner(['docker', 'compose', '--project-name', 'fagoo', '--env-file', str(self.home / 'config.env'), '-f', str(release / 'infra/compose.yaml'), *args], {'FAGOO_HOME': str(self.home), **({'FAGOO_IMAGE': image} if image else {}), **({'FAGOO_VERSION': version} if version else {})})

    def check(self):
        if not self.lock.acquire(blocking=False):
            raise ValueError('UPDATE_BUSY')
        try:
            with tempfile.TemporaryDirectory(dir=self.home / 'state') as scratch:
                manifest, signature = Path(scratch) / 'manifest.json', Path(scratch) / 'manifest.sig'
                root = 'https://github.com/Quevenapp/Fagoo/releases/latest/download'
                try:
                    self.fetch(root + '/manifest.json', manifest, 65536)
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    (self.checked_dir / 'manifest.json').unlink(missing_ok=True)
                    (self.checked_dir / 'manifest.sig').unlink(missing_ok=True)
                    result = self.snapshot()
                    result['message'] = 'Nenhuma versão estável foi publicada para atualização.'
                    return result
                self.fetch(root + '/manifest.sig', signature, 64)
                candidate = verify_manifest(manifest, signature, self.public_key)
                shutil.copyfile(manifest, self.checked_dir / 'manifest.json')
                shutil.copyfile(signature, self.checked_dir / 'manifest.sig')
            return self.snapshot()
        finally:
            self.lock.release()

    def enqueue(self, version):
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise ValueError('INVALID_VERSION')
        if not self.lock.acquire(blocking=False):
            raise ValueError('UPDATE_BUSY')
        try:
            if self.status().get('database_may_have_changed') or self.status().get('state') == 'interrupted':
                raise ValueError('RECOVERY_REQUIRED')
            candidate = verify_manifest(self.checked_dir / 'manifest.json', self.checked_dir / 'manifest.sig', self.public_key)
            if version != candidate['version'] or version == self.current()['version']:
                raise ValueError('RELEASE_NOT_CHECKED_OR_ALREADY_INSTALLED')
            if not newer_version(version, self.current()['version']):
                raise ValueError('RELEASE_DOWNGRADE_FORBIDDEN')
            installed_db = self.current()['database_version']
            if not candidate['compatible_database_min'] <= installed_db <= candidate['database_version']:
                raise ValueError('DATABASE_UPGRADE_PATH_UNSUPPORTED')
            state = self.save(state='queued', phase='preflight', job_id=str(uuid.uuid4()), target_version=version, message=None)
            threading.Thread(target=self.perform, args=(candidate,), daemon=True).start()
            return state
        except Exception:
            self.lock.release()
            raise

    def perform(self, candidate):
        previous, migration_started = (self.home / 'current').resolve(), False
        release = self.home / 'releases' / candidate['version']
        try:
            self.save(state='running', phase='download')
            if shutil.disk_usage(self.home).free < 3 * 1024 ** 3:
                raise ValueError('INSUFFICIENT_DISK_SPACE')
            if release.exists():
                raise ValueError('RELEASE_DIRECTORY_EXISTS_REVIEW_PREVIOUS_ATTEMPT')
            release.parent.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(dir=self.home / 'state') as scratch:
                archive = Path(scratch) / 'deployment.tar.gz'
                self.fetch(candidate['artifact']['url'], archive, candidate['artifact']['size'])
                extract_bundle(archive, release, candidate['artifact'])
            self.save(phase='pull')
            ensure_image(candidate, self.home, self.fetch, self.runner)
            self.save(phase='maintenance')
            self.compose(previous, ['stop', 'api', 'jobs'])
            self.save(phase='backup')
            self.runner(['bash', str(previous / 'scripts/backup.sh')], {'FAGOO_HOME': str(self.home)})
            self.save(phase='migrate')
            migration_started = True
            self.compose(release, ['run', '--rm', '-T', '--interactive=false', '--no-deps', 'api', 'node', 'apps/api/src/migrate.mjs'], candidate['image'], candidate['version'])
            pending = self.home / 'current.next'
            pending.symlink_to(release, target_is_directory=True)
            os.replace(pending, self.home / 'current')
            self.save(phase='start')
            self.compose(release, ['up', '-d', 'api', 'jobs'], candidate['image'], candidate['version'])
            self.save(phase='health')
            self.wait_healthy(release, candidate)
            frontend = 'pending_configuration'
            if (self.home / 'cloudflare.json').is_file():
                self.save(phase='cloudflare')
                self.runner(['python3', str(release / 'infra/cloudflare-deploy.py'), '--apply', '--release', str(release)], {'FAGOO_HOME': str(self.home), 'FAGOO_IMAGE': candidate['image']})
                frontend = 'complete'
            self.commit_environment(candidate)
            atomic_json(self.home / 'state/installed.json', candidate)
            self.save(state='complete', phase='complete', installed_version=candidate['version'], frontend=frontend, message=None if frontend == 'complete' else 'API updated; Cloudflare frontend is not configured on this installation.')
        except Exception as error:
            if not migration_started:
                try:
                    self.compose(previous, ['up', '-d', 'api', 'jobs'])
                except Exception:
                    pass
            else:
                try:
                    self.compose(release, ['stop', 'api', 'jobs'], candidate['image'], candidate['version'])
                except Exception:
                    pass
            self.save(state='failed', phase='recovery_required' if migration_started else 'failed', message=str(error)[:200], database_may_have_changed=migration_started)
        finally:
            self.lock.release()

    def wait_healthy(self, release, candidate):
        for _ in range(24):
            try:
                self.compose(release, ['exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], candidate['image'], candidate['version'])
                return
            except RuntimeError:
                time.sleep(5)
        raise RuntimeError('HEALTH_CHECK_FAILED')

    def commit_environment(self, candidate):
        path = self.home / 'config.env'
        lines = [line for line in path.read_text().splitlines() if not line.startswith(('FAGOO_IMAGE=', 'FAGOO_VERSION='))]
        lines.extend([f"FAGOO_IMAGE={candidate['image']}", f"FAGOO_VERSION={candidate['version']}"])
        temporary = path.with_suffix('.next')
        temporary.write_text('\n'.join(lines) + '\n')
        temporary.chmod(0o600)
        os.replace(temporary, path)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self):
        expected = self.server.token
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + expected)

    def do_GET(self):
        if not self.authorized():
            return self.respond(401, {'error': 'UNAUTHORIZED'})
        if self.path != '/v1/status':
            return self.respond(404, {'error': 'NOT_FOUND'})
        return self.respond(200, self.server.updater.snapshot())

    def do_POST(self):
        if not self.authorized():
            return self.respond(401, {'error': 'UNAUTHORIZED'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 1024 or self.headers.get('Content-Type') != 'application/json':
                raise ValueError('INVALID_BODY')
            value = json.loads(self.rfile.read(length))
            if self.path == '/v1/check' and value == {}:
                return self.respond(200, self.server.updater.check())
            if self.path == '/v1/update' and isinstance(value, dict) and set(value) == {'version'}:
                return self.respond(202, self.server.updater.enqueue(value['version']))
            return self.respond(404, {'error': 'NOT_FOUND'})
        except (ValueError, FileNotFoundError) as error:
            return self.respond(409, {'error': str(error)[:160]})
        except Exception:
            return self.respond(502, {'error': 'RELEASE_SERVICE_UNAVAILABLE'})


class Server(socketserver.ThreadingMixIn, getattr(socketserver, 'UnixStreamServer', socketserver.TCPServer)):
    daemon_threads = True


def serve(home):
    if os.name != 'posix':
        raise RuntimeError('UPDATER_REQUIRES_LINUX_UNIX_SOCKETS')
    updater = Updater(home)
    token = (Path(home) / 'secrets/updater-token').read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}', token):
        raise ValueError('INVALID_UPDATER_TOKEN')
    address = Path('/run/fagoo/updater.sock')
    address.parent.mkdir(mode=0o750, exist_ok=True)
    if address.exists():
        address.unlink()
    with Server(str(address), Handler) as server:
        import grp
        os.chown(address, 0, grp.getgrnam('fagoo-update').gr_gid)
        address.chmod(0o660)
        server.updater, server.token = updater, token
        server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve', 'status', 'load-image'])
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--signature', type=Path)
    args = parser.parse_args()
    home = os.environ.get('FAGOO_HOME', '/opt/fagoo')
    if args.action == 'serve':
        serve(home)
    elif args.action == 'load-image':
        manifest = verify_manifest(args.manifest, args.signature, Path(home) / 'updater/release-root.pem')
        ensure_image(manifest, home)
    else:
        print((Path(home) / 'state/update.json').read_text(encoding='utf-8'))
