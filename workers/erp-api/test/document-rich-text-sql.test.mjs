// Synthetic data only. 202610200270: texto rico seguro (Outros itens ou serviços and Condições comerciais › Texto of the proposta) and
// the Cabeçalho personalizado of the prints. PGlite with every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f;
before(async () => { f = await documentsEFixture(); });
after(async () => f?.close());
const run = (text, extra = {}) => ({ text, bold: false, italic: false, underline: false, color: null, background: null, size: null, ...extra });
const rich = (...blocks) => ({ version: 1, blocks: blocks.map(runs => ({ align: 'left', indent: 0, code: false, runs })) });
const content = rich([run('Instalação ', { bold: true }), run('no local', { color: '#c92a2a', size: 14 })], [run('Treinamento da equipe')]);
const proposal = (extra = {}) => f.data('sales_proposals', { other_items: { content, total: '25.00' }, commercial_conditions: { mode: 'installments', text: null }, ...extra });
const create = (data, kind = 'sales_proposals') => f.call(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data });

test('privileges: the new RPCs run only for service_role; the helpers and the tables are closed', async () => {
  for (const sig of ['public.erp_document_print_header(uuid,text)', 'public.erp_document_print_header_save(uuid,text,uuid,integer,jsonb)']) {
    const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
    assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']], sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  }
  for (const fn of ['erp_documents.rich_text(jsonb)', 'erp_documents.rich_text_plain(jsonb)', 'erp_documents.print_header_view(text,uuid)', 'erp_documents.extension_data(jsonb)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, `${role} ${fn}`);
  for (const table of ['print_header', 'print_header_audit']) for (const role of ['anon', 'authenticated', 'service_role'])
    assert.equal(await f.scalar("select has_table_privilege($1,$2,'SELECT') v", [role, `erp_documents.${table}`]), false);
});

test('Outros itens ou serviços: texto rico and Total outros itens added to the proposta; Condições comerciais Texto without parcelas', async () => {
  const saved = await create(proposal());
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const doc = saved.value.document;
  assert.deepEqual([doc.totals.subtotal, doc.totals.other_items, doc.totals.total, doc.other_items.total], ['10.00', '25.00', '35.00', '25.00']);
  assert.deepEqual(doc.other_items.content, content);
  const read = (await f.call(`/v1/documentos/sales_proposals/${doc.id}`)).value.document;
  assert.deepEqual(read.other_items, { content, total: '25.00' });
  // Parcelas follow the total with the outros itens.
  assert.equal((await create(proposal({ installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] }))).status, 400);
  assert.equal((await create(proposal({ installments: [{ due_date: '2026-11-20', amount: '35.00', method: null }] }))).status, 200);
  // Texto: the conditions are the text; no parcelas.
  const text = await create(proposal({ commercial_conditions: { mode: 'text', text: rich([run('50% na aprovação e 50% na entrega')]) } }));
  assert.equal(text.status, 200, JSON.stringify(text.value)); assert.equal(text.value.document.commercial_conditions.mode, 'text');
  assert.equal((await create(proposal({ commercial_conditions: { mode: 'text', text: null }, installments: [{ due_date: '2026-11-20', amount: '35.00', method: null }] }))).status, 400);
  // The reviewed copy keeps them.
  const copy = (await f.call(`/v1/duplicacao-documentos/sales_proposals/${doc.id}/preview`)).value;
  assert.deepEqual([copy.data.other_items, copy.data.commercial_conditions], [{ content, total: '25.00' }, { mode: 'installments', text: null }]);
});

test('refusals: never HTML nor unknown keys, colors or sizes; only the proposta has the two fields; the database checks the same', async () => {
  for (const bad of ['<b>Instalação</b>', { version: 1, blocks: [{ align: 'left', indent: 0, code: false, runs: [{ ...run('x'), html: '<script>' }] }] },
    rich([run('x', { color: 'red' })]), rich([run('x', { size: 13 })]), rich([run('linha\nquebrada')]), rich([run('')]), { version: 2, blocks: [] }])
    assert.equal((await create(proposal({ other_items: { content: bad, total: '1.00' } }))).status, 400, JSON.stringify(bad));
  assert.equal((await create(f.data('sales_orders', { other_items: { content, total: '1.00' } }), 'sales_orders')).status, 400);
  const sql = body => f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_proposals', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body });
  await assert.rejects(() => sql(proposal({ other_items: { content: rich([run('x', { color: '#FFF' })]), total: '1.00' } })), /erp_document_rich_text_invalid/);
  await assert.rejects(() => sql(proposal({ commercial_conditions: { mode: 'parcela', text: null } })), /erp_document_conditions_invalid/);
  await assert.rejects(() => f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: f.data('sales_orders', { other_items: { content, total: '1.00' } }) }), /erp_document_other_items_invalid/);
});

