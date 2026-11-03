import test from 'node:test';
import assert from 'node:assert/strict';
import { addToCart, cartTotals, cashChange, generatePayments, itemDiscountPercent, lineTotals, money, moneyCents, pdvFailure, receiptItems, removeOneByCode, saleDocument, totalCents, unitMoney } from '../src/lib/pdv-model.ts';
import { PDV_SHORTCUTS, pdvActionFor, pdvShortcuts } from '../src/lib/pdv-shortcuts.ts';
import { AccessError } from '../src/lib/real-access.ts';
import { parsePosRoute, posRoute } from '../../../workers/erp-api/src/pos.mjs';

// Synthetic data only. Frente de caixa (PDV): cart, item discount in R$ or %, parcelas, troco, receipt order and shortcuts.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (n, quantity, price, extra = {}) => ({ id: id(n), product_id: id(100 + n), description: `Produto ${n}`, code: `P-${n}`, unit: 'UN', quantity, unit_price: price, discount_percent: '0', comment: null, list_price: null, kind: 'P', ...extra });

test('Money in exact cents and the item discount typed in reais becomes an exact percentage', () => {
  assert.deepEqual([moneyCents('12,34'), moneyCents('0,5'), moneyCents('100'), money('123456'), money(-150n)], ['1234', '50', '10000', 'R$ 1.234,56', 'R$ -1,50']);
  assert.throws(() => moneyCents('1.234,56'), /sem separador de milhar/);
  for (const [quantity, price, discount] of [['3', '9.99', '1,00'], ['1', '0.07', '0,01'], ['7', '13.4567', '2,37'], ['2.5', '19.90', '4,98'], ['12', '833.33', '99,99']]) {
    const percent = itemDiscountPercent(quantity, price, 'amount', discount), totals = lineTotals({ quantity, unit_price: price, discount_percent: percent });
    assert.equal(String(BigInt(totals.discount.replace('.', ''))), moneyCents(discount), `${quantity} × ${price} − ${discount}`);
  }
  assert.equal(itemDiscountPercent('1', '10', 'percent', '12,5'), '12.5');
  assert.equal(itemDiscountPercent('1', '10', 'amount', '10,00'), '100');
  assert.throws(() => itemDiscountPercent('1', '10', 'amount', '10,01'), /maior que o subtotal/);
  assert.equal(unitMoney('10.5'), 'R$ 10,50');
});

test('Agrupar itens idênticos sums equal lines only; Remover produto a partir do GTIN takes one unit', () => {
  let cart = addToCart([], line(1, '1', '10'), true);
  cart = addToCart(cart, { ...line(2, '2', '10'), product_id: id(101) }, true);
  assert.deepEqual(cart.map(item => item.quantity), ['3']);
  cart = addToCart(cart, { ...line(3, '1', '10'), product_id: id(101), comment: 'Sem embalagem' }, true);
  cart = addToCart(cart, { ...line(4, '1', '10'), product_id: id(101) }, false);
  assert.deepEqual(cart.map(item => item.quantity), ['3', '1', '1']);
  const removed = removeOneByCode([line(5, '2.5', '1', { gtin: '7891234567895' })], '7891234567895');
  assert.deepEqual(removed.cart.map(item => item.quantity), ['1.5']);
  assert.deepEqual(removeOneByCode([line(6, '1', '1')], 'p-6').cart, []);
  assert.equal(removeOneByCode([line(7, '1', '1')], 'X'), null);
});

test('Totais, parcelas pela condição e troco das parcelas à vista em dinheiro', () => {
  const cart = [line(1, '2', '10'), line(2, '1', '25.5', { discount_percent: '10' })];
  const totals = cartTotals(cart, { discount_mode: 'amount', discount_value: '5.00', freight: '0', other_expenses: '1.00' });
  assert.deepEqual([totals.subtotal, totals.discount, totals.total, totalCents(totals)], ['42.95', '5.00', '38.95', '3895']);
  const rows = generatePayments('3895', '30 60 90', id(9));
  assert.deepEqual(rows.map(row => [row.days, row.amount_cents]), [[30, '1299'], [60, '1298'], [90, '1298']]);
  assert.deepEqual(generatePayments('1000', '', id(9)).map(row => [row.days, row.amount_cents]), [[0, '1000']]);
  assert.deepEqual(generatePayments('1000', '2x', id(9)).map(row => row.days), [30, 60]);
  assert.throws(() => generatePayments('1000', '', ''), /forma de pagamento/);
  const methods = [{ id: id(9), payment_type: '01' }, { id: id(8), payment_type: '03' }];
  const change = cashChange([{ key: 'a', payment_method_id: id(9), days: 0, amount_cents: '2000', note: '' }, { key: 'b', payment_method_id: id(8), days: 0, amount_cents: '1895', note: '' }], methods, '5000');
  assert.deepEqual([change.cash, change.change], [2000n, 3000n]);
  const document = saleDocument(cart, { discount_mode: 'amount', discount_value: '5.00', freight: '0', other_expenses: '1.00' }, { date: '2026-10-20', warehouse_id: id(50), expected_date: null, notes: ' ', internal_notes: '', seller_id: null, category_id: null });
  assert.deepEqual(Object.keys(document.items[0]), ['id', 'product_id', 'description', 'code', 'unit', 'quantity', 'unit_price', 'discount_percent', 'detailed_description']);
  assert.equal(document.notes, null);
});

