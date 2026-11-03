import io
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

import bundle_origin_backup as bundle
import stage_origin_backup as stage


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('contatos.csv', b'ID;Nome\n0001;PRIVATE_NAME\n')
        self.source = raw.getvalue()
        (self.root / 'source.zip').write_bytes(self.source)
        self.plan, self.output = self.root / 'plan', self.root / 'bundle.zip'
        stage.prepare(self.root / 'source.zip', self.plan)

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_entries_bytes_crc_and_seekable_store_headers(self):
        result = bundle.make_bundle(self.plan, self.output)
        self.assertNotIn('PRIVATE_NAME', str(result))
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual(result['sha256'], stage.digest(self.output.read_bytes()))
        with zipfile.ZipFile(self.output) as archive:
            manifest = stage.validate_plan(self.plan)
            self.assertEqual(archive.namelist(), ['manifest.json'] + [x['local'] for x in manifest['objects'] + manifest['chunks']])
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read(f"objects/{manifest['summary']['source_sha256']}.zip"), self.source)
            cursor = 0
            with self.output.open('rb') as stream:
                for entry in archive.infolist():
                    self.assertEqual(entry.header_offset, cursor)
                    stream.seek(cursor)
                    header = struct.unpack('<IHHHHHIIIHH', stream.read(30))
                    self.assertEqual(header[0], 0x04034b50)
                    self.assertEqual(header[2:4], (0, 0))  # No flags or compression.
                    self.assertEqual(header[6:9], (entry.CRC, entry.file_size, entry.file_size))
                    self.assertEqual(header[10], 0)
                    self.assertEqual(entry.extra + entry.comment, b'')
                    self.assertEqual(stat.S_IFMT(entry.external_attr >> 16), stat.S_IFREG)
                    cursor += 30 + len(entry.filename) + entry.file_size
                self.assertEqual(cursor, archive.start_dir)

    def test_existing_output_and_symlink_are_never_overwritten(self):
        self.output.write_bytes(b'original')
        with self.assertRaises(FileExistsError):
            bundle.make_bundle(self.plan, self.output)
        self.assertEqual(self.output.read_bytes(), b'original')
        link = self.root / 'link.zip'
        link.symlink_to(self.output)
        with self.assertRaises(FileExistsError):
            bundle.make_bundle(self.plan, link)
        self.assertEqual(self.output.read_bytes(), b'original')

    def test_changed_object_is_rejected_before_output_creation(self):
        obj = stage.validate_plan(self.plan)['objects'][0]
        (self.plan / obj['local']).write_bytes(b'changed')
        with self.assertRaisesRegex(stage.StageError, 'PLAN_OBJECT_INTEGRITY_FAILURE'):
            bundle.make_bundle(self.plan, self.output)
        self.assertFalse(self.output.exists())

    def test_change_after_validation_is_detected_and_partial_stays_private(self):
        original = stage.read_file
        reads = 0
        def changing(path, limit):
            nonlocal reads
            if Path(path).name == 'manifest.json':
                reads += 1
                if reads == 3:
                    return b'changed'
            return original(path, limit)
        with mock.patch.object(stage, 'read_file', side_effect=changing):
            with self.assertRaisesRegex(stage.StageError, 'PLAN_CHANGED_DURING_BUNDLING'):
                bundle.make_bundle(self.plan, self.output)
        self.assertTrue(self.output.exists())
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)

    def test_size_limit_refuses_before_creating_output(self):
        with mock.patch.object(bundle, 'MAX_BUNDLE', 10):
            with self.assertRaisesRegex(stage.StageError, 'BUNDLE_SIZE_OR_ENTRY_LIMIT'):
                bundle.make_bundle(self.plan, self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
