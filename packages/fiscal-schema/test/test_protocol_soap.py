"""SOAP extraction is only a boundary; independent pinned XSD remains mandatory."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from protocol_validator import ProtocolValidator
from validator import FiscalSchemaError


class ProtocolSoapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run = subprocess.run(["node", str(ROOT / "test/protocol-soap-fixture.mjs")],
                             check=True, capture_output=True, timeout=15)
        cls.fixtures = json.loads(run.stdout)
        cls.validator = ProtocolValidator()

    def test_soap_draft_payload_and_extracted_candidate_pass_independent_pinned_xsd(self):
        for fixture in self.fixtures:
            context = {"expected_access_key": fixture["accessKey"], "expected_model": fixture["model"]}
            request = self.validator.validate(fixture["draft"]["xml"].encode(), direction="request", **context)
            candidate = fixture["candidate"]
            response = self.validator.validate(candidate["payloadXml"].encode(), direction="response",
                                               expected_reference_digest=fixture["referenceDigest"], **context)
            self.assertTrue(request["xsdValidated"])
            self.assertEqual(candidate["payloadDigest"], response["xmlDigest"])
            self.assertEqual(response["cStat"], "101")
            self.assertEqual(response["protocol"]["cStat"], "100")
            self.assertTrue(response["eventReconciliationRequired"])
            self.assertEqual(fixture["draft"]["envelopeDigest"],
                             hashlib.sha256(fixture["draft"]["envelopeXml"].encode()).hexdigest())
            self.assertFalse(candidate["xsdValidated"])
            self.assertFalse(candidate["bindingVerified"])
            for result in (candidate, response):
                for flag in ("verified", "tlsOriginVerified", "signatureVerified", "sefazAuthorized", "canTransmit"):
                    self.assertFalse(result[flag])

    def test_soap_shape_and_context_do_not_promote_a_schema_invalid_payload(self):
        for fixture in self.fixtures:
            candidate = fixture["incomplete"]
            self.assertTrue(candidate["queryContextMatched"])
            self.assertTrue(candidate["requiresProtocolValidation"])
            self.assertFalse(candidate["xsdValidated"])
            with self.assertRaisesRegex(FiscalSchemaError, "XML_XSD_INVALID"):
                self.validator.validate(candidate["payloadXml"].encode(), direction="response",
                                        expected_access_key=fixture["accessKey"], expected_model=fixture["model"])


if __name__ == "__main__":
    unittest.main()
