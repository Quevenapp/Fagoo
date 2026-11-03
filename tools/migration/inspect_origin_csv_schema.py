#!/usr/bin/env python3
"""Read-only schema/coverage diagnostics for CSV members of a Origin ZIP.

Never prints or retains CSV record values. This is not an import adapter.
"""

import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import unicodedata
import zipfile

from inspect_origin_backup import InventoryError, Limits, member_path_is_safe, open_regular_file, zip_preflight


MAX_CSV_BYTES = 64 * 1024 * 1024
MAX_ROWS = 500000
MAX_COLUMNS = 500


def normalized(value):
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower().strip()


def decode_text(raw):
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="strict"), "utf-16-with-bom"
    try:
        return raw.decode("utf-8-sig", errors="strict"), "utf-8-with-bom" if raw.startswith(b"\xef\xbb\xbf") else "utf-8-compatible"
    except UnicodeDecodeError:
        try:
            return raw.decode("cp1252", errors="strict"), "windows-1252-compatible-not-authoritatively-declared"
        except UnicodeDecodeError:
            return raw.decode("latin-1", errors="strict"), "iso-8859-1-compatible-not-authoritatively-declared"


def diagnose(raw, name):
    text, encoding = decode_text(raw)
    candidate_counts = {}
    for delimiter in (";", ",", "\t", "|"):
        try:
            first = next(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True), [])
            candidate_counts[delimiter] = len(first)
        except csv.Error:
            candidate_counts[delimiter] = 0
    delimiter = max(candidate_counts, key=candidate_counts.get)
    if candidate_counts[delimiter] <= 1:
        raise InventoryError("DELIMITER_UNRESOLVED")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
    headers = next(reader)
    if len(headers) > MAX_COLUMNS:
        raise InventoryError("COLUMN_LIMIT")
    columns, unique_sets = [], {}
    for index, header in enumerate(headers):
        label = normalized(header)
        identity = bool(re.search(r"(^id($|\b|_)|\bid\b|codigo|cpf|cnpj|numero|\bsku\b|gtin|^n\s+do pedido|n[ºo°]\.?\s*documento|\bnro?\b|chave)", label))
        link = bool(re.search(r"url|link|anexo|imagem", label))
        column = {"index": index + 1, "header": header, "blank": 0, "nonblank": 0, "min_length": None, "max_length": 0, "identity_candidate": identity, "link_candidate": link, "url_shaped_cells": 0, "formula_prefix_cells": 0}
        if identity:
            unique_sets[index] = set()
            column.update({"digits_only_cells": 0, "leading_zero_cells": 0})
        columns.append(column)
    widths = collections.Counter()
    row_hashes = set()
    duplicate_rows = rows = blank_rows = 0
    formula_prefix_cells = 0
    for row in reader:
        if not row or not any(value.strip() for value in row):
            blank_rows += 1
            continue
        rows += 1
        if rows > MAX_ROWS:
            raise InventoryError("ROW_LIMIT")
        widths[len(row)] += 1
        digest = hashlib.sha256(json.dumps(row, ensure_ascii=False).encode()).digest()
        duplicate_rows += digest in row_hashes
        row_hashes.add(digest)
        for index, column in enumerate(columns):
            value = row[index] if index < len(row) else ""
            # Whitespace is ignored only for blank and shape diagnostics, not written back.
            trimmed = value.strip()
            if not trimmed:
                column["blank"] += 1
                continue
            column["nonblank"] += 1
            length = len(value)
            column["min_length"] = min(column["min_length"], length) if column["min_length"] is not None else length
            column["max_length"] = max(column["max_length"], length)
            if trimmed.startswith(("=", "+", "-", "@")):
                column["formula_prefix_cells"] += 1
                formula_prefix_cells += 1
            if re.match(r"https?://", trimmed, flags=re.I):
                column["url_shaped_cells"] += 1
            if index in unique_sets:
                unique_sets[index].add(hashlib.sha256(value.encode()).digest())
                column["digits_only_cells"] += trimmed.isdigit()
                column["leading_zero_cells"] += len(trimmed) > 1 and trimmed.startswith("0") and trimmed.isdigit()
    for index, values in unique_sets.items():
        columns[index]["distinct_nonblank"] = len(values)
        columns[index]["repeated_nonblank_rows"] = columns[index]["nonblank"] - len(values)
    return {
        "member": name, "sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw),
        "encoding": encoding, "delimiter": delimiter, "quotechar": '"', "strict_csv_parse": True,
        "header_columns": len(headers), "rows_excluding_header_and_blank": rows,
        "blank_records": blank_rows, "physical_lines": reader.line_num,
        "row_width_counts": dict(sorted(widths.items())),
        "wrong_width_rows": sum(count for width, count in widths.items() if width != len(headers)),
        "exact_duplicate_rows": duplicate_rows,
        "duplicate_headers": [label for label, count in collections.Counter(headers).items() if count > 1],
        "formula_like_prefix_cells_not_executed": formula_prefix_cells,
        "columns": columns,
    }


