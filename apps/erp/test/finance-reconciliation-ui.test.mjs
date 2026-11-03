import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { runBatch } from '../src/lib/origin-batch.ts';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';
import { decodeOfx, reconciliationApiPath, reconciliationRoute, toReconcile } from '../src/lib/finance-reconciliation-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';
import { presetRange } from '../src/lib/origin-list.ts';
import { todaySP } from '../src/lib/real-finance-model.ts';

// Synthetic data only. 137: Caixas e bancos > Conciliação (OFX import, sugestões, Buscar, Novo, reverter, extratos importados).
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', BANK = id(1), CAIXA = id(2);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const lastButton = async (view, label) => { const found = view.nodes().filter(node => node.type === 'button' && text(node) === label).at(-1); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const account = (n, extra = {}) => ({ id: id(n), name: n === 1 ? 'Itaú sintético' : 'Caixa sintético', kind: n === 1 ? 'bank' : 'cash', account_type: n === 1 ? 'checking' : 'cash', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null, start_on: '2026-01-01', active: true,
  default_movements: false, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '0', balance_cents: '0', first_movement_on: null, in_use: true, cnab: null, version: 1, created_at: 'x', updated_at: 'x', ...extra });
const candidate = (n, extra = {}) => ({ kind: 'entry', id: id(200 + n), line_kind: 'entry', posted_on: '2026-03-04', amount_cents: '-15000', note: `Lançamento ${n}`, contact_name: null, entry_origin: 'manual', ...extra });
const bankLine = (n, extra = {}) => ({ id: id(100 + n), statement_id: id(90), account_id: BANK, fitid: `F${n}`, posted_on: '2026-03-05', amount_cents: '-15000', memo: `TARIFA ${n}`, trntype: 'DEBIT', state: 'pending', version: 1, links: [], suggestion: null, ...extra });
function server({ lines = [bankLine(1, { suggestion: candidate(1) }), bankLine(2, { amount_cents: '30000', memo: 'PIX ALFA', trntype: 'CREDIT' })], statements = [{ id: id(90), file_name: 'marco.ofx', created_at: '2026-03-31T12:00:00Z', period_from: '2026-03-01', period_to: '2026-03-31', lines: 2, reconciled: 0 }], post = call => ({ action: call.path.split('/').at(-1), replayed: false, entity: 'reconciliation', record: { id: id(99), new_lines: 2, bank_lines: 2 }, data_mode: 'erp_native' }) } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: 'financeiro' } } }, listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async catalog() { return { entity: 'contacts', items: [], limit: 10, has_more: false, next_cursor: null, data_mode: 'erp_native' }; },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') return { read: true, write: state.session.membership.role !== 'consulta', data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/contas-financeiras') return { entity: 'financial_accounts', page: 1, limit: 100, total: 2, items: [account(1), account(2)], data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      if (url.pathname === '/v1/financeiro/conciliacao') { const items = lines.filter(line => line.state === url.searchParams.get('state')); return { entity: 'reconciliation', account_id: url.searchParams.get('account'), state: url.searchParams.get('state'), page: Number(url.searchParams.get('page')), limit: 50, total: items.length, items: structuredClone(items), counts: { pending: lines.filter(line => line.state === 'pending').length, reconciled: lines.filter(line => line.state === 'reconciled').length, hidden: 0 }, statements, data_mode: 'erp_native' }; }
      if (url.pathname === '/v1/financeiro/conciliacao/candidatos') return { entity: 'reconciliation_candidates', account_id: BANK, from: url.searchParams.get('from'), to: url.searchParams.get('to'), movements: [candidate(3, { amount_cents: '20000', kind: 'movement', line_kind: 'settlement', entry_origin: undefined }), candidate(4, { amount_cents: '10000' })],
        titles: [{ id: id(300), kind: 'receivable', version: 2, contact_name: 'Alfa', description: 'Venda', due_on: '2026-03-10', balance_cents: '30000', installment: 1, installments: 1, payment_method_name: 'Pix sintético' }], data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), setSession(next) { state.session = next; for (const listener of listeners) listener(); } };
}
const mount = (source, location = `/financeiro-empresa?area=conciliacao&conta=${BANK}`) => mountComponent('FinanceReconciliation.tsx', { controller: source.controller }, { location, expandChildren: ['ReconciliationBusyGuard', 'ReconciliationField', 'Modal', 'SearchDrawer', 'EntryModal', 'TransferFromLine', 'RevertModal', 'StatementsModal', 'CategoryTreePicker', 'TreeList'] });
const fileOf = (name, content, latin = false) => ({ name, size: content.length, arrayBuffer: async () => latin ? Uint8Array.from([...content].map(char => char.charCodeAt(0))).buffer : new TextEncoder().encode(content).buffer });

