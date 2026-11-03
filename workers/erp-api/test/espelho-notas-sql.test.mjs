import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { espelhoHFixture, migrationSql } from './helpers/espelho-h-fixture.mjs';
import { COMPANY, SUPPLIER, accessKey, nfeXml } from './helpers/fiscal-import-xml.mjs';
import { createHandler } from '../src/index.mjs';

// Leva H, lane espelho (NFE-027, NFE-069, NFE-063, NFE-185, NFE-212, NFE-024, NFE-172) on PGlite over every production migration and the
// wave H files, through the real Worker handler. Synthetic Origin payloads, XMLs and received documents only.
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const NS = 'http://www.portalfiscal.inf.br/nfe', sha = v => createHash('sha256').update(v).digest('hex');
const code = expected => error => error.code === expected;
let f, handler;
const objects = new Map();
const types = new Map();
async function rpc(name, args) {
  if (!types.has(name)) types.set(name, new Map((await f.db.query("select x.n,x.t from pg_proc p,unnest(p.proargnames,string_to_array(oidvectortypes(p.proargtypes),', ')) x(n,t) where p.proname=$1 and p.pronamespace='public'::regnamespace", [name])).rows.map(r => [r.n, r.t])));
  const e = Object.entries(args), t = types.get(name);
  await f.db.exec('set role service_role');
  try { return await f.scalar(`select public.${name}(${e.map(([k], i) => `${k}=>$${i + 1}`).join(',')})v`, e.map(([k, v]) => Array.isArray(v) && t.get(k)?.endsWith('[]') ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : v)); }
  finally { await f.db.exec('reset role'); }
}
const call = async (path, method = 'GET', body, user = f.users.admin) => {
  const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: response.status, value: await response.json() };
};
const list = (args = {}, user = f.users.admin) => rpc('erp_fiscal_invoice_list', { p_user_id: user, ...args });
const nfe = (id, over = {}) => ({ id: Number(id), numero: '000123', serie: 1, tipo: 1, dataEmissao: '2026-10-10 10:00:00', dataOperacao: '2026-10-10 10:00:00', situacao: 5, valorNota: 100,
  contato: { nome: 'Cliente Sintético', numeroDocumento: '12345678000195' }, ...over });
const order = (id, nota, over = {}) => ({ id: Number(id), numero: 77, data: '2026-10-01', contato: { id: 9, nome: 'Cliente do Pedido' }, notaFiscal: nota === undefined ? { id: 0 } : nota, ...over });
const row = (page, id) => page.items.find(r => r.id === id);

before(async () => {
  // Lane files after this lane's range (0362+) belong to other agents of the lane and are left out here.
  f = await espelhoHFixture({ before: '202610210362' });
  handler = createHandler({ fetchImpl: async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
    const storage = /\/storage\/v1\/object\/authenticated\/brufap-received-dfe\/objects\/([a-f0-9]{64})\.xml$/.exec(url);
    if (storage) return objects.has(storage[1]) ? new Response(objects.get(storage[1]), { headers: { 'Content-Type': 'application/octet-stream' } }) : new Response('{}', { status: 404 });
    try { return Response.json(await rpc(new URL(url).pathname.split('/').at(-1), JSON.parse(options.body))); }
    catch (e) { return Response.json({ code: e.code, message: /^(erp|dfe)_[a-z0-9_]{1,80}$/.test(e.message) ? e.message : 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); }
  } });
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2) on conflict(singleton) do update set data=excluded.data", [JSON.stringify({ legal_name: 'Empresa Sintética Ltda', trade_name: 'Sintética', cnpj: COMPANY, ie: '110042490114', state: 'SP', city: 'São Paulo', municipality_code: '3550308', postal_code: '01001000', street: 'Praça Sintética', number: '1', district: 'Centro', phone: '1130001000' }), f.users.admin]);
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict(singleton) do update set crt=excluded.crt", [f.users.admin]);
});
after(() => f?.close());

