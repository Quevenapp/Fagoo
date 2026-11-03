import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { originStockCell, cubeStock, nativeStockLine, productStockText, ORIGIN_EXPORT_COLUMNS } from '../src/lib/product-origin-stock-model.ts';
import { exportColumns, exportCsv } from '../src/lib/product-form-model.ts';

// Synthetic data only. The Origin balance is the one observed in the mirror; the native one is the Brufap ledger. Never added.
globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '93000000-0000-4000-8000-0000000000aa', warehouse = '93000000-0000-4000-8000-0000000000bb';
const ok = { origin: 'origin', status: 'ok', warehouse: null };
const observed = (patch = {}) => ({ origin: 'origin', state: 'observed', product_source_id: '201', warehouse_source_id: '900', warehouse_name: 'Geral', physical: '10', virtual: '8',
  physical_state: 'value', virtual_state: 'value', observed_at: '2026-10-22T12:05:00Z', source_version: 3, positions: 1, issues: [], ...patch });
const empty = (state, patch = {}) => ({ origin: 'origin', state, product_source_id: state === 'unlinked' ? null : '202', warehouse_source_id: null, warehouse_name: null, physical: null, virtual: null,
  physical_state: null, virtual_state: null, observed_at: null, source_version: null, positions: state === 'multiple_warehouses' ? 2 : 0, issues: [], ...patch });
const noMovements = { state: 'no_movements', quantity: null, warehouse: null };

test('Origin cell: positive, zero and negative físico with virtual and the moment in São Paulo', () => {
  const cell = originStockCell(observed(), ok);
  assert.deepEqual([cell.text, cell.quantity, cell.state], ['10', '10', 'observed']);
  assert.equal(cell.detail, 'Virtual 8 · obs. 22/10/2026, 09:05');
  assert.match(cell.title, /Estoque observado no Origin · Geral\. Físico: 10\. Virtual 8\. Observado em 22\/10\/2026, 09:05 \(São Paulo\)\. Não é disponibilidade no FAGOO/);
  assert.equal(originStockCell(observed({ physical: '0', virtual: '0' }), ok).text, '0');
  assert.deepEqual([originStockCell(observed({ physical: '-3', virtual: '-5' }), ok).text, originStockCell(observed({ physical: '-3', virtual: '-5' }), ok).detail.split(' · ')[0]], ['−3', 'Virtual −5']);
  assert.equal(originStockCell(observed({ physical: '900719925474099.123456' }), ok).text, '900.719.925.474.099,123456', 'exact digits, never a float');
});

test('Origin cell: every absence has its own reason and never reads as zero', () => {
  const text = (stock, page = ok) => originStockCell(stock, page).text;
  assert.equal(text(observed({ physical: null, physical_state: 'null' })), 'Saldo não informado');
  assert.equal(text(observed({ physical: null, physical_state: 'invalid' })), 'Valor inválido na fonte');
  assert.equal(originStockCell(observed({ virtual: null, virtual_state: 'invalid' }), ok).detail.split(' · ')[0], 'Virtual: valor inválido na fonte');
  assert.equal(text(empty('not_observed')), 'Posição não observada');
  assert.equal(text(empty('unlinked')), 'Produto sem vínculo');
  assert.equal(text(empty('source_deleted')), 'Excluído no Origin');
  assert.equal(text(empty('warehouse_unlinked')), 'Depósito sem correspondência');
  assert.equal(text(empty('multiple_warehouses')), '2 depósitos no Origin');
  assert.equal(text(observed(), { ...ok, status: 'forbidden' }), 'Acesso não permitido');
  assert.equal(text(null, null), 'Acesso não permitido');
  assert.equal(text(null, { ...ok, status: 'unavailable' }), 'Estoque Origin não consultado');
  for (const stock of [empty('not_observed'), empty('unlinked'), observed({ physical: null, physical_state: 'absent' })]) assert.equal(originStockCell(stock, ok).quantity, null);
  assert.equal(nativeStockLine(noMovements, false).text, 'Estoque nativo sem lançamentos');
});

test('native and Origin balances never mix: print and the cube name their origin', () => {
  const native = { state: 'recorded', quantity: '2.000000', warehouse: null };
  assert.equal(productStockText(native, observed({ physical: '7', virtual: '7' }), ok, false), 'Origin (físico): 7 (Virtual 7 · obs. 22/10/2026, 09:05) | FAGOO: 2');
  assert.deepEqual(cubeStock(native, observed({ physical: '7' }), ok, false), { quantity: '7', origin: 'origin', reason: '' });
  assert.deepEqual(cubeStock(native, empty('unlinked'), ok, false), { quantity: '2.000000', origin: 'brufap', reason: '' });
  assert.deepEqual(cubeStock(noMovements, empty('not_observed'), ok, false), { quantity: null, origin: null, reason: 'Estoque Origin: posição não observada' });
  assert.deepEqual(cubeStock(noMovements, empty('unlinked'), ok, false), { quantity: null, origin: null, reason: 'Estoque nativo sem lançamentos' });
  assert.equal(productStockText(noMovements, observed(), ok, false), 'Origin (físico): 10 (Virtual 8 · obs. 22/10/2026, 09:05) | FAGOO: Estoque nativo sem lançamentos');
});

