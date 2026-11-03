import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Clientes e fornecedores no padrão do Origin (lane contatos): listagem (ContactList.tsx) e formulário (ContactEditor.tsx)
// pelas rotas /v1/cadastros/contatos. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '95000000-0000-4000-8000-0000000000aa';
const stamp = '2026-10-20T12:00:00+00:00';
const ids = { ana: '95000000-0000-4000-8000-000000000001', bia: '95000000-0000-4000-8000-000000000002', gone: '95000000-0000-4000-8000-000000000003', seller: '95000000-0000-4000-8000-0000000000bb' };
const TYPES = [['customer', 'Cliente', true], ['developer', 'Desenvolvedor', true], ['supplier', 'Fornecedor', true], ['default', 'Padrao', true], ['technician', 'Técnico', true], ['carrier', 'Transportador', true],
  ['seller', 'Vendedor', true], ['accountant', 'Contador', false], ['verified_supplier', 'Fornecedor verificado', false]].map(([slug, label, system], index) => ({ id: `95000000-0000-4000-8000-1000000000${String(index).padStart(2, '0')}`, slug, label, system, deletable: !system, position: index + 1, contacts: 0 }));
const item = (id, name, extra = {}) => ({ id, entity: 'contacts', version: 2, active: true, situation: 'A', name, code: null, trade_name: null, person_type: 'F', document: '529.982.247-25', email: null, phone: '(19) 3434-1000',
  mobile: '(19) 90000-0000', city: 'Piracicaba', state: 'SP', roles: ['customer'], types: ['customer'], crt: null, seller_id: null, seller_name: null, next_visit: null, is_seller: false, created_at: stamp, updated_at: stamp, source: null, ...extra });
const ROWS = [item(ids.ana, 'Ana Cliente', { code: 'C-1', email: 'ana@sintetico.test', seller_id: ids.seller, seller_name: 'Vendedora' }), item(ids.bia, 'Bia Fornecedora', { roles: ['supplier'], types: ['supplier'] }),
  item(ids.gone, 'Cadastro Excluído', { situation: 'E', active: false })];
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const headers = view => view.nodes().filter(node => node.type === 'th').map(node => textOf(node.props.children));
const component = (view, name) => view.find(node => node.type?.name === name);
const byAria = (view, label) => view.find(node => node.type === 'button' && node.props['aria-label'] === label);
const tool = (view, title) => view.find(node => node.type?.name === 'ToolButton' && node.props.title === title);

function server({ role = 'admin', write = ['contacts'], rows = ROWS, prefs = { version: 0, columns: null, filters: null }, required = [], sellerFailure = null } = {}) {
  const calls = [], prefsCalls = [], snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  let preference = { ...prefs };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {}, retry() {},
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_types', can_create: write.includes('contacts'), can_delete: role === 'admin', items: TYPES, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return { scope: 'seller_options', users: [], items: [{ id: ids.seller, name: 'Vendedora', code: null }], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/vendedores/a-partir-do-contato') { if (sellerFailure && sellerFailure.count-- > 0) throw new AccessError(503); return { entity: 'sellers', contact: { id: options.body.contact_id }, seller: { id: ids.seller }, replayed: false, data_mode: 'erp_native' }; }
      const patch = /^\/v1\/cadastros\/contatos\/([^/]+)\/(situacao|vendedor)$/.exec(path);
      if (patch) { const row = rows.find(r => r.id === patch[1]); return { entity: 'contacts', record: { ...row, version: row.version + 1, ...(patch[2] === 'situacao' ? { situation: options.body.situation } : { seller_id: options.body.seller_id }) }, replayed: false, data_mode: 'erp_native' }; }
      if (path.startsWith('/v1/cadastros/contatos?')) {
        const params = new URLSearchParams(path.split('?')[1]);
        const shown = rows.filter(row => params.get('situation') === 'all' || params.get('situation') === row.situation || (!params.get('situation') && row.situation !== 'E'));
        return { entity: 'contacts', items: shown, page: Number(params.get('page')), size: 100, total: shown.length, sort: params.get('sort') || 'created_desc', situation: params.get('situation') || 'latest', scoped: false, data_mode: 'erp_native' };
      }
      throw new Error(`unexpected ${path}`);
    },
    async listPreferences(path, options = {}) {
      prefsCalls.push({ path, method: options.method ?? 'GET', body: options.body && structuredClone(options.body) });
      if (options.method === 'POST') {
        const from = preference.version; preference = { version: from + 1, columns: options.body.columns, filters: options.body.filters };
        return { scope: 'list_preferences_command', data_mode: 'erp_native', receipt: { command_id: options.body.command_id, list_id: 'cadastros.contatos', from_version: from, to_version: from + 1, changed_at: stamp },
          preference: { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.contatos', version: from + 1, columns: preference.columns, filters: preference.filters, updated_at: stamp }, replayed: false };
      }
      return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.contatos', version: preference.version, columns: preference.columns, filters: preference.filters, updated_at: preference.version ? stamp : null };
    },
    async preferences() { return { items: [{ key: 'contatos.campos_obrigatorios', value: required, version: 1 }] }; },
    async finance() { return { items: [{ id: '95000000-0000-4000-8000-0000000000c1', name: 'Vendas de mercadorias', kind: 'receivable', active: true, version: 1 }] }; },
    async fiscalInvoices() { throw new AccessError(403); },
  };
  return { calls, prefsCalls, controller, snapshot, pages: () => calls.filter(call => call.path.startsWith('/v1/cadastros/contatos?')).map(call => new URLSearchParams(call.path.split('?')[1])) };
}
const mountList = (service, location) => mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'contacts' }, { expandChildren: ['NativeListLayout', 'ContactCatalog'], ...(location ? { location } : {}) });

