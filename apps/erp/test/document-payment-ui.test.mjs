import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { methodCondition, readPaymentOptions, withMethod } from '../src/lib/document-payment-model.ts';
import { autoFinanceMessage, readSupplierCodes } from '../src/lib/document-pricing-model.ts';

// 202610200196 Pagamento (Destino, Detalhes de pagamento, Forma e "Ver detalhes"), Preço lista, Código no fornecedor, impostos e
// o lançamento automático de contas no editor de documentos. Synthetic controller; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000196', contact = 'c0000000-0000-4000-8000-000000000196', product = 'f0000000-0000-4000-8000-000000000196';
const cash = 'e0000000-0000-4000-8000-000000000196', card = 'e1000000-0000-4000-8000-000000000196', threeTimes = 'e2000000-0000-4000-8000-000000000196';
const methods = [{ id: card, description: 'Cartão crédito', payment_type: '03', condition: null, destination: 'caixa', account_id: cash, card_brand: '01', card_integration: '2', card_cnpj: null, is_default: false },
  { id: threeTimes, description: 'Boleto 3x', payment_type: '15', condition: '30 60 90', destination: 'contas', account_id: null, card_brand: null, card_integration: null, card_cnpj: null, is_default: true }];
const options = (kind, list = methods) => ({ kind, methods: list, accounts: kind === 'sales_proposals' ? [] : [{ id: cash, name: 'Caixa', kind: 'cash' }], data_mode: 'erp_native', operational_effects: false });
const settle = async view => { for (let i = 0; i < 4; i += 1) { await new Promise(resolve => setTimeout(resolve, 15)); await view.flush(); } };
const picker = (view, entity) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === entity && n.props.label !== 'Transportador');
function withDocument() { const previous = globalThis.document; globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} }; return () => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }; }
const section = view => view.nodes().find(n => n.type === 'fieldset' && typeof n.props.onMouseEnter === 'function');
function service({ kind = 'sales_orders', paymentMethods = methods, onPost } = {}) {
  const calls = [], posts = [];let last = null;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: kind === 'purchase_orders' ? 'estoque' : 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; return { items: [], has_more: false }; },
    async documents(path, request = {}) {
      calls.push({ path, method: request.method });
      if (path.endsWith('/pagamento')) return options(kind, paymentMethods);
      if (path.includes('/codigos-fornecedor?')) return { contact_id: contact, items: [{ product_id: product, code: 'FORN-9' }], data_mode: 'erp_native', operational_effects: false };
      if (path.endsWith('/proximo-numero')) return { kind, next_number: '10', reserved: false, data_mode: 'erp_native', operational_effects: false };
      if (request.method === 'POST') {
        posts.push(structuredClone(request.body));
        const doc = { ...normalizeDocument(kind, request.body.data), id: 'b0000000-0000-4000-8000-000000000196', kind, number: '10', version: 1, status: 'open', contact_snapshot: { id: contact, name: 'Cliente' }, source_proposal_id: null,
          effect_flags: { finance_active: false, stock_active: false }, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
        doc.items = doc.items.map((item, index) => ({ ...item, id: item.id ?? `d000000${index}-0000-4000-8000-000000000196`, product_snapshot: null }));
        last = doc; return { kind, document: doc, replayed: false, ...(onPost?.() ?? {}), data_mode: 'erp_native', operational_effects: false };
      }
      if (last && path.endsWith(last.id)) return { kind, document: last, data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
  };
  return { controller, calls, posts };
}
const mount = (s, kind = 'sales_orders', extra = {}) => mountComponent('RealDocuments.tsx', { controller: s.controller, kind, record: null, writable: true, onSaved: extra.onSaved ?? (() => {}), onClose() {}, onConverted() {} },
  { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentPaymentHeader', 'InstallmentMethod', 'InstallmentDetailsDialog', 'Modal', 'DocumentAutoFinance'] });

test('payment model: options, condição of a forma cadastrada, Forma of a parcela and supplier codes', () => {
  const read = readPaymentOptions(options('sales_orders'), 'sales_orders');
  assert.deepEqual(read.accounts.map(a => a.name), ['Caixa']);
  assert.throws(() => readPaymentOptions({ ...options('sales_orders'), kind: 'purchase_orders' }, 'sales_orders'));
  assert.deepEqual(methodCondition(' boleto 3X ', read.methods), { condition: '30 60 90', method: read.methods[1] });
  assert.equal(methodCondition('30 60', read.methods), null);
  assert.deepEqual(methodCondition('Cartão crédito', read.methods)?.condition, '0', 'a forma without condição is à vista');
  const row = withMethod({ due_date: '2026-10-20', amount: '10.00', method: null, details: null }, read.methods[0], 'sales_orders');
  assert.deepEqual([row.payment_method_id, row.method, row.details.payment_type, row.details.card_brand, row.details.account_id], [card, 'Cartão crédito', '03', '01', cash]);
  assert.equal(Object.hasOwn(withMethod({ due_date: '2026-10-20', amount: '1' }, read.methods[0], 'sales_proposals'), 'details'), false, 'propostas have no details');
  assert.deepEqual([...readSupplierCodes({ contact_id: contact, items: [{ product_id: product, code: 'F-1' }] }, contact)], [[product, 'F-1']]);
  assert.match(autoFinanceMessage({ outcome: 'done', posting_id: card }), /lançadas automaticamente/);
  assert.match(autoFinanceMessage({ outcome: 'skipped', reason: 'erp_finance_access_denied' }), /seu perfil não lança contas/);
});

test('pedido de venda: Destino, Detalhes de pagamento, Forma and Ver detalhes are saved with the parcelas', async () => {
  const restore = withDocument(), s = service(), view = await mount(s);
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    assert.equal(s.calls.filter(c => c.path.endsWith('/pagamento')).length, 0, 'nothing is read before the section is used');
    await view.click('Adicionar outra parcela');
    section(view).props.onMouseEnter(); await settle(view);
    assert.equal(s.calls.filter(c => c.path.endsWith('/pagamento')).length, 1);
    const destination = view.input('doc-payment-destination');
    // Leva H (VND-131): the caixas and the other contas financeiras are grouped; they only choose the conta prevista.
    assert.deepEqual([destination.props.children[2].props.label, destination.props.children[2].props.children.map(o => o.props.children)], ['Caixa', ['Caixa']]);
    assert.match(view.text(), /O Destino escolhe a conta prevista/);
    await view.change('doc-payment-destination', cash);
    await view.change('doc-payment-means', '17'); await view.change('doc-payment-indicator', '1');
    await view.change('doc-installment-amount-0', '10');
    await view.change('doc-installment-method-0', card);
    await view.click('Ver detalhes');
    assert.match(view.text(), /Detalhes da parcela/);
    await view.change('doc-detail-authorization', 'AUT-77'); await view.change('doc-detail-fee', '0,5');
    await view.click('OK');
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '10', kind: 'P' }); await view.flush();
    await view.submit(); await settle(view);
    assert.equal(s.posts.length, 1, JSON.stringify(view.text()).slice(0, 400));
    const data = s.posts[0].data;
    assert.deepEqual([data.payment_account_id, data.payment_means, data.payment_indicator], [cash, '17', '1']);
    assert.deepEqual([data.installments[0].payment_method_id, data.installments[0].method, data.installments[0].details.authorization_code, data.installments[0].details.fee_amount, data.installments[0].details.payment_type],
      [card, 'Cartão crédito', 'AUT-77', '0.50', '03']);
    assert.equal(data.items.at(-1).list_price, '10', 'Preço lista of the product');
  } finally { view.unmount(); restore(); }
});

