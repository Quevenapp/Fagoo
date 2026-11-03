// Production migration chain + fiscal mirror; synthetic identities and XML bytes only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fiscalMirrorFixture } from './helpers/fiscal-mirror-fixture.mjs';
import { inspectArchivedXml } from '../../../packages/fiscal-xml/src/archive.mjs';
import { buildAccessKey } from '../../../packages/fiscal-core/src/identity.mjs';
import { invoice, event, identity, keyFor } from '../../origin-sync/test/xml-fixtures.mjs';
import { parseSyncedXmlRoute, executeSyncedXmlRoute } from '../src/synced-xml.mjs';
import { parseHistoryRoute, executeHistoryRoute } from '../src/history.mjs';

const MIGRATION = '202610220004_fiscal_xml_scope.sql';
const sha = value => createHash('sha256').update(value).digest('hex');
const key = (n, model = '55') => buildAccessKey({ ...identity(model), number: String(n) });
const backup = sha('synthetic-fiscal-xml-scope');
const objects = new Map(), sources = {}, backupFiles = {};
let f, sellerA, sellerB, contactA, contactB, unscoped;
const signatures = [
  'public.erp_synced_xml_list(uuid,integer,uuid,text,text,text,boolean)',
  'public.erp_synced_xml_object(uuid,uuid)',
  'public.erp_history_xml(uuid,text,integer,integer,text,text,text)',
  'public.erp_history_xml_object(uuid,text,text)',
  'public.erp_catalog_invoice_tags(uuid,text,text,text[])',
  'public.erp_catalog_invoice_tags_save(uuid,text,text,text,integer,uuid,jsonb,text)',
];

async function base() {
  const result = await fiscalMirrorFixture(), originalRpc = result.rpc;
  // Expected database denials inside a rolled-back scenario need a savepoint so RESET ROLE cannot mask the original SQLSTATE.
  result.rpc = async (name, args) => {
    if (!result.testTransaction) return originalRpc(name, args);
    const entries = Object.entries(args); await result.db.exec('savepoint fiscal_rpc_test');
    try {
      await result.db.exec('set role service_role');
      const value = await result.scalar(`select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) v`,
        entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value));
      await result.db.exec('reset role;release savepoint fiscal_rpc_test'); return value;
    } catch (error) { await result.db.exec('rollback to savepoint fiscal_rpc_test;release savepoint fiscal_rpc_test'); throw error; }
  };
  return result;
}
const beginScenario = async () => { await f.db.exec('begin'); f.testTransaction = true; };
const endScenario = async () => { await f.db.exec('rollback'); f.testTransaction = false; };
const synced = (suffix = '', user = f.users.consulta, fetchObject) => executeSyncedXmlRoute(
  parseSyncedXmlRoute(new Request(`https://synthetic.invalid/v1/xmls-sincronizados${suffix}`)),
  { userId: user, rpc: f.rpc, fetchObject });
const history = (suffix = '', user = f.users.consulta, fetchObject) => executeHistoryRoute(
  parseHistoryRoute(new URL(`https://synthetic.invalid/v1/history/xml${suffix}${suffix.includes('?') ? '&' : '?'}backup=${backup}`)),
  { userId: user, rpc: f.rpc, fetchObject });
const fetchStored = async path => {
  const hash = path.split('/').at(-1).slice(0, -4);
  assert.match(path, /^\/storage\/v1\/object\/authenticated\/origin-(?:fiscal-xml|backups)\/objects\/[0-9a-f]{64}\.xml$/);
  return new Response(objects.get(hash));
};
const notFound = action => assert.rejects(action, error => error.code === 'P0002');