test('default listing: Últimos incluídos, the Origin default columns, the type selector from the API and plain headers', async () => {
  const service = server(), view = await mountList(service);
  try {
    assert.deepEqual(Object.fromEntries(service.pages()[0]), { page: '1', size: '100' }, 'Situação = Últimos incluídos is the server default');
    assert.deepEqual(headers(view), ['Seleção', 'Código', 'Nome', 'CPF/CNPJ', 'Cidade', 'Telefone', 'Marcadores', 'Ações']);
    assert.equal(view.nodes().some(node => node.type === 'button' && node.props.className === 'catalog-sort'), false, 'headers do not sort (Origin CL-26)');
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Exibindo pela ordem de inclusão']);
    const selector = component(view, 'OriginSelector').props;
    assert.deepEqual(selector.options, ['Todos', 'Sem tipo definido', 'Cliente', 'Contador', 'Desenvolvedor', 'Fornecedor', 'Fornecedor verificado', 'Transportador', 'Técnico', 'Vendedor']);
    assert.match(view.text(), /\(19\) 3434-1000/); assert.doesNotMatch(view.text(), /90000-0000/, 'Telefone shows only the Fone');
    assert.equal(view.nodes().filter(node => node.type === 'td' && node.props.className === 'contact-col-optional').length, 4, 'Código and CPF/CNPJ hide on small screens');
    const menu = view.nodes().filter(node => node.type?.name === 'RowMenu')[0].props.items;
    assert.deepEqual(menu.map(entry => entry.label), ['Editar', 'Ficha financeira', 'Tornar vendedor', 'Comentários', 'Inativar']);
    assert.equal(menu[1].disabled, false, 'Ficha financeira opens for the administrador (onda C)'); assert.equal(menu[2].disabled, false);
    assert.match(view.text(), /Quantidade de contatos2/);
    assert.equal(view.button('Imprimir etiquetas').disabled, true, 'Imprimir etiquetas needs a selection');
    assert.equal(view.button('Contatos agrupados').disabled, true);
    assert.equal(view.nodes().some(node => node.type === 'span' && node.props.title === 'Cadastro excluído'), false, 'Últimos incluídos never shows excluded rows');
  } finally { view.unmount(); }
});

