import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { preferencesFixture } from './helpers/preferences-fixture.mjs';
import { WAVE_D_BASE, WAVE_D_LANE } from './helpers/fiscal-lane.mjs';
import { invoiceRecord, listPage, natureRecord } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { contactSourceRecord, estimateTaxes, orderSourceRecord } from '../../../packages/erp-domain/src/fiscal-invoice-order.mjs';

// Wave D of the notas lane on PGlite (published chain + this lane + the product registry of 119 and the contact profile and sellers
// of 124), synthetic data only. 215: one note per pedido on save and link, the Vendedor of the note and its list filter, Destino da
// Operação, the pedido source v2 (vendedor, transportador, parcels rule) and the contact picked in the note form. 216: rules by
// "Grupo de Produtos". Nothing emits, transmits or posts effects.
const code = expected => error => error.code === expected;
const message = (expected, errcode = '22023') => error => error.code === errcode && error.message === expected;
let f, product, contact, carrier, sellerContact, seller, warehouse, saleNature, buyNature, otherNature;
const catalog = async (entity, data, user) => (await f.rpc('erp_catalog_save', { p_user_id: user ?? f.users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
const order = async (kind, body = {}) => (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-10', contact_id: contact.id, warehouse_id: warehouse.id,
  items: [{ product_id: product.id, description: 'Peça sintética 215', unit: 'UN', quantity: '2', unit_price: '10' }], ...body } })).document;
const invoice = (over = {}) => ({ model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: saleNature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
  recipient: { contact_id: contact.id, name: 'Cliente sintético 215', person_type: 'J', document: '12345678000190', state: 'MG' }, items: [{ product_id: product.id, description: 'Peça sintética 215', quantity: '2', unit_price: '10' }], ...over });
const execute = (action, data, user = f.users.fiscal, command = randomUUID()) => f.rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const link = (data, user = f.users.fiscal) => f.rpc('erp_fiscal_invoice_link', { p_user_id: user, p_command_id: randomUUID(), p_data: data });
const savePrefs = async (page, changes) => {
  const current = await f.rpc('erp_preferences_page', { p_user_id: f.users.admin, p_page: page });
  return f.rpc('erp_preferences_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: page, p_changes: Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(i => i.key === key).version, value })) });
};

before(async () => {
  const base = await preferencesFixture({ lane: [...WAVE_D_BASE, ...WAVE_D_LANE] });
  f = { ...base, scalar: async (text, args = []) => (await base.db.query(text, args)).rows[0]?.value };
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: 'SP', cnpj: '11.222.333/0001-81' }), f.users.admin]);
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [f.users.admin]);
  product = await catalog('products', { name: 'Peça sintética 215', code: 'P-215', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '84714900' });
  contact = await catalog('contacts', { name: 'Cliente sintético 215', person_type: 'J', document: '12345678000190', ie: '123456789', state: 'MG', city: 'Belo Horizonte', postal_code: '30110000', street: 'Rua Sintética', number: '10' });
  carrier = await catalog('contacts', { name: 'Transportadora sintética 215', person_type: 'J', document: '22333444000155', ie: '987654321', state: 'SP', city: 'Campinas', street: 'Av. das Cargas', number: '500', district: 'Distrito Sintético' });
  sellerContact = await catalog('contacts', { name: 'Vendedora sintética 215', person_type: 'F', document: '12345678909' });
  seller = (await f.db.query('insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id', [sellerContact.id, f.users.admin])).rows[0].id;
  warehouse = await catalog('warehouses', { name: 'Depósito 215' });
  const nature = async data => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  saleNature = await nature({ description: 'Venda 215', direction: '1', crt: '1' }); buyNature = await nature({ description: 'Compra 215', direction: '0', crt: '1', presence: '9' });
  otherNature = await nature({ description: 'Venda do contato 215', direction: '1', crt: '1' });
  await f.db.query("insert into erp_catalog.contact_profile(record_id,taxpayer,nfe_email,operation_nature_id,seller_id) values($1,'1','nfe@sintetico.test',$2,$3)", [contact.id, otherNature.id, seller]);
});
after(() => f?.close());

