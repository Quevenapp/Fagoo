// Synthetic data only. 202610200269: Origin "Salvar nova versão" of the proposta comercial (número-base 123, versões 123-2, 123-3),
// the previous version read-only, the version label in the reads and in the listagem. PGlite with every migration, the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f;
before(async () => { f = await documentsEFixture(); });
after(async () => f?.close());
// Origin/authority/readonly are response metadata, never editable document input.
const editable = doc => { const { id, kind, number, status, version, origin, authority, readonly, effect_flags, contact_snapshot, source_proposal_id, created_at, updated_at, totals, situation, seller_name, category_name, carrier_name,
  price_list_name, payment_account_name, payment_method_names, payment_account_names, proposal_version, ...data } = doc; return { ...data, items: data.items.map(({ position, gross, discount, total, product_snapshot, ...item }) => ({ ...item, id: null })),
  installments: data.installments.map(({ position, ...row }) => row) }; };
const read = async id => (await f.call(`/v1/documentos/sales_proposals/${id}`)).value.document;
const version = (doc, data = editable(doc), command = randomUUID(), user = f.users.admin) => f.call(`/v1/documentos/sales_proposals/${doc.id}/nova-versao`, 'POST', { command_id: command, expected_version: doc.version, data }, user);

test('privileges: the version RPC runs only for service_role; the internal helpers and the table are closed', async () => {
  const sig = 'public.erp_document_proposal_version(uuid,uuid,integer,uuid,jsonb)';
  const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
  assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']]);
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  for (const fn of ['erp_documents.proposal_superseded(uuid)', 'erp_documents.proposal_version_json(uuid)', 'erp_documents.document_view(uuid)', 'erp_documents.list_row(uuid,boolean,boolean)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, `${role} ${fn}`);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_table_privilege($1,'erp_documents.proposal_version','SELECT') v", [role]), false);
});

test('Salvar nova versão: a new proposta 123-2 from the form; the previous one is read-only; 123-3 from the latest; replay and CAS', async () => {
  const base = await f.create('sales_proposals', { notes: 'Primeira versão' });
  assert.equal((await read(base.id)).proposal_version, null, 'a proposta without versions');
  const command = randomUUID(), body = { ...editable(base), notes: 'Segunda versão' };
  const first = await version(base, body, command);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const v2 = first.value.document;
  assert.notEqual(v2.id, base.id); assert.equal(v2.notes, 'Segunda versão'); assert.equal(v2.status, base.status);
  assert.deepEqual([first.value.proposal_version.seq, first.value.proposal_version.label, first.value.proposal_version.superseded, first.value.source.id], [2, `${base.number}-2`, false, base.id]);
  // Replay: the same command answers the same version, nothing new.
  const again = await version(base, body, command);
  assert.deepEqual([again.status, again.value.document.id, again.value.replayed], [200, v2.id, true]);
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.proposal_version where base_id=$1', [base.id]), 1);
  // The previous version: read-only for the save, still with situações; it knows the latest one.
  const old = await read(base.id);
  assert.deepEqual([old.proposal_version.label, old.proposal_version.superseded, old.proposal_version.latest.id, old.proposal_version.latest.label], [base.number, true, v2.id, `${base.number}-2`]);
  const locked = await f.call(`/v1/documentos/sales_proposals/${base.id}`, 'PATCH', { command_id: randomUUID(), expected_version: old.version, data: { ...editable(old), notes: 'Alterada' } });
  assert.deepEqual([locked.status, locked.value.error?.code], [409, 'ERP_DOCUMENT_VERSION_LOCKED']);
  assert.equal((await version(old)).status, 409, 'a new version only from the latest one');
  assert.equal((await f.transition(old, 'pending')).status, 200, 'the situação of an older version still changes');
  // From the latest: 123-3; the stale version read is refused (CAS).
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${v2.id}/nova-versao`, 'POST', { command_id: randomUUID(), expected_version: v2.version + 5, data: editable(v2) })).status, 409);
  const third = await version(await read(v2.id));
  assert.equal(third.status, 200, JSON.stringify(third.value)); assert.equal(third.value.proposal_version.label, `${base.number}-3`);
  const second = await read(v2.id);
  assert.deepEqual([second.proposal_version.label, second.proposal_version.superseded, second.proposal_version.versions], [`${base.number}-2`, true, 3]);
  // The listagem shows the version label.
  const listed = (await f.call('/v1/documentos/sales_proposals?page=1&limit=100&status=open,draft,pending')).value.items;
  const labels = Object.fromEntries(listed.filter(row => [base.id, v2.id, third.value.document.id].includes(row.id)).map(row => [row.id, row.version_label]));
  assert.deepEqual(labels, { [base.id]: null, [v2.id]: `${base.number}-2`, [third.value.document.id]: `${base.number}-3` });
  // The audit keeps the version on the proposta of origin.
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.audit where document_id=$1 and action='proposal_version'", [base.id]), 1);
});

test('refusals: modelos have no versions; the version takes the automatic number; profiles and the seller scope', async () => {
  const model = await f.create('sales_proposals', { template: true, template_name: 'Modelo sintético' });
  assert.equal((await version(model)).status, 400);
  const plain = await f.create('sales_proposals');
  assert.equal((await version(plain, { ...editable(plain), number: '999' })).status, 400);
  assert.equal((await version(plain, { ...editable(plain), template: true })).status, 400);
  assert.equal((await version(plain, editable(plain), randomUUID(), f.users.consulta)).status, 403);
  assert.ok([404, 405].includes((await f.call(`/v1/documentos/sales_orders/${plain.id}/nova-versao`, 'POST', { command_id: randomUUID(), expected_version: 1, data: editable(plain) })).status), 'only propostas have versions');
  const sellerId = await f.seller(f.users.vendas, { allow: true, name: 'Vendedor versões' });
  const other = await f.catalog('contacts', { name: 'Cliente de outro vendedor 269' });
  const hidden = await f.create('sales_proposals', { contact_id: other.id });
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try { assert.equal((await version(hidden, editable(hidden), randomUUID(), f.users.vendas)).status, 404); }
  finally {
    await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false);
    await f.db.query('delete from erp_catalog.seller where id=$1', [sellerId]);
  }
  await assert.rejects(() => f.db.query('update erp_documents.proposal_version set version_seq=9'), /erp_document_version_immutable|permission/);
});
