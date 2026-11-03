import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { documentsDFixture } from './helpers/documents-d-fixture.mjs';

// 202610200196 (Pagamento, Lista de preço, impostos, lançamento automático e Gerar venda pré-preenchido) on PGlite through the
// real Worker. Synthetic data only.
let f, cash, bank, closed, card, payOnly, inactive, list, expired;
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const save = (kind, extra, user, top = {}) => f.call(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: f.data(kind, extra), ...top }, user);
const edit = (kind, doc, extra, user) => f.call(`/v1/documentos/${kind}/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data: f.data(kind, extra) }, user);
const read = async (kind, id) => (await ok(`/v1/documentos/${kind}/${id}`)).document;
const status = (kind, doc, target, user) => f.call(`/v1/documentos/${kind}/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: target }, user);
const details = (extra = {}) => ({ account_id: null, payment_type: null, card_brand: null, integration_type: null, acquirer_cnpj: null, authorization_code: null, received_amount: null, fee_amount: null, commission_fee_amount: null, ...extra });
const one = async (sql, args = []) => (await f.db.query(sql, args)).rows[0];
const method = async (description, extra = {}) => (await one(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by,active,deleted_at)
  values($1,$2,'contas',$3,$4,$4,$5,null) returning id`, [description, extra.type ?? '15', extra.applicable ?? 'ambos', f.users.admin, extra.active ?? true])).id;
before(async () => {
  f = await documentsDFixture();
  cash = (await one("insert into erp_finance.account(name,kind) values('Caixa sintético','cash') returning id")).id;
  bank = (await one("insert into erp_finance.account(name,kind) values('Banco sintético','bank') returning id")).id;
  closed = (await one("insert into erp_finance.account(name,kind,active) values('Conta encerrada','bank',false) returning id")).id;
  card = await method('Cartão sintético', { type: '03' });
  payOnly = await method('Só pagamentos', { applicable: 'pagamentos' });
  inactive = await method('Forma inativa', { active: false });
  list = (await one("insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction) values('Atacado sintético','other','custom',null,'percent','discount') returning id")).id;
  expired = (await one("insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction,starts_on,ends_on) values('Lista vencida','other','custom',null,'percent','discount','2020-01-01','2020-01-31') returning id")).id;
});
after(() => f?.close());

test('196 grants and hash guard', async () => {
  for (const fn of ['public.erp_document_payment_options(uuid,text)', 'public.erp_document_supplier_codes(uuid,uuid,uuid[])', 'public.erp_document_conversion_preview(uuid,text,uuid)', 'public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, fn);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true, fn);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
  }
  for (const internal of ['erp_documents.check_payment_links(text,jsonb,jsonb)', 'erp_documents.check_tax_preference(jsonb,jsonb)','erp_documents.auto_finance(uuid,uuid,uuid)', 'erp_documents.installment_details(text,jsonb,numeric)', 'erp_documents.finance_payment_preview(erp_documents.document,jsonb)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [internal]), false, internal);
});

test('the SQL normalize and the domain agree on the 196 fields', async () => {
  const body = { date: '2026-10-20', contact_id: f.contact.id, items: [f.line({ list_price: '12.5', supplier_code: null }), f.line({ quantity: '2', list_price: null, supplier_code: null })],
    tax_ipi: '1.25', tax_icms_st: '0.75', price_list_id: list, payment_account_id: cash, payment_means: '03', payment_indicator: '1',
    installments: [{ due_date: '2026-10-21', amount: '20.00', method: null, note: null, payment_reference: null, payment_method_id: card, details: details({ payment_type: '03', card_brand: '01', integration_type: '2', acquirer_cnpj: '12ABC34501DE35', authorization_code: 'A1-2', received_amount: '19.5', fee_amount: '0.5' }) },
      { due_date: '2026-11-21', amount: '12.00', payment_method_id: null, details: null }] };
  const sql = await f.scalar('select erp_documents.normalize($1,$2::jsonb) v', ['sales_orders', JSON.stringify(body)]);
  assert.deepEqual(sql, normalizeDocument('sales_orders', body));
  assert.equal(sql.totals.total, '32.00'); assert.deepEqual([sql.totals.ipi, sql.totals.icms_st], ['1.25', '0.75']);
  const purchase = { date: '2026-10-20', contact_id: f.contact.id, items: [f.line({ supplier_code: ' FORN-1 ', list_price: null })] };
  assert.deepEqual(await f.scalar('select erp_documents.normalize($1,$2::jsonb) v', ['purchase_orders', JSON.stringify(purchase)]), normalizeDocument('purchase_orders', purchase));
  for (const [kind, change] of [['sales_orders', { items: [f.line({ supplier_code: 'X' })] }], ['purchase_orders', { price_list_id: list }], ['purchase_orders', { tax_ipi: '1.00' }],
    ['sales_proposals', { installments: [{ due_date: '2026-10-21', amount: '10', details: details() }] }], ['sales_proposals', { payment_account_id: cash }], ['service_orders', { payment_means: '01' }],
    ['sales_orders', { installments: [{ due_date: '2026-10-21', amount: '10', details: details({ fee_amount: '10.01' }) }] }], ['sales_orders', { payment_indicator: '2' }]]) {
    const value = { date: '2026-10-20', contact_id: f.contact.id, items: [f.line()], ...change };
    assert.throws(() => normalizeDocument(kind, value), `${kind} ${JSON.stringify(change)}`);
    await assert.rejects(() => f.scalar('select erp_documents.normalize($1,$2::jsonb) v', [kind, JSON.stringify(value)]), `${kind} ${JSON.stringify(change)}`);
  }
});

test('Pagamento: Destino, Detalhes de pagamento, Forma and details of the parcelas, checked when new or changed and named in the reading', async () => {
  const options = await ok('/v1/documentos/sales_orders/pagamento', 'GET', undefined, f.users.vendas);
  assert.deepEqual(options.methods.map(m => m.description).sort(), ['Cartão sintético', 'Forma inativa'].filter(name => name !== 'Forma inativa'));
  assert.deepEqual(options.accounts.map(a => a.name), ['Banco sintético', 'Caixa sintético']);
  assert.deepEqual((await ok('/v1/documentos/purchase_orders/pagamento', 'GET', undefined, f.users.estoque)).methods.map(m => m.description).sort(), ['Cartão sintético', 'Só pagamentos']);
  assert.deepEqual((await ok('/v1/documentos/sales_proposals/pagamento', 'GET', undefined, f.users.vendas)).accounts, []);
  // Only who writes the kind chooses formas and contas: a profile that only reads pedidos de venda never lists the contas financeiras.
  for (const user of [f.users.fiscal, f.users.estoque]) assert.equal((await f.call('/v1/documentos/sales_orders/pagamento', 'GET', undefined, user)).status, 403);
  const installments = [{ due_date: '2026-10-21', amount: '10.00', method: null, note: null, payment_reference: null, payment_method_id: card, details: details({ account_id: bank, payment_type: '03', authorization_code: 'AUT9' }) }];
  const created = await save('sales_orders', { payment_account_id: cash, payment_means: '17', payment_indicator: '0', installments }, f.users.vendas);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  let doc = await read('sales_orders', created.value.document.id);
  assert.deepEqual([doc.payment_account_id, doc.payment_account_name, doc.payment_means, doc.payment_indicator], [cash, 'Caixa sintético', '17', '0']);
  assert.deepEqual([doc.installments[0].payment_method_id, doc.payment_method_names[card], doc.payment_account_names[bank], doc.installments[0].details.authorization_code], [card, 'Cartão sintético', 'Banco sintético', 'AUT9']);
  assert.equal((await save('sales_orders', { installments: [{ ...installments[0], payment_method_id: payOnly }] })).status, 400, 'a forma só de pagamentos is refused in a pedido de venda');
  assert.equal((await save('sales_orders', { installments: [{ ...installments[0], payment_method_id: inactive }] })).status, 400, 'an inactive forma cannot be chosen');
  assert.equal((await save('sales_orders', { payment_account_id: closed })).status, 400, 'an inactive conta cannot be chosen');
  assert.equal((await save('purchase_orders', { installments: [{ ...installments[0], payment_method_id: payOnly, details: details() }] }, f.users.estoque)).status, 200);
  // A forma inactivated after the choice stays on the pedido already saved.
  await f.db.query('update erp_catalog.payment_method set active=false where id=$1', [card]);
  const edited = await edit('sales_orders', doc, { payment_account_id: cash, payment_means: '17', payment_indicator: '0', installments, notes: 'Editado' }, f.users.vendas);
  assert.equal(edited.status, 200, JSON.stringify(edited.value));
  await f.db.query('update erp_catalog.payment_method set active=true where id=$1', [card]);
  // An older client that does not send the new fields cannot erase them.
  doc = edited.value.document;
  const old = await f.call(`/v1/documentos/sales_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version,
    data: { ...f.data('sales_orders'), payment_account_id: cash, payment_means: '17', payment_indicator: '0', installments: [{ due_date: '2026-10-21', amount: '10.00', method: null, note: null, payment_reference: null }] } }, f.users.vendas);
  assert.equal(old.status, 409, JSON.stringify(old.value));
});