test('215 entry points are SECURITY DEFINER for service_role only, helpers stay private and replaced bodies were hash-checked', async () => {
  for (const signature of ['public.erp_fiscal_invoice_order_source_v2(uuid,uuid,text)', 'public.erp_fiscal_invoice_contact_source(uuid,uuid,text)', 'public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb)',
    'public.erp_fiscal_invoice_link(uuid,uuid,jsonb)', 'public.erp_fiscal_invoice_context(uuid,text)',
    'public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false, `${role} ${signature}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true, signature);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
    assert.equal(await f.scalar("select proconfig::text value from pg_proc where oid=$1::regprocedure", [signature]), '{search_path=pg_catalog}');
  }
  for (const helper of ['erp_fiscal_invoices.require_single_invoice(uuid,text,jsonb)', 'erp_fiscal_invoices.order_source_v2(uuid,text)', 'erp_fiscal_invoices.contact_snapshot(uuid)',
    'erp_fiscal_invoices.seller_ref(uuid)', 'erp_fiscal_invoices.origin_seller_ids(uuid)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
  assert.equal(await f.scalar("select to_regprocedure('public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text)') is null value"), true,
    'the list keeps one signature (the previous Worker calls it without p_seller_id)');
  // The guard refuses to replace a body that is not the published one.
  const guard = (await import('node:fs/promises')).readFile(new URL('../../../supabase/migrations/202610200215_fiscal_invoice_seller_order_integrity.sql', import.meta.url), 'utf8');
  const block = (await guard).replace(/\r\n/g, '\n').match(/do \$\$declare v record;begin[\s\S]*?end\$\$;/)[0];
  await assert.rejects(() => f.db.exec(block), error => error.message === 'fiscal_invoice_215_previous_definition_changed');
});

test('215 one note per pedido: a second note of the same pedido de venda is refused on save and on link; deleting the first frees it', async () => {
  const sale = await order('sales_orders');
  const first = (await execute('create', { invoice: invoice(), orders: [sale.id] })).invoice;
  assert.deepEqual(first.orders.map(o => o.id), [sale.id]);
  await assert.rejects(() => execute('create', { invoice: invoice(), orders: [sale.id] }), message('erp_fiscal_invoice_order_has_invoice', '40001'), 'two tabs of "Gerar nota fiscal" do not save two notes');
  // The note that already carries the pedido keeps saving.
  const updated = (await execute('update', { id: first.id, expected_version: 1, invoice: invoice({ additional_info: 'Atualizada' }), orders: [sale.id] })).invoice;
  assert.equal(updated.version, 2);
  const free = (await execute('create', { invoice: invoice() })).invoice;
  await assert.rejects(() => execute('update', { id: free.id, expected_version: 1, invoice: invoice(), orders: [sale.id] }), message('erp_fiscal_invoice_order_has_invoice', '40001'));
  await assert.rejects(() => link({ invoice_id: free.id, expected_version: 1, action: 'link', document_id: sale.id }), message('erp_fiscal_invoice_order_has_invoice', '40001'));
  await execute('delete', { id: first.id, expected_version: 2, reason: 'Teste sintético' });
  const linked = await link({ invoice_id: free.id, expected_version: 1, action: 'link', document_id: sale.id });
  assert.deepEqual(linked.invoice.orders.map(o => o.id), [sale.id]);
  const source = orderSourceRecord(await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: sale.id, p_model: '55' }));
  assert.ok(source.reasons.some(r => r.code === 'has_invoice'), 'the source and the save agree');
});

test('215 one note per pedido: ordens de serviço too, while pedidos de compra keep several entry notes (Vinculação Parcial)', async () => {
  const os = await order('service_orders');
  await execute('create', { invoice: invoice(), orders: [os.id] }, f.users.admin);
  await assert.rejects(() => execute('create', { invoice: invoice(), orders: [os.id] }, f.users.admin), message('erp_fiscal_invoice_order_has_invoice', '40001'));
  const purchase = await order('purchase_orders');
  const entry = { direction: '0', issue_type: 'T', number: '77', nature_id: buyNature.id, presence: '9' };
  await execute('create', { invoice: invoice(entry), orders: [purchase.id] });
  const second = (await execute('create', { invoice: invoice({ ...entry, number: '78' }), orders: [purchase.id] })).invoice;
  assert.deepEqual(second.orders.map(o => o.id), [purchase.id]);
});

test('215 Vendedor: stored with its name, kept by an older form, refused when its contact is inactive, and filtered in the list', async () => {
  const created = (await execute('create', { invoice: invoice({ seller_id: seller }) })).invoice;
  const record = invoiceRecord(created);
  assert.equal(record.seller_id, seller); assert.equal(record.seller_name, 'Vendedora sintética 215');
  // An update without the key (form before 215) keeps the seller.
  const kept = (await execute('update', { id: created.id, expected_version: 1, invoice: invoice() })).invoice;
  assert.equal(kept.seller_id, seller);
  const cleared = (await execute('update', { id: created.id, expected_version: 2, invoice: invoice({ seller_id: null }) })).invoice;
  assert.equal(cleared.seller_id, null); assert.equal(cleared.seller_name, null); assert.doesNotThrow(() => invoiceRecord(cleared));
  await assert.rejects(() => execute('create', { invoice: invoice({ seller_id: randomUUID() }) }), message('erp_fiscal_invoice_seller_unavailable'));
  const otherContact = await catalog('contacts', { name: 'Vendedor inativo 215', person_type: 'F', document: '98765432100' });
  const inactive = (await f.db.query('insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id', [otherContact.id, f.users.admin])).rows[0].id;
  await f.db.query('update erp_catalog.record set active=false where id=$1', [otherContact.id]);
  await assert.rejects(() => execute('create', { invoice: invoice({ seller_id: inactive }) }), message('erp_fiscal_invoice_seller_unavailable'));
  const again = (await execute('create', { invoice: invoice({ seller_id: seller, additional_info: 'Filtro vendedor' }) })).invoice;
  const args = { origin: 'brufap', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc' };
  const page = listPage(await f.rpc('erp_fiscal_invoice_list', { p_user_id: f.users.fiscal, p_origin: 'brufap', p_model: '55', p_direction: '1', p_seller_id: seller }), args);
  assert.deepEqual(page.items.map(r => r.id), [again.id]);
  const all = await f.rpc('erp_fiscal_invoice_list', { p_user_id: f.users.fiscal, p_origin: 'brufap', p_model: '55', p_direction: '1' });
  assert.ok(all.total_count > 1, 'without the filter every note is listed');
});

test('215 Vendedor filter on Origin notes: the Origin vendedor linked to the contact of the Brufap seller', async () => {
  await f.db.query("insert into origin_sync.resource_state(resource) values('fiscal_wave_d_test') on conflict do nothing");
  const seed = (entity, id, payload) => f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'fiscal_wave_d_test',$2,$3::jsonb,$4)", [entity, id, JSON.stringify(payload), 'b'.repeat(64)]);
  await seed('sellers', '700', { id: 700, contato: { id: '7001' } });
  await seed('contacts', '7001', { id: 7001, nome: 'Vendedora sintética 215' });
  await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts' and source_id='7001'");
  await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) select entity,source_id,$1,version_hash,version_hash,'synced' from origin_sync.raw_record where entity='contacts' and source_id='7001'", [sellerContact.id]);
  await seed('nfe', '9701', { tipo: 1, numero: 701, serie: 1, dataEmissao: '2026-10-15 10:00:00', situacao: 5, valorNota: 10, contato: { nome: 'Cliente Origin A' }, vendedor: { id: 700 } });
  await seed('nfe', '9702', { tipo: 1, numero: 702, serie: 1, dataEmissao: '2026-10-15 11:00:00', situacao: 5, valorNota: 20, contato: { nome: 'Cliente Origin B' }, vendedor: { id: 799 } });
  const page = await f.rpc('erp_fiscal_invoice_list', { p_user_id: f.users.consulta, p_origin: 'origin', p_model: '55', p_direction: '1', p_seller_id: seller });
  assert.deepEqual(page.items.map(r => r.id), ['9701']);
  const none = await f.rpc('erp_fiscal_invoice_list', { p_user_id: f.users.consulta, p_origin: 'origin', p_model: '55', p_direction: '1', p_seller_id: randomUUID() });
  assert.equal(none.total_count, 0);
});

