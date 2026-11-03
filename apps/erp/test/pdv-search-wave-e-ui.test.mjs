import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { productSearchPath } from '../src/lib/product-search-model.ts';

// Synthetic data only. Documentos lane wave E: Frente de caixa "Pesquisa avançada (Alt+A)" of the product (VND-280) and the
// Pesquisa avançada of the cliente handing the whole row to the client panel (Tipo, CNPJ/CPF, Código and Fantasia).
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), STORE = id(30), SESSION = id(31), DINHEIRO = id(40), PRODUCT = id(50), OTHER = id(51), WAREHOUSE = id(60), CONSUMER = id(70), CLIENT = id(71);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const shortcuts = { cliente: 'C', pagamento: 'B', produto: 'Z', pesquisa: 'A', buscar: 'P', excluir: 'Q', fechar: 'M', finalizar: 'S', imprimir: 'I', nova: 'N', favoritos: 'G', 'remover-gtin': 'R', sangria: ',', suprimento: '.', 'trocar-loja': 'L', balcao: 'T', mesa: 'V' };
const context = () => ({ entity: 'pos_context', data_mode: 'erp_native', today: '2026-10-20', role: 'admin',
  permissions: { operate: true, items: true, payments: true, finish: true, edit_price: true, remove_items: true, change_method: true },
  effects: { cash: true, contacts: true, finance: true, fiscal: true, settings: true, stock: true },
  settings: { tables: false, cash_control: true, cash_check_methods: false, unique_cash: false, default_operation: 'nenhum', default_method: 'nenhum', receipt_order: 'insercao', percent_discount: false,
    closing_statuses: ['atendido', 'verificado'], negative_stock: true, block_zero: false, item_discount: true, group_items: true, shortcuts: { ...shortcuts }, sales_negative_stock: false, free_items: true, seller_required: false },
  receipt: { limit_description: false, code: true, notes: false, comments: false, discount: false, footer: 'Obrigado', font_size: 12 },
  stores: [{ id: STORE, name: 'Caixa loja sintética' }], accounts: [{ id: STORE, name: 'Caixa loja sintética', kind: 'cash' }],
  cash_sessions: [{ id: SESSION, account_id: STORE, account_name: 'Caixa loja sintética', operator_id: actor, operator_name: 'Operadora Sintética', opened_at: '2026-10-20T12:00:00Z', opened_on: '2026-10-20', change_cents: '5000', version: 1, own: true }],
  methods: [{ id: DINHEIRO, description: 'Dinheiro', payment_type: '01', destination: 'caixa', account_id: null, condition: null, is_default: false }],
  warehouses: [{ id: WAREHOUSE, name: 'Depósito sintético' }], default_warehouse: { id: WAREHOUSE, name: 'Depósito sintético' }, seller: null, consumer: { id: CONSUMER, name: 'Consumidor final', active: true },
  pix: null, certificate: 'missing', settings_version: 1 });
const record = (n, name, extra = {}) => ({ id: n, entity: 'products', version: 1, active: true, name, code: `C-${name.slice(0, 3)}`, unit: 'UN', price: '10.0000', kind: 'P', gtin: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', source: null, ...extra });
const page = (items, next = null) => ({ entity: 'products', items, next_cursor: next, has_more: next !== null, limit: 10, data_mode: 'erp_native' });

function server({ catalog = () => page([]) } = {}) {
  const state = { session: { phase: 'ready', membership: { user_id: actor, role: 'admin' } } }, calls = [], listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async pos(path) { calls.push({ path, method: 'GET' });
      if (path === '/v1/frente-caixa') return structuredClone(context());
      if (path.startsWith('/v1/frente-caixa/vendas?')) return { entity: 'pos_sales', data_mode: 'erp_native', items: [], total: 0 };
      throw new Error(`Unexpected ${path}`); },
    async finance() { throw new AccessError(403); },
    async catalog(path) { calls.push({ path, method: 'GET' }); return catalog(path); },
    async stockPositions(path) { throw new Error(`stock ${path}`); },
    async company() { return { section: 'identity', record: null, data_mode: 'erp_native', emission_enabled: false }; },
    async documents() { throw new Error('documents'); },
  };
  return { controller, calls, setUser(user) { state.session = { phase: 'ready', membership: { user_id: user, role: 'admin' } }; for (const listener of listeners) listener(); } };
}
const component = (view, name, predicate = () => true) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name && predicate(node.props));
const button = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node).startsWith(label)).at(-1);
const press = async (view, label) => { const found = button(view, label); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick({ preventDefault() {} }); await settle(view); };