async function seller(user, name) {
  const contact = await f.catalog('contacts', { name });
  return f.scalar('insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by) values($1,$2,$3,$3) returning id::text v', [contact.id, user, f.users.admin]);
}
async function linkedContact(sourceId, sellerId) {
  const record = await f.catalog('contacts', { name: `Contato sintético ${sourceId}` });
  await f.stage('contacts', sourceId, { id: sourceId, nome: `Contato sintético ${sourceId}` });
  await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts' and source_id=$1", [sourceId]);
  await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) select entity,source_id,$2,version_hash,version_hash,'synced' from origin_sync.raw_record where entity='contacts' and source_id=$1", [sourceId, record.id]);
  await f.db.query('insert into erp_catalog.contact_profile(record_id,seller_id) values($1,$2) on conflict(record_id) do update set seller_id=excluded.seller_id', [record.id, sellerId]);
  return record;
}
async function raw(sourceId, n, contact, model = '55') {
  return f.stage(model === '55' ? 'nfe' : 'nfce', sourceId, {
    id: sourceId, chaveAcesso: key(n, model), situacao: 5, tipo: 1, numero: String(n), serie: 1,
    dataEmissao: '2026-10-16 08:00:00', valorNota: 10, ...(contact ? { contato: { id: contact } } : {}),
  });
}
function xml(n, model, kind, variant = '') {
  const originalKey = keyFor(model), accessKey = key(n, model);
  return (kind === 'event' ? event(model) : invoice(model, variant)).replaceAll(originalKey, accessKey)
    .replace('<nNF>1</nNF>', `<nNF>${n}</nNF>`).replace(`<cDV>${originalKey[43]}</cDV>`, `<cDV>${accessKey[43]}</cDV>`);
}
async function archive(label, sourceId, n, { model = '55', priorEvent = false } = {}) {
  const source = randomUUID(), entity = model === '55' ? 'nfe' : 'nfce';
  await f.db.query('insert into origin_fiscal.source(id,entity,source_id,access_key) values($1,$2,$3,$4)', [source, entity, sourceId, key(n, model)]);
  const rows = [];
  for (const kind of priorEvent ? ['event', 'invoice'] : ['invoice']) {
    const revision = randomUUID(), bytes = new TextEncoder().encode(xml(n, model, kind));
    const hash = sha(bytes), metadata = inspectArchivedXml(bytes, { key: key(n, model), entity });
    await f.db.query("insert into origin_fiscal.revision(id,source,revision,manifest_hash,source_status) values($1,$2,$3,$4,'5')", [revision, source, rows.length + 1, hash]);
    await f.db.query('insert into origin_fiscal.object(hash,size,metadata) values($1,$2,$3::jsonb) on conflict do nothing', [hash, bytes.length, JSON.stringify(metadata)]);
    const id = await f.scalar('insert into origin_fiscal.item(revision,object_hash) values($1,$2) returning id::text v', [revision, hash]);
    await f.db.query("insert into storage.objects values('origin-fiscal-xml',$1,$2::jsonb) on conflict do nothing", [`objects/${hash}.xml`, JSON.stringify({ size: bytes.length, mimetype: 'application/xml' })]);
    await f.db.query('update origin_fiscal.source set current_revision=$1 where id=$2', [revision, source]);
    objects.set(hash, bytes); rows.push({ id, hash, bytes, source, revision, key: key(n, model) });
  }
  sources[label] = { ...rows.at(-1), rows };
}
async function backupXml(label, n, { model = '55', duplicate = false } = {}) {
  const bytes = new TextEncoder().encode(xml(n, model, 'invoice')), hash = sha(bytes);
  const metadata = inspectArchivedXml(bytes, { key: key(n, model), entity: model === '55' ? 'nfe' : 'nfce' });
  for (let i = 0; i < (duplicate ? 2 : 1); i++) {
    const file = sha(`synthetic-${label}-${i}`);
    await f.db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data) values($1,'xml',$2,0,$3::jsonb),($1,'file',$2,0,$4::jsonb)", [backup, file,
      JSON.stringify({ ...metadata, sha256: hash, key: key(n, model) }),
      JSON.stringify({ storage_representation: 'object', object_sha256: hash, object_key: `objects/${hash}.xml`, object_size: bytes.length })]);
    if (duplicate) await f.db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data) values($1,'issue',$2,0,'{\"code\":\"SYNTHETIC_WARNING\"}')", [backup, file]);
  }
  await f.db.query("insert into storage.objects values('origin-backups',$1,$2::jsonb) on conflict do nothing", [`objects/${hash}.xml`, JSON.stringify({ size: bytes.length, mimetype: 'application/xml' })]);
  objects.set(hash, bytes); backupFiles[label] = { hash, bytes };
}

