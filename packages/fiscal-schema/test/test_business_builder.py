"""Checks the new business serializer against the preserved official XSD, without network."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from validator import Validator, FiscalSchemaError


class BusinessBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["node", str(ROOT / "test/business-fixture.mjs")],
                                check=True, capture_output=True, timeout=30)
        cls.cases = json.loads(result.stdout)
        cls.validator = Validator()

    def test_all_supported_models_and_tax_branches_pass_pinned_schema_after_synthetic_signature(self):
        self.assertEqual(set(self.cases), {"55-101", "55-102", "55-500", "65-102", "65-500", "65-qr", "55-250"})
        for name, case in self.cases.items():
            with self.subTest(name=name):
                self.assertTrue(case["signature_verified"])
                r = self.validator.validate(case["xml"].encode(), expected_model=case["model"])
                self.assertTrue(r["xsdValidated"])
                self.assertFalse(r["taxRulesValidated"])
                self.assertFalse(r["canTransmit"])
                self.assertFalse(case["can_transmit"])

    def test_unsigned_is_not_misrepresented_as_full_nfe_schema_validated(self):
        with self.assertRaises(FiscalSchemaError) as failure:
            self.validator.validate(self.cases["55-102"]["unsigned"].encode(), expected_model="55")
        self.assertEqual(failure.exception.code, "XML_XSD_INVALID")

    def test_group_order_and_missing_credit_are_rejected_by_the_actual_schema(self):
        xml = self.cases["55-101"]["xml"]
        for broken in [xml.replace("<vCredICMSSN>0.50</vCredICMSSN>", ""),
                       xml.replace("<orig>0</orig><CSOSN>101</CSOSN>", "<CSOSN>101</CSOSN><orig>0</orig>")]:
            with self.assertRaises(FiscalSchemaError) as failure:
                self.validator.validate(broken.encode(), expected_model="55")
            self.assertEqual(failure.exception.code, "XML_XSD_INVALID")


if __name__ == "__main__":
    unittest.main()
