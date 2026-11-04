import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// 202610200287-294 (Documentos, onda G): the screens with synthetic controllers (no DOM, no network, no date of today).
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const actor = 'a0000000-0000-4000-8000-000000000290', contact = 'c0000000-0000-4000-8000-000000000290', product = 'd0000000-0000-4000-8000-000000000290';
const LOT_A = 'a1000000-0000-4000-8000-000000000290', LOT_B = 'a2000000-0000-4000-8000-000000000290', SALE = 'b0000000-0000-4000-8000-000000000290';
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name);
function record(kind, data = {}, extra = {}) {
  const items = data.items ?? [{ product_id: product, description: 'Parafuso sintético', code: 'PAR-1', unit: 'UN', quantity: '3', unit_price: '5', discount_percent: '0' }];
  const normalized = normalizeDocument(kind, { date: '2026-10-20', contact_id: contact, installments: [], ...data, items });
  return { ...normalized, id: SALE, kind, number: '290', version: 4, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente Onda G' }, effect_flags: { finance_active: false, stock_active: false }, ...extra,
    items: normalized.items.map((item, index) => ({ ...item, id: `e0000000-0000-4000-8000-00000000029${index}`, product_snapshot: item.product_id ? { id: item.product_id, name: item.description } : null })) };
}
function controller(answer) {
  const calls = [];
  return { calls, port: {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'admin', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products', 'warehouses'], write: [], data_mode: 'erp_native' }; return { entity: 'products', items: [], has_more: false }; },
    async documents(path, options = {}) { calls.push({ path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }); return answer(path, options); },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  } };
}
async function editor(kind, doc, answer, expand = []) {
  const c = controller(answer), saved = [];
  const view = await mountComponent('RealDocuments.tsx', { controller: c.port, kind, record: doc, writable: true, onSaved: value => saved.push(value), onClose() {}, onConverted() {}, onCopyPrepared() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: expand });
  // The children report their effects (contas, estoque, reservas, recebimentos): none active here unless the record flags say so.
  for (const node of view.nodes().filter(n => typeof n.type === 'function' && typeof n.props.onActive === 'function')) { node.props.onMode?.('available'); node.props.onActive(false); }
  await view.flush();
  return { view, calls: c.calls, saved };
}

test('VND-096: with posted stock the pedido shows the Origin notice and Salvar saves only the observações', async () => {
  const doc = record('sales_orders', { notes: 'Antes' }, { status: 'verified', effect_flags: { finance_active: false, stock_active: true } });
  const { view, calls } = await editor('sales_orders', doc, (path, options) => options.method ? { kind: 'sales_orders', replayed: false, document: { ...doc, version: 5, notes: options.body.notes, internal_notes: options.body.internal_notes }, data_mode: 'erp_native', operational_effects: false }
    : { kind: 'sales_orders', document: doc, data_mode: 'erp_native', operational_effects: false }, ['DocumentNotesNotice', 'DocumentOptionalSection']);
  try {
    assert.match(view.text(), /Não é possível alterar o pedido, pois já foram realizadas as seguintes ações:/);
    assert.ok(view.nodes().some(n => n.type === 'a' && textOf(n) === 'Lançamento de Estoque ↗'));
    assert.equal(view.nodes().some(n => n.type === 'a' && textOf(n) === 'Lançamento de Contas ↗'), false, 'only the effects that happened');
    assert.equal(view.input('doc-item-qty-0').disabled, true, 'the items stay read-only');
    assert.equal(view.input('doc-notes').disabled, false); assert.equal(view.input('doc-internal_notes').disabled, false);
    await view.change('doc-notes', 'Entregar na portaria');
    await view.submit();
    const post = calls.find(call => call.method === 'POST');
    assert.equal(post.path, `/v1/documentos/sales_orders/${SALE}/observacoes`);
    assert.deepEqual(Object.keys(post.body).sort(), ['command_id', 'expected_version', 'internal_notes', 'notes']);
    assert.deepEqual([post.body.expected_version, post.body.notes, post.body.internal_notes], [4, 'Entregar na portaria', null]);
  } finally { view.unmount(); }
});

