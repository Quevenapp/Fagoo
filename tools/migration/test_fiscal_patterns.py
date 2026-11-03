"""Synthetic tests for the read-only historical pattern counter."""
import unittest

from inspect_fiscal_patterns import add_invoice, new_stats, safe_xml, NS, freeze
from inspect_origin_backup import InventoryError


def invoice(icms, cfop='5102', extra='', model='55'):
    return safe_xml(f'''<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe{'1'*44}">
      <ide><mod>{model}</mod><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe><idDest>1</idDest></ide>
      <emit><CRT>1</CRT></emit><det><prod><CFOP>{cfop}</CFOP><NCM>82055900</NCM></prod>
      <imposto><ICMS>{icms}</ICMS><PIS><PISOutr><CST>49</CST><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>
      <COFINS><COFINSOutr><CST>49</CST></COFINSOutr></COFINS>{extra}</imposto></det></infNFe></NFe>'''.encode())


class FiscalPatternsTests(unittest.TestCase):
    def test_structural_group_is_not_csosn(self):
        root = invoice('<ICMSSN102><orig>0</orig><CSOSN>400</CSOSN></ICMSSN102>', '5916')
        stats = new_stats(); add_invoice(stats, root, root, '1'*44, set())
        self.assertEqual(stats['tax_groups']['ICMS'], {'ICMSSN102': 1})
        self.assertEqual(stats['tax_codes']['ICMS/CSOSN'], {'400': 1})
        self.assertEqual(stats['common_domestic_sales_only_documents'], 0)

    def test_zero_precision_and_absence_are_distinct(self):
        root = invoice('<ICMSSN101><orig>0</orig><CSOSN>101</CSOSN><pCredSN>4.7900</pCredSN><vCredICMSSN>0.00</vCredICMSSN></ICMSSN101>')
        stats = new_stats(); add_invoice(stats, root, root, '1'*44, {'1'*44})
        self.assertEqual(stats['rate_histograms']['ICMS/ICMSSN101/pCredSN'], {'4.7900': 1})
        self.assertNotIn('ICMS/ICMSSN101/vCredICMSSN', stats['nonzero_numeric_fields_items'])
        self.assertEqual(stats['tax_groups']['IPI'], {'absent': 1})
        self.assertEqual(stats['cancel_event_documents'], 1)

    def test_item_vs_document_frequency_and_ibs_isolation(self):
        root = invoice('<ICMSSN500><orig>2</orig><CSOSN>500</CSOSN></ICMSSN500>', '5405', '<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>1.00</vBC></gIBSCBS></IBSCBS>')
        import copy
        root.find(NS+'infNFe').append(copy.deepcopy(root.find(NS+'infNFe/'+NS+'det')))
        stats = new_stats(); add_invoice(stats, root, root, '1'*44, set())
        self.assertEqual(stats['cfop_items'], {'5405': 2})
        self.assertEqual(stats['cfop_documents'], {'5405': 1})
        self.assertEqual(stats['tax_codes']['IBSCBS/CST'], {'000': 2})
        self.assertEqual(stats['features_documents']['IBSCBS'], 1)
        self.assertEqual(stats['common_domestic_sales_only_documents'], 0)
        self.assertEqual(freeze(stats)['documents'], 1)

    def test_dtd_rejected_before_aggregation(self):
        with self.assertRaises(InventoryError):
            safe_xml(b'<!DOCTYPE x [<!ENTITY y "unsafe">]><x>&y;</x>')


if __name__ == '__main__':
    unittest.main()
