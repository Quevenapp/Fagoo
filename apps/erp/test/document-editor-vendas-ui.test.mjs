import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// The real Editor of RealDocuments.tsx with a synthetic controller (no DOM, no network).
const actor = 'a0000000-0000-4000-8000-000000000102', docId = 'b0000000-0000-4000-8000-000000000102', contact = 'c0000000-0000-4000-8000-000000000102', proposal = 'b0000000-0000-4000-8000-000000000103';
const product = 'd0000000-0000-4000-8000-000000000102';
const node = (view, name, predicate = () => true) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name && predicate(n));
const picker = (view, entity) => node(view, 'CatalogPicker', n => n.props.entity === entity);
const productRow = (extra = {}) => ({ id: product, entity: 'products', version: 1, active: true, name: 'Produto sintético', code: 'PS-1', gtin: null, unit: 'UN', kind: 'S', price: '10.0000', source: null, ...extra });
const body = (kind, extra = {}) => ({ date: '2026-10-16', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item sintético', code: 'L1', unit: 'UN', quantity: '1.5', unit_price: '10', detailed_description: null }, { id: 'e0000000-0000-4000-8000-000000000002', product_id: null, description: 'Outro item', code: null, unit: 'UN', quantity: '2.25', unit_price: '4', discount_percent: '10', detailed_description: null }], ...extra });
function record(kind = 'sales_orders', data = body(kind), extra = {}) {
  const normalized = normalizeDocument(kind, data);
  return { ...normalized, id: docId, kind, number: '102', version: 1, status: kind === 'service_orders' ? 'open' : 'draft', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', source_proposal_id: null, contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map((item, index) => ({ ...item, id: item.id ?? `e0000000-0000-4000-8000-00000000000${index + 1}`, product_snapshot: null })), ...extra };
}
function setup({ kind = 'sales_orders', contactRead = () => ({ entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }), proposalRead, nextNumber, savedNumber = '102' } = {}) {
  const calls = []; let saved = null;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/contacts/')) return contactRead(path);
      return { entity: 'products', items: [], has_more: false };
    },
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body === undefined ? undefined : structuredClone(options.body) });
      if (path.startsWith('/v1/documentos/sales_proposals/') && proposalRead) return proposalRead(path);
      if (path.endsWith('/proximo-numero')) { if (!nextNumber) throw new AccessError(404); return { kind, next_number: nextNumber, reserved: false, data_mode: 'erp_native', operational_effects: false }; }
      if (options.method) saved = options.body.data;
      return { kind, document: record(kind, saved ?? body(kind), { version: 2, number: savedNumber }), data_mode: 'erp_native', operational_effects: false };
    },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { controller, calls, posts: () => calls.filter(call => call.method === 'POST' || call.method === 'PATCH') };
}
// A saved pedido stays read-only until the reservation child reports that no reservation is active.
async function mount(s, kind, current, extra = {}) {
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind, record: current, writable: true, onSaved() {}, onClose() {}, onConverted() {}, ...extra }, { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentContactCheck', 'DocumentProposalNumber', 'DocumentDeliveryAddress'] });
  const reservations = node(view, 'SalesOrderReservations');
  if (reservations) { reservations.props.onActive(false); await view.flush(); }
  return view;
}

test('header carries Origin Cancelar | Salvar and “(*) Campos obrigatórios”; Salvar submits the editor form', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', record());
  try {
    const save = view.find(n => n.type === 'button' && n.props.form === 'document-editor-form');
    assert.equal(save.props.type, 'submit'); assert.equal(save.props.children, 'Salvar');
    assert.equal(view.find(n => n.type === 'form').props.id, 'document-editor-form'); assert.equal(view.find(n => n.type === 'form').props.noValidate, true);
    assert.match(view.text(), /\(\*\) Campos obrigatórios/);
    assert.equal(view.button('Cancelar').disabled, false);
    assert.equal(view.nodes().some(n => n.type === 'button' && ['Voltar', 'Voltar à listagem', 'Salvar novo documento'].includes(n.props.children)), false, 'no second save bar at the bottom');
  } finally { view.unmount(); }
});

