#!/usr/bin/env python3
"""Pack a validated local plan for the admin upload; no network or credentials.

ZIP32, STORE only, no extras/comments/descriptors or directory entries. Original
archives remain opaque byte objects. The input plan and existing outputs are never
changed. A failed output is retained privately and must not be uploaded.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

import stage_origin_backup as stage

MAX_BUNDLE = 512 * 1024 * 1024
MAX_OBJECTS = 9000
MAX_ENTRIES = 19001


def make_bundle(directory, output):
    directory, output = Path(directory), Path(output)
    manifest = stage.validate_plan(directory)
    raw_manifest = stage.read_file(directory / 'manifest.json', 16 * 1024 * 1024)
    if stage.parse_json(raw_manifest) != manifest:
        stage.fail('PLAN_CHANGED_DURING_BUNDLING')
    selected = [('manifest.json', stage.digest(raw_manifest), len(raw_manifest))]
    selected += [(item['local'], item['sha256'], item['size'])
                 for item in manifest['objects'] + manifest['chunks']]
    names = [name for name, _, _ in selected]
    size = 22 + sum(length + 76 + 2 * len(name) for name, _, length in selected)
    if (len(manifest['objects']) > MAX_OBJECTS or len(selected) > MAX_ENTRIES
            or len(set(names)) != len(names) or size > MAX_BUNDLE):
        stage.fail('BUNDLE_SIZE_OR_ENTRY_LIMIT')
    if output.parent.is_symlink() or not output.parent.is_dir():
        stage.fail('INVALID_OUTPUT_DIRECTORY')
    descriptor = os.open(output, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    # A seekable file lets zipfile fill local CRC/sizes instead of descriptors.
    with os.fdopen(descriptor, 'w+b') as stream:
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED,
                             allowZip64=False) as archive:
            archive.comment = b''
            for name, expected_hash, expected_size in selected:
                path = directory / name if name == 'manifest.json' else stage.plan_path(directory, name)
                raw = stage.read_file(path, 16 * 1024 * 1024 if name == 'manifest.json' else stage.MAX_SOURCE)
                if len(raw) != expected_size or stage.digest(raw) != expected_hash:
                    stage.fail('PLAN_CHANGED_DURING_BUNDLING')
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o600) << 16
                info.extra = info.comment = b''
                archive.writestr(info, raw)
        stream.flush()
        os.fsync(stream.fileno())
    if output.stat().st_size != size:
        stage.fail('BUNDLE_SIZE_MISMATCH')
    # Independent readback of every entry verifies CRC, exact bytes and ordering.
    with zipfile.ZipFile(output, 'r') as archive:
        infos = archive.infolist()
        if [info.filename for info in infos] != names or archive.comment:
            stage.fail('BUNDLE_READBACK_MISMATCH')
        for info, (_, expected_hash, expected_size) in zip(infos, selected):
            if (info.compress_type != zipfile.ZIP_STORED or info.flag_bits != 0
                    or info.extra or info.comment or info.is_dir()
                    or info.file_size != expected_size
                    or stage.digest(archive.read(info)) != expected_hash):
                stage.fail('BUNDLE_READBACK_MISMATCH')
    result_hash = hashlib.sha256()
    with stage.open_regular_file(output) as stream:
        while block := stream.read(1024 * 1024):
            result_hash.update(block)
    parent_fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    return {'profile': 'origin-backup-upload-bundle-v1', 'entries': len(selected),
            'size': size, 'sha256': result_hash.hexdigest(),
            'manifest_sha256': stage.digest(raw_manifest),
            'source_sha256': manifest['summary']['source_sha256'],
            'operational_effects': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(make_bundle(args.plan_dir, args.output), sort_keys=True))
    except (stage.StageError, stage.InventoryError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({'error': 'BUNDLE_FAILED_PRIVATE_DETAILS_SUPPRESSED'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
