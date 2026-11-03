"""Offline contract checks against the unmodified official PL_NFeDistDFe_104."""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / 'schemas/distribution-v1.04'
MANIFEST_HASH = 'd1abb13b31187e9ea17d9fe8d08503b46080cbae8ea6da1337dc8a905d640f95'
NS = 'http://www.portalfiscal.inf.br/nfe'


class DistributionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest_bytes = (SCHEMAS / 'manifest.json').read_bytes()
        assert hashlib.sha256(manifest_bytes).hexdigest() == MANIFEST_HASH
        manifest = json.loads(manifest_bytes)
        verified = {}
        for item in manifest['files']:
            data = (SCHEMAS / item['name']).read_bytes()
            assert len(data) == item['bytes'] and hashlib.sha256(data).hexdigest() == item['sha256']
            verified[item['name']] = data

        class Resolver(etree.Resolver):
            def resolve(self, url, public_id, context):
                if url not in verified:
                    raise ValueError('UNRECOGNIZED_SCHEMA_DEPENDENCY')
                return self.resolve_string(verified[url], context, base_url=url)

        parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
        parser.resolvers.add(Resolver())
        cls.request_schema = etree.XMLSchema(etree.fromstring(verified['distDFeInt_v1.01.xsd'], parser, base_url='distDFeInt_v1.01.xsd'))
        cls.response_schema = etree.XMLSchema(etree.fromstring(verified['retDistDFeInt_v1.01.xsd'], parser, base_url='retDistDFeInt_v1.01.xsd'))
        module = (ROOT.parent / 'fiscal-xml/src/distribution.mjs').as_uri()
        identity = (ROOT.parent / 'fiscal-core/src/identity.mjs').as_uri()
        source = f"""import {{buildDistributionRequest}} from {json.dumps(module)};
import {{cnpjCheckDigits}} from {json.dumps(identity)};
const base='12ABC34501DE', common={{authorUf:'35',lastNsu:'999999999999999'}};
console.log(JSON.stringify(['1','2'].flatMap(environment=>['12345678000195',base+cnpjCheckDigits(base)].map(interestedCnpj=>buildDistributionRequest({{...common,environment,interestedCnpj}}).xml))));"""
        process = subprocess.run(['node', '--input-type=module', '-e', source], capture_output=True, check=True, timeout=15)
        cls.queries = json.loads(process.stdout)

    def response(self, documents=1, nsu=True):
        data = base64.b64encode(gzip.compress(b'<synthetic/>')).decode()
        docs = ''.join(f'<docZip{(" NSU=" + chr(34) + str(i+1).zfill(15) + chr(34)) if nsu else ""} schema="future_v1.00.xsd">{data}</docZip>' for i in range(documents))
        return f'<retDistDFeInt xmlns="{NS}" versao="1.01"><tpAmb>2</tpAmb><verAplic>TESTE</verAplic><cStat>138</cStat><xMotivo>RESPOSTA SINTETICA</xMotivo><dhResp>2026-10-16T10:00:00-03:00</dhResp><ultNSU>{str(documents).zfill(15)}</ultNSU><maxNSU>{str(documents).zfill(15)}</maxNSU><loteDistDFeInt>{docs}</loteDistDFeInt></retDistDFeInt>'.encode()

    def test_generated_requests_match_official_layout_both_environments_and_alphanumeric_cnpj(self):
        for query in self.queries:
            self.request_schema.assertValid(etree.fromstring(query.encode()))

    def test_nsu_is_exactly_fifteen_digits_and_layout_stays_101(self):
        query = self.queries[0].encode()
        for altered in (query.replace(b'999999999999999', b'0'), query.replace(b'999999999999999', b'1000000000000000'), query.replace(b'versao="1.01"', b'versao="1.04"')):
            self.assertFalse(self.request_schema.validate(etree.fromstring(altered)))

    def test_response_allows_at_most_fifty_individually_compressed_documents(self):
        self.response_schema.assertValid(etree.fromstring(self.response(50)))
        self.assertFalse(self.response_schema.validate(etree.fromstring(self.response(51))))

    def test_doc_nsu_optional_in_official_xsd_does_not_authorize_cursor_inference(self):
        self.response_schema.assertValid(etree.fromstring(self.response(nsu=False)))

    def test_published_xsd_requires_response_cursors_despite_optional_table_in_nt(self):
        altered = self.response().replace(b'<ultNSU>000000000000001</ultNSU>', b'')
        self.assertFalse(self.response_schema.validate(etree.fromstring(altered)))

    def test_schema_only_validates_base64_not_compression_document_kind_or_fiscal_merit(self):
        response = etree.fromstring(self.response())
        response.find(f'.//{{{NS}}}docZip').text = base64.b64encode(b'not gzip and not XML').decode()
        self.response_schema.assertValid(response)


if __name__ == '__main__':
    unittest.main()
