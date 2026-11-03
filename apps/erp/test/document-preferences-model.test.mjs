import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_PREFERENCE_PAGES, defaultDocumentPreferences, documentPreferences, readDocumentPreferences } from '../src/lib/document-preferences.ts';
import { grossWeightSum, formatWeight } from '../src/lib/document-weight.ts';
import { conditionInstallments } from '../src/lib/document-payment-condition.ts';
import { missingRequired } from '../src/lib/document-required.ts';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { defaultListFilters, documentRowActions, PURCHASE_STATUS_OPTIONS, SEARCH_HINTS } from '../src/lib/document-list-model.ts';
import { FREIGHT_MODES } from '../src/lib/document-commercial-model.ts';
import { freshDocument } from '../src/lib/real-documents-model.ts';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { normalizeDocument, INITIAL_STATE } from '../../../packages/erp-domain/src/index.mjs';

// 202610200129 Preferências of the document screens (synthetic values; no network).
const me = 'a0000000-0000-4000-8000-000000000129', other = 'a0000000-0000-4000-8000-000000000130';
const view = (kind, values = {}) => {
  const page = preferencePage(DOCUMENT_PREFERENCE_PAGES[kind]);
  return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role: 'admin', can_manage: true, directory: storedFields(page).some(f => f.kind === 'users') ? [] : null,
    items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: '2026-10-20T12:00:00Z' } : { key: field.key, value: field.default, version: 0, updated_at: null }) };
};

test('defaults are the FAGOO behaviour before the pages were read; each kind reads its own page', () => {
  assert.deepEqual(DOCUMENT_PREFERENCE_PAGES, { sales_orders: 'vendas-vendas', sales_proposals: 'vendas-propostas', service_orders: 'servicos-os', purchase_orders: 'suprimentos-compras' });
  for (const kind of Object.keys(DOCUMENT_PREFERENCE_PAGES)) {
    const p = defaultDocumentPreferences(kind);
    assert.deepEqual([p.loaded, p.observation, p.numberEditable, p.installmentBase, p.sumGrossWeight, p.totalsVisible, p.freeItems, p.repeatedItems, p.nextContactRequired, p.showDetails, p.showAdditional, p.showCarrier, p.freightFirstInstallment],
      [false, '', false, 'date', false, true, true, true, false, 'sim', 'sim', 'sim', false], kind);
  }
});

test('values of the pages become typed rules, including the users who see the totals of the pedidos', () => {
  const sales = documentPreferences('sales_orders', view('sales_orders', { 'vendas.observacao_padrao': 'Entrega em horário comercial', 'vendas.editar_numero': true, 'vendas.data_parcelas': 'data_saida', 'vendas.exibir_detalhes': 'opcional',
    'vendas.exibir_dados_adicionais': 'nao', 'vendas.exibir_transportadora': 'opcional', 'vendas.produtos_nao_cadastrados': false, 'vendas.somar_peso_bruto': true, 'vendas.frete_primeira_parcela': true,
    'vendas.exibir_totais_usuarios': [other], 'vendas.imprimir_ordem': 'localizacao', 'vendas.imprimir_ncm': true, 'vendas.imprimir_numero_item': true }), me);
  assert.deepEqual([sales.loaded, sales.observation, sales.numberEditable, sales.installmentBase, sales.showDetails, sales.showAdditional, sales.showCarrier, sales.freeItems, sales.sumGrossWeight, sales.freightFirstInstallment, sales.totalsVisible],
    [true, 'Entrega em horário comercial', true, 'ship_date', 'opcional', 'nao', 'opcional', false, true, true, false]);
  assert.equal(documentPreferences('sales_orders', view('sales_orders', { 'vendas.exibir_totais_usuarios': [me] }), me).totalsVisible, true);
  assert.equal(documentPreferences('sales_orders', view('sales_orders', { 'vendas.exibir_totais': false }), me).totalsVisible, false);
  assert.deepEqual([sales.print.order, sales.print.ncm, sales.print.itemNumber, sales.print.detailedDescription], ['location', true, true, true]);
  const proposal = documentPreferences('sales_proposals', view('sales_proposals', { 'propostas.proximo_contato_obrigatorio': true, 'propostas.exibir_transportadora': 'nao', 'propostas.exibir_totais': false, 'propostas.imprimir_valores': false }), me);
  assert.deepEqual([proposal.nextContactRequired, proposal.showCarrier, proposal.totalsVisible, proposal.print.values, proposal.installmentBase], [true, 'nao', false, false, 'date']);
  const os = documentPreferences('service_orders', view('service_orders', { 'os.itens_repetidos': false, 'os.rotulo_equipamento': 'Aparelho', 'os.rotulo_cliente': '  ', 'os.data_parcelas': 'data_prevista', 'os.ocultar_valores': true, 'os.rotulo_assinatura': 'Visto do técnico', 'os.exibir_assinatura': true }), me);
  assert.deepEqual([os.repeatedItems, os.labels, os.installmentBase, os.print.hideValues, os.print.signature, os.print.signatureLabel], [false, { equipamento: 'Aparelho' }, 'expected_date', true, true, 'Visto do técnico']);
  const purchase = documentPreferences('purchase_orders', view('purchase_orders', { 'compras.data_parcelas': 'data_prevista', 'compras.rotulo_titulo': 'Ordem de compra', 'compras.codigo_secundario': 'gtin', 'compras.imprimir_vencimento_parcelas': true }), me);
  assert.deepEqual([purchase.installmentBase, purchase.print.title, purchase.print.secondaryCode, purchase.print.dueDates, purchase.totalsVisible], ['expected_date', 'Ordem de compra', 'gtin', true, true]);
});

