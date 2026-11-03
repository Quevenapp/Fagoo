#!/usr/bin/env python3
"""Read-only aggregate tax-pattern inventory of the original nested Origin ZIP.

No customer data, item descriptions, keys, document numbers or monetary totals
are retained. Issuer CNPJ is retained only in the private report. Counts describe
historical XML content; they do not validate tax treatment or authorization.
"""
import argparse
from collections import Counter, defaultdict
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile

from inspect_origin_xml import bounded_read, safe_xml, NS, DS, MAX_XML, MAX_TOTAL
from inspect_origin_backup import InventoryError, Limits, open_regular_file, zip_preflight


def name(node):
    return node.tag.rsplit('}', 1)[-1]


def value(node, path, missing='absent'):
    if node is None:
        return missing
    return (node.findtext('/'.join(NS + p for p in path.split('/'))) or '').strip() or missing


def counter_json(counter):
    return dict(sorted(counter.items(), key=lambda item: (-item[1], item[0])))


def new_stats():
    return {'documents': 0, 'items': 0, 'dates': [], 'dimensions': defaultdict(Counter),
            'cfop_items': Counter(), 'cfop_documents': Counter(), 'ncm_items': Counter(),
            'origin_items': Counter(), 'tax_groups': defaultdict(Counter),
            'tax_codes': defaultdict(Counter), 'field_presence_items': Counter(),
            'nonzero_numeric_fields_items': Counter(), 'rate_histograms': defaultdict(Counter),
            'combinations_items': Counter(), 'combinations_documents': Counter(),
            'features_documents': Counter(), 'anp_code_items': Counter(),
            'common_domestic_sales_only_documents': 0, 'cancel_event_documents': 0}


def add_invoice(stats, root, invoice, key, cancel_keys):
    inf = invoice.find(NS + 'infNFe')
    stats['documents'] += 1
    stats['cancel_event_documents'] += key in cancel_keys
    stats['dates'].append(value(inf, 'ide/dhEmi', '')[:10] or value(inf, 'ide/dEmi', '')[:10])
    for label, path in {'model':'ide/mod', 'environment':'ide/tpAmb', 'direction':'ide/tpNF',
        'purpose':'ide/finNFe', 'destination':'ide/idDest', 'emission_type':'ide/tpEmis',
        'final_consumer':'ide/indFinal', 'presence':'ide/indPres', 'CRT':'emit/CRT',
        'issuer_state':'emit/enderEmit/UF', 'recipient_state':'dest/enderDest/UF',
        'recipient_ie_indicator':'dest/indIEDest'}.items():
        stats['dimensions'][label][value(inf, path)] += 1
    protocols = root.findall('.//' + NS + 'infProt')
    statuses = {value(p, 'cStat') for p in protocols if value(p, 'chNFe') == key}
    for status in statuses or {'absent_matching_protocol'}:
        stats['dimensions']['protocol_status'][status] += 1
    stats['dimensions']['signature_element']['present' if invoice.find(DS + 'Signature') is not None else 'absent'] += 1
    stats['dimensions']['operation_nature'][value(inf, 'ide/natOp')] += 1
    for feature, path in {'referenced_document':'ide/NFref', 'billing':'cobr', 'payment':'pag',
        'transport':'transp', 'authorized_access':'autXML', 'additional_info':'infAdic',
        'IBSCBS_total':'total/IBSCBSTot', 'IS_total':'total/ISTot'}.items():
        if inf.find('/'.join(NS + p for p in path.split('/'))) is not None:
            stats['features_documents'][feature] += 1
    cfops = set()
    patterns = set()
    features = set()
    common_domestic = value(inf, 'ide/tpNF') == '1' and value(inf, 'ide/finNFe') == '1' and value(inf, 'ide/idDest') == '1'
    for detail in inf.findall(NS + 'det'):
        stats['items'] += 1
        cfop = value(detail, 'prod/CFOP')
        cfops.add(cfop)
        stats['cfop_items'][cfop] += 1
        stats['ncm_items'][value(detail, 'prod/NCM')] += 1
        tax = detail.find(NS + 'imposto')
        tax_pattern = []
        for group_name in ('ICMS', 'PIS', 'COFINS', 'IPI', 'II', 'ISSQN', 'ICMSUFDest', 'IBSCBS', 'IS'):
            group = None if tax is None else tax.find(NS + group_name)
            if group is None:
                stats['tax_groups'][group_name]['absent'] += 1
                tax_pattern.append(group_name + '=absent')
                continue
            features.add(group_name)
            leaves = [c for c in group if name(c) not in ('cEnq', 'CNPJProd', 'cSelo', 'qSelo')]
            subgroups = [name(c) for c in leaves if len(c)] or [group_name]
            for subgroup in subgroups:
                stats['tax_groups'][group_name][subgroup] += 1
            codes = []
            def walk(node, path):
                local = name(node)
                path = path + '/' + local if path else local
                if not len(node):
                    val = (node.text or '').strip()
                    stats['field_presence_items'][path] += 1
                    if local in ('CST', 'CSOSN', 'cClassTrib'):
                        stats['tax_codes'][group_name + '/' + local][val or 'empty'] += 1
                        codes.append(local + ':' + (val or 'empty'))
                    if local == 'orig' and group_name == 'ICMS':
                        stats['origin_items'][val or 'empty'] += 1
                    if local.startswith('p'):
                        stats['rate_histograms'][path][val or 'empty'] += 1
                    if local.startswith(('p', 'v', 'q')):
                        try:
                            if Decimal(val) != 0:
                                stats['nonzero_numeric_fields_items'][path] += 1
                        except InvalidOperation:
                            pass
                else:
                    for child in node:
                        walk(child, path)
            walk(group, '')
            tax_pattern.append(group_name + '=' + '+'.join(subgroups) + '[' + ','.join(sorted(codes)) + ']')
        pattern = 'CFOP=' + cfop + ';' + ';'.join(tax_pattern)
        common_domestic = common_domestic and cfop in ('5102', '5405') and value(detail, 'imposto/ICMS/ICMSSN101/CSOSN', '') + value(detail, 'imposto/ICMS/ICMSSN102/CSOSN', '') + value(detail, 'imposto/ICMS/ICMSSN500/CSOSN', '') in ('101','102','500') and value(detail, 'imposto/PIS/PISOutr/CST') == '49' and value(detail, 'imposto/COFINS/COFINSOutr/CST') == '49' and (tax is None or all(tax.find(NS + g) is None for g in ('IPI','IBSCBS','IS','II','ISSQN','ICMSUFDest')))
        patterns.add(pattern)
        stats['combinations_items'][pattern] += 1
        if detail.find(NS + 'impostoDevol') is not None:
            features.add('impostoDevol')
        prod = detail.find(NS + 'prod')
        if prod is not None and prod.find(NS + 'comb') is not None:
            stats['anp_code_items'][value(prod, 'comb/cProdANP')] += 1
        for tag in ('CEST', 'cBenef', 'DI', 'detExport', 'rastro', 'med', 'comb', 'veicProd', 'arma'):
            if prod is not None and prod.find(NS + tag) is not None:
                features.add('prod/' + tag)
    stats['cfop_documents'].update(cfops)
    stats['combinations_documents'].update(patterns)
    stats['features_documents'].update(features)
    stats['common_domestic_sales_only_documents'] += common_domestic