test('215 Destino da Operação: 1 or 2 for a Brazilian recipient, 3 only for a foreign one, 1 on the NFC-e; an older form keeps it', async () => {
  const ok = (await execute('create', { invoice: invoice({ operation_destination: '1' }) })).invoice;
  assert.equal(ok.operation_destination, '1'); assert.equal(invoiceRecord(ok).operation_destination, '1');
  await assert.rejects(() => execute('create', { invoice: invoice({ operation_destination: '3' }) }), message('erp_fiscal_invoice_destination_invalid'));
  await assert.rejects(() => execute('create', { invoice: invoice({ operation_destination: '4' }) }), message('erp_fiscal_invoice_destination_invalid'));
  // Review fix: a Brazilian recipient without UF is not foreign (the null comparison used to let 3 through).
  await assert.rejects(() => execute('create', { invoice: invoice({ recipient: { name: 'Cliente sem UF', person_type: 'J', document: '12345678000190' }, operation_destination: '3' }) }),
    message('erp_fiscal_invoice_destination_invalid'));
  const foreign = { recipient: { name: 'Cliente estrangeiro', person_type: 'E', state: 'EX' } };
  await assert.rejects(() => execute('create', { invoice: invoice({ ...foreign, operation_destination: '2' }) }), message('erp_fiscal_invoice_destination_invalid'));
  assert.equal((await execute('create', { invoice: invoice({ ...foreign, operation_destination: '3' }) })).invoice.operation_destination, '3');
  const kept = (await execute('update', { id: ok.id, expected_version: 1, invoice: invoice() })).invoice;
  assert.equal(kept.operation_destination, '1', 'absent key keeps the stored value');
  const nfce = { model: '65', issue_type: 'C', final_consumer: true, recipient: {} };
  await assert.rejects(() => execute('create', { invoice: invoice({ ...nfce, operation_destination: '2' }) }), message('erp_fiscal_invoice_destination_invalid'));
});