test('356-359: new tables are private, the replaced list bodies were hash-checked and the RPCs stay service_role only', async () => {
  for (const table of ['erp_fiscal_invoices.origin_order_link', 'erp_fiscal_invoices.invoice_source', 'erp_dfe.summary'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') v", [role, table]), false, `${role} ${table}`);
  for (const sig of ['public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,uuid)',
    'public.erp_catalog_invoice_list_tagged(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,text,uuid)',
    'public.erp_dfe_summary_record(uuid,uuid,text,jsonb)', 'public.erp_dfe_summaries(uuid,uuid,uuid[])']) {
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true, sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=to_regprocedure($1)', [sig]), true);
  }
  // The previous signatures are gone (no ambiguous overload) and the internal query is not callable from the API.
  assert.equal(await f.scalar("select count(*)::int v from pg_proc where proname in('erp_fiscal_invoice_list','erp_catalog_invoice_list_tagged') and pronamespace='public'::regnamespace"), 2);
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_fiscal_invoices.list_query(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,boolean,text,uuid)','EXECUTE') v"), false);
  const text = await migrationSql('202610210358_fiscal_invoice_list_espelho.sql');
  assert.match(text, /fiscal_invoice_list_358_previous_definition_changed/);
  for (const name of ['202610210356_fiscal_origin_order_links.sql', '202610210357_fiscal_invoice_source.sql', '202610210358_fiscal_invoice_list_espelho.sql', '202610210359_dfe_summary.sql'])
    assert.match(await migrationSql(name), /^-- Leva H[\s\S]*\nbegin;[\s\S]*\ncommit;\n$/);
});

test('NFE-027: the Origin pedido declares its note (notaFiscal.id); repeated and out-of-order deliveries keep only the current link', async () => {
  await f.mirror('nfe', '9001', nfe('9001'));
  await f.mirror('sales_orders', '501', order('501', { id: 9001 }));
  let page = await list();
  assert.deepEqual(row(page, '9001').orders, [{ id: '501', kind: 'sales_orders', number: '77', date: '2026-10-01', contact_name: 'Cliente do Pedido' }]);
  // Duplicate delivery: same link, one row.
  await f.mirror('sales_orders', '501', order('501', { id: 9001 }));
  assert.equal(await f.scalar("select count(*)::int v from erp_fiscal_invoices.origin_order_link where order_source_id='501'"), 1);
  // A second pedido of the same note; the V badge lists both, ordered by number.
  await f.mirror('sales_orders', '502', order('502', { id: '9001' }, { numero: 12, contato: { nome: 'Outro Cliente' } }));
  page = await list();
  assert.deepEqual(row(page, '9001').orders.map(o => [o.id, o.number]), [['502', '12'], ['501', '77']]);
  // Nº pedido de venda now finds Origin notes.
  assert.deepEqual((await list({ p_order_number: '12' })).items.map(r => r.id), ['9001']);
  assert.deepEqual((await list({ p_order_number: '999' })).items, []);
  // The pedido points to another note, then loses it (id 0): the old link is removed each time, never kept by name or value.
  await f.mirror('sales_orders', '502', order('502', { id: 9002 }, { numero: 12 }));
  await f.mirror('nfe', '9002', nfe('9002', { numero: '124' }));
  page = await list();
  assert.deepEqual(row(page, '9001').orders.map(o => o.id), ['501']); assert.deepEqual(row(page, '9002').orders.map(o => o.id), ['502']);
  await f.mirror('sales_orders', '502', order('502', { id: 0 }, { numero: 12 }));
  assert.deepEqual(row(await list(), '9002').orders, []);
  // A note mirrored after its pedido (out of order) gets the link as soon as it arrives.
  await f.mirror('sales_orders', '503', order('503', { id: 9003 }, { numero: 30 }));
  assert.equal(row(await list(), '9003'), undefined);
  await f.mirror('nfe', '9003', nfe('9003', { numero: '125' }));
  assert.deepEqual(row(await list(), '9003').orders.map(o => o.number), ['30']);
  // A payload the trigger cannot trust never blocks the staging: invalid number stays out of the badge.
  await f.mirror('sales_orders', '504', order('504', { id: 9003 }, { numero: 'ABC' }));
  assert.deepEqual(row(await list(), '9003').orders.map(o => o.id), ['503']);
  // Same Origin id as nfe and nfce: ambiguous, no link on either.
  await f.mirror('nfce', '9003', nfe('9003', { numero: '125' }));
  assert.deepEqual(row(await list(), '9003').orders, []);
  assert.deepEqual(row(await list({ p_model: '65' }), '9003').orders, []);
  // Reconciliation rebuilds the same state.
  const before = (await f.db.query('select order_source_id,invoice_source_id,order_number from erp_fiscal_invoices.origin_order_link order by 1')).rows;
  await f.db.exec('delete from erp_fiscal_invoices.origin_order_link');
  assert.ok(await f.scalar('select erp_fiscal_invoices.origin_order_link_rebuild() v') >= 4);
  assert.deepEqual((await f.db.query('select order_source_id,invoice_source_id,order_number from erp_fiscal_invoices.origin_order_link order by 1')).rows, before);
  // Through the Worker the Origin row passes the strict list contract with its pedidos.
  const http = await call('/v1/notas-fiscais?model=55&order_number=77', 'GET', undefined, f.users.consulta);
  assert.equal(http.status, 200, JSON.stringify(http.value));
  assert.deepEqual(http.value.items.map(r => [r.id, r.orders.map(o => o.id)]), [['9001', ['501']]]);
});

test('NFE-069: situação of the Origin API (OpenAPI v3) keeps its origin code; Emitida DANFE is an authorized note with the DANFE printed', async () => {
  await f.mirror('nfe', '9101', nfe('9101', { numero: '201', situacao: 6 }));
  await f.mirror('nfe', '9102', nfe('9102', { numero: '202', situacao: { id: 5, valor: 0 } }));
  await f.mirror('nfe', '9103', nfe('9103', { numero: '203', situacao: 12 }));
  const page = await list();
  const pick = id => { const r = row(page, id); return [r.status, r.status_raw, r.fiscal_status, r.danfe_emitted]; };
  assert.deepEqual(pick('9101'), [7, '6', 6, true]);
  assert.deepEqual(pick('9102'), [6, '5', 6, false]);
  assert.deepEqual(pick('9103'), [null, '12', null, false]);
  // "Autorizadas - Sem DANFE" stays the authorized notes without DANFE; "Emitidas" are all the authorized ones.
  assert.ok((await list({ p_status: 'authorized' })).items.every(r => r.status === 6));
  const issued = (await list({ p_status: 'issued' })).items.map(r => r.id);
  assert.ok(issued.includes('9101') && issued.includes('9102') && !issued.includes('9103'));
  const http = await call('/v1/notas-fiscais?model=55&q=201');
  assert.equal(http.status, 200); assert.deepEqual([http.value.items[0].fiscal_status, http.value.items[0].danfe_emitted, http.value.items[0].source_origin], [6, true, 'origin']);
});

test('NFE-063/185: model, origin and source environment are independent; imported NF-e and NFC-e keep the tpAmb of their XML', async () => {
  assert.equal(await f.scalar("select erp_fiscal_invoices.xml_source_environment('<NFe><infNFe><ide><tpAmb>2</tpAmb></ide></infNFe></NFe><protNFe><infProt><tpAmb>2</tpAmb></infProt></protNFe>') v"), '2');
  assert.equal(await f.scalar("select erp_fiscal_invoices.xml_source_environment('<ide><tpAmb>1</tpAmb></ide><infProt><tpAmb>2</tpAmb></infProt>') v"), null);
  assert.equal(await f.scalar("select erp_fiscal_invoices.xml_source_environment('<ide></ide>') v"), null);
  const exit = nfeXml({ emit: COMPANY, dest: SUPPLIER, number: 811 });
  const imported = await call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: exit.xml }, f.users.fiscal);
  assert.equal(imported.status, 200, JSON.stringify(imported.value)); assert.equal(imported.value.imported, true);
  const id = imported.value.invoice.id;
  assert.deepEqual((await f.db.query('select source_environment,xml_sha256 from erp_fiscal_invoices.invoice_source where invoice_id=$1', [id])).rows[0], { source_environment: '1', xml_sha256: sha(exit.xml) });
  await assert.rejects(() => f.db.query("update erp_fiscal_invoices.invoice_source set source_environment='2' where invoice_id=$1", [id]));
  const nfce = nfeXml({ model: '65', emit: COMPANY, dest_block: false, crt: '1', transport: false, dup: false, number: 812, items: [{ code: 'P-65', name: 'Produto de balcão', quantity: '2.0000', price: '10.0000' }], pay: [{ tPag: '01', vPag: '20.00' }] });
  const second = await call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: nfce.xml }, f.users.fiscal);
  assert.equal(second.status, 200, JSON.stringify(second.value)); assert.equal(second.value.imported, true);
  // The same key again stays a duplicate (dedup by key: only production XMLs are imported, so key and key + environment agree).
  const again = await call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: exit.xml }, f.users.fiscal);
  assert.deepEqual([again.value.imported, again.value.refused], [false, 'duplicate']);
  const homologation = await call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: nfeXml({ emit: COMPANY, dest: SUPPLIER, number: 813, tpAmb: '2' }).xml }, f.users.fiscal);
  assert.equal(homologation.value.refused, 'xml_homologation');
  const native = await list({ p_origin: 'brufap' });
  const r55 = row(native, id);
  assert.deepEqual([r55.issue_type, r55.environment, r55.source_origin, r55.source_environment], ['S', null, 'xml_import', '1']);
  const r65 = row(await list({ p_origin: 'brufap', p_model: '65' }), second.value.invoice.id);
  assert.deepEqual([r65.issue_type, r65.environment, r65.source_origin, r65.source_environment], ['S', null, 'xml_import', '1']);
  // The emission environment column and its guard are untouched: the import still carries no environment.
  assert.equal(await f.scalar('select environment v from erp_fiscal_invoices.invoice where id=$1', [id]), null);
  const http = await call('/v1/notas-fiscais?model=65&origin=brufap', 'GET', undefined, f.users.fiscal);
  assert.equal(http.status, 200, JSON.stringify(http.value));
  assert.deepEqual(http.value.items.map(r => [r.source_origin, r.source_environment]), [['xml_import', '1']]);
  // Origin notes: origin origin, environment of the archived XML (none collected here).
  assert.deepEqual([row(await list(), '9001').source_origin, row(await list(), '9001').source_environment], ['origin', null]);
});

