// Synthetic data only. 202610200267: the seller scope ("Contato acessível somente ao vendedor vinculado") in the reads by document
// (ocorrências, anexos, diário and eventos da OS, pendências, cópia, conversões) and in the reports; the automatic contas a pagar of
// the new pedido de compra; the Frente de caixa that leaves a refused effect pending. PGlite with every migration, the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';
import { posFixture, today } from './helpers/pos-fixture.mjs';

let f;
before(async () => { f = await documentsEFixture(); });
after(async () => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.value)}`); return r.value; };
const status = async (path, method = 'GET', body, user) => (await f.call(path, method, body, user)).status;

test('privileges: the replaced public RPCs run only for service_role; the internal helpers for nobody', async () => {
  const sigs = ['erp_document_occurrence_list(uuid,text,uuid)', 'erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid)', 'erp_document_pendencies(uuid,text,uuid)',
    'erp_document_copy_preview(uuid,text,uuid)', 'erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)', 'erp_proposal_convert(uuid,uuid,integer,uuid)',
    'erp_proposal_convert_to_service(uuid,uuid,integer,uuid)', 'erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)', 'erp_document_sales_report(uuid,jsonb)',
    'erp_document_sales_abc(uuid,text,text)', 'erp_document_service_report(uuid,jsonb)', 'erp_document_service_occurrence_report(uuid,text,text,text)'];
  for (const sig of sigs) {
    const row = (await f.db.query("select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)", [`public.${sig}`])).rows[0];
    assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']], sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, `public.${sig}`]), false, `${role} ${sig}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [`public.${sig}`]), true, sig);
  }
  for (const sig of ['erp_attachments.authorize(uuid,text,uuid,boolean)', 'erp_documents.service_event_context(uuid,uuid)', 'erp_documents.service_journal_context(uuid,uuid,boolean)',
    'erp_pos.sale_effects(uuid,uuid,uuid,jsonb)', 'erp_documents.auto_finance(uuid,uuid,uuid)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false, `${role} ${sig}`);
});