test('215 pedido source v2: vendedor, transportador of the cadastro and "Considerar a data da venda nas parcelas"', async () => {
  const sale = await order('sales_orders', { installments: [{ due_date: '2026-11-09', amount: '20.00', method: 'Boleto' }] });
  // seller_id (164) and carrier_id (168) of the documentos lane, published; written here directly to keep this fixture small.
  await f.db.query("update erp_documents.document set body=body||jsonb_build_object('seller_id',$1::text,'carrier_id',$2::text) where id=$3", [seller, carrier.id, sale.id]);
  const raw = await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: sale.id, p_model: '55' });
  const s = orderSourceRecord(raw);
  assert.deepEqual(s.seller, { id: seller, name: 'Vendedora sintética 215' });
  assert.deepEqual({ ...s.carrier }, { contact_id: carrier.id, name: 'Transportadora sintética 215', active: true, person_type: 'J', document: '22333444000155', ie: '987654321', postal_code: null,
    street: 'Av. das Cargas', number: '500', complement: null, district: 'Distrito Sintético', city: 'Campinas', state: 'SP' });
  assert.equal(s.keep_order_dates, false, 'Origin default: the parcels move with the note date');
  await savePrefs('notas-nfe', { 'nfe.data_venda_parcelas': true });
  assert.equal(orderSourceRecord(await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: sale.id, p_model: '55' })).keep_order_dates, true);
  const os = await order('service_orders');
  assert.equal(orderSourceRecord(await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.admin, p_document_id: os.id, p_model: '55' })).keep_order_dates, false, 'the OS follows its own preference');
  const purchase = await order('purchase_orders');
  assert.equal(orderSourceRecord(await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: purchase.id, p_model: '55' })).keep_order_dates, true);
  // Same access rules as 176; the previous source is untouched for the previous Worker.
  for (const user of [f.users.consulta, f.users.vendas]) await assert.rejects(() => f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: user, p_document_id: sale.id, p_model: '55' }), code('42501'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: os.id, p_model: '55' }), code('42501'));
  const v1 = await f.rpc('erp_fiscal_invoice_order_source', { p_user_id: f.users.fiscal, p_document_id: sale.id, p_model: '55' });
  assert.equal(Object.hasOwn(v1, 'seller'), false); assert.equal(orderSourceRecord(v1).keep_order_dates, true, 'the wave C projection still validates');
});

test('215 contact source: Contribuinte, e-mail da NF-e, natureza padrão of the direction and vendedor of the contact', async () => {
  const value = contactSourceRecord(await f.rpc('erp_fiscal_invoice_contact_source', { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_direction: '1' }), contact.id);
  assert.equal(value.contact.taxpayer, '1'); assert.equal(value.contact.nfe_email, 'nfe@sintetico.test'); assert.equal(value.contact.ie, '123456789');
  assert.deepEqual(value.nature, { id: otherNature.id, description: 'Venda do contato 215', crt: '1' });
  assert.deepEqual(value.seller, { id: seller, name: 'Vendedora sintética 215' });
  const entry = contactSourceRecord(await f.rpc('erp_fiscal_invoice_contact_source', { p_user_id: f.users.admin, p_contact_id: contact.id, p_direction: '0' }));
  assert.equal(entry.nature, null, 'a sale nature never fills an entry note');
  const plain = contactSourceRecord(await f.rpc('erp_fiscal_invoice_contact_source', { p_user_id: f.users.admin, p_contact_id: carrier.id, p_direction: '1' }));
  assert.equal(plain.contact.taxpayer, null); assert.equal(plain.seller, null); assert.equal(plain.contact.street, 'Av. das Cargas');
  for (const user of [f.users.consulta, f.users.vendas, f.users.financeiro]) await assert.rejects(() => f.rpc('erp_fiscal_invoice_contact_source', { p_user_id: user, p_contact_id: contact.id, p_direction: '1' }), code('42501'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_contact_source', { p_user_id: f.users.fiscal, p_contact_id: randomUUID(), p_direction: '1' }), code('P0002'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_contact_source', { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_direction: '2' }), code('22023'));
});

test('215 context: Destino da Operação manual (NF-e only) and the open contas panels follow the preferences', async () => {
  let context = await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' });
  assert.equal(context.operation_destination_manual, false); assert.deepEqual(context.open_titles, { receivable: false, payable: false });
  await savePrefs('notas-nfe', { 'nfe.destino_manual': true });
  await savePrefs('vendas-vendas', { 'vendas.ver_contas_receber': true });
  context = await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' });
  assert.equal(context.operation_destination_manual, true); assert.deepEqual(context.open_titles, { receivable: true, payable: false });
  assert.equal((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '65' })).operation_destination_manual, false, 'the NFC-e is always interna');
});