test('NFE-024/172: Categoria filters the notes of the Brufap by the contas lançadas by the note, never the Origin notes', async () => {
  const exit = nfeXml({ emit: COMPANY, dest: SUPPLIER, number: 821 });
  const imported = await call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: exit.xml }, f.users.fiscal);
  const id = imported.value.invoice.id;
  const contact = await f.catalog('contacts', { name: 'Cliente Sintético' });
  const [cat, other] = [randomUUID(), randomUUID()];
  await f.db.query("insert into erp_finance.category(id,name,kind) values($1,'Vendas de mercadorias','receivable'),($2,'Outras receitas','receivable')", [cat, other]);
  const posting = randomUUID(), title = randomUUID();
  await f.db.query("insert into erp_finance.invoice_posting(id,invoice_id,invoice_version,group_id,snapshot,preview_hash,actor,command_id) values($1,$2,1,$3,'{}',$4,$5,$6)", [posting, id, randomUUID(), 'a'.repeat(64), f.users.admin, randomUUID()]);
  await f.db.query("insert into erp_finance.title(id,group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents) values($1,$2,1,1,'receivable',$3,$4,'Parcela sintética','2026-10-18','2026-11-18',1000)", [title, randomUUID(), contact.id, cat]);
  await f.db.query('insert into erp_finance.invoice_title(title_id,posting_id,position) values($1,$2,1)', [title, posting]);
  assert.deepEqual((await list({ p_origin: 'brufap', p_category_id: cat })).items.map(r => r.id), [id]);
  assert.deepEqual((await list({ p_origin: 'brufap', p_category_id: other })).items, []);
  // A reversed posting no longer counts.
  await f.db.query("update erp_finance.invoice_posting set state='reversed',reversed_at=now(),reversed_by=$2,reason='Estorno sintético' where id=$1", [posting, f.users.admin]);
  assert.deepEqual((await list({ p_origin: 'brufap', p_category_id: cat })).items, []);
  await f.db.query("update erp_finance.invoice_posting set state='active',reversed_at=null,reversed_by=null,reason=null where id=$1", [posting]);
  // Origin notes have no contas in the Brufap: the filter is refused instead of answering an empty list.
  await assert.rejects(() => list({ p_category_id: cat }), code('22023'));
  // The tagged variant answers the same filter (and keeps its tag rule).
  assert.deepEqual((await rpc('erp_catalog_invoice_list_tagged', { p_user_id: f.users.admin, p_origin: 'brufap', p_tag: 'none', p_category_id: cat })).items.map(r => r.id), [id]);
  await assert.rejects(() => rpc('erp_catalog_invoice_list_tagged', { p_user_id: f.users.admin, p_origin: 'brufap', p_category_id: cat }), code('22023'));
  // Company profiles: consulta does not read the notes of the Brufap; vendas does not read notes at all.
  await assert.rejects(() => list({ p_origin: 'brufap', p_category_id: cat }, f.users.consulta), code('42501'));
  await assert.rejects(() => list({}, f.users.vendas), code('42501'));
  const http = await call(`/v1/notas-fiscais?model=55&origin=brufap&category_id=${cat}`, 'GET', undefined, f.users.fiscal);
  assert.equal(http.status, 200, JSON.stringify(http.value)); assert.deepEqual(http.value.items.map(r => r.id), [id]);
  assert.equal((await call(`/v1/notas-fiscais?model=55&category_id=${cat}`)).status, 400);
  // Nothing was created to fill the filter.
  assert.equal(await f.scalar('select count(*)::int v from erp_finance.title'), 1);
});