test('Lista de preço and Preço lista stored; Código no fornecedor of the pedido de compra and its lookup', async () => {
  const created = await save('sales_orders', { price_list_id: list, items: [f.line({ product_id: f.product.id, description: 'Produto', list_price: '9.9', supplier_code: null })] }, f.users.vendas);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const doc = await read('sales_orders', created.value.document.id);
  assert.deepEqual([doc.price_list_id, doc.price_list_name, doc.items[0].list_price], [list, 'Atacado sintético', '9.9000']);
  assert.equal((await save('sales_orders', { price_list_id: expired })).status, 400, 'an expired list cannot be chosen');
  assert.equal((await save('purchase_orders', { price_list_id: list }, f.users.estoque)).status, 400);
  await f.db.query('insert into erp_catalog.product_supplier(record_id,position,supplier_id,code,is_default) values($1,1,$2,$3,true)', [f.product.id, f.contact.id, 'FORN-77']);
  const codes = await ok(`/v1/documentos/purchase_orders/codigos-fornecedor?contact_id=${f.contact.id}&produtos=${f.product.id},${f.other.id}`, 'GET', undefined, f.users.estoque);
  assert.deepEqual(codes.items, [{ product_id: f.product.id, code: 'FORN-77' }]);
  assert.equal((await f.call(`/v1/documentos/purchase_orders/codigos-fornecedor?contact_id=${f.contact.id}&produtos=${f.product.id}`, 'GET', undefined, f.users.vendas)).status, 403);
  const purchase = await save('purchase_orders', { items: [f.line({ product_id: f.product.id, description: 'Produto', supplier_code: 'FORN-77', list_price: null })] }, f.users.estoque);
  assert.equal(purchase.status, 200, JSON.stringify(purchase.value));
  assert.equal((await read('purchase_orders', purchase.value.document.id)).items[0].supplier_code, 'FORN-77');
  // Clonar keeps the list, the Preço lista and the Código no fornecedor.
  const preview = await ok(`/v1/duplicacao-documentos/purchase_orders/${purchase.value.document.id}/preview`, 'GET', undefined, f.users.estoque);
  assert.equal(preview.data.items[0].supplier_code, 'FORN-77');
  const salePreview = await ok(`/v1/duplicacao-documentos/sales_orders/${doc.id}/preview`, 'GET', undefined, f.users.vendas);
  assert.deepEqual([salePreview.data.price_list_id, salePreview.data.items[0].list_price], [list, '9.9000']);
});