before(async () => {
  f = await base(); await f.migrate(MIGRATION);
  sellerA = await seller(f.users.consulta, 'Vendedor carteira A'); sellerB = await seller(f.users.fiscal, 'Vendedor carteira B');
  contactA = await linkedContact('101', sellerA); contactB = await linkedContact('102', sellerB);
  unscoped = randomUUID(); await f.db.query('insert into auth.users(id,email) values($1,$2)', [unscoped, 'unscoped@synthetic.test']);
  await f.db.query("insert into erp_access.membership(user_id,role) values($1,'fiscal')", [unscoped]);
  await f.preference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  await raw('201', 1, '101'); await raw('202', 2, '102'); await raw('203', 3, '999');
  await raw('204', 4, null, '65'); await raw('206', 6, '101'); await raw('207', 6, '102');
  await raw('208', 8, '101'); await raw('210', 9, '101');
  await archive('own', '201', 1, { priorEvent: true }); await archive('foreign', '202', 2);
  await archive('unlinked', '203', 3); await archive('anonymous', '204', 4, { model: '65' });
  await archive('ambiguous', '206', 6); await archive('changedKey', '208', 7);
  await archive('fallback', '209', 9); await archive('legacy', '211', 10);
  await f.db.query("insert into origin_backup.batch(backup_sha,manifest,status) values($1,'{}','stored')", [backup]);
  await backupXml('own', 1, { duplicate: true }); await backupXml('foreign', 2); await backupXml('unlinked', 3);
  await backupXml('anonymous', 4, { model: '65' }); await backupXml('ambiguous', 6); await backupXml('legacy', 10);
});
after(async () => f?.close());

test('004 SQL and HTTP filter current/history before cursor pagination for scoped consulta and fiscal', async () => {
  const page = (await synced()).body;
  assert.deepEqual(new Set(page.items.map(row => row.id)), new Set([sources.own.id, sources.fallback.id]));
  const allHistory = (await synced('?include_history=true')).body;
  assert.equal(allHistory.items.length, 3); assert.ok(allHistory.items.some(row => row.kind === 'event'));
  const first = (await synced('?include_history=true&limit=1')).body;
  assert.equal(first.has_more, true); assert.equal(first.next_cursor, first.items[0].id);
  const rest = (await synced(`?include_history=true&after=${first.next_cursor}`)).body;
  assert.equal(rest.items.length, 2); assert.ok(rest.items.every(row => row.id > first.next_cursor));
  assert.deepEqual((await synced('', f.users.fiscal)).body.items.map(row => row.id), [sources.foreign.id]);
  assert.deepEqual((await synced(`?q=${key(6)}`)).body.items, []);
});