async function receivedDocument(kind, xml, key) {
  const bytes = new TextEncoder().encode(xml), h = sha(bytes);
  objects.set(h, bytes);
  let channel = await f.scalar("select id::text v from erp_dfe.channel where environment='1'");
  if (!channel) {
    channel = randomUUID();
    await f.db.query("insert into erp_dfe.channel(id,cnpj,environment,identity_version,author_uf,version,coordinator,other_consumers_reviewed,checkpoint_confirmed,collection_requested) values($1,$2,'1',1,'35',1,'external',false,false,false)", [channel, COMPANY]);
  }
  const attempt = randomUUID();
  await f.db.query("insert into erp_dfe.command(id,actor,action,request_hash,channel_id,result) values($1,$2,'collect',$3,$4,'{}')", [attempt, f.users.admin, 'b'.repeat(64), channel]);
  await f.db.query("insert into erp_dfe.attempt(id,channel_id,actor,channel_version,identity_version,request_nsu,request_hash,state,lease_id,lease_until,lease_started_at,dispatched_at,finished_at,result) values($1,$2,$3,1,1,'000000000000000',$4,'stored',$5,now(),now(),now(),now(),'{}')", [attempt, channel, f.users.admin, 'b'.repeat(64), randomUUID()]);
  await f.db.query('insert into erp_dfe.object(hash,size_bytes) values($1,$2) on conflict do nothing', [h, bytes.length]);
  const id = randomUUID();
  const schema = { invoice_summary: 'resNFe_v1.01.xsd', invoice: 'procNFe_v4.00.xsd', event_summary: 'resEvento_v1.01.xsd' }[kind];
  await f.db.query('insert into erp_dfe.document(id,channel_id,nsu,object_hash,schema_name,kind,access_key,recipient_match,quarantined,first_attempt) values($1,$2,null,$3,$4,$5,$6,$7,false,$8)', [id, channel, h, schema, kind, key, kind === 'invoice' ? true : null, attempt]);
  return { id, channel, hash: h };
}