test('137 conciliação model: URL, API path accepted by the Worker, Para conciliar and the OFX charset', async () => {
  const route = reconciliationRoute(new URLSearchParams(`conta=${BANK}&situacao=conciliados&valor=150`));
  assert.deepEqual(route, { conta: BANK, situacao: 'reconciled', valor: '150' });
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${reconciliationApiPath(route, 2)}`));
  assert.deepEqual(parsed.args, { p_account: BANK, p_state: 'reconciled', p_amount_cents: '150', p_page: 2, p_limit: 50 });
  assert.throws(() => reconciliationRoute(new URLSearchParams('situacao=todos')), /inválidos/);
  assert.equal(toReconcile({ amount_cents: '-15000' }, [{ amount_cents: '-10000' }, { amount_cents: '-5000' }]), '0');
  assert.equal(decodeOfx(Uint8Array.from([...'CHARSET:1252\n<OFX><MEMO>PAGAMENTO CART\xC3O'].map(char => char.charCodeAt(0)))).endsWith('CARTÃO'), true);
  assert.equal(decodeOfx(new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><OFX>João')).endsWith('João'), true);
});

test('137 without extrato: Bem-vindo a conciliação bancária and the .OFX upload with "Conferir resultado"', async () => {
  let fail = 1; const source = server({ lines: [], statements: [], post: () => { if (fail-- > 0) throw new AccessError(503); return { action: 'statement_import', replayed: false, entity: 'reconciliation', record: { id: id(99), new_lines: 2, bank_lines: 3 }, data_mode: 'erp_native' }; } });
  const none = await mount(server(), '/financeiro-empresa?area=conciliacao');
  try { assert.match(none.text(), /Selecione no topo a conta financeira/); } finally { none.unmount(); }
  const view = await mount(source);
  try {
    assert.match(view.text(), /Bem-vindo a conciliação bancária/); assert.match(view.text(), /Faça o upload do arquivo \.OFX do seu banco/);
    const input = () => view.find(node => node.type === 'input' && node.props.type === 'file');
    await input().props.onChange({ target: { files: [fileOf('extrato.pdf', 'x')], value: '' } }); await view.flush(); assert.match(view.text(), /Selecione um arquivo \.OFX/);
    const content = 'OFXHEADER:100\nCHARSET:1252\n<OFX><MEMO>TARIFA CART\xC3O</OFX>';
    await input().props.onChange({ target: { files: [fileOf('marco.ofx', content, true)], value: '' } }); await view.flush(); await new Promise(resolve => setTimeout(resolve, 10)); await view.flush();
    const first = source.posts()[0];
    assert.equal(first.path, '/v1/financeiro/actions/statement_import'); assert.deepEqual([first.body.data.account_id, first.body.data.file_name], [BANK, 'marco.ofx']); assert.match(first.body.data.content, /TARIFA CARTÃO/);
    assert.match(view.text(), /Conferir resultado/);
    await input().props.onChange({ target: { files: [fileOf('marco.ofx', content, true)], value: '' } }); await view.flush(); await new Promise(resolve => setTimeout(resolve, 10)); await view.flush();
    assert.equal(source.posts()[1].body.command_id, first.body.command_id, 'the same import is sent again');
    assert.match(view.text(), /Extrato importado: 2 de 3 lançamento\(s\) novo\(s\)\./);
  } finally { view.unmount(); }
});

test('137 queue: cards of the bank and of the FAGOO, Conciliar a sugestão, Ocultar, and CONCILIAR TODOS skips lines without suggestion', async () => {
  const source = server(), view = await mount(source);
  try {
    assert.match(view.text(), /Extrato do BancoMovimentações no FAGOO/); assert.match(view.text(), /TARIFA 1- R\$ 150,0005\/03\/2026Detalhamento: F1/);
    assert.match(view.text(), /Caixas e banco- R\$ 150,0004\/03\/2026Lançamento 1/); assert.match(view.text(), /Nenhuma sugestão com o mesmo valor/);
    await lastButton(view, 'Conciliar');
    assert.deepEqual(source.posts()[0].body.data, { line_id: id(101), expected_version: 1, links: [{ kind: 'entry', id: id(201) }] });
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ocultar lançamento').props.onClick(); await view.flush();
    assert.deepEqual([source.posts()[1].path, source.posts()[1].body.data], ['/v1/financeiro/actions/line_hide', { line_id: id(101), expected_version: 1 }]);
    await lastButton(view, 'CONCILIAR TODOS');
    const dialog = child(view, 'BatchDialog');
    assert.deepEqual([dialog.props.plan.eligible.map(item => item.id), dialog.props.plan.skipped.map(item => item.message)], [[id(101)], ['Sem sugestão: use Buscar ou Novo.']]);
    await runBatch(dialog.props.plan, dialog.props.run);
    assert.equal(source.posts().at(-1).path, '/v1/financeiro/actions/line_reconcile');
  } finally { view.unmount(); }
});

test('137 Buscar: Valor no extrato, Lançamentos selecionados and Para conciliar; Conciliar several lançamentos or settle an open conta', async () => {
  const source = server(), view = await mount(source);
  try {
    const buttons = view.nodes().filter(node => node.type === 'button' && text(node) === 'Buscar'); buttons.at(-1).props.onClick(); await view.flush();
    assert.match(view.text(), /Pesquise e adicione os lançamentos que você deseja conciliar\./);
    assert.match(source.calls.find(call => call.path.startsWith('/v1/financeiro/conciliacao/candidatos')).path, /from=2026-02-03&to=2026-04-04/);
    await view.change(`candidate-movement-${id(203)}`, true); assert.match(view.text(), /Para conciliarR\$ 100,00/); assert.match(view.text(), /Divergência entre registro e movimentação/);
    await view.change(`candidate-entry-${id(204)}`, true); assert.match(view.text(), /Para conciliarR\$ 0,00/);
    await lastButton(view, 'Conciliar');
    assert.deepEqual(source.posts()[0].body.data, { line_id: id(102), expected_version: 1, links: [{ kind: 'movement', id: id(203) }, { kind: 'entry', id: id(204) }] });
    view.nodes().filter(node => node.type === 'button' && text(node) === 'Novo Recebimento').at(-1).props.onClick(); await view.flush();
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Venda').props.onChange({ target: { checked: true } }); await view.flush();
    await lastButton(view, 'Conciliar');
    assert.deepEqual(source.posts()[1].body.data, { line_id: id(102), expected_version: 1, items: [{ id: id(300), expected_version: 2, principal_cents: '30000' }] });
  } finally { view.unmount(); }
});

test('137/172 Reverter conciliação offers the estorno for lançamentos, baixas and transferências; Extratos importados keeps an extrato with conciliados', async () => {
  const lines = [bankLine(5, { state: 'reconciled', links: [candidate(5, { link_id: id(500) })] }), bankLine(6, { state: 'reconciled', amount_cents: '30000', links: [candidate(6, { kind: 'movement', line_kind: 'settlement', amount_cents: '30000', link_id: id(501) })] })];
  const source = server({ lines, statements: [{ id: id(90), file_name: 'marco.ofx', created_at: '2026-03-31T12:00:00Z', period_from: '2026-03-01', period_to: '2026-03-31', lines: 2, reconciled: 2 }] }), view = await mount(source, `/financeiro-empresa?area=conciliacao&conta=${BANK}&situacao=conciliados`);
  try {
    const reverts = view.nodes().filter(node => node.type === 'button' && node.props['aria-label'] === 'Reverter conciliação');
    reverts[1].props.onClick(); await view.flush();
    assert.equal(view.input('reconciliation-reverse').disabled, false, 'a baixa is estornada from the conciliação too (172)');
    await lastButton(view, 'Cancelar');
    view.nodes().filter(node => node.type === 'button' && node.props['aria-label'] === 'Reverter conciliação')[0].props.onClick(); await view.flush();
    assert.match(view.text(), /Tem certeza que deseja remover o vínculo do lançamento\?/);
    await view.change('reconciliation-reverse', true); await lastButton(view, 'Confirmar');
    assert.deepEqual(source.posts()[0].body.data, { line_id: id(105), expected_version: 1, reverse: true });
    await lastButton(view, 'Extratos importados');
    assert.equal(view.nodes().find(node => node.type === 'button' && text(node) === 'Excluir extrato').disabled, true);
  } finally { view.unmount(); }
  // A pagamento de comissão (171) or a sangria (173) is excluded only in its screen: here the vínculo is removed without estorno.
  const owned = server({ lines: [bankLine(7, { state: 'reconciled', links: [candidate(7, { link_id: id(502), entry_origin: 'commission' })] })] }), other = await mount(owned, `/financeiro-empresa?area=conciliacao&conta=${BANK}&situacao=conciliados`);
  try {
    other.find(node => node.type === 'button' && node.props['aria-label'] === 'Reverter conciliação').props.onClick(); await other.flush();
    assert.equal(other.input('reconciliation-reverse').disabled, true); assert.match(other.text(), /excluídos em Financeiro > Comissões ou no Controle de caixa/);
    await lastButton(other, 'Confirmar');
    assert.deepEqual(owned.posts()[0].body.data, { line_id: id(107), expected_version: 1 });
  } finally { other.unmount(); }
});

test('FIN-169 Buscar: Período around the extrato, the Origin presets and Período customizado; the Forma de pagamento of the conta', async () => {
  const source = server(), view = await mount(source);
  const search = () => new URL(source.calls.filter(call => call.path.startsWith('/v1/financeiro/conciliacao/candidatos')).at(-1).path, 'https://x.invalid').searchParams;
  const label = name => view.nodes().find(node => node.type === 'label' && text(node) === name)?.props.htmlFor;
  try {
    view.nodes().filter(node => node.type === 'button' && text(node) === 'Novo Recebimento').at(-1).props.onClick(); await view.flush();
    assert.deepEqual([search().get('from'), search().get('to')], ['2026-02-03', '2026-04-04']);
    assert.equal(view.input(label('Período')).props.value, 'extrato'); assert.equal(label('De'), undefined, 'De and Até only in Período customizado');
    assert.ok(view.text().includes('De 03/02/2026 até 04/04/2026'));
    assert.match(view.text(), /AlfaPix sintético/, 'Forma de pagamento column');
    await view.change(label('Período'), 'este-mes'); const month = presetRange('este-mes', todaySP());
    assert.deepEqual([search().get('from'), search().get('to')], [month.from, month.to]);
    await view.change(label('Período'), 'customizado'); assert.ok(label('De') && label('Até'));
    await view.change(label('De'), '2026-03-01'); assert.deepEqual([search().get('from'), search().get('to')], ['2026-03-01', month.to]);
    await view.change(label('Período'), 'extrato'); assert.deepEqual([search().get('from'), search().get('to')], ['2026-02-03', '2026-04-04']);
    assert.ok(source.calls.every(call => !call.method), 'searching never writes');
  } finally { view.unmount(); }
});

test('FIN-170 Mostrar detalhes of the bank line, Mostrar mais/menos of the FAGOO card and Editar registro of a lançamento de caixa', async () => {
  const links = [candidate(7, { link_id: id(700), category_name: 'Tarifas' }), candidate(8, { link_id: id(701), amount_cents: '-5000' }), candidate(9, { link_id: id(702), kind: 'movement', line_kind: 'settlement', entry_origin: undefined, amount_cents: '-1000' })];
  const lines = [bankLine(7, { state: 'reconciled', amount_cents: '-21000', links }), bankLine(8, { suggestion: candidate(10, { entry_origin: 'commission' }) })];
  const source = server({ lines: [lines[1]] }), reconciled = server({ lines: [lines[0]] });
  const entry = { id: id(207), account_id: BANK, account_name: 'Itaú sintético', kind: 'out', amount_cents: '15000', posted_on: '2026-03-04', competence_on: '2026-03-04', category_id: null, category_name: 'Tarifas', contact_id: null, contact_name: null, note: 'Lançamento 7', origin: 'reconciliation', version: 3, deleted: false, created_at: 'x', updated_at: 'x' };
  const base = reconciled.controller.finance.bind(reconciled.controller);
  reconciled.controller.finance = async (path, options = {}) => path === `/v1/financeiro/lancamentos/${id(207)}` ? (reconciled.calls.push({ path }), { entity: 'cash_entries', record: structuredClone(entry), data_mode: 'erp_native' })
    : options.method === 'POST' ? (reconciled.calls.push({ path, ...options, body: structuredClone(options.body) }), { action: 'entry_save', replayed: false, entity: 'cash_entries', record: { ...entry, note: options.body.data.note, version: 4 }, data_mode: 'erp_native' }) : base(path, options);
  const expand = ['ReconciliationBusyGuard', 'ReconciliationField', 'Field', 'Modal', 'CashEntryDrawer', 'CategoryTreePicker', 'TreeList'];
  const pending = await mountComponent('FinanceReconciliation.tsx', { controller: source.controller }, { location: `/financeiro-empresa?area=conciliacao&conta=${BANK}`, expandChildren: expand });
  try {
    assert.equal(pending.nodes().some(node => node.type === 'button' && text(node) === 'Editar registro'), false, 'a pagamento de comissão is changed only in Comissões');
    await lastButton(pending, 'Mostrar detalhes');
    assert.match(pending.text(), /Identificador do banco \(FITID\)F8/); assert.match(pending.text(), /Arquivomarco\.ofx \(01\/03\/2026 a 31\/03\/2026\)/); assert.match(pending.text(), /Importado em31\/03\/2026/);
    await lastButton(pending, 'Ocultar detalhes'); assert.doesNotMatch(pending.text(), /Identificador do banco/);
  } finally { pending.unmount(); }
  const view = await mountComponent('FinanceReconciliation.tsx', { controller: reconciled.controller }, { location: `/financeiro-empresa?area=conciliacao&conta=${BANK}&situacao=conciliados`, expandChildren: expand });
  try {
    assert.match(view.text(), /Lançamento 7/); assert.match(view.text(), /Lançamento 8/); assert.doesNotMatch(view.text(), /Lançamento 9/, 'two lançamentos until Mostrar mais');
    await lastButton(view, 'Mostrar mais (1)');
    assert.match(view.text(), /Lançamento 9/); assert.match(view.text(), /Categoria: Tarifas/); assert.match(view.text(), /Categoria: Sem categoria/);
    const edits = view.nodes().filter(node => node.type === 'button' && text(node) === 'Editar registro');
    assert.equal(edits.length, 2, 'only the lançamentos de caixa, not the baixa');
    edits[0].props.onClick(); for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.ok(view.nodes().find(node => node.type === 'section' && node.props['aria-label'] === 'Lançamento caixa'), 'the gaveta of Caixas e bancos');
    const note = view.find(node => node.type === 'label' && text(node) === 'Histórico *').props.htmlFor;
    await view.change(note, 'Tarifa do pacote'); await view.submit();
    const post = reconciled.calls.find(call => call.method === 'POST');
    assert.equal(post.path, '/v1/financeiro/actions/entry_save');
    assert.deepEqual([post.body.data.id, post.body.data.expected_version, post.body.data.note, post.body.data.amount_cents], [id(207), 3, 'Tarifa do pacote', '15000']);
    assert.match(view.text(), /Lançamento atualizado: Tarifa do pacote\./);
    await lastButton(view, 'Mostrar menos'); assert.doesNotMatch(view.text(), /Lançamento 9/);
  } finally { view.unmount(); }
});
