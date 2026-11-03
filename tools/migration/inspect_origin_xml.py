#!/usr/bin/env python3
"""Read-only aggregate inspection of the supplied Origin nested NF-e archive.

This is structural inspection, not XSD/signature/fiscal validation or import.
Private issue locators may include fiscal keys. Never print that report in full.
"""

import argparse
import collections
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from xml.parsers import expat
import zipfile

from inspect_origin_backup import InventoryError, Limits, member_path_is_safe, open_regular_file, zip_preflight

NS = '{http://www.portalfiscal.inf.br/nfe}'
DS = '{http://www.w3.org/2000/09/xmldsig#}'
MAX_XML = 8 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024


def safe_xml(raw):
    # Expat recognizes declarations irrespective of XML encoding. Reject DTDs
    # and entities before constructing an ElementTree (no XXE/entity expansion).
    def reject(*_):
        raise InventoryError('XML_DECLARATIONS_NOT_ALLOWED')
    parser = expat.ParserCreate()
    parser.StartDoctypeDeclHandler = reject
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    parser.Parse(raw, True)
    return ET.fromstring(raw)


def bounded_read(archive, info, limit):
    if not member_path_is_safe(info.orig_filename) or info.flag_bits & 1:
        raise InventoryError('UNSAFE_OR_ENCRYPTED_MEMBER')
    if info.file_size > limit or info.file_size > max(1, info.compress_size) * 1000:
        raise InventoryError('MEMBER_SIZE_LIMIT')
    return archive.read(info)  # ZipInfo is essential: duplicated names stay distinct.


def text(node, path):
    return (node.findtext(path) or '').strip()