test('Total do IPI e ICMS ST: added to the total, needs the preference when new or changed', async () => {
  assert.equal((await save('sales_orders', { tax_ipi: '1.00', tax_icms_st: '0.00' })).status, 400, 'preference off');
  await f.setPreference('vendas-propostas', 'propostas.exibir_ipi_st', true);
  const created = await save('sales_orders', { tax_ipi: '1.00', tax_icms_st: '0.50', installments: [{ due_date: '2026-10-20', amount: '11.50', method: null }] });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  assert.deepEqual([created.value.document.totals.total, created.value.document.totals.ipi], ['11.50', '1.00']);
  assert.equal(await f.scalar('select total::text v from erp_documents.document where id=$1', [created.value.document.id]), '11.50');
  await f.setPreference('vendas-propostas', 'propostas.exibir_ipi_st', false);
  // Unchanged taxes keep the pedido editable with the preference off.
  const again = await edit('sales_orders', created.value.document, { tax_ipi: '1.00', tax_icms_st: '0.50', installments: [{ due_date: '2026-10-20', amount: '11.50', method: null }], notes: 'Editado' });
  assert.equal(again.status, 200, JSON.stringify(again.value));
  // Duplicar keeps the taxes of the source; with the preference off they stay valid while unchanged, a new value does not.
  const preview = await ok(`/v1/duplicacao-documentos/sales_orders/${created.value.document.id}/preview`);
  assert.deepEqual([preview.data.tax_ipi, preview.data.tax_icms_st], ['1.00', '0.50']);
  const copy = body => f.call(`/v1/duplicacao-documentos/sales_orders/${created.value.document.id}`, 'POST', { command_id: randomUUID(), expected_source_version: preview.source.version, data: { ...preview.data, ...body } });
  const copied = await copy({});
  assert.equal(copied.status, 200, JSON.stringify(copied.value)); assert.equal(copied.value.document.totals.total, '11.50');
  assert.equal((await copy({ tax_ipi: '2.00' })).status, 400, 'a changed tax needs the preference');
  // Gerar venda of a proposta saved with taxes, after the preference was switched off.
  await f.setPreference('vendas-propostas', 'propostas.exibir_ipi_st', true);
  const proposal = (await save('sales_proposals', { tax_ipi: '1.00', tax_icms_st: '0.00', installments: [{ due_date: '2026-10-30', amount: '11.00', method: null }] })).value.document;
  await f.setPreference('vendas-propostas', 'propostas.exibir_ipi_st', false);
  const prefilled = await ok(`/v1/documentos/sales_orders/a-partir-da-proposta/${proposal.id}`);
  const sale = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: prefilled.data, source_proposal: { id: proposal.id, expected_version: prefilled.source.version } });
  assert.equal(sale.status, 200, JSON.stringify(sale.value)); assert.equal(sale.value.document.totals.total, '11.00');
});

