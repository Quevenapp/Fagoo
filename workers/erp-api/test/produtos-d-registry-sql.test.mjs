import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosDFixture, migrationSql, fails } from './helpers/produtos-d-fixture.mjs';

// Produtos lane, wave D (migration 191): Itens p/ caixa decimal, filtro Campos customizados (página e reajuste), código Sequencial
// EAN, contexto do formulário (CRT) e a criação automática de produtos a partir dos documentos. PGlite, dados sintéticos.
const PUBLIC = ['erp_catalog_product_page_custom', 'erp_catalog_product_form_context', 'erp_catalog_product_save', 'erp_catalog_product_price_adjust'];
const ean = body => { let sum = 0; for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1); return `${body}${(10 - (sum % 10)) % 10}`; };
const sqlCode = code => error => error.code === code;

test('191 grants: SECURITY DEFINER, fixed search_path, service_role only; the document function is internal', async () => {
  const f = await produtosDFixture();
  try {
    for (const name of PUBLIC) {
      const rows = await f.rows(`select p.prosecdef d,p.proconfig c,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('authenticated',p.oid,'execute') u,has_function_privilege('service_role',p.oid,'execute') s
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
      assert.deepEqual([rows.length, rows[0].d, rows[0].c, rows[0].a, rows[0].u, rows[0].s], [1, true, ['search_path=pg_catalog'], false, false, true], name);
    }
    for (const sig of ['erp_catalog.document_product(uuid,text,uuid,jsonb)', 'erp_catalog.product_custom_filter(jsonb)', 'erp_catalog.next_product_code(boolean)'])
      assert.deepEqual(await f.rows(`select has_function_privilege('service_role','${sig}','execute') s,has_function_privilege('authenticated','${sig}','execute') u`), [{ s: false, u: false }], sig);
    assert.equal(await f.scalar("select has_table_privilege('service_role','erp_catalog.product_detail','select') v"), false);
  } finally { await f.close(); }
});

test('191 Itens p/ caixa: exact decimal in the detail, integer mirror in the catalog, old routes followed, migration of stored values', async () => {
  // Production state first: a product saved with the integer column before 191 keeps its value afterwards.
  const f = await produtosDFixture({ lane: [] });
  try {
    const before = (await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Caixa antiga', kind: 'P', format: 'S', items_per_box: '24' } })).record;
    await f.db.exec(await migrationSql('202610200191_product_registry_d.sql'));
    const read = id => f.rpc('erp_catalog_product_get', { p_user_id: f.users.consulta, p_id: id }).then(value => value.record);
    let record = await read(before.id);
    assert.deepEqual([record.items_per_box, record.items_per_box_decimal, record.version], ['24', '24.000000', before.version]);
    // Decimal through the form path: mirror empty, exact value kept, one version and one audit.
    const command = randomUUID();
    let saved = await f.productSave({ items_per_box_decimal: '2.5' }, { id: record.id, version: record.version, command });
    assert.deepEqual([saved.record.items_per_box, saved.record.items_per_box_decimal, saved.record.version], [null, '2.500000', record.version + 1]);
    assert.equal((await f.productSave({ items_per_box_decimal: '2.5' }, { id: record.id, version: record.version, command })).replayed, true);
    assert.equal((await f.productSave({ items_per_box_decimal: '2.500' }, { id: saved.record.id, version: saved.record.version })).record.version, saved.record.version, 'same value, same version');
    assert.equal(await f.scalar("select after_data->>'items_per_box_decimal' v from erp_catalog.audit where record_id=$1 order by id desc limit 1", [record.id]), '2.500000');
    record = saved.record;
    saved = await f.productSave({ items_per_box_decimal: '999999' }, { id: record.id, version: record.version });
    assert.deepEqual([saved.record.items_per_box, saved.record.items_per_box_decimal], ['999999', '999999.000000']);
    record = saved.record;
    for (const bad of ['-1', '1000000', '1.1234567', '1,5', 'abc', '', 3]) await fails(assert, f.productSave({ items_per_box_decimal: bad }, { id: record.id, version: record.version }), '22023');
    // The old catalog route (integer column) is copied to the detail.
    const old = (await f.rpc('erp_catalog_save', { p_user_id: f.users.estoque, p_entity: 'products', p_id: record.id, p_expected_version: record.version, p_command_id: randomUUID(), p_data: { items_per_box: '7' } })).record;
    record = await read(record.id);
    assert.deepEqual([old.items_per_box, record.items_per_box_decimal, record.version], ['7', '7.000000', old.version]);
    // Clearing through the form clears both.
    saved = await f.productSave({ items_per_box_decimal: null }, { id: record.id, version: record.version });
    assert.deepEqual([saved.record.items_per_box, saved.record.items_per_box_decimal], [null, null]);
    // A new product starts with the decimal; the stock lane's "Saldo inicial" path goes through the same save.
    const created = await f.product({ name: 'Caixa nova', items_per_box_decimal: '0.25' });
    assert.deepEqual([created.items_per_box, created.items_per_box_decimal], [null, '0.250000']);
    // Saving other catalog fields keeps the decimal (the integer column is not touched by the form).
    const renamed = await f.productSave({ name: 'Caixa nova renomeada', brand: 'Marca X' }, { id: created.id, version: created.version });
    assert.deepEqual([renamed.record.name, renamed.record.items_per_box_decimal], ['Caixa nova renomeada', '0.250000']);
  } finally { await f.close(); }
});

test('191 Campos customizados filter: page by type, AND, permissions, refusals and the filtered price adjust', async () => {
  const f = await produtosDFixture();
  try {
    const field = data => f.rpc('erp_catalog_custom_field_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).then(value => value.field);
    const text = await field({ field_type: 'text', name: 'Material' }), number = await field({ field_type: 'decimal', name: 'Fator' });
    const date = await field({ field_type: 'date', name: 'Lançamento' }), flag = await field({ field_type: 'boolean', name: 'Importado' });
    const list = await field({ field_type: 'list', name: 'Cor', options: [{ label: 'Azul' }, { label: 'Verde' }] }), other = await field({ field_type: 'list', name: 'Tamanho', options: [{ label: 'P' }] });
    const [azul, verde] = list.options;
    const make = async (name, values, price = '10') => f.product({ name, price, custom_values: values });
    const a = await make('Mesa de Aço', { [text.id]: 'Aço inox', [number.id]: '1.5', [date.id]: '2026-01-10', [flag.id]: 'true', [list.id]: azul.id });
    const b = await make('Cadeira', { [text.id]: 'Madeira', [number.id]: '3', [date.id]: '2026-05-01', [flag.id]: 'false', [list.id]: verde.id });
    await make('Sem campos', {});
    const page = (custom, extra = {}, user = f.users.consulta) => f.rpc('erp_catalog_product_page_custom', { p_user_id: user, p_page: 1, p_size: 100, p_sort: 'name_asc', p_situation: 'latest', p_custom: custom, ...extra });
    const names = async (custom, extra) => (await page(custom, extra)).items.map(item => item.name);
    assert.deepEqual(await names([{ field_id: text.id, value: 'ACO' }]), ['Mesa de Aço'], 'contains, without accents or case');
    assert.deepEqual(await names([{ field_id: number.id, from: '1.5', to: '2' }]), ['Mesa de Aço']);
    assert.deepEqual(await names([{ field_id: number.id, from: '2' }]), ['Cadeira']);
    assert.deepEqual(await names([{ field_id: date.id, to: '2026-03-01' }]), ['Mesa de Aço']);
    assert.deepEqual(await names([{ field_id: flag.id, value: 'false' }]), ['Cadeira']);
    assert.deepEqual(await names([{ field_id: list.id, value: verde.id.toUpperCase() }]), ['Cadeira']);
    assert.deepEqual(await names([{ field_id: list.id, value: azul.id }, { field_id: number.id, from: '2' }]), [], 'every filter applies');
    assert.deepEqual(await names([{ field_id: text.id, value: 'a' }], { p_query: 'cadeira' }), ['Cadeira'], 'with the other filters of the page');
    const result = await page([{ field_id: text.id, value: 'a' }], {}, f.users.vendas);
    const v2 = await f.rpc('erp_catalog_product_page_v2', { p_user_id: f.users.vendas, p_page: 1, p_size: 100, p_sort: 'name_asc', p_situation: 'latest' });
    assert.deepEqual([result.total, result.page, result.size, result.sort, result.stock_visible], [2, 1, 100, 'name_asc', v2.stock_visible]);
    assert.deepEqual(Object.keys(result.items[0]).sort(), Object.keys(v2.items.find(item => item.id === result.items[0].id)).sort(), 'the same item shape as the v2 page');
    const stocked = await page([{ field_id: text.id, value: 'a' }], {}, f.users.estoque);
    assert.deepEqual([stocked.stock_visible, stocked.items.map(row => row.stock.state)], [true, ['no_movements', 'no_movements']]);
    for (const bad of [[], [{ field_id: text.id }], [{ field_id: text.id, value: 'x', from: '1' }], [{ field_id: number.id, value: '1' }], [{ field_id: number.id, from: '3', to: '1' }],
      [{ field_id: number.id, from: '1e3' }], [{ field_id: date.id, from: '2026-02-30' }], [{ field_id: flag.id, value: 'sim' }], [{ field_id: list.id, value: other.options[0].id }],
      [{ field_id: randomUUID(), value: 'x' }], [{ field_id: text.id.toUpperCase(), value: 'x' }], [{ field_id: text.id, value: 'x', extra: 1 }], Array.from({ length: 11 }, () => ({ field_id: text.id, value: 'a' })), { field_id: text.id }])
      await fails(assert, page(bad), '22023');
    await fails(assert, page(null), '22023');
    await fails(assert, page([{ field_id: text.id, value: 'a' }], {}, f.users.inactive), '42501');
    await fails(assert, page([{ field_id: text.id, value: 'a' }], { p_stock: 'zero', p_warehouse_id: randomUUID() }), 'P0002');
    assert.deepEqual((await page([{ field_id: text.id, value: 'a' }], { p_stock: 'no_movements' })).items.map(item => item.name), ['Cadeira', 'Mesa de Aço'], 'with the stock filter');
    // Reajuste "Produtos filtrados" with the same filter: only the matching products change.
    const adjust = (filters, command = randomUUID()) => f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: command, p_rule: { action: 'increase', unit: 'amount', value: '1' }, p_items: null, p_filters: filters });
    const command = randomUUID();
    const applied = await adjust({ situation: 'latest', custom: [{ field_id: list.id, value: azul.id }] }, command);
    assert.deepEqual([applied.total, applied.applied], [1, 1]);
    assert.equal((await adjust({ situation: 'latest', custom: [{ field_id: list.id, value: azul.id }] }, command)).replayed, true);
    const prices = Object.fromEntries((await f.rows('select r.name,p.price::text price from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id')).map(row => [row.name, row.price]));
    assert.deepEqual([prices['Mesa de Aço'], prices.Cadeira], ['11.0000', '10.0000']);
    assert.equal((await adjust({ situation: 'latest', custom: null })).total, 3, 'a null custom filter is no filter');
    await fails(assert, adjust({ situation: 'latest', custom: 'x' }), '22023');
    await fails(assert, adjust({ situation: 'latest', custom: [{ field_id: randomUUID(), value: 'x' }] }), '22023');
    assert.equal(b.version, 1);
  } finally { await f.close(); }
});

test('191 Sequencial EAN: GS1 prefix, item number floor, check digit, exhaustion and the manual code', async () => {
  const f = await produtosDFixture();
  try {
    await f.preference('cadastros-produtos', 'produtos.codigo', 'sequencial_ean');
    await assert.rejects(f.product({ name: 'Sem prefixo' }), error => error.code === '22023' && /ean_prefix_missing/.test(error.message));
    assert.equal((await f.product({ name: 'Código digitado', code: 'ABC-1' })).code, 'ABC-1', 'a typed code stays');
    await f.preference('cadastros-produtos', 'produtos.ean_prefixo', '7891234');
    assert.equal((await f.product({ name: 'Primeiro EAN' })).code, ean('789123400000'));
    assert.equal((await f.product({ name: 'Segundo EAN' })).code, ean('789123400001'));
    await f.preference('cadastros-produtos', 'produtos.ean_proximo', 50);
    assert.equal((await f.product({ name: 'Com piso' })).code, ean('789123400050'));
    assert.equal((await f.product({ name: 'Depois do piso' })).code, ean('789123400051'));
    // An 11-digit prefix leaves one digit for the item: 0 to 9, then the save is refused.
    await f.preference('cadastros-produtos', 'produtos.ean_prefixo', '78912345678');
    await f.preference('cadastros-produtos', 'produtos.ean_proximo', 9);
    const last = await f.product({ name: 'Último' });
    assert.equal(last.code, ean('789123456789'));
    assert.match(last.code, /^\d{13}$/);
    await assert.rejects(f.product({ name: 'Esgotado' }), error => error.code === '22023' && /ean_exhausted/.test(error.message));
    await f.preference('cadastros-produtos', 'produtos.ean_prefixo', '12AB');
    await fails(assert, f.product({ name: 'Prefixo inválido' }), '22023');
    // Sequencial keeps numbering after the largest numeric code.
    await f.preference('cadastros-produtos', 'produtos.codigo', 'sequencial');
    assert.equal((await f.product({ name: 'Sequencial' })).code, String(BigInt(ean('789123456789')) + 1n));
    await f.preference('cadastros-produtos', 'produtos.codigo', 'manual');
    assert.equal((await f.product({ name: 'Manual' })).code, null);
  } finally { await f.close(); }
});

test('191 form context: only the confirmed CRT, for every product reader', async () => {
  const f = await produtosDFixture();
  try {
    const context = user => f.rpc('erp_catalog_product_form_context', { p_user_id: user });
    assert.deepEqual(await context(f.users.vendas), { crt: null, data_mode: 'erp_native' });
    await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{}'::jsonb,$1)", [f.users.admin]);
    await f.db.query('insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,null,null,null)');
    assert.equal((await context(f.users.estoque)).crt, null, 'not confirmed: unknown');
    await f.db.query("update erp_company.fiscal set crt='3',confirmed_at=clock_timestamp(),confirmed_by=$1", [f.users.admin]);
    for (const user of [f.users.admin, f.users.consulta, f.users.vendas, f.users.estoque, f.users.fiscal]) assert.equal((await context(user)).crt, '3');
    await fails(assert, context(f.users.inactive), '42501');
    await fails(assert, context(randomUUID()), '42501');
  } finally { await f.close(); }
});

test('191 automatic products from documents: any profile that writes the document, preference, origin, code and replay', async () => {
  const f = await produtosDFixture();
  try {
    const call = (user, kind, command, item) => f.scalar('select erp_catalog.document_product($1,$2,$3,$4::jsonb)::text v', [user, kind, command, JSON.stringify(item)]);
    const item = { position: 1, description: 'Serviço de montagem', code: null, unit: 'UN', unit_price: '35.5' };
    const command = randomUUID();
    assert.equal(await call(f.users.vendas, 'sales_orders', command, item), null, 'preference off: nothing is created');
    await f.preference('cadastros-produtos', 'produtos.cadastro_auto_vendas', true);
    await f.preference('cadastros-produtos', 'produtos.origem_padrao', '2');
    await f.preference('cadastros-produtos', 'produtos.codigo', 'sequencial');
    await f.product({ name: 'Existente numerado', code: '41' });
    const id = await call(f.users.vendas, 'sales_orders', command, item);
    const created = (await f.rpc('erp_catalog_product_get', { p_user_id: f.users.vendas, p_id: id })).record;
    assert.deepEqual([created.name, created.code, created.unit, created.price, created.kind, created.format, created.origin, created.active, created.version],
      ['Serviço de montagem', '42', 'UN', '35.5000', 'P', 'S', '2', true, 1]);
    assert.deepEqual(await f.rows("select actor::text a,action from erp_catalog.audit where record_id=$1", [id]), [{ a: f.users.vendas, action: 'create' }]);
    assert.equal(await call(f.users.vendas, 'sales_orders', command, item), id, 'the same document command and position return the same product');
    await fails(assert, call(f.users.vendas, 'sales_orders', command, { ...item, description: 'Outro' }), '40001');
    // An active product with the same code is linked instead of created.
    const linked = await f.product({ name: 'Parafuso', code: 'PAR-10' });
    assert.equal(await call(f.users.vendas, 'sales_orders', randomUUID(), { position: 1, description: 'Parafuso livre', code: 'par-10', unit: 'UN', unit_price: '1' }), linked.id);
    // Service orders: services (kind S) when the item says so; purchase orders: no sale price.
    await f.preference('cadastros-produtos', 'produtos.cadastro_auto_os', true);
    const service = await call(f.users.vendas, 'service_orders', randomUUID(), { position: 2, description: 'Revisão', code: 'SRV-1', unit: 'H', unit_price: '80', kind: 'S' });
    assert.equal((await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: service })).record.kind, 'S');
    await f.preference('cadastros-produtos', 'produtos.cadastro_auto_compras', true);
    const bought = await call(f.users.estoque, 'purchase_orders', randomUUID(), { position: 1, description: 'Chapa', code: 'CH-1', unit: 'KG', unit_price: '9.9' });
    assert.equal((await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: bought })).record.price, null);
    // The document write permission decides: Vendas does not write purchase orders, Financeiro writes no document.
    await fails(assert, call(f.users.vendas, 'purchase_orders', randomUUID(), item), '42501');
    await fails(assert, call(f.users.financeiro, 'sales_orders', randomUUID(), item), '42501');
    await fails(assert, call(f.users.inactive, 'sales_orders', randomUUID(), item), '42501');
    await fails(assert, call(f.users.vendas, 'sales_orders', randomUUID(), { ...item, product_id: linked.id }), '22023');
    await fails(assert, call(f.users.vendas, 'sales_orders', randomUUID(), { ...item, kind: 'N' }), '22023');
    await assert.rejects(call(f.users.vendas, 'sales_orders', randomUUID(), { ...item, description: '' }), sqlCode('22023'));
  } finally { await f.close(); }
});

test('191 preference definitions: the Sequencial EAN keys exist in SQL with the rules of the page schema', async () => {
  const { STORED_PREFERENCE_PAGES } = await import('../../../packages/erp-domain/src/preferences/catalog.mjs');
  const { definitionRows, fieldAt, fieldMigration, preferenceValueValid, storedFields } = await import('../../../packages/erp-domain/src/preferences/core.mjs');
  const { generatedBlock, committedBlock } = await import('../../../tools/preferences/generate-definitions.mjs');
  assert.equal(await committedBlock('191'), generatedBlock('191'), 'run node tools/preferences/generate-definitions.mjs --write');
  const f = await produtosDFixture();
  try {
    const page = STORED_PREFERENCE_PAGES.find(p => p.id === 'cadastros-produtos');
    const mine = storedFields(page).filter(x => fieldMigration(page, x) === '191');
    assert.deepEqual(mine.map(x => x.key), ['produtos.ean_prefixo', 'produtos.ean_proximo']);
    const rows = await f.rows("select key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format from erp_preferences.definition where key like 'produtos.ean_%' order by ordinal");
    // As 191 applied them (the preferências lane turns the prefix into 'digits' in 264).
    assert.deepEqual(rows, definitionRows(page, '191').filter(r => mine.some(x => x.key === r.key)).map(r => ({ ...r })));
    for (const field of mine) for (const value of ['', '7891234', 'x'.repeat(12), 0, 99999, 100000, -1, null, '12'])
      assert.equal(await f.scalar('select erp_preferences.value_valid(d,$2::jsonb) v from erp_preferences.definition d where d.key=$1', [field.key, value === null ? null : JSON.stringify(value)]), preferenceValueValid(fieldAt(field, '191'), value), `${field.key} ${JSON.stringify(value)}`);
  } finally { await f.close(); }
});

test('191 Controle de lote: the switch of the product is stored with the product command and refused with variations', async () => {
  const f = await produtosDFixture();
  try {
    const created = await f.product({ name: 'Leite em pó', lot_control: true });
    assert.equal(created.lot_control, true);
    const off = await f.productSave({ lot_control: false }, { id: created.id, version: created.version });
    assert.deepEqual([off.record.lot_control, off.record.version], [false, created.version + 1]);
    assert.equal((await f.productSave({ lot_control: false }, { id: created.id, version: off.record.version })).record.version, off.record.version, 'unchanged: same version');
    await fails(assert, f.productSave({ lot_control: 'sim' }, { id: created.id, version: off.record.version }), '22023');
    await fails(assert, f.productSave({ lot_control: null }, { id: created.id, version: off.record.version }), '22023');
    await assert.rejects(f.product({ name: 'Camiseta', format: 'V', lot_control: true }), error => error.code === '22023' && /lot_control_variations/.test(error.message));
    const on = await f.productSave({ lot_control: true }, { id: created.id, version: off.record.version });
    await assert.rejects(f.productSave({ format: 'V' }, { id: created.id, version: on.record.version }), error => error.code === '22023' && /lot_control_variations/.test(error.message), 'turning into variations with lots on');
    assert.equal((await f.product({ name: 'Sem lote' })).lot_control, false, 'off by default');
  } finally { await f.close(); }
});

test('191 erp_catalog_save: a new product without Origem gets the Origem padrão; contacts, edits and a given Origem do not change', async () => {
  const f = await produtosDFixture();
  try {
    const save = (entity, data, { id = null, version = 0 } = {}) => f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: entity, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_data: data }).then(value => value.record);
    assert.equal((await save('products', { name: 'Padrão 0', kind: 'P', format: 'S' })).origin, '0', 'the default of the page is 0, as in the form');
    await f.preference('cadastros-produtos', 'produtos.origem_padrao', '2');
    const product = await save('products', { name: 'Importado', kind: 'P', format: 'S' });
    assert.equal(product.origin, '2');
    assert.equal((await save('products', { name: 'Com origem', kind: 'P', format: 'S', origin: '1' })).origin, '1');
    assert.equal((await save('products', { name: 'Editado' }, { id: product.id, version: product.version })).origin, '2', 'an edit keeps the stored Origem');
    assert.equal(Object.hasOwn(await save('contacts', { name: 'Contato', person_type: 'J' }), 'origin'), false);
    const command = randomUUID(), body = { p_user_id: f.users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: command, p_data: { name: 'Repetido', kind: 'P', format: 'S' } };
    const first = await f.rpc('erp_catalog_save', body);
    assert.equal((await f.rpc('erp_catalog_save', body)).replayed, true, 'the same command replays');
    assert.equal(first.record.origin, '2');
    // "Conferir resultado" after the Origem padrão changed still replays the stored result (the request hash keeps the Origem used).
    await f.preference('cadastros-produtos', 'produtos.origem_padrao', '5');
    const again = await f.rpc('erp_catalog_save', body);
    assert.deepEqual([again.replayed, again.record.id, again.record.origin], [true, first.record.id, '2']);
    await fails(assert, f.rpc('erp_catalog_save', { ...body, p_data: { name: 'Outro corpo', kind: 'P', format: 'S' } }), '40001');
    await fails(assert, f.rpc('erp_catalog_save', { ...body, p_user_id: f.users.estoque }), '40001');
    // A new command takes the current preference.
    assert.equal((await save('products', { name: 'Novo comando', kind: 'P', format: 'S' })).origin, '5');
    // The product form path: a body without the Origem key gets the default; an explicit empty Origem stays empty.
    assert.equal((await f.product({ name: 'Integração' })).origin, '5');
    assert.equal((await f.product({ name: 'Sem origem', origin: null })).origin, null);
  } finally { await f.close(); }
});

test('191 erp_catalog_save: a product command saved before 191 still replays after the deploy (no Origem added to its request)', async () => {
  const f = await produtosDFixture({ lane: [] });
  try {
    const body = { p_user_id: f.users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Antes da 191', kind: 'P', format: 'S' } };
    const first = await f.rpc('erp_catalog_save', body);
    assert.equal(first.record.origin, null);
    await f.db.exec(await migrationSql('202610200191_product_registry_d.sql'));
    const again = await f.rpc('erp_catalog_save', body);
    assert.deepEqual([again.replayed, again.record.id, again.record.origin], [true, first.record.id, null]);
    assert.equal(await f.scalar("select count(*)::integer v from erp_catalog.record where entity='products' and name='Antes da 191'"), 1);
  } finally { await f.close(); }
});
