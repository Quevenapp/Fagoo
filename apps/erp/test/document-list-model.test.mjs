import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_LIST_FILTERS, documentListQuery, readDocumentListPage, listIndicators, statusTargets, reasonRequired, statusBatchPlan, documentRowActions, nextOrder, orderColumn, pageCount, SEARCH_HINTS, DATE_TYPES, validReason, effectsActive,
} from '../src/lib/document-list-model.ts';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over = {}) => ({ id: id(1), kind: 'sales_orders', number: '7', version: 3, status: 'open', date: '2026-10-16', total: '10.00', contact_id: id(9), contact_name: 'Cliente sintético', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, ...over });
const query = (kind, patch = {}, options) => Object.fromEntries(documentListQuery(kind, { ...EMPTY_LIST_FILTERS, ...patch }, options));

test('list query always asks for a numbered page of 100 and serializes only the filters in use', () => {
  assert.deepEqual(query('sales_orders'), { limit: '100', page: '1' });
  assert.deepEqual(query('sales_orders', { query: '  12.345.678/0001-90 ', statuses: ['open', 'verified'], from: '2026-10-01', to: '2026-10-31', dateType: 'expected_date', warehouse: { id: id(2), name: 'Depósito' }, product: { id: id(3), name: 'Peça' }, city: ' Piracicaba ', state: 'SP' }, { page: 3, order: 'number_asc' }),
    { limit: '100', page: '3', order: 'number_asc', status: 'open,verified', q: '12.345.678/0001-90', date_type: 'expected_date', date_from: '2026-10-01', date_to: '2026-10-31', warehouse_id: id(2), product_id: id(3), city: 'Piracicaba', state: 'SP' });
  assert.equal(query('sales_orders', { dateType: 'expected_date' }).date_type, undefined, 'a date type without period does not filter');
  assert.deepEqual(query('service_orders', { technician: 'Técnico', equipment: 'Bomba', serialNumber: 'SN-1' }), { limit: '100', page: '1', technician: 'Técnico', equipment: 'Bomba', serial_number: 'SN-1' });
  assert.deepEqual(query('purchase_orders', { internalNote: 'lote' }), { limit: '100', page: '1', internal_note: 'lote' });
  assert.deepEqual(query('sales_proposals', { dateType: 'next_contact', from: '2026-10-20' }), { limit: '100', page: '1', date_type: 'next_contact', date_from: '2026-10-20' });
});

test('list query rejects invalid filters, foreign filters for the screen and invalid pages before any request', () => {
  for (const [kind, patch, options] of [
    ['sales_orders', { query: 'x'.repeat(121) }], ['sales_orders', { query: 'a\nb' }], ['sales_orders', { from: '2026-02-30' }], ['sales_orders', { from: '2026-10-02', to: '2026-10-01' }],
    ['sales_orders', { statuses: ['approved'] }], ['sales_orders', { statuses: ['open', 'open'] }], ['sales_orders', { dateType: 'next_contact' }], ['purchase_orders', { city: 'Piracicaba' }],
    ['sales_orders', { technician: 'x' }], ['service_orders', { internalNote: 'x' }], ['sales_proposals', { state: 'SP' }], ['sales_orders', { state: 'XX' }], ['sales_orders', { city: '   ' }],
    ['sales_orders', { warehouse: { id: 'nope', name: 'x' } }], ['sales_orders', {}, { page: 0 }], ['sales_orders', {}, { page: 1.5 }], ['sales_orders', {}, { order: 'id' }], ['sales_orders', {}, { limit: 101 }],
  ]) assert.throws(() => documentListQuery(kind, { ...EMPTY_LIST_FILTERS, ...patch }, options), Error, JSON.stringify([kind, patch, options]));
});

