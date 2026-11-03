import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

import stage_origin_backup as stage


def archive(entries):
    stream = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as result:
            for name, raw in entries:
                result.writestr(name, raw)
    return stream.getvalue()


def invoice_key(model='65'):
    return '35' + '2610' + '0' * 14 + model + '001' + '000000001' + '1' + '00000001' + '0'


def invoice(model='65', protocol=True, signature=True):
    key = invoice_key(model)
    signed = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>' if signature else ''
    receipt = f'<protNFe><infProt><chNFe>{key}</chNFe><nProt>123</nProt></infProt></protNFe>' if protocol else ''
    return f'<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe{key}"><ide><mod>{model}</mod><tpAmb>2</tpAmb></ide></infNFe>{signed}</NFe>{receipt}</nfeProc>'.encode()


def event(protocol=True):
    key = invoice_key()
    info = f'<chNFe>{key}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento>'
    receipt = f'<retEvento><infEvento>{info}<nProt>456</nProt></infEvento></retEvento>' if protocol else ''
    return f'<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe"><evento><infEvento Id="ID110111{key}01"><tpAmb>2</tpAmb>{info}</infEvento><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/></evento>{receipt}</procEventoNFe>'.encode()


class FakeRemote:
    def __init__(self):
        self.calls = []
        self.uploaded = set()
        self.chunks = {}

    def upload(self, directory, obj):
        self.uploaded.add(obj['key'])

    def rpc(self, method, args):
        self.calls.append(method)
        if method == 'apply_chunk':
            old = self.chunks.get(args['p_chunk_id'])
            if old is not None:
                assert old == args['p_records']
            self.chunks[args['p_chunk_id']] = args['p_records']
        return {'status': 'stored'}


class PreparedBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, entries):
        source = self.root / 'source.zip'
        source.write_bytes(archive(entries))
        output = self.root / 'plan'
        summary = stage.prepare(source, output)
        return source, output, summary

    def records(self, directory, kind):
        manifest = stage.validate_plan(directory)
        return [r for chunk in manifest['chunks'] if chunk['kind'] == kind for r in json.loads((directory / chunk['local']).read_text())]

    def test_originals_hashes_private_permissions_and_csv_values_are_preserved(self):
        raw = b'\xef\xbb\xbfID;Nome;Codigo\n00123;PRIVATE_CUSTOMER;0007\n00123;PRIVATE_CUSTOMER;0007\n'
        source, output, summary = self.prepare([('contatos.csv', raw)])
        self.assertEqual(summary['source_sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(summary['counts']['csv'], 2)
        records = self.records(output, 'csv')
        self.assertEqual([r['record_no'] for r in records], [1, 2])
        self.assertEqual(records[0]['data']['source_id'], '00123')
        self.assertEqual(records[0]['data']['payload']['Codigo'], '0007')
        self.assertEqual(records[0]['data']['payload'], records[1]['data']['payload'])
        self.assertNotIn('PRIVATE_CUSTOMER', json.dumps(summary))
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in output.rglob('*') if p.is_file()))
        self.assertEqual(stage.digest(source.read_bytes()), summary['source_sha256'])

    def test_nested_xml_duplicates_preserve_occurrences_and_deduplicate_objects(self):
        same = invoice()
        nested = archive([('same.xml', same), ('same.xml', same), ('event.xml', event())])
        _, output, summary = self.prepare([('nfe.zip', archive([('backup-1.zip', nested)]))])
        self.assertEqual(summary['counts']['xml'], 3)
        self.assertEqual(summary['unique_invoice_keys_by_model'], {'65': 1})
        self.assertEqual(summary['counts']['issue'], 0)
        xml = self.records(output, 'xml')
        self.assertEqual(len({row['file_id'] for row in xml}), 3)
        self.assertEqual(len({row['data']['sha256'] for row in xml}), 2)
        self.assertTrue(all(row['data']['signature_verified'] is False for row in xml))
        files = self.records(output, 'file')
        self.assertTrue(all(row['data']['storage_representation'] == 'container_original' for row in files if row['data']['kind'] == 'archive' and len(row['data']['source_path']) > 1))

    def test_events_use_their_own_protocol_and_do_not_require_invoice_authorization(self):
        _, output, summary = self.prepare([('cancel.xml', event()), ('pending.xml', event(False))])
        codes = [r['data']['code'] for r in self.records(output, 'issue')]
        self.assertIn('EVENT_RETURN_PROTOCOL_ABSENT', codes)
        self.assertNotIn('INVOICE_PROTOCOL_ABSENT', codes)
        self.assertEqual(summary['counts']['xml'], 2)

    def test_missing_signature_protocol_and_changed_canonical_bytes_are_quarantined(self):
        _, output, _ = self.prepare([('complete.xml', invoice()), ('incomplete.xml', invoice(protocol=False, signature=False))])
        codes = [r['data']['code'] for r in self.records(output, 'issue')]
        self.assertIn('INVOICE_SIGNATURE_ELEMENT_ABSENT', codes)
        self.assertIn('INVOICE_PROTOCOL_ABSENT', codes)
        self.assertEqual(codes.count('CANONICAL_XML_KEY_HAS_DIFFERENT_BYTES'), 2)

    def test_dtd_entity_payload_is_preserved_but_never_expanded(self):
        xml = b'<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>'
        _, output, summary = self.prepare([('bad.xml', xml)])
        self.assertEqual(summary['counts']['xml'], 1)
        self.assertEqual(self.records(output, 'issue')[0]['data']['code'], 'XML_PARSE_OR_DECLARATION_REJECTED')

    def test_bad_csv_schema_encoding_and_width_do_not_create_inferred_records(self):
        _, output, summary = self.prepare([('contatos.csv', b'ID;Nome\n1;NAME;EXTRA\n2;OK\n'), ('produtos.csv', b'ID;Descri\xe7\xe3o\n3;X\n'), ('unknown.csv', b'ID;Nome\n4;Y\n')])
        self.assertEqual(summary['counts']['csv'], 1)
        codes = {r['data']['code'] for r in self.records(output, 'issue')}
        self.assertEqual(codes, {'CSV_ROW_WIDTH_MISMATCH', 'CSV_ENCODING_REQUIRES_REVIEW', 'CSV_MODULE_UNRECOGNIZED'})

    def test_archive_traversal_and_symlink_members_are_rejected(self):
        for name in ['../outside.xml', '/outside.xml', 'a/../../outside.xml', 'a\\..\\outside.xml']:
            with self.subTest(name=name):
                source = self.root / 'attack.zip'
                source.write_bytes(archive([(name, b'x')]))
                with self.assertRaisesRegex(stage.StageError, '^UNSAFE_ARCHIVE_MEMBER$'):
                    stage.prepare(source, self.root / f'plan-{hashlib.sha256(name.encode()).hexdigest()}')
        info = zipfile.ZipInfo('link.xml')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        source = self.root / 'symlink.zip'
        source.write_bytes(archive([(info, b'/etc/passwd')]))
        with self.assertRaisesRegex(stage.StageError, '^UNSAFE_ARCHIVE_MEMBER$'):
            stage.prepare(source, self.root / 'plan-link')

    def test_expansion_and_member_limits_fail_before_member_read(self):
        source = self.root / 'oversized.zip'
        source.write_bytes(archive([('blob.bin', b'12345')]))
        with mock.patch.object(stage, 'MAX_MEMBER', 4):
            with self.assertRaisesRegex(stage.StageError, '^ARCHIVE_MEMBER_SIZE_OR_RATIO_LIMIT$'):
                stage.prepare(source, self.root / 'over-plan')

    def test_existing_output_is_never_overwritten(self):
        source, output, _ = self.prepare([('contatos.csv', b'ID;Nome\n1;A\n')])
        original = (output / 'manifest.json').read_bytes()
        with self.assertRaisesRegex(stage.StageError, '^OUTPUT_ALREADY_EXISTS$'):
            stage.prepare(source, output)
        self.assertEqual((output / 'manifest.json').read_bytes(), original)

    def test_manifest_is_deterministic_and_apply_replays_only_identical_chunks(self):
        source, output, summary = self.prepare([('contatos.csv', b'ID;Nome\n1;PRIVATE_NAME\n')])
        output2 = self.root / 'plan2'
        self.assertEqual(stage.prepare(source, output2), summary)
        self.assertEqual((output / 'manifest.json').read_bytes(), (output2 / 'manifest.json').read_bytes())
        remote = FakeRemote()
        stage.apply(output, 'a' * 20, 'unused', client=remote)
        original_chunks = dict(remote.chunks)
        stage.apply(output, 'a' * 20, 'unused', client=remote)
        self.assertEqual(remote.chunks, original_chunks)
        self.assertEqual(remote.calls.count('finish'), 2)

    def test_tampered_object_stops_before_any_remote_call(self):
        _, output, _ = self.prepare([('contatos.csv', b'ID;Nome\n1;A\n')])
        manifest = json.loads((output / 'manifest.json').read_text())
        (output / manifest['objects'][0]['local']).write_bytes(b'ALTERED')
        remote = FakeRemote()
        with self.assertRaisesRegex(stage.StageError, '^PLAN_OBJECT_INTEGRITY_FAILURE$'):
            stage.apply(output, 'a' * 20, 'unused', client=remote)
        self.assertEqual(remote.calls, [])

    def test_plan_rejects_path_escape_and_symlink_object_directory(self):
        with self.assertRaisesRegex(stage.StageError, '^INVALID_PLAN_PATH$'):
            stage.plan_path(self.root, '../secret')
        _, output, _ = self.prepare([('contatos.csv', b'ID;Nome\n1;A\n')])
        (output / 'objects').rename(output / 'objects-real')
        (output / 'objects').symlink_to(output / 'objects-real', target_is_directory=True)
        with self.assertRaisesRegex(stage.StageError, '^SYMLINK_PLAN_DIRECTORY$'):
            stage.validate_plan(output)

    def test_prepare_cli_summary_never_prints_private_cells(self):
        source = self.root / 'private-name.zip'
        source.write_bytes(archive([('contatos.csv', b'ID;Nome\n1;PRIVATE_CELL_VALUE\n')]))
        captured = io.StringIO()
        with mock.patch.object(sys_module(), 'argv', ['stage', 'prepare', '--source', str(source), '--output-dir', str(self.root / 'cli-plan')]), contextlib.redirect_stdout(captured):
            self.assertEqual(stage.main(), 0)
        self.assertNotIn('PRIVATE_CELL_VALUE', captured.getvalue())
        self.assertNotIn('private-name', captured.getvalue())


