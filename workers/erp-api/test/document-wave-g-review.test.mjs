// Synthetic data only. Review of the documentos lane, wave G (202610200287-294): Worker refusals added by the review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { posRefusal } from '../src/pos.mjs';

test('Frente de caixa: "Número de casas decimais na quantidade" refused by the pedido of the venda has its own reason', () => {
  assert.equal(posRefusal('erp_document_quantity_decimals'), 'quantity_decimals');
  assert.equal(posRefusal('erp_document_price_decimals'), 'price_decimals', 'the price rule is unchanged');
});
