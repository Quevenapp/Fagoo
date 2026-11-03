// Synthetic data only. 202610200287: lots of the items (Informar lotes), Garantia of the items of the OS, IPI % of the pedido de
// compra, values of the campos customizados of the OS and the casas decimais of the quantity. PGlite with every migration and the
// real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f, lotted, other, lots;
before(async () => {
  f = await documentsEFixture();
  const product = async name => { const p = await f.catalog('products', { name, unit: 'UN', kind: 'P', format: 'S', price: '10' });
    await f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: p.id, p_expected_version: await f.recordVersion(p.id), p_command_id: randomUUID(), p_data: { name, lot_control: true }, p_acknowledged: null }); return p; };
  lotted = await product('Leite sintético G'); other = await product('Queijo sintético G');
  const lot = async (p, code) => (await f.rpc('erp_stock_lot_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_product_id: p.id, p_lot_id: null, p_expected_version: 0, p_code: code })).lot.id;
  lots = { a: await lot(lotted, 'L-A'), b: await lot(lotted, 'L-B'), other: await lot(other, 'Q-1') };
});
after(async () => f?.close());
const create = (kind, data, user) => f.call(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data }, user);
const sale = (items, extra = {}) => f.data('sales_orders', { items, ...extra });
const line = (extra = {}) => f.line({ product_id: lotted.id, description: 'Leite', quantity: '3', ...extra });
const field = async (data = {}) => {
  const row = { field_type: 'text', name: `Campo ${randomUUID().slice(0, 8)}`, required: false, active: true, options: '[]', ...data };
  return f.scalar(`insert into erp_documents.custom_field(kind,field_type,name,required,active,options,max_length,created_by,updated_by)
    values('service_orders',$1,$2,$3,$4,$5::jsonb,$6,$7,$7) returning id::text v`, [row.field_type, row.name, row.required, row.active, row.options, row.max_length ?? null, f.users.admin]);
};