test('004 direct synchronized downloads deny foreign, unlinked, anonymous, ambiguous, old-key and unmatched archives', async () => {
  for (const label of ['foreign', 'unlinked', 'anonymous', 'ambiguous', 'changedKey', 'legacy'])
    await notFound(() => synced(`/${sources[label].id}/download`, f.users.consulta, () => { throw Error('Storage must not be called'); }));
  for (const label of ['own', 'fallback']) {
    const result = await synced(`/${sources[label].id}/download`, f.users.consulta, fetchStored);
    assert.equal(result.type, 'download'); assert.deepEqual(result.bytes, sources[label].bytes);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  const historical = sources.own.rows[0];
  assert.deepEqual((await synced(`/${historical.id}/download`, f.users.consulta, fetchStored)).bytes, historical.bytes);
});

test('004 backup key scope filters totals and dedup counts and blocks direct legacy links', async () => {
  const page = (await history('?limit=1')).body;
  assert.equal(page.total, 1); assert.equal(page.has_more, false); assert.equal(page.next_offset, null);
  assert.equal(page.items[0].id, backupFiles.own.hash); assert.equal(page.items[0].occurrences, 2);
  assert.deepEqual(page.items[0].issues, ['SYNTHETIC_WARNING']);
  assert.equal((await history('?offset=1')).body.items.length, 0);
  for (const label of ['foreign', 'unlinked', 'anonymous', 'ambiguous', 'legacy'])
    await notFound(() => history(`/${backupFiles[label].hash}/download`, f.users.consulta, () => { throw Error('Storage must not be called'); }));
  assert.deepEqual((await history(`/${backupFiles.own.hash}/download`, f.users.consulta, fetchStored)).bytes, backupFiles.own.bytes);
});

test('004 administrator and fiscal without seller retain legacy XML; backup catalog remains unchanged', async () => {
  for (const user of [f.users.admin, unscoped]) {
    assert.equal((await synced('', user)).body.items.length, 8);
    assert.equal((await history('', user)).body.total, 6);
    assert.equal((await synced(`/${sources.legacy.id}/download`, user, fetchStored)).type, 'download');
    assert.equal((await history(`/${backupFiles.legacy.hash}/download`, user, fetchStored)).type, 'download');
  }
  assert.equal((await f.rpc('erp_history_backups', { p_user_id: f.users.consulta })).items.length, 1);
  const full = (await history('', f.users.admin)).body;
  const filtered = (await history('?model=65&kind=invoice', f.users.admin)).body;
  assert.deepEqual(filtered.items, full.items.filter(row => row.model === '65')); assert.equal(filtered.total, 1);
  const exact = (await history(`?q=${key(1)}`, f.users.admin)).body;
  assert.equal(exact.total, 1); assert.equal(exact.items[0].id, backupFiles.own.hash);
  const later = (await history('?limit=2&offset=1', f.users.admin)).body;
  assert.deepEqual(later.items, full.items.slice(1, 3)); assert.equal(later.total, 6); assert.equal(later.next_offset, 3);
  assert.equal((await history('?kind=event', f.users.admin)).body.total, 0);
});

test('004 module/role revocation protects all four XML RPCs while unmodified backup catalog stays available', async () => {
  await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',array['vendas.pedidos_venda'],1,clock_timestamp(),$2)", [f.users.consulta, f.users.admin]);
  try {
    for (const action of [() => synced(), () => synced(`/${sources.own.id}/download`, f.users.consulta, fetchStored), () => history(), () => history(`/${backupFiles.own.hash}/download`, f.users.consulta, fetchStored)])
      await assert.rejects(action, error => error.code === '42501');
    assert.equal((await f.rpc('erp_history_backups', { p_user_id: f.users.consulta })).items.length, 1);
  } finally { await f.db.query('delete from erp_access.user_control where user_id=$1', [f.users.consulta]); }
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, f.users.inactive]) {
    await assert.rejects(() => synced('', user), error => error.code === '42501');
    await assert.rejects(() => history('', user), error => error.code === '42501');
  }
});

test('004 HTTP second authorization check denies both downloads if contact ownership changes during Storage retrieval', async () => {
  for (const download of [fetch => synced(`/${sources.own.id}/download`, f.users.consulta, fetch), fetch => history(`/${backupFiles.own.hash}/download`, f.users.consulta, fetch)]) {
    try {
      await notFound(() => download(async path => {
        await f.db.query('update erp_catalog.contact_profile set seller_id=$2 where record_id=$1', [contactA.id, sellerB]);
        return fetchStored(path);
      }));
    } finally { await f.db.query('update erp_catalog.contact_profile set seller_id=$2 where record_id=$1', [contactA.id, sellerA]); }
  }
});

