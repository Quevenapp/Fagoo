import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { parsePosRoute, posRoute } from '../../../workers/erp-api/src/pos.mjs';

// Synthetic data only. Vendas › Frente de caixa (RealPdv, migrations 202610200204-206): loja and caixa, product, payment,
// finalizar with "Conferir resultado", pré-venda for a vendedor without fechamento, late answers after a profile change.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), STORE = id(30), SESSION = id(31), DINHEIRO = id(40), CARTAO = id(41), PRODUCT = id(50), WAREHOUSE = id(60), CONSUMER = id(70), SALE = id(80), DOCUMENT = id(81);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const shortcuts = { cliente: 'C', pagamento: 'B', produto: 'Z', pesquisa: 'A', buscar: 'P', excluir: 'Q', fechar: 'M', finalizar: 'S', imprimir: 'I', nova: 'N', favoritos: 'G', 'remover-gtin': 'R', sangria: ',', suprimento: '.', 'trocar-loja': 'L', balcao: 'T', mesa: 'V' };
const context = (extra = {}, settings = {}) => ({ entity: 'pos_context', data_mode: 'erp_native', today: '2026-10-20', role: 'admin',
  permissions: { operate: true, items: true, payments: true, finish: true, edit_price: true, remove_items: true, change_method: true },
  effects: { cash: true, contacts: true, finance: true, fiscal: true, settings: true, stock: true },
  settings: { tables: false, cash_control: true, cash_check_methods: false, unique_cash: false, default_operation: 'nenhum', default_method: 'nenhum', receipt_order: 'insercao', percent_discount: false,
    closing_statuses: ['atendido', 'verificado'], negative_stock: true, block_zero: false, item_discount: true, group_items: true, shortcuts: { ...shortcuts }, sales_negative_stock: false, free_items: true, seller_required: false, ...settings },
  receipt: { limit_description: false, code: true, notes: false, comments: false, discount: false, footer: 'Obrigado pela preferência', font_size: 12 },
  stores: [{ id: STORE, name: 'Caixa loja sintética' }], accounts: [{ id: STORE, name: 'Caixa loja sintética', kind: 'cash' }],
  cash_sessions: [{ id: SESSION, account_id: STORE, account_name: 'Caixa loja sintética', operator_id: actor, operator_name: 'Operadora Sintética', opened_at: '2026-10-20T12:00:00Z', opened_on: '2026-10-20', change_cents: '5000', version: 1, own: true }],
  methods: [{ id: DINHEIRO, description: 'Dinheiro', payment_type: '01', destination: 'caixa', account_id: null, condition: null, is_default: false }, { id: CARTAO, description: 'Cartão de crédito', payment_type: '03', destination: 'contas', account_id: null, condition: '30 60', is_default: false }],
  warehouses: [{ id: WAREHOUSE, name: 'Depósito sintético' }], default_warehouse: { id: WAREHOUSE, name: 'Depósito sintético' }, seller: null, consumer: { id: CONSUMER, name: 'Consumidor final', active: true },
  pix: null, certificate: 'missing', settings_version: 1, ...extra });
