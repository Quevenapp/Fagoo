import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Contatos lane, wave C: Imprimir etiquetas with a selection, Ficha financeira, Aniversariantes up to 366 days, the
// Vendedor check on a Tipo da Pessoa change, specific refusals in the form, the contact tools of the pickers and the full
// "Contato rápido". Synthetic data only.
const listeners = [];
globalThis.document = { activeElement: null, getElementById: () => null, body: { classList: { add() {}, remove() {} }, append() {}, style: {}, children: [] }, createElement: () => ({ remove() {} }),
  addEventListener: (type, fn) => listeners.push(fn), removeEventListener() {} };
const actor = '97000000-0000-4000-8000-0000000000aa', other = '97000000-0000-4000-8000-0000000000bb', stamp = '2026-10-20T12:00:00+00:00';
const uuid = n => `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const component = (view, name) => view.find(node => node.type?.name === name);
const byAria = (view, label) => view.find(node => (node.type === 'button' || node.type === 'a') && node.props['aria-label'] === label);
// The picker searches after a 250 ms pause: wait for that read before the next step, so no late update races a flush.
const until = async (view, done) => { for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(done(), 'the debounced read happened'); await view.flush(); };
const refusal = (status, code, field) => Object.assign(new AccessError(status), { code, ...(field ? { field } : {}) });
const TYPES = [['customer', 'Cliente'], ['supplier', 'Fornecedor'], ['carrier', 'Transportador']].map(([slug, label], index) => ({ id: uuid(100 + index), slug, label, system: true, deletable: false, position: index + 1, contacts: 0 }));
const item = (id, name, extra = {}) => ({ id, entity: 'contacts', version: 2, active: true, situation: 'A', name, code: null, trade_name: null, person_type: 'J', document: null, email: null, phone: null, mobile: null,
  city: 'Piracicaba', state: 'SP', roles: ['supplier'], types: ['supplier'], crt: null, seller_id: null, seller_name: null, next_visit: null, is_seller: false, created_at: stamp, updated_at: stamp, source: null, ...extra });
const ROWS = [item(uuid(1), 'Ana Fornecedora'), item(uuid(2), 'Bia Fornecedora')];
const LABEL = { label: { width: '100', height: '40', font: 'helvetica', font_size: '9', barcode: 'c128', barcode_text: true, currency: false, show_labels: false, columns_gap: '3', rows_gap: '0' },
  page: { size: 'A4', width: null, height: null, orientation: 'portrait', margin_left: '5', margin_top: '10' },
  fields: [{ field: 'nome', x: '4', y: '4', size: '10', bold: true, barcode: false }, { field: 'endereco', x: '4', y: '11', size: '9', bold: false, barcode: false }] };
const TEMPLATES = [{ id: 'padrao-contato', type: 'contato', description: 'Etiqueta de contato', default: true, config: LABEL, version: 0, updated_at: null },
  { id: uuid(300), type: 'contato', description: 'Envelope sintético', default: false, config: { ...LABEL, label: { ...LABEL.label, width: '200' } }, version: 1, updated_at: stamp }];
const values = name => ({ nome: name, fantasia: null, documento: null, endereco: 'Rua Sintética, 1', bairro: 'Centro', cidade_uf: 'Piracicaba/SP', cep: '13400-000', telefone: null });

function listServer({ role = 'admin', labels } = {}) {
  const calls = [], snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {}, retry() {},
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method });
      if (path === '/v1/cadastros') return { read: ['contacts'], write: role === 'consulta' ? [] : ['contacts'], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_types', can_create: true, can_delete: true, items: TYPES, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/contatos/etiquetas?')) { if (labels) return labels(path); const ids = new URLSearchParams(path.split('?')[1]).get('ids').split(','); return { scope: 'contact_labels', templates: TEMPLATES, items: ids.map(id => ({ id, values: values(ROWS.find(r => r.id === id)?.name ?? 'X') })), data_mode: 'erp_native' }; }
      if (path.startsWith('/v1/cadastros/contatos?')) { const params = new URLSearchParams(path.split('?')[1]); return { entity: 'contacts', items: ROWS, page: Number(params.get('page')), size: 100, total: ROWS.length, sort: 'created_desc', situation: 'latest', scoped: false, data_mode: 'erp_native' }; }
      if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return { scope: 'seller_options', users: [], items: [], data_mode: 'erp_native' };
      throw new Error(`unexpected ${path}`);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.contatos', version: 0, columns: null, filters: null, updated_at: null }; },
    async preferences() { return { items: [] }; }, async finance() { return { items: [] }; }, async fiscalInvoices() { throw new AccessError(403); },
  };
  return { calls, controller, snapshot };
}
const mountList = service => mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'contacts' }, { expandChildren: ['NativeListLayout', 'ContactCatalog'], location: '/cadastros-reais?cadastro=contacts&contato=fornecedor' });

test('Fornecedores list: Imprimir etiquetas works with a selection and Ficha financeira opens the ficha of the contact', async () => {
  const service = listServer(), view = await mountList(service);
  try {
    assert.equal(view.button('Imprimir etiquetas').disabled, true, 'needs a selection (Origin CL-25)');
    assert.ok(component(view, 'ToolButton'), 'Imprimir listagem de contatos stays on the Fornecedores shortcut');
    view.find(node => node.props?.['aria-label'] === 'Selecionar Bia Fornecedora').props.onClick({ shiftKey: false }); await view.flush();
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label).at(-1), 'Selecionados: 1 cadastro');
    assert.equal(view.button('Imprimir etiquetas').disabled, false);
    assert.equal(view.button('Aniversariantes').disabled, true, 'Mais ações > Imprimir is off with a selection');
    await view.click('Imprimir etiquetas');
    const labels = component(view, 'ContactLabelsPrint').props;
    assert.deepEqual(labels.ids, [uuid(2)]);
    const menu = view.nodes().filter(node => node.type?.name === 'RowMenu')[0].props.items, ficha = menu.find(entry => entry.label === 'Ficha financeira');
    assert.equal(ficha.disabled, false); ficha.onClick(); await view.flush();
    assert.equal(`${view.location().pathname}${view.location().search}`, `/financeiro-empresa?area=ficha&contato=${uuid(1)}`, 'only the id goes to the address');
  } finally { view.unmount(); }
  const vendas = listServer({ role: 'vendas' }), restricted = await mountList(vendas);
  try {
    const ficha = restricted.nodes().filter(node => node.type?.name === 'RowMenu')[0].props.items.find(entry => entry.label === 'Ficha financeira');
    assert.deepEqual([ficha.disabled, ficha.title], [true, 'Seu perfil não consulta o financeiro.']);
  } finally { restricted.unmount(); }
});

test('ContactLabelsPrint: Contato models, copies, pages and a late answer after the session changed', async () => {
  const service = listServer();
  const view = await mountComponent('ContactLabelsPrint.tsx', { controller: service.controller, ids: [uuid(1), uuid(2)], onClose() {} }, { componentName: 'ContactLabelsPrint' });
  try {
    assert.equal(service.calls.at(-1).path, `/v1/cadastros/contatos/etiquetas?ids=${encodeURIComponent(`${uuid(1)},${uuid(2)}`)}`);
    assert.deepEqual(view.input('contact-labels-template').props.children.map(option => textOf(option)), ['Etiqueta de contato (Padrão)', 'Envelope sintético']);
    assert.equal(view.nodes().filter(node => node.type?.name === 'LabelSvg').length, 2);
    assert.match(view.text(), /2 etiqueta\(s\) em 1 página\(s\) de 14/);
    await view.change('contact-labels-copies', '3');
    assert.equal(view.nodes().filter(node => node.type?.name === 'LabelSvg').length, 6);
    await view.change('contact-labels-template', uuid(300));
    assert.match(view.text(), /6 etiqueta\(s\) em 1 página\(s\) de 7/, 'a 200 mm label fits one column');
    await view.change('contact-labels-copies', '0');
    assert.match(view.text(), /Informe de 1 a 100 cópias/); assert.equal(view.button('Imprimir etiquetas').disabled, true);
  } finally { view.unmount(); }
  let release; const gate = new Promise(resolve => { release = resolve; });
  const late = listServer({ labels: async path => { await gate; const ids = new URLSearchParams(path.split('?')[1]).get('ids').split(','); return { scope: 'contact_labels', templates: TEMPLATES, items: ids.map(id => ({ id, values: values('X') })), data_mode: 'erp_native' }; } });
  const waiting = await mountComponent('ContactLabelsPrint.tsx', { controller: late.controller, ids: [uuid(1)], onClose() {} }, { componentName: 'ContactLabelsPrint' });
  try {
    late.snapshot.membership = { user_id: other, role: 'admin' }; release(); await waiting.flush();
    assert.equal(waiting.nodes().some(node => node.type?.name === 'LabelSvg'), false, 'the other user never sees the labels');
  } finally { waiting.unmount(); }
  const hidden = listServer({ labels: () => { throw refusal(403, 'ERP_CONTACT_NOT_VISIBLE'); } });
  const refused = await mountComponent('ContactLabelsPrint.tsx', { controller: hidden.controller, ids: [uuid(1)], onClose() {} }, { componentName: 'ContactLabelsPrint' });
  try { assert.match(refused.text(), /não pertence à carteira do seu vendedor/); } finally { refused.unmount(); }
});

test('Aniversariantes: a period over 366 days says so and is never sent', async () => {
  const service = listServer();
  const request = { kind: 'birthdays', state: { sort: 'name_asc', query: '', type: '', filters: { situation: 'all', person_type: '', phone: '', email: '', state: '', city: '', seller: null, sale_statuses: [] }, period: { field: 'next_visit', from: '', to: '' } }, columns: ['name'] };
  const view = await mountComponent('ContactListPrint.tsx', { controller: service.controller, request, types: [], onClose() {} }, { componentName: 'ContactListPrint' });
  try {
    await view.change('contact-birth-from', '2026-01-01'); await view.change('contact-birth-to', '2027-01-03');
    assert.match(view.text(), /pode ter no máximo 366 dias/, '367 days'); assert.equal(view.button('Gerar').disabled, true);
    await view.change('contact-birth-to', '2027-01-02');
    assert.doesNotMatch(view.text(), /366 dias/); assert.equal(view.button('Gerar').disabled, false, '366 days are accepted');
    await view.change('contact-birth-from', '2028-01-01'); await view.change('contact-birth-to', '2029-01-01');
    assert.equal(view.button('Gerar').disabled, false, 'a leap year with its last day');
    await view.change('contact-birth-to', '2025-12-31');
    assert.match(view.text(), /o fim não pode ser anterior ao início/);
    assert.equal(service.calls.some(call => call.path.includes('/exportar')), false);
  } finally { view.unmount(); }
});

const sellerContact = { id: uuid(10), entity: 'contacts', version: 3, active: true, created_at: stamp, updated_at: stamp, name: 'Vendedora Sintética', code: null, person_type: 'F', document: '11.222.333/0001-81', situation: 'A', roles: [], types: ['seller'], persons: [],
  source: null, ie_exempt: false, credit_limit_mode: 'unlimited', taxpayer: '9', state: 'SP', city: 'Piracicaba', seller_record_id: uuid(11), finance_category_name: null, operation_nature_name: null, seller_name: null, updated_by_name: null };
const sellerDto = { id: uuid(11), contact_id: uuid(10), version: 1, user_id: null, user_name: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: 'parcial', commission_mode: 'fixa', commission_rate: null, commission_bands: [], discount_limit: '0.0000', notes: null, created_at: stamp, updated_at: stamp };
test('Vendedor form: changing only the Tipo da Pessoa checks the CPF/CNPJ again; a refusal names its reason', async () => {
  const calls = [], snapshot = { phase: 'ready', membership: { user_id: actor, role: 'admin' } };
  let saveFailure = refusal(409, 'ERP_SELLER_USER_TAKEN');
  const controller = { getSnapshot: () => snapshot, subscribe: () => () => {}, async preferences() { return { items: [] }; }, async catalog(path, options = {}) {
    calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
    if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_types', can_create: true, can_delete: true, items: TYPES, data_mode: 'erp_native' };
    if (path.startsWith('/v1/cadastros/vendedores?')) return { entity: 'sellers', items: [{ ...item(uuid(10), 'Vendedora Sintética', { types: ['seller'], roles: [], is_seller: true }), seller_id: uuid(11), seller_version: 1 }], page: 1, size: 100, total: 1, sort: 'created_desc', situation: 'latest', can_write: true, data_mode: 'erp_native' };
    if (path === `/v1/cadastros/vendedores/${uuid(11)}` && !options.method) return { entity: 'sellers', seller: sellerDto, contact: sellerContact, can_write: true, users: [], data_mode: 'erp_native' };
    if (path === '/v1/cadastros/contatos/conferir') return { entity: 'contacts', warnings: [], data_mode: 'erp_native' };
    if (options.method === 'PATCH') { if (saveFailure) { const failure = saveFailure; saveFailure = null; throw failure; } return { entity: 'sellers', seller: { ...sellerDto, version: 2 }, contact: sellerContact, replayed: false, data_mode: 'erp_native' }; }
    throw new Error(path);
  } };
  const view = await mountComponent('RealSellers.tsx', { controller }, { expandChildren: ['NativeListLayout', 'SellerEditor', 'SellerForm'] });
  try {
    await view.click('Vendedora Sintética');
    await view.change('seller-person_type', 'J'); await view.submit();
    const check = calls.find(call => call.path === '/v1/cadastros/contatos/conferir');
    assert.ok(check, 'the unchanged CNPJ is checked again under the new Tipo da Pessoa');
    assert.deepEqual([check.body.id, check.body.data.person_type, check.body.data.document], [uuid(10), 'J', '11.222.333/0001-81']);
    assert.match(view.text(), /Este usuário do sistema já está vinculado a outro vendedor/);
  } finally { view.unmount(); }
});

const FULL = { id: uuid(20), entity: 'contacts', version: 4, active: true, created_at: stamp, updated_at: stamp, name: 'Ana Cliente', code: null, trade_name: null, person_type: 'F', document: null, ie: null, email: null,
  phone: null, mobile: null, postal_code: null, street: null, number: null, complement: null, district: null, city: null, state: 'SP', situation: 'A', roles: ['customer'], types: ['customer'], persons: [], source: null,
  ie_exempt: false, credit_limit_mode: 'unlimited', credit_limit: null, crt: null, client_since: '2020-01-01', taxpayer: '9', seller_id: null, seller_name: null, finance_category_id: null, finance_category_name: null,
  operation_nature_id: null, operation_nature_name: null, updated_by_name: 'Administrador', seller_record_id: null, notes: null };
test('contact form: a required field refused by the server is named and highlighted; a hidden contact says why', async () => {
  const failures = [refusal(400, 'ERP_CONTACT_REQUIRED_FIELD', 'email'), refusal(403, 'ERP_CONTACT_NOT_VISIBLE')];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {}, async catalog(path, options = {}) {
    if (path === '/v1/cadastros/tipos-contato') return { scope: 'contact_types', can_create: true, can_delete: false, items: TYPES, data_mode: 'erp_native' };
    if (path === '/v1/cadastros/contatos/codigo') return { scope: 'contact_code', mode: 'manual', next_number: '1', version: 0, highest_used: '0', can_edit: false, data_mode: 'erp_native' };
    if (options.method) throw failures.shift();
    throw new Error(path);
  }, async preferences() { return { items: [] }; }, async finance() { return { items: [] }; }, async fiscalInvoices() { throw new AccessError(403); } };
  const view = await mountComponent('ContactEditor.tsx', { controller, entity: 'contacts', record: FULL, writable: true, onSaved() {}, onClose() {} }, { componentName: 'ContactEditor', expandChildren: ['ContactForm'] });
  try {
    await view.change('contact-name', 'Ana Cliente Sintética'); await view.submit();
    assert.match(view.text(), /O campo E-Mail é obrigatório \(Preferências › Configurações de clientes e fornecedores\)/);
    assert.equal(view.input('contact-email').props['aria-invalid'], true);
    assert.doesNotMatch(view.text(), /Conferir resultado/, 'a definitive refusal is not an unknown outcome');
    await view.change('contact-email', 'ana@sintetico.test');
    assert.equal(view.input('contact-email').props['aria-invalid'], undefined);
    await view.submit();
    assert.match(view.text(), /não pertence à carteira do seu vendedor/);
  } finally { view.unmount(); }
});

function pickerServer({ notes = 'Entregar só pela manhã.', persons = 1 } = {}) {
  const calls = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'estoque' } }), async stockPositions() { throw new Error('no stock'); }, async catalog(path, options = {}) {
    calls.push(path);
    if (path.startsWith('/v1/cadastros/contatos/opcoes?')) return { scope: 'contact_options', role: null, limit: 25, scoped: false, has_more: false, data_mode: 'erp_native',
      items: [{ ...item(uuid(30), 'Fornecedor Sintético'), has_notes: true, persons, trade_name: 'Peças Sintéticas', document: '11.222.333/0001-81' }] };
    if (path === `/v1/cadastros/contatos/${uuid(30)}/resumo`) return { scope: 'contact_summary', id: uuid(30), name: 'Fornecedor Sintético', code: null, situation: 'A', notes, contact_info: null, data_mode: 'erp_native',
      persons: Array.from({ length: persons }, (_, i) => ({ id: uuid(40 + i), name: `Pessoa ${i + 1}`, code: null, situation: 'A', visible: true, email: 'pessoa@sintetico.test', phone: '(19) 3000-0000', mobile: null })) };
    if (path.startsWith(`/v1/cadastros/contatos/${uuid(30)}/historico?`)) return { scope: 'contact_history', contact_id: uuid(30), kind: 'purchase_orders', visible: true, data_mode: 'erp_native',
      items: [{ id: uuid(50), number: '12', date: '2026-10-15', status: 'in_progress', total: '1234.50' }] };
    throw new Error(path);
  } };
  return { calls, controller };
}
test('contact picker: scoped search, Observações card, pessoas de contato, Editar Contato, histórico and the ENTER busca avançada', async () => {
  const service = pickerServer(), chosen = [];
  const props = { controller: service.controller, entity: 'contacts', label: 'Fornecedor *', selected: null, onSelect: row => chosen.push(row), contactTools: { history: 'purchase_orders' } };
  const view = await mountComponent('DocumentCatalogPicker.tsx', props, { componentName: 'CatalogPicker', expandChildren: ['ContactPickerTools', 'ContactSearchDialog', 'Modal'] });
  try {
    await until(view, () => service.calls.includes('/v1/cadastros/contatos/opcoes?limit=25'));
    assert.ok(service.calls.some(path => path === '/v1/cadastros/contatos/opcoes?limit=25'), 'pickers search the contacts picker (seller scope)');
    assert.throws(() => byAria(view, 'Visualizar pessoas de contato'), 'no contact, no eye');
    await view.updateProps({ selected: { id: uuid(30), name: 'Fornecedor Sintético' } });
    assert.match(view.find(node => node.props?.className === 'contact-notes-card').props.children, /Entregar só pela manhã/);
    byAria(view, 'Visualizar pessoas de contato').props.onClick(); await view.flush();
    assert.match(view.text(), /Pessoa 1.*\(19\) 3000-0000.*pessoa@sintetico\.test/);
    assert.equal(byAria(view, 'Editar Contato').props.href, `/cadastros-reais?cadastro=contacts&registro=${uuid(30)}`);
    assert.equal(byAria(view, 'Editar Contato').props.target, '_blank');
    byAria(view, 'Visualizar histórico do cliente').props.onClick(); await view.flush(); // the Origin label, also on the Fornecedor field
    assert.ok(service.calls.includes(`/v1/cadastros/contatos/${uuid(30)}/historico?tipo=pedidos-compra`));
    assert.match(view.text(), /Últimos registros deste fornecedor.*12.*15\/10\/2026.*Em andamento.*R\$ 1\.234,50/);
    let prevented = false;
    const field = () => view.find(node => node.type === 'input' && node.props.type === 'search' && node.props.maxLength === 120 && node.props.id?.startsWith('picker-'));
    field().props.onChange({ target: { value: 'Forn' } }); await view.flush(); await until(view, () => service.calls.includes('/v1/cadastros/contatos/opcoes?limit=25&q=Forn'));
    field().props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; }, nativeEvent: {} }); await view.flush();
    assert.equal(prevented, true, 'ENTER never submits the document');
    assert.equal(view.input('contact-search-query').props.value, 'Forn', 'the typed text goes to the busca avançada');
    assert.equal(service.calls.at(-1), '/v1/cadastros/contatos/opcoes?limit=50&q=Forn', 'and is searched right away');
    await view.change('contact-search-query', 'peças'); await view.change('contact-search-city', 'Piracicaba');
    view.input('contact-search-city').props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }); await view.flush();
    assert.equal(service.calls.at(-1), '/v1/cadastros/contatos/opcoes?limit=50&q=pe%C3%A7as&cidade=Piracicaba');
    assert.match(view.text(), /Peças Sintéticas.*11\.222\.333\/0001-81.*Piracicaba\/SP/);
    await view.click('Selecionar');
    assert.deepEqual(chosen.map(row => row.id), [uuid(30)]);
    assert.equal(view.nodes().some(node => node.props?.id === 'contact-search-query'), false, 'the dialog closes after the choice');
  } finally { view.unmount(); }
  const plain = pickerServer({ notes: null, persons: 0 });
  const empty = await mountComponent('DocumentCatalogPicker.tsx', { ...props, controller: plain.controller, selected: { id: uuid(30), name: 'Fornecedor Sintético' } }, { componentName: 'CatalogPicker', expandChildren: ['ContactPickerTools'] });
  try {
    assert.equal(byAria(empty, 'Visualizar pessoas de contato').disabled, true, 'nothing to show, no enabled eye');
    assert.equal(empty.nodes().some(node => node.props?.className === 'contact-notes-card'), false);
  } finally { empty.unmount(); }
});

test('Contato rápido: the full Origin fields go to the Clientes e fornecedores route; a required field refusal is named', async () => {
  const posts = [];
  let answer = () => { throw refusal(400, 'ERP_CONTACT_REQUIRED_FIELD', 'nfe_email'); };
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), async catalog(path, options = {}) {
    if (options.method === 'POST') { posts.push({ path, body: structuredClone(options.body) }); return answer(); }
    if (path === `/v1/cadastros/contatos/${uuid(60)}`) return { entity: 'contacts', record: { ...FULL, id: uuid(60), name: 'Cliente Estrangeiro', person_type: 'E' }, data_mode: 'erp_native' };
    throw new Error(path);
  } };
  const created = [];
  const initial = { name: 'Cliente Estrangeiro', person_type: 'J', document: '', phone: '', mobile: '', email: '', roles: ['customer'] };
  const view = await mountComponent('DocumentQuickContact.tsx', { controller, kind: 'sales_orders', initial, onCreated: record => created.push(record), onClose() {} }, { expandChildren: ['Modal'] });
  try {
    assert.equal(view.input('quick-contact-situation-A').props.checked, true);
    assert.equal(view.input('quick-contact-taxpayer').props.value, '9');
    await view.change('quick-contact-person-type', 'E');
    assert.ok(view.input('quick-contact-country')); assert.throws(() => view.input('quick-contact-rg'), 'RG is for Pessoa Física');
    await view.change('quick-contact-country', 'Argentina'); await view.change('quick-contact-taxpayer', '2');
    await view.change('quick-contact-nfe-email', 'nfe@sintetico.test'); await view.change('quick-contact-info', 'Falar com o comprador');
    await view.change('quick-contact-notes', 'Entrega pelo porto'); view.input('quick-contact-situation-S').props.onChange(); await view.flush();
    await view.submit();
    assert.equal(posts[0].path, '/v1/cadastros/contatos');
    const data = posts[0].body.data;
    assert.deepEqual([data.person_type, data.country, data.taxpayer, data.nfe_email, data.contact_info, data.notes, data.situation, data.rg, data.birth_date, data.types, data.roles],
      ['E', 'Argentina', '2', 'nfe@sintetico.test', 'Falar com o comprador', 'Entrega pelo porto', 'S', null, null, ['customer'], undefined]);
    assert.match(view.text(), /O campo E-mail para envio da NFe é obrigatório|O campo E-Mail para envio da NFe é obrigatório/);
    assert.equal(view.input('quick-contact-nfe-email').props['aria-invalid'], true);
    answer = () => ({ entity: 'contacts', record: { ...FULL, id: uuid(60), name: 'Cliente Estrangeiro', person_type: 'E' }, replayed: false, data_mode: 'erp_native' });
    await view.submit();
    assert.equal(posts.length, 2); assert.notEqual(posts[0].body.command_id, posts[1].body.command_id, 'a definitive refusal starts a new command');
    assert.deepEqual(created.map(record => record.id), [uuid(60)]);
  } finally { view.unmount(); }
});

test('Contato rápido: Campos obrigatórios of the Preferências are marked and checked before sending', async () => {
  const posts = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }),
    async preferences(path) { assert.equal(path, '/v1/preferencias/cadastros-contatos'); return { items: [{ key: 'contatos.campos_obrigatorios', value: ['email', 'rg', 'profissao'], version: 1 }] }; },
    async catalog(path, options = {}) { if (options.method === 'POST') { posts.push(options.body); return { entity: 'contacts', record: { ...FULL, id: uuid(61) }, replayed: false, data_mode: 'erp_native' }; }
      if (path === `/v1/cadastros/contatos/${uuid(61)}`) return { entity: 'contacts', record: { ...FULL, id: uuid(61) }, data_mode: 'erp_native' }; throw new Error(path); } };
  const initial = { name: 'Cliente Sintético', person_type: 'J', document: '', phone: '', mobile: '', email: '', roles: ['customer'] };
  const view = await mountComponent('DocumentQuickContact.tsx', { controller, kind: 'purchase_orders', initial: { ...initial, roles: ['supplier'] }, onCreated() {}, onClose() {} }, { expandChildren: ['Modal'] });
  try {
    const label = id => textOf(view.find(node => node.type === 'label' && node.props.htmlFor === id).props.children);
    assert.equal(label('quick-contact-email'), 'E-mail *');
    assert.throws(() => view.input('quick-contact-rg'), 'RG only exists for Pessoa Física');
    await view.submit();
    assert.match(view.text(), /O campo E-Mail é obrigatório/); assert.equal(posts.length, 0, 'nothing is sent');
    assert.equal(view.input('quick-contact-email').props['aria-invalid'], true);
    await view.change('quick-contact-person-type', 'F'); assert.equal(label('quick-contact-rg'), 'RG *');
    await view.change('quick-contact-email', 'compras@sintetico.test'); await view.change('quick-contact-rg', '12.345');
    await view.submit();
    assert.equal(posts.length, 1, 'Profissão is not in the quick contact: the server decides it');
  } finally { view.unmount(); }
});

test('Contato rápido: Situação Inativo creates the contact once, never asks to confirm it again and does not select it', async () => {
  const posts = [], reads = [];
  const inactive = { ...FULL, id: uuid(62), name: 'Cliente Inativo', active: false, situation: 'I' };
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), async catalog(path, options = {}) {
    if (options.method === 'POST') { posts.push(structuredClone(options.body)); return { entity: 'contacts', record: inactive, replayed: posts.length > 1, data_mode: 'erp_native' }; }
    if (path === `/v1/cadastros/contatos/${uuid(62)}`) { reads.push(path); return { entity: 'contacts', record: inactive, data_mode: 'erp_native' }; }
    throw new Error(path);
  } };
  const created = [];
  const initial = { name: 'Cliente Inativo', person_type: 'J', document: '', phone: '', mobile: '', email: '', roles: ['customer'] };
  const view = await mountComponent('DocumentQuickContact.tsx', { controller, kind: 'sales_orders', initial, onCreated: record => created.push(record), onClose() {} }, { expandChildren: ['Modal'] });
  try {
    view.input('quick-contact-situation-I').props.onChange(); await view.flush();
    await view.submit();
    assert.equal(posts.length, 1); assert.equal(posts[0].data.situation, 'I');
    assert.equal(reads.length, 1, 'the created contact is read again');
    assert.match(view.text(), /cadastrado com a situação Inativo/);
    assert.equal(view.nodes().some(node => node.type === 'button' && textOf(node.props.children) === 'Conferir resultado'), false, 'a saved contact is never sent again');
    assert.equal(view.nodes().some(node => node.type === 'button' && textOf(node.props.children) === 'Salvar'), false);
    assert.deepEqual(created, [], 'an inactive contact is not chosen in the document');
  } finally { view.unmount(); }
});

test('contact history keeps the contact-scoped native coverage visible',async()=>{
 const service=pickerServer(),read=service.controller.catalog;
 service.controller.catalog=async(...args)=>{const raw=await read(...args);return args[0].includes('/historico?')?{...raw,origin:'brufap',mirror_excluded_count:2,coverage:{partial:true,reason:'native_effects_only'}}:raw;};
 const view=await mountComponent('ContactPickerTools.tsx',{controller:service.controller,contact:{id:uuid(30),name:'Fornecedor Sintético'},tools:{history:'purchase_orders'}},{componentName:'ContactPickerTools'});
 try{const button=view.nodes().find(n=>n.props?.['aria-label']==='Visualizar histórico do cliente');assert.ok(button);button.props.onClick();await view.flush();assert.match(view.text(),/2 documentos Origin não entram neste cálculo/);}finally{view.unmount();}
});
