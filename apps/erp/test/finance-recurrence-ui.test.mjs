import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';
import { generateSkip, recurrenceApiPath, recurrencePage, recurrenceParams, recurrenceRoute, recurrenceSchedule } from '../src/lib/finance-recurrence-model.ts';
import { importRows, importTemplates, sheetCents, sheetDate } from '../src/lib/finance-records-import.ts';
import { parseCsv } from '../src/lib/finance-sheet-import.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 138: Ocorrência recorrente na gaveta, "Alterar contas em aberto", Contas recorrentes e Importação.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', CONTACT = id(800), REC = id(700), OTHER = id(701), DONE = id(702);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
const lastButton = async (view, label) => { const found = buttons(view, label).at(-1); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 4, group_id: id(9000), installment: 1, installments: 1, contact_id: CONTACT, contact_name: 'Cliente sintético', category_id: null, category_name: null, description: `Aluguel ${n}`, source_reference: null, issued_on: '2026-10-01', due_on: '2026-11-10', amount_cents: '10000', settled_cents: '0', balance_cents: '10000', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null,
  competence_on: '2026-10-01', account_id: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-11-10', deleted_at: null, recurrence_id: null, ...extra });
const recurrence = (recordId, extra = {}) => ({ id: recordId, kind: 'receivable', contact_id: CONTACT, contact_name: 'Cliente sintético', category_id: null, category_name: null, account_id: null, description: 'Aluguel', amount_cents: '10000', frequency: 'monthly', due_day: 10, second_day: null, weekday: null,
  business_days: false, end_on: null, next_on: '2026-12-10', generated: 1, active: true, open_titles: 1, version: 7, created_at: '2026-10-20T12:00:00Z', ...extra });
const role = state => ({ phase: 'ready', membership: { user_id: actor, role: state } });

function server({ post = () => { throw new Error('no post'); }, recurrences = [recurrence(REC), recurrence(OTHER, { description: 'Mensalidade', frequency: 'weekly', due_day: null, weekday: 1 }), recurrence(DONE, { description: 'Contrato encerrado', end_on: '2026-11-30', next_on: null })], session = role('financeiro'), permitted } = {}) {
  const calls = [], state = { session }, listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts'], write: ['contacts'] }; return { entity: 'contacts', items: [], limit: 10, has_more: false, next_cursor: null, data_mode: 'erp_native' }; },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') return { read: true, write: state.session.membership.role !== 'consulta', ...(permitted ? { permitted } : {}), data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call, calls.filter(item => item.method === 'POST' && item.path === path).length);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [] };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      if (url.pathname === `/v1/financeiro/recorrentes/${REC}`) return { entity: 'recurrences', record: recurrence(REC), data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/recorrentes') { const active = url.searchParams.get('situacao') === 'todas' ? null : url.searchParams.get('situacao') === 'ativas'; const items = recurrences.filter(item => active === null || item.active === active);
        return { entity: 'recurrences', kind: url.searchParams.get('kind'), active, page: 1, limit: 100, total: items.length, items: structuredClone(items), data_mode: 'erp_native' }; }
      const detail = /^\/v1\/financeiro\/titles\/([^/]+)\/detalhe$/.exec(url.pathname);
      if (detail) return { entity: 'titles', data_mode: 'erp_native', record: title(40, { recurrence_id: REC }), origin: null, account: null, billing: null, imported: false, settled_before: false, original: null };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), setRole(next) { state.session = role(next); for (const listener of listeners) listener(); } };
}
const drawer = (source, props = {}) => {
  const events = { saved: [], closed: 0 };
  return mountComponent('FinanceTitleDrawer.tsx', { controller: source.controller, kind: 'receivable', mode: 'create', title: null, onClose: () => { events.closed++; }, onSaved: value => events.saved.push(value), ...props }, { expandChildren: ['DrawerField', 'CategoryTreePicker', 'TreeList', 'Modal'] }).then(view => Object.assign(view, { events }));
};
const created = call => ({ action: 'recurrence_create', replayed: false, entity: 'recurrences', record: recurrence(REC), title: title(41, { recurrence_id: REC, due_on: call.body.data.due_on }), data_mode: 'erp_native' });
async function fillHeader(view) {
  child(view, 'CatalogPicker').props.onSelect({ id: CONTACT, name: 'Cliente sintético' }); await view.flush();
  await view.change(field(view, 'Valor (R$) *').props.id, '100,00'); await view.change(field(view, 'Emissão *').props.id, '2026-10-20');
  await view.change(field(view, 'Competência *').props.id, '2026-10-01'); await view.change(field(view, 'Vencimento *').props.id, '2026-11-10');
  await view.change(field(view, 'Histórico').props.id, 'Aluguel sintético');
}

