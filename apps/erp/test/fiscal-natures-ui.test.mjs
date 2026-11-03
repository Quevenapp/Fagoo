import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Naturezas de operação, Configurações globais de impostos and homologation event dialogs (synthetic controller only).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = '20000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002';
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
const press = async (view, label) => { const node = view.nodes().find(n => n.type === 'button' && textOf(n).trim() === label); if (!node) throw new Error(`Missing ${label}`); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
async function modalAction(view, label) {
  const modal = components(view, 'Modal').at(-1); let found;
  walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node).trim() === label) found = node; });
  if (!found) throw new Error(`Missing dialog action ${label}`); if (found.props.disabled) throw new Error(`Disabled dialog action ${label}`);
  found.props.onClick?.({ preventDefault() {} }); await view.flush();
}
const actionDisabled = (view, label) => { let found; walk(components(view, 'Modal').at(-1).props.actions, node => { if (node.type === 'button' && textOf(node).trim() === label) found = node; }); return found.props.disabled; };
const record = (over = {}) => ({ id: id(1), description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
  include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', defaults: [], rules: [], ...over });
function server({ role = 'admin', post } = {}) {
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: user, role } };
  return { calls, become: v => { snapshot = v; }, posts: () => calls.filter(c => c.method !== 'GET'), controller: { getSnapshot: () => snapshot, subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') return post(call);
      if (path.startsWith('/v1/notas-fiscais/naturezas?')) return { items: [{ id: id(1), description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false, active: true, version: 1, defaults: [], rule_count: 0 }], page: 1, limit: 100, total_count: 1, writable: role !== 'consulta', review: { confirmed: false, version: 0, confirmed_at: null }, data_mode: 'erp_native' };
      if (path === `/v1/notas-fiscais/naturezas/${id(1)}`) return { nature: record(), writable: true, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 2, updated_at: '2026-10-20T12:00:00Z', writable: role !== 'consulta', data_mode: 'erp_native' };
      if (path.startsWith('/v1/notas-fiscais/eventos?')) return { items: [{ id: id(7), kind: 'inutilization', invoice_id: null, model: '55', environment: '2', series: 2, number_from: 40, number_to: 45, sequence: null, text: 'Faixa sintética pulada', state: 'pending', protocol: null, requested_at: '2026-10-20T12:00:00Z', access_key: null }], kind: 'inutilization', page: 1, limit: 100, total_count: 1, transmission_enabled: false, data_mode: 'erp_native_homologation' };
      throw new AccessError(404);
    },
    async catalog() { return { items: [], has_more: false }; } } };
}

test('Naturezas de operação: Origin list, default codes by direction and a new nature saved with a rule and the command id', async () => {
  const srv = server({ post: call => ({ nature: record({ id: call.body.action === 'create' ? id(2) : id(1), description: call.body.nature?.description ?? 'Venda sintética', defaults: call.body.code ? [call.body.code] : [],
    rules: (call.body.nature?.rules ?? []).map((r, i) => ({ ...r, position: i + 1, products: [] })) }), action: call.body.action, replayed: false, data_mode: 'erp_native' }) });
  const list = await mountComponent('RealOperationNatures.tsx', { controller: srv.controller }, { location: '/naturezas-operacao' });
  try {
    assert.match(list.text(), /Venda sintética/); assert.match(list.text(), /Quantidade de operações fiscais/);
    const items = components(list, 'RowMenu')[0].props.items.map(i => i.label);
    assert.deepEqual(items, ['Clonar Operação', 'Padrão venda', 'Padrão venda física', 'Padrão venda jurídica', 'Padrão venda cupom', 'Padrão devolução (saída)', 'Inativar']);
    components(list, 'RowMenu')[0].props.items[1].onClick(); await list.flush();
    assert.deepEqual([srv.posts()[0].body.action, srv.posts()[0].body.code, srv.posts()[0].body.expected_version], ['set_default', 'S', 1]); assert.match(list.text(), /Padrão venda definido/);
  } finally { list.unmount(); }
  const form = await mountComponent('RealOperationNatures.tsx', { controller: srv.controller }, { location: '/naturezas-operacao?natureza=nova', expandChildren: ['OperationNatureForm', 'NatureRuleDialog'] });
  try {
    await form.change('nature-description', 'Venda interna sintética');
    const tab = label => form.nodes().find(n => n.type === 'button' && n.props.role === 'tab' && textOf(n) === label).props.onClick();
    tab('ICMS'); await form.flush(); await press(form, 'Adicionar regra');
    assert.equal(components(form, 'Modal').at(-1).props.title, 'Regra de ICMS');
    await modalAction(form, 'Salvar'); assert.match(form.text(), /Uma situação tributária válida deve ser selecionada\./);
    await form.change('rule-situation', '101'); await form.change('rule-credit_rate', '1,25'); await form.change('rule-cfop', '5102');
    await modalAction(form, 'Salvar'); assert.equal(components(form, 'Modal').length, 0);
    await press(form, 'Salvar');
    const created = srv.posts().at(-1);
    assert.equal(created.body.action, 'create'); assert.ok(created.body.command_id);
    assert.deepEqual(created.body.nature.rules, [{ tax: 'icms', destinations: [], product_scope: 'any', ncms: [], product_ids: [], data: { situation: '101', credit_rate: '1.2500', cfop: '5102' }, additional_info: null, fiscal_info: null }]);
  } finally { form.unmount(); }
  const reader = server({ role: 'consulta' }), readOnly = await mountComponent('RealOperationNatures.tsx', { controller: reader.controller }, { location: '/naturezas-operacao' });
  try { assert.ok(components(readOnly, 'RowMenu')[0].props.items.every(i => i.disabled)); } finally { readOnly.unmount(); }
});