test('Situação, Vendedor, Prox. Visita / Sem compras no período and Limpar map to strict parameters and the Origin chips', async () => {
  const service = server(), view = await mountList(service);
  try {
    await view.change('contact-situation-filter', 'E'); await view.submit();
    assert.deepEqual(Object.fromEntries(service.pages().at(-1)), { page: '1', size: '100', sort: 'name_asc', situation: 'E' });
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Cadastros: Excluídos']);
    assert.ok(tool(view, 'Restaurar selecionados'), 'Restaurar takes the place of the trash');
    assert.ok(view.nodes().some(node => node.type === 'span' && node.props.title === 'Cadastro excluído'), 'excluded rows carry the red ✕');
    assert.equal(view.button('Excluir definitivamente').disabled, true);
    await view.change('contact-situation-filter', 'latest');
    component(view, 'SellerPicker').props.onChange({ id: ids.seller, name: 'Vendedora', code: null }); await view.flush();
    view.find(node => node.type?.name === 'ContactPeriodPicker').props.onApply({ field: 'no_purchases', from: '2026-10-01', to: '2026-10-31' }); await view.flush();
    await view.change('contact-sale-open', true);
    await view.submit();
    assert.deepEqual(Object.fromEntries(service.pages().at(-1)), { page: '1', size: '100', seller_id: ids.seller, period: 'no_purchases', from: '2026-10-01', to: '2026-10-31', sale_statuses: 'open' });
    const labels = component(view, 'AppliedChips').props.chips.map(chip => chip.label);
    for (const label of ['Exibindo pela ordem de inclusão', 'Vendedor: Vendedora', 'Sem compras no período: 01/10/2026 até 31/10/2026', 'Situações de vendas: Em aberto']) assert.ok(labels.includes(label), label);
    component(view, 'AppliedChips').props.onClear(); await view.flush();
    assert.deepEqual(Object.fromEntries(service.pages().at(-1)), { page: '1', size: '100', sort: 'name_asc', situation: 'all' }, 'Limpar: Situação Todos, alphabetical order');
    assert.deepEqual(component(view, 'AppliedChips').props.chips, [], '"Nenhum filtro aplicado"');
    assert.ok(view.nodes().some(node => node.type === 'span' && node.props.title === 'Cadastro excluído'), 'Todos includes the excluded ones');
    assert.equal(service.calls.some(call => call.method), false, 'filters only read');
  } finally { view.unmount(); }
});

test('company route: ?contato= keeps the readable values (Estoque › Fornecedores) and the selector writes the URL', async () => {
  const service = server(), view = await mountList(service, '/cadastros-reais?cadastro=contacts&contato=fornecedor');
  try {
    assert.equal(service.pages()[0].get('type'), 'supplier');
    assert.equal(component(view, 'OriginSelector').props.value, 'Fornecedor');
    component(view, 'OriginSelector').props.onChange('Vendedor'); await view.flush();
    assert.equal(view.location().search, '?cadastro=contacts&contato=vendedor');
    assert.equal(service.pages().at(-1).get('type'), 'seller');
    component(view, 'OriginSelector').props.onChange('Todos'); await view.flush();
    assert.equal(view.location().search, '?cadastro=contacts');
  } finally { view.unmount(); }
});