def relation_diagnostics(archive):
    """Compare candidate keys in memory, returning counts only, never values."""
    required = {"contatos.csv", "produtos.csv", "pedidos_compra.csv", "pedidos_venda.csv", "saldos_estoque.csv", "contas_receber.csv", "contas_pagar.csv"}
    if not required.issubset(archive.namelist()):
        return {"status": "EXPECTED_SCHEMA_NOT_PRESENT"}
    def rows(name):
        raw = archive.read(name)
        if len(raw) > MAX_CSV_BYTES:
            raise InventoryError("CSV_SIZE_LIMIT")
        text, _ = decode_text(raw)
        return list(csv.DictReader(io.StringIO(text, newline=""), delimiter=";", strict=True))
    def doc(value):
        return re.sub(r"[^A-Za-z0-9]", "", value).upper()
    def coverage(records, column, targets, transform=lambda value: value.strip()):
        counters = collections.Counter()
        for record in records:
            key = transform(record.get(column, "") or "")
            if not key:
                counters["blank_key_rows"] += 1
            elif targets[key] == 1:
                counters["unique_candidate_rows"] += 1
            elif targets[key] > 1:
                counters["ambiguous_candidate_rows"] += 1
            else:
                counters["no_candidate_rows"] += 1
        return {name: counters[name] for name in ("blank_key_rows", "unique_candidate_rows", "ambiguous_candidate_rows", "no_candidate_rows")}
    contacts, products, stocks = rows("contatos.csv"), rows("produtos.csv"), rows("saldos_estoque.csv")
    contact_docs = collections.Counter(doc(row["CNPJ / CPF"]) for row in contacts if doc(row["CNPJ / CPF"]))
    product_ids = collections.Counter(row["ID"].strip() for row in products)
    product_skus = collections.Counter(row["Código"].strip() for row in products if row["Código"].strip())
    result = {
        "meaning": "Candidate-key coverage only; no records linked or changed, no semantic identity guaranteed.",
        "stock_to_products_by_id": coverage(stocks, "ID Produto", product_ids),
        "stock_distinct_deposit_labels": len({row["Depósito*"] for row in stocks}),
        "products_without_stock_record_by_id": len(set(product_ids) - {row["ID Produto"].strip() for row in stocks}),
        "duplicate_product_sku_groups": sum(count > 1 for count in product_skus.values()),
        "duplicate_contact_document_groups_after_punctuation_removal": sum(count > 1 for count in contact_docs.values()),
    }
    for name, document_field, order_field in (
        ("pedidos_venda.csv", "CPF/CNPJ Comprador", "Número pedido"),
        ("pedidos_compra.csv", "CPF/CNPJ do contato", "N° do pedido"),
        ("contas_receber.csv", "CPF/CNPJ", None),
        ("contas_pagar.csv", "CPF/CNPJ", None),
    ):
        records = rows(name)
        entry = {"contact_document_candidates": coverage(records, document_field, contact_docs, doc)}
        if order_field:
            entry["product_sku_candidates"] = coverage(records, "SKU", product_skus)
            groups = collections.defaultdict(set)
            for row in records:
                groups[row[order_field]].add((row["Data"], doc(row[document_field])))
            entry["distinct_order_numbers"] = len(groups)
            entry["order_numbers_with_multiple_date_document_pairs"] = sum(len(values) > 1 for values in groups.values())
        result[name] = entry
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() == args.source.resolve() or args.output.exists():
        raise InventoryError("OUTPUT_MUST_BE_NEW")
    csv.field_size_limit(4 * 1024 * 1024)
    report = {"purpose": "read_only_schema_diagnostics_no_import_no_financial_recalculation", "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "source_name": args.source.name, "privacy": "Column labels and aggregate counts only; no CSV cell values.", "files": []}
    with open_regular_file(args.source) as stream:
        size = os.fstat(stream.fileno()).st_size
        if size > Limits().max_file_bytes:
            raise InventoryError("SOURCE_SIZE_LIMIT")
        report["source_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
        zip_preflight(stream, size, Limits())
        with zipfile.ZipFile(stream) as archive:
            seen = set()
            total = 0
            for info in archive.infolist():
                if not info.filename.lower().endswith(".csv"):
                    continue
                if not member_path_is_safe(info.orig_filename) or info.filename in seen:
                    raise InventoryError("UNSAFE_OR_DUPLICATE_MEMBER")
                seen.add(info.filename)
                total += info.file_size
                if info.file_size > MAX_CSV_BYTES or total > 256 * 1024 * 1024:
                    raise InventoryError("CSV_SIZE_LIMIT")
                if info.flag_bits & 1 or info.file_size > max(1, info.compress_size) * 1000:
                    raise InventoryError("UNSUPPORTED_OR_EXCESSIVE_COMPRESSION")
                report["files"].append(diagnose(archive.read(info), info.filename))
            report["candidate_relations"] = relation_diagnostics(archive)
        stream.seek(0)
        if hashlib.file_digest(stream, "sha256").hexdigest() != report["source_sha256"]:
            raise InventoryError("SOURCE_CHANGED")
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(report, out, ensure_ascii=False, indent=2)
        out.write("\n")
    print(f"Diagnóstico privado gravado: {len(report['files'])} CSVs; nenhum registro importado.")


if __name__ == "__main__":
    try:
        main()
    except (InventoryError, OSError, csv.Error, UnicodeError, zipfile.BadZipFile) as exc:
        # No exception messages from input parsers: they can include source values.
        print(f"Diagnóstico não concluído ({type(exc).__name__}).")
        raise SystemExit(1)
