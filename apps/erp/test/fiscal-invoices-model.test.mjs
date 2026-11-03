import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREENS, deletePlan, emptyFilters, filterChips, fiscalListQuery, invoiceNumber, rowActions, statusClass, statusLabel, orderIndicator } from '../src/lib/fiscal-invoice-list-model.ts';
import { cloneDraft, complementaryDraft, draftToInput, installmentsFromCondition, newDraft, checkDraft, itemTabs, recordToDraft } from '../src/lib/fiscal-invoice-form-model.ts';
import { normalizeInvoiceInput, invoiceTotals } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// Pure rules of the Origin invoice screens (synthetic data only).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over = {}) => ({ origin: 'brufap', id: id(1), version: 1, number: null, series: 1, issue_date: '2026-10-20', entry_date: null, name: 'Cliente', document: null, state: 'SP', nature: 'Venda',
  status: 1, status_raw: null, total: '10.00', total_known: true, environment: '2', issue_type: 'N', access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0, orders: [], ...over });
const labels = (actions) => actions.map(a => `${a.label}${a.enabled ? '' : ' (x)'}`);

test('query parameters follow the API contract and refuse invalid filters before the network', () => {
  const nfe = SCREENS.nfe, entry = SCREENS.entrada, filters = emptyFilters(entry);
  assert.equal(fiscalListQuery(nfe, 'origin', emptyFilters(nfe)).toString(), 'model=55&page=1');
  assert.equal(fiscalListQuery(SCREENS.nfce, 'origin', emptyFilters(SCREENS.nfce), { page: 2, order: 'number_asc' }).toString(), 'model=65&page=2&order=number_asc');
  assert.equal(filters.dateType, 'entry');
  assert.equal(fiscalListQuery(entry, 'brufap', { ...filters, from: '2026-10-01', to: '2026-10-31', custom: { person_type: 'F', series: '2', document: '123.456' } }).toString(),
    'model=55&direction=0&origin=brufap&page=1&date_type=entry&date_from=2026-10-01&date_to=2026-10-31&person_type=F&document=123.456&series=2');
  for (const bad of [{ query: 'x'.repeat(121) }, { from: '2026-02-30' }, { from: '2026-10-02', to: '2026-10-01' }, { status: 'registered' }, { state: 'XX' }, { custom: { person_type: 'Z' } }, { custom: { series: '1000' } }])
    assert.throws(() => fiscalListQuery(nfe, 'origin', { ...emptyFilters(nfe), ...bad }), Error, JSON.stringify(bad));
  assert.deepEqual(filterChips(entry, { ...filters, status: 'registered', custom: { person_type: 'J', nature: ' Compra ' } }).map(c => c.label), ['Situação: Registradas', 'Natureza: Compra', 'Tipo da Pessoa: Jurídica']);
});

test('situação labels, tones and six-digit numbers like Origin; NFC-e shows Emitida', () => {
  assert.equal(invoiceNumber({ number: 42 }), '000042'); assert.equal(invoiceNumber({ number: null }), '—');
  assert.equal(statusLabel({ status: 6, status_raw: '5' }, '55'), 'Autorizada'); assert.equal(statusLabel({ status: 7, status_raw: null }, '65'), 'Emitida');
  assert.equal(statusLabel({ status: null, status_raw: '99' }, '55'), 'Situação 99 do Origin');
  assert.equal(statusClass({ status: 6 }, '55'), 'status-badge status-success is-bold'); assert.equal(statusClass({ status: 10 }, '55'), 'status-badge status-overdue');
  assert.equal(statusClass({ status: 3 }, '55'), 'status-badge status-warning is-bold'); assert.equal(statusClass({ status: 8 }, '55'), 'status-badge status-info');
  assert.equal(orderIndicator(row({ orders: [{ id: id(5), kind: 'sales_orders', number: '15', date: '2026-10-19', contact_name: 'Cliente' }] })).title, 'Número pedido: 15 - Data: 19/10/2026 - Cliente: Cliente');
});

test('⋮ rules per situation: Origin hides Enviar and Cancelar while waiting and blocks effects on cancelled notes', () => {
  const nfe = SCREENS.nfe;
  const pending = labels(rowActions(nfe, row(), { writable: true }));
  assert.deepEqual(pending.slice(0, 3), ['Editar', 'Enviar nota fiscal (x)', 'Outras opções de NF-e']);
  assert.ok(pending.includes('Clonar nota') && pending.includes('Imprimir espelho NF') && pending.includes('Lançar contas (x)'));
  const waiting = labels(rowActions(nfe, row({ status: 4 }), { writable: true }));
  assert.equal(waiting.some(l => l.startsWith('Enviar')), false); assert.ok(waiting.includes('Consultar recibo (x)'));
  const authorized = rowActions(nfe, row({ status: 6, access_key: '3'.repeat(44) }), { writable: true });
  assert.equal(authorized.find(a => a.label === 'Cancelar NF-e').enabled, true); assert.equal(authorized.find(a => a.label === 'Carta de correção').enabled, true);
  assert.equal(authorized.find(a => a.label === 'NFe complementar').enabled, true);
  const cancelled = rowActions(nfe, row({ status: 3 }), { writable: true });
  assert.match(cancelled.find(a => a.label === 'Lançar contas').reason, /cancelada ou denegada/); assert.equal(cancelled.some(a => a.label === 'Cancelar NF-e'), false);
  const origin = rowActions(nfe, row({ origin: 'origin', id: '9001', version: null, environment: '1', issue_type: null, status: 6 }), { writable: true });
  assert.equal(origin[0].label, 'Visualizar'); assert.match(origin.find(a => a.label === 'Cancelar NF-e').reason, /convivência/); assert.equal(origin.find(a => a.label === 'Imprimir espelho NF').enabled, false);
  const nfce = labels(rowActions(SCREENS.nfce, row({ status: 1 }), { writable: false }));
  assert.ok(nfce.includes('Autorizar NFC-e (x)') && nfce.includes('Gerar NF-e (x)') && nfce.includes('Exportar XML (x)'));
  assert.equal(nfce.some(l => l.startsWith('Carta de correção')), false, 'CC-e is NF-e only');
  const plan = deletePlan([row(), row({ origin: 'origin', id: '9001' })]);
  assert.deepEqual([plan.eligible.length, plan.skipped[0].message], [1, 'Nota do Origin: a exclusão continua no Origin.']);
});