test('VND-029/PRF-031: Informar lotes is read when the items are used and the lots go with the item; quantities follow the casas decimais', async () => {
  const doc = record('sales_orders');
  const { view, calls } = await editor('sales_orders', doc, path => {
    if (path.startsWith('/v1/documentos/sales_orders/lotes?')) return { kind: 'sales_orders', items: [{ product_id: product, lot_control: true }], data_mode: 'erp_native', operational_effects: false };
    if (path.startsWith(`/v1/documentos/sales_orders/lotes/${product}`)) return { kind: 'sales_orders', product: { id: product, name: 'Parafuso sintético', code: 'PAR-1', unit: 'UN', lot_control: true }, warehouse_id: null, total: 2,
      items: [{ id: LOT_A, code: 'L-01', manufactured_on: null, expires_on: '2027-01-31', active: true, quantity: '10.000000' }, { id: LOT_B, code: 'L-02', manufactured_on: null, expires_on: null, active: true, quantity: '-1.500000' }], data_mode: 'erp_native', operational_effects: false };
    return { kind: 'sales_orders', document: doc, data_mode: 'erp_native', operational_effects: false };
  }, ['DocumentItemLots', 'Modal']);
  try {
    assert.equal(calls.some(call => call.path.includes('/lotes')), false, 'nothing is read before the items are used');
    const items = view.nodes().find(n => n.type === 'fieldset' && n.props.onPointerEnter);
    items.props.onPointerEnter(); await view.flush(); await view.flush();
    const link = () => view.nodes().find(n => n.type === 'a' && n.props['aria-label'] === 'Informar lotes do item 1');
    assert.equal(textOf(link()), 'Informar lotes');
    link().props.onClick({ preventDefault() {} }); await view.flush(); await view.flush();
    assert.match(view.text(), /Quantidade do item: 3/);
    assert.match(view.text(), /Sem lote: 3/);
    await view.click('+ Adicionar lote'); await view.click('+ Adicionar lote');
    const select = n => view.nodes().find(x => x.type === 'select' && x.props['aria-label'] === `Lote da linha ${n}`), qty = n => view.nodes().find(x => x.type === 'input' && x.props['aria-label'] === `Quantidade do lote da linha ${n}`);
    select(1).props.onChange({ target: { value: LOT_A } }); qty(1).props.onChange({ target: { value: '1,5' } });
    select(2).props.onChange({ target: { value: LOT_B } }); qty(2).props.onChange({ target: { value: '1' } }); await view.flush();
    await view.click('Aplicar');
    assert.match(view.text(), /A soma dos lotes \(2,5\) precisa ser igual à quantidade do item \(3\)/);
    qty(2).props.onChange({ target: { value: '1,5' } }); await view.flush();
    await view.click('Aplicar');
    assert.equal(textOf(link()), '2 lotes informados');
    // The saldo of a lot below zero is shown, not refused.
    link().props.onClick({ preventDefault() {} }); await view.flush(); await view.flush();
    assert.match(view.text(), /-1,5/); await view.click('Cancelar');
  } finally { view.unmount(); }
});

test('EST-033/EST-148: the pedido de compra in the Origin order, with IPI % of the items and Total do IPI', async () => {
  const doc = record('purchase_orders', { items: [{ product_id: product, description: 'Chapa', code: 'CH-1', unit: 'UN', quantity: '2', unit_price: '50', discount_percent: '0', ipi_rate: '10' }] });
  const { view } = await editor('purchase_orders', doc, () => ({ kind: 'purchase_orders', document: doc, data_mode: 'erp_native', operational_effects: false }), ['DocumentOptionalSection']);
  try {
    const legends = view.nodes().filter(n => n.type === 'legend').map(textOf);
    const order = ['Fornecedor', 'Itens do pedido de compra', 'Detalhes da compra', 'Pagamento', 'Dados adicionais'].map(label => legends.indexOf(label));
    assert.ok(order.every(index => index >= 0), JSON.stringify(legends));
    assert.deepEqual([...order].sort((a, b) => a - b), order, JSON.stringify(legends));
    assert.equal(legends.includes('Identificação'), false);
    assert.ok(view.nodes().some(n => n.type === 'h3' && textOf(n) === 'Totais da compra'));
    assert.equal(view.nodes().some(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.label === 'Depósito previsto'), false, 'the depósito is chosen in Lançar estoque');
    assert.ok(view.nodes().some(n => n.type === 'th' && textOf(n) === 'IPI %'));
    assert.match(view.text(), /Total do IPI/);
    assert.match(view.text(), /R\$\s?10,00/);
  } finally { view.unmount(); }
});