def sys_module():
    import sys
    return sys


class TransportTests(unittest.TestCase):
    def test_target_and_role_guard(self):
        for project, key in [('https://evil.test', 'sb_secret_test'), ('a' * 20, 'sb_publishable_test'), ('a' * 20, 'plain-secret')]:
            with self.assertRaises(stage.StageError):
                stage.Supabase(project, key)
        client = stage.Supabase('a' * 20, 'sb_secret_test')
        for method, path in [('DELETE', '/storage/v1/object/origin-backups/x'), ('GET', 'https://evil.test'), ('POST', '/rest/v1/rpc/other')]:
            with self.assertRaisesRegex(stage.StageError, '^HTTP_ROUTE_NOT_ALLOWED$'):
                client.request(method, path)

    def test_redirect_guard_does_not_include_location_or_secret(self):
        with self.assertRaises(stage.StageError) as caught:
            stage.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://private.example/SECRET')
        self.assertEqual(str(caught.exception), 'HTTP_REDIRECT_BLOCKED')

    def test_storage_conflict_requires_a_matching_authenticated_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'objects').mkdir()
            (directory / 'chunks').mkdir()
            raw = b'PRIVATE_XML'
            sha = stage.digest(raw)
            obj = {'local': f'objects/{sha}.xml', 'key': f'objects/{sha}.xml', 'sha256': sha, 'size': len(raw), 'content_type': 'application/xml'}
            (directory / obj['local']).write_bytes(raw)
            client = stage.Supabase('a' * 20, 'sb_secret_test')
            client.request = mock.Mock(side_effect=[(400, b''), (200, '0' * 64)])
            with self.assertRaisesRegex(stage.StageError, '^REMOTE_OBJECT_INTEGRITY_FAILURE$'):
                client.upload(directory, obj)
            self.assertIn('/object/authenticated/', client.request.call_args_list[1].args[1])
            client.request = mock.Mock(side_effect=[(409, b''), (200, sha)])
            client.upload(directory, obj)


class SqlContractTests(unittest.TestCase):
    def test_schema_is_separate_and_rpc_grants_are_service_only(self):
        sql = (Path(__file__).resolve().parents[2] / 'supabase/migrations/202610160003_origin_backup_staging.sql').read_text()
        self.assertIn('create schema origin_backup', sql)
        self.assertNotIn('insert into origin_sync.', sql)
        self.assertNotIn('insert into erp.', sql)
        self.assertEqual(sql.count('enable row level security'), 3)
        self.assertNotIn('create policy', sql.lower())
        for signature in ['origin_backup_begin(text, jsonb)', 'origin_backup_apply_chunk(text, text, text, jsonb)', 'origin_backup_finish(text)']:
            self.assertIn(f'revoke all on function public.{signature} from public, anon, authenticated;', sql)
            self.assertIn(f'grant execute on function public.{signature} to service_role;', sql)
        self.assertIn('immutable_backup_record_conflict', sql)
        self.assertIn('backup_storage_object_missing', sql)


if __name__ == '__main__':
    unittest.main()