test('The body built by the screen is accepted by the Worker contract', async () => {
  const data = { sale_id: null, expected_version: 0, document_version: null, kind: 'balcao', table_number: null, account_id: id(30), cash_session_id: id(31), contact_id: null, price_list_id: null,
    document: saleDocument([line(1, '2', '10')], { discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0' }, { date: '2026-10-20', warehouse_id: id(50), expected_date: null, notes: '', internal_notes: '', seller_id: null, category_id: null }),
    payments: [{ payment_method_id: id(9), days: 0, amount_cents: '2000', note: null }], destination_account_id: null, to_ledger: false, cash_received_cents: '5000' };
  const parsed = await parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa/actions/sale_finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: id(1), data }) }), posRoute('/v1/frente-caixa/actions/sale_finish'));
  assert.equal(parsed.rpc, 'erp_pos_sale_execute');
  assert.deepEqual(parsed.args.p_data.payments, data.payments);
  // An open sale goes back with the version of the pedido it read; a new one has none.
  for (const broken of [{ document_version: 3 }, { sale_id: id(80), expected_version: 2, document_version: null }])
    await assert.rejects(() => parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa/actions/sale_finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: id(1), data: { ...data, ...broken } }) }), posRoute('/v1/frente-caixa/actions/sale_finish')), error => error.status === 400);
  await assert.rejects(() => parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa/actions/sale_finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: id(1), data: { ...data, payments: [{ ...data.payments[0], amount_cents: '1999' }] } }) }), posRoute('/v1/frente-caixa/actions/sale_finish')), error => error.status === 400);
});

test('Comprovante: ordem Alfabética ou Inserção; the refusals of the server become Origin messages', () => {
  const sale = { items: [{ ...line(1, '1', '1'), description: 'Zebra', position: 1 }, { ...line(2, '1', '1'), description: 'abacate', position: 2 }, { ...line(3, '1', '1'), description: 'Banana', position: 3 }] };
  assert.deepEqual(receiptItems(sale, 'alfabetica').map(item => item.description), ['abacate', 'Banana', 'Zebra']);
  assert.deepEqual(receiptItems(sale, 'insercao').map(item => item.description), ['Zebra', 'abacate', 'Banana']);
  assert.match(pdvFailure(new AccessError(400, 'ERP_INVALID_QUERY', 'stock_insufficient')), /Estoque insuficiente/);
  assert.match(pdvFailure(new AccessError(409, 'ERP_CONFLICT', 'cash_session_required')), /o caixa deve ser aberto/);
  assert.match(pdvFailure(new AccessError(409)), /mudou/);
});

test('Configured shortcuts: the keys of Preferências replace the Origin defaults; a repeated or unknown key keeps the defaults', () => {
  const configured = Object.fromEntries(PDV_SHORTCUTS.map(item => [item.action, item.key]));
  configured.finalizar = 'F'; configured.favoritos = 'S';
  const shortcuts = pdvShortcuts(configured);
  assert.equal(shortcuts.find(item => item.action === 'finalizar').key, 'F');
  assert.equal(pdvActionFor({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 'f', code: 'KeyF' }, false, shortcuts), 'finalizar');
  assert.equal(pdvActionFor({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 's', code: 'KeyS' }, false, shortcuts), 'favoritos');
  assert.equal(pdvShortcuts({ ...configured, nova: 'F' }), PDV_SHORTCUTS);
  assert.equal(pdvShortcuts({ ...configured, nova: '?' }), PDV_SHORTCUTS);
  assert.equal(pdvShortcuts(null), PDV_SHORTCUTS);
});
