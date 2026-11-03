import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';

// 113 on PGlite with synthetic Origin payloads and synthetic native notes only.
const migration = async name => readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const code = expected => error => error.code === expected;
const KEY = (model, number) => { const digits = `352610112223330001${'81'}${model}001${String(number).padStart(9, '0')}1${'12345678'}`.slice(0, 43); let sum = 0, weight = 2; for (let i = 42; i >= 0; i--) { sum += Number(digits[i]) * weight; weight = weight === 9 ? 2 : weight + 1; } const dv = 11 - (sum % 11); return digits + (dv >= 10 ? 0 : dv); };
let f, nature, entryNature, native, entryNative;
const list = (args = {}, user = f.users.admin) => f.rpc('erp_fiscal_invoice_list', { p_user_id: user, ...args });
const ids = page => page.items.map(row => row.id);
async function seed(entity, id, payload) {
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'fiscal_list_test',$2,$3::jsonb,$4)", [entity, id, JSON.stringify(payload), 'a'.repeat(64)]);
}
async function archive(entity, sourceId, key, environment, events = 0) {
  const source = randomUUID(), revision = randomUUID();
  await f.db.query('insert into origin_fiscal.source(id,entity,source_id,access_key) values($1,$2,$3,$4)', [source, entity, sourceId, key]);
  await f.db.query("insert into origin_fiscal.revision(id,source,revision,manifest_hash,source_status) values($1,$2,1,$3,'5')", [revision, source, randomUUID().replace(/-/g, '').padEnd(64, '0')]);
  await f.db.query('update origin_fiscal.source set current_revision=$1 where id=$2', [revision, source]);
  const kinds = [{ kind: 'invoice', event_type: null, event_sequence: null }, ...Array.from({ length: events }, (_, n) => ({ kind: 'event', event_type: '110110', event_sequence: String(n + 1) }))];
  for (const meta of kinds) {
    const hash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await f.db.query('insert into origin_fiscal.object(hash,size,metadata) values($1,10,$2::jsonb)', [hash, JSON.stringify({ key, model: key.slice(20, 22), environment, kind: meta.kind, protocol: '135260000000001', protocol_present: true, signature_present: true, event_type: meta.event_type, event_sequence: meta.event_sequence, issues: [] })]);
    await f.db.query('insert into origin_fiscal.item(revision,object_hash) values($1,$2)', [revision, hash]);
  }
}