test('draft conversion: decimal comma, empty fields dropped, homologation numbering and clones without number or key', () => {
  const draft = newDraft({ model: '55', direction: '1' }, { company: { crt: '1', state: 'SP' }, series: [{ series: 2, next_number: 10, enabled: true }], defaults: { S: { id: id(9), description: 'Venda' } } }, '2026-10-20');
  assert.deepEqual([draft.series, draft.nature_id, draft.presence, draft.transport.freight_by], ['2', id(9), '1', '9']);
  draft.recipient = { name: 'Cliente', person_type: 'F', document: '98765432100' }; draft.freight = '1,5';
  draft.items = [{ description: 'Item', quantity: '2,5', unit_price: '3', icms: { situation: '102', base: '' }, ipi: {} }];
  const input = draftToInput(draft);
  assert.deepEqual(input.items[0], { description: 'Item', quantity: '2.5', unit_price: '3', icms: { situation: '102' } }); assert.equal(input.freight, '1.5'); assert.equal(input.number, null);
  const checked = checkDraft(draft); assert.ok('input' in checked); assert.equal(checked.totals.totals.total, '9.00');
  assert.deepEqual(checkDraft({ ...draft, items: [] }), { error: 'Inclua pelo menos um item na nota.' });
  const normalized = normalizeInvoiceInput({ ...input, issue_type: 'T', number: '15', access_key: null }), totals = invoiceTotals(normalized);
  const record = { ...normalized, id: id(1), version: 3, status: 8, environment: null, series: 2, number: 15, protocol: null, authorized_at: null, nature_description: 'Venda',
    items: normalized.items.map((it, i) => ({ ...it, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: '0.00', other_expenses: '0.00', discount: '0.00' } })), totals: totals.totals,
    orders: [{ id: id(3), kind: 'sales_orders', number: '7', date: null, contact_name: null }], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null };
  assert.equal(recordToDraft(record).number, '15');
  const clone = cloneDraft(record);
  assert.deepEqual([clone.number, clone.access_key, clone.issue_type, clone.orders.length], ['', '', 'N', 0], 'a clone is a new own note');
  const inverted = cloneDraft(record, { invert: true, context: { company: { crt: '1', state: 'SP' }, series: [], defaults: { E: { id: id(8), description: 'Compra' } } } });
  assert.deepEqual([inverted.direction, inverted.nature_id, inverted.presence], ['0', id(8), '9']);
  const complementary = complementaryDraft({ ...record, access_key: '3'.repeat(44) });
  assert.deepEqual([complementary.purpose, complementary.references], ['2', [{ type: 'nfe', key: '3'.repeat(44) }]]);
});

test('Gerar parcelas understands 30 60, 3x and 15 +2x with exact cents', () => {
  assert.deepEqual(installmentsFromCondition('30 60', 10000n, '2026-10-20'), [{ days: '30', date: '2026-11-19', amount: '50.00' }, { days: '60', date: '2026-12-19', amount: '50.00' }]);
  assert.deepEqual(installmentsFromCondition('3x', 10000n, '2026-10-20').map(i => i.amount), ['33.33', '33.33', '33.34']);
  assert.deepEqual(installmentsFromCondition('15 +2x', 1001n, '2026-10-20').map(i => [i.days, i.amount]), [['15', '3.33'], ['45', '3.33'], ['75', '3.35']]);
  for (const bad of ['', 'abc', '0x', '30 60 a']) assert.equal(installmentsFromCondition(bad, 100n, '2026-10-20'), null, bad);
  assert.equal(installmentsFromCondition('30', 0n, '2026-10-20'), null);
});

test('item tabs follow the Origin modal and filter CST lists by regime and direction', () => {
  const simples = itemTabs('1', '1'), normal = itemTabs('3', '0');
  assert.deepEqual(simples.map(t => t.label), ['Dados do item', 'ICMS', 'IPI', 'PIS', 'COFINS', 'Importação', 'Exportação', 'Combustível', 'Medicamento', 'Outros', 'Estoque', 'Retenções', 'Armamento', 'Veículo']);
  const situation = tabs => tabs.find(t => t.id === 'icms').sections[0].fields.find(f => f.key === 'situation');
  assert.equal(situation(simples).label, 'CSOSN'); assert.ok(situation(simples).options.some(([c]) => c === '101'));
  assert.equal(situation(normal).label, 'Situação tributária do ICMS'); assert.equal(situation(normal).options.some(([c]) => c === '101'), false);
  const ipi = tabs => tabs.find(t => t.id === 'ipi').sections[0].fields.find(f => f.key === 'situation').options.map(([c]) => c);
  assert.deepEqual(ipi(normal), ['00', '01', '02', '03', '04', '05', '49']); assert.deepEqual(ipi(simples), ['50', '51', '52', '53', '54', '55', '99']);
  assert.deepEqual(simples.find(t => t.id === 'icms').sections.map(s => s.title), ['Geral', 'Substituição tributária', 'Substituição tributária - Retenção', 'Partilha']);
});
