#!/usr/bin/env python3
"""Inventory a local Origin export without extracting or importing its records.

The JSON report contains private filenames and metadata, never cell/XML contents.
Nested ZIPs and ZIP64 archives are reported for separate inspection, not opened.
Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib


CHUNK = 1024 * 1024


@dataclasses.dataclass(frozen=True)
class Limits:
    max_files: int = 25000
    max_file_bytes: int = 1024 * 1024 * 1024
    max_member_bytes: int = 128 * 1024 * 1024
    max_total_bytes: int = 4 * 1024 * 1024 * 1024
    max_compression_ratio: int = 1000
    max_depth: int = 32
    max_central_directory_bytes: int = 16 * 1024 * 1024


class InventoryError(Exception):
    """A stable error code, deliberately without file contents or OS messages."""


def filename_hints(name: str) -> list[str]:
    """Hints only: actual module identification requires real file schemas."""
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    hints = []
    patterns = {
        "contacts": ("cliente", "fornecedor", "contato"),
        "products": ("produto",),
        "stock": ("estoque", "deposito"),
        "sales": ("venda", "pedido"),
        "purchases": ("compra",),
        "receivables": ("receber",),
        "payables": ("pagar",),
        "cash_and_banks": ("caixa", "banco"),
        "service_orders": ("ordem_servico", "ordens_servico", "ordem de servico", "ordens de servico"),
        "cnab": ("cnab", "remessa", "retorno"),
        "attachments": ("anexo",),
        "structures": ("composic", "estrutura"),
    }
    for module, needles in patterns.items():
        if any(needle in normalized for needle in needles):
            hints.append(module)
    if Path(name).suffix.lower() == ".xml":
        hints.append("xml_document_type_unverified")
    return hints


def member_path_is_safe(name: str) -> bool:
    # Backslashes can become separators on another platform; validate both forms.
    if not name or "\x00" in name or re.match(r"^[A-Za-z]:", name):
        return False
    normalized = name.replace("\\", "/")
    if normalized.startswith("/"):
        return False
    parts = normalized.rstrip("/").split("/")
    return bool(parts) and all(part not in ("", ".", "..") for part in parts)


def format_hint(name: str) -> str:
    extension = Path(name).suffix.lower()
    return {
        ".zip": "zip", ".csv": "csv", ".tsv": "tsv", ".xls": "xls",
        ".xlsx": "xlsx", ".xml": "xml", ".pdf": "pdf", ".txt": "text",
        ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
        ".rem": "cnab_candidate", ".ret": "cnab_candidate",
    }.get(extension, "unknown")


def open_regular_file(path: Path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise InventoryError("NOT_REGULAR_FILE")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def zip_preflight(stream, size: int, limits: Limits) -> None:
    """Bound the central directory before ZipFile allocates its member objects."""
    tail_start = max(0, size - 65557)
    stream.seek(tail_start)
    tail = stream.read(65557)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        raise InventoryError("INVALID_ZIP_DIRECTORY")
    fields = struct.unpack_from("<4s4H2LH", tail, offset)
    _, disk, start_disk, disk_entries, entries, directory_size, directory_offset, comment_size = fields
    if offset + 22 + comment_size != len(tail):
        raise InventoryError("INVALID_ZIP_DIRECTORY")
    # ZipFile honors a ZIP64 locator even without classic EOCD sentinels.
    # Read it separately: a maximum-length comment leaves it outside the tail.
    locator_offset = tail_start + offset - 20
    if locator_offset >= 0:
        stream.seek(locator_offset)
        if stream.read(4) == b"PK\x06\x07":
            raise InventoryError("ZIP64_INSPECTION_PENDING")
    if disk or start_disk or disk_entries != entries:
        raise InventoryError("MULTIDISK_ZIP_NOT_SUPPORTED")
    if entries == 0xFFFF or directory_size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF:
        raise InventoryError("ZIP64_INSPECTION_PENDING")
    if entries > limits.max_files:
        raise InventoryError("ZIP_MEMBER_COUNT_LIMIT")
    if directory_size > limits.max_central_directory_bytes:
        raise InventoryError("ZIP_DIRECTORY_SIZE_LIMIT")
    stream.seek(0)


class Inspector:
    def __init__(self, limits: Limits):
        if any(value <= 0 for value in dataclasses.asdict(limits).values()):
            raise InventoryError("INVALID_LIMIT")
        self.limits = limits
        self.entries = []
        self.findings = []
        self.bytes_hashed = 0
        self.walk_entries = 0

    def add(self, entry: dict) -> bool:
        if len(self.entries) >= self.limits.max_files:
            if "ENTRY_COUNT_LIMIT" not in self.findings:
                self.findings.append("ENTRY_COUNT_LIMIT")
            return False
        self.entries.append(entry)
        return True

    def hash_stream(self, stream, declared_size: int, per_file_limit: int) -> str:
        if declared_size > per_file_limit:
            raise InventoryError("FILE_SIZE_LIMIT")
        if self.bytes_hashed + declared_size > self.limits.max_total_bytes:
            raise InventoryError("TOTAL_HASH_BYTES_LIMIT")
        hasher = hashlib.sha256()
        read_size = 0
        while True:
            # Never ask a decompressor for an unbounded read.
            block = stream.read(min(CHUNK, per_file_limit - read_size + 1))
            if not block:
                break
            read_size += len(block)
            self.bytes_hashed += len(block)
            if read_size > per_file_limit:
                raise InventoryError("FILE_SIZE_LIMIT")
            if self.bytes_hashed > self.limits.max_total_bytes:
                raise InventoryError("TOTAL_HASH_BYTES_LIMIT")
            hasher.update(block)
        if read_size != declared_size:
            raise InventoryError("SIZE_CHANGED_OR_INVALID")
        return hasher.hexdigest()

    def inspect_archive(self, stream, size: int, parent: str, container: dict) -> None:
        try:
            zip_preflight(stream, size, self.limits)
            with zipfile.ZipFile(stream) as archive:
                members = archive.infolist()
                if len(members) > self.limits.max_files:
                    raise InventoryError("ZIP_MEMBER_COUNT_LIMIT")
                names = set()
                for index, info in enumerate(members):
                    member = {
                        "kind": "zip_member",
                        "archive": parent,
                        "path": info.filename,
                        "index": index,
                        "size_bytes": info.file_size,
                        "compressed_bytes": info.compress_size,
                        "extension": Path(info.filename).suffix.lower(),
                        "format_hint": format_hint(info.filename),
                        "module_hints": filename_hints(info.filename),
                        "status": "pending",
                    }
                    if not self.add(member):
                        container["archive_status"] = "partial"
                        break
                    if not member_path_is_safe(info.orig_filename):
                        member["status"] = "UNSAFE_ARCHIVE_PATH"
                        continue
                    if info.filename in names:
                        member["status"] = "DUPLICATE_ARCHIVE_PATH"
                        continue
                    names.add(info.filename)
                    unix_type = stat.S_IFMT(info.external_attr >> 16)
                    if unix_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                        member["status"] = "SPECIAL_ARCHIVE_ENTRY_SKIPPED"
                        continue
                    if info.is_dir():
                        member["status"] = "directory"
                        continue
                    if info.flag_bits & 1:
                        member["status"] = "ENCRYPTED_ENTRY_SKIPPED"
                        continue
                    if info.file_size > self.limits.max_member_bytes:
                        member["status"] = "MEMBER_SIZE_LIMIT"
                        continue
                    if info.file_size > max(1, info.compress_size) * self.limits.max_compression_ratio:
                        member["status"] = "COMPRESSION_RATIO_LIMIT"
                        continue
                    try:
                        with archive.open(info, "r") as member_stream:
                            member["sha256"] = self.hash_stream(member_stream, info.file_size, self.limits.max_member_bytes)
                        member["status"] = "hashed"
                        if member["extension"] == ".zip":
                            member["nested_archive_status"] = "INSPECTION_PENDING_NO_RECURSION"
                    except InventoryError as exc:
                        member["status"] = str(exc)
                    except (zipfile.BadZipFile, EOFError, zlib.error, lzma.LZMAError):
                        member["status"] = "ZIP_INTEGRITY_ERROR"
                    except (RuntimeError, NotImplementedError):
                        member["status"] = "ZIP_ENTRY_UNSUPPORTED"
                    except (OSError, ValueError):
                        member["status"] = "ZIP_ENTRY_READ_ERROR"
                else:
                    container["archive_status"] = "inventoried"
        except InventoryError as exc:
            container["archive_status"] = str(exc)
        except (zipfile.BadZipFile, EOFError, struct.error):
            container["archive_status"] = "INVALID_ZIP"
        except (OSError, ValueError):
            container["archive_status"] = "ZIP_READ_ERROR"

    def inspect_file(self, path: Path, label: str) -> None:
        entry = {
            "kind": "file",
            "path": label,
            "extension": path.suffix.lower(),
            "format_hint": format_hint(path.name),
            "module_hints": filename_hints(path.name),
            "status": "pending",
        }
        if not self.add(entry):
            return
        try:
            with open_regular_file(path) as stream:
                before = os.fstat(stream.fileno())
                size = before.st_size
                entry["size_bytes"] = size
                entry["sha256"] = self.hash_stream(stream, size, self.limits.max_file_bytes)
                entry["status"] = "hashed"
                stream.seek(0)
                signature = stream.read(4)
                if path.suffix.lower() == ".zip" or signature in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
                    entry["detected_type"] = "zip_candidate"
                    self.inspect_archive(stream, size, label, entry)
                after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    entry.pop("sha256", None)
                    entry["status"] = "SOURCE_CHANGED_DURING_INSPECTION"
                    self.findings.append("SOURCE_CHANGED_DURING_INSPECTION")
        except InventoryError as exc:
            entry["status"] = str(exc)
        except OSError:
            entry["status"] = "FILE_READ_ERROR"

    def walk(self, directory: Path, root: Path, depth: int = 0) -> None:
        if depth > self.limits.max_depth:
            self.findings.append("DIRECTORY_DEPTH_LIMIT")
            return
        try:
            with os.scandir(directory) as children:
                for child in children:
                    self.walk_entries += 1
                    if self.walk_entries > self.limits.max_files or len(self.entries) >= self.limits.max_files:
                        if "ENTRY_COUNT_LIMIT" not in self.findings:
                            self.findings.append("ENTRY_COUNT_LIMIT")
                        return
                    path = Path(child.path)
                    label = path.relative_to(root).as_posix()
                    if child.is_symlink():
                        self.add({"kind": "symlink", "path": label, "status": "SYMLINK_SKIPPED"})
                    elif child.is_dir(follow_symlinks=False):
                        self.walk(path, root, depth + 1)
                    elif child.is_file(follow_symlinks=False):
                        self.inspect_file(path, label)
                    else:
                        self.add({"kind": "special", "path": label, "status": "SPECIAL_FILE_SKIPPED"})
        except OSError:
            self.findings.append("DIRECTORY_READ_ERROR")

    def inspect(self, source: Path) -> dict:
        if source.is_symlink():
            raise InventoryError("SOURCE_SYMLINK_NOT_ALLOWED")
        if source.is_dir():
            source_type = "directory"
            self.walk(source, source)
        elif source.is_file():
            source_type = "file"
            self.inspect_file(source, source.name)
        else:
            raise InventoryError("SOURCE_NOT_FOUND_OR_NOT_REGULAR")
        self.entries.sort(key=lambda item: (item.get("archive", ""), item["path"], item.get("index", -1)))
        digest_paths = {}
        for entry in self.entries:
            if "sha256" in entry:
                digest_paths.setdefault(entry["sha256"], []).append({"archive": entry.get("archive"), "path": entry["path"], "index": entry.get("index")})
        attention = sum(
            entry["status"] not in ("hashed", "directory")
            or entry.get("archive_status") not in (None, "inventoried")
            or "nested_archive_status" in entry
            for entry in self.entries
        )
        return {
            "schema_version": 1,
            "purpose": "diagnostic_inventory_only_no_import",
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source": {"type": source_type, "label": source.name},
            "privacy": "Private filenames and metadata. No record contents. Keep report private.",
            "limits": dataclasses.asdict(self.limits),
            "summary": {"entries": len(self.entries), "attention_entries": attention, "bytes_hashed": self.bytes_hashed, "findings": sorted(set(self.findings))},
            "identical_content_groups": [{"sha256": digest, "entries": paths} for digest, paths in sorted(digest_paths.items()) if len(paths) > 1],
            "entries": self.entries,
        }


def write_inventory(source: Path, output: Path, limits: Limits) -> dict:
    source = source.absolute()
    output = output.absolute()
    # Resolving parents also catches a report path aliased back into the input.
    source_real = source.resolve()
    output_real = output.resolve()
    if output_real == source_real or (source.is_dir() and output_real.is_relative_to(source_real)):
        raise InventoryError("OUTPUT_INSIDE_SOURCE_NOT_ALLOWED")
    if output.exists() or output.is_symlink():
        raise InventoryError("OUTPUT_ALREADY_EXISTS")
    report = Inspector(limits).inspect(source)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(output, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
    except FileExistsError:
        raise InventoryError("OUTPUT_ALREADY_EXISTS") from None
    except OSError:
        raise InventoryError("OUTPUT_WRITE_ERROR") from None
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Inventário privado de backup Origin; não extrai nem importa dados.")
    parser.add_argument("source", type=Path, help="ZIP, outro arquivo ou pasta local de exportações")
    parser.add_argument("--output", required=True, type=Path, help="JSON novo, fora da pasta de origem; diretório deve existir")
    defaults = Limits()
    for field in dataclasses.fields(defaults):
        parser.add_argument("--" + field.name.replace("_", "-"), type=int, default=getattr(defaults, field.name))
    args = parser.parse_args(argv)
    limits = Limits(**{field.name: getattr(args, field.name) for field in dataclasses.fields(defaults)})
    try:
        report = write_inventory(args.source, args.output, limits)
    except InventoryError as exc:
        print(f"Inventário não concluído ({exc}).", file=sys.stderr)
        return 1
    except OSError:
        print("Inventário não concluído (FILESYSTEM_ERROR).", file=sys.stderr)
        return 1
    summary = report["summary"]
    print(f"Inventário gravado: {summary['entries']} entradas; {summary['attention_entries']} exigem atenção.")
    return 2 if summary["attention_entries"] or summary["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