test('NFE-212: Data emissão, Valor, Fornecedor and CNPJ/CPF read once from the kept resumo or NF-e, checked against the access key', async () => {
  const key = accessKey({ cnpj: SUPPLIER, number: 901 });
  const resumo = await receivedDocument('invoice_summary', `<?xml version="1.0" encoding="UTF-8"?><resNFe xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe><CNPJ>${SUPPLIER}</CNPJ><xNome>Fornecedor Sintético S.A.</xNome><IE>110042490114</IE><dhEmi>2026-10-15T09:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1234.5</vNF><digVal>c2ludGV0aWNv</digVal><dhRecbto>2026-10-15T09:01:00-03:00</dhRecbto><nProt>135260000000001</nProt><cSitNFe>1</cSitNFe></resNFe>`, key);
  const full = nfeXml({ emit: SUPPLIER, dest: COMPANY, number: 902 });
  const complete = await receivedDocument('invoice', full.xml, full.key);
  const event = await receivedDocument('event_summary', `<resEvento xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resEvento>`, key);
  const ids = [resumo.id, complete.id, event.id].join(',');
  const empty = await call(`/v1/notas-recebidas/summaries?channel_id=${resumo.channel}&ids=${ids}`, 'GET', undefined, f.users.consulta);
  assert.equal(empty.status, 200, JSON.stringify(empty.value)); assert.deepEqual(empty.value.items, []);
  const read = await call(`/v1/notas-recebidas/documents/${resumo.id}/summary`, 'POST', {}, f.users.consulta);
  assert.equal(read.status, 200, JSON.stringify(read.value));
  assert.deepEqual(read.value.summary, { document_id: resumo.id, issue_date: '2026-10-15', total: '1234.50', supplier_name: 'Fornecedor Sintético S.A.', supplier_document: SUPPLIER, situation: '1' });
  assert.equal(read.value.recorded, true); assert.equal(read.value.can_query, false); assert.equal(read.value.financial_mutation_performed, false);
  const again = await call(`/v1/notas-recebidas/documents/${resumo.id}/summary`, 'POST', {}, f.users.fiscal);
  assert.deepEqual([again.value.recorded, again.value.summary], [false, read.value.summary]);
  const nfeRead = await call(`/v1/notas-recebidas/documents/${complete.id}/summary`, 'POST', {});
  assert.equal(nfeRead.status, 200, JSON.stringify(nfeRead.value));
  assert.deepEqual(nfeRead.value.summary, { document_id: complete.id, issue_date: '2026-10-18', total: full.total, supplier_name: 'Fornecedor sintético S.A.', supplier_document: SUPPLIER, situation: null });
  assert.equal((await call(`/v1/notas-recebidas/documents/${event.id}/summary`, 'POST', {})).status, 422);
  const stored = await call(`/v1/notas-recebidas/summaries?channel_id=${resumo.channel}&ids=${ids}`);
  assert.deepEqual(stored.value.items.map(s => s.document_id).sort(), [resumo.id, complete.id].sort());
  // Profiles outside the received notes, a body with data, a summary that disagrees with the key and an update are all refused.
  assert.equal((await call(`/v1/notas-recebidas/summaries?channel_id=${resumo.channel}&ids=${ids}`, 'GET', undefined, f.users.vendas)).status, 403);
  assert.equal((await call(`/v1/notas-recebidas/documents/${resumo.id}/summary`, 'POST', { total: '1.00' })).status, 400);
  const other = await receivedDocument('invoice_summary', `<resNFe xmlns="${NS}" versao="1.01"><chNFe>${accessKey({ cnpj: SUPPLIER, number: 903 })}</chNFe></resNFe>`, accessKey({ cnpj: SUPPLIER, number: 903 }));
  await assert.rejects(() => rpc('erp_dfe_summary_record', { p_user_id: f.users.admin, p_document_id: other.id, p_object_hash: other.hash, p_summary: { access_key: accessKey({ cnpj: SUPPLIER, number: 903 }), supplier_document: COMPANY } }), code('22023'));
  await assert.rejects(() => rpc('erp_dfe_summary_record', { p_user_id: f.users.admin, p_document_id: other.id, p_object_hash: 'c'.repeat(64), p_summary: { access_key: accessKey({ cnpj: SUPPLIER, number: 903 }) } }), code('22023'));
  await assert.rejects(() => f.db.query("update erp_dfe.summary set total=1 where document_id=$1", [resumo.id]));
  // Altered bytes in the Storage are never read.
  objects.set(other.hash, new TextEncoder().encode(`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${'0'.repeat(44)}</chNFe></resNFe>`));
  assert.equal((await call(`/v1/notas-recebidas/documents/${other.id}/summary`, 'POST', {})).status, 502);
  assert.equal(await f.scalar('select count(*)::int v from erp_dfe.summary'), 2);
});