before(async () => {
  f = await fixture({ apply: false });
  for (const name of ['202610160016_company', '202610160022_fiscal_drafts', '202610160035_fiscal_item_preparation', '202610160040_fiscal_tax_preparation', '202610160046_fiscal_numbering',
    '202610160027_origin_fiscal_archive', '202610200111_fiscal_operation_natures', '202610200112_fiscal_invoice_core', '202610200113_fiscal_invoice_list']) await f.db.exec(await migration(name));
  await f.db.exec("insert into origin_sync.resource_state(resource) values('fiscal_list_test')");
  const contact = { id: '501', nome: 'Cliente Alfa Sintético', numeroDocumento: '12.345.678/0001-90', email: 'compras@alfa.invalid', telefone: '(19) 3333-4444', endereco: { uf: 'SP', municipio: 'Piracicaba', endereco: 'Rua Sintética', numero: '10' } };
  await seed('contacts', '501', { nome: 'Cliente Alfa Sintético', codigo: 'C-77' });
  await seed('nfe', '9001', { tipo: 1, numero: '000123', serie: 1, dataEmissao: '2026-10-15 10:00:00', dataOperacao: '2026-10-16 08:00:00', situacao: 5, valorNota: 100.1, valorFrete: 10,
    contato: contact, chaveAcesso: KEY('55', 123), xml: 'https://signed.invalid/private', linkDanfe: 'https://signed.invalid/danfe', itens: [{ codigo: 'P-1', descricao: 'Peça sintética', unidade: 'UN', quantidade: 2, valor: 45.05, valorTotal: 90.1, cfop: '5102', classificacaoFiscal: '84713012' }],
    parcelas: [{ data: '2026-11-15', valor: 100.1, observacoes: 'Parcela sintética' }], transporte: { fretePorConta: 0, transportador: { nome: 'Transportadora Beta Sintética' }, volumes: [{ codigoRastreamento: 'BR123SINT' }] } });
  await seed('nfe', '9002', { tipo: 1, numero: 124, serie: '2', dataEmissao: '2026-09-30 09:00:00', situacao: 2, valorNota: '5.05', contato: { id: '502', nome: 'Pessoa Gama Sintética', numeroDocumento: '987.654.321-00', endereco: { uf: 'MG' } } });
  await seed('nfe', '9003', { tipo: 1, numero: 125, serie: 1, dataEmissao: '2026-10-01 09:00:00', situacao: 99, contato: { nome: 'Sem valor sintético' } });
  await seed('nfe', '9004', { tipo: 0, numero: 77, serie: 1, dataEmissao: '2026-10-02 09:00:00', dataOperacao: '2026-10-05 09:00:00', situacao: 7, valorNota: 300, contato: { nome: 'Fornecedor Delta Sintético', numeroDocumento: '11222333000181' } });
  await seed('nfe', '9005', { tipo: 1, numero: 126, serie: 1, dataEmissao: '2026-10-03 09:00:00', situacao: 5, valorNota: 999, contato: { nome: 'Homologação no Origin' }, chaveAcesso: KEY('55', 126) });
  await seed('nfce', '9101', { numero: 7, serie: 1, dataEmissao: '2026-10-10 12:00:00', situacao: 5, valorNota: 12.5, contato: { nome: 'Consumidor sintético' } });
  await archive('nfe', '9001', KEY('55', 123), '1', 2);
  await archive('nfe', '9005', KEY('55', 126), '2');
  const natures = async data => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  nature = await natures({ description: 'Venda sintética', direction: '1', crt: '1' });
  entryNature = await natures({ description: 'Compra sintética', direction: '0', crt: '1' });
  const create = async data => (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: data } })).invoice;
  const base = { model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: nature.id, issue_date: '2026-10-18', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { contact_id: f.contact.id, name: 'Cliente Nativo Sintético', person_type: 'J', document: '12345678000190', state: 'RJ' },
    items: [{ product_id: f.product.id, description: 'Peça sintética', quantity: '1', unit_price: '20' }], transport: { mode: 'manual', carrier: { name: 'Transportadora Nativa' }, tracking_code: 'NATIVO-1' } };
  native = await create(base);
  entryNative = await create({ ...base, direction: '0', issue_type: 'T', number: '900', series: '3', nature_id: entryNature.id, exit_date: '2026-10-19' });
});
after(() => f?.close());

test('113 is read-only, SECURITY DEFINER and granted only to service_role', async () => {
  for (const signature of ['public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text)', 'public.erp_fiscal_invoice_origin_get(uuid,text,text)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
    assert.equal(await f.scalar("select provolatile value from pg_proc where oid=$1::regprocedure", [signature]), 's');
  }
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_fiscal_invoices.list_rows(text,text,text,text)','EXECUTE') value"), false);
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, randomUUID()]) await assert.rejects(() => list({}, user), code('42501'));
});

test('Notas do Origin: mirror rows with Origin screen codes, numbers without zeros, exact totals and no homologation XML', async () => {
  const page = await list({}, f.users.consulta);
  assert.deepEqual(ids(page), ['9001', '9003', '9002'], 'newest first; Origin homologation note and entry note stay out');
  assert.equal(page.total_count, 3); assert.equal(page.total_amount, '105.15'); assert.equal(page.amount_unknown, 1); assert.equal(page.brufap_visible, false); assert.equal(page.data_mode, 'origin_mirror_readonly');
  const [first, unknown, cancelled] = page.items;
  assert.deepEqual([first.number, first.series, first.status, first.total, first.document, first.state, first.issue_date, first.entry_date], [123, 1, 6, '100.10', '12345678000190', 'SP', '2026-10-15', '2026-10-16']);
  assert.ok(first.xml_id); assert.match(first.xml_hash, /^[0-9a-f]{64}$/); assert.equal(first.xml_size, 10); assert.equal(first.environment, '1'); assert.equal(first.protocol_present, true); assert.equal(first.event_count, 2); assert.equal(first.access_key, KEY('55', 123));
  assert.deepEqual([unknown.status, unknown.status_raw, unknown.total, unknown.total_known], [null, '99', '0.00', false]);
  assert.deepEqual([cancelled.status, cancelled.series, cancelled.document], [3, 2, '98765432100']);
  assert.doesNotMatch(JSON.stringify(page), /signed\.invalid|private/);
  await assert.rejects(() => list({ p_origin: 'brufap' }, f.users.consulta), code('42501'), 'homologation tests are for admin and fiscal');
});