test('page reader accepts only the requested page/order of this kind with exact totals', () => {
  const page = { kind: 'sales_orders', items: [row()], limit: 100, page: 2, order: 'date_desc', has_more: false, next_cursor: null, total_count: 101, total_amount: '1234.56', data_mode: 'erp_native', operational_effects: false };
  assert.equal(readDocumentListPage(page, 'sales_orders', 2, 'date_desc'), page);
  for (const bad of [{ page: 1 }, { order: 'date_asc' }, { kind: 'purchase_orders' }, { total_count: -1 }, { total_count: '101' }, { total_amount: '1234.5' }, { total_amount: 1234.56 }, { items: [row({ kind: 'purchase_orders' })] }, { items: [row({ id: 'x' })] }])
    assert.throws(() => readDocumentListPage({ ...page, ...bad }, 'sales_orders', 2, 'date_desc'), /DOCUMENT_LIST_INVALID/, JSON.stringify(bad));
});

test('row indicators follow Origin letters and only reflect projected effects', () => {
  assert.deepEqual(listIndicators(row()), []);
  const all = listIndicators(row({ source_proposal_id: id(4), source_proposal_number: '15', finance_active: true, stock_active: true, warehouse_name: 'Depósito Norte', fiscal_draft: true, internal_notes: 'Ligar antes' }));
  assert.deepEqual(all.map(item => [item.key, item.letter?.text ?? item.icon, item.title]), [['P', 'P', 'Proposta comercial 15'], ['C', 'C', 'Contas lançadas'], ['E', 'E', 'Estoque lançado - Depósito: Depósito Norte'], ['N', 'N', 'Nota fiscal vinculada (rascunho no emissor)'], ['OBS', 'comment', 'Ligar antes']]);
  assert.equal(listIndicators(row({ kind: 'purchase_orders', receipt_active: true }))[0].title, 'Estoque lançado');
  assert.deepEqual(listIndicators(row({ fiscal_draft: false })), []);
});

test('situação targets are the server transitions; active effects keep only the forward moves the SQL guards accept', () => {
  // 202610200103: Origin "todas para todas"; Atendido parcialmente keeps 008.
  // 202610200245: Venda Agenciada joins the Origin "todas para todas" group.
  assert.deepEqual(statusTargets('sales_orders', row()), ['draft', 'verified', 'in_progress', 'agency_sale', 'fulfilled', 'cancelled']);
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'in_progress' })), ['draft', 'open', 'verified', 'agency_sale', 'partially_fulfilled', 'fulfilled', 'cancelled']);
  // Faturado parcialmente comes from Atendido parcialmente and goes back to it (or to Cancelado), also with active effects.
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'partially_fulfilled' })), ['in_progress', 'partially_invoiced', 'fulfilled', 'cancelled']);
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'partially_invoiced', stock_active: true })), ['partially_fulfilled']);
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'partially_fulfilled', finance_active: true })), ['partially_invoiced', 'fulfilled']);
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'in_progress', stock_active: true })), ['partially_fulfilled', 'fulfilled']);
  // 202610200279 (estoque): Em aberto goes forward with stock or a reserva (not with contas).
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'open', reservation_active: true })), ['verified', 'in_progress', 'fulfilled']);
  assert.deepEqual(statusTargets('sales_orders', row({ status: 'open', finance_active: true })), []);
  assert.deepEqual(statusTargets('sales_proposals', row({ kind: 'sales_proposals', status: 'open', template: true })), ['draft', 'pending', 'waiting', 'rejected', 'cancelled']);
  assert.deepEqual(statusTargets('sales_proposals', row({ kind: 'sales_proposals', status: 'completed' })), [], 'Concluído only through the conversion');
  assert.equal(reasonRequired('sales_orders', 'open', 'cancelled'), true);
  assert.equal(reasonRequired('sales_orders', 'fulfilled', 'open'), true);
  assert.equal(reasonRequired('sales_orders', 'open', 'verified'), false);
  assert.equal(reasonRequired('sales_orders', 'draft', 'fulfilled'), false, 'a new move between open situações needs no reason');
  assert.equal(reasonRequired('sales_orders', 'fulfilled', 'in_progress'), true, 'leaving a closed situação needs a reason');
  assert.equal(reasonRequired('service_orders', 'approved', 'in_progress'), false, '008 forward move');
  assert.equal(reasonRequired('service_orders', 'approved', 'quoted'), true);
});

