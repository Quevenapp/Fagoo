import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { preferencesFixture } from './helpers/preferences-fixture.mjs';
import { fiscalInvoicesRoute, parseFiscalInvoicesRoute, executeFiscalInvoicesRoute } from '../src/fiscal-invoices.mjs';
import { nfeXml } from './helpers/fiscal-import-xml.mjs';
import { WAVE_D_BASE, WAVE_D_LANE } from './helpers/fiscal-lane.mjs';

// 217 through the real Worker parser and contract on PGlite: the entry note XML links items by the supplier code of the product
// cadastro, creates the free items as products ("Cadastrar automaticamente produtos a partir de compras") and updates NCM, GTIN
// and the supplier description of linked products ("Automatização de atualização de dados"). Synthetic XMLs and parties only.
let f, supplier, byGtin, bySupplierCode;
const call = async (path, { method = 'GET', body, user = f.users.admin } = {}) => {
  const url = new URL(`https://api.example.test/v1/notas-fiscais${path}`);
  const request = new Request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return executeFiscalInvoicesRoute(await parseFiscalInvoicesRoute(request, fiscalInvoicesRoute(url.pathname)), { userId: user, rpc: (name, args) => f.rpc(name, args) });
};
const importXml = (xml, user) => call('/importar', { method: 'POST', body: { command_id: randomUUID(), xml }, user });
const catalog = async (entity, data) => (await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
const savePrefs = async (page, changes) => {
  const current = await f.rpc('erp_preferences_page', { p_user_id: f.users.admin, p_page: page });
  return f.rpc('erp_preferences_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: page, p_changes: Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(i => i.key === key).version, value })) });
};
const product = async id => (await f.db.query('select r.name,r.code,r.version,p.ncm,p.gtin,p.unit from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=$1', [id])).rows[0];
const suppliers = async id => (await f.db.query('select supplier_id,code,description,cost_price::text cost,is_default from erp_catalog.product_supplier where record_id=$1 order by position', [id])).rows;

before(async () => {
  const base = await preferencesFixture({ lane: [...WAVE_D_BASE, ...WAVE_D_LANE] });
  f = { ...base, scalar: async (text, args = []) => (await base.db.query(text, args)).rows[0]?.value };
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: 'SP', cnpj: '11.222.333/0001-81' }), f.users.admin]);
  supplier = await catalog('contacts', { name: 'Fornecedor sintético S.A.', person_type: 'J', document: '12.345.678/0001-95' });
  byGtin = await catalog('products', { name: 'Parafuso do cadastro', code: 'PAR-1', unit: 'UN', kind: 'P', format: 'S', price: '3', gtin: '7891234567895', ncm: '73181600' });
  bySupplierCode = await catalog('products', { name: 'Arruela do cadastro', code: 'ARR-1', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  await f.db.query("insert into erp_catalog.product_supplier(record_id,position,supplier_id,code,description,is_default) values($1,1,$2,'FORN-ARR','Arruela antiga',true)", [bySupplierCode.id, supplier.id]);
});
after(() => f?.close());

