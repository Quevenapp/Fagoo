import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { addressLabels, addressesCsv, labelSheets } from '../src/lib/document-list-export.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Comprovante, carnê, impressão detalhada, endereços e etiquetas (synthetic data only).
const contact = 'c0000000-0000-4000-8000-000000000105', product = 'd0000000-0000-4000-8000-000000000105';
function record(extra = {}) {
  const data = { date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: product, description: 'Zebra peça', code: 'B-2', unit: 'UN', quantity: '2', unit_price: '9.5', discount_percent: '0' }, { id: 'e0000000-0000-4000-8000-000000000002', product_id: null, description: 'Alfa serviço', code: 'A-1', unit: 'H', quantity: '1.5', unit_price: '100', discount_percent: '10' }],
    installments: [{ due_date: '2026-11-20', amount: '77.00', method: 'Boleto', note: null, payment_reference: null }, { due_date: '2026-12-20', amount: '77.00', method: null, note: null, payment_reference: null }], ...extra };
  const normalized = normalizeDocument('sales_orders', data);
  return { ...normalized, id: 'b0000000-0000-4000-8000-000000000105', kind: 'sales_orders', number: '105', version: 2, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente Comprovante', document: '529.982.247-25' }, effect_flags: { finance_active: false, stock_active: false },
    items: normalized.items.map((item, index) => ({ ...item, product_snapshot: index === 0 ? { id: product, version: 1, name: 'Zebra peça', price: '10.0000' } : null })) };
}
const company = { version: 3, data: { legal_name: 'Empresa Sintética Ltda', trade_name: 'Sintética', cnpj: '11.222.333/0001-81', ie: null, street: 'Rua A', number: '1', complement: null, district: 'Centro', city: 'Piracicaba', state: 'SP', postal_code: '13400-000', email: null, phone: null, crt: '1' } };

test('Imprimir c/ detalhes adds the list price and the code; Opções de impressão orders the items without renumbering', () => {
  const plain = documentPrintModel(record());
  assert.equal(plain.detailed, false); assert.deepEqual(plain.items.map(item => item.description), ['Zebra peça', 'Alfa serviço']);
  const detailed = documentPrintModel(record(), null, { detailed: true, order: 'alphabetical' });
  assert.deepEqual(detailed.items.map(item => [item.position, item.description, item.listPrice]), [[2, 'Alfa serviço', null], [1, 'Zebra peça', 'R$ 10,00']]);
  assert.deepEqual(documentPrintModel(record(), null, { order: 'code' }).items.map(item => item.code), ['A-1', 'B-2']);
});

test('comprovante shows the non-fiscal notice, items, totals and installments; 80 mm uses the narrow sheet', async () => {
  let model; try { model = documentPrintModel(record(), company); } catch (error) { model = documentPrintModel(record()); }
  const a4 = await mountComponent('DocumentPrintPreview.tsx', { model, format: 'a4' }, { componentName: 'DocumentReceiptSheet' });
  try {
    assert.match(a4.text(), /Comprovante de venda.*Não é documento fiscal.*Pedido de venda nº 105.*Cliente: Cliente Comprovante.*Zebra peça.*2 UN × R\$ 9,50.*R\$ 19,00.*Total do documento.*R\$ 154,00.*1\. 20\/11\/2026 · R\$ 77,00 · Boleto/s);
    assert.equal(a4.nodes()[0].props.className, 'commercial-sheet commercial-receipt');
  } finally { a4.unmount(); }
  const narrow = await mountComponent('DocumentPrintPreview.tsx', { model, format: '80mm' }, { componentName: 'DocumentReceiptSheet' });
  try { assert.match(narrow.nodes()[0].props.className, /commercial-receipt-80/); } finally { narrow.unmount(); }
});

test('carnê prints one slip per planned installment and explains when there is none', async () => {
  const model = documentPrintModel(record());
  const view = await mountComponent('DocumentPrintPreview.tsx', { model }, { componentName: 'DocumentCarneSheet' });
  try {
    assert.equal(view.nodes().filter(n => n.type === 'section' && n.props.className === 'commercial-carne-slip').length, 2);
    assert.match(view.text(), /Parcela 1\/2.*Vencimento: 20\/11\/2026.*Valor: R\$ 77,00.*sem código de barras e sem valor de boleto/s);
  } finally { view.unmount(); }
  const empty = await mountComponent('DocumentPrintPreview.tsx', { model: documentPrintModel(record({ installments: [] })) }, { componentName: 'DocumentCarneSheet' });
  try { assert.match(empty.text(), /não tem parcelas/); } finally { empty.unmount(); }
});

test('Endereços selecionados and Etiquetas use the delivery or contact address and never run formulas', () => {
  const rows = [{ number: '7', contact_name: '=Cliente', address: 'Rua 1 - Centro', contact_email: 'a@b.invalid', contact_phone: null }, { number: '8', contact_name: 'Sem endereço', address: null }];
  const csv = addressesCsv('sales_orders', rows);
  assert.equal(csv, '﻿"Número";"Cliente";"Endereço";"E-mail";"Telefone"\r\n"7";"\'=Cliente";"Rua 1 - Centro";"a@b.invalid";""\r\n"8";"Sem endereço";"";"";""\r\n');
  const labels = addressLabels('sales_orders', rows);
  assert.deepEqual(labels[1], { name: 'Sem endereço', address: null, reference: 'Pedido 8' });
  const sheets = labelSheets(Array.from({ length: 11 }, () => labels[0]), '2x5');
  assert.deepEqual([sheets.length, sheets[0].length, sheets[1].filter(Boolean).length, sheets[1].at(-1)], [2, 10, 1, null]);
});
