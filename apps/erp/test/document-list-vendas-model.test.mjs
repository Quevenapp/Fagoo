import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_COLORS, readableText, statusPresentation } from '../src/lib/document-status-colors.ts';
import { documentRowActions } from '../src/lib/document-list-model.ts';
import { LIST_READ_MAX_ROWS, ListReadError, csvMoney, documentListCsv, listFileName, mergeListPages, printMoneyText } from '../src/lib/document-list-export.ts';
import { whatsappMessage, whatsappPhone, whatsappUrl, WHATSAPP_ITEM_LIMIT } from '../src/lib/document-whatsapp.ts';
import { calendarCells, calendarHeading, CALENDAR_UP } from '../src/lib/origin-list.ts';

// Wave 2 of the vendas lane: Origin colors, seller visibility, list export, WhatsApp and the datepicker views. Synthetic data only.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, over = {}) => ({ id: id(n), kind: 'sales_orders', number: String(n), version: 1, status: 'open', date: '2026-10-16', total: '10.00', contact_id: id(900), contact_name: 'Cliente sintético', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, ...over });
const page = (number, items, over = {}) => ({ kind: 'sales_orders', items, limit: 100, page: number, order: 'date_desc', has_more: false, next_cursor: null, total_count: 3, total_amount: '30.00', data_mode: 'erp_native', operational_effects: false, ...over });