test('reading a page goes through the strict page parser; no preferences port keeps the defaults', async () => {
  const signal = new AbortController().signal;
  assert.equal((await readDocumentPreferences({ getSnapshot: () => ({ membership: { user_id: me } }) }, 'sales_orders', signal)).loaded, false);
  const calls = [];
  const read = await readDocumentPreferences({ getSnapshot: () => ({ membership: { user_id: me } }), preferences: async path => { calls.push(path); return view('service_orders', { 'os.observacao_padrao': 'Testar antes de entregar' }); } }, 'service_orders', signal);
  assert.deepEqual([calls, read.observation, read.loaded], [['/v1/preferencias/servicos-os'], 'Testar antes de entregar', true]);
  await assert.rejects(() => readDocumentPreferences({ preferences: async () => ({ ...view('service_orders'), page: 'vendas-vendas' }) }, 'service_orders', signal));
});

test('Somar peso bruto: exact sum of the linked products × quantity, empty without any weight, null while a quantity is being typed', () => {
  const weights = new Map([['a', '1.250000'], ['b', '0.333333'], ['c', null]]);
  const of = item => weights.get(item.id);
  assert.equal(grossWeightSum([{ id: 'a', product_id: 'p', quantity: '2' }, { id: 'b', product_id: 'q', quantity: '3' }, { id: 'c', product_id: 'r', quantity: '9' }, { id: 'x', product_id: null, quantity: '5' }], of), '3.499999');
  assert.equal(grossWeightSum([{ id: 'b', product_id: 'q', quantity: '0.5' }], of), '0.166667', 'half up at 6 decimals');
  assert.equal(grossWeightSum([{ id: 'c', product_id: 'r', quantity: '1' }], of), null);
  assert.equal(grossWeightSum([{ id: 'a', product_id: 'p', quantity: '1,' }], of), null);
  assert.equal(formatWeight(2_500_000n), '2.5');
});

test('Gerar parcelas: base date of the Preferências with its Origin message, and the freight whole in the first installment', () => {
  const input = { ...normalizeDocument('sales_orders', { date: '2026-10-20', contact_id: me, items: [{ description: 'Item', unit: 'UN', quantity: '1', unit_price: '100' }], freight: '10.01' }) };
  const plan = conditionInstallments(input, '30 60', '2026-10-25', { freightFirst: true });
  assert.deepEqual(plan.map(row => [row.due_date, row.amount]), [['2026-11-24', '60.01'], ['2026-12-24', '50.00']]);
  assert.deepEqual(conditionInstallments(input, '2x', '2026-10-20').map(row => row.amount), ['55.01', '55.00']);
  assert.throws(() => conditionInstallments(input, '30', '', { baseLabel: 'Data saída' }), /Preencha o campo Data saída antes de gerar as parcelas\./);
});

test('required próximo contato (not for models), Origin freight labels and the observation of a new document', () => {
  const base = { date: '2026-10-20', contact_id: me, items: [{ description: 'x', unit: 'UN', quantity: '1', unit_price: '1' }] };
  assert.deepEqual(missingRequired('sales_proposals', base, { nextContact: true }).map(f => f.label), ['Próximo contato']);
  assert.deepEqual(missingRequired('sales_proposals', { ...base, template: true }, { nextContact: true }), []);
  assert.deepEqual(missingRequired('sales_proposals', base), []);
  assert.deepEqual(missingRequired('service_orders', { ...base, contact_id: '' }, { contactLabel: 'Proprietário' }).map(f => f.label), ['Proprietário']);
  assert.equal(FREIGHT_MODES['0'], '0 - Contratação do Frete por conta do Remetente (CIF)'); assert.equal(FREIGHT_MODES['9'], '9 - Sem Ocorrência de Transporte');
  assert.equal(freshDocument('purchase_orders', '2026-10-20', 'Conferir NF').notes, 'Conferir NF');
  assert.equal(Object.hasOwn(freshDocument('purchase_orders', '2026-10-20'), 'notes'), false);
  assert.equal(INITIAL_STATE.sales_orders, 'open');
});