test('search path: active products, 10 a time, with Tipo, Formato, Marca and the cursor; invalid text is refused', () => {
  assert.equal(productSearchPath({ q: ' caneta ', kind: 'P', format: 'S', brand: 'Marca X' }, null), '/v1/cadastros/products?limit=10&active=true&q=caneta&kind=P&format=S&brand=Marca+X');
  assert.equal(productSearchPath({ q: '', kind: '', format: '', brand: '' }, OTHER), `/v1/cadastros/products?limit=10&active=true&after=${OTHER}`);
  assert.throws(() => productSearchPath({ q: 'a\nb', kind: '', format: '', brand: '' }, null));
});

test('Pesquisa avançada (Alt+A) of the product: filters, Mais resultados and Selecionar fill the Produto panel', async () => {
  const source = server({ catalog: path => path.includes('after=') ? page([record(OTHER, 'Lápis sintético')]) : page([record(PRODUCT, 'Caneta sintética', { gtin: '7891234567895' })], PRODUCT) });
  const view = await mountComponent('RealPdv.tsx', { controller: source.controller }, { location: '/frente-caixa-empresa', expandChildren: ['ProductAdvancedSearch'] });
  try {
    await settle(view);
    assert.ok(button(view, 'Pesquisa avançada (Alt+A)'), 'the button shows the configured key');
    await press(view, 'Pesquisa avançada (Alt+A)');
    assert.match(view.text(), /Pesquise por código, descrição ou GTIN.*Tipo.*Formato.*Marca/s); assert.match(view.text(), /Caneta sintética.*7891234567895.*R\$ 10,00/s);
    await view.change('product-search-kind', 'S');
    view.nodes().find(node => node.type === 'form' && node.props.className === 'document-contact-search').props.onSubmit({ preventDefault() {}, stopPropagation() {} }); await settle(view);
    assert.ok(source.calls.some(call => call.path.includes('kind=S')), 'Tipo goes to the server');
    await press(view, 'Mais resultados');
    assert.match(view.text(), /Lápis sintético/);
    const select = view.nodes().filter(node => node.type === 'button' && text(node) === 'Selecionar')[0];
    select.props.onClick({ preventDefault() {} }); await settle(view);
    assert.equal(view.nodes().some(node => node.props?.id === 'product-search-kind'), false, 'the dialog closes');
    assert.deepEqual(component(view, 'CatalogPicker', props => props.entity === 'products').props.selected, { id: PRODUCT, name: 'Caneta sintética' });
  } finally { view.unmount(); }
});

test('Pesquisa avançada of the product: a late answer after a session change is not shown', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const source = server({ catalog: () => pending.then(() => page([record(PRODUCT, 'Caneta sintética')])) });
  const view = await mountComponent('ProductAdvancedSearch.tsx', { controller: source.controller, initialQuery: 'can', onSelect() {}, onClose() {} });
  try {
    source.setUser(id(2)); release(); await settle(view);
    assert.doesNotMatch(view.text(), /Caneta sintética/); assert.match(view.text(), /A sessão mudou/);
  } finally { view.unmount(); }
});

test('Pesquisa avançada of the cliente: Tipo, CNPJ/CPF, Código and Fantasia come from the chosen row', async () => {
  const source = server({ catalog: path => path.startsWith('/v1/cadastros/contatos?') ? { items: [{ id: CLIENT, name: 'Cliente Sintético Ltda', trade_name: 'Sintético', code: 'CLI-9', document: '11222333000181', person_type: 'J', city: 'Piracicaba', state: 'SP', situation: 'A' }], total: 1 }
    : path.startsWith('/v1/cadastros/tipos-contato') ? { items: [] } : page([]) });
  const view = await mountComponent('RealPdv.tsx', { controller: source.controller }, { location: '/frente-caixa-empresa', expandChildren: ['DocumentContactSearch'] });
  try {
    await settle(view);
    await press(view, 'Cliente (Alt+C)');
    await press(view, 'Pesquisa avançada');
    const select = view.nodes().filter(node => node.type === 'button' && text(node) === 'Selecionar')[0];
    assert.ok(select); select.props.onClick({ preventDefault() {} }); await settle(view);
    const shown = view.text();
    assert.match(shown, /Cliente Sintético Ltda/); assert.match(shown, /Pessoa jurídica/); assert.match(shown, /11222333000181/); assert.match(shown, /CLI-9/); assert.match(shown, /Sintético/);
  } finally { view.unmount(); }
});
