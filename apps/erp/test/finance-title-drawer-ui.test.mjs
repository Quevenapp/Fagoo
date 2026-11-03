import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse, chooseCategory } from './helpers/finance-category-tree-fixture.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 108 Origin drawer: tabs, fields, Resumo, locks of the source, commands with "Conferir resultado".
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = id(500), ARCHIVED = id(501), CATEGORY = id(600), OTHER_KIND = id(601), CONTACT = id(800), REMITTANCE = id(900);
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 4, group_id: id(9000), installment: 1, installments: 1, contact_id: CONTACT, contact_name: 'Cliente sintético', category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null, issued_on: '2026-01-01', due_on: '2026-02-01', amount_cents: '10000', settled_cents: '0', balance_cents: '10000', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null,
  competence_on: '2026-01-01', account_id: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-02-01', deleted_at: null, ...extra });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
const page = (entity, items) => ({ entity, data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items });
function server({ detail = {}, post, role = 'financeiro' } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: id(1), role } } };
  const controller = {
    getSnapshot: () => state.session,
    async catalog(path) { calls.push({ path }); if (path === '/v1/cadastros') return { read: ['contacts'], write: ['contacts'] }; throw new Error(`Unexpected ${path}`); },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (options.method === 'POST') return post(call, calls.filter(item => item.method === 'POST').length);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return page('accounts', [{ id: ACCOUNT, name: 'Banco sintético', kind: 'bank', active: true }, { id: ARCHIVED, name: 'Caixa antigo', kind: 'cash', active: false }]);
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), [{ id: CATEGORY, name: 'Receita sintética', kind: 'receivable' }, { id: OTHER_KIND, name: 'Despesa sintética', kind: 'payable' }]);
      const match = /^\/v1\/financeiro\/titles\/([^/]+)\/detalhe$/.exec(url.pathname);
      if (match) { const record = detail.record ?? title(Number(match[1].slice(-4))); return { entity: 'titles', data_mode: 'erp_native', record, origin: record.origin ?? null, account: null, billing: null, imported: false, settled_before: false, original: null, ...detail, record }; }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), setRole(next) { state.session = { phase: 'ready', membership: { user_id: id(1), role: next } }; } };
}
const mount = (source, props) => {
  const events = { saved: [], closed: 0 };
  return mountComponent('FinanceTitleDrawer.tsx', { controller: source.controller, kind: 'receivable', mode: 'create', title: null, onClose: () => { events.closed++; }, onSaved: value => events.saved.push(value), ...props }, { expandChildren: ['DrawerField', 'CategoryTreePicker', 'TreeList'] }).then(view => Object.assign(view, { events }));
};

