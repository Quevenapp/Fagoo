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
from validator import FiscalSchemaError, MAX_XML_BYTES, PROFILE_ROOT, Validator, _PinnedResolver


class ValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["node", str(ROOT / "test/fixture.mjs")], check=True,
                                capture_output=True, timeout=30)
        cls.fixtures = json.loads(result.stdout)
        cls.validator = Validator()

    def xml(self, model="55"):
        return self.fixtures[model]["xml"].encode()

    def rejects(self, data, code, model="55"):
        with self.assertRaises(FiscalSchemaError) as result:
            self.validator.validate(data, expected_model=model)
        self.assertEqual(result.exception.code, code)
        return result.exception

    def test_full_synthetic_signed_models_match_pinned_official_schema(self):
        for model in ("55", "65"):
            self.assertTrue(self.fixtures[model]["signatureVerified"])
            result = self.validator.validate(self.xml(model), expected_model=model)
            self.assertTrue(result["xsdValidated"])
            self.assertEqual(result["xmlDigest"], hashlib.sha256(self.xml(model)).hexdigest())
            for flag in ("signatureVerified", "taxRulesValidated", "icpBrasilChainValidated",
                         "revocationChecked", "sefazAuthorized", "canTransmit"):
                self.assertFalse(result[flag])

    def test_missing_required_field_bad_order_and_decimal_are_rejected(self):
        xml = self.xml()
        for bad in (xml.replace(b"<natOp>VENDA FICTICIA DE TESTE</natOp>", b""),
                    xml.replace(b"<vPag>10.00</vPag>", b"<vPag>10.001</vPag>"),
                    xml.replace(b"<cUF>35</cUF><cNF>12345678</cNF>",
                                b"<cNF>12345678</cNF><cUF>35</cUF>")):
            self.rejects(bad, "XML_XSD_INVALID")

    def test_online_nfce_qr_v3_supplement_matches_official_schema(self):
        fixture = self.fixtures["nfceQrV3"]
        self.assertTrue(fixture["signatureVerified"])
        result = self.validator.validate(fixture["xml"].encode(), expected_model="65")
        self.assertTrue(result["xsdValidated"])
        bad = fixture["xml"].replace("|3|2</qrCode>", "|9|2</qrCode>").encode()
        self.rejects(bad, "XML_XSD_INVALID", model="65")

    def test_schema_validation_does_not_verify_signature_or_tax_totals(self):
        # A changed valid string and arithmetically wrong total still fit the XSD.
        changed = self.xml().replace(b"<vNF>10.00</vNF>", b"<vNF>99.99</vNF>")
        result = self.validator.validate(changed, expected_model="55")
        self.assertTrue(result["xsdValidated"])
        self.assertFalse(result["signatureVerified"])
        self.assertFalse(result["taxRulesValidated"])
        self.assertFalse(result["canTransmit"])

    def test_error_diagnostics_do_not_expose_input_values(self):
        marker = b"PRIVATE_FINANCIAL_VALUE_ABC"
        error = self.rejects(self.xml().replace(b"<vPag>10.00</vPag>",
                             b"<vPag>" + marker + b"</vPag>"), "XML_XSD_INVALID")
        self.assertTrue(error.diagnostics)
        self.assertNotIn(marker.decode(), str(error) + json.dumps(error.diagnostics))
        for diagnostic in error.diagnostics:
            self.assertEqual(set(diagnostic), {"line", "column", "domain", "type"})

    def test_dtd_entities_comments_cdata_and_processing_instructions_rejected(self):
        for prefix in (b'<!DOCTYPE NFe SYSTEM "file:///etc/passwd">',
                       b'<!DOCTYPE NFe [<!ENTITY x SYSTEM "https://example.invalid/">]>',
                       b'<!--comment-->', b'<?instruction secret?>'):
            self.rejects(prefix + self.xml(), "XML_DECLARATION_UNSUPPORTED")
        self.rejects(self.xml().replace(b"PRODUTO FICTICIO", b"<![CDATA[PRODUTO]]> FICTICIO"),
                     "XML_DECLARATION_UNSUPPORTED")

    def test_model_environment_namespace_and_wrapper_fail_closed(self):
        self.rejects(self.xml(), "XML_EXPECTED_MODEL_MISMATCH", model="65")
        self.rejects(self.xml(), "EXPECTED_MODEL_REQUIRED", model=None)
        self.rejects(self.xml().replace(b"<tpAmb>2</tpAmb>", b"<tpAmb>1</tpAmb>"),
                     "XML_HOMOLOGATION_REQUIRED")
        self.rejects(self.xml().replace(b"http://www.portalfiscal.inf.br/nfe", b"urn:fake"),
                     "XML_NFE_ROOT_INVALID")
        self.rejects(b"<nfeProc>" + self.xml() + b"</nfeProc>", "XML_NFE_ROOT_INVALID")

    def test_encoding_size_and_tree_limits(self):
        for xml in (b"", b" " * (MAX_XML_BYTES + 1), "not bytes"):
            self.rejects(xml, "XML_SIZE_OR_TYPE_INVALID")
        for xml in (b"\xff" + self.xml(), b"\xef\xbb\xbf" + self.xml(), b"\x00" + self.xml()):
            self.rejects(xml, "XML_ENCODING_INVALID")
        self.rejects(self.xml()[:-5], "XML_MALFORMED")
        self.rejects(self.xml().replace(b"<emit>", b"<emit>" + b"<x>" * 90 + b"</x>" * 90), "XML_TREE_LIMIT")
        attributes = b" ".join(f'a{i}="x"'.encode() for i in range(41))
        self.rejects(self.xml().replace(b"<emit>", b"<emit " + attributes + b">"), "XML_TREE_LIMIT")

    def test_utf8_declaration_supported_other_encodings_rejected(self):
        result = self.validator.validate(b'<?xml version="1.0" encoding="UTF-8"?>' + self.xml(), expected_model="55")
        self.assertTrue(result["xsdValidated"])
        self.rejects(b'<?xml version="1.0" encoding="ISO-8859-1"?>' + self.xml(), "XML_DECLARATION_UNSUPPORTED")

    def test_pinned_manifest_and_all_files_detect_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "profile"
            shutil.copytree(PROFILE_ROOT, root)
            manifest = (root / "manifest.json").read_bytes()
            (root / "manifest.json").write_bytes(manifest + b" ")
            with self.assertRaisesRegex(FiscalSchemaError, "SCHEMA_MANIFEST_INTEGRITY_FAILED"):
                Validator(root)
            (root / "manifest.json").write_bytes(manifest)
            for item in json.loads(manifest)["files"]:
                path = root / item["name"]
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaisesRegex(FiscalSchemaError, "SCHEMA_FILE_INTEGRITY_FAILED"):
                    Validator(root)
                path.write_bytes(original)

    def test_resolver_rejects_network_and_paths_outside_allowlist(self):
        resolver = _PinnedResolver(PROFILE_ROOT, {"nfe_v4.00.xsd": b""})
        for url in ("https://example.invalid/a.xsd", "file:///etc/passwd", "../a.xsd",
                    "unknown.xsd", "file://example.invalid/nfe_v4.00.xsd"):
            with self.assertRaisesRegex(FiscalSchemaError, "SCHEMA_EXTERNAL_RESOURCE_FORBIDDEN"):
                resolver.resolve(url, None, None)

    def test_cli_stdin_outputs_only_sanitized_result(self):
        result = subprocess.run([sys.executable, str(ROOT / "validator.py"), "--model", "55"],
                                input=self.xml(), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(json.loads(result.stdout)["xsdValidated"])
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(b"EMPRESA", result.stdout)
        bad = subprocess.run([sys.executable, str(ROOT / "validator.py"), "--model", "55"],
                             input=b"bad", capture_output=True, timeout=10)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(json.loads(bad.stdout)["code"], "XML_MALFORMED")
        self.assertEqual(bad.stderr, b"")


if __name__ == "__main__":
    unittest.main()
