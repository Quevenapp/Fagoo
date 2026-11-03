#!/usr/bin/env python3
"""Prepare an immutable private staging plan; apply only through an explicit command.

No ERP effects, inferred joins, amount/date conversion, XML signing or transmission.
Only aggregates/error codes are written to stdout. Prepared files contain private data.
"""
import argparse
import base64
import collections
import concurrent.futures
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.request
import zipfile

from inspect_origin_backup import InventoryError, Limits, member_path_is_safe, open_regular_file, zip_preflight
from inspect_origin_xml import NS, DS, safe_xml

VERSION = 1
BUCKET = 'origin-backups'
MAX_SOURCE = 40 * 1024 * 1024
MAX_MEMBER = 40 * 1024 * 1024
MAX_NESTED_ARCHIVE = 128 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_ENTRIES = 25000
MAX_ROWS = 500000
MAX_CHUNK = 2 * 1024 * 1024
KINDS = ('file', 'csv', 'xml', 'issue')
CSV_TYPES = {
    'contatos.csv': ('contacts', 'ID', ('ID', 'Nome')),
    'produtos.csv': ('products', 'ID', ('ID', 'Descrição')),
    'pedidos_compra.csv': ('purchase_orders', None, ('N° do pedido', 'SKU')),
    'pedidos_venda.csv': ('sales_orders', None, ('Número pedido', 'SKU')),
    'caixa_bancos.csv': ('cash_movements', 'Id', ('Id', 'Histórico')),
    'contas_receber.csv': ('receivables', 'ID', ('ID', 'Cliente')),
    'contas_pagar.csv': ('payables', 'ID', ('ID', 'Fornecedor')),
    'saldos_estoque.csv': ('stock_snapshot', None, ('ID Produto', 'Depósito*')),
}