const group = async name => (await f.db.query("insert into erp_catalog.taxonomy(kind,name,created_by,updated_by) values('product_groups',$1,$2,$2) returning id", [name, f.users.admin])).rows[0].id;
const natureExecute = (action, data, user = f.users.fiscal) => f.rpc('erp_fiscal_nature_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: action, p_data: data });
const groupRule = (groupIds, data = { situation: '50', rate: '7' }) => ({ tax: 'ipi', destinations: [], product_scope: 'groups', ncms: [], product_ids: [], group_ids: groupIds, data });

test('216 "Grupo de Produtos": the rule keeps its groups with names, other rules come back as before, and Clonar Operação copies them', async () => {
  const tools = await group('Ferramentas 216'), parts = await group('Peças 216');
  const created = (await natureExecute('create', { nature: { description: 'Venda por grupo 216', direction: '1', crt: '1',
    rules: [groupRule([tools, parts]), { tax: 'ipi', destinations: [], product_scope: 'any', ncms: [], product_ids: [], data: { situation: '50', rate: '1' } }] } })).nature;
  const record = natureRecord(created);
  const [byGroup, any] = record.rules;
  assert.deepEqual(byGroup.group_ids, [tools, parts].sort()); assert.deepEqual(byGroup.groups.map(g => g.name).sort(), ['Ferramentas 216', 'Peças 216']);
  assert.equal(Object.hasOwn(created.rules[1], 'group_ids'), false, 'a rule without groups keeps the 111 shape'); assert.equal(any.product_scope, 'any');
  const clone = natureRecord((await natureExecute('clone', { id: created.id, expected_version: 1 })).nature);
  assert.deepEqual(clone.rules[0].group_ids, byGroup.group_ids);
  await assert.rejects(() => natureExecute('create', { nature: { description: 'Grupo inválido', direction: '1', crt: '1', rules: [groupRule([randomUUID()])] } }), message('erp_fiscal_rule_group_invalid'));
  await assert.rejects(() => natureExecute('create', { nature: { description: 'Grupo vazio', direction: '1', crt: '1', rules: [groupRule([])] } }), message('erp_fiscal_rule_product_invalid'));
  await assert.rejects(() => natureExecute('create', { nature: { description: 'Grupo e NCM', direction: '1', crt: '1', rules: [{ ...groupRule([tools]), ncms: ['84'] }] } }), message('erp_fiscal_rule_product_invalid'));
  await assert.rejects(() => natureExecute('create', { nature: { description: 'Grupo em regra de produto', direction: '1', crt: '1', rules: [{ ...groupRule([tools]), product_scope: 'products', product_ids: [product.id] }] } }), message('erp_fiscal_rule_product_invalid'));
  await assert.rejects(() => f.db.query("insert into erp_fiscal_invoices.nature_rule(nature_id,tax,position,destinations,product_scope,data) values($1,'pis',1,'{}','groups',$2::jsonb)", [created.id, JSON.stringify({ situation: '01' })]),
    error => /nature_rule_scope/.test(error.message), 'the table refuses a groups rule without groups');
});

test('216 product groups of the items and the estimate context v2 feed the same engine rule', async () => {
  const group216 = await group('Grupo da estimativa 216');
  if (Number(await f.scalar('select count(*) value from erp_catalog.product_detail where record_id=$1', [product.id]))) await f.db.query('update erp_catalog.product_detail set product_group_id=$1 where record_id=$2', [group216, product.id]);
  else await f.db.query('insert into erp_catalog.product_detail(record_id,product_group_id) values($1,$2)', [product.id, group216]);
  const plain = await catalog('products', { name: 'Sem grupo 216', code: 'P-216-2', unit: 'UN', kind: 'P', format: 'S', price: '5' });
  const groups = await f.rpc('erp_fiscal_invoice_product_groups', { p_user_id: f.users.fiscal, p_product_ids: [product.id, plain.id, product.id] });
  assert.deepEqual(groups.items.map(i => [i.id, i.group_id]).sort(), [[product.id, group216], [plain.id, null]].sort());
  for (const user of [f.users.consulta, f.users.vendas]) await assert.rejects(() => f.rpc('erp_fiscal_invoice_product_groups', { p_user_id: user, p_product_ids: [product.id] }), code('42501'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_product_groups', { p_user_id: f.users.fiscal, p_product_ids: [] }), code('22023'));
  const nature = (await natureExecute('create', { nature: { description: 'IPI por grupo 216', direction: '1', crt: '1', rules: [groupRule([group216], { situation: '50', rate: '10' })] } }, f.users.admin)).nature;
  await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'set_default', p_data: { id: nature.id, expected_version: 1, code: 'S' } });
  await f.db.query('update erp_catalog.contact_profile set operation_nature_id=null where record_id=$1', [contact.id]);
  const context = await f.rpc('erp_fiscal_tax_estimate_context_v2', { p_user_id: f.users.vendas, p_kind: 'sales_orders', p_contact_id: contact.id, p_product_ids: [product.id, plain.id] });
  assert.deepEqual(context.products.map(p => [p.id, p.group_id]).sort(), [[product.id, group216], [plain.id, null]].sort());
  const request = { kind: 'sales_orders', contact_id: contact.id, items: [{ product_id: product.id, quantity: '1', unit_price: '100' }, { product_id: plain.id, quantity: '1', unit_price: '100' }], discount: '0.00', freight: '0.00', other_expenses: '0.00' };
  const estimate = estimateTaxes(context, request, '2026-10-20');
  assert.deepEqual(estimate.items.map(i => i.ipi), ['10.00', '0.00'], 'the group rule applies only to the product of the group');
  const v1 = await f.rpc('erp_fiscal_tax_estimate_context', { p_user_id: f.users.vendas, p_kind: 'sales_orders', p_contact_id: contact.id, p_product_ids: [product.id] });
  assert.equal(Object.hasOwn(v1.products[0], 'group_id'), false, 'the previous context is untouched for the previous Worker');
});


test('218 "Histórico do produto para o cliente": Origin notes of the linked contact by product code and Brufap notes, newest first, 20 at most', async () => {
  await f.db.query("insert into origin_sync.resource_state(resource) values('fiscal_wave_d_test') on conflict do nothing");
  const seed = (entity, id, payload) => f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'fiscal_wave_d_test',$2,$3::jsonb,$4)", [entity, id, JSON.stringify(payload), 'c'.repeat(64)]);
  await seed('contacts', '8001', { id: 8001, nome: 'Cliente sintético 215' });
  await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts' and source_id='8001'");
  await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) select entity,source_id,$1,version_hash,version_hash,'synced' from origin_sync.raw_record where entity='contacts' and source_id='8001'", [contact.id]);
  await seed('nfe', '9801', { tipo: 1, numero: '000801', serie: 1, dataEmissao: '2030-01-05 10:00:00', situacao: 5, valorNota: 30, contato: { id: 8001, nome: 'Cliente sintético 215' },
    itens: [{ codigo: 'P-215', descricao: 'Peça sintética 215', quantidade: 3, valor: 10, valorTotal: 30 }, { codigo: 'OUTRO', descricao: 'Outro', quantidade: 1, valor: 1, valorTotal: 1 }] });
  await seed('nfe', '9802', { tipo: 0, numero: 802, serie: 1, dataEmissao: '2030-01-06 10:00:00', situacao: 5, contato: { id: 8001 }, itens: [{ codigo: 'P-215', quantidade: 1, valor: 9, valorTotal: 9 }] });
  await seed('nfe', '9803', { tipo: 1, numero: 803, serie: 1, dataEmissao: '2030-01-07 10:00:00', situacao: 5, contato: { id: 9999 }, itens: [{ codigo: 'P-215', quantidade: 1, valor: 9, valorTotal: 9 }] });
  await execute('create', { invoice: invoice({ additional_info: 'Histórico 218' }) });
  const history = await f.rpc('erp_fiscal_invoice_item_history', { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_product_id: product.id, p_direction: '1' });
  assert.ok(history.items.length > 1 && history.items.length <= 20);
  assert.deepEqual(history.items[0], { origin: 'origin', id: '9801', number: 801, series: 1, issue_date: '2030-01-05', issue_type: null, quantity: '3', unit_price: '10', total: '30.00' }, 'only the exit note of the linked contact with the product code');
  assert.ok(history.items.slice(1).every(i => i.origin === 'brufap' && i.quantity === '2.0000' && i.total === '20.00'), 'the Brufap notes of the contact with the product');
  assert.deepEqual([...history.items].map(i => i.issue_date ?? ''), [...history.items].map(i => i.issue_date ?? '').sort().reverse(), 'newest first');
  const entry = await f.rpc('erp_fiscal_invoice_item_history', { p_user_id: f.users.admin, p_contact_id: contact.id, p_product_id: product.id, p_direction: '0' });
  assert.ok(entry.items.some(i => i.origin === 'origin' && i.id === '9802'), 'the entry side lists the entry notes');
  for (const user of [f.users.consulta, f.users.vendas]) await assert.rejects(() => f.rpc('erp_fiscal_invoice_item_history', { p_user_id: user, p_contact_id: contact.id, p_product_id: product.id, p_direction: '1' }), code('42501'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_item_history', { p_user_id: f.users.fiscal, p_contact_id: randomUUID(), p_product_id: product.id, p_direction: '1' }), code('P0002'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_item_history', { p_user_id: f.users.fiscal, p_contact_id: contact.id, p_product_id: product.id, p_direction: '2' }), code('22023'));
  assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text)','EXECUTE') value"), true);
  assert.equal(await f.scalar("select has_function_privilege('authenticated','public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text)','EXECUTE') value"), false);
});