test('situação colors follow the Origin hex per document, with readable text and the OS dot', () => {
  assert.deepEqual(statusPresentation('sales_orders', 'open'), { mode: 'badge', background: '#E9DC40', text: '#1F2933' });
  assert.deepEqual(statusPresentation('sales_orders', 'in_progress'), { mode: 'badge', background: '#0065F9', text: '#FFFFFF' });
  assert.equal(statusPresentation('sales_orders', 'draft').background, '#FF66E3');
  assert.equal(statusPresentation('sales_orders', 'verified').background, '#85F39E');
  assert.deepEqual(statusPresentation('service_orders', 'quoted'), { mode: 'dot', color: '#FF0016' });
  assert.deepEqual(statusPresentation('sales_proposals', 'approved'), { mode: 'neutral' }, 'propostas keep the neutral badge');
  assert.deepEqual(statusPresentation('purchase_orders', 'open'), { mode: 'tone' });
  for (const colors of Object.values(STATUS_COLORS)) for (const color of Object.values(colors)) assert.match(readableText(color), /^#(1F2933|FFFFFF)$/);
  assert.throws(() => readableText('red'), /STATUS_COLOR_INVALID/);
});

test('the vendas profile does not see emission, stock and finance actions; Estornar letters are struck', () => {
  const labels = (role, over = {}, kind = 'sales_orders') => documentRowActions(kind, row(1, { kind, ...over }), { role, writable: role !== 'consulta' }).map(action => action.label);
  for (const hidden of ['Gerar nota fiscal', 'Gerar NFC-e', 'Lançar estoque', 'Lançar contas']) assert.equal(labels('vendas').includes(hidden), false, hidden);
  assert.ok(labels('vendas').includes('Clonar venda')); assert.ok(labels('vendas').includes('Enviar por WhatsApp'));
  assert.ok(labels('consulta').includes('Gerar nota fiscal'), 'other profiles still see the item disabled with its reason');
  assert.deepEqual(labels('vendas', { status: 'open' }, 'service_orders').filter(label => /contas|estoque/.test(label)), []);
  const posted = documentRowActions('sales_orders', row(1, { status: 'in_progress', stock_active: true, finance_active: true }), { role: 'admin', writable: true });
  assert.deepEqual(posted.filter(action => action.letter?.struck).map(action => action.label), ['Estornar estoque', 'Estornar contas']);
  assert.equal(documentRowActions('sales_orders', row(1), { role: 'admin', writable: true }).some(action => action.letter?.struck), false);
});

test('list pages merge only when every page describes the same filtered set', () => {
  const merged = mergeListPages('sales_orders', [page(1, [row(1), row(2)]), page(2, [row(3)])]);
  assert.deepEqual(merged.rows.map(item => item.id), [id(1), id(2), id(3)]); assert.equal(merged.total_amount, '30.00');
  assert.throws(() => mergeListPages('sales_orders', [page(1, [row(1), row(2)]), page(2, [row(3)], { total_count: 4 })]), /mudou durante a leitura/);
  assert.throws(() => mergeListPages('sales_orders', [page(1, [row(1), row(2)]), page(2, [row(2)])]), /mudou durante a leitura/);
  assert.throws(() => mergeListPages('sales_orders', [page(1, [row(1), row(2)]), page(3, [row(3)])]), /mudou durante a leitura/);
  assert.throws(() => mergeListPages('sales_orders', [page(1, [row(1)], { total_count: 2 })]), /mudou durante a leitura/, 'a missing row is not silently printed');
  assert.throws(() => mergeListPages('sales_orders', [page(1, [], { total_count: LIST_READ_MAX_ROWS + 1 })]), error => error instanceof ListReadError && /Refine os filtros/.test(error.message));
});

test('CSV keeps exact cents, Origin headers, a totals line and neutralizes formulas', () => {
  const snapshot = mergeListPages('sales_orders', [page(1, [row(1, { contact_name: '=HYPERLINK("x")', total: '1234567.89', expected_date: '2026-10-20' }), row(2, { status: 'cancelled', total: '0.01' }), row(3, { contact_name: 'Cliente "aspas"', total: '29.99' })], { total_amount: '1234597.89' })]);
  const csv = documentListCsv(snapshot), lines = csv.slice(1).split('\r\n');
  assert.equal(csv[0], '﻿'); assert.equal(lines.at(-1), '');
  assert.equal(lines[0], '"Número";"Data";"Data prevista";"Cliente";"Total (R$)";"Situação";"Origem";"ID Origin";"Observado em";"Cobertura"');
  assert.equal(lines[1], '"1";"16/10/2026";"20/10/2026";"\'=HYPERLINK(""x"")";"1234567,89";"Em aberto";"FAGOO";"";"";""');
  assert.equal(lines[2], '"2";"16/10/2026";"";"Cliente sintético";"0,01";"Cancelado";"FAGOO";"";"";""');
  assert.equal(lines[3], '"3";"16/10/2026";"";"Cliente ""aspas""";"29,99";"Em aberto";"FAGOO";"";"";""');
  assert.equal(lines[4], '"Quantidade de Vendas";"3";"Valor total";"1234597,89"');
  assert.equal(csvMoney('0.10'), '0,10'); assert.throws(() => csvMoney('1.5'), ListReadError);
  assert.equal(printMoneyText('1234567.89'), 'R$ 1.234.567,89');
  assert.equal(listFileName('sales_proposals', '2026-10-20'), 'propostas-comerciais-2026-10-20.csv');
  const proposals = documentListCsv({ kind: 'sales_proposals', rows: [row(1, { kind: 'sales_proposals', status: 'approved', next_contact: '2026-11-01', template: true })], total_count: 1, total_amount: '10.00' });
  assert.match(proposals, /"Número";"Data";"Próx\. Contato";"Cliente";"Valor";"Situação";"Origem";"ID Origin";"Observado em";"Cobertura"\r\n"1";"16\/10\/2026";"01\/11\/2026";"Cliente sintético";"10,00";"Aprovado \(modelo\)"/);
});

test('WhatsApp uses the contact mobile (or phone) with 55 and a summary in exact decimals', () => {
  assert.equal(whatsappPhone({ mobile: '(19) 99876-5432' }), '5519998765432');
  assert.equal(whatsappPhone({ mobile: '', phone: '019 3433-1234' }), '551934331234');
  assert.equal(whatsappPhone({ mobile: '+55 11 91234-5678' }), '5511912345678');
  for (const bad of [{}, { mobile: '1234' }, { mobile: '00 0000-0000' }, { phone: 12 }]) assert.equal(whatsappPhone(bad), null, JSON.stringify(bad));
  const items = Array.from({ length: WHATSAPP_ITEM_LIMIT + 2 }, (_, index) => ({ description: `Item ${index + 1}`, quantity: '1.500000', unit: 'KG', total: '10.05' }));
  const record = { kind: 'sales_orders', number: '1001', date: '2026-10-20', contact_snapshot: { id: id(900), name: 'Cliente sintético', mobile: '19998765432' }, items, totals: { total: '1234.50' } };
  const message = whatsappMessage(record);
  assert.match(message, /^Pedido de venda nº 1001\nData: 20\/10\/2026\nCliente: Cliente sintético\nItens:\n- Item 1 · 1,5 KG · R\$ 10,05\n/);
  assert.match(message, /… e mais 2 itens\nTotal: R\$ 1\.234,50$/);
  assert.equal(whatsappUrl(record), `https://wa.me/5519998765432?text=${encodeURIComponent(message)}`);
  assert.equal(whatsappUrl({ ...record, contact_snapshot: { id: id(900), name: 'Sem celular' } }), null);
  // 202610200129: the pedido de compra is sent to the supplier.
  assert.match(whatsappMessage({ ...record, kind: 'purchase_orders', items: [], contact_snapshot: { id: id(900), name: 'Fornecedor sintético' } }), /^Pedido de compra nº 1001\nData: 20\/10\/2026\nFornecedor: Fornecedor sintético\nTotal:/);
});

test('datepicker title climbs day → month → year → decade and each view lists its cells', () => {
  assert.equal(calendarHeading('days', 2026, 10), 'Outubro 2026'); assert.equal(calendarHeading('months', 2026, 10), '2026');
  assert.equal(calendarHeading('years', 2026, 10), '2020-2029'); assert.equal(calendarHeading('decades', 2026, 10), '2000-2099');
  assert.deepEqual([CALENDAR_UP.days, CALENDAR_UP.months, CALENDAR_UP.years, CALENDAR_UP.decades, CALENDAR_UP.centuries], ['months', 'years', 'decades', 'centuries', 'centuries']);
  // EST-009 (lane C): the century view, one more level up.
  assert.equal(calendarHeading('centuries', 2026, 10), '2000-2999');
  const centuries = calendarCells('centuries', 2026, 10);
  assert.deepEqual([centuries[0].label, centuries[1].label, centuries[11].label], ['1900', '2000', '3000']);
  assert.deepEqual(centuries.find(cell => cell.current), { label: '2000', year: 2026, month: 10, level: 'decades', outside: false, current: true });
  const months = calendarCells('months', 2026, 10);
  assert.deepEqual(months.map(cell => cell.label), ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']);
  assert.deepEqual(months.filter(cell => cell.current).map(cell => [cell.month, cell.level]), [[10, 'days']]);
  const years = calendarCells('years', 2026, 10);
  assert.deepEqual([years[0].label, years[1].label, years[11].label, years[0].outside, years[11].outside], ['2019', '2020', '2030', true, true]);
  assert.deepEqual(years.find(cell => cell.current), { label: '2026', year: 2026, month: 10, level: 'months', outside: false, current: true });
  const decades = calendarCells('decades', 2026, 10);
  assert.deepEqual([decades[0].label, decades[1].label, decades[11].label], ['1990', '2000', '2100']);
  assert.deepEqual(decades.find(cell => cell.current), { label: '2020', year: 2026, month: 10, level: 'years', outside: false, current: true });
});