test('search and Filtrar panel: name, CPF/CNPJ with mask, number with zeros, key, situação, period, UF and custom search fields', async () => {
  const origin = async args => ids(await list(args, f.users.fiscal));
  assert.deepEqual(await origin({ p_query: 'alfa' }), ['9001']);
  assert.deepEqual(await origin({ p_query: '12.345.678/0001' }), ['9001']);
  assert.deepEqual(await origin({ p_query: '1234' }), [], 'fewer than five digits never searches documents');
  assert.deepEqual(await origin({ p_query: '000124' }), ['9002']); assert.deepEqual(await origin({ p_query: '124' }), ['9002']);
  assert.deepEqual(await origin({ p_query: KEY('55', 123) }), ['9001']);
  assert.deepEqual(await origin({ p_status: 'issued' }), ['9001']); assert.deepEqual(await origin({ p_status: 'cancelled' }), ['9002']); assert.deepEqual(await origin({ p_status: 'pending' }), []);
  assert.deepEqual(await origin({ p_date_from: '2026-10-01', p_date_to: '2026-10-15' }), ['9001', '9003']);
  assert.deepEqual(await origin({ p_date_type: 'entry', p_date_from: '2026-10-16', p_date_to: '2026-10-16' }), ['9001']);
  assert.deepEqual(await origin({ p_state: 'MG' }), ['9002']); assert.deepEqual(await origin({ p_person_type: 'F' }), ['9002']);
  assert.deepEqual(await origin({ p_document: '12.345.678/0001-90' }), ['9001']); assert.deepEqual(await origin({ p_email: 'ALFA.invalid' }), ['9001']);
  assert.deepEqual(await origin({ p_phone: '3333-4444' }), ['9001']); assert.deepEqual(await origin({ p_series: 2 }), ['9002']);
  assert.deepEqual(await origin({ p_contact_code: 'C-77' }), ['9001']); assert.deepEqual(await origin({ p_carrier: 'beta' }), ['9001']); assert.deepEqual(await origin({ p_tracking: 'br123' }), ['9001']);
  for (const other of ['transportador', 'fretePorConta', 'codigoRastreamento', 'Beta', 'volumes'])
    assert.deepEqual(await origin({ p_tracking: other }), [], `Código de rastreio matches tracking values only, never ${other}`);
  await f.db.query("update erp_catalog.record set code='P-1' where id=$1", [f.product.id]);
  assert.deepEqual(await origin({ p_product_id: f.product.id }), ['9001'], 'Origin items match the product code');
  assert.deepEqual(await origin({ p_nature: 'venda' }), [], 'Origin payloads carry only the nature id');
  assert.deepEqual(await origin({ p_direction: '0' }), ['9004']);
  assert.deepEqual(await origin({ p_direction: '0', p_status: 'registered' }), ['9004']);
  assert.deepEqual(ids(await list({ p_model: '65' })), ['9101']);
  for (const args of [{ p_model: '65', p_direction: '0' }, { p_origin: 'x' }, { p_status: 'x' }, { p_state: 'XX' }, { p_limit: 101 }, { p_page: 0 }, { p_order: 'name' }, { p_date_type: 'x' },
    { p_date_from: '2026-10-02', p_date_to: '2026-10-01' }, { p_query: 'x'.repeat(121) }, { p_person_type: 'X' }, { p_series: 1000 }])
    await assert.rejects(() => list(args), code('22023'), JSON.stringify(args));
});