test('Gerar parcelas with a forma cadastrada uses its condição and that forma', async () => {
  const s = service(), view = await mount(s);
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '30', kind: 'P' }); await view.flush();
    await view.change('doc-condition', 'Boleto 3x'); await view.click('Gerar parcelas'); await settle(view);
    assert.equal(view.input('doc-installment-method-2').props.value, threeTimes);
    assert.deepEqual([0, 1, 2].map(i => view.input(`doc-installment-amount-${i}`).props.value), ['10,00', '10,00', '10,00']);
  } finally { view.unmount(); }
});

test('without formas cadastradas: the Origin warning with Configurar formas', async () => {
  const s = service({ paymentMethods: [] }), view = await mount(s);
  try {
    await view.click('Adicionar outra parcela'); section(view).props.onMouseEnter(); await settle(view);
    assert.match(view.text(), /Não será possível utilizar esta seção pois você não possui forma de pagamentos cadastradas nesta conta\./);
    await view.click('Configurar formas');
    assert.equal(view.location().pathname, '/formas-pagamento-empresa');
  } finally { view.unmount(); }
});

test('pedido de compra: Código no fornecedor filled from the vínculo produto-fornecedor and Código SKU of the product', async () => {
  const s = service({ kind: 'purchase_orders' }), view = await mount(s, 'purchase_orders');
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Fornecedor', state: 'SP' }); await view.flush();
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'SKU-1', unit: 'UN', price: '10', kind: 'P' }); await settle(view);
    const index = 0;
    assert.equal(view.input(`doc-item-supplier-code-${index}`).props.value, 'FORN-9');
    assert.ok(view.nodes().some(n => n.type === 'input' && n.props['aria-label'] === `Código SKU do item ${index + 1}` && n.props.value === 'SKU-1' && n.props.readOnly));
    await view.change(`doc-item-supplier-code-${index}`, 'FORN-10');
    await view.submit(); await settle(view);
    assert.equal(s.posts[0].data.items[0].supplier_code, 'FORN-10');
  } finally { view.unmount(); }
});