test('Lançar contas takes the Forma and the conta of the Destino; the contas stay open', async () => {
  const created = await save('sales_orders', { payment_account_id: cash, installments: [{ due_date: '2026-10-20', amount: '4.00', method: null, payment_method_id: card, details: null },
    { due_date: '2026-11-20', amount: '6.00', method: null, payment_method_id: null, details: details({ account_id: bank }) }] });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  let doc = created.value.document;
  const moved = await status('sales_orders', doc, 'in_progress'); assert.equal(moved.status, 200, JSON.stringify(moved.value)); doc = moved.value.document;
  const preview = (await ok(`/v1/documentos/sales_orders/${doc.id}/financeiro/preview`, 'POST', { expected_document_version: doc.version, category_id: null, installments: null }, f.users.financeiro)).preview;
  assert.deepEqual(preview.installments.map(p => [p.payment_method_name, p.account_name]), [['Cartão sintético', 'Caixa sintético'], [null, 'Banco sintético']]);
  const posted = await ok(`/v1/documentos/sales_orders/${doc.id}/financeiro/post`, 'POST', { expected_document_version: doc.version, category_id: null, installments: null, command_id: randomUUID(), preview_hash: preview.preview_hash }, f.users.financeiro);
  assert.equal(posted.cash_movement_performed, false);
  const titles = (await f.db.query('select payment_method_id,account_id,settled_cents from erp_finance.title t join erp_finance.document_title l on l.title_id=t.id where l.posting_id=$1 order by l.position', [posted.posting.id])).rows;
  assert.deepEqual(titles, [{ payment_method_id: card, account_id: cash, settled_cents: 0 }, { payment_method_id: null, account_id: bank, settled_cents: 0 }]);
});