test('108/172 drawer includes a Parcelada conta (a recurrence, each parcela with the Valor) with competência, conta financeira, percentuais and dias úteis, recovering an uncertain save', async () => {
  const recurrence = { id: id(70), kind: 'receivable', contact_id: CONTACT, contact_name: 'Cliente sintético', category_id: CATEGORY, category_name: 'Receita sintética', account_id: ACCOUNT, description: 'Mensalidade sintética', amount_cents: '10000', frequency: 'installments', due_day: 31, second_day: null, weekday: null,
    business_days: true, end_on: null, next_on: '2026-03-31', generated: 1, active: true, open_titles: 1, version: 1, created_at: '2026-01-05T12:00:00Z', installments: 3 };
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return { entity: 'recurrences', data_mode: 'erp_native', action: 'recurrence_create', replayed: true, record: recurrence, title: title(71, { installments: 3, group_id: id(70), recurrence_id: id(70) }) }; } });
  const view = await mount(source);
  try {
    assert.deepEqual(['Cabeçalho', 'Pagamento', 'Ocorrência', 'Anexos'].map(label => buttons(view, label)[0].props['aria-selected']), [true, false, false, false]);
    // SQL 211: the Anexos tab is open; a new conta asks to be saved before receiving files.
    assert.equal(buttons(view, 'Anexos')[0].disabled, false); await view.click('Anexos'); assert.match(view.text(), /Salve a conta para incluir anexos/); await view.click('Cabeçalho');
    assert.equal(field(view, 'Emissão *').props.value, todaySP()); assert.equal(field(view, 'Competência *').props.value, todaySP());
    await view.submit(); assert.match(view.text(), /Selecione o cliente\./); assert.equal(source.posts().length, 0);
    child(view, 'CatalogPicker').props.onSelect({ id: CONTACT, name: 'Cliente sintético' }); await view.flush();
    await view.change(field(view, 'Valor (R$) *').props.id, '100,00'); await view.change(field(view, 'Emissão *').props.id, '2026-01-05');
    await view.change(field(view, 'Competência *').props.id, '2025-12-01'); await view.change(field(view, 'Vencimento *').props.id, '2026-02-14');
    await view.change(field(view, 'Histórico').props.id, 'Mensalidade sintética'); assert.match(view.text(), /21 de 2.000 caracteres/);
    await view.click('Pagamento');
    assert.equal(field(view, 'Forma de Pagamento').disabled, false, 'the formas de pagamento of the cadastro (SQL 175)'); assert.equal(field(view, 'Vendedor').disabled, false, 'the Vendedor of Cadastros > Vendedores (SQL 210)');
    const accounts = view.nodes().filter(node => node.type === 'option' && node.props.value === ACCOUNT || node.props?.value === ARCHIVED).map(text);
    assert.deepEqual(accounts, ['Banco sintético'], 'an archived conta financeira is not offered');
    await view.change(field(view, 'Conta Financeira').props.id, ACCOUNT);
    field(view, 'Categoria').props.onClick(); await view.flush();
    assert.ok(!view.nodes().some(node => node.type === 'button' && text(node) === 'Despesa sintética'), 'only categorias of the kind (the tree of the tab)');
    await chooseCategory(view, field(view, 'Categoria').props.id, 'Receita sintética');
    await view.change(field(view, 'Nº no banco').props.id, ' 00012345 '); await view.change(field(view, 'Nº documento').props.id, 'Contrato 7');
    await view.change(field(view, 'Juros mensal (%)').props.id, '1,5'); await view.change(field(view, 'Multa (%)').props.id, '2,00');
    await view.click('Ocorrência');
    const occurrences = view.nodes().filter(node => node.type === 'option' && ['unica', 'parcelada', 'mensal', 'anual'].includes(node.props.value)).map(node => [text(node), Boolean(node.props.disabled)]);
    assert.deepEqual(occurrences, [['Única', false], ['Parcelada', false], ['Mensal', false], ['Anual', false]], 'the recurring ones create the recurrence (SQL 138)');
    await view.change(field(view, 'Ocorrência').props.id, 'parcelada');
    assert.equal(buttons(view, 'Salvar e dar baixa').length, 0, 'only a single parcela opens the baixa');
    await view.change(field(view, 'Dia de vencimento *').props.id, '31'); await view.change(field(view, 'Parcelas *').props.id, '3');
    view.find(node => node.type === 'input' && node.props.role === 'switch').props.onChange({ target: { checked: true } }); await view.flush();
    // 14/02/2026 is a Saturday and 16-17/02/2026 is Carnaval; 31/03/2026 is a Tuesday; 30/04/2026 (no 31st) is a Thursday.
    assert.match(view.text(), /1\/318\/02\/2026R\$ 100,002\/331\/03\/2026R\$ 100,003\/330\/04\/2026R\$ 100,00/);
    assert.match(view.text(), /Cada parcela tem o valor informado, como no Origin/);
    await view.change(field(view, 'Ocorrência').props.id, 'parcelada');
    await view.click('Pagamento'); await view.change(field(view, 'Juros mensal (%)').props.id, '1,555'); await view.click('Ocorrência'); await view.submit();
    assert.equal(buttons(view, 'Pagamento')[0].props['aria-selected'], true, 'a validation error opens the tab of the field'); assert.match(view.text(), /Informe o percentual/);
    await view.change(field(view, 'Juros mensal (%)').props.id, '1,50'); await view.submit();
    assert.equal(source.posts().length, 1); assert.match(view.text(), /Use “Conferir resultado”/); assert.equal(view.guard().busy, true);
    assert.equal(view.find(node => node.type === 'fieldset' && node.props.role === 'tabpanel').props.disabled, true, 'the form is locked until the result is confirmed');
    assert.equal(buttons(view, 'Conferir resultado')[0].props.type, 'submit'); await view.submit();
    const [first, second] = source.posts();
    assert.equal(first.path, '/v1/financeiro/actions/recurrence_create'); assert.deepEqual(second.body, first.body, 'the same command_id and body are replayed');
    assert.deepEqual(first.body.data, { kind: 'receivable', contact_id: CONTACT, category_id: CATEGORY, account_id: ACCOUNT, description: 'Mensalidade sintética', source_reference: 'Contrato 7', bank_number: '00012345',
      issued_on: '2026-01-05', competence_on: '2025-12-01', due_on: '2026-02-14', amount_cents: '10000', interest_month_bp: 150, penalty_bp: 200, frequency: 'installments', business_days: true, due_day: 31, installments: 3 });
    await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/recurrence_create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first.body) }));
    assert.deepEqual(view.events.saved, [undefined]);
  } finally { view.unmount(); }
});

