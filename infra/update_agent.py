#!/usr/bin/env python3
"""Local Unix-socket service. Only fixed, signed release operations can be requested."""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import socketserver
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import uuid

from release_protocol import PROTOCOL, RELEASES, VERSION, atomic_json, digest_file, download, newer_version, verify_manifest
from update_config import read_values, cloudflare_credentials, source_identity
from update_pipeline import Pipeline

ACTIVE = {'checking', 'queued', 'running'}
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')


class Updater:
    def __init__(self, root, fetch=download, pipeline=Pipeline, restart=False):
        self.root = Path(root).resolve()
        self.home = self.root / 'private/updates'
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.public_key = self.root / 'private/update-service/release-root.pem'
        self.checked = self.home / 'checked'
        self.checked.mkdir(exist_ok=True, mode=0o700)
        self.state_path = self.home / 'state.json'
        self.fetch, self.pipeline, self.restart = fetch, pipeline, restart
        self.action_lock, self.state_lock = threading.Lock(), threading.RLock()
        if not self.state_path.exists():
            self.save(state='idle', phase='idle', error=None, recovery_required=False)
        elif self.status().get('state') in ACTIVE:
            maintenance = (self.root / 'private/update-service/run/maintenance').exists()
            self.save(state='interrupted', phase='recovery' if maintenance else 'idle',
                      error='UPDATE_INTERRUPTED', recovery_required=maintenance)

    @staticmethod
    def stamp():
        return datetime.now(timezone.utc).isoformat()

    def status(self):
        with self.state_lock:
            return json.loads(self.state_path.read_text(encoding='utf-8'))

    def save(self, **values):
        with self.state_lock:
            previous = self.status() if self.state_path.exists() else {}
            previous.update(values, updated_at=self.stamp())
            atomic_json(self.state_path, previous)
            return previous

    def current(self):
        path = self.home / 'installed.json'
        if path.exists():
            value = json.loads(path.read_text())
            source = Path(value['source_dir']).resolve()
            if source != self.root and not source.is_relative_to(self.home / 'releases'):
                raise ValueError('INSTALLED_SOURCE_OUTSIDE_ROOT')
            return value
        return {**source_identity(self.root), 'source_dir': str(self.root), 'database_major': 17}

    def candidate(self):
        manifest = self.checked / 'fagoo-release.json'
        value = verify_manifest(manifest, self.checked / 'fagoo-release.sig', self.public_key)
        return value, digest_file(manifest)

    def snapshot(self):
        current, state = self.current(), self.status()
        ready, candidate, checked_hash = True, None, None
        try:
            cloudflare_credentials(self.root / 'private/install/cloudflare/credentials.json')
        except (OSError, ValueError, KeyError):
            ready = False
        try:
            candidate, checked_hash = self.candidate()
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        available = bool(candidate and newer_version(candidate['version'], current['version']))
        return {'protocol': PROTOCOL, 'installed': {key: current.get(key) for key in ('version', 'revision', 'installed_at')},
                'latest': None if candidate is None else {'version': candidate['version'], 'revision': candidate['source_commit'],
                    'notes': candidate.get('notes', ''), 'manifest_sha256': checked_hash},
                'update_available': available, 'cloudflare_configured': ready,
                'status': {key: state.get(key) for key in ('state', 'phase', 'job_id', 'version', 'updated_at', 'error', 'recovery_required', 'backup_id')},
                'can_apply': ready and available and state.get('state') not in ACTIVE and not state.get('recovery_required')}

    def check(self):
        with tempfile.TemporaryDirectory(prefix='check-', dir=self.home) as directory:
            manifest, signature = Path(directory) / 'manifest.json', Path(directory) / 'manifest.sig'
            try:
                self.fetch(RELEASES + '/latest/download/fagoo-release.json', manifest, 16384)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                (self.checked / 'fagoo-release.json').unlink(missing_ok=True)
                (self.checked / 'fagoo-release.sig').unlink(missing_ok=True)
                self.save(state='idle', phase='idle', error='NO_PUBLIC_RELEASE')
                return
            # Use the version-specific signature so a simultaneous publication cannot mix two releases.
            version = json.loads(manifest.read_text()).get('version')
            if not isinstance(version, str) or not VERSION.fullmatch(version):
                raise ValueError('INVALID_RELEASE_VERSION')
            self.fetch(f'{RELEASES}/download/{version}/fagoo-release.sig', signature, 64)
            verify_manifest(manifest, signature, self.public_key)
            os.replace(manifest, self.checked / 'fagoo-release.json')
            os.replace(signature, self.checked / 'fagoo-release.sig')
        self.save(state='idle', phase='ready', error=None)

    def start_check(self):
        if not self.action_lock.acquire(blocking=False):
            raise ValueError('UPDATE_BUSY')
        if self.status().get('recovery_required'):
            self.action_lock.release()
            raise ValueError('UPDATE_RECOVERY_REQUIRED')
        self.save(state='checking', phase='search', error=None)
        def task():
            try:
                self.check()
            except Exception as error:
                self.save(state='failed', phase='search', error=self.error_code(error))
            finally:
                self.action_lock.release()
        threading.Thread(target=task, daemon=True).start()
        return self.snapshot()

    @staticmethod
    def error_code(error):
        if isinstance(error, ValueError) and re.fullmatch('[A-Z][A-Z0-9_]{1,80}', str(error)):
            return str(error)
        return 'UPDATE_OPERATION_FAILED'

    def enqueue(self, body, actor):
        if (not isinstance(body, dict) or set(body) != {'version', 'manifest_sha256', 'request_id'}
                or not isinstance(body['request_id'], str) or not UUID.fullmatch(body['request_id'])
                or not isinstance(body['manifest_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', body['manifest_sha256'])):
            raise ValueError('INVALID_UPDATE_REQUEST')
        previous = self.status()
        if previous.get('request_id') == body['request_id'] and previous.get('actor') == actor:
            if previous.get('version') != body['version'] or previous.get('manifest_sha256') != body['manifest_sha256']:
                raise ValueError('UPDATE_REQUEST_CONFLICT')
            return {**self.snapshot(), 'progress_token': previous.get('progress_token')}
        if not self.action_lock.acquire(blocking=False):
            raise ValueError('UPDATE_BUSY')
        try:
            if previous.get('recovery_required'):
                raise ValueError('UPDATE_RECOVERY_REQUIRED')
            manifest, checked_hash = self.candidate()
            if manifest['version'] != body['version'] or not hmac.compare_digest(checked_hash, body['manifest_sha256']):
                raise ValueError('CHECKED_RELEASE_CHANGED')
            if not newer_version(manifest['version'], self.current()['version']):
                raise ValueError('RELEASE_DOWNGRADE_OR_REINSTALL_REFUSED')
            cloudflare_credentials(self.root / 'private/install/cloudflare/credentials.json')
            progress, job = secrets.token_urlsafe(32), str(uuid.uuid4())
            self.save(state='queued', phase='download', error=None, actor=actor, request_id=body['request_id'],
                      version=manifest['version'], manifest_sha256=checked_hash, progress_token=progress,
                      progress_expires=time.time() + 7200, job_id=job, backup_id=None, recovery_required=False)
            response = {**self.snapshot(), 'progress_token': progress}
            def task():
                try:
                    self.save(state='running')
                    self.pipeline(self).execute(manifest, job)
                except Exception as error:
                    self.save(state='failed', error=self.error_code(error))
                finally:
                    self.action_lock.release()
                if self.restart and self.status().get('state') == 'succeeded':
                    subprocess.Popen(['systemctl', '--no-block', 'restart', 'fagoo-updater.service'],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            threading.Thread(target=task, daemon=True).start()
            return response
        except Exception:
            self.action_lock.release()
            raise

    def progress(self, token):
        state = self.status()
        if (not isinstance(token, str) or len(token) > 100 or time.time() > state.get('progress_expires', 0)
                or not state.get('progress_token') or not hmac.compare_digest(token, state['progress_token'])):
            raise PermissionError('UPDATE_PROGRESS_UNAUTHORIZED')
        return self.snapshot()


def handler_for(service, token):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = 'FAGOO'
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass  # Request headers, tokens and bodies never enter service logs.

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def process(self):
            authorization = self.headers.get('Authorization', '')
            if len(self.headers.get_all('Authorization', [])) != 1 or not hmac.compare_digest(authorization, 'Bearer ' + token):
                return self.reply(401, {'error': 'UPDATE_SERVICE_UNAUTHORIZED'})
            if self.headers.get('Transfer-Encoding') or self.path not in ('/status', '/check', '/apply', '/progress'):
                return self.reply(400, {'error': 'INVALID_UPDATE_REQUEST'})
            try:
                if self.path == '/progress' and self.command == 'GET':
                    return self.reply(200, service.progress(self.headers.get('X-Fagoo-Progress', '')))
                actor = self.headers.get('X-Fagoo-Actor', '')
                if not UUID.fullmatch(actor):
                    raise PermissionError('UPDATE_ACTOR_REQUIRED')
                if self.path == '/status' and self.command == 'GET':
                    return self.reply(200, service.snapshot())
                if self.command != 'POST' or self.path not in ('/check', '/apply'):
                    return self.reply(405, {'error': 'UPDATE_METHOD_NOT_ALLOWED'})
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 <= size <= 4096 or not self.headers.get('Content-Type', '').startswith('application/json'):
                    raise ValueError('INVALID_UPDATE_REQUEST')
                body = json.loads(self.rfile.read(size))
                if self.path == '/check':
                    if body != {}:
                        raise ValueError('INVALID_UPDATE_REQUEST')
                    return self.reply(202, service.start_check())
                return self.reply(202, service.enqueue(body, actor))
            except PermissionError:
                self.reply(403, {'error': 'UPDATE_ACCESS_DENIED'})
            except (ValueError, OSError) as error:
                self.reply(409, {'error': service.error_code(error)})
            except Exception:
                self.reply(503, {'error': 'UPDATE_OPERATION_FAILED'})

        do_GET = process
        do_POST = process
    return Handler


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    values = read_values(root / 'private/install/.env')
    token = values.get('FAGOO_UPDATE_AGENT_TOKEN', '')
    if not re.fullmatch('[a-f0-9]{64}', token):
        raise SystemExit('UPDATE_SERVICE_NOT_CONFIGURED')
    run = root / 'private/update-service/run'
    run.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (run / 'service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        socket = run / 'agent.sock'
        if socket.exists():
            if not stat.S_ISSOCK(socket.lstat().st_mode):
                raise SystemExit('UNEXPECTED_UPDATE_SOCKET_PATH')
            socket.unlink()
        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True
            slots = threading.BoundedSemaphore(16)

            def process_request(self, request, client_address):
                if not self.slots.acquire(blocking=False):
                    self.shutdown_request(request)
                    return
                try:
                    super().process_request(request, client_address)
                except Exception:
                    self.slots.release()
                    raise

            def process_request_thread(self, request, client_address):
                try:
                    super().process_request_thread(request, client_address)
                finally:
                    self.slots.release()
        with Server(str(socket), handler_for(Updater(root, restart=True), token)) as server:
            os.chmod(socket, 0o600)
            server.serve_forever()


if __name__ == '__main__':
    os.umask(0o077)
    main()
