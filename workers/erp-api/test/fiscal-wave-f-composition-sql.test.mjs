import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveFFixture } from './helpers/fiscal-wave-f-fixture.mjs';
import { orderSourceRecord } from '../../../packages/erp-domain/src/fiscal-invoice-order.mjs';

// Wave F of the notas fiscais lane (synthetic data only): "Desmembrar produtos Físico / Virtual em uma estrutura na nota fiscal" also for the
// NFC-e of a sale. The Frente de caixa opens "Gerar NFC-e" with its pedido de venda (RealPdv fiscalHref), the same source as the NF-e (254).
let f, contact, warehouse, part, screw, kit;
const recordVersion = async id => Number(await f.scalar('select version v from erp_catalog.record where id=$1', [id]));
before(async () => {
  f = await fiscalWaveFFixture();
  await f.company();
  await f.setPreference('suprimentos-estoque', 'estoque.nf_estoque_negativo', true).catch(() => null);
  contact = await f.catalog('contacts', { name: 'Consumidor sintético', person_type: 'F', document: '52998224725', state: 'SP', city: 'São Paulo', postal_code: '01001000', street: 'Rua Sintética', number: '10', district: 'Centro' });
  warehouse = await f.catalog('warehouses', { name: 'Depósito do caixa' });
  part = await f.catalog('products', { name: 'Peça do kit', code: 'PK-1', unit: 'UN', kind: 'P', format: 'S', price: '30', ncm: '84714900' });
  screw = await f.catalog('products', { name: 'Parafuso do kit', code: 'PK-2', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '73181500' });
  kit = await f.catalog('products', { name: 'Kit do caixa', code: 'KIT-PDV', unit: 'KT', kind: 'P', format: 'E', price: '50', ncm: '84714900' });
  await f.rpc('erp_stock_product_compose', { p_user_id: f.users.admin, p_id: kit.id, p_expected_version: await recordVersion(kit.id), p_command_id: randomUUID(), p_data: { name: 'Kit do caixa' }, p_acknowledged: null,
    p_composition: { expected_version: 0, stock_type: 'physical', post_mode: 'product', items: [{ component_id: part.id, quantity: '1' }, { component_id: screw.id, quantity: '2' }] } });
});
after(() => f?.close());

test('Gerar NFC-e of a sale (the path of the Frente de caixa) splits the structure into its components with the preference on', async () => {
  const sale = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: { date: '2026-10-20', contact_id: contact.id, warehouse_id: warehouse.id, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', commercial: null,
    items: [{ product_id: kit.id, description: 'Kit do caixa', detailed_description: null, code: 'KIT-PDV', unit: 'KT', quantity: '1', unit_price: '50', discount_percent: '0' }], installments: [] } });
  assert.equal(sale.status, 200, JSON.stringify(sale.value));
  const read = async () => orderSourceRecord((await f.call(`/v1/notas-fiscais/pedido/${sale.value.document.id}?model=65`, 'GET', undefined, f.users.fiscal)).value);
  assert.equal((await read()).items[0].composition, null, 'off by default, as in Origin');
  await f.setPreference('vendas-vendas', 'vendas.desmembrar_fisico', true);
  const source = await read();
  assert.equal(source.model, '65');
  assert.deepEqual(source.items[0].composition.components.map(c => [c.product_id, c.quantity]), [[part.id, '1.000000'], [screw.id, '2.000000']]);
});