test('138 recurrence and import models: URL, Worker paths, schedule and the sheet lines', async () => {
  const route = recurrenceRoute(new URLSearchParams('area=recorrentes&tipo=P&situacao=inativas&q=Aluguel&pagina=2'));
  assert.deepEqual(route, { kind: 'payable', situacao: 'inativas', q: 'Aluguel', page: 2 });
  assert.equal(recurrenceParams(route).toString(), 'area=recorrentes&tipo=P&situacao=inativas&q=Aluguel&pagina=2');
  assert.equal(recurrenceParams({ ...route, situacao: 'ativas', q: '', page: 1 }).toString(), 'area=recorrentes&tipo=P', 'Ativas is the default');
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${recurrenceApiPath(route)}`));
  assert.deepEqual(parsed.args, { p_kind: 'payable', p_active: false, p_query: 'Aluguel', p_page: 2, p_limit: 100 });
  for (const bad of ['tipo=X', 'situacao=todos', 'pagina=0', 'extra=1']) assert.throws(() => recurrenceRoute(new URLSearchParams(bad)), /inválidos/, bad);
  assert.throws(() => recurrencePage({ entity: 'recurrences', kind: 'receivable', active: true, page: 1, limit: 100, total: 1, items: [recurrence(REC, { active: false, next_on: null })], data_mode: 'erp_native' }, { kind: 'receivable', situacao: 'ativas', q: '', page: 1 }), /Não foi possível/, 'an inactive one never shows under Ativas');
  assert.equal(recurrenceSchedule(recurrence(REC, { frequency: 'biweekly', due_day: 20, second_day: 5, business_days: true, end_on: '2027-06-30' }), value => value.split('-').reverse().join('/')), 'Quinzenal · dias 5 e 20 · dias úteis · até 30/06/2027');
  assert.equal(recurrenceSchedule(recurrence(REC, { frequency: 'weekly', due_day: null, weekday: 1 }), String), 'Semanal · segunda');
  assert.deepEqual([generateSkip(recurrence(REC)), generateSkip(recurrence(REC, { active: false, next_on: null })), generateSkip(recurrence(REC, { next_on: null }))], [null, 'Recorrência inativa.', 'A data limite da recorrência foi atingida.']);
  assert.deepEqual([sheetDate('1/7/2026'), sheetDate('2026-07-01'), sheetDate('31/02/2026'), sheetDate('ontem')], ['2026-07-01', '2026-07-01', '2026-02-31', 'ontem'], 'an impossible date goes as typed so the server reports the column');
  assert.deepEqual(['1.234,56', '1234,5', '1234.56', 'R$ 10', '-25,00', 'abc'].map(value => sheetCents(value).cents), ['123456', '123450', '123456', '1000', '2500', 'abc']);
  const cash = importRows('cash', parseCsv('Data;Competência;Tipo;Valor;Histórico;Contato;CPF/CNPJ;Categoria;Conta financeira\n05/07/2026;;Saída;25,00;Tarifa;;;Tarifas;Caixa sintético\n06/07/2026;;;-10,00;Ajuste;;;;Caixa sintético\n07/07/2026;;Transferência;5,00;Outro;;;;Caixa sintético\n'));
  assert.deepEqual(cash.map(row => [row.line, row.side ?? null, row.amount_cents]), [[2, 'out', '2500'], [3, 'out', '1000'], [4, null, '500']], 'a negative Valor without Tipo is a saída; an unknown Tipo is left for the server');
  const preview = await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/records_import_preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: id(1), data: { kind: 'cash', file_name: 'caixa.csv', rows: cash } }) }));
  assert.equal(preview.rpc, 'erp_finance_import_preview', 'the rows built by the ERP pass the strict Worker validation');
  assert.throws(() => importRows('receivable', [['Data de emissão'], ...Array.from({ length: 1001 }, () => ['01/07/2026'])]), /até 1\.000 registros/);
  const zip = new TextDecoder().decode(importTemplates());
  for (const name of ['contas-a-receber.csv', 'contas-a-pagar.csv', 'registros-de-caixa.csv', '"Data de emissão";"Vencimento"', '"Fornecedor"', '"Tipo"']) assert.ok(zip.includes(name), name);
});

test('138 drawer Mensal creates the recurrence with its first conta and "Conferir resultado"; Semanal follows the Dia da semana', async () => {
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return created(call); } });
  const view = await drawer(source);
  try {
    await fillHeader(view); await view.click('Ocorrência');
    await view.change(field(view, 'Ocorrência').props.id, 'mensal');
    assert.equal(buttons(view, 'Salvar e dar baixa').length, 0, 'a recurring conta is not settled from the drawer');
    assert.equal(field(view, 'Dia de vencimento *').props.value, '10', 'the day follows the vencimento');
    assert.match(view.text(), /Define uma data limite|Data limite/); assert.match(view.text(), /geradas em Gerenciar contas recorrentes/);
    await view.change(field(view, 'Data limite').props.id, '2027-06-30');
    view.find(node => node.type === 'input' && node.props.role === 'switch').props.onChange({ target: { checked: true } }); await view.flush();
    await view.submit(); await settle(view);
    assert.equal(source.posts().length, 1); assert.match(view.text(), /Use “Conferir resultado”/);
    await view.submit(); await settle(view);
    const [first, second] = source.posts();
    assert.equal(first.path, '/v1/financeiro/actions/recurrence_create'); assert.deepEqual(second.body, first.body, 'the same command_id and body are replayed');
    assert.deepEqual(first.body.data, { kind: 'receivable', contact_id: CONTACT, category_id: null, account_id: null, description: 'Aluguel sintético', source_reference: null, bank_number: null, issued_on: '2026-10-20', competence_on: '2026-10-01', due_on: '2026-11-10', amount_cents: '10000',
      interest_month_bp: 0, penalty_bp: 0, frequency: 'monthly', business_days: true, end_on: '2027-06-30', due_day: 10 });
    const parsed = await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/recurrence_create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first.body) }));
    assert.equal(parsed.rpc, 'erp_finance_recurrence_execute'); assert.deepEqual(view.events.saved, [undefined]);
  } finally { view.unmount(); }
  const weekly = server({ post: created });
  const second = await drawer(weekly);
  try {
    await fillHeader(second); await second.click('Ocorrência');
    await second.change(field(second, 'Ocorrência').props.id, 'quinzenal');
    assert.ok(field(second, 'Dia do 2º vencimento *'), 'Quinzenal asks the 2º vencimento');
    await second.change(field(second, 'Ocorrência').props.id, 'semanal');
    assert.equal(field(second, 'Dia da semana *').props.value, '2', '10/11/2026 is a Tuesday');
    assert.deepEqual(second.nodes().filter(node => node.type === 'option' && ['0', '5'].includes(node.props.value)).map(text), ['Domingo', 'Sexta']);
    await second.change(field(second, 'Dia da semana *').props.id, '5');
    await second.click('Cabeçalho'); assert.equal(field(second, 'Vencimento *').props.value, '2026-11-13', 'the vencimento moves to the next Friday');
    await second.submit(); await settle(second);
    const data = weekly.posts()[0].body.data;
    assert.deepEqual([data.frequency, data.weekday, data.due_on, Object.hasOwn(data, 'due_day')], ['weekly', 5, '2026-11-13', false]);
  } finally { second.unmount(); }
});

test('138 drawer edit of a recurring conta asks "Alterar contas em aberto" and recovers the second command without reading again', async () => {
  const recurring = title(40, { recurrence_id: REC });
  const edited = { entity: 'titles', action: 'title_edit', replayed: false, record: { ...recurring, version: 5, amount_cents: '12000', balance_cents: '12000' }, data_mode: 'erp_native' };
  const updated = call => ({ action: 'recurrence_update', replayed: false, entity: 'recurrences', record: recurrence(REC, { version: 8 }), updated_titles: 2, data_mode: 'erp_native', ...(call ? {} : {}) });
  const source = server({ post: (call, count) => { if (call.path.endsWith('/title_edit')) return edited; if (count === 1) throw new AccessError(503); return updated(call); } });
  const view = await drawer(source, { mode: 'edit', title: recurring });
  try {
    await settle(view);
    await view.change(field(view, 'Valor (R$) *').props.id, '120,00'); await view.submit(); await settle(view);
    assert.equal(source.posts().length, 0, 'nothing is sent before the choice');
    assert.match(view.text(), /Esta é uma conta recorrente\. O que deseja fazer com as contas em aberto vinculadas à esta\?/); assert.match(view.text(), /Vão para as outras contas: valor/);
    assert.equal(field(view, 'Atualizar todas as contas em aberto vinculadas').disabled, true, 'the scope waits for "Alterar contas em aberto."');
    await view.change(field(view, 'Alterar contas em aberto.').props.id, true);
    await view.change(field(view, 'Atualizar todas as contas em aberto vinculadas').props.id, true);
    await view.change(field(view, 'Alterar lançamentos de contas futuras.').props.id, true);
    await lastButton(view, 'Salvar'); await settle(view);
    const [edit, first] = source.posts();
    assert.deepEqual(edit.body.data, { id: recurring.id, expected_version: 4, amount_cents: '12000' });
    assert.deepEqual(first.body.data, { id: REC, from_title_id: recurring.id, scope: 'all', future: true, changes: { amount_cents: '12000' }, expected_version: 7 });
    assert.match(view.text(), /A conta foi salva\. Não foi possível confirmar a alteração das outras contas/); assert.equal(buttons(view, 'Fechar').length > 0, true);
    await view.submit(); await settle(view);
    const all = source.posts(); assert.equal(all.length, 3); assert.deepEqual(all[2].body, first.body, 'the same recurrence_update is replayed');
    assert.equal(source.calls.filter(call => call.path === `/v1/financeiro/recorrentes/${REC}`).length, 1, 'the version is read once');
    assert.deepEqual(view.events.saved, [undefined]);
  } finally { view.unmount(); }
  // A refusal of the second step keeps the saved conta and only offers Fechar; "Somente esta" sends only the conta.
  const refused = server({ post: call => { if (call.path.endsWith('/title_edit')) return edited; throw new AccessError(409); } });
  const again = await drawer(refused, { mode: 'edit', title: recurring });
  try {
    await settle(again);
    await again.change(field(again, 'Valor (R$) *').props.id, '120,00'); await again.submit(); await settle(again);
    await again.change(field(again, 'Alterar lançamentos de contas futuras.').props.id, true); await lastButton(again, 'Salvar'); await settle(again);
    assert.equal(refused.posts().at(-1).body.data.scope, 'none');
    assert.match(again.text(), /A conta foi salva, mas as outras contas da recorrência não foram alteradas: a recorrência mudou/);
    assert.equal(buttons(again, 'Conferir resultado').length, 0); await lastButton(again, 'Fechar'); assert.deepEqual(again.events.saved, [undefined]);
  } finally { again.unmount(); }
  const only = server({ post: () => edited });
  const single = await drawer(only, { mode: 'edit', title: recurring });
  try {
    await settle(single);
    await single.change(field(single, 'Valor (R$) *').props.id, '120,00'); await single.submit(); await settle(single); await lastButton(single, 'Salvar'); await settle(single);
    assert.deepEqual(only.posts().map(call => call.path), ['/v1/financeiro/actions/title_edit']); assert.equal(only.calls.some(call => call.path.startsWith('/v1/financeiro/recorrentes')), false);
  } finally { single.unmount(); }
});

const list = (source, location = '/financeiro-empresa?area=recorrentes&tipo=R') => mountComponent('FinanceRecurring.tsx', { controller: source.controller }, { location, expandChildren: ['BusyGuard', 'Modal', 'BatchDialog', 'NativeListLayout', 'AppliedChips'] });
test('138 Contas recorrentes lists the Origin columns, Inativar and Gerar contas with the skipped ones and "Conferir resultado"', async () => {
  let generateFailures = 1;
  const source = server({ post: (call) => {
    if (call.path.endsWith('/recurrence_set_active')) return { action: 'recurrence_set_active', replayed: false, entity: 'recurrences', record: recurrence(REC, { active: false, next_on: null, version: 8 }), data_mode: 'erp_native' };
    if (generateFailures-- > 0) throw new AccessError(503);
    return { action: 'recurrence_generate', replayed: false, entity: 'recurrences', record: recurrence(call.body.data.id, { version: 8, ...(call.body.data.id === OTHER ? { frequency: 'weekly', due_day: null, weekday: 1 } : {}) }), title: title(42, { due_on: '2026-12-10' }), data_mode: 'erp_native' };
  } });
  const view = await list(source); await settle(view);
  try {
    assert.equal(source.calls.find(call => call.path.startsWith('/v1/financeiro/recorrentes')).path, '/v1/financeiro/recorrentes?kind=receivable&situacao=ativas&page=1&limit=100');
    for (const label of ['Contato', 'Histórico', 'Categoria', 'Tipo recorrência']) assert.ok(view.nodes().some(node => node.type === 'th' && text(node) === label), label);
    assert.match(view.text(), /Situação: Ativas/); assert.match(view.text(), /Mensal/); assert.match(view.text(), /Semanal · segunda/); assert.match(view.text(), /As contas recorrentes nascem das contas com ocorrência diferente de Única/); assert.match(view.text(), /a Parcelada gera até atingir o nº de parcelas/);
    assert.equal(view.nodes().filter(node => node.type === 'tr').every(node => node.props.onClick === undefined), true, 'a row click opens nothing');
    assert.equal(buttons(view, 'Gerar contas')[0].disabled, true, 'Gerar contas waits for a selection');
    for (const label of ['Selecionar Cliente sintético · Aluguel', 'Selecionar Cliente sintético · Contrato encerrado']) view.find(node => node.type === 'input' && node.props['aria-label'] === label).props.onChange(); await view.flush();
    await view.click('Gerar contas');
    assert.match(view.text(), /A data limite da recorrência foi atingida\./); assert.match(view.text(), /vencimento 10\/12\/2026/);
    await lastButton(view, 'Gerar contas'); await settle(view);
    assert.equal(source.posts().length, 1); assert.deepEqual(source.posts()[0].body.data, { id: REC, expected_version: 7 });
    await lastButton(view, 'Fechar'); await settle(view);
    assert.match(view.text(), /1 recorrência de “Gerar contas” sem resultado confirmado/); assert.equal(view.guard().busy, true);
    await view.click('Conferir resultado'); await lastButton(view, 'Conferir resultado'); await settle(view);
    assert.deepEqual(source.posts()[1].body, source.posts()[0].body, 'the same command_id is replayed');
    await lastButton(view, 'Fechar'); await settle(view);
    assert.doesNotMatch(view.text(), /sem resultado confirmado/); assert.match(view.text(), /Conferir resultado: 1 concluído/);
    child(view, 'RowMenu').props.items[0].onClick(); await view.flush();
    assert.equal(child(view, 'RowMenu').props.items[0].label, 'Inativar'); assert.match(view.text(), /Nenhuma nova conta é gerada/);
    await lastButton(view, 'Confirmar'); await settle(view);
    assert.deepEqual(source.posts().at(-1).body.data, { id: REC, expected_version: 7, active: false }); assert.match(view.text(), /Recorrência inativada: Cliente sintético · Aluguel\./);
  } finally { view.unmount(); }
  const consulta = server({ session: role('consulta') });
  const read = await list(consulta, '/financeiro-empresa?area=recorrentes&tipo=P&situacao=todas'); await settle(read);
  try {
    assert.match(consulta.calls.find(call => call.path.startsWith('/v1/financeiro/recorrentes')).path, /kind=payable&situacao=todas/);
    assert.equal(buttons(read, 'Gerar contas').length, 0); assert.equal(read.nodes().some(node => node.type === 'input' && node.props.type === 'checkbox'), false); assert.equal(child(read, 'RowMenu'), undefined);
    assert.match(read.text(), /Somente consulta/);
  } finally { read.unmount(); }
});

const fileOf = (name, content) => ({ name, size: content.length, arrayBuffer: async () => new TextEncoder().encode(content).buffer });
const importer = (source, location = '/financeiro-empresa?area=importacao') => mountComponent('FinanceImport.tsx', { controller: source.controller }, { location, expandChildren: ['BusyGuard'] });
test('138 Importação de registros financeiros previews each line and imports only the new ones with "Conferir resultado"', async () => {
  let imports = 0;
  const source = server({ post: call => {
    if (call.path.endsWith('/records_import_preview')) return { entity: 'financial_import', kind: 'receivable', rows: [{ line: 2, status: 'new', errors: [] }, { line: 3, status: 'duplicate', errors: [] }, { line: 4, status: 'error', errors: ['vencimento', 'valor'] }], data_mode: 'erp_native' };
    if (imports++ === 0) throw new AccessError(503);
    return { action: 'records_import', replayed: true, entity: 'financial_import', kind: 'receivable', created: 1, skipped: 0, data_mode: 'erp_native' };
  } });
  const view = await importer(source); await settle(view);
  try {
    assert.equal(view.input('records-import-kind').props.value, 'receivable');
    assert.deepEqual(view.nodes().filter(node => node.type === 'option').map(text), ['Conta a Receber', 'Conta a Pagar', 'Registros de caixa']);
    assert.ok(buttons(view, 'tabela modelo').length === 1); assert.match(view.text(), /só insere registros novos/);
    const input = () => view.find(node => node.type === 'input' && node.props.type === 'file');
    await input().props.onChange({ target: { files: [fileOf('contas.xlsx', 'x')], value: '' } }); await settle(view);
    assert.match(view.text(), /Selecione um arquivo \.CSV/); assert.equal(source.posts().length, 0);
    const csv = 'Data de emissão;Vencimento;Competência;Valor;Histórico;Cliente;CPF/CNPJ;Categoria;Conta financeira;Nº documento\n01/07/2026;31/07/2026;;1.234,56;Venda A;Alfa;12.345.678/0001-90;Vendas;;N1\n02/07/2026;15/08/2026;01/07/2026;99,9;Venda B;Beta;;;;\n03/07/2026;31/02/2026;;abc;Venda C;Gama;;;;\n';
    await input().props.onChange({ target: { files: [fileOf('contas.csv', csv)], value: '' } }); await settle(view);
    const preview = source.posts()[0];
    assert.equal(preview.path, '/v1/financeiro/actions/records_import_preview');
    assert.deepEqual(preview.body.data.rows[0], { line: 2, amount_cents: '123456', description: 'Venda A', contact_document: '12.345.678/0001-90', category: 'Vendas', issued_on: '2026-07-01', due_on: '2026-07-31', contact_name: 'Alfa', document: 'N1' });
    assert.deepEqual([preview.body.data.rows[1].competence_on, preview.body.data.rows[2].due_on, preview.body.data.rows[2].amount_cents], ['2026-07-01', '2026-02-31', 'abc']);
    assert.equal((await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/records_import_preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preview.body) }))).rpc, 'erp_finance_import_preview');
    assert.match(view.text(), /1 registro novo · 1 já importado · 1 com erro/); assert.match(view.text(), /Vencimento, Valor/); assert.match(view.text(), /As linhas com erro não são importadas/);
    await view.click('Importar 1 registro novo'); await settle(view);
    assert.match(view.text(), /Use “Conferir resultado”/); assert.equal(view.guard().busy, true);
    await view.click('Conferir resultado'); await settle(view);
    const [, first, second] = source.posts();
    assert.equal(first.path, '/v1/financeiro/actions/records_import'); assert.deepEqual(second.body, first.body, 'the same command_id and lines are replayed');
    assert.deepEqual(first.body.data.rows.map(row => row.line), [2], 'only the new line is sent');
    assert.match(view.text(), /Importação concluída: 1 registro incluído\./);
  } finally { view.unmount(); }
  const cash = await importer(server(), '/financeiro-empresa?area=importacao&tipo=caixa'); await settle(cash);
  try { assert.equal(cash.input('records-import-kind').props.value, 'cash'); assert.match(cash.text(), /Colunas de Registros de caixa: Data, Competência, Tipo/); assert.match(cash.text(), /Caixas e bancos/); } finally { cash.unmount(); }
  const consulta = await importer(server({ session: role('consulta') })); await settle(consulta);
  try { assert.equal(consulta.nodes().some(node => node.type === 'input' && node.props.type === 'file'), false); assert.match(consulta.text(), /Seu perfil consulta o financeiro, sem importar registros\./); } finally { consulta.unmount(); }
});

test('246 recorrências and Importação follow incluir/editar of their kind (Sistema › Usuários › Permissões), as the server checks', async () => {
  const limited = server({ permitted: ['financas.contas_receber', 'financas.contas_pagar', 'financas.contas_pagar.ie'] });
  const receivable = await list(limited, '/financeiro-empresa?area=recorrentes&tipo=R'); await settle(receivable);
  try {
    assert.equal(buttons(receivable, 'Gerar contas').length, 0, 'without incluir/editar of Contas a receber no recorrência generates contas');
    assert.equal(child(receivable, 'RowMenu'), undefined);
  } finally { receivable.unmount(); }
  const payable = await list(limited, '/financeiro-empresa?area=recorrentes&tipo=P'); await settle(payable);
  try { assert.equal(buttons(payable, 'Gerar contas').length, 1, 'Contas a pagar incluir/editar keeps them'); } finally { payable.unmount(); }
  const sheet = await importer(server({ permitted: ['financas.contas_receber'] })); await settle(sheet);
  try { assert.equal(sheet.nodes().some(node => node.type === 'label' && node.props.htmlFor === 'records-import-file'), false, 'no PROCURAR ARQUIVO without incluir'); } finally { sheet.unmount(); }
});
