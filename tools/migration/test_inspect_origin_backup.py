"""Synthetic integrity/privacy tests; no company data is used."""

import contextlib
import dataclasses
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
import zipfile

from inspect_origin_backup import Inspector, InventoryError, Limits, main, member_path_is_safe, write_inventory


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "input"
        self.source.mkdir()
        self.output = self.root / "inventory.json"

    def tearDown(self):
        self.temp.cleanup()

    def zip_file(self, members, compression=zipfile.ZIP_DEFLATED):
        path = self.source / "backup.zip"
        with zipfile.ZipFile(path, "w", compression=compression) as archive:
            for name, value in members:
                archive.writestr(name, value)
        return path

    def test_hash_and_no_record_contents(self):
        private = b"Nome;CPF;Valor\nPRIVATE_NAME_ABC;12345678900;123.45\n"
        path = self.source / "clientes.csv"
        path.write_bytes(private)
        report = write_inventory(self.source, self.output, Limits())
        self.assertEqual(report["entries"][0]["sha256"], hashlib.sha256(private).hexdigest())
        self.assertEqual(report["entries"][0]["module_hints"], ["contacts"])
        serialized = self.output.read_text()
        for secret in ("PRIVATE_NAME_ABC", "12345678900", "123.45"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual(path.read_bytes(), private)

    def test_safe_zip_hashed_without_extraction(self):
        payload = b"<private>TEST_PRIVATE_VALUE</private>"
        path = self.zip_file([("xml/document.xml", payload)])
        report = Inspector(Limits()).inspect(path)
        member = next(item for item in report["entries"] if item["kind"] == "zip_member")
        self.assertEqual(member["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertNotIn("TEST_PRIVATE_VALUE", json.dumps(report))
        self.assertFalse((self.source / "xml").exists())

    def test_unsafe_paths_rejected_without_reading(self):
        bad = ["../escape.csv", "/absolute.xml", "C:\\temp\\x.xml", "\\\\server\\x", "a/../b", "a//b"]
        for name in bad:
            with self.subTest(name=name):
                self.assertFalse(member_path_is_safe(name))
        path = self.zip_file([(name, "private") for name in bad])
        report = Inspector(Limits()).inspect(path)
        members = [item for item in report["entries"] if item["kind"] == "zip_member"]
        self.assertTrue(all(item["status"] == "UNSAFE_ARCHIVE_PATH" for item in members))
        self.assertTrue(all("sha256" not in item for item in members))
        self.assertFalse((self.root / "escape.csv").exists())

    def test_filesystem_and_zip_symlinks_not_followed(self):
        target = self.root / "private.txt"
        target.write_text("SECRET_SYMLINK_TARGET")
        (self.source / "link.txt").symlink_to(target)
        path = self.source / "archive.zip"
        info = zipfile.ZipInfo("linked")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(info, "../../private.txt")
        report = Inspector(Limits()).inspect(self.source)
        statuses = {item["status"] for item in report["entries"]}
        self.assertIn("SYMLINK_SKIPPED", statuses)
        self.assertIn("SPECIAL_ARCHIVE_ENTRY_SKIPPED", statuses)
        self.assertNotIn("SECRET_SYMLINK_TARGET", json.dumps(report))

    def test_nested_zip_is_pending(self):
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, "w") as archive:
            archive.writestr("hidden.csv", "private_nested_value")
        path = self.zip_file([("nested.zip", nested.getvalue())])
        report = Inspector(Limits()).inspect(path)
        member = next(item for item in report["entries"] if item["kind"] == "zip_member")
        self.assertEqual(member["nested_archive_status"], "INSPECTION_PENDING_NO_RECURSION")
        self.assertNotIn("hidden.csv", json.dumps(report))
        self.assertEqual(len(report["entries"]), 2)

    def test_limits_reject_large_compressed_member(self):
        path = self.zip_file([("large.csv", b"x" * 100000)])
        limits = dataclasses.replace(Limits(), max_member_bytes=1000)
        report = Inspector(limits).inspect(path)
        member = next(item for item in report["entries"] if item["kind"] == "zip_member")
        self.assertEqual(member["status"], "MEMBER_SIZE_LIMIT")
        limits = dataclasses.replace(Limits(), max_compression_ratio=2)
        report = Inspector(limits).inspect(path)
        member = next(item for item in report["entries"] if item["kind"] == "zip_member")
        self.assertEqual(member["status"], "COMPRESSION_RATIO_LIMIT")

    def test_total_hash_budget_and_entry_limit(self):
        (self.source / "one.csv").write_bytes(b"x" * 32)
        (self.source / "two.csv").write_bytes(b"y" * 32)
        report = Inspector(dataclasses.replace(Limits(), max_total_bytes=40)).inspect(self.source)
        self.assertIn("TOTAL_HASH_BYTES_LIMIT", {item["status"] for item in report["entries"]})
        self.assertLessEqual(report["summary"]["bytes_hashed"], 40)
        report = Inspector(dataclasses.replace(Limits(), max_files=1)).inspect(self.source)
        self.assertLessEqual(len(report["entries"]), 1)
        self.assertIn("ENTRY_COUNT_LIMIT", report["summary"]["findings"])

    def test_crc_corruption_is_detected(self):
        path = self.zip_file([("one.csv", b"UNIQUE_ORIGINAL_CONTENT")], compression=zipfile.ZIP_STORED)
        binary = path.read_bytes().replace(b"UNIQUE_ORIGINAL_CONTENT", b"UNIQUE_CORRUPTED_CONTNT")
        path.write_bytes(binary)
        report = Inspector(Limits()).inspect(path)
        member = next(item for item in report["entries"] if item["kind"] == "zip_member")
        self.assertEqual(member["status"], "ZIP_INTEGRITY_ERROR")
        self.assertNotIn("sha256", member)

    def test_invalid_compression_is_reported_without_traceback(self):
        path = self.zip_file([("one.csv", b"sample contents" * 100)])
        binary = bytearray(path.read_bytes())
        # Local header is 30 bytes, followed by this ASCII filename and no extra.
        # Deflate BTYPE=3 is reserved and must fail before any contents are used.
        binary[30 + len("one.csv")] = 0x07
        path.write_bytes(binary)
        report = Inspector(Limits()).inspect(path)
        member = next(item for item in report["entries"] if item["kind"] == "zip_member")
        self.assertEqual(member["status"], "ZIP_INTEGRITY_ERROR")

    def test_identical_contents_and_duplicate_archive_names(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            path = self.zip_file([("one.csv", "same"), ("two.csv", "same"), ("one.csv", "different")])
        report = Inspector(Limits()).inspect(path)
        self.assertEqual(len(report["identical_content_groups"]), 1)
        self.assertIn("DUPLICATE_ARCHIVE_PATH", {item["status"] for item in report["entries"]})

    def test_refuses_overwrite_input_or_output(self):
        path = self.source / "one.csv"
        path.write_text("original")
        with self.assertRaisesRegex(InventoryError, "OUTPUT_INSIDE_SOURCE"):
            write_inventory(path, path, Limits())
        with self.assertRaisesRegex(InventoryError, "OUTPUT_INSIDE_SOURCE"):
            write_inventory(self.source, self.source / "report.json", Limits())
        self.output.write_text("keep")
        with self.assertRaisesRegex(InventoryError, "OUTPUT_ALREADY_EXISTS"):
            write_inventory(self.source, self.output, Limits())
        self.assertEqual(path.read_text(), "original")
        self.assertEqual(self.output.read_text(), "keep")

    def test_cli_does_not_print_names_or_contents(self):
        (self.source / "PERSON_NAME_IN_FILENAME.csv").write_text("PRIVATE_CELL_VALUE")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main([str(self.source), "--output", str(self.output)])
        self.assertEqual(code, 0)
        self.assertNotIn("PERSON_NAME", out.getvalue() + err.getvalue())
        self.assertNotIn("PRIVATE_CELL", out.getvalue() + err.getvalue())
        self.assertNotIn(str(self.source), out.getvalue() + err.getvalue())

    def test_invalid_zip_and_unreasonable_directory_are_reported(self):
        path = self.source / "invalid.zip"
        path.write_bytes(b"not a zip")
        report = Inspector(Limits()).inspect(path)
        self.assertEqual(report["entries"][0]["archive_status"], "INVALID_ZIP_DIRECTORY")
        path = self.zip_file([("one.csv", "one"), ("two.csv", "two")])
        report = Inspector(dataclasses.replace(Limits(), max_files=1)).inspect(path)
        self.assertEqual(report["entries"][0]["archive_status"], "ZIP_MEMBER_COUNT_LIMIT")

    def test_zip64_locator_cannot_bypass_classic_directory_limits(self):
        for comment in (b"", b"c" * 65535):
            with self.subTest(comment_length=len(comment)):
                path = self.zip_file([("one.csv", "one"), ("two.csv", "two")])
                binary = path.read_bytes()
                end_offset = binary.rfind(b"PK\x05\x06")
                fields = struct.unpack_from("<4s4H2LH", binary, end_offset)
                entries, directory_size, directory_offset = fields[4:7]
                end64 = struct.pack(
                    "<4sQ2H2L4Q", b"PK\x06\x06", 44, 45, 45, 0, 0,
                    entries, entries, directory_size, directory_offset,
                )
                locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, end_offset, 1)
                # Small classic values hide the real directory from the old
                # preflight, while ZipFile obtains its values from ZIP64.
                end32 = struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, 0, 0, 0, 0, len(comment))
                path.write_bytes(binary[:end_offset] + end64 + locator + end32 + comment)
                with zipfile.ZipFile(path) as archive:
                    self.assertEqual(len(archive.infolist()), 2)
                limits = dataclasses.replace(Limits(), max_central_directory_bytes=1)
                report = Inspector(limits).inspect(path)
                self.assertEqual(report["entries"][0]["archive_status"], "ZIP64_INSPECTION_PENDING")
                self.assertEqual(len(report["entries"]), 1)


if __name__ == "__main__":
    unittest.main()
