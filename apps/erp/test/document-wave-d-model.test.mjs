import test from 'node:test';
import assert from 'node:assert/strict';
import { documentRowActions, listIndicators } from '../src/lib/document-list-model.ts';

// Wave D of the documentos lane (synthetic rows): the OS with a nota fiscal (202610200198).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over = {}) => ({ id: id(1), kind: 'service_orders', number: '7', version: 3, status: 'open', date: '2026-10-16', total: '10.00', contact_id: id(9), contact_name: 'Cliente sintético', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z',
  expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false,
  reservation_active: null, fiscal_draft: null, internal_notes: null, invoice: null, pendencies: false, service_order_number: null, template_name: null, invoice_linked: false, ...over });

test('OS: the nota fiscal linked gives the letter N and removes Gerar nota fiscal', () => {
  const actions = r => documentRowActions('service_orders', r, { role: 'admin', writable: true }).map(action => action.action);
  assert.ok(actions(row()).includes('fiscal55'));
  assert.equal(actions(row({ invoice_linked: true })).includes('fiscal55'), false);
  assert.equal(actions(row({ invoice: { model: '55', number: '9', series: '1', issue_date: '2026-10-20', authorized: true }, invoice_linked: true })).includes('fiscal55'), false);
  assert.deepEqual(listIndicators(row({ invoice_linked: true })).map(item => [item.key, item.title]), [['N', 'Ordem de serviço com nota fiscal vinculada']]);
  assert.match(listIndicators(row({ invoice: { model: '55', number: '9', series: '1', issue_date: '2026-10-20', authorized: true }, invoice_linked: true }))[0].title, /^Origem NF 9 - Data: 20\/10\/2026$/);
});

test('Garantia até follows Preferências › Serviços "Data base da garantia" (same rule as SQL 168)', async () => {
  const { warrantyUntil } = await import('../src/lib/document-preferences.ts');
  const os = { warranty_days: '30', date: '2026-10-01', expected_date: '2026-10-05', finish_date: null, ship_date: '2026-10-10' };
  assert.equal(warrantyUntil(os, 'nao_utilizar'), null);
  assert.equal(warrantyUntil(os, 'data_os'), '2026-10-31');
  assert.equal(warrantyUntil(os, 'data_prevista'), '2026-11-04');
  assert.equal(warrantyUntil(os, 'data_conclusao'), '2026-10-31', 'without conclusão, the date of the OS');
  assert.equal(warrantyUntil(os, 'data_saida'), '2026-11-09');
  assert.equal(warrantyUntil({ ...os, warranty_days: null }, 'data_os'), null);
});

test('casas decimais do peso: exact rounding for the display and typing limited to the places', async () => {
  const { roundedDecimal, limitedDecimal } = await import('../src/lib/document-decimals.ts');
  assert.deepEqual([roundedDecimal('12.345678', 3), roundedDecimal('9.9996', 3), roundedDecimal('0.0004', 3), roundedDecimal('2.5', 0), roundedDecimal('7', 2)], ['12.346', '10', '0', '3', '7']);
  assert.deepEqual([limitedDecimal('1,2345', 2), limitedDecimal('1.2', 3), limitedDecimal('7.1', 0), limitedDecimal('8', 1)], ['1,23', '1.2', '7', '8']);
});