test('Lançamento automático de contas em Pedidos de Venda: on a change of situação and on the save, with the profile of the user', async () => {
  const fresh = async () => (await save('sales_orders', { installments: [{ due_date: '2026-10-25', amount: '10.00', method: null }] })).value.document;
  let doc = await fresh();
  let moved = await status('sales_orders', doc, 'fulfilled');
  assert.equal(moved.status, 200); assert.equal(moved.value.auto_finance, undefined, 'preference off: nothing posted');
  await f.setPreference('vendas-vendas', 'vendas.contas_automaticas_pedido', true);
  doc = await fresh();
  assert.equal((await save('sales_orders', {})).value.auto_finance, undefined, 'Em aberto is not a situação of lançamento');
  moved = await status('sales_orders', doc, 'fulfilled');
  assert.equal(moved.status, 200, JSON.stringify(moved.value)); assert.equal(moved.value.auto_finance.outcome, 'done');
  assert.equal(moved.value.document.effect_flags.finance_active, true);
  assert.equal(await f.scalar("select count(*)::int v from erp_finance.document_posting where document_id=$1 and state='active'", [doc.id]), 1);
  // Vendas cannot post contas: the situação changes and the answer says why nothing was posted.
  doc = await fresh();
  moved = await status('sales_orders', doc, 'verified', f.users.vendas);
  assert.equal(moved.status, 200, JSON.stringify(moved.value)); assert.deepEqual(moved.value.auto_finance, { outcome: 'skipped', reason: 'erp_finance_access_denied' });
  assert.equal(moved.value.document.effect_flags.finance_active, false);
  // Saving a pedido already in a situação of lançamento posts it (one parcela à vista without parcelas).
  const saved = await edit('sales_orders', moved.value.document, { notes: 'Sem parcelas' });
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); assert.equal(saved.value.auto_finance.outcome, 'done');
  assert.equal(await f.scalar("select string_agg(t.due_on::text||':'||t.amount_cents,',') v from erp_finance.title t join erp_finance.document_title l on l.title_id=t.id join erp_finance.document_posting p on p.id=l.posting_id where p.document_id=$1", [doc.id]), '2026-10-20:1000');
  // The change of situação made by an occurrence (list ⋮ and the modal) also posts and says so.
  doc = await fresh();
  const occurrence = await f.call(`/v1/documentos/sales_orders/${doc.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: doc.version, occurred_on: '2026-10-20', occurred_time: '10:00', text: null, status: 'in_progress' });
  assert.equal(occurrence.status, 200, JSON.stringify(occurrence.value)); assert.equal(occurrence.value.auto_finance.outcome, 'done');
  await f.setPreference('vendas-vendas', 'vendas.contas_automaticas_pedido', false);
});

test('Gerar venda / Gerar ordem de serviço opened prefilled; the save concludes the proposta once', async () => {
  const proposal = (await save('sales_proposals', { price_list_id: list, items: [f.line({ list_price: '11', supplier_code: null })], installments: [{ due_date: '2026-10-30', amount: '10.00', method: null, payment_method_id: card }] })).value.document;
  const prefilled = await ok(`/v1/documentos/sales_orders/a-partir-da-proposta/${proposal.id}`, 'GET', undefined, f.users.vendas);
  assert.deepEqual([prefilled.source.number, prefilled.data.price_list_id, prefilled.data.items[0].list_price, prefilled.data.installments[0].payment_method_id], [proposal.number, list, '11.0000', card]);
  assert.equal(await f.scalar('select status v from erp_documents.document where id=$1', [proposal.id]), 'draft', 'nothing is saved by the preview');
  const sale = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: prefilled.data, source_proposal: { id: proposal.id, expected_version: 1 } }, f.users.vendas);
  assert.equal(sale.status, 200, JSON.stringify(sale.value));
  assert.deepEqual([sale.value.source_proposal.status, sale.value.document.source_proposal_id], ['completed', proposal.id]);
  assert.equal(await f.scalar('select status v from erp_documents.document where id=$1', [proposal.id]), 'completed');
  assert.equal((await f.call(`/v1/documentos/service_orders/a-partir-da-proposta/${proposal.id}`)).status, 409, 'already converted');
  const other = (await save('sales_proposals', {})).value.document;
  assert.equal((await f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), data: f.data('service_orders'), source_proposal: { id: other.id, expected_version: 9 } })).status, 409, 'stale proposta');
  assert.equal((await f.call('/v1/documentos/purchase_orders', 'POST', { command_id: randomUUID(), data: f.data('purchase_orders'), source_proposal: { id: other.id, expected_version: 1 } })).status, 400);
  const os = await f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), data: f.data('service_orders'), source_proposal: { id: other.id, expected_version: 1 } });
  assert.equal(os.status, 200, JSON.stringify(os.value)); assert.equal(os.value.document.source_proposal_id, other.id);
});

test('Gerar ordem serviço of a pedido leaves the Detalhes de pagamento out', async () => {
  const sale = (await save('sales_orders', { payment_means: '01', payment_indicator: '0' })).value.document;
  const os = await ok(`/v1/documentos/sales_orders/${sale.id}/gerar-os`, 'POST', { command_id: randomUUID(), expected_version: sale.version });
  const doc = await read('service_orders', os.service_order.id);
  assert.deepEqual([doc.payment_means ?? null, doc.payment_indicator ?? null], [null, null]);
});

test('Bloquear a proposta acima do limite de crédito: parcelas plus the open contas a receber, refused with its own code; the administrador saves', async () => {
  const client = await f.catalog('contacts', { name: 'Cliente com limite' });
  await f.db.query(`insert into erp_catalog.contact_profile(record_id,credit_limit_mode,credit_limit) values($1,'value',15) on conflict(record_id) do update set credit_limit_mode='value',credit_limit=15`, [client.id]);
  const parcel = amount => ({ installments: [{ due_date: '2026-10-30', amount, method: null }] });
  const proposal = (extra, user) => f.call('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: { ...f.data('sales_proposals', extra), contact_id: client.id } }, user);
  assert.equal((await proposal(parcel('10.00'), f.users.vendas)).status, 200, 'preference off');
  await f.setPreference('vendas-propostas', 'propostas.bloquear_limite_credito', true);
  assert.equal((await proposal(parcel('10.00'), f.users.vendas)).status, 200, 'within the limit');
  await f.db.query(`insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,original_due_on) values(gen_random_uuid(),1,1,'receivable',$1,'Conta sintética','2026-10-01','2026-10-31',800,'2026-10-31')`, [client.id]);
  const refused = await proposal(parcel('10.00'), f.users.vendas);
  assert.deepEqual([refused.status, refused.value.error?.code], [400, 'ERP_DOCUMENT_CREDIT_LIMIT'], JSON.stringify(refused.value));
  assert.equal((await proposal({}, f.users.vendas)).status, 200, 'without parcelas nothing is parcelado');
  assert.equal((await proposal(parcel('10.00'), f.users.admin)).status, 200, 'Desconsiderar limite');
  await f.setPreference('vendas-propostas', 'propostas.bloquear_limite_credito', false);
});