test('print follows Configuração de Impressão: columns, title, NCM, location order, technician print and signature', () => {
  const doc = (kind, extra = {}) => { const normalized = normalizeDocument(kind, { date: '2026-10-20', contact_id: me, items: [{ id: 'e0000000-0000-4000-8000-000000000001', description: 'Bucha', unit: 'UN', quantity: '2', unit_price: '5', detailed_description: 'Nylon' }, { id: 'e0000000-0000-4000-8000-000000000002', description: 'Arruela', unit: 'UN', quantity: '1.5', unit_price: '2' }], installments: [], ...extra });
    return { ...normalized, id: 'b0000000-0000-4000-8000-000000000129', kind, number: '42', version: 1, status: INITIAL_STATE[kind], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null, effect_flags: { finance_active: false, stock_active: false },
      contact_snapshot: { id: me, name: 'Cliente sintético', code: 'C-9' }, items: normalized.items.map((item, i) => ({ ...item, product_snapshot: { name: item.description, ncm: i ? '73182200' : '39269090', location: i ? 'A-01' : 'B-02', gtin: '7890000000017', gtin_tax: null } })) };
  };
  const plain = documentPrintModel(doc('sales_orders'));
  assert.deepEqual([plain.columns.position, plain.columns.values, plain.showTotals, plain.title, plain.items[0].detailedDescription], [true, true, true, 'Pedido de venda', 'Nylon'], 'without preferences: the FAGOO layout');
  const sales = documentPrintModel(doc('sales_orders'), null, { prefs: { ...defaultDocumentPreferences('sales_orders').print, ncm: true, location: true, order: 'location', quantitySum: true, contactCode: true, detailedDescription: false } });
  assert.deepEqual(sales.items.map(item => [item.description, item.ncm, item.location]), [['Arruela', '73182200', 'A-01'], ['Bucha', '39269090', 'B-02']]);
  assert.deepEqual([sales.columns.position, sales.quantitySum, sales.contactCode, sales.items[1].detailedDescription], [false, '3.5', 'C-9', null]);
  const proposal = documentPrintModel(doc('sales_proposals'), null, { prefs: { ...defaultDocumentPreferences('sales_proposals').print, values: false, totals: false } });
  assert.deepEqual([proposal.columns.values, proposal.showTotals, proposal.columns.quantity], [false, false, true]);
  const osPrefs = { ...defaultDocumentPreferences('service_orders').print, hideValues: true, hideContact: true, signature: true, signatureLabel: 'Visto do técnico' };
  const normal = documentPrintModel(doc('service_orders'), null, { prefs: osPrefs, labels: { equipamento: 'Aparelho' } });
  assert.deepEqual([normal.columns.values, normal.showContact, normal.signature, normal.serviceLabels.equipment, normal.technician], [true, true, 'Visto do técnico', 'Aparelho', false], 'the normal OS print keeps values and client');
  const technician = documentPrintModel(doc('service_orders'), null, { prefs: osPrefs, technician: true });
  assert.deepEqual([technician.columns.values, technician.showTotals, technician.showContact, technician.title], [false, false, false, 'Ordem de serviço para técnico']);
  const purchase = documentPrintModel(doc('purchase_orders'), null, { prefs: { ...defaultDocumentPreferences('purchase_orders').print, title: 'Ordem de compra', secondaryCode: 'gtin' } });
  assert.deepEqual([purchase.title, purchase.items[0].secondaryCode, purchase.showDueDates], ['Ordem de compra', '7890000000017', false]);
});

test('pedidos de compra list: Origin defaults, single situação, search hint and the ⋮ order without Editar', () => {
  assert.deepEqual(defaultListFilters('purchase_orders', '2026-10-20'), { ...defaultListFilters('sales_orders', '2026-10-20'), statuses: ['open'], from: '2026-09-21', to: '2026-10-20' });
  assert.deepEqual(defaultListFilters('sales_orders', '2026-10-20').statuses, []);
  assert.deepEqual([...PURCHASE_STATUS_OPTIONS], ['open', 'fulfilled', 'cancelled', 'in_progress', 'partially_fulfilled']);
  assert.equal(SEARCH_HINTS.purchase_orders, 'Pesquisa por nome, número do pedido ou ordem de compra');
  const row = { id: 'b0000000-0000-4000-8000-000000000129', kind: 'purchase_orders', number: '1', version: 1, status: 'open', date: '2026-10-20', total: '1.00', contact_id: me, contact_name: 'Fornecedor', created_at: '', updated_at: '', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: null, fiscal_draft: null, internal_notes: null };
  const actions = documentRowActions('purchase_orders', row, { role: 'estoque', writable: true });
  assert.deepEqual(actions.map(action => action.label), ['Lançar estoque', 'Lançar contas', 'Gerar nota fiscal', 'Imprimir', 'Imprimir etiquetas', 'Enviar por e-mail', 'Enviar por whatsapp', 'Clonar compra', 'Em andamento', 'Atendido', 'Cancelado']);
  // 202610200240: the product labels of the saved pedido (Cadastros › Produtos).
  assert.equal(actions.find(action => action.label === 'Imprimir etiquetas').enabled, true);
  assert.equal(actions.find(action => action.label === 'Imprimir etiquetas').action, 'print_product_labels');
});