test('missing fields show “O campo … é obrigatório”, are highlighted and clear when filled; nothing is sent', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', null);
  try {
    await view.submit();
    assert.match(view.text(), /O campo Cliente é obrigatório\. O campo Descrição é obrigatório\./);
    assert.equal(s.posts().length, 0);
    assert.equal(picker(view, 'contacts').props.invalid, true);
    assert.equal(view.input('doc-item-description-0').props['aria-invalid'], true);
    await view.change('doc-item-description-0', 'Peça digitada');
    assert.equal(view.input('doc-item-description-0').props['aria-invalid'], undefined);
    assert.equal(picker(view, 'contacts').props.invalid, true, 'the missing client stays highlighted');
  } finally { view.unmount(); }
});

test('items show #, a read-only code for cadastro items, Item repetido and the price below the list price', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', record());
  try {
    assert.deepEqual(view.nodes().filter(n => n.type === 'td' && n.props.className === 'document-item-position').map(n => n.props.children), [1, 2]);
    assert.equal(view.find(n => n.type === 'input' && n.props['aria-label'] === 'Código do item 1').props.readOnly, false);
    picker(view, 'products').props.onSelect(productRow()); await view.flush();
    assert.equal(view.find(n => n.type === 'input' && n.props['aria-label'] === 'Código do item 3').props.readOnly, true);
    assert.doesNotMatch(view.text(), /Item repetido/);
    const message = picker(view, 'products').props.onSelect(productRow()); await view.flush();
    assert.match(message, /^Item repetido: Produto sintético já estava no documento/); assert.match(view.text(), /Item repetido/);
    const price = () => view.input('doc-item-price-2');
    assert.equal(price().props.className, undefined);
    await view.change('doc-item-price-2', '9,99');
    assert.equal(price().props.className, 'document-price-below'); assert.equal(price().props.title, 'O preço unitário deste item está abaixo do preço de lista!');
    const toggle = view.find(n => n.type === 'button' && n.props['aria-controls'] === 'doc-item-detail-0');
    assert.equal(toggle.props['aria-expanded'], false); toggle.props.onClick(); await view.flush();
    assert.equal(view.find(n => n.type === 'button' && n.props['aria-controls'] === 'doc-item-detail-0').props['aria-expanded'], true);
  } finally { view.unmount(); }
});

test('Totais: Nº de itens, exact Soma das quantidades, single Desconto with %, Prazo de entrega and the four Origin totals', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', record());
  try {
    assert.equal(view.input('doc-item-count').props.value, '2'); assert.equal(view.input('doc-qty-sum').props.value, '3,75');
    assert.match(view.text(), /Desconto total da venda.*Desconto total dos itens.*Total dos itens.*Total da venda/s);
    await view.change('doc-discount_value', '10%'); await view.change('doc-delivery-days', '7');
    assert.equal(view.input('doc-discount_value').props.value, '10%');
    await view.submit();
    const sent = s.posts().at(-1).body.data;
    assert.deepEqual([sent.discount_mode, sent.discount_value, sent.commercial.transport.delivery_days], ['percent', '10', '7']);
  } finally { view.unmount(); }
});

test('Condição de pagamento + Gerar parcelas fills the planned installments; Dias moves the due date', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', record());
  try {
    await view.change('doc-condition', 'dez dias'); await view.click('Gerar parcelas');
    assert.match(view.text(), /Informe a condição como no Origin/);
    await view.change('doc-condition', '30 60'); await view.click('Gerar parcelas');
    assert.deepEqual([0, 1].map(index => [view.input(`doc-installment-days-${index}`).props.value, view.input(`doc-installment-date-${index}`).props.value, view.input(`doc-installment-amount-${index}`).props.value]), [['30', '2026-11-15', '11,55'], ['60', '2026-12-15', '11,55']]);
    await view.change('doc-installment-days-1', '45');
    assert.equal(view.input('doc-installment-date-1').props.value, '2026-11-30');
    await view.submit();
    const sent = s.posts().at(-1).body.data;
    assert.deepEqual(sent.installments.map(row => [row.due_date, row.amount]), [['2026-11-15', '11.55'], ['2026-11-30', '11.55']]);
    assert.equal(sent.payment_terms, '30 60', 'the condition typed is kept as the document condition');
  } finally { view.unmount(); }
});