test('219 "Forma" from Cadastros › Formas de pagamento: listed by direction for the note profiles and stored on the parcel when it exists', async () => {
  const dto = await import('../../../packages/erp-domain/src/fiscal-invoice-dto.mjs');
  assert.deepEqual((await f.scalar('select erp_fiscal_invoices.invoice_specs() value')).installment, JSON.parse(JSON.stringify(dto.INSTALLMENT_SPEC)), 'the parcel descriptors match the shared ones');
  const method = async (description, payment_type, applicable, over = {}) => (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,applicable,card_brand,card_integration,card_cnpj,active,created_by,updated_by) values($1,$2,'contas',$3,$4,$5,$6,$7,$8,$8) returning id",
    [description, payment_type, applicable, over.brand ?? null, over.integration ?? null, over.cnpj ?? null, over.active ?? true, f.users.admin])).rows[0].id;
  const card = await method('Cartão Visa loja 219', '03', 'recebimentos', { brand: '01', integration: '2', cnpj: '11222333000181' });
  const supplierPix = await method('Pix fornecedores 219', '17', 'pagamentos');
  const both = await method('Boleto 219', '15', 'ambos');
  await method('Inativa 219', '01', 'ambos', { active: false });
  const exit = await f.rpc('erp_fiscal_invoice_payment_methods', { p_user_id: f.users.fiscal, p_direction: '1' });
  assert.deepEqual(exit.items.filter(m => m.description.endsWith('219')).map(m => m.description), ['Boleto 219', 'Cartão Visa loja 219']);
  assert.deepEqual(exit.items.find(m => m.id === card), { id: card, description: 'Cartão Visa loja 219', payment_type: '03', card_brand: '01', card_integration: '2', card_cnpj: '11222333000181' });
  const entry = await f.rpc('erp_fiscal_invoice_payment_methods', { p_user_id: f.users.admin, p_direction: '0' });
  assert.deepEqual(entry.items.filter(m => m.description.endsWith('219')).map(m => m.id).sort(), [supplierPix, both].sort());
  for (const user of [f.users.consulta, f.users.vendas]) await assert.rejects(() => f.rpc('erp_fiscal_invoice_payment_methods', { p_user_id: user, p_direction: '1' }), code('42501'));
  const saved = (await execute('create', { invoice: invoice({ payment: { installments: [{ date: '2026-11-20', amount: '20.00', method: '03', payment_method_id: card, card: { brand: '01', integration: '2', cnpj: '11222333000181' } }] } }) })).invoice;
  assert.equal(saved.payment.installments[0].payment_method_id, card);
  await assert.rejects(() => execute('create', { invoice: invoice({ payment: { installments: [{ date: '2026-11-20', amount: '20.00', payment_method_id: randomUUID() }] } }) }), message('erp_fiscal_invoice_payment_method_not_found'));
  // Review fix: a forma excluded in Cadastros later stays on the note that has it (it keeps saving), but no parcel takes it anew.
  const excluded = await method('Excluída depois 219', '15', 'ambos');
  const parcel = { date: '2026-11-20', amount: '20.00', method: '15', payment_method_id: excluded };
  const withExcluded = (await execute('create', { invoice: invoice({ payment: { installments: [parcel] } }) })).invoice;
  await f.db.query('update erp_catalog.payment_method set deleted_at=now(),deleted_by=$1,version=version+1 where id=$2', [f.users.admin, excluded]);
  assert.equal((await execute('update', { id: withExcluded.id, expected_version: 1, invoice: invoice({ additional_info: 'Ainda salva', payment: { installments: [parcel] } }) })).invoice.version, 2);
  await assert.rejects(() => execute('create', { invoice: invoice({ payment: { installments: [parcel] } }) }), message('erp_fiscal_invoice_payment_method_not_found'));
  await assert.rejects(() => execute('update', { id: saved.id, expected_version: 1, invoice: invoice({ payment: { installments: [parcel] } }) }), message('erp_fiscal_invoice_payment_method_not_found'));
});