test('Testes de homologação do Brufap: native rows only, with order, pages, totals and native filters', async () => {
  const page = await list({ p_origin: 'brufap' }, f.users.fiscal);
  assert.deepEqual(ids(page), [native.id]); assert.equal(page.items[0].environment, '2'); assert.equal(page.items[0].status, 1); assert.equal(page.items[0].number, null);
  assert.equal(page.items[0].version, 1); assert.equal(page.total_amount, '20.00'); assert.equal(page.data_mode, 'erp_native_homologation'); assert.equal(page.brufap_visible, true);
  assert.deepEqual(ids(await list({ p_origin: 'brufap', p_direction: '0' })), [entryNative.id]);
  assert.deepEqual(ids(await list({ p_origin: 'brufap', p_direction: '0', p_date_type: 'entry', p_date_from: '2026-10-19' })), [entryNative.id]);
  assert.deepEqual(ids(await list({ p_origin: 'brufap', p_product_id: f.product.id })), [native.id]);
  assert.deepEqual(ids(await list({ p_origin: 'brufap', p_nature: 'venda sint' })), [native.id]);
  assert.deepEqual(ids(await list({ p_origin: 'brufap', p_tracking: 'nativo' })), [native.id]);
  const second = (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: { model: '55', direction: '1', issue_type: 'N', series: '2',
    nature_id: nature.id, issue_date: '2026-10-19', crt: '1', purpose: '1', presence: '1', final_consumer: true, recipient: { name: 'Segundo nativo', person_type: 'F' }, items: [{ description: 'Item', quantity: '1', unit_price: '0.05' }] } } })).invoice;
  const first = await list({ p_origin: 'brufap', p_limit: 1, p_page: 1 }), next = await list({ p_origin: 'brufap', p_limit: 1, p_page: 2 }), beyond = await list({ p_origin: 'brufap', p_limit: 1, p_page: 3 });
  assert.deepEqual([ids(first), first.has_more, ids(next), next.has_more, ids(beyond), beyond.has_more], [[second.id], true, [native.id], false, [], false]);
  for (const page of [first, next, beyond]) { assert.equal(page.total_count, 2); assert.equal(page.total_amount, '20.05'); }
  assert.deepEqual(ids(await list({ p_origin: 'brufap', p_order: 'date_asc' })), [native.id, second.id]);
  await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'delete', p_data: { id: second.id, expected_version: 1, reason: 'Teste sintético' } });
  assert.deepEqual(ids(await list({ p_origin: 'brufap' })), [native.id], 'deleted notes leave the list');
});

test('Origin note detail is an allowlisted read-only projection', async () => {
  const detail = await f.rpc('erp_fiscal_invoice_origin_get', { p_user_id: f.users.consulta, p_entity: 'nfe', p_source_id: '9001' });
  assert.equal(detail.writable, false); assert.equal(detail.number, 123); assert.equal(detail.status, 6); assert.equal(detail.total, '100.10'); assert.equal(detail.freight, '10.00');
  assert.deepEqual(detail.items, [{ code: 'P-1', description: 'Peça sintética', unit: 'UN', quantity: '2', unit_price: '45.05', total: '90.10', cfop: '5102', ncm: '84713012', gtin: null }]);
  assert.deepEqual(detail.installments, [{ date: '2026-11-15', amount: '100.10', note: 'Parcela sintética' }]);
  assert.equal(detail.contact.document, '12345678000190'); assert.equal(detail.contact.city, 'Piracicaba'); assert.equal(detail.events.length, 2); assert.equal(detail.xml.protocol, '135260000000001');
  assert.doesNotMatch(JSON.stringify(detail), /signed\.invalid/);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_origin_get', { p_user_id: f.users.consulta, p_entity: 'nfe', p_source_id: '9005' }), code('P0002'), 'Origin homologation XML');
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_origin_get', { p_user_id: f.users.consulta, p_entity: 'nfe', p_source_id: '1' }), code('P0002'));
  for (const [entity, id] of [['contacts', '501'], ['nfe', 'abc'], ['nfe', null]]) await assert.rejects(() => f.rpc('erp_fiscal_invoice_origin_get', { p_user_id: f.users.consulta, p_entity: entity, p_source_id: id }), code('22023'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_origin_get', { p_user_id: f.users.vendas, p_entity: 'nfe', p_source_id: '9001' }), code('42501'));
});