test('Gerar venda / Gerar ordem de serviço: the Outros itens become one free item with their total; the direct conversion refuses them', async () => {
  const source = (await create(proposal({ discount_mode: 'percent', discount_value: '10' }))).value.document;
  assert.deepEqual([source.totals.discount, source.totals.total], ['1.00', '34.00']);
  const draft = (await f.call(`/v1/documentos/sales_orders/a-partir-da-proposta/${source.id}`)).value;
  const free = draft.data.items.at(-1);
  assert.deepEqual([free.description, free.unit_price, free.quantity, free.detailed_description], ['Outros itens ou serviços', '25.00', '1', 'Instalação no local\nTreinamento da equipe']);
  assert.deepEqual([draft.data.discount_mode, draft.data.discount_value, 'other_items' in draft.data, 'commercial_conditions' in draft.data], ['amount', '1.00', false, false]);
  const sale = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), source_proposal: { id: source.id, expected_version: draft.source.version }, data: draft.data });
  assert.equal(sale.status, 200, JSON.stringify(sale.value)); assert.equal(sale.value.document.totals.total, source.totals.total, 'the total of the proposta');
  const other = (await create(proposal())).value.document;
  const os = (await f.call(`/v1/documentos/service_orders/a-partir-da-proposta/${other.id}`)).value;
  assert.deepEqual([os.data.items.at(-1).group, os.data.items.at(-1).unit_price], ['service', '25.00']);
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${other.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: other.version })).status, 400);
  // Without outros itens the direct conversion still works and the pedido never carries the fields of the proposta.
  const plain = (await create(proposal({ other_items: null, commercial_conditions: { mode: 'none', text: null } }))).value.document;
  const converted = await f.call(`/v1/documentos/sales_proposals/${plain.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: plain.version });
  assert.equal(converted.status, 200, JSON.stringify(converted.value));
  assert.equal(await f.scalar("select (body ? 'commercial_conditions') or (body ? 'other_items') v from erp_documents.document where id=$1", [converted.value.sale.id]), false);
});

test('Cabeçalho personalizado: read by the readers of the kind, saved by the administrador with command, version and audit', async () => {
  const empty = await f.call('/v1/documentos/sales_orders/cabecalho', 'GET', undefined, f.users.vendas);
  assert.deepEqual([empty.status, empty.value.version, empty.value.content, empty.value.can_manage], [200, 0, null, false]);
  const header = rich([run('Brufap Indústria', { bold: true, size: 16 })], [run('Rua Sintética, 100 — Campinas/SP')]);
  const command = randomUUID(), body = { command_id: command, expected_version: 0, content: header };
  const saved = await f.call('/v1/documentos/sales_orders/cabecalho', 'POST', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); assert.deepEqual([saved.value.version, saved.value.replayed, saved.value.content], [1, false, header]);
  const replay = await f.call('/v1/documentos/sales_orders/cabecalho', 'POST', body);
  assert.deepEqual([replay.status, replay.value.replayed, replay.value.version], [200, true, 1]);
  assert.equal((await f.call('/v1/documentos/sales_orders/cabecalho', 'POST', { command_id: randomUUID(), expected_version: 0, content: null })).status, 409, 'CAS on the version read');
  assert.equal((await f.call('/v1/documentos/sales_orders/cabecalho', 'POST', { command_id: randomUUID(), expected_version: 1, content: null }, f.users.vendas)).status, 403);
  assert.equal((await f.call('/v1/documentos/purchase_orders/cabecalho', 'GET', undefined, f.users.vendas)).status, 403, 'only readers of the kind');
  assert.equal((await f.call('/v1/documentos/sales_orders/cabecalho', 'POST', { command_id: randomUUID(), expected_version: 1, content: '<h1>x</h1>' })).status, 400);
  assert.equal((await f.call('/v1/documentos/sales_orders/cabecalho?x=1')).status, 400);
  const cleared = await f.call('/v1/documentos/sales_orders/cabecalho', 'POST', { command_id: randomUUID(), expected_version: 1, content: null });
  assert.deepEqual([cleared.status, cleared.value.version, cleared.value.content], [200, 2, null]);
  assert.deepEqual((await f.rows("select version,before_data is not null b,after_data is not null a from erp_documents.print_header_audit where kind='sales_orders' order by id")).map(r => [r.version, r.b, r.a]), [[1, false, true], [2, true, false]]);
  await assert.rejects(() => f.db.query("delete from erp_documents.print_header_audit"), /immutable/);
});