const product = { id: PRODUCT, entity: 'products', version: 1, active: true, name: 'Caneta sintética', code: 'CAN-01', unit: 'UN', price: '10.0000', kind: 'P', gtin: '7891234567895', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', source: null };
const saleRecord = (extra = {}) => ({ id: SALE, document_id: DOCUMENT, number: '42', document_version: 4, status: 'fulfilled', state: 'finished', kind: 'balcao', table_number: null, date: '2026-10-20', created_at: '2026-10-20T13:00:00Z',
  finished_at: '2026-10-20T13:00:01Z', cancelled_at: null, operator_id: actor, operator_name: 'Operadora Sintética', account_id: STORE, account_name: 'Caixa loja sintética', cash_session_id: SESSION, contact_id: CONSUMER,
  contact_name: 'Consumidor final', customer_identified: false, total_cents: '2000', cash_received_cents: '5000', change_cents: '3000', effects: { stock: 'posted', finance: 'posted', settled_cents: '2000', open_cents: '0' }, invoice: null, version: 2,
  price_list_id: null, destination_account_id: null, to_ledger: false, cancel_reason: null, warehouse_id: WAREHOUSE, warehouse_name: 'Depósito sintético', seller_id: null, seller_name: null, category_id: null, expected_date: null, notes: null, internal_notes: null,
  discount_mode: 'amount', discount_value: '0.00', freight: '0.00', other_expenses: '0.00', totals: { gross: '20.00', line_discount: '0.00', subtotal: '20.00', discount: '0.00', freight: '0.00', other_expenses: '0.00', total: '20.00' }, contact_document: '',
  items: [{ id: id(90), position: 1, product_id: PRODUCT, description: 'Caneta sintética', code: 'CAN-01', unit: 'UN', quantity: '2.000000', unit_price: '10.0000', discount_percent: '0.0000', gross: '20.00', discount: '0.00', total: '20.00', comment: null }],
  payments: [{ position: 1, payment_method_id: DINHEIRO, method_name: 'Dinheiro', payment_type: '01', days: 0, due_on: '2026-10-20', amount_cents: '2000', note: null, title_id: id(91), settlement_id: id(92) }], ...extra });

function server({ role = 'admin', ctx = context(), post = () => { throw new Error('no post'); } } = {}) {
  const state = { session: { phase: 'ready', membership: { user_id: actor, role } } }, calls = [], listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async pos(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method === 'POST') return post(call, calls.filter(item => item.method === 'POST' && item.path === path).length);
      if (path === '/v1/frente-caixa') return structuredClone(ctx);
      if (path.startsWith('/v1/frente-caixa/vendas?')) return { entity: 'pos_sales', data_mode: 'erp_native', items: [], total: 0 };
      if (path === `/v1/frente-caixa/vendas/${SALE}`) return { entity: 'pos_sale', data_mode: 'erp_native', record: saleRecord() };
      throw new Error(`Unexpected ${path}`);
    },
    async finance(path) { calls.push({ path, method: 'GET' }); throw new AccessError(403); },
    async catalog(path) { calls.push({ path, method: 'GET' }); throw new Error(`catalog ${path}`); },
    async stockPositions(path) { calls.push({ path, method: 'GET' }); throw new Error(`stock ${path}`); },
    async company() { return { section: 'identity', record: null, data_mode: 'erp_native', emission_enabled: false }; },
    async documents() { throw new Error('documents'); },
  };
  return { controller, calls, posts: () => calls.filter(call => call.method === 'POST'),
    setRole(next) { state.session = { phase: 'ready', membership: { user_id: actor, role: next } }; for (const listener of listeners) listener(); } };
}
const mount = (source, expand = []) => mountComponent('RealPdv.tsx', { controller: source.controller }, { location: '/frente-caixa-empresa', expandChildren: expand });
const component = (view, name, predicate = () => true) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name && predicate(node.props));
const button = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node).startsWith(label)).at(-1);
const press = async (view, label) => { const found = button(view, label); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick({ preventDefault() {} }); await settle(view); };
const addProduct = async view => {
  component(view, 'CatalogPicker', props => props.entity === 'products').props.onSelect(product); await settle(view);
  await view.change('pdv-quantity', '2'); await press(view, 'Inserir');
};

test('PDV: loja and caixa from the context, configured shortcuts, certificate alert and the item in the sale', async () => {
  const source = server({ ctx: context({}, { shortcuts: { ...shortcuts, finalizar: 'F', favoritos: 'S' } }) }), view = await mount(source);
  try {
    await settle(view);
    const shown = view.text();
    assert.match(shown, /Caixa loja sintética/); assert.match(shown, /Caixa aberto · Operadora Sintética/); assert.match(shown, /Certificado inválido/);
    assert.match(shown, /Finalizar venda \(Alt\+F\)/, 'the key of Preferências › Teclas de atalho');
    assert.match(shown, /Produto \(Alt\+Z\)Cliente \(Alt\+C\)Pagamento \(Alt\+B\)/);
    await addProduct(view);
    assert.match(view.text(), /Caneta sintéticaCód: CAN-01/); assert.match(view.text(), /Total R\$ 20,00/);
    assert.equal(view.guard().changed, true, 'a sale in progress keeps the unsaved-changes guard');
  } finally { view.unmount(); }
});

