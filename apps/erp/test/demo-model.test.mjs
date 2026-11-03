import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortRecords, proposalToOrder, csvForRecords, localCalendarDate, effectiveDateField } from '../src/lib/demo-model.ts';

const module = {
  id: 'vendas', columns: [{ key: 'number' }, { key: 'customer' }, { key: 'total', type: 'money' }],
  filters: [{ key: 'status', options: ['Em aberto', 'Atendido'] }], dateField: 'date',
};
const rows = [
  { id: '1', number: '2', customer: 'Cliente Árvore', total: 20, date: '2026-10-10', status: 'Em aberto' },
  { id: '2', number: '10', customer: 'Cliente Árvore', total: 9, date: '2026-10-12', status: 'Atendido' },
  { id: '3', number: '3', customer: 'Outro cliente', total: 40, date: '2026-10-15', status: 'Em aberto' },
];

test('search, dates and exact filters compose while numeric sorting preserves the source array', () => {
  const params = new URLSearchParams({ q: 'arvore', 'filter.status': 'Em aberto', from: '2026-10-01', to: '2026-10-11', sort: 'total', direction: 'desc' });
  assert.deepEqual(filterAndSortRecords(rows, module, params).map(row => row.id), ['1']);
  assert.deepEqual(filterAndSortRecords(rows, module, new URLSearchParams({ sort: 'total' })).map(row => row.id), ['2', '1', '3']);
  assert.deepEqual(rows.map(row => row.id), ['1', '2', '3']);
});

test('latest products is a date ordering rather than a nonexistent status', () => {
  assert.deepEqual(filterAndSortRecords(rows, { ...module, id: 'produtos' }, new URLSearchParams({ 'filter.status': 'Últimos Incluídos' })).map(row => row.id), ['3', '2', '1']);
});

test('search also finds configured fields omitted from the table', () => {
  const contacts = { ...module, fields: [{ key: 'email' }, { key: 'document' }] };
  const rows = [{ id: 'demo', customer: 'Contato fictício', email: 'teste@example.invalid', document: 'DEMO123' }];
  assert.equal(filterAndSortRecords(rows, contacts, new URLSearchParams({ q: 'example.invalid' })).length, 1);
  assert.equal(filterAndSortRecords(rows, contacts, new URLSearchParams({ q: 'DEMO123' })).length, 1);
});

test('local day uses São Paulo and receipt filters select the payment date', () => {
  assert.equal(localCalendarDate(new Date('2026-10-16T01:00:00Z')), '2026-10-15');
  assert.equal(effectiveDateField({ ...module, id: 'contas-receber' }, new URLSearchParams({ 'filter.option': 'Recebidas' })), 'paymentDate');
});

test('financial options use outstanding balance and due dates instead of stale fixture labels', () => {
  const finance = { ...module, id: 'contas-receber', filters: [{ key: 'option' }], dateField: 'dueDate' };
  const titles = [
    { id: '1', date: '2026-10-01', dueDate: '2026-10-10', balance: 100, status: 'Em aberto', option: 'Emitidas' },
    { id: '2', date: '2026-10-02', dueDate: '2026-10-10', balance: 0, status: 'Recebido', option: 'Atrasadas' },
    { id: '3', date: '2026-10-03', dueDate: '2026-10-20', balance: 30, status: 'Parcialmente recebido' },
  ];
  assert.deepEqual(filterAndSortRecords(titles, finance, new URLSearchParams({ 'filter.option': 'Atrasadas' }), '2026-10-16').map(row => row.id), ['1']);
  assert.equal(filterAndSortRecords(titles, finance, new URLSearchParams({ 'filter.option': 'Em aberto' }), '2026-10-16').length, 2);
  assert.deepEqual(filterAndSortRecords(titles, finance, new URLSearchParams({ 'filter.option': 'Emitidas', from: '2026-10-01', to: '2026-10-01' }), '2026-10-16').map(row => row.id), ['1']);
});

test('proposal conversion preserves its content and reopens the same local order on repetition', () => {
  const proposal = { id: 'proposal-1', number: 'ORC-101', customer: 'Cliente fictício', total: 128.55, notes: 'Somente demonstração', _items: '[{"quantity":1}]' };
  const first = proposalToOrder(proposal, [], 'order-1', '2026-10-16');
  assert.equal(first.created, true);
  assert.equal(first.record.originId, proposal.id);
  assert.equal(first.record.total, proposal.total);
  assert.equal(first.record._items, proposal._items);
  assert.equal(first.record.stockStatus, 'Não lançado');
  assert.equal(first.record.financialStatus, 'Não lançado');
  assert.equal(first.record.fiscalStatus, 'Não emitida');
  const repeated = proposalToOrder(proposal, [first.record], 'order-2', '2026-10-17');
  assert.equal(repeated.created, false);
  assert.equal(repeated.record.id, 'order-1');
  assert.equal(proposal.number, 'ORC-101');
});

test('CSV export quotes delimiters and neutralizes spreadsheet formulas', () => {
  const output = csvForRecords([{ id: '1', name: '=1+1', note: 'Texto; "entre aspas"' }], [{ key: 'name', label: 'Nome' }, { key: 'note', label: 'Observação' }]);
  assert.match(output, /"'=1\+1"/);
  assert.match(output, /"Texto; ""entre aspas"""/);
  assert.ok(output.startsWith('\uFEFF'));
  for (const name of ['  =1+1', '\n=1+1', '\ttexto', '\ntexto', '  @SUM(1)']) {
    assert.ok(csvForRecords([{ id: 'demo', name }], [{ key: 'name', label: 'Nome' }]).split('\r\n')[1].startsWith('"\''));
  }
});
test('document tabs and explicit search keys compose without losing URL filters', () => {
  const module = { id: 'notas-entrada', columns: [{ key: 'number' }], fields: [], listTabs: { key: 'entryKind', options: ['Notas de compra', 'Notas recebidas'] }, searchKeys: ['customerEmail'] };
  const records = [
    { id: '1', number: '1', entryKind: 'Notas de compra', customerEmail: 'cliente@example.invalid' },
    { id: '2', number: '2', entryKind: 'Notas recebidas', customerEmail: 'cliente@example.invalid' },
  ];
  assert.deepEqual(filterAndSortRecords(records, module, new URLSearchParams('q=example.invalid')).map(row => row.id), ['1']);
  assert.deepEqual(filterAndSortRecords(records, module, new URLSearchParams({ q: 'example.invalid', 'tab.entryKind': 'Notas recebidas' })).map(row => row.id), ['2']);
});