test('selection: chip, red trash, Excluir selecionados and Vincular a vendedor run one command per contact', async () => {
  const service = server(), view = await mountList(service);
  try {
    assert.equal(tool(view, 'Excluir selecionados').props.disabled, true);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Ana Cliente').props.onClick({ shiftKey: false }); await view.flush();
    assert.ok(component(view, 'AppliedChips').props.chips.some(chip => chip.label === 'Selecionados: 1 cadastro'));
    assert.ok(view.nodes().some(node => node.type === 'span' && node.props.className === 'contact-trash is-armed'));
    assert.equal(view.button('Aniversariantes').disabled, true, 'Mais ações > Imprimir is disabled with a selection');
    tool(view, 'Excluir selecionados').props.onClick(); await view.flush();
    const dialog = component(view, 'BatchDialog').props;
    assert.equal(dialog.title, 'Excluir selecionados'); assert.equal(dialog.confirmLabel, 'Excluir');
    await dialog.run({ id: ids.ana, label: 'Ana Cliente', version: 2, situation: 'A', seller_id: null });
    const sent = service.calls.find(call => call.method === 'PATCH');
    assert.equal(sent.path, `/v1/cadastros/contatos/${ids.ana}/situacao`);
    assert.deepEqual({ ...sent.body, command_id: 'id' }, { command_id: 'id', expected_version: 2, situation: 'E' });
    dialog.onClose([{ id: ids.ana, label: 'Ana Cliente', outcome: 'ok' }]); await view.flush();
    assert.match(view.text(), /Mudança de situação/);

    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Bia Fornecedora').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Vincular a vendedor');
    let link = component(view, 'BatchDialog').props;
    assert.equal(link.title, 'Vincular Contatos a Vendedor'); assert.equal(link.canConfirm, false, 'Ok needs a seller');
    link.description.props.onChange({ id: ids.seller, name: 'Vendedora', code: null }); await view.flush();
    link = component(view, 'BatchDialog').props; assert.equal(link.canConfirm, true);
    await link.run({ id: ids.bia, label: 'Bia Fornecedora', version: 2, situation: 'A', seller_id: null });
    const linked = service.calls.filter(call => call.method === 'PATCH').at(-1);
    assert.equal(linked.path, `/v1/cadastros/contatos/${ids.bia}/vendedor`); assert.equal(linked.body.seller_id, ids.seller);
    // A session change stops the next items.
    service.snapshot.membership = { user_id: '95000000-0000-4000-8000-0000000000ff', role: 'admin' };
    await assert.rejects(link.run({ id: ids.ana, label: 'Ana Cliente', version: 3, situation: 'A', seller_id: null }), /A sessão mudou/);
  } finally { view.unmount(); }
});

test('listagem customizada: the choice and the columns are saved per user and Nome stays fixed', async () => {
  const service = server({ prefs: { version: 1, columns: ['email', 'seller', 'name'], filters: { listagem: 'customizada' } } }), view = await mountList(service);
  try {
    assert.deepEqual(headers(view), ['Seleção', 'E-mail', 'Vendedor', 'Nome', 'Marcadores', 'Ações']);
    assert.match(view.text(), /ana@sintetico\.test/); assert.match(view.text(), /Vendedora/);
    const views = () => component(view, 'ListControls').props.views.props.children;
    views()[1].props.onClick(); await view.flush();
    const panel = component(view, 'ListColumnsPanel').props;
    assert.equal(panel.fixed, 'name'); assert.deepEqual(panel.columns.map(c => c.label), ['Nome', 'Cidade', 'CPF/CNPJ', 'Telefone', 'Código', 'Código do Regime Tributário', 'Situação', 'UF', 'Nome fantasia', 'E-mail', 'Celular', 'Vendedor']);
    panel.onApply(['name', 'crt', 'mobile']); await view.flush();
    assert.deepEqual(service.prefsCalls.at(-1).body.columns, ['name', 'crt', 'mobile']); assert.deepEqual(service.prefsCalls.at(-1).body.filters, { listagem: 'customizada' });
    assert.deepEqual(headers(view), ['Seleção', 'Nome', 'Código do Regime Tributário', 'Celular', 'Marcadores', 'Ações']);
    views()[0].props.onChange('padrao'); await view.flush();
    assert.equal(service.prefsCalls.at(-1).body.filters, null, 'Visualizar listagem padrão is saved too');
    assert.deepEqual(headers(view), ['Seleção', 'Código', 'Nome', 'CPF/CNPJ', 'Cidade', 'Telefone', 'Marcadores', 'Ações']);
  } finally { view.unmount(); }
});