class StageError(Exception):
    """Public code only: never include a source record, filename or credential."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fail(code):
    raise StageError(code)


def read_file(path, limit):
    with open_regular_file(Path(path)) as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            fail('LOCAL_FILE_SIZE_LIMIT')
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        fail('LOCAL_FILE_SIZE_LIMIT')
    return raw


def write_private(path, raw):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=reject_duplicates, parse_constant=lambda _: fail('INVALID_JSON_NUMBER'))
    except (ValueError, UnicodeError):
        fail('INVALID_JSON')


class Plan:
    def __init__(self, directory):
        self.directory = Path(directory)
        if self.directory.exists() or self.directory.is_symlink():
            fail('OUTPUT_ALREADY_EXISTS')
        self.directory.mkdir(mode=0o700, parents=True)
        os.chmod(self.directory, 0o700)
        (self.directory / 'objects').mkdir(mode=0o700)
        (self.directory / 'chunks').mkdir(mode=0o700)
        self.buffers = {kind: [] for kind in KINDS}
        self.buffer_bytes = collections.Counter()
        self.counts = collections.Counter()
        self.chunks = []
        self.objects = {}
        self.issue_numbers = collections.Counter()

    def blob(self, raw, kind):
        sha = digest(raw)
        extension, mime = {'archive': ('zip', 'application/zip'), 'csv': ('csv', 'text/csv'), 'xml': ('xml', 'application/xml')}.get(kind, ('bin', 'application/octet-stream'))
        name = f'{sha}.{extension}'
        if name not in self.objects:
            write_private(self.directory / 'objects' / name, raw)
            self.objects[name] = {'local': f'objects/{name}', 'key': f'objects/{name}', 'sha256': sha, 'size': len(raw), 'content_type': mime}
        return self.objects[name]

    def add(self, kind, file_id, number, data):
        record = {'file_id': file_id, 'record_no': number, 'data': data}
        length = len(canonical(record))
        if length > MAX_CHUNK - 1024:
            fail('SINGLE_RECORD_SIZE_LIMIT')
        if len(self.buffers[kind]) >= 250 or self.buffer_bytes[kind] + length > MAX_CHUNK - 1024:
            self.flush(kind)
        self.buffers[kind].append(record)
        self.buffer_bytes[kind] += length + 1
        self.counts[kind] += 1

    def issue(self, file_id, code, row_number=None):
        self.issue_numbers[file_id] += 1
        data = {'code': code}
        if row_number is not None:
            data['source_record_no'] = row_number
        self.add('issue', file_id, self.issue_numbers[file_id], data)

    def flush(self, kind):
        if not self.buffers[kind]:
            return
        raw = canonical(self.buffers[kind])
        sha = digest(raw)
        name = f'chunks/{kind}-{len(self.chunks):05d}-{sha}.json'
        write_private(self.directory / name, raw)
        self.chunks.append({'local': name, 'kind': kind, 'id': sha, 'sha256': sha, 'records': len(self.buffers[kind]), 'size': len(raw)})
        self.buffers[kind] = []
        self.buffer_bytes[kind] = 0


def prepare(source, directory):
    source_raw = read_file(source, MAX_SOURCE)
    source_sha = digest(source_raw)
    plan = Plan(directory)
    expanded = entries = csv_rows = 0
    csv_counts = collections.Counter()
    models = collections.Counter()
    unique_keys = collections.defaultdict(set)
    canonical_xml = collections.defaultdict(list)
    original_object = plan.blob(source_raw, 'archive')

    def stage_csv(raw, name, file_id):
        nonlocal csv_rows
        if name not in CSV_TYPES:
            plan.issue(file_id, 'CSV_MODULE_UNRECOGNIZED')
            return
        entity, native_field, required = CSV_TYPES[name]
        try:
            decoded = raw.decode('utf-8-sig', errors='strict')
        except UnicodeError:
            plan.issue(file_id, 'CSV_ENCODING_REQUIRES_REVIEW')
            return
        # This adapter is intentionally calibrated to the inspected UTF-8/semicolon backup.
        reader = csv.reader(io.StringIO(decoded, newline=''), delimiter=';', strict=True)
        csv.field_size_limit(1024 * 1024)
        try:
            headers = next(reader, [])
            if not headers or len(headers) > 500 or len(set(headers)) != len(headers) or any(not h for h in headers) or not set(required).issubset(headers):
                plan.issue(file_id, 'CSV_SCHEMA_REQUIRES_REVIEW')
                return
            for number, values in enumerate(reader, 1):
                if not values or not any(v.strip() for v in values):
                    continue
                csv_rows += 1
                if csv_rows > MAX_ROWS:
                    fail('CSV_TOTAL_ROW_LIMIT')
                if len(values) != len(headers):
                    plan.issue(file_id, 'CSV_ROW_WIDTH_MISMATCH', number)
                    continue
                payload = dict(zip(headers, values))  # Exact strings, including leading zeroes.
                native_id = payload[native_field] if native_field else None
                if native_id and not re.fullmatch(r'\d{1,40}', native_id):
                    plan.issue(file_id, 'CSV_SOURCE_ID_REQUIRES_REVIEW', number)
                    native_id = None
                plan.add('csv', file_id, number, {'entity': entity, 'source_id': native_id or None, 'payload': payload, 'encoding': 'utf-8', 'delimiter': ';'})
                csv_counts[entity] += 1
        except csv.Error:
            plan.issue(file_id, 'CSV_PARSE_REQUIRES_REVIEW')

    def stage_xml(raw, file_id):
        result = {'sha256': digest(raw), 'kind': 'unknown', 'validation': 'structural_only', 'signature_verified': False, 'xsd_validated': False}
        try:
            root = safe_xml(raw)
        except Exception:
            plan.issue(file_id, 'XML_PARSE_OR_DECLARATION_REJECTED')
            plan.add('xml', file_id, 0, result)
            return
        invoices = [root] if root.tag == NS + 'NFe' else root.findall('.//' + NS + 'NFe')
        events = [root] if root.tag == NS + 'evento' else root.findall('.//' + NS + 'evento')
        if len(invoices) == 1 and not events:
            node = invoices[0]
            info = node.find(NS + 'infNFe')
            identifier = info.attrib.get('Id', '') if info is not None else ''
            key = identifier[3:] if re.fullmatch(r'NFe\d{44}', identifier) else None
            model = info.findtext(NS + 'ide/' + NS + 'mod') if info is not None else None
            environment = info.findtext(NS + 'ide/' + NS + 'tpAmb') if info is not None else None
            signature = node.find(DS + 'Signature') is not None
            protocols = root.findall('.//' + NS + 'protNFe/' + NS + 'infProt')
            matching = [p for p in protocols if key and p.findtext(NS + 'chNFe') == key and p.findtext(NS + 'nProt')]
            result.update(kind='invoice', key=key, model=model, environment=environment, signature_present=signature, protocol_present=bool(matching), protocol=matching[0].findtext(NS + 'nProt') if matching else None)
            if not key:
                plan.issue(file_id, 'INVOICE_KEY_INVALID_OR_MISSING')
            if model not in ('55', '65') or (key and key[20:22] != model):
                plan.issue(file_id, 'INVOICE_MODEL_REQUIRES_REVIEW')
            if environment not in ('1', '2'):
                plan.issue(file_id, 'INVOICE_ENVIRONMENT_REQUIRES_REVIEW')
            if not signature:
                plan.issue(file_id, 'INVOICE_SIGNATURE_ELEMENT_ABSENT')
            if not matching:
                plan.issue(file_id, 'INVOICE_PROTOCOL_ABSENT')
            models[str(model)] += 1
            if key:
                unique_keys[str(model)].add(key)
                canonical_xml[('invoice', environment, key)].append((file_id, result['sha256']))
        elif len(events) == 1 and not invoices:
            node = events[0]
            info = node.find(NS + 'infEvento')
            event_id = info.attrib.get('Id', '') if info is not None else ''
            def event_text(tag):
                return info.findtext(NS + tag) if info is not None else None
            key, event_type, sequence = event_text('chNFe'), event_text('tpEvento'), event_text('nSeqEvento')
            environment = event_text('tpAmb')
            signature = node.find(DS + 'Signature') is not None
            protocols = root.findall('.//' + NS + 'retEvento/' + NS + 'infEvento')
            matching = [p for p in protocols if p.findtext(NS + 'chNFe') == key and p.findtext(NS + 'tpEvento') == event_type and p.findtext(NS + 'nSeqEvento') == sequence and p.findtext(NS + 'nProt')]
            model = key[20:22] if key and re.fullmatch(r'\d{44}', key) else None
            result.update(kind='event', key=key, model=model, environment=environment, event_id=event_id, event_type=event_type, sequence=sequence, signature_present=signature, protocol_present=bool(matching), protocol=matching[0].findtext(NS + 'nProt') if matching else None)
            if not re.fullmatch(r'ID\d{52}', event_id) or model not in ('55', '65'):
                plan.issue(file_id, 'EVENT_ID_OR_KEY_REQUIRES_REVIEW')
            if environment not in ('1', '2'):
                plan.issue(file_id, 'EVENT_ENVIRONMENT_REQUIRES_REVIEW')
            if not signature:
                plan.issue(file_id, 'EVENT_SIGNATURE_ELEMENT_ABSENT')
            if not matching:
                plan.issue(file_id, 'EVENT_RETURN_PROTOCOL_ABSENT')
            if event_id:
                canonical_xml[('event', environment, event_id)].append((file_id, result['sha256']))
        else:
            plan.issue(file_id, 'XML_STRUCTURE_REQUIRES_REVIEW')
        plan.add('xml', file_id, 0, result)

    def walk(raw, chain, depth, name):
        nonlocal expanded, entries
        lower = name.lower()
        kind = 'archive' if lower.endswith('.zip') else 'csv' if lower.endswith('.csv') else 'xml' if lower.endswith('.xml') else 'other'
        file_id = digest(canonical(chain))
        # Internal archives/CSVs are already preserved byte-for-byte by the
        # original ZIP. Store their indexed location/hash without uploading
        # redundant containers. XML gets a directly addressable hash object.
        obj = plan.blob(raw, kind) if kind == 'xml' or depth == 0 else original_object
        representation = 'object' if kind == 'xml' or depth == 0 else 'container_original'
        plan.add('file', file_id, 0, {'kind': kind, 'source_path': chain, 'sha256': digest(raw), 'size': len(raw), 'object_key': obj['key'], 'object_sha256': obj['sha256'], 'object_size': obj['size'], 'storage_representation': representation})
        if kind == 'archive':
            if depth > 3:
                fail('ARCHIVE_DEPTH_LIMIT')
            stream = io.BytesIO(raw)
            zip_preflight(stream, len(raw), Limits())
            with zipfile.ZipFile(stream) as archive:
                for index, info in enumerate(archive.infolist()):
                    entries += 1
                    if entries > MAX_ENTRIES:
                        fail('TOTAL_MEMBER_COUNT_LIMIT')
                    mode = info.external_attr >> 16
                    if not member_path_is_safe(info.orig_filename) or stat.S_ISLNK(mode) or info.flag_bits & 1:
                        fail('UNSAFE_ARCHIVE_MEMBER')
                    if info.is_dir():
                        continue
                    limit = MAX_XML if info.filename.lower().endswith('.xml') else MAX_NESTED_ARCHIVE if info.filename.lower().endswith('.zip') else MAX_MEMBER
                    if info.file_size > limit or info.file_size > max(1, info.compress_size) * 1000:
                        fail('ARCHIVE_MEMBER_SIZE_OR_RATIO_LIMIT')
                    expanded += info.file_size
                    if expanded > MAX_EXPANDED:
                        fail('ARCHIVE_TOTAL_EXPANSION_LIMIT')
                    value = archive.read(info)  # The ZipInfo index preserves duplicate paths.
                    if len(value) != info.file_size:
                        fail('ARCHIVE_MEMBER_SIZE_MISMATCH')
                    walk(value, chain + [{'index': index, 'name': info.orig_filename}], depth + 1, info.filename)
        elif kind == 'csv':
            stage_csv(raw, name, file_id)
        elif kind == 'xml':
            stage_xml(raw, file_id)
        else:
            plan.issue(file_id, 'UNCLASSIFIED_MEMBER_PRESERVED')

    walk(source_raw, [{'index': 0, 'name': 'original.zip'}], 0, 'original.zip')
    for entries_for_key in canonical_xml.values():
        if len({sha for _, sha in entries_for_key}) > 1:
            for file_id, _ in entries_for_key:
                plan.issue(file_id, 'CANONICAL_XML_KEY_HAS_DIFFERENT_BYTES')
    if digest(read_file(source, MAX_SOURCE)) != source_sha:
        fail('SOURCE_CHANGED_DURING_PREPARATION')
    for kind in KINDS:
        plan.flush(kind)
    summary = {
        'format_version': VERSION, 'source_sha256': source_sha, 'source_size': len(source_raw),
        'counts': {kind: plan.counts[kind] for kind in KINDS},
        'csv_rows_by_entity': dict(sorted(csv_counts.items())),
        'invoice_occurrences_by_model': dict(sorted(models.items())),
        'unique_invoice_keys_by_model': {key: len(value) for key, value in sorted(unique_keys.items())},
        'object_count': len(plan.objects), 'object_bytes': sum(obj['size'] for obj in plan.objects.values()),
        'validation': 'structural_only_no_xsd_or_signature_verification',
        'operational_effects': False,
    }
    manifest = {'summary': summary, 'bucket': BUCKET, 'objects': list(plan.objects.values()), 'chunks': sorted(plan.chunks, key=lambda c: (KINDS.index(c['kind']), c['local']))}
    write_private(plan.directory / 'manifest.json', canonical(manifest))
    write_private(plan.directory / 'summary.json', canonical(summary))
    return summary


def plan_path(directory, relative):
    if not isinstance(relative, str) or not re.fullmatch(r'(?:objects/[0-9a-f]{64}\.(?:zip|csv|xml|bin)|chunks/(?:file|csv|xml|issue)-\d{5}-[0-9a-f]{64}\.json)', relative):
        fail('INVALID_PLAN_PATH')
    base = Path(directory)
    if base.is_symlink() or (base / 'objects').is_symlink() or (base / 'chunks').is_symlink():
        fail('SYMLINK_PLAN_DIRECTORY')
    path = base / relative
    if path.resolve().parent not in [base.resolve() / 'objects', base.resolve() / 'chunks']:
        fail('INVALID_PLAN_PATH')
    return path


def validate_plan(directory):
    manifest = parse_json(read_file(Path(directory) / 'manifest.json', 16 * 1024 * 1024))
    if not isinstance(manifest, dict) or manifest.get('bucket') != BUCKET or manifest.get('summary', {}).get('format_version') != VERSION:
        fail('INVALID_PLAN_MANIFEST')
    summary = manifest['summary']
    if not re.fullmatch(r'[0-9a-f]{64}', summary.get('source_sha256', '')) or summary.get('operational_effects') is not False:
        fail('INVALID_PLAN_MANIFEST')
    objects = manifest.get('objects', [])
    chunks = manifest.get('chunks', [])
    if not isinstance(objects, list) or len(objects) > MAX_ENTRIES + 1 or not isinstance(chunks, list) or len(chunks) > 10000:
        fail('PLAN_SIZE_LIMIT')
    keys = set()
    for obj in objects:
        path = plan_path(directory, obj['local'])
        raw = read_file(path, MAX_SOURCE)
        if obj['key'] != obj['local'] or obj['key'] in keys or digest(raw) != obj['sha256'] or len(raw) != obj['size'] or obj['sha256'] not in path.name:
            fail('PLAN_OBJECT_INTEGRITY_FAILURE')
        if obj.get('content_type') not in ('application/zip', 'text/csv', 'application/xml', 'application/octet-stream'):
            fail('INVALID_PLAN_CONTENT_TYPE')
        keys.add(obj['key'])
    counts = collections.Counter()
    for chunk in chunks:
        path = plan_path(directory, chunk['local'])
        raw = read_file(path, MAX_CHUNK)
        if digest(raw) != chunk['sha256'] or chunk['id'] != chunk['sha256'] or len(raw) != chunk['size'] or chunk['kind'] not in KINDS:
            fail('PLAN_CHUNK_INTEGRITY_FAILURE')
        records = parse_json(raw)
        if not isinstance(records, list) or len(records) != chunk['records'] or len(records) > 250:
            fail('INVALID_PLAN_CHUNK')
        for record in records:
            if not isinstance(record, dict) or not re.fullmatch(r'[0-9a-f]{64}', record.get('file_id', '')) or type(record.get('record_no')) is not int or not isinstance(record.get('data'), dict):
                fail('INVALID_PLAN_RECORD')
            if chunk['kind'] == 'file' and record['data'].get('object_key') not in keys:
                fail('PLAN_OBJECT_REFERENCE_MISSING')
        counts[chunk['kind']] += len(records)
    if {kind: counts[kind] for kind in KINDS} != summary['counts'] or len(objects) != summary['object_count'] or sum(obj['size'] for obj in objects) != summary['object_bytes']:
        fail('PLAN_COUNT_MISMATCH')
    if not any(obj['sha256'] == summary['source_sha256'] and obj['size'] == summary['source_size'] and obj['content_type'] == 'application/zip' for obj in objects):
        fail('ORIGINAL_BACKUP_OBJECT_MISSING')
    return manifest


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fail('HTTP_REDIRECT_BLOCKED')


class Supabase:
    def __init__(self, project_ref, key, opener=None, sleep=time.sleep):
        if not re.fullmatch(r'[a-z0-9]{20}', project_ref or '') or not isinstance(key, str) or not key or len(key) > 8192 or re.search(r'\s', key):
            fail('INVALID_SERVER_CREDENTIAL_CONFIG')
        if not key.startswith('sb_secret_'):
            try:
                encoded = key.split('.')[1]
                claims = parse_json(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            except Exception:
                fail('SERVER_CREDENTIAL_REQUIRED')
            # Claim check prevents accidental use of a public key. The server
            # still performs actual signature/credential validation.
            if not isinstance(claims, dict) or claims.get('role') != 'service_role':
                fail('SERVER_CREDENTIAL_REQUIRED')
        self.origin = f'https://{project_ref}.supabase.co'
        self.headers = {'apikey': key, 'Authorization': f'Bearer {key}'}
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.sleep = sleep

    def request(self, method, path, body=None, content_type='application/json', expected_size=None):
        allowed = re.fullmatch(r'/rest/v1/rpc/origin_backup_(?:begin|apply_chunk|finish)', path) or re.fullmatch(r'/storage/v1/object/(?:authenticated/)?origin-backups/objects/[0-9a-f]{64}\.(?:zip|csv|xml|bin)', path)
        if not allowed or method not in ('GET', 'POST'):
            fail('HTTP_ROUTE_NOT_ALLOWED')
        headers = {**self.headers, 'Content-Type': content_type, 'x-upsert': 'false'}
        for attempt in range(3):
            request = urllib.request.Request(self.origin + path, data=body, headers=headers, method=method)
            try:
                with self.opener.open(request, timeout=30) as response:
                    if response.geturl() != self.origin + path:
                        fail('HTTP_REDIRECT_BLOCKED')
                    if expected_size is not None:
                        hashed, size = hashlib.sha256(), 0
                        while chunk := response.read(1024 * 1024):
                            size += len(chunk)
                            if size > expected_size:
                                fail('REMOTE_OBJECT_SIZE_MISMATCH')
                            hashed.update(chunk)
                        if size != expected_size:
                            fail('REMOTE_OBJECT_SIZE_MISMATCH')
                        return response.status, hashed.hexdigest()
                    raw = response.read(1024 * 1024 + 1)
                    if len(raw) > 1024 * 1024:
                        fail('HTTP_RESPONSE_SIZE_LIMIT')
                    return response.status, raw
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()  # Never read or print server error bodies.
                if status in (429, 500, 502, 503, 504) and attempt < 2:
                    self.sleep(2 ** attempt)
                    continue
                return status, b''
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == 2:
                    fail('HTTP_NETWORK_FAILED')
                self.sleep(2 ** attempt)
        fail('HTTP_RETRY_LIMIT')

    def rpc(self, name, args):
        status, raw = self.request('POST', f'/rest/v1/rpc/origin_backup_{name}', canonical(args))
        if status != 200:
            fail(f'RPC_{name.upper()}_HTTP_{status}')
        result = parse_json(raw)
        if not isinstance(result, dict):
            fail('RPC_RESPONSE_INVALID')
        return result

    def upload(self, directory, obj):
        raw = read_file(plan_path(directory, obj['local']), MAX_SOURCE)
        if digest(raw) != obj['sha256']:
            fail('PLAN_OBJECT_CHANGED')
        path = f'/storage/v1/object/{BUCKET}/{obj["key"]}'
        status, _ = self.request('POST', path, raw, obj['content_type'])
        if status not in (200, 201, 400, 409):
            fail(f'STORAGE_UPLOAD_HTTP_{status}')
        # A conflict is accepted only after authenticated read/hash comparison.
        status, remote_hash = self.request('GET', f'/storage/v1/object/authenticated/{BUCKET}/{obj["key"]}', expected_size=obj['size'])
        if status != 200 or remote_hash != obj['sha256']:
            fail('REMOTE_OBJECT_INTEGRITY_FAILURE')


def apply(directory, project_ref, key, workers=4, client=None, progress=None):
    if not isinstance(workers, int) or not 1 <= workers <= 4:
        fail('INVALID_WORKER_LIMIT')
    manifest = validate_plan(directory)  # Fully verify before any network mutation.
    client = client or Supabase(project_ref, key)
    source_sha = manifest['summary']['source_sha256']
    client.rpc('begin', {'p_backup_sha': source_sha, 'p_manifest': manifest['summary']})
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(client.upload, directory, obj) for obj in manifest['objects']]
        for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
            future.result()
            if progress and (completed % 250 == 0 or completed == len(futures)):
                progress({'phase': 'verified_uploads', 'completed': completed, 'total': len(futures)})
    for completed, chunk in enumerate(sorted(manifest['chunks'], key=lambda c: (KINDS.index(c['kind']), c['local'])), 1):
        raw = read_file(plan_path(directory, chunk['local']), MAX_CHUNK)
        if digest(raw) != chunk['sha256']:
            fail('PLAN_CHUNK_CHANGED')
        client.rpc('apply_chunk', {'p_backup_sha': source_sha, 'p_kind': chunk['kind'], 'p_chunk_id': chunk['id'], 'p_records': parse_json(raw)})
        if progress and (completed % 25 == 0 or completed == len(manifest['chunks'])):
            progress({'phase': 'staging_chunks', 'completed': completed, 'total': len(manifest['chunks'])})
    result = client.rpc('finish', {'p_backup_sha': source_sha})
    # Return only bounded aggregate fields, never arbitrary server content.
    return {'status': result.get('status') if result.get('status') in ('stored', 'stored_with_issues') else 'UNEXPECTED_REMOTE_STATUS', 'counts': manifest['summary']['counts'], 'operational_effects': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Local dry-run only; writes a private immutable plan.')
    prep.add_argument('--source', required=True, type=Path)
    prep.add_argument('--output-dir', required=True, type=Path)
    validate = commands.add_parser('validate', help='Verify hashes/counts locally; no network.')
    validate.add_argument('--plan-dir', required=True, type=Path)
    remote = commands.add_parser('apply', help='Upload originals and write private staging; no operational ERP effects.')
    remote.add_argument('--plan-dir', required=True, type=Path)
    remote.add_argument('--project-ref', required=True)
    remote.add_argument('--key-file', required=True, type=Path, help='Private file containing only the server key; never pass the key on the command line.')
    remote.add_argument('--workers', type=int, default=4)
    remote.add_argument('--confirm-private-staging', action='store_true', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            result = prepare(args.source, args.output_dir)
        elif args.command == 'validate':
            result = validate_plan(args.plan_dir)['summary']
        else:
            if args.key_file.stat().st_mode & 0o077:
                fail('KEY_FILE_PERMISSIONS_TOO_OPEN')
            key = read_file(args.key_file, 8192).decode('utf-8').strip()
            result = apply(args.plan_dir, args.project_ref, key, args.workers, progress=lambda value: print(json.dumps(value), flush=True))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    except (StageError, InventoryError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({'error': 'STAGING_FAILED_PRIVATE_DETAILS_SUPPRESSED'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
