import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

from configure import configure
from release_protocol import atomic_json, digest_file, extract_release, newer_version, verify_manifest
from update_agent import Updater
from update_pipeline import Pipeline
from update_lock import UpdateLock

ACTOR = '11111111-1111-4111-8111-111111111111'


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'installation'
        self.root.mkdir()
        (self.root / 'package.json').write_text('{"version":"0.2.0-dev.0"}')
        (self.root / 'private/update-service/run').mkdir(parents=True)
        configure(self.root / 'private/install/.env', 'https://erp.example.test', 'https://services.example.test', 'https://api.example.test')
        atomic_json(self.root / 'private/install/cloudflare/credentials.json', {'account_id':'a'*32,'zone_id':'b'*32,'token':'synthetic-cloudflare-token-for-tests'})
        self.key = Path(self.temp.name) / 'signing.pem'
        self.public = self.root / 'private/update-service/release-root.pem'
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(self.key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['openssl','pkey','-in',str(self.key),'-pubout','-out',str(self.public)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.release = Path(self.temp.name) / 'release'
        self.release.mkdir()
        self.archive = self.release / 'source.tar.gz'
        self.members = {'package.json':b'{"version":"0.2.0"}', 'package-lock.json':b'{}',
            'infra/compose.yaml':b'services: {}', 'infra/update_agent.py':b'# signed fixture', 'infra/migrate.py':b'# fixture',
            'infra/deploy-application.py':b'# fixture', 'apps/erp/src/App.tsx':b'// fixture'}
        self.pack()
        self.sign()
        atomic_json(self.root / 'private/updates/installed.json', {'version':'v0.2.0-dev.0','revision':'a'*40,'source_dir':str(self.root),'database_major':17})

    def pack(self, special=None):
        with tarfile.open(self.archive,'w:gz') as archive:
            for name,content in self.members.items():
                entry=tarfile.TarInfo(name);entry.size=len(content);archive.addfile(entry,io.BytesIO(content))
            if special is not None:archive.addfile(special)

    def sign(self):
        self.manifest={'format':2,'product':'fagoo','version':'v0.2.0','minimum_updater':1,'platform':'ubuntu-24.04-amd64',
            'database_major':17,'source_commit':'b'*40,'notes':'Versão de teste',
            'artifact':{'url':'https://github.com/Quevenapp/Fagoo/releases/download/v0.2.0/fagoo-source.tar.gz','size':self.archive.stat().st_size,'sha256':digest_file(self.archive)}}
        atomic_json(self.release/'manifest.json',self.manifest)
        subprocess.run(['openssl','pkeyutl','-sign','-inkey',str(self.key),'-rawin','-in',str(self.release/'manifest.json'),'-out',str(self.release/'manifest.sig')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    def fetch(self,url,target,limit):
        source=self.archive if url.endswith('.tar.gz') else self.release/('manifest.sig' if url.endswith('.sig') else 'manifest.json')
        self.assertLessEqual(source.stat().st_size,limit)
        shutil.copyfile(source,target)

    def service(self,pipeline=Pipeline):
        return Updater(self.root,fetch=self.fetch,pipeline=pipeline)

    def checked(self,pipeline=Pipeline):
        service=self.service(pipeline);service.check();return service

    def request(self,service):
        return {'version':'v0.2.0','manifest_sha256':service.snapshot()['latest']['manifest_sha256'],'request_id':str(uuid.uuid4())}

    def test_real_signature_and_digest_are_required(self):
        value=verify_manifest(self.release/'manifest.json',self.release/'manifest.sig',self.public)
        extracted=extract_release(self.archive,Path(self.temp.name)/'extracted',value)
        self.assertTrue((extracted/'.fagoo-release.json').is_file())
        with (self.release/'manifest.json').open('ab') as f:f.write(b' ')
        with self.assertRaisesRegex(ValueError,'INVALID_RELEASE_SIGNATURE'):verify_manifest(self.release/'manifest.json',self.release/'manifest.sig',self.public)
        with self.archive.open('ab') as f:f.write(b'tampered')
        with self.assertRaisesRegex(ValueError,'INVALID_RELEASE_DIGEST'):extract_release(self.archive,Path(self.temp.name)/'bad',value)

    def test_archive_cannot_escape_or_install_links_or_private_files(self):
        for name,kind in [('../outside',tarfile.DIRTYPE),('/absolute',tarfile.DIRTYPE),('private/install',tarfile.DIRTYPE),('infra/linked',tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                entry=tarfile.TarInfo(name);entry.type=kind;entry.linkname='/etc'
                self.pack(entry);self.sign()
                with self.assertRaisesRegex(ValueError,'UNSAFE_RELEASE_PATH'):extract_release(self.archive,Path(self.temp.name)/str(uuid.uuid4()),self.manifest)

    def test_version_order_rejects_reinstall_downgrade_and_unknown_installation(self):
        self.assertTrue(newer_version('v0.2.0','v0.2.0-dev.0'))
        self.assertTrue(newer_version('v0.2.0-rc.10','v0.2.0-rc.9'))
        self.assertFalse(newer_version('v0.2.0','v0.2.0'))
        self.assertFalse(newer_version('v0.1.9','v0.2.0'))
        with self.assertRaisesRegex(ValueError,'INSTALLED_VERSION_UNKNOWN'):newer_version('v0.2.0','source')

    def test_public_status_never_exposes_credentials_source_paths_or_progress_token(self):
        service=self.checked()
        service.save(actor=ACTOR,progress_token='private-progress',progress_expires=99999999999)
        text=json.dumps(service.snapshot())
        for private in ('synthetic-cloudflare-token','private-progress',str(self.root),'source_dir','actor'):
            self.assertNotIn(private,text)
        self.assertTrue(service.snapshot()['can_apply'])
        with self.assertRaises(PermissionError):service.progress('wrong')

    def test_clicked_release_is_bound_to_checked_digest(self):
        service=self.checked();request=self.request(service);request['manifest_sha256']='c'*64
        with self.assertRaisesRegex(ValueError,'CHECKED_RELEASE_CHANGED'):service.enqueue(request,ACTOR)
        self.assertFalse(service.action_lock.locked())

    def test_concurrent_and_replayed_requests_cannot_start_second_update(self):
        began,finish=threading.Event(),threading.Event();calls=[]
        class Blocking:
            def __init__(self,service):self.service=service
            def execute(self,manifest,job):calls.append(job);began.set();finish.wait(5);self.service.save(state='succeeded',phase='complete')
        service=self.checked(Blocking);request=self.request(service)
        accepted=service.enqueue(request,ACTOR)
        self.assertTrue(began.wait(2))
        self.assertEqual(service.enqueue(request,ACTOR)['progress_token'],accepted['progress_token'])
        with self.assertRaisesRegex(ValueError,'UPDATE_BUSY'):service.enqueue(self.request(service),ACTOR)
        self.assertEqual(service.progress(accepted['progress_token'])['status']['job_id'],calls[0])
        self.assertEqual(len(calls),1);finish.set()
        self.assertTrue(service.action_lock.acquire(timeout=2));service.action_lock.release()

    def test_restart_during_maintenance_requires_recovery(self):
        service=self.service();service.save(state='running')
        atomic_json(self.root/'private/update-service/run/maintenance',{'job':str(uuid.uuid4())})
        restored=self.service()
        self.assertTrue(restored.status()['recovery_required'])
        self.assertEqual(restored.status()['state'],'interrupted')
        with self.assertRaisesRegex(ValueError,'UPDATE_RECOVERY_REQUIRED'):restored.start_check()

    def test_lock_recovers_only_a_known_dead_dashboard_process(self):
        lock=UpdateLock(self.root);lock.acquire()
        with patch('update_lock.os.kill',return_value=None):
            with self.assertRaisesRegex(ValueError,'UPDATE_BUSY'):UpdateLock(self.root).acquire()
        with patch('update_lock.os.kill',side_effect=ProcessLookupError):
            recovered=UpdateLock(self.root);recovered.acquire();recovered.release()
        lock.path.mkdir()
        with self.assertRaisesRegex(ValueError,'UPDATE_LOCK_REQUIRES_INSPECTION'):UpdateLock(self.root).acquire()

    def test_failed_signature_cannot_leave_an_installable_candidate(self):
        service=self.service()
        (self.release/'manifest.sig').write_bytes(b'x'*64)
        with self.assertRaisesRegex(ValueError,'INVALID_RELEASE_SIGNATURE'):service.check()
        self.assertFalse(service.snapshot()['can_apply'])

    def pipeline_fixture(self,service,fail=None):
        calls=[];outer=self
        class Fixture(Pipeline):
            def preflight(self,*args):calls.append('preflight')
            def capture_cloudflare(self,*args):return {'api':[{'version_id':'before','percentage':100}]}
            def run(self,argv,**kwargs):
                calls.append(' '.join(map(str,argv)))
                if any(str(arg).endswith('record-runtime.py') for arg in argv):atomic_json(self.backup/'previous-runtime-images.json',{})
                return ''
            def compose(self,source,*args,**kwargs):
                calls.append(' '.join(map(str,args)))
                if kwargs.get('output'):kwargs['output'].write(b'fixture backup bytes')
                return ''
            def check_public_version(self,*args):calls.append('versions verified')
            def check_health(self):calls.append('health verified')
            def phase(self,name):
                super().phase(name)
                if fail==name:raise ValueError('SYNTHETIC_FAILURE')
        return Fixture(service),calls

    def test_backup_precedes_mutations_and_success_follows_public_verification(self):
        service=self.checked();pipeline,calls=self.pipeline_fixture(service);job=str(uuid.uuid4())
        pipeline.execute(self.manifest,job)
        backup=json.loads((pipeline.backup/'recovery.json').read_text())
        self.assertTrue(backup['backup_complete']);self.assertTrue(backup['runtime_changed'])
        self.assertEqual(digest_file(pipeline.backup/'database.dump'),backup['sha256']['database.dump'])
        dump=next(i for i,c in enumerate(calls) if 'pg_dump' in c)
        mutation=next(i for i,c in enumerate(calls) if 'up -d --wait --wait-timeout 300' in c)
        self.assertLess(dump,mutation)
        self.assertEqual(calls[-2:],['versions verified','health verified'])
        self.assertEqual(service.current()['version'],'v0.2.0')
        self.assertEqual(service.status()['state'],'succeeded')
        self.assertFalse(pipeline.maintenance.exists())

    def test_failure_after_backup_keeps_maintenance_and_installed_version(self):
        service=self.checked();pipeline,calls=self.pipeline_fixture(service,fail='cloudflare')
        with self.assertRaisesRegex(ValueError,'SYNTHETIC_FAILURE'):pipeline.execute(self.manifest,str(uuid.uuid4()))
        self.assertTrue(pipeline.maintenance.exists())
        self.assertTrue(service.status()['recovery_required'])
        self.assertEqual(service.current()['version'],'v0.2.0-dev.0')
        self.assertTrue((pipeline.backup/'database.dump').is_file())


if __name__=='__main__':unittest.main()