test('Tornar vendedor executes directly; an unknown result is confirmed with the same command', async () => {
  const service = server({ sellerFailure: { count: 1 } }), view = await mountList(service);
  try {
    view.nodes().filter(node => node.type?.name === 'RowMenu')[0].props.items.find(entry => entry.label === 'Tornar vendedor').onClick(); await view.flush();
    assert.match(view.text(), /Não foi possível confirmar se Ana Cliente virou vendedor/);
    const first = service.calls.find(call => call.path === '/v1/cadastros/vendedores/a-partir-do-contato');
    await view.click('Conferir resultado');
    const sent = service.calls.filter(call => call.path === '/v1/cadastros/vendedores/a-partir-do-contato');
    assert.equal(sent.length, 2); assert.equal(sent[1].body.command_id, first.body.command_id); assert.equal(sent[1].body.contact_id, ids.ana);
    assert.match(view.text(), /Ana Cliente agora é vendedor\./);
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta', write: [] }), readOnly = await mountList(reader);
  try {
    assert.equal(headers(readOnly)[0], 'Código', 'no selection column without write access');
    assert.throws(() => tool(readOnly, 'Excluir selecionados'));
    const menu = readOnly.nodes().filter(node => node.type?.name === 'RowMenu')[0].props.items;
    assert.deepEqual(menu.map(entry => entry.label), ['Visualizar', 'Ficha financeira', 'Tornar vendedor', 'Comentários']);
    assert.equal(menu[2].disabled, true);
  } finally { readOnly.unmount(); }
});

test('Comentários: the modal lists and adds; an unknown result keeps the text and repeats the same command', async () => {
  let fail = 1;
  const calls = [], controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), async catalog(path, options = {}) {
    calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
    if (!options.method) return { scope: 'contact_comments', contact_id: ids.ana, can_comment: true, items: [{ id: '95000000-0000-4000-8000-0000000000c9', body: 'Primeiro contato', author_name: 'Vendas', created_at: stamp }], data_mode: 'erp_native' };
    if (fail-- > 0) throw new AccessError(503);
    return { scope: 'contact_comment', contact_id: ids.ana, item: { id: '95000000-0000-4000-8000-0000000000ca', body: options.body.body, author_name: 'Vendas', created_at: stamp }, replayed: false, data_mode: 'erp_native' };
  } };
  const view = await mountComponent('ContactComments.tsx', { controller, contact: { id: ids.ana, name: 'Ana Cliente' }, onClose() {} }, { componentName: 'ContactComments' });
  try {
    assert.match(view.text(), /Primeiro contato/);
    assert.equal(view.input('contact-comment').props.placeholder, 'Digite aqui um comentário');
    await view.change('contact-comment', 'Ligar na segunda');
    assert.equal(view.guard().changed, true, 'a typed comment is protected by the unsaved guard');
    byAria(view, 'Enviar comentário').props.onClick(); await view.flush();
    assert.match(view.text(), /Conferir resultado/);
    await view.click('Conferir resultado');
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2); assert.equal(posts[1].body.command_id, posts[0].body.command_id); assert.equal(posts[1].body.body, 'Ligar na segunda');
    assert.match(view.text(), /Ligar na segunda/); assert.equal(view.input('contact-comment').props.value, '');
  } finally { view.unmount(); }
});

// ---- Formulário ----
const FULL = { id: ids.ana, entity: 'contacts', version: 4, active: true, created_at: stamp, updated_at: stamp, name: 'Ana Cliente', code: 'C-1', trade_name: null, person_type: 'F', document: '529.982.247-25',
  ie: null, email: 'ana@sintetico.test', phone: null, mobile: null, postal_code: null, street: null, number: null, complement: null, district: null, city: null, state: 'SP', situation: 'A', roles: ['customer'],
  types: ['customer'], persons: [], source: null, ie_exempt: false, credit_limit_mode: 'unlimited', credit_limit: null, crt: null, client_since: '2020-01-01', taxpayer: '9', rg: '12.345.678-9', rg_issuer: 'SSP',
  birth_date: '1990-05-10', avg_tax_load: '12.50', seller_id: null, seller_name: null, finance_category_id: null, finance_category_name: null, operation_nature_id: null, operation_nature_name: null,
  updated_by_name: 'Administrador', seller_record_id: null, notes: null };