def freeze(stats):
    result = {}
    for key, val in stats.items():
        if key == 'dates':
            dates = sorted(d for d in val if d)
            result['dates'] = {'first': dates[0] if dates else None, 'last': dates[-1] if dates else None}
        elif isinstance(val, Counter):
            result[key] = counter_json(val)
        elif isinstance(val, defaultdict):
            result[key] = {k: counter_json(v) for k, v in sorted(val.items())}
        else:
            result[key] = val
    return result


def inspect(source, own_hash):
    documents, seen, invoice_hashes, event_stats, cancel_keys = [], set(), {}, Counter(), set()
    total_bytes, occurrences, duplicates = 0, 0, 0
    with open_regular_file(source) as stream:
        before = hashlib.file_digest(stream, 'sha256').hexdigest()
        zip_preflight(stream, os.fstat(stream.fileno()).st_size, Limits())
        with zipfile.ZipFile(stream) as outer:
            matches = [i for i in outer.infolist() if i.filename == 'nfe.zip']
            if len(matches) != 1:
                raise InventoryError('NFE_ARCHIVE_NOT_UNIQUE')
            packed = bounded_read(outer, matches[0], 128 * 1024 * 1024)
        nested_stream = io.BytesIO(packed)
        zip_preflight(nested_stream, len(packed), Limits())
        with zipfile.ZipFile(nested_stream) as nested:
            for entry in nested.infolist():
                packed = bounded_read(nested, entry, 128 * 1024 * 1024)
                child_stream = io.BytesIO(packed)
                zip_preflight(child_stream, len(packed), Limits())
                with zipfile.ZipFile(child_stream) as archive:
                    for member in archive.infolist():
                        if member.is_dir() or not member.filename.lower().endswith('.xml'):
                            continue
                        occurrences += 1
                        total_bytes += member.file_size
                        if total_bytes > MAX_TOTAL:
                            raise InventoryError('TOTAL_XML_LIMIT')
                        raw = bounded_read(archive, member, MAX_XML)
                        digest = hashlib.sha256(raw).hexdigest()
                        if digest in seen:
                            duplicates += 1
                            continue
                        seen.add(digest)
                        root = safe_xml(raw)
                        invoices = [root] if root.tag == NS + 'NFe' else root.findall('.//' + NS + 'NFe')
                        for invoice in invoices:
                            inf = invoice.find(NS + 'infNFe')
                            key = inf.get('Id', '').removeprefix('NFe') if inf is not None else ''
                            if not re.fullmatch(r'\d{44}', key):
                                raise InventoryError('INVOICE_KEY_INVALID')
                            if key in invoice_hashes:
                                raise InventoryError('DIFFERENT_BYTES_SAME_KEY_REQUIRES_REVIEW')
                            invoice_hashes[key] = digest
                            documents.append((root, invoice, key))
                        events = [root] if root.tag == NS + 'evento' else root.findall('.//' + NS + 'evento')
                        for event in events:
                            inf = event.find(NS + 'infEvento')
                            event_stats[value(inf, 'tpEvento')] += 1
                            if value(inf, 'tpEvento') == '110111':
                                cancel_keys.add(value(inf, 'chNFe'))
        stream.seek(0)
        if hashlib.file_digest(stream, 'sha256').hexdigest() != before:
            raise InventoryError('SOURCE_CHANGED')
    issuers = {}
    all_stats, own_stats, others = new_stats(), new_stats(), new_stats()
    own_segments = defaultdict(new_stats)
    own_cnpjs = {value(invoice.find(NS + 'infNFe'), 'emit/CNPJ') for _,invoice,_ in documents if hashlib.sha256(value(invoice.find(NS + 'infNFe'), 'emit/CNPJ').encode()).hexdigest() == own_hash}
    relations = Counter()
    for root, invoice, key in documents:
        inf = invoice.find(NS + 'infNFe')
        cnpj = value(inf, 'emit/CNPJ')
        recipient = value(inf, 'dest/CNPJ', '')
        issuer_hash = hashlib.sha256(cnpj.encode()).hexdigest()
        if issuer_hash not in issuers:
            issuers[issuer_hash] = {'issuer_cnpj_private': cnpj, 'issuer_sha256': issuer_hash,
                                    'same_company': issuer_hash == own_hash, 'stats': new_stats()}
        add_invoice(issuers[issuer_hash]['stats'], root, invoice, key, cancel_keys)
        add_invoice(all_stats, root, invoice, key, cancel_keys)
        add_invoice(own_stats if issuer_hash == own_hash else others, root, invoice, key, cancel_keys)
        relation = 'own_issuer' if issuer_hash == own_hash else ('other_issuer_company_recipient' if recipient in own_cnpjs else 'other_issuer_other_or_missing_recipient')
        relations[relation] += 1
        issuers[issuer_hash]['stats']['dimensions']['company_relation'][relation] += 1
        if issuer_hash == own_hash:
            segment = '|'.join(value(inf, p) for p in ('ide/mod', 'ide/tpAmb', 'ide/tpNF', 'ide/finNFe'))
            add_invoice(own_segments[segment], root, invoice, key, cancel_keys)
    if own_hash and not own_stats['documents']:
        raise InventoryError('CONFIRMED_ISSUER_NOT_FOUND')
    return {'private_report': True, 'purpose': 'historical_tax_pattern_inventory_only',
        'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'source_sha256': before,
        'source_unchanged': True, 'deduplication': 'full XML SHA256; unique invoice key must have one payload',
        'scope': {'xml_occurrences': occurrences, 'duplicate_xml_extra_occurrences': duplicates,
                  'unique_xml_hashes': len(seen), 'unique_invoices': len(documents),
                  'issuer_count': len(issuers), 'event_types': counter_json(event_stats)},
        'company_issuer_sha256': own_hash or None,
        'issuer_identity_basis': 'candidate dominant issuer, unique issuer of model65; not human identity confirmation by this tool',
        'company_relations': counter_json(relations),
        'limitations': ['Historical content, not current rule or correctness', 'No customer identifiers retained',
            'No XSD/signature/current SEFAZ authorization validation', 'No monetary totals/balances calculated',
            'Cancellation events counted by presence, not adjudicated as effective',
            'Counts by tax code/CFOP are item counts; document frequency may overlap',
            'Supplier-issued documents are not company-issued operations',
            'No backup completeness claim; no operational data mutation'],
        'all_issuers': freeze(all_stats), 'company': freeze(own_stats), 'other_issuers': freeze(others),
        'company_segments_model_environment_direction_purpose': {k: freeze(v) for k,v in sorted(own_segments.items())},
        'issuers': [{**i, 'stats': freeze(i['stats'])} for i in sorted(issuers.values(), key=lambda i: -i['stats']['documents'])]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--issuer-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{64}', args.issuer_sha256):
        raise InventoryError('ISSUER_HASH_INVALID')
    report = inspect(args.source, args.issuer_sha256)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    print(json.dumps({'scope': report['scope'], 'company_documents': report['company']['documents'],
                      'company_items': report['company']['items'], 'source_unchanged': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