test('the save answer tells whether the contas were posted automatically', async () => {
  let message = null;
  const s = service({ onPost: () => ({ auto_finance: { outcome: 'skipped', reason: 'erp_finance_access_denied' } }) }), view = await mount(s, 'sales_orders', { onSaved: (_record, text) => { message = text; } });
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '10', kind: 'P' }); await view.flush();
    await view.submit(); await settle(view);
    assert.match(message, /As contas não foram lançadas automaticamente: seu perfil não lança contas/);
  } finally { view.unmount(); }
});

test('Lista de preço is saved with the pedido and gives the Preço lista of the item', async () => {
  const wholesale = 'e3000000-0000-4000-8000-000000000196';
  const header = { id: wholesale, name: 'Atacado', category: 'other', list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, version: 1, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', rule: 'Customizada', products: 1 };
  const s = service();
  s.controller.catalog = async path => {
    if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' };
    if (path === '/v1/cadastros/listas-precos') return { items: [header], data_mode: 'erp_native' };
    if (path.startsWith('/v1/cadastros/listas-precos/aplicaveis')) return { contact_id: contact, seller_id: null, payment_method_id: null, state: 'SP', items: [header], data_mode: 'erp_native' };
    if (path === `/v1/cadastros/listas-precos/${wholesale}/precos?produtos=${product}`) return { list: { id: wholesale, name: 'Atacado', list_type: 'custom', rule: 'Customizada', valid_now: true, version: 1 }, items: [{ product_id: product, in_list: true, list_price: '8.50' }], data_mode: 'erp_native' };
    return { items: [], has_more: false };
  };
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentPriceList'] });
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await settle(view);
    await view.change('doc-price-list', wholesale);
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '10', kind: 'P' }); await settle(view);
    assert.equal(view.input('doc-item-price-0').props.value, '8,5');
    assert.match(view.text(), /Preço listaPreço un/, 'the Preço lista column of the pedido de venda');
    await view.submit(); await settle(view);
    assert.equal(s.posts[0].data.price_list_id, wholesale);
    assert.deepEqual([s.posts[0].data.items[0].list_price, s.posts[0].data.items[0].unit_price], ['8.5', '8.5']);
  } finally { view.unmount(); }
});

test('Total do IPI e ICMS ST estimated with the preference on are added to the total that is saved', async () => {
  const s = service();
  s.controller.fiscalInvoices = async () => ({ enabled: true, available: true, reason: null, nature: { id: cash, description: 'Venda' }, items: [{ product_id: product, ipi: '1.00', st: '0.50' }], totals: { ipi: '1.00', st: '0.50', total: '11.50' }, data_mode: 'erp_native' });
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['FiscalOrderTaxEstimate'] });
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '10', kind: 'P' }); await view.flush();
    await new Promise(resolve => setTimeout(resolve, 700)); await settle(view);
    assert.match(view.text(), /Total da vendaR\$ 11,50/);
    assert.match(view.text(), /O total do pedido soma o IPI e o ICMS ST estimados\./);
    await view.submit(); await settle(view);
    assert.deepEqual([s.posts[0].data.tax_ipi, s.posts[0].data.tax_icms_st], ['1.00', '0.50']);
  } finally { view.unmount(); }
});