function editorServer({ checks = [], saves = [], required = [] } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => {},
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_types', can_create: true, can_delete: true, items: TYPES, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/contatos/codigo') return { scope: 'contact_code', mode: 'manual', next_number: '1', version: 0, highest_used: '0', can_edit: true, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/contatos/conferir') { const next = checks.shift() ?? []; if (next instanceof Error) throw next; return { entity: 'contacts', warnings: next, data_mode: 'erp_native' }; }
      if (options.method) { const next = saves.shift(); if (next instanceof Error) throw next; return { entity: 'contacts', record: { ...FULL, id: path.split('/')[4] ?? '95000000-0000-4000-8000-0000000000ee', version: 5 }, replayed: false, data_mode: 'erp_native' }; }
      if (/^\/v1\/cadastros\/contatos\/[0-9a-f-]{36}$/.test(path)) return { entity: 'contacts', record: { ...FULL, id: path.split('/')[4] }, data_mode: 'erp_native' };
      throw new Error(`unexpected ${path}`);
    },
    async preferences() { return { items: [{ key: 'contatos.campos_obrigatorios', value: required, version: 1 }] }; },
    async finance() { return { items: [] }; },
    async fiscalInvoices() { throw new AccessError(403); },
  };
  return { calls, controller, writes: () => calls.filter(call => call.method && !call.path.endsWith('/conferir')) };
}
const mountEditor = (service, props = {}) => mountComponent('ContactEditor.tsx', { controller: service.controller, entity: 'contacts', record: null, writable: true, onSaved() {}, onClose() {}, ...props },
  { componentName: 'ContactEditor', expandChildren: ['ContactForm'] });

test('new contact: Origin defaults, fields by Tipo da Pessoa and the whole form in one payload', async () => {
  const service = editorServer(), saved = [];
  const view = await mountEditor(service, { onSaved: record => saved.push(record) });
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    assert.deepEqual([view.input('contact-person_type').props.value, view.input('contact-taxpayer').props.value, view.input('contact-client_since').props.value, view.input('contact-situation').props.value],
      ['F', '9', today, 'A']);
    assert.ok(view.input('contact-rg')); assert.throws(() => view.input('contact-crt'), 'CRT is only for Pessoa Jurídica');
    assert.match(view.text(), /CPF/);
    await view.change('contact-name', 'Empresa Sintética'); await view.change('contact-rg', '1234');
    await view.change('contact-person_type', 'J');
    assert.throws(() => view.input('contact-rg')); assert.ok(view.input('contact-crt')); assert.ok(view.input('contact-ie_exempt'));
    assert.match(view.text(), /CNPJ/);
    await view.change('contact-ie_exempt', 'true');
    assert.equal(view.input('contact-taxpayer').props.value, '2', 'IE Isento suggests Contribuinte 2');
    assert.equal(view.input('contact-ie').disabled, true);
    await view.change('contact-complement', 'Sala 2');
    assert.match(view.text(), /6\/200/, 'Complemento counter');
    assert.equal(view.guard().changed, true);
    await view.submit();
    const post = service.writes()[0];
    assert.equal(post.path, '/v1/cadastros/contatos'); assert.equal(post.method, 'POST');
    assert.deepEqual(post.body.acknowledged_warnings, undefined, 'no CPF/CNPJ typed: no check');
    assert.equal(post.body.data.name, 'Empresa Sintética'); assert.equal(post.body.data.rg, null, 'fields of another person type are cleared');
    assert.equal(post.body.data.ie_exempt, true); assert.equal(post.body.data.taxpayer, '2'); assert.equal(post.body.data.credit_limit_mode, 'unlimited');
    assert.deepEqual(post.body.data.types, []); assert.deepEqual(post.body.data.persons, []);
    assert.ok(Object.hasOwn(post.body.data, 'billing_city') && Object.hasOwn(post.body.data, 'next_visit'));
    assert.equal(saved.length, 1, 'the saved contact is read again and reported');
  } finally { view.unmount(); }
});