test('batch situação preview skips each row with its reason and requires a reason for cancel/reopen', () => {
  const rows = [row({ id: id(1), status: 'open' }), row({ id: id(2), status: 'cancelled', number: '8' }), row({ id: id(3), status: 'draft', number: '9' }), row({ id: id(4), status: 'open', number: '10', finance_active: true })];
  const plan = statusBatchPlan('sales_orders', rows, 'cancelled', '');
  assert.deepEqual(plan.eligible.map(item => item.id), []);
  assert.deepEqual(plan.skipped.map(item => item.message), ['Informe um motivo com pelo menos três caracteres.', 'Já está nesta situação.', 'Informe um motivo com pelo menos três caracteres.', 'Existe lançamento ou reserva ativa; estorne antes desta mudança.']);
  const reasoned = statusBatchPlan('sales_orders', rows, 'cancelled', 'Cliente desistiu');
  assert.deepEqual(reasoned.eligible.map(item => item.id), [id(1), id(3)]);
  assert.match(reasoned.eligible[0].label, /^Pedido 7 · Cliente sintético$/);
  const verified = statusBatchPlan('sales_orders', rows, 'verified', '');
  assert.deepEqual(verified.eligible.map(item => item.id), [id(1), id(3)], 'Em digitação → Verificado is allowed (todas para todas)');
  assert.match(verified.skipped.find(item => item.id === id(2)).message, /Informe um motivo/, 'leaving Cancelado needs a reason');
  assert.match(statusBatchPlan('sales_orders', [row({ id: id(5), status: 'partially_fulfilled' })], 'open', 'Motivo sintético').skipped[0].message, /Não é possível ir de Atendido parcialmente para Em aberto/);
  assert.equal(statusBatchPlan('sales_orders', rows, '', '').eligible.length, 4, 'rows wait for a target instead of being listed as ignored');
});

test('⋮ actions per screen enable only what exists for the profile; unavailable Origin items stay disabled with a reason', () => {
  const view = (kind, over, ctx) => documentRowActions(kind, row({ kind, ...over }), ctx).map(action => `${action.label}${action.enabled ? '' : ' (x)'}`);
  assert.deepEqual(view('sales_orders', {}, { role: 'admin', writable: true }), ['Editar', 'Gerar nota fiscal', 'Gerar nota fiscal parcial', 'Lançar estoque', 'Lançar contas', 'Gerar NFC-e', 'Gerar ordem serviço (x)', 'Clonar venda', 'Imprimir', 'Imprimir comprovante', 'Imprimir c/ detalhes', 'Imprimir carnê', 'Relatório de produção', 'Enviar por e-mail (x)', 'Enviar por WhatsApp', 'Emitir boletos (x)', 'Em digitação', 'Verificado', 'Em andamento', 'Venda Agenciada', 'Atendido', 'Cancelado']);
  assert.deepEqual(view('sales_orders', { reservation_active: true }, { role: 'estoque', writable: false }), ['Visualizar', 'Gerar nota fiscal (x)', 'Gerar nota fiscal parcial (x)', 'Lançar estoque (x)', 'Lançar contas (x)', 'Gerar NFC-e (x)', 'Gerar ordem serviço (x)', 'Clonar venda (x)', 'Imprimir', 'Imprimir comprovante', 'Imprimir c/ detalhes', 'Imprimir carnê', 'Relatório de produção', 'Enviar por e-mail (x)', 'Enviar por WhatsApp', 'Emitir boletos (x)']);
  const reserved = documentRowActions('sales_orders', row({ reservation_active: true }), { role: 'estoque', writable: false }).find(action => action.key === 'stock');
  assert.match(reserved.title, /reserva ativa/);
  assert.deepEqual(view('sales_orders', { status: 'in_progress', stock_active: true, finance_active: true }, { role: 'admin', writable: true }).filter(label => /estoque|contas|Atendido|Cancelado/.test(label)), ['Estornar estoque', 'Estornar contas', 'Atendido parcialmente', 'Atendido']);
  assert.deepEqual(view('sales_proposals', { status: 'approved' }, { role: 'vendas', writable: true }), ['Editar', 'Gerar venda', 'Gerar ordem de serviço', 'Imprimir', 'Enviar por e-mail (x)', 'Enviar por whatsapp', 'Rascunho', 'Em aberto', 'Pendente', 'Aguardando', 'Não aprovado', 'Cancelado', 'Clonar proposta', 'Criar modelo']);
  // 202610200129: like Origin, Gerar venda does not require Aprovado; cancelled and concluded propostas do not generate.
  assert.equal(documentRowActions('sales_proposals', row({ kind: 'sales_proposals', status: 'open' }), { role: 'vendas', writable: true }).find(action => action.key === 'convert_sale').enabled, true);
  assert.match(documentRowActions('sales_proposals', row({ kind: 'sales_proposals', status: 'cancelled' }), { role: 'vendas', writable: true }).find(action => action.key === 'convert_sale').title, /cancelada/);
  assert.match(documentRowActions('sales_proposals', row({ kind: 'sales_proposals', status: 'approved', template: true }), { role: 'vendas', writable: true }).find(action => action.key === 'convert_sale').title, /Modelos/);
  assert.deepEqual(view('service_orders', { status: 'open' }, { role: 'financeiro', writable: false }), ['Visualizar', 'Lançar contas', 'Lançar estoque (x)', 'Gerar nota fiscal (x)', 'Imprimir', 'Imprimir para técnico', 'Imprimir etiqueta', 'Imprimir carnê', 'Enviar por e-mail (x)', 'Enviar por whatsapp', 'Clonar ordem (x)']);
  // 202610200129: Origin order of the pedido de compra, without Editar (the row opens it).
  assert.deepEqual(view('purchase_orders', { status: 'in_progress', receipt_active: true }, { role: 'estoque', writable: true }), ['Estornar estoque', 'Lançar contas (x)', 'Gerar nota fiscal (x)', 'Imprimir', 'Imprimir etiquetas', 'Enviar por e-mail (x)', 'Enviar por whatsapp', 'Clonar compra', 'Atendido parcialmente', 'Atendido']);
  for (const action of documentRowActions('sales_orders', row(), { role: 'consulta', writable: false })) if (!action.enabled) assert.ok(action.title, action.label);
});