test('004 key scope uses the latest captured version when raw staging regresses', async () => {
  await beginScenario();
  try {
    await raw('201', 1, '101');
    await f.stage('nfe', '201', { id: '201', chaveAcesso: key(2), contato: { id: '102' }, situacao: 5 }, { version: 1 });
    assert.equal(await f.scalar("select access_key v from erp_fiscal_mirror.current where entity='nfe' and source_id='201'"), key(1));
    assert.equal((await synced(`/${sources.own.id}/download`, f.users.consulta, fetchStored)).type, 'download');
    assert.equal((await history(`/${backupFiles.own.hash}/download`, f.users.consulta, fetchStored)).type, 'download');
    await notFound(() => synced(`/${sources.foreign.id}/download`, f.users.consulta, fetchStored));
  } finally { await endScenario(); }
});

test('004 tags reads enforce module and seller scope; mirror writes cannot create commands even for admin', async () => {
  await beginScenario();
  try {
    const tag = (await f.rpc('erp_catalog_taxonomy_save', { p_user_id: f.users.admin, p_kind: 'tags', p_id: null, p_expected_version: 0,
      p_command_id: randomUUID(), p_data: { name: 'Marcador fiscal sintético', tag_type: 'invoices' } })).item;
    await f.db.query("insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('origin','55','201',$1),('origin','55','202',$1)", [tag.id]);
    const readTags = (ids, user = f.users.consulta) => f.rpc('erp_catalog_invoice_tags', { p_user_id: user, p_origin: 'origin', p_model: '55', p_ids: `{${ids.join(',')}}` });
    assert.equal((await readTags(['201'])).items[0].tags[0].name, 'Marcador fiscal sintético');
    await notFound(() => readTags(['202'])); await notFound(() => readTags(['201', '202'])); await notFound(() => readTags(['999999']));
    assert.equal((await readTags(['201', '202'], f.users.admin)).items.length, 2);
    const priorCommands = await f.scalar('select count(*) v from erp_catalog.command');
    for (const user of [f.users.admin, f.users.fiscal]) {
      await assert.rejects(() => f.rpc('erp_catalog_invoice_tags_save', { p_user_id: user, p_origin: 'origin', p_model: '55', p_id: '201',
        p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [], p_mode: 'replace' }), error => error.code === '42501');
    }
    assert.equal(await f.scalar('select count(*) v from erp_catalog.command'), priorCommands);
    await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',array['vendas.pedidos_venda'],1,clock_timestamp(),$2)", [f.users.consulta, f.users.admin]);
    await assert.rejects(() => readTags(['201']), error => error.code === '42501');
  } finally { await endScenario(); }
});

test('004 native tag edits keep normal CAS/replay but recheck seller access before replay', async () => {
  await beginScenario();
  try {
    const nature = (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create',
      p_data: { nature: { description: 'Natureza sintética carteira', direction: '1', crt: '1' } } })).nature;
    const native = async contact => (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: {
      model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: nature.id, issue_date: '2026-10-22', crt: '1', purpose: '1', presence: '1', final_consumer: false,
      recipient: { contact_id: contact.id, name: 'Cliente sintético', person_type: 'J', document: '11222333000181', state: 'SP' },
      items: [{ description: 'Item sintético', quantity: '1', unit_price: '20' }],
    } } })).invoice;
    const own = await native(contactB), foreign = await native(contactA);
    const args = { p_user_id: f.users.fiscal, p_origin: 'brufap', p_model: '55', p_id: own.id,
      p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [], p_mode: 'replace' };
    assert.equal((await f.rpc('erp_catalog_invoice_tags_save', args)).replayed, false);
    assert.equal((await f.rpc('erp_catalog_invoice_tags_save', args)).replayed, true);
    await notFound(() => f.rpc('erp_catalog_invoice_tags_save', { ...args, p_id: foreign.id, p_command_id: randomUUID() }));
    await notFound(() => f.rpc('erp_catalog_invoice_tags', { p_user_id: f.users.fiscal, p_origin: 'brufap', p_model: '55', p_ids: `{${foreign.id}}` }));
    await f.db.query('update erp_catalog.contact_profile set seller_id=$2 where record_id=$1', [contactB.id, sellerA]);
    await notFound(() => f.rpc('erp_catalog_invoice_tags_save', args));
  } finally { await endScenario(); }
});