test('Detalhes da venda shows Cadastrada em (São Paulo) and Nº da Proposta with its link; contact changes are announced', async () => {
  const opened = [];
  const s = setup({ contactRead: () => ({ entity: 'contacts', record: { id: contact, name: 'Cliente renomeado', active: false } }), proposalRead: () => ({ kind: 'sales_proposals', document: { id: proposal, kind: 'sales_proposals', number: '77' } }) });
  const view = await mount(s, 'sales_orders', record('sales_orders', body('sales_orders'), { source_proposal_id: proposal }));
  try {
    assert.match(view.text(), /Detalhes da venda.*Cadastrada em: 16\/10\/2026 09:00:00/s);
    assert.equal(view.input('doc-proposal-number').props.value, '77'); assert.equal(view.input('doc-proposal-number').props.readOnly, true);
    await view.click('Abrir proposta 77');
    assert.equal(view.location().search, `?tipo=sales_proposals&documento=${proposal}`);
    assert.match(view.text(), /O nome desse cliente foi alterado nessa venda: no cadastro ele é “Cliente renomeado”\. O cliente está inativo no cadastro\./);
    assert.equal(opened.length, 0);
  } finally { view.unmount(); }
  const missing = setup({ contactRead: () => { throw new AccessError(404); }, proposalRead: () => { throw new AccessError(403); } });
  const other = await mount(missing, 'sales_orders', record('sales_orders', body('sales_orders'), { source_proposal_id: proposal }));
  try {
    assert.match(other.text(), /Cliente não encontrado no cadastro/);
    assert.equal(other.input('doc-proposal-number').props.value, 'Proposta de origem'); assert.match(other.text(), /não está disponível para o seu perfil/);
  } finally { other.unmount(); }
  const denied = setup({ contactRead: () => { throw new AccessError(403); } }), quiet = await mount(denied, 'sales_orders', record());
  try { assert.doesNotMatch(quiet.text(), /cadastro/i); } finally { quiet.unmount(); }
});

test('a new pedido is saved with CIF freight; proposals compute Validade from days; OS uses Problema and Informações técnico', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', null);
  try {
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente sintético' }); await view.change('doc-item-description-0', 'Peça'); await view.change('doc-item-price-0', '5');
    await view.submit();
    assert.equal(s.posts().at(-1).body.data.commercial.transport.freight_mode, '0');
  } finally { view.unmount(); }
  const p = setup({ kind: 'sales_proposals' }), proposalView = await mount(p, 'sales_proposals', record('sales_proposals'));
  try {
    await proposalView.change('doc-valid-days', '15');
    assert.equal(proposalView.input('doc-valid').props.value, '2026-10-31'); assert.equal(proposalView.input('doc-valid-days').props.value, '15');
    assert.match(proposalView.text(), /Condições gerais.*Prazo de entrega/s); assert.match(proposalView.text(), /Total da proposta/);
  } finally { proposalView.unmount(); }
  const o = setup({ kind: 'service_orders' }), osView = await mount(o, 'service_orders', record('service_orders', { date: '2026-10-16', contact_id: contact, items: [] }));
  try { assert.match(osView.text(), /Problema.*Informações técnico/s); assert.doesNotMatch(osView.text(), /Defeito relatado|Diagnóstico \/ solução/); }
  finally { osView.unmount(); }
});

test('a typed client without cadastro shows “Contato não cadastrado” and opens Contato rápido with the name', async () => {
  const created = [];
  const view = await mountComponent('DocumentCatalogPicker.tsx', { controller: { getSnapshot: () => ({ membership: { user_id: actor } }), async catalog() { return { entity: 'contacts', items: [], has_more: false }; } }, entity: 'contacts', label: 'Cliente *', onSelect() {}, onCreate: query => created.push(query) }, { componentName: 'CatalogPicker' });
  try {
    view.find(n => n.type === 'input' && n.props.type === 'search').props.onChange({ target: { value: '  Cliente sem cadastro ' } });
    await new Promise(resolve => setTimeout(resolve, 300)); await view.flush();
    assert.match(view.text(), /Contato não cadastrado — Para completar os dados clique aqui/);
    await view.click('Para completar os dados clique aqui');
    assert.deepEqual(created, ['Cliente sem cadastro']);
  } finally { view.unmount(); }
});