test('219 Documento referenciado: the access key is looked up in the Brufap notes and the Origin XML archive, for the note profiles', async () => {
  const keyOf = (number, model = '55') => { const digits = `3526101122233300018${'1'}${model}001${String(number).padStart(9, '0')}1${'12345678'}`.slice(0, 43); let sum = 0, weight = 2; for (let i = 42; i >= 0; i--) { sum += Number(digits[i]) * weight; weight = weight === 9 ? 2 : weight + 1; } const dv = 11 - (sum % 11); return digits + (dv >= 10 ? 0 : dv); };
  const key = keyOf(901);
  await f.db.query("insert into origin_sync.resource_state(resource) values('fiscal_wave_d_test') on conflict do nothing");
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','fiscal_wave_d_test','9901',$1::jsonb,$2)", [JSON.stringify({ tipo: 1, numero: '000901', serie: 1, dataEmissao: '2026-10-01 10:00:00', valorNota: 55.5, contato: { nome: 'Cliente da chave' }, chaveAcesso: key }), 'd'.repeat(64)]);
  await f.db.query('insert into origin_fiscal.source(entity,source_id,access_key) values($1,$2,$3)', ['nfe', '9901', key]);
  const found = await f.rpc('erp_fiscal_invoice_key_lookup', { p_user_id: f.users.fiscal, p_key: key });
  assert.deepEqual(found.items, [{ origin: 'origin', id: '9901', model: '55', direction: '1', number: 901, series: 1, issue_date: '2026-10-01', name: 'Cliente da chave', total: '55.50' }]);
  const thirdKey = keyOf(902);
  const registered = (await execute('create', { invoice: invoice({ issue_type: 'T', number: '902', series: '1', access_key: thirdKey }) })).invoice;
  const brufap = await f.rpc('erp_fiscal_invoice_key_lookup', { p_user_id: f.users.admin, p_key: thirdKey });
  assert.deepEqual(brufap.items.map(i => [i.origin, i.id, i.number]), [['brufap', registered.id, 902]]);
  assert.deepEqual((await f.rpc('erp_fiscal_invoice_key_lookup', { p_user_id: f.users.fiscal, p_key: keyOf(903) })).items, []);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_key_lookup', { p_user_id: f.users.fiscal, p_key: '123' }), code('22023'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_key_lookup', { p_user_id: f.users.consulta, p_key: key }), code('42501'));
});

