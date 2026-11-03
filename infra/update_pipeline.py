"""Ordered update of the local runtime and Cloudflare, with a persistent maintenance gate."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

from release_protocol import atomic_json, extract_release, digest_file
from update_config import read_values, cloudflare_credentials
from update_lock import UpdateLock


class Pipeline:
    def __init__(self, service):
        self.service = service
        self.root = service.root
        self.env_file = self.root / 'private/install/.env'
        self.values = read_values(self.env_file)
        self.credentials_path = self.root / 'private/install/cloudflare/credentials.json'
        self.credentials = cloudflare_credentials(self.credentials_path)
        self.previous = service.current()
        self.source = Path(self.previous['source_dir'])
        self.backup = None
        self.maintenance = self.root / 'private/update-service/run/maintenance'
        self.log = None

    def environment(self):
        # Dependencies and build processes receive no infrastructure credentials.
        import re
        blocked = re.compile(r'TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|^VITE_|^SUPABASE_|^CLOUDFLARE_|^CF_|^FAGOO_|^PG|^WRANGLER_|^WORKERS_CI_', re.I)
        env = {key: value for key, value in os.environ.items() if not blocked.search(key)}
        env.update(CI='true', NO_COLOR='1', WRANGLER_SEND_METRICS='false', NODE_OPTIONS='--max-old-space-size=1536')
        return env

    def run(self, argv, *, cwd=None, output=None, timeout=1800):
        result = subprocess.run([str(arg) for arg in argv], cwd=cwd or self.source, env=self.environment(),
                                stdin=subprocess.DEVNULL, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
        raw = (result.stdout or b'') + (result.stderr or b'')
        text = raw.decode('utf-8', errors='replace')
        for secret in [self.credentials['token'], *[v for k, v in self.values.items() if any(word in k for word in ('SECRET', 'PASSWORD', 'KEY', 'TOKEN'))]]:
            if len(secret) >= 12:
                text = text.replace(secret, '[redacted]')
        if self.log:
            self.log.write(text[-2 * 1024 * 1024:])
            self.log.flush()
        if result.returncode:
            raise ValueError('UPDATE_COMMAND_FAILED')
        return (result.stdout or b'').decode('utf-8', errors='replace').strip()

    def compose(self, source, *args, **kwargs):
        return self.run(['docker', 'compose', '--project-name', 'fagoo', '--env-file', self.env_file,
                         '-f', Path(source) / 'infra/compose.yaml', *args], **kwargs)

    def phase(self, value):
        self.service.save(phase=value)
        if self.log:
            self.log.write('\nPHASE: ' + value + '\n')
            self.log.flush()

    def preflight(self, candidate, manifest):
        major = self.compose(self.source, 'exec', '-T', 'db', 'psql', '-X', '-At', '-U', 'postgres', '-d', 'postgres',
                             '-c', "select current_setting('server_version_num')::integer/10000")
        if major != str(manifest['database_major']):
            raise ValueError('DATABASE_MAJOR_UPGRADE_REFUSED')
        self.run([sys.executable, candidate / 'infra/migrate.py', '--env-file', self.env_file, '--check-only'], cwd=candidate)
        database = int(self.compose(self.source, 'exec', '-T', 'db', 'psql', '-X', '-At', '-U', 'postgres', '-d', 'postgres',
                                    '-c', "select pg_database_size('postgres')"))
        objects = int(self.compose(self.source, 'exec', '-T', 'storage', 'du', '-sk', '/var/lib/storage').split()[0]) * 1024
        if shutil.disk_usage(self.root).free < 2 * (database + objects) + 2 * 1024 ** 3:
            raise ValueError('INSUFFICIENT_UPDATE_DISK_SPACE')

    def capture_cloudflare(self, source):
        spec = importlib.util.spec_from_file_location('fagoo_publish_preflight', Path(source) / 'infra/deploy-application.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        api, web = module.configurations(self.values, self.credentials['account_id'], self.credentials['zone_id'])
        module.check_domains((api, web), self.credentials['account_id'], self.credentials['zone_id'], self.credentials['token'])
        result = {}
        for config in (api, web):
            value = module.cloudflare_get(f"/accounts/{self.credentials['account_id']}/workers/scripts/{config['name']}/deployments", self.credentials['token'])['result']
            deployments = value.get('deployments', []) if isinstance(value, dict) else value
            if isinstance(deployments, list):
                deployments = sorted(deployments, key=lambda item: item.get('created_on', ''), reverse=True)
            if not isinstance(deployments, list) or not deployments or not isinstance(deployments[0].get('versions'), list):
                raise ValueError('PREVIOUS_CLOUDFLARE_VERSION_UNAVAILABLE')
            result[config['name']] = deployments[0]['versions']
        return result

    def execute(self, manifest, job):
        state = self.root / 'private/updates'
        candidate = state / 'releases' / (manifest['version'] + '-' + job[:8])
        archive = state / (job + '.tar.gz')
        self.backup = self.root / 'private/backups' / ('update-' + job)
        lock = UpdateLock(self.root)
        lock.acquire()
        try:
            with (state / (job + '.log')).open('w', encoding='utf-8') as self.log:
                self.phase('download')
                self.service.fetch(manifest['artifact']['url'], archive, manifest['artifact']['size'])
                extract_release(archive, candidate, manifest)
                self.phase('preflight')
                self.preflight(candidate, manifest)
                previous_cloudflare = self.capture_cloudflare(candidate)
                self.phase('build')
                self.run(['npm', 'run', 'install:deployment'], cwd=candidate)
                self.run([sys.executable, candidate / 'infra/deploy-application.py', '--env-file', self.env_file,
                          '--account-id', self.credentials['account_id'], '--zone-id', self.credentials['zone_id'], '--dry-run'], cwd=candidate)
                self.compose(candidate, 'pull', '--quiet')
                self.phase('backup')
                self.backup.mkdir(parents=True, mode=0o700)
                atomic_json(self.backup / 'recovery.json', {'job': job, 'previous': self.previous, 'target': manifest,
                                                           'cloudflare': previous_cloudflare, 'backup_complete': False, 'runtime_changed': False})
                shutil.copy2(self.env_file, self.backup / 'runtime.env')
                self.run([sys.executable, self.source / 'infra/record-runtime.py', '--env-file', self.env_file,
                          '--output', self.backup / 'previous-runtime-images.json'])
                atomic_json(self.maintenance, {'job': job})
                self.service.save(recovery_required=True, backup_id=self.backup.name)
                self.compose(self.source, 'stop', '--timeout', '30', 'auth', 'rest', 'storage')
                with (self.backup / 'database.dump').open('wb') as output:
                    self.compose(self.source, 'exec', '-T', 'db', 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '--format=custom', '--create', output=output)
                with (self.backup / 'storage.tar').open('wb') as output:
                    self.compose(self.source, 'run', '-T', '--rm', '--no-deps', '--entrypoint', 'tar', 'storage',
                                 '-cf', '-', '-C', '/var/lib/storage', '.', output=output)
                if not (self.backup / 'database.dump').stat().st_size or not (self.backup / 'storage.tar').stat().st_size:
                    raise ValueError('UPDATE_BACKUP_INCOMPLETE')
                recovery = json.loads((self.backup / 'recovery.json').read_text())
                recovery['backup_complete'] = True
                recovery['sha256'] = {name: digest_file(self.backup / name) for name in ('database.dump', 'storage.tar', 'runtime.env', 'previous-runtime-images.json')}
                atomic_json(self.backup / 'recovery.json', recovery)
                self.phase('runtime')
                recovery['runtime_changed'] = True
                atomic_json(self.backup / 'recovery.json', recovery)
                self.compose(candidate, 'up', '-d', '--wait', '--wait-timeout', '300', 'db', 'auth', 'rest', 'storage')
                self.run([sys.executable, candidate / 'infra/bootstrap-owner.py', '--env-file', self.env_file], cwd=candidate)
                self.phase('database')
                self.run([sys.executable, candidate / 'infra/migrate.py', '--env-file', self.env_file], cwd=candidate)
                self.phase('cloudflare')
                self.run([sys.executable, candidate / 'infra/deploy-application.py', '--env-file', self.env_file,
                          '--account-id', self.credentials['account_id'], '--zone-id', self.credentials['zone_id'],
                          '--deploy', '--prepared', '--credentials-file', self.credentials_path], cwd=candidate)
                self.phase('verification')
                self.compose(candidate, 'up', '-d', '--wait', '--wait-timeout', '120', 'gateway')
                self.check_public_version(manifest)
                self.maintenance.unlink()
                self.check_health()
                installed = {'version': manifest['version'], 'revision': manifest['source_commit'], 'source_dir': str(candidate),
                             'database_major': manifest['database_major'], 'installed_at': self.service.stamp()}
                atomic_json(state / 'installed.json', installed)
                self.service.save(state='succeeded', phase='complete', recovery_required=False, error=None)
                archive.unlink(missing_ok=True)
        except Exception:
            if self.service.status().get('recovery_required'):
                atomic_json(self.maintenance, {'job': job})
            raise
        finally:
            self.log = None
            lock.release()

    def check_public_version(self, manifest):
        for origin, path in ((self.values['FAGOO_WEB_ORIGIN'], '/fagoo-version.json'), (self.values['FAGOO_API_ORIGIN'], '/v1/system/version')):
            for attempt in range(30):
                try:
                    request = urllib.request.Request(origin + path + '?verification=' + manifest['source_commit'],
                        headers={'Cache-Control': 'no-cache', 'User-Agent': 'FAGOO-updater/1', 'Accept': 'application/json'})
                    with urllib.request.urlopen(request, timeout=10) as response:
                        value = json.loads(response.read(4097))
                    if value.get('revision') == manifest['source_commit'] and value.get('version') == manifest['version']:
                        break
                except (OSError, ValueError):
                    pass
                if attempt == 29:
                    raise ValueError('PUBLISHED_VERSION_VERIFICATION_FAILED')
                time.sleep(3)

    def check_health(self):
        request = urllib.request.Request(self.values['FAGOO_BACKEND_ORIGIN'] + '/auth/v1/health',
                                         headers={'Origin': self.values['FAGOO_WEB_ORIGIN'],
                                                  'User-Agent': 'FAGOO-updater/1', 'Accept': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200 or response.headers.get('Access-Control-Allow-Origin') != self.values['FAGOO_WEB_ORIGIN']:
                raise ValueError('APPLICATION_HEALTH_FAILED')