test('Finalizar venda: one à vista parcel follows the total; an uncertain answer repeats the same command; the sale is cleared after it', async () => {
  const answer = { action: 'sale_finish', replayed: false, data_mode: 'erp_native', entity: 'pos_sale', record: saleRecord() };
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return answer; } }), view = await mount(source);
  try {
    await settle(view); await addProduct(view);
    view.find(node => node.type === 'button' && text(node).startsWith('Pagamento')).props.onClick(); await settle(view);
    assert.match(view.text(), /Total da vendaR\$ 20,00/);
    await view.change('pdv-received', '50,00');
    assert.match(view.text(), /Troco em dinheiroR\$ 30,00/);
    await press(view, 'Finalizar venda');
    assert.match(view.text(), /Conferir resultado/);
    await press(view, 'Conferir resultado');
    const [first, second] = source.posts();
    assert.equal(first.path, '/v1/frente-caixa/actions/sale_finish');
    assert.deepEqual(second.body, first.body, 'the same command id and body');
    const { data } = first.body;
    assert.deepEqual([data.account_id, data.cash_session_id, data.contact_id, data.cash_received_cents, data.payments], [STORE, SESSION, null, '5000', [{ payment_method_id: DINHEIRO, days: 0, amount_cents: '2000', note: null }]]);
    assert.deepEqual(data.document.items.map(item => [item.product_id, item.quantity, item.unit_price, item.discount_percent]), [[PRODUCT, '2', '10.0000', '0']]);
    await parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa/actions/sale_finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first.body) }), posRoute('/v1/frente-caixa/actions/sale_finish'));
    assert.match(view.text(), /Venda nº 42 finalizada\./);
    assert.match(view.text(), /Total R\$ 0,00/);
    assert.equal(view.guard().changed, false);
  } finally { view.unmount(); }
});

test('Vendedor sem fechamento envia a pré-venda (sale_save, sem pagamento obrigatório); sem itens, nada é enviado', async () => {
  const ctx = context({ role: 'vendas', permissions: { operate: true, items: true, payments: false, finish: false, edit_price: false, remove_items: false, change_method: false }, effects: { cash: false, contacts: true, finance: false, fiscal: false, settings: false, stock: false } }, { cash_control: false });
  const answer = { action: 'sale_save', replayed: false, data_mode: 'erp_native', entity: 'pos_sale', record: saleRecord({ state: 'open', status: 'open', finished_at: null, effects: {}, payments: [], cash_received_cents: null, change_cents: '0' }) };
  const source = server({ role: 'vendas', ctx, post: () => answer }), view = await mount(source);
  try {
    await settle(view);
    assert.equal(button(view, 'Enviar pré-venda').disabled, true, 'nothing to send without items');
    await addProduct(view);
    assert.equal(view.input('pdv-unit-price').props.readOnly, true, 'Editar o preço unitário is off for this vendedor');
    await press(view, 'Enviar pré-venda');
    const [post] = source.posts();
    assert.equal(post.path, '/v1/frente-caixa/actions/sale_save');
    assert.deepEqual([post.body.data.cash_session_id, post.body.data.payments], [SESSION, []], 'the shared caixa of the loja, no payment registered');
    assert.match(view.text(), /Pré-venda nº 42 enviada para o caixa\./);
  } finally { view.unmount(); }
});

test('A profile change during the reading drops the late answer; consulta only reads', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const source = server(), original = source.controller.pos;
  const readOnly = { permissions: { operate: false, items: false, payments: false, finish: false, edit_price: false, remove_items: false, change_method: false }, effects: { cash: false, contacts: false, finance: false, fiscal: false, settings: false, stock: false } };
  source.controller.pos = async (path, options) => {
    if (path !== '/v1/frente-caixa') return original(path, options);
    const role = source.controller.getSnapshot().membership.role; await gate;
    return role === 'admin' ? context({ stores: [{ id: STORE, name: 'Loja lida pelo administrador' }] }) : context({ role, ...readOnly, stores: [{ id: STORE, name: 'Loja lida pela consulta' }] });
  };
  const view = await mount(source);
  try {
    source.setRole('consulta'); await settle(view);
    release(); await settle(view); await settle(view);
    const after = view.text();
    assert.doesNotMatch(after, /Loja lida pelo administrador/, 'the answer read for the administrador is dropped after the profile change');
    assert.match(after, /Loja lida pela consulta/); assert.match(after, /Somente consulta./);
  } finally { view.unmount(); }
  const consulta = server({ role: 'consulta', ctx: context({ role: 'consulta', permissions: { operate: false, items: false, payments: false, finish: false, edit_price: false, remove_items: false, change_method: false }, effects: { cash: false, contacts: false, finance: false, fiscal: false, settings: false, stock: false } }) });
  const read = await mount(consulta);
  try {
    await settle(read);
    assert.match(read.text(), /Somente consulta\./);
    assert.equal(button(read, 'Finalizar venda').disabled, true);
  } finally { read.unmount(); }
});