test('warnings: an invalid CPF asks "Salvar mesmo assim"; a duplicate forbidden by Preferências cannot be confirmed', async () => {
  const service = editorServer({ checks: [[{ code: 'invalid_document', field: 'document', expected: 'cpf' }], [{ code: 'duplicate_document', field: 'document', total: 1, blocked: true, matches: [{ id: ids.bia, name: 'Bia', code: null, active: true }] }]] });
  const view = await mountEditor(service);
  try {
    await view.change('contact-name', 'Contato'); await view.change('contact-document', '529.982.247-24'); await view.submit();
    assert.match(view.text(), /O CPF informado não confere com os dígitos verificadores\./);
    assert.equal(service.writes().length, 0);
    await view.click('Salvar mesmo assim');
    assert.deepEqual(service.writes()[0].body.acknowledged_warnings, ['invalid_document']);
  } finally { view.unmount(); }
  const second = editorServer({ checks: [[{ code: 'duplicate_document', field: 'document', total: 1, blocked: true, matches: [{ id: ids.bia, name: 'Bia', code: null, active: true }] }]] });
  const blocked = await mountEditor(second);
  try {
    await blocked.change('contact-name', 'Contato'); await blocked.change('contact-document', '529.982.247-25'); await blocked.submit();
    assert.match(blocked.text(), /As Preferências não permitem CPF \/ CNPJ duplicado\./);
    assert.throws(() => blocked.button('Salvar mesmo assim'));
    assert.equal(second.writes().length, 0);
  } finally { blocked.unmount(); }
});

test('unknown save result: "Conferir resultado" repeats the same command; required fields come from Preferências', async () => {
  const service = editorServer({ saves: [new AccessError(503)] }), saved = [];
  const view = await mountEditor(service, { onSaved: record => saved.push(record) });
  try {
    await view.change('contact-name', 'Contato'); await view.submit();
    assert.match(view.text(), /Não foi possível confirmar o resultado/);
    assert.equal(view.guard().busy, true, 'an uncertain save keeps the unsaved guard');
    await view.click('Conferir resultado');
    const writes = service.writes();
    assert.equal(writes.length, 2); assert.equal(writes[1].body.command_id, writes[0].body.command_id);
    assert.equal(saved.length, 1);
  } finally { view.unmount(); }
  const strict = editorServer({ required: ['cep', 'rg'] }), form = await mountEditor(strict);
  try {
    assert.match(form.text(), /CEP \*/); assert.match(form.text(), /RG \*/);
    await form.change('contact-name', 'Contato'); await form.submit();
    assert.match(form.text(), /O campo CEP é obrigatório/);
    assert.equal(strict.writes().length, 0);
    await form.change('contact-person_type', 'J');
    assert.doesNotMatch(form.text(), /RG \*/, 'RG is only required where it exists (Pessoa Física)');
  } finally { form.unmount(); }
});

test('an existing contact is read in full before editing; Excluído is read-only; the PATCH carries the full record version', async () => {
  const service = editorServer({ checks: [[]] });
  const legacy = { id: ids.ana, entity: 'contacts', version: 4, active: true, name: 'Ana Cliente', code: 'C-1', created_at: stamp, updated_at: stamp, roles: ['customer'], source: null };
  const view = await mountEditor(service, { record: legacy });
  try {
    assert.equal(service.calls[0].path, `/v1/cadastros/contatos/${ids.ana}`);
    assert.equal(view.input('contact-avg_tax_load').props.value, '12,50');
    assert.match(view.text(), /Alterado em .*por Administrador/);
    await view.change('contact-name', 'Ana Cliente Alterada'); await view.submit();
    const patch = service.writes()[0];
    assert.equal(patch.method, 'PATCH'); assert.equal(patch.body.expected_version, 4); assert.equal(patch.body.data.avg_tax_load, '12.50'); assert.equal(patch.body.data.rg, '12.345.678-9');
  } finally { view.unmount(); }
  const excluded = editorServer(), readOnly = await mountEditor(excluded, { record: { ...FULL, situation: 'E', active: false } });
  try {
    assert.match(readOnly.text(), /Cadastro excluído\. Para editar, restaure-o/);
    assert.throws(() => readOnly.button('Salvar'));
    assert.equal(readOnly.input('contact-name').disabled, true);
  } finally { readOnly.unmount(); }
});