test('export keeps the native Estoque of the Origin sheet and adds its own Origin columns with exact numbers', () => {
  const columns = exportColumns('standard', []), names = columns.map(([name]) => name);
  assert.equal(names.filter(name => name === 'Estoque').length, 1);
  assert.deepEqual(names.slice(-4), ORIGIN_EXPORT_COLUMNS.map(([name]) => name));
  assert.deepEqual(exportColumns('custom', []).map(([name]) => name), ['ID', 'Código', 'Descrição']);
  const csv = exportCsv([{ id: 'x', name: 'A', stock: '2.000000', origin_stock: observed({ physical: '-3.25', virtual: '-5' }) }, { id: 'y', name: 'B', stock: null, origin_stock: empty('not_observed') },
    { id: 'z', name: 'C', stock: null, origin_stock: observed({ physical: null, physical_state: 'null' }) }, { id: 'w', name: 'D', stock: null, origin_stock: null, origin_stock_status: 'unavailable' }], columns).split('\r\n');
  assert.ok(csv[1].endsWith(';-3,25;-5;22/10/2026, 09:05;Observado'));
  assert.ok(csv[2].endsWith(';;;;Posição não observada'));
  assert.ok(csv[3].endsWith(';;8;22/10/2026, 09:05;Observado (físico: saldo não informado)'));
  assert.ok(csv[4].endsWith(';;;;Não consultado'));
});

function server(page) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'consulta', capabilities: { originHistory: true } } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method });
      if (path === '/v1/cadastros') return { data_mode: 'erp_native', read: ['products'], write: [] };
      const params = new URLSearchParams(path.split('?')[1] ?? '');
      return { entity: 'products', page: Number(params.get('page')), size: Number(params.get('size')), total: page.items.length, sort: 'created_desc', stock_visible: true, data_mode: 'erp_native', ...page };
    },
    async stockPositions() { return { items: [{ id: warehouse, name: 'Geral', active: true }], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
  };
  return { calls, controller };
}
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const cells = view => view.nodes().filter(node => node.type === 'td' && String(node.props.className || '').includes('catalog-stock')).map(node => textOf(node.props.children));
const product = (n, stock, origin) => ({ id: `93000000-0000-4000-8000-00000000000${n}`, entity: 'products', version: 1, active: true, name: `Produto ${n}`, code: `QA-${n}`, unit: 'UN', price: '1.5000', kind: 'P', format: 'S', source: null, stock, origin_stock: origin });

test('product list shows Origin and FAGOO lines, with explicit filter groups, and only reads', async () => {
  const items = [product(1, noMovements, observed()), product(2, { state: 'recorded', quantity: '2.000000', warehouse: null }, observed({ physical: '7', virtual: '7' })),
    product(3, { state: 'recorded', quantity: '4.000000', warehouse: null }, empty('unlinked')), product(4, noMovements, empty('not_observed'))];
  const { calls, controller } = server({ items, origin_stock: ok });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.deepEqual(cells(view), [
      'Origin (físico) 10Virtual 8 · obs. 22/10/2026, 09:05FAGOO Estoque nativo sem lançamentos',
      'Origin (físico) 7Virtual 7 · obs. 22/10/2026, 09:05FAGOO 2',
      'Origin (físico) Produto sem vínculoFAGOO 4',
      'Origin (físico) Posição não observadaFAGOO Estoque nativo sem lançamentos']);
    assert.doesNotMatch(cells(view).join(' '), /Origin \(físico\) Sem lançamentos/, 'a Origin product never reads as “Sem lançamentos”');
    const select = view.input('catalog-stock-filter'), groups = select.props.children[1].props.children;
    assert.deepEqual(groups.map(group => group.props.label), ['Estoque nativo do FAGOO', 'Estoque Origin (físico observado)']);
    assert.deepEqual(groups[1].props.children.map(option => option.props.value), ['origin_positive', 'origin_zero', 'origin_negative', 'origin_not_observed', 'origin_unlinked']);
    await view.change('catalog-stock-filter', 'origin_positive'); await view.change('catalog-warehouse-filter', warehouse); await view.submit();
    const last = new URLSearchParams(calls.filter(call => call.path.startsWith('/v1/cadastros/products?')).at(-1).path.split('?')[1]);
    assert.deepEqual([last.get('stock'), last.get('warehouse_id')], ['origin_positive', warehouse]);
    assert.equal(calls.some(call => call.method && call.method !== 'GET'), false, 'opening and filtering the list never writes');
    assert.equal(calls.filter(call => call.path.includes('espelho')).length, 0, 'no per-product mirror call from the browser');
  } finally { view.unmount(); }
});

test('an unmatched warehouse is named in the chip; an API without the Origin summary keeps the native cell as before', async () => {
  const { controller } = server({ items: [product(1, { state: 'no_movements', quantity: null, warehouse: { id: warehouse, state: 'no_movements', quantity: null } }, empty('warehouse_unlinked'))],
    origin_stock: { ...ok, warehouse: { id: warehouse, source_id: null, linked: false } } });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    await view.change('catalog-stock-filter', 'origin_positive'); await view.change('catalog-warehouse-filter', warehouse); await view.submit();
    assert.ok(view.find(node => node.type?.name === 'AppliedChips').props.chips.some(chip => chip.label === 'Estoque Origin (físico): Maior que zero (Geral, sem correspondência no Origin)'));
    assert.match(cells(view)[0], /Depósito sem correspondência/);
  } finally { view.unmount(); }
  const old = server({ items: [product(1, noMovements, undefined)] });
  const legacy = await mountComponent('RealCatalog.tsx', { controller: old.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try { assert.deepEqual(cells(legacy), ['Sem lançamentos']); } finally { legacy.unmount(); }
});