test('the print of the pedido de compra shows the Ordem de compra', () => {
  const normalized = normalizeDocument('purchase_orders', { date: '2026-10-20', contact_id: me, items: [{ description: 'Bucha', unit: 'UN', quantity: '1', unit_price: '1' }], order_reference: 'OC-77' });
  const record = { ...normalized, id: 'b0000000-0000-4000-8000-000000000136', kind: 'purchase_orders', number: '9', version: 1, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null, effect_flags: { finance_active: false, stock_active: false }, contact_snapshot: { id: me, name: 'Fornecedor' }, items: normalized.items.map((item, i) => ({ ...item, id: `e0000000-0000-4000-8000-00000000000${i + 1}`, product_snapshot: null })) };
  assert.deepEqual(documentPrintModel(record).details, [{ label: 'Ordem de compra', value: 'OC-77' }]);
});

test('the comprovante não fiscal and the detailed code follow Preferências › Vendas', () => {
  const sales = documentPreferences('sales_orders', view('sales_orders', { 'vendas.imprimir_codigo': 'gtin', 'vendas.comprovante_limitar_descricao': true, 'vendas.comprovante_rodape': 'Obrigado pela preferência', 'vendas.comprovante_fonte': 9 }), me);
  assert.deepEqual([sales.print.detailedCode, sales.print.receipt.limitDescription, sales.print.receipt.code, sales.print.receipt.footer, sales.print.receipt.fontSize], ['gtin', true, false, 'Obrigado pela preferência', 9]);
  const normalized = normalizeDocument('sales_orders', { date: '2026-10-20', contact_id: me, items: [{ description: 'Bucha de nylon com rosca interna', code: 'B1', unit: 'UN', quantity: '1', unit_price: '1' }] });
  const record = { ...normalized, id: 'b0000000-0000-4000-8000-000000000137', kind: 'sales_orders', number: '9', version: 1, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null, effect_flags: { finance_active: false, stock_active: false }, contact_snapshot: { id: me, name: 'Cliente' }, items: normalized.items.map(item => ({ ...item, id: 'e0000000-0000-4000-8000-000000000001', product_snapshot: { name: 'Bucha', gtin: '7890000000017' } })) };
  const model = documentPrintModel(record, null, { detailed: true, prefs: sales.print });
  assert.deepEqual([model.items[0].detailedCode, model.receipt.footer, model.receipt.fontSize], ['7890000000017', 'Obrigado pela preferência', 9]);
  assert.deepEqual(documentPrintModel(record).receipt, { limitDescription: false, code: true, notes: false, comments: false, discount: false, footer: null, fontSize: 12 }, 'without preferences: the FAGOO comprovante');
});

test('a reviewed copy of a pedido de compra may keep the source date (Data do pedido clonado); other kinds may not', async () => {
  const { readCopyPreview, COPY_RESET_FIELDS } = await import('../src/lib/document-copy-model.ts');
  const source = kind => ({ id: 'b0000000-0000-4000-8000-000000000138', kind, number: '5', version: 2, contact_id: me });
  const preview = (kind, reset) => ({ source: { id: 'b0000000-0000-4000-8000-000000000138', kind, number: '5', version: 2 }, data: { date: '2026-09-15', contact_id: me, warehouse_id: null, expected_date: null, valid_until: null, next_contact: null, template: false, items: [{ id: null, product_id: null, description: 'Item', code: null, unit: 'UN', quantity: '1', unit_price: '1', discount_percent: '0' }], installments: [], equipment: null, serial_number: null, technician: null, defect: null, solution: null }, reset_fields: reset, persisted: false, data_mode: 'erp_native', operational_effects: false });
  const kept = COPY_RESET_FIELDS.filter(key => key !== 'date');
  assert.equal(readCopyPreview(preview('purchase_orders', kept), source('purchase_orders')).data.date, '2026-09-15');
  assert.throws(() => readCopyPreview(preview('sales_orders', kept), source('sales_orders')), /validar a cópia/);
  assert.equal(readCopyPreview(preview('sales_orders', [...COPY_RESET_FIELDS]), source('sales_orders')).reset_fields[0], 'date');
});