test('108 drawer edits only what changed, with the version shown; Salvar e dar baixa with no change just opens the baixa', async () => {
  const source = server({ post: () => ({ entity: 'titles', data_mode: 'erp_native', action: 'title_edit', replayed: false, record: title(1, { version: 5 }) }) });
  const view = await mount(source, { mode: 'edit', title: title(1, { overdue: true, due_on: '2026-02-01', interest_month_bp: 300, penalty_bp: 200, balance_cents: '10000', competence_on: '2025-12-15', account_id: ACCOUNT }) });
  try {
    assert.match(view.text(), /Conta a receber/); assert.match(view.text(), /Atrasada/);
    await view.click('Salvar e dar baixa');
    assert.deepEqual(view.events.saved, [{ settleId: id(1) }]); assert.equal(source.posts().length, 0, 'nothing changed, nothing is sent');
    await view.click('Ocorrência'); assert.equal(field(view, 'Ocorrência').props.disabled, true); assert.match(view.text(), /Parcela 1 de 1/);
    await view.click('Cabeçalho'); await view.change(field(view, 'Vencimento *').props.id, '2026-03-01');
    await view.click('Pagamento'); await view.change(field(view, 'Conta Financeira').props.id, '');
    await view.change(field(view, 'Multa (%)').props.id, '0'); await view.submit();
    assert.deepEqual(source.posts()[0].body.data, { id: id(1), expected_version: 4, due_on: '2026-03-01', account_id: null, penalty_bp: 0 });
    assert.equal(source.posts()[0].path, '/v1/financeiro/actions/title_edit'); assert.deepEqual(view.events.saved.at(-1), undefined);
  } finally { view.unmount(); }
});

test('108 drawer Resumo computes juros pró-rata and multa until today in exact cents', async () => {
  const today = todaySP(), due = new Date(Date.parse(`${today}T00:00:00Z`) - 15 * 86400000).toISOString().slice(0, 10);
  const view = await mount(server(), { mode: 'edit', title: title(1, { overdue: true, due_on: due, original_due_on: '2025-12-01', interest_month_bp: 300, penalty_bp: 200, amount_cents: '12345', balance_cents: '10001', settled_cents: '2344', status: 'partial' }) });
  try {
    // 3% a.m. × 15/30 × 100,01 = 1,50015 → R$ 1,50; multa 2% × 100,01 = 2,0002 → R$ 2,00; total 103,51.
    assert.match(view.text(), /Vencimento original01\/12\/2025Valor originalR\$ 123,45JurosR\$ 1,50MultaR\$ 2,00Valor totalR\$ 103,51/);
    assert.match(view.text(), /15 dias de atraso/); assert.match(view.text(), /Atrasada/);
    const badge = view.find(node => node.type === 'span' && typeof node.props.className === 'string' && node.props.className.includes('status-badge'));
    assert.equal(badge.props.title, 'Atrasada por 15 dias');
  } finally { view.unmount(); }
});