test('Contato acessível somente ao vendedor vinculado: reads by document, conversions and reports follow the seller of the contact', async () => {
  const sellerId = await f.seller(f.users.vendas, { allow: true, name: 'Vendedor do escopo F' });
  const mine = await f.catalog('contacts', { name: 'Cliente F do vendedor', city: 'Campinas', state: 'SP' }), other = await f.catalog('contacts', { name: 'Cliente F de outro', city: 'Campinas', state: 'SP' });
  await f.assign(mine.id, sellerId);
  const day = { date: '2026-09-15' };
  const a = await f.create('sales_orders', { ...day, contact_id: mine.id }), b = await f.create('sales_orders', { ...day, contact_id: other.id });
  const pa = await f.create('sales_proposals', { ...day, contact_id: mine.id }), pb = await f.create('sales_proposals', { ...day, contact_id: other.id });
  const oa = await f.create('service_orders', { ...day, contact_id: mine.id, equipment: 'Equipamento F' }), ob = await f.create('service_orders', { ...day, contact_id: other.id, equipment: 'Equipamento F' });
  await f.setPreference('empresa-geral', 'empresa.editar_data_ocorrencia', true);
  for (const doc of [oa, ob]) await ok(`/v1/documentos/service_orders/${doc.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: doc.version, occurred_on: '2026-09-16', occurred_time: '10:00', text: 'Ocorrência F' });
  await f.setPreference('empresa-geral', 'empresa.editar_data_ocorrencia', false);
  const report = user => ok('/v1/documentos/sales_orders/relatorio-vendas?from=2026-09-01&to=2026-09-30&group=contact', 'GET', undefined, user);
  const names = value => value.groups.map(group => group.label).filter(label => label.startsWith('Cliente F')).sort();
  assert.deepEqual(names(await report(f.users.vendas)), ['Cliente F de outro', 'Cliente F do vendedor'], 'without the preference every contact');
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try {
    const seller = f.users.vendas;
    // Ocorrências, pendências, cópia conferida: the document of another contact is not found.
    assert.equal(await status(`/v1/documentos/sales_orders/${b.id}/ocorrencias`, 'GET', undefined, seller), 404);
    assert.equal(await status(`/v1/documentos/sales_orders/${a.id}/ocorrencias`, 'GET', undefined, seller), 200);
    assert.equal(await status(`/v1/documentos/sales_orders/${b.id}/pendencias`, 'GET', undefined, seller), 404);
    assert.equal(await status(`/v1/documentos/sales_orders/${a.id}/pendencias`, 'GET', undefined, seller), 200);
    assert.equal(await status(`/v1/duplicacao-documentos/sales_orders/${b.id}/preview`, 'GET', undefined, seller), 404);
    assert.equal(await status(`/v1/duplicacao-documentos/sales_orders/${a.id}/preview`, 'GET', undefined, seller), 200);
    const removable = (await ok(`/v1/documentos/service_orders/${ob.id}/ocorrencias`)).items[0];
    assert.equal(await status(`/v1/documentos/service_orders/${ob.id}/ocorrencias/${removable.id}/exclusao`, 'POST', { command_id: randomUUID() }, seller), 404);
    // Anexos (every attachment RPC goes through erp_attachments.authorize).
    await assert.rejects(() => f.rpc('erp_attachment_list', { p_user_id: seller, p_kind: 'sales_orders', p_document_id: b.id }), /erp_attachment_document_not_found/);
    assert.equal((await f.rpc('erp_attachment_list', { p_user_id: seller, p_kind: 'sales_orders', p_document_id: a.id })).document_id, a.id);
    await assert.rejects(() => f.rpc('erp_attachment_reserve', { p_user_id: seller, p_kind: 'sales_orders', p_document_id: b.id, p_command_id: randomUUID(), p_filename: 'f.pdf',
      p_mime_type: 'application/pdf', p_size_bytes: 10, p_sha256: 'a'.repeat(64) }), /erp_attachment_document_not_found/);
    // Diário and eventos da OS.
    assert.equal(await status(`/v1/ordens-servico/${ob.id}/diario`, 'GET', undefined, seller), 404);
    assert.equal(await status(`/v1/ordens-servico/${oa.id}/diario`, 'GET', undefined, seller), 200);
    assert.equal(await status(`/v1/ordens-servico/${ob.id}/eventos`, 'GET', undefined, seller), 404);
    assert.equal(await status(`/v1/ordens-servico/${oa.id}/eventos`, 'GET', undefined, seller), 200);
    // Conversions by id (Gerar venda / Gerar ordem de serviço / Gerar ordem serviço do pedido).
    assert.equal(await status(`/v1/documentos/sales_proposals/${pb.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: pb.version }, seller), 404);
    assert.equal(await status(`/v1/documentos/sales_orders/${b.id}/gerar-os`, 'POST', { command_id: randomUUID(), expected_version: b.version }, seller), 404);
    // Reports: only the contacts of the seller of the user; the administrador sees everything.
    assert.deepEqual(names(await report(seller)), ['Cliente F do vendedor']);
    assert.deepEqual(names(await report(f.users.admin)), ['Cliente F de outro', 'Cliente F do vendedor']);
    const abc = await ok('/v1/documentos/sales_orders/curva-abc?from=2026-09-01&to=2026-09-30', 'GET', undefined, seller);
    assert.equal(abc.total, '10.00', 'only the pedido of the seller contact in September');
    const os = await ok(`/v1/documentos/service_orders/relatorio-os?condicoes=${encodeURIComponent(JSON.stringify([{ column: 'date', value: '2026-09-15' }]))}`, 'GET', undefined, seller);
    assert.deepEqual(os.rows.map(row => row.id), [oa.id]);
    const occurrences = await ok('/v1/documentos/service_orders/relatorio-ocorrencias?from=2026-09-01&to=2026-09-30', 'GET', undefined, seller);
    assert.deepEqual([...new Set(occurrences.rows.map(row => row.document_id))], [oa.id]);
    const everything = await ok('/v1/documentos/service_orders/relatorio-ocorrencias?from=2026-09-01&to=2026-09-30');
    assert.deepEqual([...new Set(everything.rows.map(row => row.document_id))].sort(), [oa.id, ob.id].sort());
    // The administrador is never scoped; the conversion of a visible proposta still works for the seller.
    assert.equal(await status(`/v1/documentos/sales_orders/${b.id}/ocorrencias`), 200);
    assert.equal(await status(`/v1/documentos/sales_proposals/${pa.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: pa.version }, seller), 200);
  } finally {
    await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false);
    await f.db.query('update erp_catalog.contact_profile set seller_id=null where seller_id=$1', [sellerId]);
    await f.db.query('delete from erp_catalog.seller where id=$1', [sellerId]);
  }
});

test('Automação lançamento de contas pagar ao criar novo pedido de compra: the save that creates the pedido posts its parcelas', async () => {
  const create = (extra, user = f.users.admin) => f.call('/v1/documentos/purchase_orders', 'POST', { command_id: randomUUID(), data: f.data('purchase_orders', extra) }, user);
  const parcelas = { installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] };
  const postings = id => f.scalar("select count(*)::int v from erp_finance.document_posting where document_id=$1 and state='active'", [id]);
  let saved = await create(parcelas);
  assert.equal(saved.status, 200); assert.equal(saved.value.auto_finance, undefined, 'the preference starts off');
  const before = saved.value.document;
  await f.setPreference('suprimentos-compras', 'compras.automacao_contas_pagar', true);
  try {
    saved = await create(parcelas);
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    assert.equal(saved.value.auto_finance.outcome, 'done');
    const doc = saved.value.document;
    assert.deepEqual([doc.status, await postings(doc.id)], ['open', 1]);
    assert.equal(await f.scalar("select t.kind v from erp_finance.document_posting p join erp_finance.title t on t.group_id=p.group_id where p.document_id=$1 limit 1", [doc.id]), 'payable');
    // Without parcelas, by a profile without contas, or editing an older pedido: saved, nothing posted, the answer says why.
    saved = await create({});
    assert.deepEqual([saved.status, saved.value.auto_finance], [200, { outcome: 'skipped', reason: 'erp_document_finance_no_installments' }]);
    saved = await create(parcelas, f.users.estoque);
    assert.deepEqual([saved.status, saved.value.auto_finance], [200, { outcome: 'skipped', reason: 'erp_finance_access_denied' }]);
    assert.equal(await postings(saved.value.document.id), 0);
    const edited = await f.call(`/v1/documentos/purchase_orders/${before.id}`, 'PATCH', { command_id: randomUUID(), expected_version: before.version, data: f.data('purchase_orders', { ...parcelas, notes: 'Editado' }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.value));
    assert.deepEqual([edited.value.auto_finance, await postings(before.id)], [undefined, 0], 'only the creation posts');
    // Replay: the same command answers the same result and posts once.
    const command = randomUUID(), body = { command_id: command, data: f.data('purchase_orders', parcelas) };
    const first = await f.call('/v1/documentos/purchase_orders', 'POST', body), again = await f.call('/v1/documentos/purchase_orders', 'POST', body);
    assert.deepEqual([first.status, again.status, again.value.document.id], [200, 200, first.value.document.id]);
    assert.equal(await postings(first.value.document.id), 1);
  } finally { await f.setPreference('suprimentos-compras', 'compras.automacao_contas_pagar', false); }
});

test('Origem padrão (PRD-122): the product created from a free item of a document gets Preferências › Produtos Origem padrão', async () => {
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_vendas', true);
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_compras', true);
  await f.setPreference('cadastros-produtos', 'produtos.origem_padrao', '2');
  try {
    for (const kind of ['sales_orders', 'purchase_orders']) {
      const doc = await f.create(kind, { items: [f.line({ description: `Produto livre origem ${kind}`, code: `ORIG-${kind}` })] });
      const productId = await f.scalar('select product_id::text v from erp_documents.item where document_id=$1', [doc.id]);
      assert.ok(productId, kind);
      assert.equal(await f.scalar('select origin v from erp_catalog.product where record_id=$1', [productId]), '2', kind);
    }
  } finally {
    await f.setPreference('cadastros-produtos', 'produtos.origem_padrao', '0');
    await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_vendas', false);
    await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_compras', false);
  }
});

test('Frente de caixa: a refused baixa à vista leaves the parcela open with the reason; the sale is finished', async () => {
  const p = await posFixture();
  try {
    await p.receive(p.product.id, '10');
    // A forma "Caixa e bancos" whose conta financeira was inactivated: the baixa à vista into it is refused by the Financeiro.
    const closed = (await p.rpc('erp_finance_account_execute', { p_user_id: p.users.admin, p_command_id: randomUUID(), p_action: 'account_create',
      p_data: { account_type: 'cash', name: 'Caixa inativado', start_on: '2020-01-01', opening_cents: '0' } })).record;
    await p.db.query('update erp_finance.account set active=false where id=$1', [closed.id]);
    const method = await p.scalar("insert into erp_catalog.payment_method(description,payment_type,destination,account_id,applicable,created_by,updated_by) values('Dinheiro conta inativa','01','caixa',$1,'recebimentos',$2,$2) returning id::text v", [closed.id, p.users.admin]);
    const item = { id: randomUUID(), product_id: p.product.id, description: p.product.name, code: p.product.code ?? null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0', detailed_description: null };
    const data = { sale_id: null, expected_version: 0, document_version: null, kind: 'balcao', table_number: null, account_id: p.store.id, cash_session_id: null, contact_id: p.contact.id, price_list_id: null,
      document: { date: today(), warehouse_id: p.warehouse.id, items: [item], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', notes: null, internal_notes: null, seller_id: null, category_id: null },
      payments: [{ payment_method_id: method, days: 0, amount_cents: '1000', note: null }], destination_account_id: null, to_ledger: false, cash_received_cents: null };
    const r = await p.call('/v1/frente-caixa/actions/sale_finish', 'POST', { command_id: randomUUID(), data });
    assert.equal(r.status, 200, JSON.stringify(r.value));
    const sale = r.value.record;
    assert.deepEqual([sale.state, sale.effects.stock, sale.effects.finance, sale.effects.settled_cents, sale.effects.open_cents, sale.effects.settle_reason],
      ['finished', 'posted', 'posted', '0', '1000', 'account_invalid']);
    assert.doesNotMatch(JSON.stringify(r.value.record.effects), /erp_/, 'only the short reason, never the SQL code');
    assert.equal(await p.balance(closed.id), '0');
    assert.equal(await p.scalar("select count(*)::int v from erp_finance.document_posting where document_id=$1 and state='active'", [sale.document_id]), 1, 'the contas stay open');
    const detail = await p.call(`/v1/frente-caixa/vendas/${sale.id}`);
    assert.equal(detail.value.record.effects.settle_reason, 'account_invalid');
  } finally { await p.close(); }
});