test('Configurações globais de impostos: versioned save, conflict message and read-only consulta', async () => {
  let conflict = true;
  const srv = server({ post: call => { if (conflict) { conflict = false; throw new AccessError(409); } return { settings: { ...call.body.settings }, difal_by_state: call.body.difal_by_state, version: 3, updated_at: '2026-10-20T13:00:00Z', writable: true, replayed: false, data_mode: 'erp_native' }; } });
  const view = await mountComponent('FiscalTaxSettings.tsx', { controller: srv.controller, onBack() {} });
  try {
    assert.match(view.text(), /Versão 2/);
    await view.change('tax-exclude_icms_pis_cofins', true);
    const select = view.nodes().find(n => n.type === 'select' && n.props['aria-label'] === 'Forma de cálculo do DIFAL em PB');
    assert.ok(textOf(select).includes('Base única com exclusão do ICMS')); assert.equal(textOf(view.nodes().find(n => n.type === 'select' && n.props['aria-label'] === 'Forma de cálculo do DIFAL em SP')).includes('Base dupla'), false);
    select.props.onChange({ target: { value: 'single_base' } }); await view.flush();
    await press(view, 'Salvar'); assert.match(view.text(), /As configurações mudaram em outra tela/);
    await press(view, 'Salvar');
    const body = srv.posts().at(-1).body;
    assert.deepEqual([body.expected_version, body.settings.exclude_icms_pis_cofins, body.difal_by_state], [2, true, { PB: 'single_base' }]);
    assert.notEqual(srv.posts()[0].body.command_id, body.command_id, 'a refused command is not reused'); assert.match(view.text(), /Configurações salvas/);
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta' }), readOnly = await mountComponent('FiscalTaxSettings.tsx', { controller: reader.controller, onBack() {} });
  try { assert.match(readOnly.text(), /apenas consultar/); } finally { readOnly.unmount(); }
});

test('Inutilizar numeração validates Origin limits, repeats an unknown outcome with the same command and never resends for another user', async () => {
  let attempts = 0;
  const srv = server({ post: call => { if (attempts++ < 1) throw new AccessError(503); return { event: { id: id(9), kind: 'inutilization', invoice_id: null, model: '55', environment: '2', series: Number(call.body.series), number_from: Number(call.body.number_from), number_to: Number(call.body.number_to), sequence: null, text: call.body.justification, state: 'pending', protocol: null, requested_at: '2026-10-20T12:00:00Z', access_key: null }, action: 'inutilization', replayed: false, transmission_enabled: false, data_mode: 'erp_native_homologation' }; } });
  const closed = [];
  const view = await mountComponent('FiscalEventDialogs.tsx', { controller: srv.controller, model: '55', onClose: done => closed.push(done) }, { componentName: 'InutilizationDialog' });
  try {
    assert.equal(actionDisabled(view, 'Inutilizar números'), true);
    await view.change('fiscal-inut-series', '2'); await view.change('fiscal-inut-from', '45'); await view.change('fiscal-inut-to', '40');
    assert.match(view.text(), /número inicial deve ser menor ou igual ao final/);
    await view.change('fiscal-inut-from', '40'); await view.change('fiscal-inut-to', '45'); await view.change('fiscal-inut-text', 'curta');
    assert.equal(actionDisabled(view, 'Inutilizar números'), true); assert.match(view.text(), /5 de no mínimo 15 caracteres/);
    await view.change('fiscal-inut-text', 'Faixa sintética pulada na numeração');
    await modalAction(view, 'Inutilizar números');
    assert.match(view.text(), /Conferir resultado/); assert.match(view.text(), /Aguardando transmissão/);
    const first = srv.posts()[0].body;
    assert.deepEqual([first.action, first.model, first.series, first.number_from, first.number_to], ['inutilization', '55', '2', '40', '45']);
    await modalAction(view, 'Conferir resultado');
    assert.equal(srv.posts()[1].body.command_id, first.command_id); assert.deepEqual(closed, [true]);
  } finally { view.unmount(); }
  const lost = server({ post: () => { throw new AccessError(503); } }), dialog = await mountComponent('FiscalEventDialogs.tsx', { controller: lost.controller, model: '65', onClose() {} }, { componentName: 'InutilizationDialog' });
  try {
    await dialog.change('fiscal-inut-series', '1'); await dialog.change('fiscal-inut-from', '1'); await dialog.change('fiscal-inut-to', '1'); await dialog.change('fiscal-inut-text', 'Justificativa sintética longa');
    await modalAction(dialog, 'Inutilizar números'); lost.become({ phase: 'ready', membership: { user_id: other, role: 'admin' } });
    await modalAction(dialog, 'Conferir resultado');
    assert.equal(lost.posts().length, 1); assert.match(dialog.text(), /A sessão ou o perfil mudou/);
  } finally { dialog.unmount(); }
});

test('Cancelar nota warns after 24 hours and the consult screen shows the queued request without protocol', async () => {
  const authorized = { id: id(3), version: 2, authorized_at: '2026-10-01T12:00:00Z' };
  const srv = server({ post: () => { throw new AccessError(409); } });
  const view = await mountComponent('FiscalEventDialogs.tsx', { controller: srv.controller, record: authorized, onClose() {} }, { componentName: 'CancelDialog' });
  try {
    assert.match(view.text(), /Essa nota ultrapassou o prazo de 24 horas para cancelamento\./);
    assert.equal(actionDisabled(view, 'Cancelar nota'), true);
    await view.change('fiscal-cancel-text', 'Cancelamento sintético de teste'); await modalAction(view, 'Cancelar nota');
    assert.deepEqual(srv.posts()[0].body.expected_version, 2); assert.match(view.text(), /A nota ou a faixa mudou/);
  } finally { view.unmount(); }
  const list = await mountComponent('FiscalEventList.tsx', { controller: server().controller, kind: 'inutilization' });
  try { assert.equal(components(list, 'OriginListHeader')[0].props.title, 'Consulta de inutilizações de NF-es'); const text = list.text(); for (const expected of ['Aguardando transmissão', 'Faixa sintética pulada', '40', '45']) assert.ok(text.includes(expected), expected); }
  finally { list.unmount(); }
});

// ---- Review fixes (synthetic data only) ----
test('a new nature opens its saved record through the confirmed navigation, not a guard that still sees the save', async () => {
  const flags = { changed: false, busy: false, bypass: 0 }, navigations = [];
  const ports = {
    useUnsavedChanges(changed, busy) { flags.changed = changed; flags.busy = busy; return { confirmLeave: action => action(), store: { runConfirmed(action) { flags.bypass++; try { action(); } finally { flags.bypass--; } } } }; },
    useNavigate() { return target => navigations.push({ target, blocked: flags.bypass === 0 && (flags.changed || flags.busy) }); },
  };
  const srv = server({ post: call => ({ nature: record({ id: id(2), description: call.body.nature.description }), action: call.body.action, replayed: false, data_mode: 'erp_native' }) });
  const form = await mountComponent('RealOperationNatures.tsx', { controller: srv.controller }, { location: '/naturezas-operacao?natureza=nova', expandChildren: ['OperationNatureForm'], ports });
  try {
    await form.change('nature-description', 'Venda sintética nova');
    await press(form, 'Salvar');
    assert.deepEqual(navigations, [{ target: `/naturezas-operacao?natureza=${id(2)}`, blocked: false }]);
  } finally { form.unmount(); }
});

test('Configurações globais de impostos says which settings the automatic calculation applies and which it only keeps', async () => {
  const view = await mountComponent('FiscalTaxSettings.tsx', { controller: server().controller, onBack() {} });
  try {
    const notes = view.nodes().filter(n => n.type === 'small' && textOf(n).includes('ainda não aplica esta configuração'));
    assert.equal(notes.length, 1, 'only the differentiated ST of contributor consumers is kept without effect');
    assert.equal(view.nodes().filter(n => n.type === 'small' && textOf(n).startsWith('Aplicada no cálculo automático')).length, 3, 'ST retido, IPI na importação e DIFAL');
  } finally { view.unmount(); }
});
