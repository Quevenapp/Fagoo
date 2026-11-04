import test from 'node:test';
import assert from 'node:assert/strict';
import { documentExtrasRoute, documentExtrasMethods, documentExtrasOperation, documentExtrasResponse } from '../src/document-extras.mjs';

test('checkout lookup projects only the exact number and refuses inconsistent upstream identities', async () => {
  const path = '/v1/documentos/sales_orders/checkout';
  const route = documentExtrasRoute(path);
  assert.deepEqual(documentExtrasMethods(route), ['GET']);
  const operation = await documentExtrasOperation(new Request('https://api.example.test' + path + '?number=42'), route, new URLSearchParams('number=42'));
  const response = { kind: 'sales_orders', id: '10000000-0000-4000-8000-000000000001', number: '42', data_mode: 'erp_native', operational_effects: false, private_payload: 'must not escape' };
  assert.deepEqual(documentExtrasResponse(response, route, operation), { data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders', id: response.id, number: '42' });
  for (const patch of [{ number: '420' }, { id: 'invalid' }, { kind: 'purchase_orders' }, { operational_effects: true }])
    assert.throws(() => documentExtrasResponse({ ...response, ...patch }, route, operation), error => error.code === 'ERP_UPSTREAM_INVALID_RESPONSE');
});