test('ordering toggles newest first, pages are counted from the filtered total and hints follow Origin wording', () => {
  assert.equal(nextOrder('date', 'date_desc'), 'date_asc'); assert.equal(nextOrder('date', 'number_desc'), 'date_desc');
  assert.equal(nextOrder('number', 'date_desc'), 'number_desc'); assert.equal(nextOrder('number', 'number_desc'), 'number_asc');
  assert.equal(orderColumn('number_asc'), 'number'); assert.equal(orderColumn('date_desc'), 'date');
  assert.deepEqual([0, 1, 100, 101, 250].map(total => pageCount(total)), [1, 1, 1, 2, 3]);
  assert.equal(SEARCH_HINTS.sales_orders, 'Pesquisar por nome, e-mail, CPF/CNPJ ou n° do pedido');
  assert.equal(SEARCH_HINTS.sales_proposals, 'Pesquisa por nome ou número da proposta');
  assert.deepEqual(DATE_TYPES.sales_orders.map(type => type.label), ['Data do pedido', 'Data prevista', 'Data de saída']);
  assert.deepEqual(DATE_TYPES.service_orders.map(type => type.label), ['Período', 'Previstos para', 'Concluídos para', 'Data de Saída', 'Garantia']);
});

test('reasons follow the worker (no control characters) and an unreadable reservation flag never counts as an effect', () => {
  assert.equal(validReason('Cliente desistiu'), true);
  for (const reason of ['  ab  ', 'Cliente\tdesistiu', 'Cliente\ndesistiu', 'x'.repeat(1001)]) assert.equal(validReason(reason), false, JSON.stringify(reason));
  // Financeiro reads the order but not the stock: reservation_active comes null and the server still checks every change.
  assert.equal(effectsActive(row({ reservation_active: null })), false);
  assert.equal(effectsActive(row({ reservation_active: true })), true);
  assert.deepEqual(statusTargets('sales_orders', row({ reservation_active: null })), ['draft', 'verified', 'in_progress', 'agency_sale', 'fulfilled', 'cancelled']);
  assert.equal(listIndicators(row({ stock_active: true, warehouse_id: id(5), warehouse_name: null })).find(item => item.key === 'E').title, 'Estoque lançado');
});