test('217 entry points stay SECURITY DEFINER for service_role only and the helpers stay private', async () => {
  assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_fiscal_invoice_import(uuid,uuid,jsonb)','EXECUTE') value"), true);
  for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_fiscal_invoice_import(uuid,uuid,jsonb)','EXECUTE') value`), false);
  for (const helper of ['erp_fiscal_invoices.supplier_product(uuid,text)', 'erp_fiscal_invoices.import_new_product(uuid,uuid,jsonb,uuid)', 'erp_fiscal_invoices.import_update_product(uuid,uuid,jsonb,uuid,jsonb)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
});

test('217 without the preferences: GTIN and supplier code link the items, nothing is created or updated', async () => {
  const { xml } = nfeXml({ number: 501, items: [{ code: 'FORN-77', name: 'Parafuso sintético', quantity: '10.0000', price: '2.5000', ean: '7891234567895' },
    { code: 'FORN-ARR', name: 'Arruela sintética', quantity: '4.0000', price: '0.7500' }, { code: 'FORN-NOVO', name: 'Porca sintética', quantity: '2.0000', price: '1.0000' }] });
  const before = await product(byGtin.id);
  const out = await importXml(xml);
  assert.equal(out.matched_items, 2); assert.deepEqual([out.created_products, out.updated_products, out.product_failures], [0, 0, 0]);
  assert.deepEqual(out.invoice.items.map(i => i.product_id ?? null), [byGtin.id, bySupplierCode.id, null], 'the code of the product at this supplier links the second item');
  assert.deepEqual(await product(byGtin.id), before, 'the cadastro does not change without "Automatização de atualização de dados"');
});

test('217 "Cadastrar automaticamente produtos a partir de compras" and "Automatização de atualização de dados" (NCM, GTIN, Descrição do fornecedor)', async () => {
  await savePrefs('cadastros-produtos', { 'produtos.cadastro_auto_compras': true });
  await savePrefs('notas-nfe', { 'nfe.atualizar_ncm': true, 'nfe.atualizar_descricao_fornecedor': true });
  const { xml } = nfeXml({ number: 502, items: [{ code: 'FORN-77', name: 'Parafuso sintético novo', quantity: '10.0000', price: '2.5000', ean: '7891234567895' },
    { code: 'FORN-NOVO-2', name: 'Porca sintética', quantity: '2.0000', price: '1.2500', ean: '7891234567802' }, { code: 'PAR-1', name: 'Código já usado', quantity: '1.0000', price: '1.0000' }] });
  const fiscal = await importXml(nfeXml({ number: 503, items: [{ code: 'FORN-NOVO-3', name: 'Item do fiscal', quantity: '1.0000', price: '1.0000' }] }).xml, f.users.fiscal);
  assert.deepEqual([fiscal.matched_items, fiscal.created_products], [0, 0], 'the fiscal profile does not write the product cadastro');
  const version = (await product(byGtin.id)).version;
  const out = await importXml(xml);
  assert.deepEqual([out.matched_items, out.created_products, out.updated_products, out.product_failures], [3, 2, 1, 0]);
  const [linked, created, freeCode] = out.invoice.items.map(i => i.product_id);
  assert.equal(linked, byGtin.id);
  const updated = await product(byGtin.id);
  assert.equal(updated.ncm, '73181500', 'NCM of the XML'); assert.equal(updated.version, version + 1);
  assert.deepEqual((await suppliers(byGtin.id)).map(s => [s.supplier_id, s.code, s.description]), [[supplier.id, 'FORN-77', 'Parafuso sintético novo']], 'the supplier row joins with the description of the XML');
  const fresh = await product(created);
  assert.deepEqual([fresh.name, fresh.code, fresh.unit, fresh.ncm, fresh.gtin], ['Porca sintética', 'FORN-NOVO-2', 'UN', '73181500', '7891234567802']);
  assert.deepEqual((await suppliers(created)).map(s => [s.supplier_id, s.code, s.description, s.cost, s.is_default]), [[supplier.id, 'FORN-NOVO-2', 'Porca sintética', '1.2500', true]]);
  assert.equal((await product(freeCode)).code, null, 'a code already used in the cadastro is not reused');
  const audit = await f.scalar("select count(*)::int value from erp_catalog.audit where record_id=any($1::uuid[]) and actor=$2", [[created, freeCode, byGtin.id], f.users.admin]);
  assert.ok(audit >= 3, 'every write goes through the audited catalog save');
  // A second import of the same supplier codes links them instead of creating again.
  const again = await importXml(nfeXml({ number: 504, items: [{ code: 'FORN-NOVO-2', name: 'Porca sintética', quantity: '1.0000', price: '1.2500' }] }).xml);
  assert.deepEqual([again.matched_items, again.created_products], [1, 0]); assert.equal(again.invoice.items[0].product_id, created);
});

test('217 a product the cadastro refuses never blocks the note: the note imports and the refusal is counted', async () => {
  await savePrefs('notas-nfe', { 'nfe.atualizar_gtin': true });
  // A product in the Excluídos of the cadastro refuses any save (erp_catalog_product_deleted); the note still imports linked to it.
  const version = (await product(bySupplierCode.id)).version;
  await f.db.query("insert into erp_catalog.product_detail(record_id,deleted_at,deleted_by) values($1,now(),$2) on conflict(record_id) do update set deleted_at=now(),deleted_by=$2", [bySupplierCode.id, f.users.admin]);
  const out = await importXml(nfeXml({ number: 505, items: [{ code: 'FORN-ARR', name: 'Arruela sintética', quantity: '1.0000', price: '1.0000', ean: '7891234567819' }] }).xml);
  assert.equal(out.imported, true); assert.equal(out.invoice.items[0].product_id, bySupplierCode.id);
  assert.deepEqual([out.updated_products, out.product_failures], [0, 1]);
  assert.equal((await product(bySupplierCode.id)).version, version, 'nothing of the refused save stays');
});