def inspect(source):
    report = {
        'purpose': 'read_only_xml_structure_and_deduplication_no_import',
        'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'private_report': True,
        'limitations': ['XSD not validated', 'Cryptographic signatures not validated', 'Fiscal authorization not checked with SEFAZ', 'Current tax regime not inferred', 'No monetary balances recomputed'],
        'archives': [], 'duplicate_path_groups': [], 'issues': [],
    }
    hashes = collections.defaultdict(list)
    invoice_keys = collections.defaultdict(list)
    event_ids = collections.defaultdict(list)
    invoice_presence = collections.defaultdict(lambda: {'protocol': False, 'signature': False})
    event_invoice_references = set()
    global_stats = collections.Counter()
    total = 0
    with open_regular_file(source) as outer_stream:
        before = hashlib.file_digest(outer_stream, 'sha256').hexdigest()
        zip_preflight(outer_stream, os.fstat(outer_stream.fileno()).st_size, Limits())
        with zipfile.ZipFile(outer_stream) as outer:
            matches = [entry for entry in outer.infolist() if entry.filename == 'nfe.zip']
            if len(matches) != 1:
                raise InventoryError('EXPECTED_NFE_ARCHIVE_NOT_UNIQUE')
            nfe_bytes = bounded_read(outer, matches[0], 128 * 1024 * 1024)
        nfe_stream = io.BytesIO(nfe_bytes)
        zip_preflight(nfe_stream, len(nfe_bytes), Limits())
        with zipfile.ZipFile(nfe_stream) as nested:
            for nested_info in nested.infolist():
                if not nested_info.filename.lower().endswith('.zip'):
                    raise InventoryError('UNEXPECTED_NFE_ARCHIVE_MEMBER')
                archive_bytes = bounded_read(nested, nested_info, 128 * 1024 * 1024)
                archive_stream = io.BytesIO(archive_bytes)
                zip_preflight(archive_stream, len(archive_bytes), Limits())
                archive_stats = collections.Counter()
                paths = collections.defaultdict(list)
                dates = []
                roots = collections.Counter()
                event_types = collections.Counter()
                with zipfile.ZipFile(archive_stream) as archive:
                    for index, info in enumerate(archive.infolist()):
                        if info.is_dir():
                            continue
                        if not info.filename.lower().endswith('.xml'):
                            archive_stats['non_xml_members'] += 1
                            continue
                        total += info.file_size
                        if total > MAX_TOTAL:
                            raise InventoryError('TOTAL_XML_SIZE_LIMIT')
                        raw = bounded_read(archive, info, MAX_XML)
                        digest = hashlib.sha256(raw).hexdigest()
                        locator = {'archive': nested_info.filename, 'index': index, 'member': info.filename, 'sha256': digest}
                        paths[info.filename].append(locator)
                        hashes[digest].append(locator)
                        archive_stats['xml_members'] += 1
                        try:
                            root = safe_xml(raw)
                        except (InventoryError, expat.ExpatError, ET.ParseError):
                            archive_stats['xml_parse_or_declaration_errors'] += 1
                            report['issues'].append({**locator, 'issue': 'XML_PARSE_OR_DECLARATION_ERROR'})
                            continue
                        roots[root.tag.split('}')[-1]] += 1
                        invoice_nodes = [root] if root.tag == NS + 'NFe' else root.findall('.//' + NS + 'NFe')
                        for invoice in invoice_nodes:
                            archive_stats['invoice_documents'] += 1
                            info_node = invoice.find(NS + 'infNFe')
                            key = info_node.attrib.get('Id', '') if info_node is not None else ''
                            if re.fullmatch(r'NFe\d{44}', key):
                                invoice_keys[key].append(locator)
                            else:
                                archive_stats['invalid_or_missing_invoice_key'] += 1
                                report['issues'].append({**locator, 'issue': 'INVALID_OR_MISSING_INVOICE_KEY'})
                            signature_present = invoice.find(DS + 'Signature') is not None
                            archive_stats['invoice_signature_present'] += signature_present
                            if not signature_present:
                                report['issues'].append({**locator, 'canonical_key': key, 'issue': 'INVOICE_SIGNATURE_ELEMENT_ABSENT'})
                            protocols = root.findall('.//' + NS + 'protNFe/' + NS + 'infProt')
                            matching = [p for p in protocols if text(p, NS + 'chNFe') == key.removeprefix('NFe')]
                            protocol_present = bool(protocols)
                            number_present = any(text(p, NS + 'nProt') for p in matching)
                            archive_stats['invoice_protocol_element_present'] += protocol_present
                            archive_stats['invoice_matching_protocol_number_present'] += number_present
                            if re.fullmatch(r'NFe\d{44}', key):
                                invoice_presence[key]['protocol'] |= number_present
                                invoice_presence[key]['signature'] |= signature_present
                            if not number_present:
                                report['issues'].append({**locator, 'canonical_key': key, 'issue': 'MATCHING_AUTHORIZATION_PROTOCOL_NUMBER_ABSENT'})
                            if protocols and not matching:
                                archive_stats['invoice_protocol_key_mismatch'] += 1
                            if info_node is not None:
                                date = text(info_node, NS + 'ide/' + NS + 'dhEmi') or text(info_node, NS + 'ide/' + NS + 'dEmi')
                                if re.match(r'^\d{4}-\d{2}-\d{2}', date):
                                    dates.append(date[:10])
                        # Count the submitted event once, not again via retEvento.
                        events = [root] if root.tag == NS + 'evento' else root.findall('.//' + NS + 'evento')
                        for event in events:
                            archive_stats['event_documents'] += 1
                            event_info = event.find(NS + 'infEvento')
                            event_id = event_info.attrib.get('Id', '') if event_info is not None else ''
                            if re.fullmatch(r'ID\d{52}', event_id):
                                event_ids[event_id].append(locator)
                            else:
                                archive_stats['invalid_or_missing_event_id'] += 1
                                report['issues'].append({**locator, 'issue': 'INVALID_OR_MISSING_EVENT_ID'})
                            if event_info is not None:
                                event_types[text(event_info, NS + 'tpEvento')] += 1
                                event_invoice_references.add('NFe' + text(event_info, NS + 'chNFe'))
                            archive_stats['event_signature_present'] += event.find(DS + 'Signature') is not None
                for path, locators in paths.items():
                    if len(locators) > 1:
                        report['duplicate_path_groups'].append({
                            'archive': nested_info.filename, 'member': path, 'occurrences': len(locators),
                            'unique_hashes': len({item['sha256'] for item in locators}), 'locators': locators,
                        })
                        archive_stats['duplicate_path_extra_members'] += len(locators) - 1
                global_stats.update(archive_stats)
                report['archives'].append({'archive': nested_info.filename, 'counts': dict(archive_stats), 'roots': dict(roots), 'event_types_once_per_request': dict(event_types), 'dates': {'min': min(dates) if dates else None, 'max': max(dates) if dates else None}})
        outer_stream.seek(0)
        after = hashlib.file_digest(outer_stream, 'sha256').hexdigest()
        if before != after:
            raise InventoryError('SOURCE_CHANGED_DURING_INSPECTION')
        report['source_sha256'] = before
    report['summary'] = {
        **dict(global_stats),
        'unique_xml_hashes': len(hashes),
        'duplicate_xml_content_extra_members': sum(len(items) - 1 for items in hashes.values()),
        'hashes_present_in_both_archives': sum(len({item['archive'] for item in items}) > 1 for items in hashes.values()),
        'unique_invoice_keys': len(invoice_keys),
        'unique_invoice_keys_with_protocol': sum(item['protocol'] for item in invoice_presence.values()),
        'unique_invoice_keys_without_protocol': sum(not item['protocol'] for item in invoice_presence.values()),
        'unique_invoice_keys_with_signature_element': sum(item['signature'] for item in invoice_presence.values()),
        'unique_invoice_keys_without_signature_element': sum(not item['signature'] for item in invoice_presence.values()),
        'invoice_key_groups_with_multiple_payload_hashes': sum(len({item['sha256'] for item in items}) > 1 for items in invoice_keys.values()),
        'unique_event_ids': len(event_ids),
        'unique_event_invoice_references': len(event_invoice_references),
        'event_invoice_references_absent_from_invoice_archive': len(event_invoice_references - set(invoice_keys)),
        'event_id_groups_with_multiple_payload_hashes': sum(len({item['sha256'] for item in items}) > 1 for items in event_ids.values()),
        'duplicate_path_groups': len(report['duplicate_path_groups']),
        'duplicate_paths_with_different_bytes': sum(group['unique_hashes'] > 1 for group in report['duplicate_path_groups']),
        'source_unchanged': True,
        'xml_parse_or_declaration_errors': global_stats['xml_parse_or_declaration_errors'],
    }
    report['same_invoice_key_multiple_payloads'] = [{'key': key, 'locators': items} for key, items in invoice_keys.items() if len({item['sha256'] for item in items}) > 1]
    report['same_event_id_multiple_payloads'] = [{'id': key, 'locators': items} for key, items in event_ids.items() if len({item['sha256'] for item in items}) > 1]
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.resolve() == args.source.resolve():
        raise InventoryError('OUTPUT_MUST_BE_NEW')
    report = inspect(args.source)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        json.dump(report, target, ensure_ascii=False, indent=2)
        target.write('\n')
    print('Inspeção XML gravada; somente agregados abaixo:')
    print(json.dumps(report['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (InventoryError, OSError, zipfile.BadZipFile) as exc:
        print(f'Inspeção não concluída ({type(exc).__name__}).')
        raise SystemExit(1)
