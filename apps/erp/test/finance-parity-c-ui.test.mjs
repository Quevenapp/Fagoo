import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';
import { openTitles } from '../src/lib/finance-open-titles.ts';

// Synthetic data only. 172: Ficha financeira paginada e o painel de contas em aberto do contato nos pedidos.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', CONTACT = id(50), OTHER = id(51);
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()), YEAR = TODAY.slice(0, 4);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const role = state => ({ phase: 'ready', membership: { user_id: actor, role: state } });
const line = n => ({ day: `${YEAR}-03-05`, line_kind: 'entry', ref_id: id(1000 + n), kind: 'receivable', note: `Lançamento ${n}`, due_on: null, side: 'credit', amount_cents: '100', situation: null, origin: null, version: 1 });

test('172 Ficha financeira reads 100 lines per page, keeps the totals of the whole period and pages with the URL', async () => {
  const calls = [];
  const controller = { getSnapshot: () => role('consulta'), subscribe: () => () => {}, retry() {}, async catalog() { return {}; },
    async finance(path) {
      calls.push(path);
      if (path === '/v1/financeiro') return { read: true, write: false, data_mode: 'erp_native' };
      const url = new URL(path, 'https://synthetic.invalid'), page = Number(url.searchParams.get('page'));
      if (url.pathname === '/v1/financeiro/ficha') return { entity: 'contact_ledger', contact_id: url.searchParams.get('contact'), contact_name: 'Alfa Sintética', scope: 'all', from: url.searchParams.get('from'), to: url.searchParams.get('to'),
        page, limit: 100, total: 130, items: Array.from({ length: page === 1 ? 100 : 30 }, (_, index) => line((page - 1) * 100 + index)), totals: { debit_cents: '0', credit_cents: '13000', balance_cents: '13000' }, data_mode: 'erp_native' };
      throw new Error(path);
    } };
  const view = await mountComponent('FinanceContactLedger.tsx', { controller }, { location: `/financeiro-empresa?area=ficha&contato=${CONTACT}`, expandChildren: ['BusyGuard'] });
  try {
    await settle(view);
    const first = calls.find(path => path.startsWith('/v1/financeiro/ficha'));
    assert.equal(first, `/v1/financeiro/ficha?contact=${CONTACT}&scope=all&from=${YEAR}-01-01&to=${YEAR}-12-31&page=1&limit=100`);
    assert.equal((await parseFinanceRoute(new Request(`https://api.example.test${first}`))).rpc, 'erp_finance_contact_ledger_page', 'the Worker sends a paged ficha to SQL 172');
    assert.match(view.text(), /Créditos: R\$ 130,00/); assert.match(view.text(), /130 lançamentos, 100 por página/);
    const pagination = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'OriginPagination');
    assert.deepEqual([pagination.props.page, pagination.props.pages, pagination.props.total], [1, 2, 130]);
    pagination.props.onPage(2); await settle(view);
    assert.equal(view.location().search, `?area=ficha&contato=${CONTACT}&pagina=2`);
    assert.equal(calls.filter(path => path.startsWith('/v1/financeiro/ficha')).at(-1), `/v1/financeiro/ficha?contact=${CONTACT}&scope=all&from=${YEAR}-01-01&to=${YEAR}-12-31&page=2&limit=100`);
    assert.match(view.text(), /Lançamento 129/);
  } finally { view.unmount(); }
});

test('172 contas em aberto do contato: summary, list on demand, hidden without access and never the answer of another contato', async () => {
  const answer = (contact, kind) => ({ entity: 'contact_open_titles', contact_id: contact, kind, total: 2, balance_cents: '5000', overdue: 1, overdue_cents: '2000',
    items: [{ id: id(60), description: 'Pedido de venda nº 7 1/2', due_on: '2020-02-01', amount_cents: '2000', balance_cents: '2000', overdue: true }, { id: id(61), description: 'Pedido de venda nº 7 2/2', due_on: '2099-01-01', amount_cents: '3000', balance_cents: '3000', overdue: false }], data_mode: 'erp_native' });
  assert.throws(() => openTitles({ ...answer(CONTACT, 'receivable'), contact_id: OTHER }, CONTACT, 'receivable'), /Não foi possível/);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const controller = { getSnapshot: () => role('vendas'), async finance(path) { calls.push(path); const url = new URL(path, 'https://x.invalid'); if (url.searchParams.get('contact') === OTHER) { await gate; } return answer(url.searchParams.get('contact'), url.searchParams.get('kind')); } };
  const view = await mountComponent('FinanceContactOpenTitles.tsx', { controller, contactId: CONTACT, kind: 'receivable' });
  try {
    await settle(view);
    assert.equal(calls[0], `/v1/financeiro/contato-em-aberto?contact=${CONTACT}&kind=receivable`);
    await parseFinanceRoute(new Request(`https://api.example.test${calls[0]}`));
    assert.match(view.text(), /Contas a receber em aberto do cliente/); assert.match(view.text(), /2 contas em aberto · R\$ 50,00 · 1 atrasada \(R\$ 20,00\)/);
    assert.doesNotMatch(view.text(), /Pedido de venda nº 7 1\/2/); await view.click('Ver contas'); assert.match(view.text(), /Pedido de venda nº 7 1\/2/);
    assert.equal(view.nodes().some(node => node.type === 'test-router-link'), false, 'vendas reads the contas without the links of the financeiro');
    await view.updateProps({ contactId: OTHER }); release(); await settle(view);
    assert.equal(calls.at(-1), `/v1/financeiro/contato-em-aberto?contact=${OTHER}&kind=receivable`);
  } finally { view.unmount(); }
  const denied = await mountComponent('FinanceContactOpenTitles.tsx', { controller: { getSnapshot: () => role('vendas'), async finance() { throw new AccessError(403); } }, contactId: CONTACT, kind: 'payable' });
  try { await settle(denied); assert.equal(denied.text(), '', 'without the preference the panel does not show'); } finally { denied.unmount(); }
  // A role change in the same session hides what the previous role read and asks the server again.
  let snapshot = role('financeiro'); const listeners = new Set(), asked = [];
  const switching = { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async finance(path) { asked.push(snapshot.membership.role); if (snapshot.membership.role === 'vendas') throw new AccessError(403); return answer(CONTACT, 'receivable'); } };
  const changed = await mountComponent('FinanceContactOpenTitles.tsx', { controller: switching, contactId: CONTACT, kind: 'receivable' });
  try {
    await settle(changed); assert.match(changed.text(), /2 contas em aberto/);
    snapshot = role('vendas'); for (const listener of listeners) listener(); await settle(changed);
    assert.deepEqual(asked, ['financeiro', 'vendas']); assert.equal(changed.text(), '', 'the vendas profile without the preference no longer sees the contas read by the financeiro');
  } finally { changed.unmount(); }
});
