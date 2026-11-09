"""Execute the real Bash wrappers with synthetic Docker/package commands, never a host daemon."""
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

from configure import configure

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get('FAGOO_TEST_BASH') or shutil.which('bash')


def shell_path(path):
    value = Path(path).as_posix()
    return '/'+value[0].lower()+value[2:] if os.name == 'nt' and value[1:2] == ':' else value

FAKE = r'''
import json, os, pathlib, subprocess, sys
name, *args = sys.argv[1:]
with open(os.environ['FAGOO_COMMAND_LOG'], 'a', encoding='utf-8') as out:
    out.write(json.dumps({'name':name, 'args':args})+'\n')
if name == 'id':
    print('0'); raise SystemExit(0)
if name == 'python3':
    if args[0] in ('infra/installation_scope.py', 'infra/configure.py', '-'):
        raise SystemExit(subprocess.run([sys.executable, *args]).returncode)
    if args[0] == '-c':
        print('17')
    if args[0] == 'infra/record-runtime.py':
        pathlib.Path(args[args.index('--output')+1]).write_text('{}')
    raise SystemExit(0)
if name == 'docker':
    if args[:2] == ['compose','version']:
        raise SystemExit(int(os.environ.get('FAGOO_NO_COMPOSE', '0')))
    if args and args[0] in ('ps','volume'):
        selected = next((a.split('=',2)[-1] for a in args if a.startswith('label=com.docker.compose.project=')), None)
        if args[0] == 'ps':
            rows = json.loads(os.environ.get('FAGOO_CONTAINERS', '{}')).get(selected, [])
        else:
            volumes = json.loads(os.environ.get('FAGOO_VOLUMES', '{}'))
            rows = volumes.get(selected, []) if selected else sum(volumes.values(), []) + json.loads(os.environ.get('FAGOO_UNLABELLED', '[]'))
        print('\n'.join(rows)); raise SystemExit(0)
    if 'config' in args and os.environ.get('FAGOO_BAD_COMPOSE') == '1':
        raise SystemExit(1)
    if any('server_version_num' in a for a in args): print('17')
    elif 'pg_dump' in args: print('synthetic-database-backup')
    elif 'tar' in args: print('synthetic-storage-backup')
    raise SystemExit(0)
if name in ('apt-get','curl','openssl'):
    raise SystemExit(0)
raise SystemExit('Unexpected fake executable')
'''


class InstallNamespaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BASH:
            raise RuntimeError('Bash is required for runtime installer validation. On Windows set FAGOO_TEST_BASH to a working Bash executable; an unavailable WSL shim is not sufficient.')
        probe = subprocess.run([BASH, '-c', 'test -n "$BASH_VERSION"'], capture_output=True, timeout=10)
        if probe.returncode:
            raise RuntimeError('Bash could not execute. Set FAGOO_TEST_BASH to a working Bash executable before running release validation.')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'infra').mkdir()
        (self.root / 'bin').mkdir()
        # Only the operating-system fixture is substituted. All script control
        # flow, argument parsing, validation, resource checks and locking run.
        for name in ('install-runtime.sh', 'update-runtime.sh'):
            text = (ROOT / 'scripts' / name).read_text(encoding='utf-8')
            text = text.replace('. /etc/os-release', '. "$task_root/os-release"')
            text = text.replace('/etc/apt/', '"$task_root/fake-apt/"')
            (self.root / 'scripts' / name).write_text(text, encoding='utf-8', newline='\n')
        for source in (ROOT / 'infra').glob('*.py'):
            shutil.copyfile(source, self.root / 'infra' / source.name)
        for name in ('runtime-manifest.json', 'compose.yaml', 'release-root.pem'):
            shutil.copyfile(ROOT / 'infra' / name, self.root / 'infra' / name)
        (self.root / 'os-release').write_text('ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n')
        (self.root / 'fake.py').write_text(FAKE, encoding='utf-8')
        executable = Path(sys.executable).as_posix()
        for name in ('id', 'python3', 'docker', 'apt-get', 'curl', 'openssl'):
            file = self.root / 'bin' / name
            file.write_text('#!/usr/bin/env bash\nexec '+shlex.quote(executable)+' '+shlex.quote((self.root / 'fake.py').as_posix())+' '+name+' "$@"\n', encoding='utf-8', newline='\n')
            file.chmod(0o755)
        self.log = self.root / 'commands.jsonl'
        self.env = dict(os.environ, FAGOO_COMMAND_LOG=str(self.log), FAGOO_CONTAINERS=json.dumps({'fagoo':['production-container']}), FAGOO_VOLUMES=json.dumps({'fagoo':['fagoo_database','fagoo_database-config','fagoo_objects']}))
        self.project = 'fagoo-qa'
        self.runtime = self.root / 'private/install/.env'
        # Both sockets remain reserved until the exact point each script starts.
        self.ports = []
        self.sockets = []
        for _ in range(2):
            sock = socket.socket(); sock.bind(('127.0.0.1',0)); self.ports.append(sock.getsockname()[1]); self.sockets.append(sock)
        self.addCleanup(lambda: [s.close() for s in self.sockets])

    def config(self, identity='fagoo-qa', legacy=False):
        configure(self.runtime, 'https://web.example.test', 'https://services.example.test', 'https://api.example.test', self.ports[0], identity, self.ports[1])
        if legacy:
            self.runtime.write_text('\n'.join(line for line in self.runtime.read_text().splitlines() if not line.startswith('FAGOO_INSTANCE_ID='))+'\n')

    def run_script(self, script, args=(), occupied=False):
        if not occupied:
            for sock in self.sockets: sock.close()
        command = 'export PATH='+shlex.quote(shell_path(self.root/'bin'))+':/usr/bin:/bin:"$PATH"; exec bash '+shlex.quote(shell_path(self.root/'scripts'/script))+' '+shlex.join(args)
        # Bash reads LF lines. text=True would translate input to CRLF on Windows.
        result = subprocess.run([BASH, '-c', command], cwd=self.root, env=self.env, input=b'https://web.example.test\nhttps://services.example.test\nhttps://api.example.test\n', capture_output=True, timeout=45)
        result.stdout = result.stdout.decode('utf-8')
        result.stderr = result.stderr.decode('utf-8')
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def assert_no_host_mutations(self):
        self.assertFalse(any(c['name']=='apt-get' or c['name']=='docker' and any(a in c['args'] for a in ('up','stop','pull','run','exec')) for c in self.calls()), self.calls())

    def test_invalid_identity_and_missing_values_fail_before_packages(self):
        for args in (['--instance-id','Bad'],['--instance-id','with_under'],['--instance-id',''],['--instance-id','a'*41],['--local-port',''],['--local-port','999'],['--instance-id']):
            with self.subTest(args=args):
                result=self.run_script('install-runtime.sh',args)
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assert_no_host_mutations()
                self.assertFalse(self.runtime.exists())

    def test_existing_target_label_or_unlabelled_volume_refuses_before_packages(self):
        self.config()
        before=self.runtime.read_bytes()
        for field,value in [('FAGOO_CONTAINERS',{'fagoo':['production'],'fagoo-qa':['existing']}),('FAGOO_UNLABELLED',['fagoo-qa_database'])]:
            with self.subTest(field=field):
                old=self.env.get(field)
                self.env[field]=json.dumps(value)
                result=self.run_script('install-runtime.sh')
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn('existing or partial',result.stderr)
                self.assert_no_host_mutations()
                self.assertEqual(self.runtime.read_bytes(),before)
                if old is None:self.env.pop(field)
                else:self.env[field]=old

    def test_fresh_namespace_preserves_production_and_propagates_scope(self):
        result=self.run_script('install-runtime.sh',['--instance-id',self.project,'--local-port',str(self.ports[0]),'--tunnel-metrics-port',str(self.ports[1]),'--skip-system-packages'])
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('FAGOO_INSTANCE_ID=fagoo-qa',self.runtime.read_text())
        self.assertFalse(any(c['name']=='apt-get' for c in self.calls()))
        for c in self.calls():
            if c['name']=='docker' and '--project-name' in c['args']:
                self.assertEqual(c['args'][c['args'].index('--project-name')+1],self.project)
        for module in ('infra/bootstrap-owner.py','infra/migrate.py'):
            calls=[c['args'] for c in self.calls() if c['name']=='python3' and c['args'][0]==module]
            self.assertTrue(calls,module)
            self.assertTrue(all(args[args.index('--project-name')+1]==self.project for args in calls))
        updater=next(c['args'] for c in self.calls() if c['name']=='python3' and c['args'][0]=='infra/install-updater.py')
        self.assertEqual(Path(updater[updater.index('--root')+1]).resolve(),self.root.resolve())
        self.assertIn('--project-name fagoo-qa --email YOUR_EMAIL',result.stdout)

    def test_persisted_identity_and_port_mismatch_do_not_mutate_packages(self):
        self.config()
        for args in (['--instance-id','another'],['--local-port',str(self.ports[1])],['--tunnel-metrics-port',str(self.ports[0])]):
            result=self.run_script('install-runtime.sh',args)
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assert_no_host_mutations()

    def test_invalid_configuration_or_occupied_port_fails_before_packages(self):
        self.config()
        result=self.run_script('install-runtime.sh',occupied=True)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('port is already in use',result.stderr)
        self.assert_no_host_mutations()
        self.runtime.write_text(self.runtime.read_text().replace('https://web.example.test','http://unsafe.example.test'))
        result=self.run_script('install-runtime.sh')
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('configuration is invalid',result.stderr)
        self.assert_no_host_mutations()

    def test_update_derives_project_and_shares_dashboard_lock_per_root(self):
        self.config()
        lock=self.root/'private/update-fagoo.lock';lock.mkdir()
        result=self.run_script('update-runtime.sh')
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('update lock exists',result.stderr)
        self.assert_no_host_mutations()
        lock.rmdir()
        result=self.run_script('update-runtime.sh')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertFalse(lock.exists())
        scopes=[c['args'][c['args'].index('--project-name')+1] for c in self.calls() if '--project-name' in c['args']]
        self.assertTrue(scopes);self.assertEqual(set(scopes),{self.project})
        self.assertEqual(len(list((self.root/'private/backups').glob('*/database.dump'))),1)

    def test_update_rejects_project_override_including_legacy_default(self):
        self.config(legacy=True)
        result=self.run_script('update-runtime.sh',['--project-name','fagoo-qa'])
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('differs from the persisted',result.stderr)
        self.assert_no_host_mutations()
        self.assertFalse((self.root/'private/update-fagoo.lock').exists())

    def test_default_package_install_runs_only_after_target_and_compose_preflight(self):
        self.config()
        result=self.run_script('install-runtime.sh')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        calls=self.calls()
        apt=next(i for i,c in enumerate(calls) if c['name']=='apt-get')
        compose_config=next(i for i,c in enumerate(calls) if c['name']=='docker' and 'config' in c['args'])
        self.assertLess(compose_config,apt)
        self.assertTrue(any(c['name']=='docker' and c['args'][0]=='ps' for c in calls[:apt]))


if __name__ == '__main__':
    unittest.main()