test('VND-250: the Campos Customizados of the OS are read when their tab opens and saved with the OS', async () => {
  const field = { id: 'f0000000-0000-4000-8000-000000000290', kind: 'service_orders', field_type: 'integer', name: 'Ordem interna', hint: 'Ex: 12', info: 'Número da ordem do cliente', required: true, min_length: null, max_length: null, width: 'medium', options: [], active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', documents: 0 };
  const doc = record('service_orders', { items: [] });
  const { view, calls } = await editor('service_orders', doc, (path, options) => {
    if (path === '/v1/documentos/service_orders/campos-customizados') return { kind: 'service_orders', can_manage: true, items: [field], data_mode: 'erp_native', operational_effects: false };
    if (options.method) return { kind: 'service_orders', replayed: false, document: { ...doc, version: 5, custom_fields: options.body.data.custom_fields }, data_mode: 'erp_native', operational_effects: false };
    return { kind: 'service_orders', document: doc, data_mode: 'erp_native', operational_effects: false };
  }, ['DocumentCustomFieldsSection']);
  try {
    assert.equal(calls.some(call => call.path.includes('campos-customizados')), false);
    await view.click('Campos Customizados'); await view.flush();
    assert.equal(calls.filter(call => call.path.includes('campos-customizados')).length, 1);
    const input = view.input(`doc-custom-${field.id}`);
    assert.equal(input.props.placeholder, 'Ex: 12');
    await view.change(`doc-custom-${field.id}`, '42');
    await view.submit();
    const write = calls.find(call => call.method !== 'GET');
    assert.deepEqual(write?.body?.data?.custom_fields, { [field.id]: '42' });
  } finally { view.unmount(); }
});

test('PRF-126: Checkout de pedidos reads the pedido by number, checks quantities and saves the reads with a command', async () => {
  const line = (key, quantity, extra) => ({ key, item_id: key, component_id: null, product_id: null, position: Number(key.slice(-1)), description: `Item ${key.slice(-1)}`, code: `C${key.slice(-1)}`, unit: 'UN', quantity, gtin: null, gtin_tax: null, location: null, ...extra });
  const lines = [line('e0000000-0000-4000-8000-000000000291', '2.000000', { gtin: '7891000000001' }), line('e0000000-0000-4000-8000-000000000292', '1.000000', {})];
  const viewOf = (reads, status = 'open', version = 4) => ({ kind: 'sales_orders', order: { id: SALE, number: '290', version, status, contact_name: 'Cliente Onda G', date: '2026-10-20' }, available: true, split: false, lines, reads, checkout_version: reads.length ? 1 : 0,
    settings: { order: 'nao_ordenar', split: false, picking: false, auto_save: false, quantity_input: true }, data_mode: 'erp_native', operational_effects: false });
  let saved = [];
  const c = controller((path, options) => {
    if (path === '/v1/documentos/sales_orders/checkout?number=290') return { kind: 'sales_orders', id: SALE, number: '290' };
    if (options.method === 'POST') { saved = options.body.reads; return { ...viewOf(saved, 'checkout_partial', 5), replayed: false, complete: false }; }
    return viewOf(saved, saved.length ? 'checkout_partial' : 'open', saved.length ? 5 : 4);
  });
  const view = await mountComponent('SalesCheckout.tsx', { controller: c.port, onClose() {} });
  try {
    await view.change('checkout-number', '290'); await view.submit(0); await view.flush();
    assert.match(view.text(), /Cliente Onda G/);
    await view.change('checkout-code', '7891000000001'); await view.change('checkout-quantity', '3'); await view.submit(1);
    assert.match(view.text(), /Quantidade lida maior que a do pedido para Item 1: 3 de 2\./);
    await view.change('checkout-code', '7891000000001'); await view.change('checkout-quantity', '1,5'); await view.submit(1);
    assert.match(view.text(), /Item 1: 1,5 de 2\./);
    assert.match(view.text(), /Ao salvar, o pedido fica Checkout parcial\./);
    await view.click('Salvar'); await view.flush();
    const post = c.calls.find(call => call.method === 'POST');
    assert.equal(post.path, `/v1/documentos/sales_orders/${SALE}/checkout`);
    assert.deepEqual([post.body.expected_version, post.body.checkout_version, post.body.reads], [4, 0, [{ key: lines[0].key, quantity: '1.500000' }]]);
    assert.match(post.body.command_id, /^[0-9a-f-]{36}$/);
    assert.match(view.text(), /Checkout salvo\. Pedido 290: Checkout parcial\./);
  } finally { view.unmount(); }
  // A lost answer keeps the same command for "Conferir resultado".
  const lost = controller((path, options) => {
    if (path === '/v1/documentos/sales_orders/checkout?number=290') return { kind: 'sales_orders', id: SALE, number: '290' };
    if (options.method === 'POST') throw new AccessError(503);
    return viewOf([]);
  });
  const again = await mountComponent('SalesCheckout.tsx', { controller: lost.port, onClose() {} });
  try {
    await again.change('checkout-number', '290'); await again.submit(0); await again.flush();
    await again.change('checkout-code', 'c2'); await again.submit(1);
    await again.click('Salvar'); await again.flush();
    assert.match(again.text(), /Conferir resultado/);
    await again.click('Conferir resultado'); await again.flush();
    const posts = lost.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2); assert.equal(posts[0].body.command_id, posts[1].body.command_id);
  } finally { again.unmount(); }
});

