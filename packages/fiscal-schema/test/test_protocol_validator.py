import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from protocol_validator import ProtocolValidator, PROFILE_ROOT
from validator import FiscalSchemaError, MAX_XML_BYTES

NS = "http://www.portalfiscal.inf.br/nfe"
DIGEST = base64.b64encode(bytes(range(20))).decode()
TIME = "2026-10-16T01:00:00-03:00"


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["node", str(ROOT / "test/protocol-fixture.mjs")], check=True, capture_output=True, timeout=15)
        cls.fixtures = json.loads(result.stdout)
        cls.validator = ProtocolValidator()

    def response(self, label="55", status="100", protocol=True, number="13526000000000001", extra=""):
        key = self.fixtures[label]["accessKey"]
        detail = f'<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_TESTE</verAplic><chNFe>{key}</chNFe><dhRecbto>{TIME}</dhRecbto><nProt>{number}</nProt><digVal>{DIGEST}</digVal><cStat>100</cStat><xMotivo>TESTE FICTICIO</xMotivo></infProt></protNFe>' if protocol else ""
        return f'<retConsSitNFe xmlns="{NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SP_TESTE</verAplic><cStat>{status}</cStat><xMotivo>TESTE FICTICIO</xMotivo><cUF>35</cUF><dhRecbto>{TIME}</dhRecbto><chNFe>{key}</chNFe>{detail}{extra}</retConsSitNFe>'.encode()

    def validate(self, xml, label="55", direction="response", **kwargs):
        return self.validator.validate(xml, expected_access_key=self.fixtures[label]["accessKey"],
                                       expected_model=self.fixtures[label]["model"], direction=direction, **kwargs)

    def rejects(self, xml, code, **kwargs):
        with self.assertRaises(FiscalSchemaError) as result:
            self.validate(xml, **kwargs)
        self.assertEqual(result.exception.code, code)
        return result.exception

    def test_generated_queries_use_official_schema_for_both_models_and_alphanumeric_key(self):
        for label in ("55", "65", "alpha"):
            xml = self.fixtures[label]["xml"].encode()
            result = self.validate(xml, label, "request")
            self.assertTrue(result["xsdValidated"])
            self.assertTrue(result["contextMatched"])
            self.assertEqual(result["xmlDigest"], hashlib.sha256(xml).hexdigest())

    def test_response_can_match_protocol_digest_without_claiming_origin_or_authorization(self):
        for label in ("55", "65", "alpha"):
            for number in ("135260000000001", "13526000000000001"):
                result = self.validate(self.response(label, number=number), label, expected_reference_digest=DIGEST)
                self.assertEqual(result["protocol"]["number"], number)
                self.assertTrue(result["protocol"]["referenceDigestMatched"])
                for flag in ("verified", "tlsOriginVerified", "signatureVerified", "sefazAuthorized", "canTransmit"):
                    self.assertFalse(result[flag])

    def test_context_binding_rejects_other_model_key_environment_uf_and_nested_protocol_key(self):
        xml = self.response()
        self.rejects(xml, "XML_QUERY_KEY_MISMATCH", label="65")
        other = self.fixtures["other"]["accessKey"].encode()
        key = self.fixtures["55"]["accessKey"].encode()
        self.rejects(xml.replace(key, other), "XML_QUERY_KEY_MISMATCH")
        self.rejects(xml.replace(b"<tpAmb>2</tpAmb>", b"<tpAmb>1</tpAmb>", 1), "XML_HOMOLOGATION_REQUIRED")
        self.rejects(xml.replace(b"<cUF>35</cUF>", b"<cUF>33</cUF>"), "XML_QUERY_UF_MISMATCH")
        start = xml.index(b"<protNFe")
        self.rejects(xml[:start] + xml[start:].replace(key, other), "XML_PROTOCOL_CONTEXT_MISMATCH")

    def test_missing_protocol_number_digest_and_digest_disagreement_never_succeed(self):
        xml = self.response()
        self.rejects(xml.replace(b"<nProt>13526000000000001</nProt>", b""), "XML_AUTHORIZATION_PROTOCOL_INCOMPLETE")
        self.rejects(xml.replace(f"<digVal>{DIGEST}</digVal>".encode(), b""), "XML_AUTHORIZATION_PROTOCOL_INCOMPLETE")
        self.rejects(xml.replace(DIGEST.encode(), b"AAAA"), "XML_PROTOCOL_DIGEST_INVALID")
        self.rejects(xml, "XML_PROTOCOL_DIGEST_MISMATCH", expected_reference_digest=base64.b64encode(b"x" * 20).decode())
        self.rejects(self.response(protocol=False), "XML_AUTHORIZATION_PROTOCOL_INCOMPLETE", expected_reference_digest=DIGEST)
        result = self.validate(xml)
        self.assertFalse(result["protocol"]["referenceDigestMatched"])

    def test_cancelled_top_level_does_not_turn_original_authorization_into_cancellation(self):
        result = self.validate(self.response(status="101"), expected_reference_digest=DIGEST)
        self.assertEqual(result["cStat"], "101")
        self.assertEqual(result["protocol"]["cStat"], "100")
        self.assertTrue(result["eventReconciliationRequired"])
        self.assertFalse(result["verified"])
        self.assertNotIn("cancellationProtocol", result)

    def test_not_found_and_new_four_digit_status_preserved_without_retry_or_authorization(self):
        for status in ("217", "9999"):
            result = self.validate(self.response(status=status, protocol=False))
            self.assertEqual(result["cStat"], status)
            self.assertIsNone(result["protocol"])
            self.assertFalse(result["canTransmit"])

    def test_events_and_legacy_cancellation_remain_unverified_and_must_match_query_context(self):
        key = self.fixtures["55"]["accessKey"]
        other = self.fixtures["other"]["accessKey"]
        # Deliberately fake signature that only satisfies XML structure; it must never gain trust.
        signature = f'<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI="#ID110111{key}01"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>{DIGEST}</DigestValue></Reference></SignedInfo><SignatureValue>AAAA</SignatureValue><KeyInfo><X509Data><X509Certificate>AAAA</X509Certificate></X509Data></KeyInfo></Signature>'
        event = f'<procEventoNFe versao="1.00"><evento versao="1.00"><infEvento Id="ID110111{key}01"><cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>12345678000195</CNPJ><chNFe>{key}</chNFe><dhEvento>{TIME}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento></detEvento></infEvento>{signature}</evento><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>SP_TESTE</verAplic><cOrgao>35</cOrgao><cStat>135</cStat><xMotivo>TESTE FICTICIO</xMotivo><chNFe>{key}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>{TIME}</dhRegEvento><nProt>13526000000000002</nProt></infEvento></retEvento></procEventoNFe>'
        result = self.validate(self.response(status="101", extra=event))
        self.assertEqual(result["eventCount"], 1)
        self.assertTrue(result["eventReconciliationRequired"])
        self.assertFalse(result["signatureVerified"])
        self.assertFalse(result["verified"])
        self.rejects(self.response(extra=event.replace(f"<chNFe>{key}</chNFe>", f"<chNFe>{other}</chNFe>")), "XML_EVENT_CONTEXT_MISMATCH")
        self.rejects(self.response(extra=event.replace("<tpAmb>2</tpAmb>", "<tpAmb>1</tpAmb>")), "XML_EVENT_CONTEXT_MISMATCH")
        legacy = f'<retCancNFe versao="2.00"><infCanc><tpAmb>2</tpAmb><verAplic>SP_TESTE</verAplic><cStat>101</cStat><xMotivo>TESTE FICTICIO</xMotivo><cUF>35</cUF><chNFe>{key}</chNFe><dhRecbto>{TIME}</dhRecbto><nProt>13526000000000002</nProt></infCanc></retCancNFe>'
        self.assertTrue(self.validate(self.response(extra=legacy))["legacyCancellationObserved"])
        self.rejects(self.response(extra=legacy.replace(key, other)), "XML_EVENT_CONTEXT_MISMATCH")

    def test_expected_key_itself_cannot_bypass_dv_or_model_constraints(self):
        key = self.fixtures["55"]["accessKey"]
        for bad in (None, "<xml>", key[:-1] + str((int(key[-1]) + 1) % 10)):
            with self.assertRaisesRegex(FiscalSchemaError, "EXPECTED_KEY_INVALID"):
                self.validator.validate(self.response(), expected_access_key=bad, expected_model="55", direction="response")
        with self.assertRaisesRegex(FiscalSchemaError, "EXPECTED_KEY_PROFILE_UNSUPPORTED"):
            self.validator.validate(self.response(), expected_access_key=key, expected_model="65", direction="response")

    def test_required_order_duplicates_namespaces_wrappers_and_calendar_fail_closed(self):
        xml = self.response()
        self.rejects(xml.replace(b"<cUF>35</cUF>", b"<cUF>35</cUF><cUF>35</cUF>"), "XML_XSD_INVALID")
        self.rejects(xml.replace(b"<cUF>35</cUF>", b""), "XML_XSD_INVALID")
        self.rejects(xml.replace(NS.encode(), b"urn:fake"), "XML_QUERY_ROOT_INVALID")
        self.rejects(b"<wrapper>" + xml + b"</wrapper>", "XML_QUERY_ROOT_INVALID")
        self.rejects(xml.replace(TIME.encode(), b"2026-02-30T01:00:00-03:00"), "XML_XSD_INVALID")
        # xs:dateTime permits no offset, but our reconciliation context requires one.
        start = xml.index(b"<protNFe")
        self.rejects(xml[:start] + xml[start:].replace(TIME.encode(), b"2026-10-16T01:00:00"), "XML_PROTOCOL_TIMESTAMP_INVALID")

    def test_untrusted_xml_bombs_encodings_and_size_are_rejected_before_validation(self):
        xml = self.response()
        for prefix in (b'<!DOCTYPE x SYSTEM "file:///etc/passwd">', b'<!--x-->', b'<?x y?>'):
            self.rejects(prefix + xml, "XML_DECLARATION_UNSUPPORTED")
        self.rejects(xml.replace(b"TESTE FICTICIO", b"<![CDATA[SECRET]]>"), "XML_DECLARATION_UNSUPPORTED")
        self.rejects(b"\xff" + xml, "XML_ENCODING_INVALID")
        self.rejects(b" " * (MAX_XML_BYTES + 1), "XML_SIZE_OR_TYPE_INVALID")
        self.rejects(xml.replace(b"<cUF>35</cUF>", b"<a>" * 90 + b"</a>" * 90), "XML_TREE_LIMIT")

    def test_errors_and_results_omit_motive_and_input_values(self):
        marker = b"PRIVATE_VALUE_MUST_NOT_APPEAR"
        xml = self.response().replace(b"TESTE FICTICIO", marker)
        self.assertNotIn(marker.decode(), json.dumps(self.validate(xml)))
        error = self.rejects(xml.replace(b"<cUF>35</cUF>", b"<cUF>" + marker + b"</cUF>"), "XML_XSD_INVALID")
        self.assertNotIn(marker.decode(), str(error) + json.dumps(error.diagnostics))

    def test_profile_manifest_dependencies_and_symlinks_are_pinned(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "profile"
            shutil.copytree(PROFILE_ROOT, root)
            manifest = (root / "manifest.json").read_bytes()
            (root / "manifest.json").write_bytes(manifest + b" ")
            with self.assertRaisesRegex(FiscalSchemaError, "SCHEMA_MANIFEST_INTEGRITY_FAILED"):
                ProtocolValidator(root)
            (root / "manifest.json").write_bytes(manifest)
            for item in json.loads(manifest)["files"]:
                path = root / item["name"]
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaisesRegex(FiscalSchemaError, "SCHEMA_FILE_INTEGRITY_FAILED"):
                    ProtocolValidator(root)
                path.write_bytes(original)

    def test_cli_keeps_context_in_stdin_and_returns_sanitized_metadata(self):
        data = {"xml": self.response().decode(), "expectedModel": "55", "expectedAccessKey": self.fixtures["55"]["accessKey"], "direction": "response", "expectedReferenceDigest": DIGEST}
        result = subprocess.run([sys.executable, str(ROOT / "protocol_validator.py")], input=json.dumps(data).encode(), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(json.loads(result.stdout)["xsdValidated"])
        self.assertNotIn(b"TESTE FICTICIO", result.stdout)
        self.assertEqual(result.stderr, b"")
        bad = subprocess.run([sys.executable, str(ROOT / "protocol_validator.py")], input=b'[]', capture_output=True, timeout=10)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(json.loads(bad.stdout)["code"], "QUERY_INPUT_INVALID")
        deep = b'{"unused":' + b'[' * 10_000 + b'0' + b']' * 10_000 + b'}'
        nested = subprocess.run([sys.executable, str(ROOT / "protocol_validator.py")], input=deep, capture_output=True, timeout=10)
        self.assertEqual(nested.returncode, 2)
        self.assertEqual(json.loads(nested.stdout)["code"], "QUERY_INPUT_INVALID")
        self.assertEqual(nested.stderr, b"")


if __name__ == "__main__":
    unittest.main()