test('004 keeps private grants, immutable archives, native effects and original byte-integrity checks', async () => {
  for (const signature of signatures) {
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, signature]), false);
  }
  for (const signature of ['erp_fiscal_mirror.archive_visible_keys(uuid)', 'erp_fiscal_mirror.archive_key_visible(uuid,text)', 'erp_fiscal_mirror.archive_source_visible(uuid,text,text,text)'])
    for (const role of ['service_role', 'anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, signature]), false);
  for (const table of ['origin_fiscal.source', 'origin_fiscal.object', 'origin_fiscal.revision', 'origin_fiscal.item', 'origin_backup.record'])
    for (const role of ['service_role', 'anon', 'authenticated']) assert.equal(await f.scalar("select has_table_privilege($1,$2,'SELECT') v", [role, table]), false);
  await assert.rejects(() => f.db.query("update origin_fiscal.object set metadata='{}' where hash=$1", [sources.own.hash]), error => error.code === '55000');
  const wrongBytes = Uint8Array.from(sources.own.bytes); wrongBytes[0] ^= 1;
  await assert.rejects(() => synced(`/${sources.own.id}/download`, f.users.consulta, () => new Response(wrongBytes)), error => error.code === 'ERP_SYNCED_XML_INTEGRITY_FAILURE');
  await assert.rejects(() => history(`/${backupFiles.own.hash}/download`, f.users.consulta, () => new Response(wrongBytes)), error => error.code === 'ERP_HISTORY_INTEGRITY_FAILURE');
  for (const table of ['erp_fiscal_invoices.invoice', 'erp_stock.movement', 'erp_stock.balance', 'erp_finance.title']) assert.equal(Number(await f.scalar(`select count(*) v from ${table}`)), 0);
});

test('004 refuses drift in any pinned prior function before installing helpers or replacing anything', async () => {
  const g = await base();
  try {
    for (const signature of signatures) {
      const original = await g.scalar('select pg_get_functiondef($1::regprocedure) v', [signature]);
      const changed = original.replace('AS $function$', () => 'AS $function$\n-- synthetic drift\n');
      assert.notEqual(changed, original); await g.db.exec(changed);
      await assert.rejects(() => g.migrate(MIGRATION), error => error.code === '55000' && /previous_definition_changed/.test(error.message));
      await g.db.exec('rollback');
      assert.equal(await g.scalar("select to_regprocedure('erp_fiscal_mirror.archive_key_visible(uuid,text)')::text v"), null);
      await g.db.exec(original);
    }
  } finally { await g.close(); }
});

