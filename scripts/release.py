#!/usr/bin/env python3
"""Prepare a signed public source release. This command does not enable GitHub Actions."""
import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'infra'))
from release_protocol import VERSION, atomic_json, digest_file, extract_release, verify_manifest


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True, encoding='utf-8').strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--notes-file', required=True)
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version) or 'v' + json.loads((ROOT / 'package.json').read_text())['version'] != args.version:
        raise SystemExit('RELEASE_VERSION_MUST_MATCH_PACKAGE')
    if git('status', '--porcelain=v1'):
        raise SystemExit('CLEAN_COMMITTED_SOURCE_REQUIRED')
    key, output = Path(args.key).resolve(), Path(args.out).resolve()
    if key.is_relative_to(ROOT):
        relative = key.relative_to(ROOT).as_posix()
        if subprocess.run(['git','-C',str(ROOT),'check-ignore','--quiet',relative]).returncode:
            raise SystemExit('SIGNING_KEY_MUST_BE_OUTSIDE_PUBLIC_SOURCE')
    output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in ('fagoo-source.tar.gz','fagoo-release.json','fagoo-release.sig')):
        raise SystemExit('RELEASE_OUTPUT_ALREADY_EXISTS')
    for line in git('ls-files','--stage').splitlines():
        mode, rest = line.split(' ',1)
        path = rest.split('\t',1)[1]
        if mode == '120000' or path.split('/')[0] in ('.local','private','node_modules','.cache','.wrangler'):
            raise SystemExit('NON_DISTRIBUTABLE_SOURCE_PATH')
    commit = git('rev-parse','HEAD')
    artifact = output / 'fagoo-source.tar.gz'
    process = subprocess.Popen(['git','-C',str(ROOT),'archive','--format=tar',commit], stdout=subprocess.PIPE)
    with gzip.open(artifact,'wb',compresslevel=9) as target:
        shutil.copyfileobj(process.stdout,target)
    if process.wait():
        raise SystemExit('SOURCE_ARCHIVE_FAILED')
    manifest = {'format':2,'product':'fagoo','version':args.version,'minimum_updater':1,
                'platform':'ubuntu-24.04-amd64','database_major':17,'source_commit':commit,
                'published_at':datetime.now(timezone.utc).isoformat(),
                'notes':Path(args.notes_file).read_text(encoding='utf-8').strip(),
                'artifact':{'url':f'https://github.com/Quevenapp/Fagoo/releases/download/{args.version}/fagoo-source.tar.gz',
                            'size':artifact.stat().st_size,'sha256':digest_file(artifact)}}
    atomic_json(output / 'fagoo-release.json',manifest)
    subprocess.run(['openssl','pkeyutl','-sign','-inkey',str(key),'-rawin','-in',str(output/'fagoo-release.json'),
                    '-out',str(output/'fagoo-release.sig')],stdin=subprocess.DEVNULL,check=True)
    verify_manifest(output/'fagoo-release.json',output/'fagoo-release.sig',ROOT/'infra/release-root.pem')
    with tempfile.TemporaryDirectory(prefix='verify-',dir=output) as temporary:
        extract_release(artifact,Path(temporary)/'source',manifest)
    print(json.dumps({'version':args.version,'revision':commit,'source_bytes':artifact.stat().st_size,'signature_verified':True,'output':str(output)}))


if __name__=='__main__':main()