test('VND-038: Busca customizada builds field, condição and valor rows; Adicionar filtros stops at 10', async () => {
  let rows = [];
  const c = controller(() => ({ kind: 'service_orders', can_manage: false, items: [{ id: 'f0000000-0000-4000-8000-000000000291', kind: 'service_orders', field_type: 'list', name: 'Prioridade', hint: null, info: null, required: false, min_length: null, max_length: null, width: 'medium',
    options: [{ id: 'f1000000-0000-4000-8000-000000000291', label: 'Alta' }], active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', documents: 0 }], data_mode: 'erp_native', operational_effects: false }));
  const view = await mountComponent('DocumentListSearch.tsx', { controller: c.port, kind: 'service_orders', rows, disabled: false, onChange: next => { rows = next; } });
  try {
    assert.equal(c.calls.length, 0, 'the campos customizados are read only after a filter is added');
    await view.click('Adicionar filtros');
    assert.deepEqual(rows, [{ field: 'number', op: 'eq', value: '' }]);
    await view.updateProps({ rows }); await view.flush();
    assert.equal(c.calls.length, 1);
    const fieldSelect = view.nodes().find(n => n.type === 'select' && n.props['aria-label'] === 'Campo do filtro 1');
    assert.ok(fieldSelect.props.children.flat(2).some(option => option?.props?.value === 'custom:f0000000-0000-4000-8000-000000000291'), 'the campos customizados of the OS are offered');
    fieldSelect.props.onChange({ target: { value: 'custom:f0000000-0000-4000-8000-000000000291' } });
    assert.deepEqual(rows, [{ field: 'custom:f0000000-0000-4000-8000-000000000291', op: 'eq', value: '' }]);
    await view.updateProps({ rows }); await view.flush();
    const ops = view.nodes().find(n => n.type === 'select' && n.props['aria-label'] === 'Condição do filtro 1').props.children.map(option => option.props.value);
    assert.deepEqual(ops, ['eq', 'ne', 'empty', 'not_empty']);
    await view.updateProps({ rows: Array.from({ length: 10 }, () => ({ field: 'notes', op: 'contains', value: 'x' })) });
    assert.equal(view.button('Adicionar filtros').disabled, true);
  } finally { view.unmount(); }
});

test('VND-250 admin: Preferências › Campos customizados › Ordem de Serviço lists and saves a field with a command', async () => {
  const field = { id: 'f0000000-0000-4000-8000-000000000292', kind: 'service_orders', field_type: 'text', name: 'Senha do aparelho', hint: null, info: null, required: false, min_length: null, max_length: 20, width: 'medium', options: [], active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', documents: 0 };
  const c = controller((path, options) => options.method ? { kind: 'service_orders', replayed: false, field: { ...field, id: 'f0000000-0000-4000-8000-000000000293', name: options.body.data.name, field_type: options.body.data.field_type }, data_mode: 'erp_native', operational_effects: false }
    : { kind: 'service_orders', can_manage: true, items: [field], data_mode: 'erp_native', operational_effects: false });
  const view = await mountComponent('DocumentCustomFieldsAdmin.tsx', { controller: c.port }, { expandChildren: ['Modal'] });
  try {
    assert.match(view.text(), /Senha do aparelho/);
    const add = view.nodes().find(n => n.type === 'button' && /Adicionar campo/.test(textOf(n)));
    add.props.onClick(); await view.flush();
    await view.change('os-field-name', 'Acessórios deixados'); await view.change('os-field-type', 'long_text');
    await view.click('Salvar'); await view.flush();
    const post = c.calls.find(call => call.method === 'POST');
    assert.equal(post.path, '/v1/documentos/service_orders/campos-customizados');
    assert.equal(post.body.expected_version, 0); assert.match(post.body.command_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([post.body.data.name, post.body.data.field_type], ['Acessórios deixados', 'long_text']);
  } finally { view.unmount(); }
});