test('privileges: the helpers and the tables of 287 stay closed; the public RPCs keep running only for service_role', async () => {
  for (const fn of ['erp_documents.quantity_decimals()', 'erp_documents.check_custom_fields(text,jsonb,jsonb)', 'erp_documents.custom_field_value(erp_documents.custom_field,text)',
    'erp_documents.check_links(text,jsonb,jsonb)', 'erp_documents.normalize(text,jsonb)', 'erp_documents.check_preference_rules(text,jsonb)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, `${role} ${fn}`);
  for (const sig of ['public.erp_document_access(uuid)', 'public.erp_document_copy_preview(uuid,text,uuid)']) {
    const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
    assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']], sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  }
  for (const table of ['custom_field', 'custom_field_audit']) for (const role of ['anon', 'authenticated', 'service_role'])
    assert.equal(await f.scalar("select has_table_privilege($1,$2,'SELECT') v", [role, `erp_documents.${table}`]), false);
});

test('Informar lotes: the lots of the product add up to the quantity, are read back and are refused anywhere else', async () => {
  const saved = await create('sales_orders', sale([line({ lots: [{ lot_id: lots.a, quantity: '1' }, { lot_id: lots.b, quantity: '2' }] }), f.line({ product_id: f.product.id, lots: [] })]));
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const doc = saved.value.document;
  assert.deepEqual(doc.items[0].lots, [{ lot_id: lots.a, quantity: '1.000000' }, { lot_id: lots.b, quantity: '2.000000' }]);
  assert.equal('lots' in doc.items[1], false, 'an empty list is Sem lote and is not kept');
  const read = (await f.call(`/v1/documentos/sales_orders/${doc.id}`)).value.document;
  assert.deepEqual(read.items[0].lots, doc.items[0].lots);
  assert.equal(await f.scalar('select data->\'lots\'->0->>\'quantity\' v from erp_documents.item where document_id=$1 and position=1', [doc.id]), '1.000000');
  // Wrong sum, repeated lot, a lot of another product, a free item, a pedido de compra and a serviço of the OS are refused.
  for (const bad of [[{ lot_id: lots.a, quantity: '1' }], [{ lot_id: lots.a, quantity: '1.5' }, { lot_id: lots.a, quantity: '1.5' }], [{ lot_id: lots.a, quantity: '3', extra: 1 }]])
    assert.equal((await create('sales_orders', sale([line({ lots: bad })]))).status, 400, JSON.stringify(bad));
  const foreign = await create('sales_orders', sale([line({ lots: [{ lot_id: lots.other, quantity: '3' }] })]));
  assert.deepEqual([foreign.status, foreign.value.error?.code], [400, 'ERP_DOCUMENT_LOT_UNAVAILABLE']);
  assert.equal((await create('sales_orders', sale([line({ product_id: null, lots: [{ lot_id: lots.a, quantity: '3' }] })]))).status, 400);
  assert.equal((await create('purchase_orders', f.data('purchase_orders', { items: [line({ lots: [{ lot_id: lots.a, quantity: '3' }] })] }), f.users.admin)).status, 400);
  const os = await create('service_orders', f.data('service_orders', { items: [line({ group: 'part', quote: false, done: false, lots: [{ lot_id: lots.a, quantity: '3' }] })] }));
  assert.equal(os.status, 200, JSON.stringify(os.value)); assert.equal(os.value.document.items[0].lots.length, 1);
  assert.equal((await create('service_orders', f.data('service_orders', { items: [line({ group: 'service', quote: false, done: false, lots: [{ lot_id: lots.a, quantity: '3' }] })] }))).status, 400);
  // The database checks the same without the Worker.
  await assert.rejects(() => f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: sale([line({ lots: [{ lot_id: lots.a, quantity: '2' }] })]) }), /erp_document_item_lots_quantity/);
  // Saving the pedido again without changes keeps the lots (identical rewrite of the items).
  const again = await f.call(`/v1/documentos/sales_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data: sale(doc.items.map(({ position, gross, discount, total, product_snapshot, ...item }) => item)) });
  assert.equal(again.status, 200, JSON.stringify(again.value)); assert.deepEqual(again.value.document.items[0].lots, doc.items[0].lots);
});

test('Garantia (dias) of the items of the OS, only in the OS; the copy keeps it', async () => {
  const os = await create('service_orders', f.data('service_orders', { items: [f.line({ product_id: f.product.id, group: 'part', quote: false, done: false, warranty_days: '90' }), f.line({ group: 'service', quote: false, done: false, warranty_days: null })] }));
  assert.equal(os.status, 200, JSON.stringify(os.value));
  assert.deepEqual(os.value.document.items.map(item => item.warranty_days), ['90', undefined]);
  for (const bad of ['-1', '10000', '1.5', 30]) assert.equal((await create('service_orders', f.data('service_orders', { items: [f.line({ group: 'part', warranty_days: bad })] }))).status, 400, String(bad));
  assert.equal((await create('sales_orders', sale([f.line({ warranty_days: '30' })]))).status, 400);
  const copy = (await f.call(`/v1/duplicacao-documentos/service_orders/${os.value.document.id}/preview`)).value;
  assert.equal(copy.data.items[0].warranty_days, '90');
});

test('IPI % of the pedido de compra: Total do IPI from the items, the total and the copy follow', async () => {
  const items = [f.line({ product_id: f.product.id, quantity: '3', unit_price: '10', ipi_rate: '10' }), f.line({ quantity: '1', unit_price: '5.55', ipi_rate: '5' }), f.line({ quantity: '1', unit_price: '1' })];
  const saved = await create('purchase_orders', f.data('purchase_orders', { items, freight: '1.50' }));
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const doc = saved.value.document;
  // 30.00 × 10% = 3.00 and 5.55 × 5% = 0.2775 → 0.28 (half up): Total do IPI 3.28; total = 36.55 + 3.28 + 1.50.
  assert.deepEqual([doc.totals.ipi, doc.totals.icms_st, doc.totals.total, 'tax_ipi' in doc], ['3.28', '0.00', '41.33', false]);
  assert.deepEqual(doc.items.map(item => item.ipi_rate), ['10.0000', '5.0000', undefined]);
  assert.equal(await f.scalar('select total::text v from erp_documents.document where id=$1', [doc.id]), '41.33');
  // A tax_ipi sent with the rates follows the items and is not kept; without rates the pedido de compra never takes an IPI.
  const sent = await create('purchase_orders', f.data('purchase_orders', { items, tax_ipi: '9.99' }));
  assert.deepEqual([sent.status, sent.value.document?.totals.ipi, 'tax_ipi' in (sent.value.document ?? {})], [200, '3.28', false]);
  assert.equal((await create('purchase_orders', f.data('purchase_orders', { tax_ipi: '1.00' }))).status, 400);
  // Leva H (EST-041, 390): the pedido de compra takes its Total ICMS ST, which adds to the total.
  const st = await create('purchase_orders', f.data('purchase_orders', { items, tax_icms_st: '1.00' }));
  assert.deepEqual([st.status, st.value.document?.totals.icms_st], [200, '1.00']);
  for (const bad of ['100.0001', '-1', '1.23456']) assert.equal((await create('purchase_orders', f.data('purchase_orders', { items: [f.line({ ipi_rate: bad })] }))).status, 400, bad);
  assert.equal((await create('sales_orders', sale([f.line({ ipi_rate: '10' })]))).status, 400, 'IPI % is of the pedido de compra');
  const copy = (await f.call(`/v1/duplicacao-documentos/purchase_orders/${doc.id}/preview`)).value;
  assert.deepEqual(copy.data.items.map(item => item.ipi_rate ?? null), ['10.0000', '5.0000', null]);
});

test('Número de casas decimais na quantidade: the items and the lots keep at most the chosen decimals (never more than 6)', async () => {
  try {
    await f.setPreference('empresa-geral', 'empresa.decimais_quantidade', 2);
    const access = (await f.call('/v1/documentos')).value;
    assert.equal(access.settings.quantity_decimals, 2);
    const refused = await create('sales_orders', sale([f.line({ quantity: '1.125' })]));
    assert.deepEqual([refused.status, refused.value.error?.code], [400, 'ERP_DOCUMENT_QUANTITY_DECIMALS']);
    assert.equal((await create('sales_orders', sale([f.line({ quantity: '1.250' })]))).status, 200, 'trailing zeros are not decimals');
    const lotted3 = await create('sales_orders', sale([line({ quantity: '1.12', lots: [{ lot_id: lots.a, quantity: '1.115' }, { lot_id: lots.b, quantity: '0.005' }] })]));
    assert.deepEqual([lotted3.status, lotted3.value.error?.code], [400, 'ERP_DOCUMENT_QUANTITY_DECIMALS']);
    await f.setPreference('empresa-geral', 'empresa.decimais_quantidade', 9);
    assert.equal((await f.call('/v1/documentos')).value.settings.quantity_decimals, 6, '7 to 10 decimals stay at the 6 of the stock');
    assert.equal((await create('sales_orders', sale([f.line({ quantity: '1.123456' })]))).status, 200);
  } finally { await f.setPreference('empresa-geral', 'empresa.decimais_quantidade', 6); }
});

test('Campos customizados of the OS: the definitions decide the type, the options, the size, required and inactive fields', async () => {
  const text = await field({ max_length: 10 }), option = randomUUID(), list = await field({ field_type: 'list', options: JSON.stringify([{ id: option, label: 'Sim' }]) });
  const decimal = await field({ field_type: 'decimal' }), required = await field({ required: true });
  const os = values => create('service_orders', f.data('service_orders', { custom_fields: values }));
  const saved = await os({ [text]: 'Placa A', [list]: option, [decimal]: '1.5', [required]: 'ok', [randomUUID()]: '' });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual(saved.value.document.custom_fields, { [text]: 'Placa A', [list]: option, [decimal]: '1.5', [required]: 'ok' });
  assert.deepEqual((await os({ [text]: 'x' })).value.error?.code, 'ERP_DOCUMENT_CUSTOM_FIELD_REQUIRED');
  for (const bad of [{ [text]: 'Texto longo demais' }, { [list]: randomUUID() }, { [decimal]: '1.50' }, { [decimal]: 'abc' }, { [randomUUID()]: 'x' }, { [text]: ' x' }])
    assert.equal((await os({ [required]: 'ok', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await create('sales_orders', sale([f.line()], { custom_fields: { [text]: 'x' } }))).status, 400, 'only the OS has campos customizados');
  // An inactive field keeps the value already saved and refuses a new one; the copy leaves it out.
  const doc = saved.value.document;
  await f.db.query('update erp_documents.custom_field set active=false where id=$1', [text]);
  const keep = await f.call(`/v1/documentos/service_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data: f.data('service_orders', { custom_fields: doc.custom_fields }) });
  assert.equal(keep.status, 200, JSON.stringify(keep.value));
  assert.equal((await f.call(`/v1/documentos/service_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: keep.value.document.version, data: f.data('service_orders', { custom_fields: { ...doc.custom_fields, [text]: 'Placa B' } }) })).value.error?.code, 'ERP_DOCUMENT_CUSTOM_FIELD_INACTIVE');
  const copy = (await f.call(`/v1/duplicacao-documentos/service_orders/${doc.id}/preview`)).value;
  assert.equal(text in copy.data.custom_fields, false); assert.equal(copy.data.custom_fields[list], option);
  await f.db.query('update erp_documents.custom_field set active=false where id=$1', [required]);
});