test('220 "Devolução de produto": the Brufap returns of a note (finalidade 4 referencing its key) and what they returned', async () => {
  const keyOf = number => { const digits = `3526101122233300018155001${String(number).padStart(9, '0')}1${'12345678'}`.slice(0, 43); let sum = 0, weight = 2; for (let i = 42; i >= 0; i--) { sum += Number(digits[i]) * weight; weight = weight === 9 ? 2 : weight + 1; } const dv = 11 - (sum % 11); return digits + (dv >= 10 ? 0 : dv); };
  const key = keyOf(950);
  const original = (await execute('create', { invoice: invoice({ issue_type: 'T', number: '950', series: '1', access_key: key, items: [{ product_id: product.id, description: 'Peça sintética 215', quantity: '5', unit_price: '10' }, { description: 'Item livre', code: 'LIVRE', quantity: '2', unit_price: '3' }] }) })).invoice;
  assert.equal(original.access_key, key);
  const back = (items, over = {}) => invoice({ direction: '0', issue_type: 'N', nature_id: buyNature.id, presence: '9', purpose: '4', references: [{ type: 'nfe', key }], items, ...over });
  const first = (await execute('create', { invoice: back([{ product_id: product.id, description: 'Peça sintética 215', quantity: '2', unit_price: '10' }]) })).invoice;
  await execute('create', { invoice: back([{ product_id: product.id, description: 'Peça sintética 215', quantity: '1', unit_price: '10' }, { description: 'Item livre', code: 'LIVRE', quantity: '2', unit_price: '3' }]) });
  const removed = (await execute('create', { invoice: back([{ product_id: product.id, description: 'Peça sintética 215', quantity: '1', unit_price: '10' }]) })).invoice;
  await execute('delete', { id: removed.id, expected_version: 1, reason: 'Devolução sintética excluída' });
  await execute('create', { invoice: back([{ product_id: product.id, description: 'Peça sintética 215', quantity: '1', unit_price: '10' }], { purpose: '1' }) });
  // Review fix: a cancelled (3) or denied (10) return gave nothing back.
  for (const status of [3, 10]) {
    const voided = (await execute('create', { invoice: back([{ product_id: product.id, description: 'Peça sintética 215', quantity: '1', unit_price: '10' }]) })).invoice;
    await f.db.query('update erp_fiscal_invoices.invoice set status=$1,version=version+1 where id=$2', [status, voided.id]);
  }
  const value = await f.rpc('erp_fiscal_invoice_returned', { p_user_id: f.users.fiscal, p_key: key });
  assert.equal(value.returns.length, 2, 'only returns (finalidade 4) that are not deleted'); assert.equal(value.returns[0].id, first.id);
  assert.deepEqual(value.items.map(i => [i.product_id, i.code, i.quantity]).sort(), [[null, 'LIVRE', '2.0000'], [product.id, null, '3.0000']].sort());
  assert.deepEqual((await f.rpc('erp_fiscal_invoice_returned', { p_user_id: f.users.admin, p_key: keyOf(951) })).returns, []);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_returned', { p_user_id: f.users.consulta, p_key: key }), code('42501'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_returned', { p_user_id: f.users.fiscal, p_key: 'x' }), code('22023'));
  assert.equal(await f.scalar("select has_function_privilege('authenticated','public.erp_fiscal_invoice_returned(uuid,text)','EXECUTE') value"), false);
});
