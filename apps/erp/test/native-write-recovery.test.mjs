import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

globalThis.document = { activeElement: null, getElementById: () => null };
const id = '10000000-0000-4000-8000-000000000001';
const warehouseId = '20000000-0000-4000-8000-000000000001';
const product = { id, name: 'Produto sintético', code: 'QA-RECOVERY', active: true, kind: 'P', format: 'S', unit: 'UN' };
const balances = [{ warehouse_id: warehouseId, warehouse_name: 'Depósito sintético', warehouse_active: true, product_id: id, quantity: '10.000000', unit: 'UN', version: 1 }];
const fixture = { id, name: 'Cadastro sintético', active: true, version: 1 };
const inputFor = (view, label) => {
  const field = view.find(node => node.type === 'label' && node.props.children === label);
  return view.input(field.props.htmlFor);
};

function server({ before, after } = {}) {
  const calls = [], commands = new Map(); let writes = 0, reads = 0;
  const request = async (path, options = {}) => {
    const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
    if (!options.method) { reads++; await before?.(call, { writes, reads }); return { record: fixture }; }
    writes++; await before?.(call, { writes, reads });
    const prior = commands.get(options.body.command_id);
    if (prior) assert.deepEqual(call.body, prior.body, 'replay must preserve the exact payload');
    else commands.set(options.body.command_id, call);
    await after?.(call, { writes, reads });
    // The stock panel (migration 105) checks its answer: one Entrada line of the launched quantity.
    if (path === '/v1/estoque/lancamentos') return { scope: 'stock_launch', data_mode: 'erp_native', kind: call.body.kind, occurred_on: '2026-10-20', replayed: false,
      movement: { id, items: [{ product_id: id, warehouse_id: warehouseId, quantity: '0.123456', unit: 'UN', balance_after: '10.123456', balance_version: 2 }] },
      detail: { revision: 1, unit_price: '1.0000000000', unit_cost: '1.0000000000', note: 'Lançamento manual' }, balance: null };
    return { record: fixture, movement: { id }, data_mode: 'erp_native' };
  };
  return { calls, commands, counts: () => ({ writes, reads }), controller: { catalog: request, finance: request, stock: request } };
}

async function mount(kind, service) {
  const saved = [], closed = [];
  const shared = { controller: service.controller, onSaved: value => saved.push(value), onClose: () => closed.push(true) };
  let view;
  if (kind === 'catalog') {
    // The contact form also loads its option lists (tipos de contato, código, Preferências, categorias, naturezas); only the contact itself counts.
    const contacts = { ...service.controller, getSnapshot: () => ({ phase: 'ready', membership: { user_id: 'qa-actor', role: 'admin' } }),
      catalog: (path, options = {}) => options.method || /^\/v1\/cadastros\/contatos\/[0-9a-f-]{36}$/.test(path) ? service.controller.catalog(path, options) : Promise.resolve({ items: [] }),
      finance: async () => ({ items: [] }), fiscalInvoices: async () => ({ items: [] }), preferences: async () => ({ items: [] }) };
    view = await mountComponent('ContactEditor.tsx', { ...shared, controller: contacts, entity: 'contacts', record: null, writable: true }, { componentName: 'ContactEditor', expandChildren: ['ContactForm'] });
  }
  if (kind === 'finance') view = await mountComponent('RealFinance.tsx', { ...shared, mode: 'account_save', record: null, kind: 'receivable' }, { componentName: 'FinanceEditor', expandChildren: ['Field', 'Confirmation'] });
  if (kind === 'stock') view = await mountComponent('StockMovementPanel.tsx', { ...shared, product, warehouse: balances[0], readReady: true, suggestion: { sale: '1', purchase: '1', cost: '1' }, onRefresh() {} }, { componentName: 'StockLaunchPanel', expandChildren: ['StockSidePanel'] });
  return { view, saved, closed };
}
async function prepare(kind, view) {
  if (kind === 'catalog') await view.change('contact-name', 'Cadastro sintético');
  if (kind === 'finance') await view.change(inputFor(view, 'Nome *').props.id, 'Conta sintética');
  if (kind === 'stock') { await view.change('stock-launch-quantity', '0.123456'); await view.change('stock-launch-note', 'Entrada sintética'); }
  // Origin's Novo Lançamento has no review step: submitting the panel sends the command.
  await view.submit();
}
async function firstWrite(kind, view) {
  await prepare(kind, view);
  if (kind === 'finance') await view.click('Salvar conta financeira');
}