test('read-only and excluded contacts: the fields stay disabled, but Cobrança, Dados adicionais and the client history still open', async () => {
  for (const props of [{ writable: false, record: { ...FULL, billing_city: 'Campinas' } }, { writable: true, record: { ...FULL, situation: 'E', active: false, billing_city: 'Campinas' } }]) {
    const service = editorServer(), view = await mountComponent('ContactEditor.tsx', { controller: service.controller, entity: 'contacts', onSaved() {}, onClose() {}, ...props },
      { componentName: 'ContactEditor', expandChildren: ['ContactForm', 'ContactSalesHistory'] });
    try {
      assert.throws(() => view.button('Salvar'));
      for (const id of ['contact-name', 'contact-situation', 'contact-credit_unlimited', 'contact-finance_category_id']) assert.equal(view.input(id).disabled, true, id);
      await view.click('Cobrança');
      assert.equal(view.input('contact-billing_city').props.value, 'Campinas', 'the billing address can be read');
      assert.equal(view.input('contact-billing_city').disabled, true);
      assert.equal(byAria(view, 'Visualizar histórico do cliente').disabled, false, 'the client history opens');
      assert.equal(view.nodes().find(node => node.type === 'button' && node.props.className === 'contact-collapse').disabled, false, 'Dados adicionais can be collapsed');
      assert.equal(service.writes().length, 0);
    } finally { view.unmount(); }
  }
});

test('a failed or refused CPF/CNPJ check never saves, and editing the field discards a stale warning', async () => {
  const service = editorServer({ checks: [[{ code: 'invalid_document', field: 'document', expected: 'cpf' }], new AccessError(503), new AccessError(400)] });
  const view = await mountEditor(service);
  try {
    await view.change('contact-name', 'Contato'); await view.change('contact-document', '529.982.247-24'); await view.submit();
    assert.ok(view.button('Salvar mesmo assim'));
    await view.change('contact-document', '529.982.247-25');
    assert.throws(() => view.button('Salvar mesmo assim'), 'editing the field discards the stale warning');
    await view.submit();
    assert.match(view.text(), /Não foi possível conferir os avisos do cadastro\. Nada foi gravado/);
    assert.equal(view.guard().busy, false, 'a failed check leaves no uncertain command');
    await view.submit();
    assert.match(view.text(), /Confira os campos informados antes de tentar novamente\./, 'a refused check points to the fields, as the save would');
    assert.equal(service.writes().length, 0);
  } finally { view.unmount(); }
});

// Financeiro (wave C, CTT-075): Categoria is the árvore com busca of receitas and despesas, with "Sem categoria".
test('contact Categoria: the finance category tree of receitas and despesas, saved with the contact', async () => {
  const { categoryTreeResponse, chooseCategory } = await import('./helpers/finance-category-tree-fixture.mjs');
  const service = editorServer(), RECEITA = '95000000-0000-4000-8000-0000000000c1', DESPESA = '95000000-0000-4000-8000-0000000000c2';
  service.controller.finance = async path => { const kind = new URL(path, 'https://x.invalid').searchParams.get('kind'); return categoryTreeResponse(kind, [{ id: RECEITA, name: 'Vendas sintéticas', kind: 'receivable' }, { id: DESPESA, name: 'Compras sintéticas', kind: 'payable' }]); };
  const view = await mountComponent('ContactEditor.tsx', { controller: service.controller, entity: 'contacts', record: null, writable: true, onSaved() {}, onClose() {} },
    { componentName: 'ContactEditor', expandChildren: ['ContactForm', 'CategoryTreePicker', 'TreeList'] });
  try {
    await view.change('contact-name', 'Contato com categoria');
    await chooseCategory(view, 'contact-finance_category_id', 'Compras sintéticas');
    await view.submit();
    assert.equal(service.writes()[0].body.data.finance_category_id, DESPESA);
  } finally { view.unmount(); }
});

test('contact sales popover identifies excluded mirrors without treating them as missing sales',async()=>{
 const controller={catalog:async()=>({contact_id:ids.ana,visible:true,items:[],origin:'brufap',mirror_excluded_count:2,coverage:{partial:true,reason:'native_effects_only'}})};
 const view=await mountComponent('ContactSalesHistory.tsx',{controller,contactId:ids.ana},{componentName:'ContactSalesHistory'});
 try{view.nodes().find(n=>n.props?.['aria-label']==='Visualizar histórico do cliente').props.onClick();await view.flush();assert.match(view.text(),/2 documentos Origin não entram neste cálculo/);}finally{view.unmount();}
});