test('004 indexed scope handles 5000 synthetic backup XML identities without native writes', async t => {
  await beginScenario();
  try {
    const stressBackup = sha('synthetic-fiscal-scope-load');
    await f.db.query("insert into origin_backup.batch(backup_sha,manifest,status) values($1,'{}','stored')", [stressBackup]);
    await f.db.exec(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,version,last_seen_at)
      select 'nfe','nfe',(900000+n)::text,jsonb_build_object('id',(900000+n)::text,'chaveAcesso',lpad(n::text,20,'0')||'55'||lpad(n::text,22,'0'),'contato',jsonb_build_object('id','101'),'situacao',5),
        encode(sha256(convert_to(n::text,'UTF8')),'hex'),1,'2026-10-22T12:00:00Z' from generate_series(1,5000)n;
      analyze origin_sync.raw_record; analyze erp_fiscal_mirror.current;`);
    await f.db.query(`insert into origin_backup.record(backup_sha,kind,file_id,record_no,data)
      select $1,'xml',encode(sha256(convert_to(n::text,'UTF8')),'hex'),0,jsonb_build_object('sha256',encode(sha256(convert_to(n::text,'UTF8')),'hex'),
        'key',lpad(n::text,20,'0')||'55'||lpad(n::text,22,'0'),'model','55','environment','1','kind','invoice') from generate_series(1,5000)n`, [stressBackup]);
    await f.db.exec('analyze origin_backup.record');
    const plan = await f.db.query("explain (format json) select source_id from origin_sync.raw_record where entity in('nfe','nfce') and payload->>'chaveAcesso'=$1", ['0'.repeat(19) + '1' + '55' + '0'.repeat(21) + '1']);
    assert.match(JSON.stringify(plan.rows), /fiscal_xml_raw_key/);
    const started = performance.now();
    const args = { p_user_id: f.users.consulta, p_backup_sha: stressBackup, p_limit: 100 };
    const result = await f.rpc('erp_history_xml', args);
    const elapsed = performance.now() - started;
    assert.equal(result.total, 5000); assert.equal(result.items.length, 100); assert.equal(result.has_more, true);
    const legacySource = await readFile(new URL('../../../supabase/migrations/202610160007_erp_history.sql', import.meta.url), 'utf8');
    const legacyStart = legacySource.indexOf('create function public.erp_history_xml(');
    const legacyEnd = legacySource.indexOf('$$;', legacySource.indexOf('as $$', legacyStart) + 5) + 3;
    await f.db.exec(legacySource.slice(legacyStart, legacyEnd).replace('public.erp_history_xml(', 'public.erp_history_xml_baseline('));
    const legacyStarted = performance.now(), legacy = await f.rpc('erp_history_xml_baseline', args), legacyElapsed = performance.now() - legacyStarted;
    assert.deepEqual(result, legacy, 'the same entirely visible acervo keeps every field, total, issue and ordering from 007');
    t.diagnostic(`5000 backup XML identities, page 100: scoped ${elapsed.toFixed(1)} ms; legacy 007 ${legacyElapsed.toFixed(1)} ms in PGlite with identical data/statistics.`);
    if (process.env.FISCAL_XML_SCOPE_EXPLAIN === '1') {
      const definition = await f.scalar("select prosrc v from pg_proc where oid='public.erp_history_xml(uuid,text,integer,integer,text,text,text)'::regprocedure");
      let sql = definition.slice(definition.indexOf('with visible_keys'), definition.indexOf(' into v_result;'));
      for (const [name, type, index] of [['p_backup_sha', 'text', 1], ['v_scope', 'uuid', 2], ['p_query', 'text', 3], ['p_model', 'text', 4], ['p_kind', 'text', 5], ['p_limit', 'integer', 6], ['p_offset', 'integer', 7]])
        sql = sql.replaceAll(new RegExp(`\\b${name}\\b`, 'g'), () => `$${index}::${type}`);
      const explanation = (await f.db.query(`explain (analyze,format json) ${sql}`, [stressBackup, sellerA, null, null, null, 100, 0])).rows[0]['QUERY PLAN'];
      const nodes = [], walk = node => { nodes.push({ type: node['Node Type'], relation: node['Relation Name'], name: node['Subplan Name'], time: node['Actual Total Time'], loops: node['Actual Loops'], rows: node['Actual Rows'] }); for (const child of node.Plans ?? []) walk(child); };
      walk(explanation[0].Plan); t.diagnostic(JSON.stringify(nodes.filter(node => node.time * node.loops > 100)));
    }
    assert.ok(elapsed < 8000, 'the scoped 5000-row count and maximum page must fit the HTTP deadline');
  } finally { await endScenario(); }
});
