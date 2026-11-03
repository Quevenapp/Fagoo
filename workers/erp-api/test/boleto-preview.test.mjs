import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseCnabRoute, executeCnabRoute } from '../src/cnab.mjs';
import { parseCnabOperationalRoute, executeCnabOperationalRoute } from '../src/cnab-operational.mjs';
import { parseBoletoPreviewRoute, executeBoletoPreviewRoute, boletoPreviewMethods } from '../src/boleto-preview.mjs';
import { createItau109PrintPreview } from '../../../packages/boleto-preview/src/index.mjs';
import { fixture as printFixture } from '../../../packages/boleto-preview/test/fixtures.mjs';
import { boletoItems, boletoPreview } from '../../../apps/erp/src/lib/boleto-preview-model.ts';

let db, today, company, contact, profile, homo, operational, inTransaction = false;
const users = {}, files = new Map(), ids = [], RPC = 'erp_cnab_itau_boleto_context';
const scalar = async (sql, values = []) => (await db.query(sql, values)).rows[0].v;
const sqlError = code => error => error.code === code;
const status = value => error => error.status === value;
const clone = value => structuredClone(value);
async function rpc(name, args) {
  assert.match(name, /^erp_[a-z_]+$/);
  const pairs = Object.entries(args);
  if (inTransaction) await db.exec('savepoint rpc_call');
  await db.exec('set role service_role');
  try { return await scalar(`select public.${name}(${pairs.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) v`, pairs.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value)); }
  catch (error) { if (inTransaction) await db.exec('rollback to savepoint rpc_call'); throw error; }
  finally { await db.exec('reset role'); if (inTransaction) await db.exec('release savepoint rpc_call'); }
}
const finance = (action, data) => rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const request = (path, body) => new Request('https://synthetic.invalid' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function storeFile({ bucket, path, bytes, upsert }) {
  assert.equal(bucket, 'brufap-cnab'); assert.equal(upsert, false);
  files.set(path, bytes.slice());
  await db.query('insert into storage.objects values($1,$2,$3)', [bucket, path, JSON.stringify({ size: bytes.length, mimetype: 'application/octet-stream' })]);
}
const getFile = async ({ bucket, path }) => { assert.equal(bucket, 'brufap-cnab'); return files.get(path).slice(); };
const ports = extra => ({ userId: users.financeiro, rpc, getFile, storeFile, ...extra });
const legacy = async (path, body, extra) => executeCnabRoute(await parseCnabRoute(request('/v1/cnab' + path, body)), ports(extra));
const op = async (path, body, extra) => executeCnabOperationalRoute(await parseCnabOperationalRoute(request('/v1/cobranca-operacional' + path, body)), ports(extra));
const context = (id = homo.billing, user = users.financeiro) => rpc(RPC, { p_user_id: user, p_billing_title_id: id });
const route = id => parseBoletoPreviewRoute(request(`/v1/boletos-itau/${id}/preview`));
const preview = (id = homo.billing, extra = {}) => executeBoletoPreviewRoute(route(id), ports(extra));
const list = (id = homo.ack.id, extra = {}) => executeBoletoPreviewRoute(parseBoletoPreviewRoute(request(`/v1/boletos-itau/remittances/${id}/items`)), ports(extra));
const digest = () => scalar(`select encode(sha256(convert_to(jsonb_build_object(
  'profile',(select jsonb_agg(to_jsonb(t)order by id)from erp_cnab.profile t),
  'remittance',(select jsonb_agg(to_jsonb(t)order by id)from erp_cnab.remittance t),
  'billing',(select jsonb_agg(to_jsonb(t)order by id)from erp_cnab.billing_title t),
  'cnab_commands',(select jsonb_agg(to_jsonb(t)order by id)from erp_cnab.command t),
  'cnab_audit',(select jsonb_agg(to_jsonb(t)order by id)from erp_cnab.audit t),
  'titles',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.title t),
  'finance_commands',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.command t),
  'settlements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.settlement t),
  'movements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.movement t),
  'objects',(select jsonb_agg(to_jsonb(t)order by name)from storage.objects t))::text,'UTF8')),'hex')v`);
async function createReady(purpose, { amount = '12345', number = 'TESTE/001' } = {}) {
  const t = (await finance('title_create_group', { kind: 'receivable', contact_id: contact.id, description: 'TITULO FICTICIO', issued_on: today, total_cents: amount, installments: [{ amount_cents: amount, due_on: today }] })).items[0];
  const version = await scalar('select version v from erp_cnab.profile where id=$1', [profile.id]);
  const body = { command_id: randomUUID(), profile_id: profile.id, expected_version: version, generated_on: today, titles: [{ title_id: t.id, expected_version: t.version, document_number: number }] };
  let ack;
  if (purpose === 'operational') {
    const p = { ...body, expected_approval_version: 1, confirm_operational: false };
    const evidence = (await op('/remittances/preview', p)).body;
    ack = (await op('/remittances', { ...p, confirm_operational: true, preview_hash: evidence.preview_hash })).body;
  } else ack = (await legacy('/remittances', body)).body;
  const billing = await scalar('select id v from erp_cnab.billing_title where title_id=$1', [t.id]);
  ids.push(t.id); return { ack, billing, title: t };
}

before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  for (const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0024_cnab_human_review','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import','0042_cnab_operational','0066_itau_boleto_preview']) {
    await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`, import.meta.url), 'utf8'));
  }
  await db.exec("insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");
  for (const role of ['admin','financeiro','consulta','vendas']) {
    users[role] = randomUUID(); await db.query('insert into auth.users values($1)', [users[role]]);
    await db.query('insert into erp_access.membership(user_id,role)values($1,$2)', [users[role], role]);
  }
  today = await scalar("select(clock_timestamp()at time zone'America/Sao_Paulo')::date::text v");
  const account = (await finance('account_save', { expected_version: 0, name: 'CONTA FICTICIA', kind: 'bank' })).record;
  const synthetic = printFixture();
  company = { legal_name: 'EMPRESA FICTICIA', cnpj: synthetic.boleto.profile.cnpj, postal_code: '01001000', street: 'RUA FICTICIA', number: '100', district: 'TESTE', city: 'SAO PAULO', municipality_code: '3550308', state: 'SP' };
  await rpc('erp_company_save_identity', { p_user_id: users.admin, p_command_id: randomUUID(), p_expected_version: 0, p_data: company });
  contact = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'PAGADOR FICTICIO', person_type: 'F', document: '12345678909', street: 'RUA FICTICIA', number: '1', district: 'TESTE', city: 'SAO PAULO', state: 'SP', postal_code: '01001000', roles: ['customer'] } })).record;
  const { accountId, ...p } = synthetic.boleto.profile;
  profile = (await legacy('/profiles', { command_id: randomUUID(), expected_version: 0, data: { ...p, account_id: account.id, ourNumberStart: '00000001', remittanceSequenceStart: '1' } }, { userId: users.admin })).body.profile;
  await op(`/profiles/${profile.id}/approval`, { command_id: randomUUID(), expected_approval_version: 0, expected_profile_version: profile.version, expected_identity_version: 1, enabled: true, confirmed_on: today, reference: 'DECLARACAO SINTETICA SEM AUTORIZACAO BANCARIA' }, { userId: users.admin });
  homo = await createReady('homologation'); operational = await createReady('operational', { number: 'TESTE/002' });
});
beforeEach(async () => { await db.exec('begin'); inTransaction = true; });
afterEach(async () => { await db.exec('rollback'); inTransaction = false; });
after(() => db?.close());

test('066 real SQL→encoder→stored bytes→print matches exact money, number and DV with no writes', async () => {
  const before = await digest();
  for (const record of [homo, operational]) {
    const raw = await context(record.billing), result = (await preview(record.billing)).body;
    assert.equal(result.binding.amountCents, '12345'); assert.equal(result.binding.ourNumberWithDigit, raw.our_number);
    assert.equal(result.binding.dueOn, today); assert.equal(result.source.remittance_hash, record.ack.file_hash);
    assert.equal(result.source_purpose, raw.source_purpose); assert.equal(result.current.company_identity_version, 1);
    assert.equal(result.persisted_number_binding_checked, true);
    assert.ok(!result.pending.includes('PERSISTED_NUMBER_ALLOCATION_NOT_CHECKED'));
    assert.equal(result.numberAllocationVerified, false); // No bank allocation evidence is asserted.
    assert.equal(result.beneficiary_address_source, 'company_identity_current'); assert.match(result.html, /NÃO PAGAR/);
    assert.equal(result.htmlHash, createHash('sha256').update(result.html).digest('hex'));
    assert.equal(result.sizeBytes, Buffer.byteLength(result.html));
    for (const key of ['canPay','canIssue','canTransmit','financialMutationPerformed','bankTransmissionPerformed','persisted','counters_changed']) assert.equal(result[key], false, key);
    assert.doesNotMatch(JSON.stringify(result), /"(?:snapshot|billing_snapshot|manifest|object_path|file|path|private_context)":/);
    const expected = printFixture();
    expected.boleto.profile = Object.fromEntries(Object.keys(expected.boleto.profile).map(k => [k, raw.snapshot.profile[k]]));
    expected.boleto.title = { amountCents: '12345', dueOn: today, referenceOn: today };
    expected.boleto.allocation.ourNumber = raw.billing_snapshot.title.ourNumber;
    expected.document = { number: raw.billing_snapshot.title.documentNumber, issuedOn: today, processedOn: today };
    expected.beneficiaryAddress = raw.beneficiary.address; expected.payer = raw.billing_snapshot.title.payer;
    assert.equal(result.html, (await createItau109PrintPreview(expected)).html);
  }
  assert.equal(await digest(), before);
  await db.exec('set transaction read only');
  assert.equal((await context()).read_only, true);
});

test('066 is a service-only GET surface with current finance read ACL', async () => {
  assert.deepEqual(boletoPreviewMethods(), ['GET']);
  assert.equal(parseBoletoPreviewRoute(request('/v1/other')), null);
  for (const role of ['admin','financeiro','consulta']) assert.equal((await preview(homo.billing, { userId: users[role] })).body.canPay, false);
  await assert.rejects(() => context(homo.billing, users.vendas), sqlError('42501'));
  await assert.rejects(() => preview(homo.billing, { userId: users.vendas }), status(403));
  await assert.rejects(() => preview(randomUUID()), status(404));
  for (const role of ['anon','authenticated']) assert.equal(await scalar("select has_function_privilege($1,'public.erp_cnab_itau_boleto_context(uuid,uuid)','EXECUTE')v", [role]), false);
  assert.equal(await scalar("select has_function_privilege('service_role','public.erp_cnab_itau_boleto_context(uuid,uuid)','EXECUTE')v"), true);
  let io = 0;
  await assert.rejects(() => executeBoletoPreviewRoute({ kind: 'preview', id: homo.billing }, { userId: users.admin, rpc: () => ++io, getFile: () => ++io }), status(400));
  await assert.rejects(() => preview(homo.billing, { userId: undefined, rpc: () => ++io }), status(401)); assert.equal(io, 0);
  for (const suffix of ['?q=1','/extra']) assert.throws(() => parseBoletoPreviewRoute(request(`/v1/boletos-itau/${homo.billing}/preview${suffix}`)), status(400));
  assert.throws(() => parseBoletoPreviewRoute(request(`/v1/boletos-itau/${homo.billing}/preview`, {})), status(405));
});

test('066 minimal discovery SQL→HTTP→UI binds ready remittance and IDs without promising print eligibility', async () => {
  const before = await digest();
  for (const record of [homo, operational]) {
    let fileReads = 0;
    const result = (await list(record.ack.id, { getFile: () => { fileReads++; throw Error('No file read in discovery'); } })).body;
    assert.equal(fileReads, 0);
    const source = { id: record.ack.id, profile_id: profile.id, file_hash: record.ack.file_hash, kind: 'remittance', state: 'ready' };
    const items = boletoItems(result, source, record === homo ? 'homologation' : 'operational');
    assert.deepEqual(items.items.map(row => [row.billing_title_id, row.finance_title_id]), [[record.billing, record.title.id]]);
    const rendered = await boletoPreview((await preview(record.billing)).body, items, items.items[0]);
    assert.equal(rendered.source.remittance_hash, result.remittance_hash);
    assert.doesNotMatch(JSON.stringify(result), /"(?:payer|name|snapshot|manifest|bucket|path|our_number|private_context)":/);
  }
  for (const role of ['admin','financeiro','consulta']) assert.equal((await list(homo.ack.id, { userId: users[role] })).body.read_only, true);
  await assert.rejects(() => list(homo.ack.id, { userId: users.vendas }), status(403));
  await assert.rejects(() => list(randomUUID()), status(404));
  for (const role of ['anon','authenticated']) assert.equal(await scalar("select has_function_privilege($1,'public.erp_cnab_itau_boleto_items(uuid,uuid)','EXECUTE')v", [role]), false);
  assert.equal(await scalar("select has_function_privilege('service_role','public.erp_cnab_itau_boleto_items(uuid,uuid)','EXECUTE')v"), true);
  assert.equal(await digest(), before);
  await db.exec('set transaction read only');
  assert.equal((await list()).body.items.length, 1);
});

test('066 discovery refuses foreign/unready or malformed bindings; unsupported print values remain explicitly listable', async () => {
  const probes = [
    ["update erp_cnab.remittance set state='reserved',object_path=null,file_hash=null,byte_size=null,manifest=null,finalized_at=null where id=$1", [homo.ack.id], 409],
    ["update erp_cnab.profile set identity=jsonb_set(identity,'{wallet}','\"110\"')where id=$1", [profile.id], 422],
    ["update erp_cnab.billing_title set snapshot=jsonb_set(snapshot,'{finance_title_id}',to_jsonb($2::text))where id=$1", [homo.billing, randomUUID()], 409],
    ["update erp_cnab.remittance set snapshot=jsonb_set(snapshot,'{titles}','[]')where id=$1", [homo.ack.id], 409],
  ];
  for (const [sql,args,expected] of probes) {
    await db.exec('savepoint list_probe'); await db.query(sql,args);
    await assert.rejects(() => list(), status(expected)); await db.exec('rollback to savepoint list_probe');
  }
  const unsupported = await createReady('homologation', { amount: '10000000000', number: 'A B' });
  const result = (await list(unsupported.ack.id)).body;
  assert.equal(result.items[0].amount_cents, '10000000000'); assert.equal(result.items[0].document_number, 'A B');
  await assert.rejects(() => preview(unsupported.billing), status(422));
});

test('066 never silently truncates barcode amount or unsupported document references', async () => {
  const before = await digest();
  const large = await createReady('homologation', { amount: '10000000000', number: 'MAX/001' });
  await assert.rejects(() => context(large.billing), sqlError('0A000'));
  const spaced = await createReady('homologation', { number: 'A B' });
  await assert.rejects(() => preview(spaced.billing), status(422));
  const maximum = await createReady('homologation', { amount: '9999999999', number: 'MAX/002' });
  const afterFixture = await digest();
  assert.equal((await preview(maximum.billing)).body.binding.amountCents, '9999999999');
  assert.equal(await digest(), afterFixture); assert.notEqual(afterFixture, before);
});

test('066 native title/contact/profile drift and non-ready reservations fail closed', async () => {
  const probes = [
    ['update erp_finance.title set version=version+1 where id=$1', [homo.title.id]],
    ['update erp_finance.title set cancelled=true where id=$1', [homo.title.id]],
    ['update erp_finance.title set settled_cents=1 where id=$1', [homo.title.id]],
    ['update erp_catalog.record set version=version+1 where id=$1', [contact.id]],
    ["update erp_cnab.profile set settings=jsonb_set(settings,'{companyName}','\"CHANGED\"')where id=$1", [profile.id]],
    ["update erp_cnab.remittance set state='reserved',object_path=null,file_hash=null,byte_size=null,manifest=null,finalized_at=null where id=$1", [homo.ack.id]],
    ["update erp_finance.account set active=false where id=(select account_id from erp_cnab.profile where id=$1)", [profile.id]],
  ];
  for (const [sql, args] of probes) {
    await db.exec('savepoint probe'); await db.query(sql, args);
    await assert.rejects(() => preview(), status(409)); await db.exec('rollback to savepoint probe');
  }
});

test('066 rejects missing/private Storage metadata and independently bound snapshots before file IO', async () => {
  const c = await context();
  const probes = [
    ["update storage.buckets set public=true where id='brufap-cnab'", []],
    ['delete from storage.objects where name=$1', [c.file.path]],
    ["update storage.objects set metadata=jsonb_set(metadata,'{size}','1')where name=$1", [c.file.path]],
    ["update erp_cnab.remittance set manifest=jsonb_set(manifest,'{0,amountCents}','\"1\"')where id=$1", [homo.ack.id]],
    ["update erp_cnab.billing_title set snapshot=jsonb_set(snapshot,'{finance_title_id}',to_jsonb($2::text))where id=$1", [homo.billing, randomUUID()]],
  ];
  for (const [sql, args] of probes) {
    await db.exec('savepoint storage_probe'); await db.query(sql, args); let reads = 0;
    await assert.rejects(() => preview(homo.billing, { getFile: async key => { reads++; return getFile(key); } }), e => [409,422].includes(e.status));
    assert.equal(reads, 0); await db.exec('rollback to savepoint storage_probe');
  }
});

test('066 current beneficiary address is explicit; CNPJ mismatch and stale operational identity block', async () => {
  const original = await context();
  await rpc('erp_company_save_identity', { p_user_id: users.admin, p_command_id: randomUUID(), p_expected_version: 1, p_data: { ...company, street: 'RUA REVISADA' } });
  const next = (await preview()).body;
  assert.equal(next.source.company_identity_version, 2); assert.match(next.html, /RUA REVISADA/);
  assert.notEqual(next.source.context_hash, original.context_hash); assert.equal(next.source.snapshot_hash, original.snapshot_hash);
  await assert.rejects(() => preview(operational.billing), status(409));
  await db.query("update erp_company.identity set data=jsonb_set(data,'{cnpj}','\"11222333000181\"')where singleton");
  await assert.rejects(() => preview(), status(409));
});

test('066 authorization, current context and operational approval are rechecked after Storage', async () => {
  const before = await digest();
  await assert.rejects(() => preview(homo.billing, { getFile: async key => { const b = await getFile(key); await db.query('update erp_access.membership set active=false where user_id=$1', [users.financeiro]); return b; } }), status(403));
  await db.query('update erp_access.membership set active=true where user_id=$1', [users.financeiro]);
  await assert.rejects(() => preview(homo.billing, { getFile: async key => { const b = await getFile(key); await db.query('update erp_finance.title set version=version+1 where id=$1', [homo.title.id]); return b; } }), status(409));
  await db.query('update erp_finance.title set version=version-1 where id=$1', [homo.title.id]);
  await db.exec('savepoint revoke_approval');
  await assert.rejects(() => preview(operational.billing, { getFile: async key => {
    const b = await getFile(key), version = await scalar('select version v from erp_cnab.profile where id=$1', [profile.id]);
    await op(`/profiles/${profile.id}/approval`, { command_id: randomUUID(), expected_approval_version: 1, expected_profile_version: version, expected_identity_version: 1, enabled: false, confirmed_on: today, reference: 'SYNTHETIC REVOCATION' }, { userId: users.admin }); return b;
  } }), status(409));
  await db.exec('rollback to savepoint revoke_approval');
  assert.equal(await digest(), before);
});

test('066 malformed bindings, manifest and hash evidence cannot reach output', async () => {
  const base = await context();
  const probes = [
    x => { x.manifest[0].amountCents = '999'; },
    x => { x.file.hash = 'a'.repeat(64); x.file.path = `profiles/${x.profile_id}/remittances/${x.file.hash}.rem`; },
    x => { x.our_number = x.our_number.slice(0, 8) + ((Number(x.our_number.at(-1)) + 1) % 10); x.manifest[0].ourNumber = x.our_number; },
    x => { x.current.title_version++; },
    x => { x.file.path = 'https://evil.invalid/x'; },
    x => { x.beneficiary.cnpj = '11222333000181'; },
    x => { x.snapshot.titles[0].collectionTerms = {}; },
    x => { x.secret = 'MUST_NOT_RETURN'; },
  ];
  for (const mutate of probes) {
    const x = clone(base); mutate(x); let reads = 0;
    await assert.rejects(() => preview(homo.billing, { rpc: async () => x, getFile: async key => { reads++; return getFile(key); } }), e => [409,502].includes(e.status));
    assert.ok(reads <= 1);
  }
  let getter = false;
  const malicious = clone(base); Object.defineProperty(malicious, 'snapshot', { enumerable: true, get() { getter = true; throw Error('secret'); } });
  await assert.rejects(() => preview(homo.billing, { rpc: async () => malicious }), status(502)); assert.equal(getter, false);
  await assert.rejects(() => preview(homo.billing, { rpc: async () => { throw Error('PRIVATE_PROVIDER_BODY'); } }), e => e.status === 502 && !e.message.includes('PRIVATE_PROVIDER_BODY'));
});

test('066 stored body is bounded, exact, cancelled and copied without mutating port buffers', async () => {
  const c = await context(), original = files.get(c.file.path).slice(), owned = original.slice();
  assert.equal((await preview(homo.billing, { getFile: async () => owned })).body.binding.amountCents, '12345');
  assert.deepEqual(owned, original);
  const buffer = Buffer.concat([Buffer.from([7]), Buffer.from(original), Buffer.from([8])]), view = buffer.subarray(1, -1);
  assert.equal((await preview(homo.billing, { getFile: async () => view })).body.binding.amountCents, '12345');
  assert.deepEqual(new Uint8Array(view), original); assert.equal(buffer[0], 7); assert.equal(buffer.at(-1), 8);
  const shared = new Uint8Array(new SharedArrayBuffer(original.length)); shared.set(original);
  await assert.rejects(() => preview(homo.billing, { getFile: async () => shared }), status(502));
  const corrupt = original.slice(); corrupt[100] ^= 1;
  await assert.rejects(() => preview(homo.billing, { getFile: async () => corrupt }), status(409));
  for (const headers of [{ 'content-encoding': 'gzip' }, { 'content-type': 'text/plain' }, { 'content-length': '1' }]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/octet-stream', ...headers } });
    await assert.rejects(() => preview(homo.billing, { getFile: async () => response }), status(502));
    assert.equal(cancelled, 1);
  }
  const response = new Response(original, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(original.length) } });
  assert.equal((await preview(homo.billing, { getFile: async () => response })).body.source.remittance_hash, c.file.hash);
  const short = new Response(original.subarray(1), { headers: { 'content-type': 'application/octet-stream' } });
  await assert.rejects(() => preview(homo.billing, { getFile: async () => short }), status(502));
});

test('066 callback-owned mutations do not change the captured print; interrupted reads never return late HTML', async () => {
  const base = await context(), object = clone(base); let reads = 0;
  const result = await preview(homo.billing, { rpc: async () => ++reads === 1 ? object : clone(base), getFile: async key => { object.snapshot.titles[0].amountCents = '99999'; object.beneficiary.address.address = 'MUTATED'; return getFile(key); } });
  assert.equal(result.body.binding.amountCents, '12345'); assert.doesNotMatch(result.body.html, /MUTATED/);
  const abort = new AbortController(); abort.abort(); let io = 0;
  await assert.rejects(() => preview(homo.billing, { signal: abort.signal, rpc: async () => ++io }), status(504)); assert.equal(io, 0);
  await assert.rejects(() => preview(homo.billing, { deadline: String(Date.now() + 1000) }), status(400));
  let release; const pending = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const inflight = preview(homo.billing, { signal: controller.signal, getFile: async () => { controller.abort(); return pending; } });
  await assert.rejects(() => inflight, status(504)); release(files.get(base.file.path).slice());
  let cancelled = 0;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/octet-stream' } });
  await assert.rejects(() => preview(homo.billing, { deadline: Date.now() + 100, getFile: async () => stalled }), status(504));
  assert.equal(cancelled, 1);
});
