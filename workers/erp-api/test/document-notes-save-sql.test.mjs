// Synthetic data only. 202610200290: Observações and Observações internas saved while the stock, contas or reservas of the document
// are active (Origin: everything else stays read-only). PGlite with every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f, warehouse;
before(async () => {
  f = await documentsEFixture();
  warehouse = await f.catalog('warehouses', { name: 'Depósito G290' });
  await f.rpc('erp_stock_post', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: '2026-10-20', p_reason: 'Entrada sintética G290',
    p_items: [{ product_id: f.product.id, warehouse_id: warehouse.id, quantity: '50', expected_version: 0 }] });
});
after(async () => f?.close());
const get = async doc => (await f.call(`/v1/documentos/${doc.kind}/${doc.id}`)).value.document;
const notes = (doc, body, user = f.users.admin, command = randomUUID()) => f.call(`/v1/documentos/${doc.kind}/${doc.id}/observacoes`, 'POST', { command_id: command, expected_version: doc.version, notes: null, internal_notes: null, ...body }, user);
const postStock = async doc => {
  const d = await get(doc);
  const p = (await f.rpc('erp_document_stock_preview', { p_user_id: f.users.estoque, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: d.version, p_occurred_on: '2026-10-20', p_reason: 'Baixa sintética G290' })).preview;
  await f.rpc('erp_document_stock_post', { p_user_id: f.users.estoque, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: d.version, p_command_id: randomUUID(), p_preview_hash: p.preview_hash,
    p_occurred_on: '2026-10-20', p_reason: 'Baixa sintética G290', p_ignored_item_ids: p.ignored.map(i => i.id) });
  return get(doc);
};

test('privileges: erp_document_notes_save runs only for service_role; the effects helper for nobody', async () => {
  const sig = 'public.erp_document_notes_save(uuid,text,uuid,integer,uuid,text,text)';
  const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
  assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']]);
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,'erp_documents.effects_active(uuid)','EXECUTE') v", [role]), false);
});

test('with posted stock the pedido saves only its observações (command, CAS, audit) and changes nothing else', async () => {
  let sale = await f.create('sales_orders', { warehouse_id: warehouse.id, notes: 'Antes', items: [f.line({ product_id: f.product.id, quantity: '2' })] });
  sale = (await f.transition(sale, 'verified')).value.document;
  sale = await postStock(sale);
  assert.equal(sale.effect_flags.stock_active, true);
  // The contract with the guards of the other lanes: only body->notes/internal_notes, version, updated_at and updated_by change.
  await f.db.exec(`create table public.g290_diff(changed text[]); create function public.g290_capture() returns trigger language plpgsql as $$ begin
    insert into public.g290_diff select array(select key from jsonb_each(to_jsonb(new)) n where n.value is distinct from to_jsonb(old)->n.key)
     ||array(select 'body.'||key from jsonb_each(new.body) b where b.value is distinct from old.body->b.key); return new; end $$;
    create trigger g290_capture before update on erp_documents.document for each row execute function public.g290_capture();`);
  const command = randomUUID();
  const saved = await notes(sale, { notes: 'Entregar na portaria', internal_notes: 'Cliente pediu nota\ncom CNPJ' }, f.users.admin, command);
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  await f.db.exec('drop trigger g290_capture on erp_documents.document; drop function public.g290_capture();');
  const changed = (await f.rows('select changed from public.g290_diff')).map(row => row.changed);
  assert.deepEqual(changed.map(list => [...list].sort()), [['body', 'body.internal_notes', 'body.notes', 'updated_at', 'updated_by', 'version']], 'the stock post left another updated_by');
  const doc = saved.value.document;
  assert.deepEqual([doc.notes, doc.internal_notes, doc.version, doc.totals.total, doc.items.length, doc.status], ['Entregar na portaria', 'Cliente pediu nota\ncom CNPJ', sale.version + 1, sale.totals.total, 1, 'verified']);
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.audit where document_id=$1 and action='notes'", [sale.id]), 1);
  // Conferir resultado and CAS.
  assert.equal((await notes(sale, { notes: 'Entregar na portaria', internal_notes: 'Cliente pediu nota\ncom CNPJ' }, f.users.admin, command)).value.replayed, true);
  assert.equal((await notes(sale, { notes: 'Outra' })).status, 409, 'the version read is old');
  // The full save of the pedido is still refused with stock (another field changes).
  const full = await f.call(`/v1/documentos/sales_orders/${sale.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version,
    data: f.data('sales_orders', { warehouse_id: warehouse.id, freight: '5', notes: doc.notes, items: doc.items.map(({ position, gross, discount, total, product_snapshot, ...item }) => item) }) });
  assert.equal(full.status, 409, JSON.stringify(full.value));
});

test('refusals: invalid body, profile without write, a document locked without effects and a contact out of the seller scope', async () => {
  const sale = await f.create('sales_orders', { items: [f.line()] });
  for (const bad of [{ notes: 'x'.repeat(4001) }, { notes: 'a\u0001b' }, { notes: 1 }, { extra: true }]) assert.equal((await notes(sale, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await notes(sale, { notes: 'x' }, f.users.consulta)).status, 403);
  const quote = await f.create('sales_proposals');
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${quote.id}/observacoes`, 'POST', { command_id: randomUUID(), expected_version: quote.version, notes: null, internal_notes: null })).status, 405, 'propostas have no effects');
  const cancelled = (await f.transition(sale, 'cancelled')).value.document;
  assert.equal((await notes(cancelled, { notes: 'x' })).status, 409, 'Cancelado without effects stays locked');
  // An editable document without effects saves its observações too.
  const open = await f.create('purchase_orders', { notes: null });
  const ok = await notes(open, { notes: 'Conferir na entrega' });
  assert.deepEqual([ok.status, ok.value.document?.notes], [200, 'Conferir na entrega']);
  // Contato acessível somente ao vendedor vinculado: the document of another contact is not found.
  const seller = await f.seller(f.users.vendas2, { name: 'Vendedor G290' });
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try {
    const own = await f.create('sales_orders', { items: [f.line()] }, f.users.admin);
    assert.equal((await notes(own, { notes: 'x' }, f.users.vendas2)).status, 404);
  } finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); void seller; }
});