test('Selecione uma loja: without an open caixa the Troco opens it through the Controle de caixa, with "Conferir resultado"', async () => {
  const opened = { action: 'session_open', replayed: false, entity: 'cash_sessions', data_mode: 'erp_native', record: { id: SESSION, account_id: STORE, operator_id: actor, operator_name: 'Operadora Sintética', version: 1, opened_at: '2026-10-20T12:00:00Z', opened_on: '2026-10-20', change_cents: '2500' } };
  const source = server({ ctx: context({ cash_sessions: [] }) });
  let finance = 0;
  source.controller.finance = async (path, options = {}) => { source.calls.push({ path, method: options.method ?? 'GET', body: options.body && structuredClone(options.body) }); finance++; if (finance === 1) throw new AccessError(503); return opened; };
  const view = await mount(source, ['PdvStoreDialog', 'Modal', 'Field']);
  try {
    await settle(view);
    assert.match(view.text(), /Selecione uma loja/); assert.match(view.text(), /Para habilitar as funcionalidades do frente de caixa, o caixa deve ser aberto\./);
    const troco = view.find(node => node.type === 'label' && text(node) === 'Troco').props.htmlFor;
    await view.change(troco, '25,00');
    await press(view, 'Ok'); assert.match(view.text(), /Conferir resultado/);
    await press(view, 'Conferir resultado');
    const posts = source.calls.filter(call => call.method === 'POST');
    assert.deepEqual(posts.map(call => call.path), ['/v1/financeiro/actions/session_open', '/v1/financeiro/actions/session_open']);
    assert.deepEqual(posts[1].body, posts[0].body); assert.deepEqual(posts[0].body.data, { account_id: STORE, change_cents: '2500' });
    assert.match(view.text(), /Caixa de Caixa loja sintética em uso\./);
  } finally { view.unmount(); }
});

test('Método de pagamento padrão PIX - QR Code impresso: the payment starts in Pix and finishing waits for "Pagamento recebido"', async () => {
  const PIX = id(42), ctx = context({ pix: { key_type: 'email', key: 'pix@sintetico.test', merchant_name: 'LOJA SINTETICA', merchant_city: 'SAO PAULO' },
    methods: [...context().methods, { id: PIX, description: 'Pix', payment_type: '20', destination: 'caixa', account_id: id(35), condition: null, is_default: false }] }, { default_method: 'pix_qrcode_impresso', default_operation: 'comprovante' });
  const answer = { action: 'sale_finish', replayed: false, data_mode: 'erp_native', entity: 'pos_sale', record: saleRecord({ payments: [{ ...saleRecord().payments[0], payment_method_id: PIX, method_name: 'Pix', payment_type: '20' }], cash_received_cents: null, change_cents: '0' }) };
  const source = server({ ctx, post: () => answer }), view = await mount(source, ['PdvPixDialog', 'Modal', 'PdvQr']);
  try {
    await settle(view); await addProduct(view);
    await press(view, 'Finalizar venda');
    assert.equal(source.posts().length, 0, 'nothing is sent before the operator confirms the Pix');
    assert.match(view.text(), /Pix - QR Code Impresso/); assert.match(view.text(), /Valor: R\$ 20,00/);
    const payload = view.nodes().find(node => node.type === 'code');
    assert.match(text(payload), /^000201.*0014br\.gov\.bcb\.pix0118pix@sintetico\.test.*540520\.00.*6304[0-9A-F]{4}$/);
    await press(view, 'Pagamento recebido');
    const [post] = source.posts();
    assert.deepEqual(post.body.data.payments, [{ payment_method_id: PIX, days: 0, amount_cents: '2000', note: null }]);
    assert.ok(component(view, 'PdvReceiptPrint'), 'Operação padrão: Imprimir comprovante não fiscal');
  } finally { view.unmount(); }
});

