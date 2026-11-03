#!/usr/bin/env python3
"""Recover an interrupted update from its own verified backup, with explicit operator confirmation."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

from release_protocol import atomic_json, digest_file
from update_agent import Updater
from update_pipeline import Pipeline


def validate_recovery(root, backup_id):
    root = Path(root).resolve()
    if not re.fullmatch(r'update-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', backup_id):
        raise ValueError('INVALID_BACKUP_ID')
    backup = root / 'private/backups' / backup_id
    if backup.is_symlink() or not backup.resolve().is_relative_to(root / 'private/backups'):
        raise ValueError('UNTRUSTED_BACKUP_PATH')
    value = json.loads((backup / 'recovery.json').read_text())
    source = Path(value['previous']['source_dir']).resolve()
    if source != root and not source.is_relative_to(root / 'private/updates/releases'):
        raise ValueError('UNTRUSTED_PREVIOUS_SOURCE')
    if value.get('backup_complete'):
        for name in ('database.dump','storage.tar','runtime.env','previous-runtime-images.json'):
            if digest_file(backup / name) != value.get('sha256',{}).get(name):
                raise ValueError('RECOVERY_BACKUP_DIGEST_MISMATCH')
        with tarfile.open(backup/'storage.tar','r:') as archive:
            for item in archive:
                if item.name.startswith('/') or '..' in Path(item.name).parts or not (item.isfile() or item.isdir()):
                    raise ValueError('UNSAFE_STORAGE_BACKUP')
    return backup,value


def restore_cloudflare(pipeline, versions):
    for name, entries in versions.items():
        if not re.fullmatch(r'fagoo-(?:api|web)-[a-f0-9]{12}',name) or not isinstance(entries,list):
            raise ValueError('INVALID_CLOUDFLARE_RECOVERY')
        cleaned=[]
        for entry in entries:
            if not re.fullmatch('[a-f0-9-]{36}',str(entry.get('version_id',''))) or type(entry.get('percentage')) not in (int,float) or not 0<=entry['percentage']<=100:
                raise ValueError('INVALID_CLOUDFLARE_RECOVERY')
            cleaned.append({'version_id':entry['version_id'],'percentage':entry['percentage']})
        if sum(e['percentage'] for e in cleaned)!=100:
            raise ValueError('INVALID_CLOUDFLARE_RECOVERY')
        url=f"https://api.cloudflare.com/client/v4/accounts/{pipeline.credentials['account_id']}/workers/scripts/{name}/deployments"
        request=urllib.request.Request(url,method='POST',data=json.dumps({'strategy':'percentage','versions':cleaned}).encode(),
            headers={'Authorization':'Bearer '+pipeline.credentials['token'],'Content-Type':'application/json','Accept':'application/json'})
        from deploy_application_recovery import no_redirect_opener
        with no_redirect_opener().open(request,timeout=30) as response:
            result=json.loads(response.read(65537))
        if result.get('success') is not True:raise ValueError('CLOUDFLARE_RECOVERY_FAILED')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True)
    parser.add_argument('--backup-id',required=True)
    parser.add_argument('--confirm-restore',action='store_true',help='Acknowledge that the installation returns to the selected pre-update backup.')
    args=parser.parse_args()
    if os.name!='posix' or os.geteuid()!=0:raise SystemExit('Run with sudo on the Ubuntu server.')
    if not args.confirm_restore:raise SystemExit('Read the recovery guide, then supply --confirm-restore for the selected backup.')
    root=Path(args.root).resolve()
    state=json.loads((root/'private/updates/state.json').read_text())
    if state.get('state') in ('queued','running','checking') or not state.get('recovery_required'):
        raise SystemExit('RECOVERY_REQUIRES_AN_INTERRUPTED_UPDATE')
    backup,recovery=validate_recovery(root,args.backup_id)
    if state.get('backup_id')!=args.backup_id:raise SystemExit('BACKUP_DOES_NOT_MATCH_INTERRUPTED_UPDATE')
    if recovery.get('runtime_changed') and not recovery.get('backup_complete'):raise SystemExit('COMPLETE_BACKUP_REQUIRED')
    subprocess.run(['systemctl','stop','fagoo-updater.service'],check=True)
    service=Updater(root)
    pipeline=Pipeline(service)
    source=Path(recovery['previous']['source_dir']).resolve()
    atomic_json(pipeline.maintenance,{'recovery':args.backup_id})
    pipeline.log=(backup/'recovery.log').open('a',encoding='utf-8')
    try:
        pipeline.compose(source,'stop','--timeout','30','auth','rest','storage')
        if recovery.get('runtime_changed'):
            shutil.copyfile(backup/'runtime.env', pipeline.env_file)
            os.chmod(pipeline.env_file, 0o600)
            record=json.loads((backup/'previous-runtime-images.json').read_text())
            images={item['service']:item['image_id'] for item in record['containers']}
            if set(images)!={'db','auth','rest','storage','gateway'} or any(not re.fullmatch('sha256:[a-f0-9]{64}',v) for v in images.values()):
                raise ValueError('PREVIOUS_RUNTIME_IMAGES_INVALID')
            override=backup/'recovery-images.json'
            atomic_json(override,{'services':{name:{'image':image} for name,image in images.items()}})
            command=['docker','compose','--project-name','fagoo','--env-file',pipeline.env_file,'-f',source/'infra/compose.yaml','-f',override]
            pipeline.run([*command,'up','-d','--wait','db'])
            pipeline.run([*command,'exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','template1','-c',
                "ALTER DATABASE postgres ALLOW_CONNECTIONS false; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres';"])
            with (backup/'database.dump').open('rb') as data:
                subprocess.run([str(x) for x in [*command,'exec','-T','db','pg_restore','-U','supabase_admin','-d','template1','--clean','--if-exists','--create','--exit-on-error']],stdin=data,stdout=subprocess.DEVNULL,stderr=pipeline.log,check=True,timeout=1800)
            # Exact object volume of this installation; the operator explicitly selected its pre-update backup.
            pipeline.run([*command,'run','-T','--rm','--no-deps','--entrypoint','sh','storage','-c',
                'find /var/lib/storage -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'])
            with (backup/'storage.tar').open('rb') as data:
                subprocess.run([str(x) for x in [*command,'run','-T','--rm','--no-deps','--entrypoint','tar','storage','-xf','-','-C','/var/lib/storage']],stdin=data,stdout=subprocess.DEVNULL,stderr=pipeline.log,check=True,timeout=1800)
            pipeline.run([*command,'up','-d','--wait','--wait-timeout','300'])
            restore_cloudflare(pipeline,recovery['cloudflare'])
        else:
            pipeline.compose(source,'up','-d','--wait','--wait-timeout','300')
        previous=recovery['previous']
        pipeline.check_public_version({'source_commit':previous['revision'],'version':previous['version']})
        pipeline.maintenance.unlink()
        pipeline.check_health()
        atomic_json(root/'private/updates/installed.json',previous)
        service.save(state='failed',phase='idle',error='UPDATE_RECOVERED',recovery_required=False)
        lock=root/'private/update-fagoo.lock'
        if lock.exists():
            # The service is stopped and the selected interrupted job was recovered.
            (lock/'owner.json').unlink(missing_ok=True)
            lock.rmdir()
        print('Previous installation restored and verified. The backup was preserved.')
    except Exception:
        atomic_json(pipeline.maintenance,{'recovery':args.backup_id})
        raise
    finally:
        pipeline.log.close()
        pipeline.log=None
        subprocess.run(['systemctl','start','fagoo-updater.service'],check=True)


if __name__=='__main__':
    os.umask(0o077)
    main()