test('pedido: Data saída starts today, Pedido de compra and Endereço de entrega are saved; a missing city is required', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', null);
  try {
    assert.equal(view.input('doc-ship-date').props.value, view.input('doc-date').props.value, 'Data saída = data da venda (hoje)');
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente sintético' }); await view.change('doc-item-description-0', 'Peça'); await view.change('doc-item-price-0', '5');
    await view.change('doc-customer-po', 'PC-77');
    await view.change('doc-delivery-different', true);
    await view.change('doc-delivery-street', 'Rua da Entrega'); await view.change('doc-delivery-postal', '13400-000');
    await view.submit();
    assert.match(view.text(), /O campo Cidade \(entrega\) é obrigatório/); assert.equal(view.input('doc-delivery-city').props['aria-invalid'], true); assert.equal(s.posts().length, 0);
    await view.change('doc-delivery-city', 'Piracicaba'); await view.change('doc-delivery-state', 'SP');
    await view.submit();
    const sent = s.posts().at(-1).body.data;
    assert.equal(sent.customer_po_number, 'PC-77');
    assert.deepEqual(sent.delivery_address, { name: null, postal_code: '13400-000', state: 'SP', city: 'Piracicaba', district: null, street: 'Rua da Entrega', number: null, complement: null, country: null });
    for (const key of ['finish_date', 'start_time', 'warranty_days', 'template_name', 'reception_notes']) assert.equal(sent[key], null, `${key} is sent as an explicit null`);
  } finally { view.unmount(); }
});

test('OS fields (término, saída, horas, Orçar/Orçado, garantia e recebimento) and the proposal model name and warranty', async () => {
  const s = setup({ kind: 'service_orders' }), view = await mount(s, 'service_orders', record('service_orders', { date: '2026-10-16', contact_id: contact, items: [] }));
  try {
    await view.change('doc-finish-date', '2026-10-20'); await view.change('doc-ship-date', '2026-10-21'); await view.change('doc-start_time', '08:00'); await view.change('doc-end_time', '11:30');
    await view.change('doc-quote_requested', true); await view.change('doc-warranty-days', '90'); await view.change('doc-warranty-info', 'Troca de peça'); await view.change('doc-reception-notes', 'Veio sem cabo');
    await view.submit();
    const sent = s.posts().at(-1).body.data;
    assert.deepEqual([sent.finish_date, sent.ship_date, sent.start_time, sent.end_time, sent.quote_requested, sent.quoted, sent.warranty_days, sent.warranty_info, sent.reception_notes], ['2026-10-20', '2026-10-21', '08:00', '11:30', true, null, '90', 'Troca de peça', 'Veio sem cabo']);
  } finally { view.unmount(); }
  const p = setup({ kind: 'sales_proposals' }), proposalView = await mount(p, 'sales_proposals', record('sales_proposals'));
  try {
    assert.equal(proposalView.nodes().some(n => n.props?.id === 'doc-template-name'), false);
    await proposalView.change('doc-warranty-months', '12');
    proposalView.find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false && !n.props.id).props.onChange({ target: { checked: true } }); await proposalView.flush();
    await proposalView.change('doc-template-name', 'Modelo padrão');
    await proposalView.submit();
    const sent = p.posts().at(-1).body.data;
    assert.deepEqual([sent.template, sent.template_name, sent.warranty_months], [true, 'Modelo padrão', '12']);
  } finally { proposalView.unmount(); }
});

test('a new document shows the next number in the title and warns when the saved number differs', async () => {
  const notices = [];
  const s = setup({ nextNumber: '105', savedNumber: '106' }), view = await mount(s, 'sales_orders', null, { onSaved: (saved, message) => notices.push([saved.number, message]) });
  try {
    assert.equal(view.find(n => n.type === 'h2').props.children, 'Pedido de venda - 105');
    picker(view, 'contacts').props.onSelect({ id: contact, name: 'Cliente sintético' }); await view.change('doc-item-description-0', 'Peça'); await view.change('doc-item-price-0', '5');
    await view.submit();
    assert.deepEqual(notices, [['106', 'O número do seu pedido foi modificado para: 106']]);
  } finally { view.unmount(); }
  const same = setup({ nextNumber: '102' }), sameView = await mount(same, 'sales_orders', null, { onSaved: (saved, message) => notices.push([saved.number, message]) });
  try { picker(sameView, 'contacts').props.onSelect({ id: contact, name: 'Cliente sintético' }); await sameView.change('doc-item-description-0', 'Peça'); await sameView.change('doc-item-price-0', '5'); await sameView.submit(); assert.deepEqual(notices.at(-1), ['102', undefined]); }
  finally { sameView.unmount(); }
});