test('Comprovante de 80 mm: ordem Alfabética, código, troco, Pix QR and the footer of Preferências › Vendas', async () => {
  const sale = saleRecord({ items: [{ ...saleRecord().items[0], description: 'Zebra de pelúcia', position: 1 }, { ...saleRecord().items[0], id: id(93), description: 'Abacaxi', code: 'ABX', position: 2 }] });
  const view = await mountComponent('PdvReceiptPrint.tsx', { job: { kind: 'sale', sale, pix: null }, receipt: context().receipt, order: 'alfabetica', company: { name: 'Loja Sintética', cnpj: '12345678000195' } }, { componentName: 'PdvReceiptSheet' });
  try {
    const shown = view.text();
    assert.match(shown, /Loja SintéticaCNPJ: 12345678000195Comprovante de vendaNão é documento fiscal/);
    assert.ok(shown.indexOf('Abacaxi') < shown.indexOf('Zebra'), 'Alfabética');
    assert.match(shown, /AbacaxiABX/); assert.match(shown, /Total recebido em dinheiroR\$ 50,00Troco em dinheiroR\$ 30,00/);
    assert.match(shown, /Obrigado pela preferência/); assert.match(shown, /Consumidor não identificado/);
  } finally { view.unmount(); }
});

// Review (onda D): the open sale goes back with the version of the pedido the screen read; the devolução says what left the caixa.
test('Pré-venda aberta: Abrir na venda e finalizar envia sale_id, expected_version e a versão do pedido lida', async () => {
  const open = saleRecord({ state: 'open', status: 'open', finished_at: null, effects: {}, payments: [], cash_received_cents: null, change_cents: '0', version: 3, document_version: 7 });
  const answer = { action: 'sale_finish', replayed: false, data_mode: 'erp_native', entity: 'pos_sale', record: saleRecord({ version: 4, document_version: 9 }) };
  const source = server({ post: () => answer }), original = source.controller.pos;
  source.controller.pos = async (path, options = {}) => {
    if (path.startsWith('/v1/frente-caixa/vendas?') && path.includes('state=open')) return { entity: 'pos_sales', data_mode: 'erp_native', items: [open], total: 1 };
    if (path === `/v1/frente-caixa/vendas/${SALE}`) return { entity: 'pos_sale', data_mode: 'erp_native', record: { ...open, returns: [], returned: {} } };
    return original(path, options);
  };
  const view = await mount(source);
  try {
    await settle(view);
    view.find(node => node.type === 'button' && text(node).startsWith('Pré-venda 42')).props.onClick(); await settle(view);
    await press(view, 'Abrir na venda');
    assert.match(view.text(), /Venda nº 42/);
    await press(view, 'Finalizar venda');
    const [post] = source.posts();
    assert.equal(post.path, '/v1/frente-caixa/actions/sale_finish');
    assert.deepEqual([post.body.data.sale_id, post.body.data.expected_version, post.body.data.document_version], [SALE, 3, 7]);
    assert.deepEqual(post.body.data.document.items.map(item => [item.id, item.quantity]), [[id(90), '2']], 'the saved item keeps its id and quantity');
    await parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa/actions/sale_finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post.body) }), posRoute('/v1/frente-caixa/actions/sale_finish'));
  } finally { view.unmount(); }
});

test('Gerar devolução: the message says when nothing left the caixa, and the next devolução counts what was already returned', async () => {
  const returned = saleRecord({ version: 3, returns: [{ id: id(95), created_at: '2026-10-20T14:00:00Z', value_cents: '1000', refund_cents: '0', reason: 'Defeito', actor_name: 'Operadora Sintética', stock: true, refund_account_id: null, items: [{ item_id: id(90), quantity: '1.000000', value_cents: '1000' }] }], returned: { [id(90)]: '1.000000' } });
  const answer = { action: 'sale_return', replayed: false, data_mode: 'erp_native', entity: 'pos_sale', record: returned, return: { value_cents: '1000', refund_cents: '0', stock: true, refund: false, items: [{ item_id: id(90), quantity: '1.000000', value_cents: '1000' }] } };
  const source = server({ post: () => answer }), original = source.controller.pos;
  source.controller.pos = async (path, options = {}) => {
    if (path.startsWith('/v1/frente-caixa/vendas?') && !path.includes('state=open')) return { entity: 'pos_sales', data_mode: 'erp_native', items: [saleRecord()], total: 1 };
    if (path === `/v1/frente-caixa/vendas/${SALE}`) return { entity: 'pos_sale', data_mode: 'erp_native', record: { ...saleRecord(), returns: [], returned: {} } };
    return original(path, options);
  };
  const view = await mount(source, ['PdvReturnDialog', 'Modal', 'Field']);
  try {
    await settle(view);
    view.find(node => node.type === 'button' && text(node).startsWith('42')).props.onClick(); await settle(view);
    await press(view, 'Gerar devolução');
    await view.change(`pdv-return-${id(90)}`, '1');
    const motivo = view.find(node => node.type === 'label' && text(node) === 'Motivo *').props.htmlFor;
    await view.change(motivo, 'Produto com defeito');
    await press(view, 'Gerar devolução');
    const [post] = source.posts();
    assert.deepEqual(post.body.data, { sale_id: SALE, expected_version: 2, items: [{ item_id: id(90), quantity: '1' }], refund_account_id: STORE, cash_session_id: SESSION, reason: 'Produto com defeito' });
    assert.match(view.text(), /Devolução registrada\. Os produtos voltaram ao estoque\. Nenhum valor saiu do caixa \(itens de R\$ 10,00\)\./);
    assert.match(view.text(), /Devoluções: R\$ 10,00 em/);
    assert.equal(button(view, 'Cancelar venda').disabled, true, 'a sale with a devolução is not cancelled');
    await press(view, 'Gerar devolução');
    assert.match(view.text(), /Pode devolver.*Caneta sintética2 UN1/, 'one of the two units is still returnable');
  } finally { view.unmount(); }
});