test('Lançamento automático de contas a receber: the administrador switches it on in Preferências › Vendas', async () => {
  const restore = withDocument();
  const fields = (await import('../../../packages/erp-domain/src/preferences/catalog.mjs')).storedPreferencePage('vendas-vendas');
  const { storedFields } = await import('../../../packages/erp-domain/src/preferences/core.mjs');
  const stored = storedFields(fields);
  const page = (role, value = false, version = 0) => ({ scope: 'preferences_page', data_mode: 'erp_native', page: 'vendas-vendas', owner: 'company', role, can_manage: role === 'admin', directory: role === 'admin' ? [] : null,
    items: stored.map(field => field.key === 'vendas.contas_automaticas_pedido' ? { key: field.key, value, version, updated_at: version ? '2026-10-20T12:00:00Z' : null } : { key: field.key, value: structuredClone(field.default), version: 0, updated_at: null }) });
  const posts = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { role: 'admin', user_id: actor } }), async preferences(path, options = {}) {
    if (options.method === 'POST') { posts.push(structuredClone(options.body)); return { scope: 'preferences_command', data_mode: 'erp_native', replayed: false, page: page('admin', true, 1),
      receipt: { command_id: options.body.command_id, page: 'vendas-vendas', changed_at: '2026-10-20T12:00:00Z', changes: [{ key: 'vendas.contas_automaticas_pedido', from_version: 0, to_version: 1, before: false, after: true }] } }; }
    return page('admin');
  } };
  let closed = null;
  const view = await mountComponent('DocumentAutoFinance.tsx', { controller, onClose: changed => { closed = changed; } }, { expandChildren: ['Modal'] });
  try {
    await settle(view);
    assert.match(view.text(), /Lançamento automático de contas a receber/);
    assert.equal(view.input('doc-auto-finance-invoices').disabled, true, 'the notas fiscais of the FAGOO do not post contas');
    await view.change('doc-auto-finance-orders', true); await view.click('Salvar'); await settle(view);
    assert.deepEqual(posts[0].changes, [{ key: 'vendas.contas_automaticas_pedido', expected_version: 0, value: true }]);
    assert.match(view.text(), /Preferência salva\./);
    await view.click('Fechar'); assert.equal(closed, true);
  } finally { view.unmount(); restore(); }
});

test('a proposta above the limite de crédito explains the refusal', async () => {
  const s = service({ kind: 'sales_proposals' });
  const original = s.controller.documents;
  s.controller.documents = async (path, options = {}) => { if (options.method === 'POST') { const refusal = new AccessError(400); refusal.code = 'ERP_DOCUMENT_CREDIT_LIMIT'; throw refusal; } return original(path, options); };
  const view = await mount(s, 'sales_proposals');
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '10', kind: 'P' }); await view.flush();
    await view.submit(); await settle(view);
    assert.match(view.text(), /excede o limite de crédito do cliente/);
    assert.doesNotMatch(view.text(), /Conferir resultado/, 'a definitive refusal');
  } finally { view.unmount(); }
});

test('202610200267: the new pedido de compra tells whether the contas a pagar were posted automatically', async () => {
  let message = null;
  const s = service({ kind: 'purchase_orders', onPost: () => ({ auto_finance: { outcome: 'done', posting_id: 'b1000000-0000-4000-8000-000000000267' } }) });
  const view = await mount(s, 'purchase_orders', { onSaved: (_record, text) => { message = text; } });
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Fornecedor', state: 'SP' }); await view.flush();
    picker(view, 'products').props.onSelect({ id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '10', kind: 'P' }); await settle(view);
    await view.submit(); await settle(view);
    assert.equal(s.posts.length, 1);
    assert.match(message, /Contas a pagar lançadas automaticamente \(Preferências › Suprimentos › Automação lançamento de contas pagar ao criar novo pedido de compra\)\./);
  } finally { view.unmount(); }
});