test('108 drawer keeps document, boleto and baixa fields with the source and warns about a remessa with file', async () => {
  const billed = title(2, { bank_number: null }), detail = { billing: { our_number: '12345678', document_number: 'D1', remittance_id: REMITTANCE, remittance_sequence: 7, remittance_state: 'ready', file_generated: true } };
  const source = server({ detail: { ...detail, record: billed } }), view = await mount(source, { mode: 'edit', title: billed });
  try {
    assert.match(view.text(), /remessa nº 7, com arquivo gerado/);
    assert.equal(child(view, 'CatalogPicker').props.disabled, true, 'the payer of a boleto is not changed');
    assert.equal(field(view, 'Valor (R$) *').props.readOnly, true);
    await view.click('Pagamento'); assert.equal(field(view, 'Nº no banco').props.readOnly, true); assert.equal(field(view, 'Nº no banco').props.value, '12345678');
  } finally { view.unmount(); }
  const linked = title(3, { document_linked: true, origin: { document_id: id(77), kind: 'sales_orders', number: '42' }, settled_cents: '100', balance_cents: '9900', status: 'partial' });
  const documented = await mount(server({ detail: { record: linked, settled_before: true } }), { mode: 'edit', title: linked });
  try {
    assert.match(documented.text(), /gerada por um documento/); assert.match(documented.text(), /Pedido de origem: #42/);
    assert.equal(field(documented, 'Emissão *').props.readOnly, true); assert.equal(field(documented, 'Valor (R$) *').props.readOnly, true);
    await documented.click('Pagamento'); assert.equal(field(documented, 'Nº documento').props.readOnly, true);
    await documented.change(field(documented, 'Nº documento').props.id, 'Outro'); await documented.submit();
    assert.match(documented.text(), /fica com a origem da conta/, 'a locked value is refused before sending');
  } finally { documented.unmount(); }
});

test('108 drawer for consulta and cancelled contas is read-only and loads nothing to edit', async () => {
  const source = server({ role: 'consulta' }), view = await mount(source, { mode: 'view', title: title(4, { category_id: CATEGORY, category_name: 'Receita sintética' }) });
  try {
    assert.equal(buttons(view, 'Salvar').length + buttons(view, 'Salvar e dar baixa').length, 0); assert.equal(buttons(view, 'Fechar').length, 1);
    assert.equal(view.find(node => node.type === 'fieldset' && node.props.role === 'tabpanel').props.disabled, true);
    assert.deepEqual(source.calls.map(call => call.path), [`/v1/financeiro/titles/${id(4)}/detalhe`], 'a consulta reads only the conta');
    await view.click('Pagamento'); assert.equal(text(field(view, 'Categoria')), 'Receita sintética', 'the current category name is shown');
    await view.click('Fechar'); assert.equal(view.events.closed, 1);
  } finally { view.unmount(); }
  const cancelled = await mount(server(), { mode: 'edit', title: title(5, { cancelled: true, status: 'cancelled' }) });
  try { assert.match(cancelled.text(), /cancelada e fica disponível somente para consulta/); assert.equal(buttons(cancelled, 'Salvar').length, 0); assert.match(cancelled.text(), /Cancelada/); } finally { cancelled.unmount(); }
});

test('108 drawer sends nothing after a role change and keeps a known rejection editable', async () => {
  const source = server({ post: () => { throw new AccessError(409); } }), view = await mount(source, { mode: 'edit', title: title(6) });
  try {
    await view.change(field(view, 'Histórico').props.id, 'Revisada'); source.setRole('consulta'); await view.submit();
    assert.equal(source.posts().length, 0); assert.match(view.text(), /Seu acesso a esta operação foi alterado/);
    source.setRole('financeiro'); await view.submit();
    assert.equal(source.posts().length, 1); assert.match(view.text(), /A conta mudou/); assert.equal(buttons(view, 'Conferir resultado').length, 0, 'a known 409 is not uncertain');
    assert.equal(view.find(node => node.type === 'fieldset' && node.props.role === 'tabpanel').props.disabled, false);
    await view.submit(); assert.notEqual(source.posts()[1].body.command_id, source.posts()[0].body.command_id, 'a new attempt after a known rejection is a new command');
    assert.deepEqual(view.events.saved, []);
  } finally { view.unmount(); }
});