test('Aba Cliente: o Tipo sai do CPF/CNPJ quando a busca de clientes não traz a pessoa (contatos espelhados do Origin)', async () => {
  const source = server(), view = await mount(source);
  try {
    await settle(view);
    view.find(node => node.type === 'button' && text(node).startsWith('Cliente')).props.onClick(); await settle(view);
    component(view, 'CatalogPicker', props => props.entity === 'contacts').props.onSelect({ id: id(71), entity: 'contacts', version: 1, active: true, name: 'Cliente espelhado', code: 'C-1', document: '123.456.789-01', trade_name: null, state: 'SP', created_at: '', updated_at: '', source: null });
    await settle(view);
    assert.match(view.text(), /NomeCliente espelhadoTipoPessoa físicaCNPJ\/CPF123\.456\.789-01CódigoC-1/);
  } finally { view.unmount(); }
});

test('Finalizar venda (202610200267): a refused Lançar estoque or baixa à vista finishes the sale and the message says why it stayed pending', async () => {
  const record = saleRecord({ effects: { stock: 'pending', finance: 'posted', settled_cents: '0', open_cents: '2000', stock_reason: 'stock_policy', settle_reason: 'account_invalid' } });
  const source = server({ post: () => ({ action: 'sale_finish', replayed: false, data_mode: 'erp_native', entity: 'pos_sale', record }) }), view = await mount(source);
  try {
    await settle(view); await addProduct(view);
    view.find(node => node.type === 'button' && text(node).startsWith('Pagamento')).props.onClick(); await settle(view);
    await view.change('pdv-received', '20,00');
    await press(view, 'Finalizar venda');
    const shown = view.text();
    assert.match(shown, /Venda nº 42 finalizada\. O estoque ficou pendente no pedido \(use Lançar estoque\): O lançamento de estoque deixaria o saldo negativo/);
    assert.match(shown, /A baixa à vista não foi feita e a parcela ficou em aberto em Contas a receber: A conta financeira escolhida não está ativa\./);
    assert.doesNotMatch(shown, /o seu perfil não os lança/, 'the administrador posts; the reason is the refusal');
    assert.equal(source.posts().length, 1);
  } finally { view.unmount(); }
});

test('202610200282 PRD-149: the Lista de preço of the venda asks for the lists of the Vendedor and of the formas de pagamento of the parcelas', async () => {
  const SELLER = id(95), source = server({ ctx: context({ seller: { id: SELLER, name: 'Vendedora sintética' } }) }), view = await mount(source);
  try {
    await settle(view); await addProduct(view);
    const lists = () => component(view, 'DocumentPriceList');
    assert.equal(lists().props.seller, SELLER);
    view.find(node => node.type === 'button' && text(node).startsWith('Pagamento')).props.onClick(); await settle(view);
    view.find(node => node.type === 'button' && text(node).startsWith('Produto')).props.onClick(); await settle(view);
    assert.deepEqual(lists().props.paymentMethods, [DINHEIRO], 'the forma of the parcela');
    // The request itself (vendedor and forma_pagamento of /aplicaveis) is checked by misto-f-ui with DocumentPriceList mounted.
    assert.equal(lists().props.contact, null, 'no cliente chosen yet');
  } finally { view.unmount(); }
});