for (const kind of ['catalog', 'finance', 'stock']) for (const status of [403, 409]) test(`${kind}: lost commit reply then ${status} preserves the original command and guarded retry`, async () => {
  const service = server({ after(call, { writes }) { if (writes === 1) throw new AccessError(503); }, before(call, { writes }) { if (call.method && writes === 2) throw new AccessError(status); } });
  const { view, saved } = await mount(kind, service);
  try {
    await firstWrite(kind, view); assert.equal(service.commands.size, 1); assert.equal(view.guard().busy, true);
    await view.click('Conferir resultado'); assert.equal(service.counts().writes, 2);
    assert.equal(view.guard().busy, true, 'a later rejection cannot resolve the earlier unknown result'); assert.equal(saved.length, 0);
    if (kind === 'catalog') { assert.equal(view.input('contact-name').disabled, true); await view.submit(); }
    if (kind === 'finance') { assert.equal(inputFor(view, 'Nome *').disabled, true); await view.submit(); }
    if (kind === 'stock') {
      assert.equal(view.button('Cancelar').disabled, true); assert.equal(view.input('stock-launch-quantity').disabled, true);
      view.button('Cancelar').props.onClick(); await view.flush();
      assert.ok(view.button('Conferir resultado'), 'even a queued cancel handler must retain the pending command');
    }
    assert.equal(service.counts().writes, 2);
    await view.click('Conferir resultado');
    assert.equal(service.counts().writes, 3); assert.equal(service.commands.size, 1); assert.equal(saved.length, 1);
    const writes = service.calls.filter(call => call.method); assert.deepEqual(writes[0].body, writes[1].body); assert.deepEqual(writes[0].body, writes[2].body);
    assert.equal(service.counts().reads, kind === 'catalog' ? 1 : 0);
  } finally { view.unmount(); }
});

for (const kind of ['catalog', 'finance', 'stock']) test(`${kind}: a known initial rejection releases the command without implying a write`, async () => {
  const service = server({ before(call) { if (call.method) throw new AccessError(409); } }), { view, saved } = await mount(kind, service);
  try { await firstWrite(kind, view); assert.equal(view.guard().busy, false); assert.equal(service.commands.size, 0); assert.equal(saved.length, 0); assert.equal(service.counts().reads, 0); }
  finally { view.unmount(); }
});

test('catalog: confirmed replay and failed current GET never resend the write', async () => {
  const service = server({ after(call, { writes }) { if (writes === 1) throw new AccessError(503); }, before(call, { reads }) { if (!call.method && reads === 1) throw new AccessError(403); } });
  const { view, saved } = await mount('catalog', service);
  try {
    await firstWrite('catalog', view); await view.click('Conferir resultado');
    assert.equal(view.guard().busy, true); assert.equal(saved.length, 0);
    await view.click('Conferir resultado');
    assert.deepEqual(service.counts(), { writes: 2, reads: 2 }); assert.equal(service.commands.size, 1); assert.equal(saved[0].id, id); assert.equal(view.guard().busy, false);
  } finally { view.unmount(); }
});

for (const kind of ['catalog', 'finance', 'stock']) test(`${kind}: leaving aborts a pending write and ignores a late response`, async () => {
  let release; const service = server({ before(call) { if (call.method) return new Promise(resolve => { release = resolve; }); } });
  const { view, saved } = await mount(kind, service);
  await firstWrite(kind, view); assert.equal(view.guard().busy, true);
  const call = service.calls.find(value => value.method); view.unmount(); assert.equal(call.signal.aborted, true);
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.length, 0); assert.equal(service.counts().reads, 0);
});
