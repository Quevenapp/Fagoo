import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parseFinancialImportRoute, executeFinancialImportRoute } from '../../workers/erp-api/src/financial-import.mjs';

// Independent probes, synthetic in-memory data only. PGlite does not prove
// concurrent PostgreSQL interleavings; lock ordering is reviewed separately.
let db, contact, today, serial = 900000;
const users = {};
const code = expected => error => error.code === expected;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
async function rpc(name, args) {
  const entries = Object.entries(args);
  await db.exec('SET ROLE service_role');
  try {
    return await scalar(`SELECT public.${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(',')}) AS value`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
  } finally { await db.exec('RESET ROLE'); }
}
const preview = (items, entity = 'receivables', actor = users.admin) => rpc('erp_origin_financial_import_preview', { p_user_id: actor, p_entity: entity, p_items: items, p_duplicate_reviewed: true });
const apply = (items, review, command = randomUUID(), entity = 'receivables', actor = users.admin) => rpc('erp_origin_financial_import_apply', { p_user_id: actor, p_entity: entity, p_items: items, p_duplicate_reviewed: true, p_command_id: command, p_preview_hash: review.preview_hash, p_confirm_import: true });
const execute = (action, data, command = randomUUID(), actor = users.admin) => rpc('erp_finance_execute', { p_user_id: actor, p_command_id: command, p_action: action, p_data: data });
const prefix = '/v1/importacao-financeira-origin';
async function api(path, body, rpcImpl = rpc, actor = users.admin) {
  const route = await parseFinancialImportRoute(new Request('https://erp.invalid' + prefix + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined));
  return executeFinancialImportRoute(route, { userId: actor, rpc: rpcImpl });
}
async function raw(entity, id, payload) {
  return scalar(`INSERT INTO origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)
    VALUES($1,'independent_import_seed',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'),clock_timestamp()-interval '1 minute')
    RETURNING jsonb_build_object('source_id',source_id,'source_hash',version_hash,'source_version',version::text,'source_seen_at',last_seen_at) AS value`, [entity, id, typeof payload === 'string' ? payload : JSON.stringify(payload)]);
}
async function source(extra = {}, options = {}) {
  const id = String(++serial), entity = options.entity || 'receivables';
  const payload = { id, situacao: 1, valor: 25.7, saldo: 25.7, historico: `Synthetic title ${id}`, dataEmissao: today, vencimento: today, contato: { id: '101' }, ocorrencia: { tipo: 1 }, ...extra };
  const item = await raw(entity, id, options.money ? JSON.stringify(payload).replace('"valor":25.7', `"valor":${options.money}`).replace('"saldo":25.7', `"saldo":${options.money}`) : payload);
  if (options.ageMinutes) item.source_seen_at = await scalar("UPDATE origin_sync.raw_record SET last_seen_at=clock_timestamp()-make_interval(mins=>$3::int) WHERE entity=$1 AND source_id=$2 RETURNING to_jsonb(last_seen_at) AS value", [entity, id, options.ageMinutes]);
  await db.query('INSERT INTO origin_finance_refresh.origin(entity,source_id) VALUES($1,$2)', [entity, id]);
  const attempt = randomUUID();
  await db.query(`INSERT INTO origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status,state,started_at,finished_at,response_hash,response_status,result_hash,result_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,'1','stored',$7::timestamptz-interval '2 seconds',$7::timestamptz-interval '1 second',$6,'1',$6,$8::bigint)`, [attempt, entity, id, randomUUID(), randomUUID(), item.source_hash, item.source_seen_at, item.source_version]);
  await db.query(`UPDATE origin_finance_refresh.origin SET current_attempt=$3,last_attempt_at=$4::timestamptz-interval '2 seconds',last_success_at=$4::timestamptz-interval '1 second' WHERE entity=$1 AND source_id=$2`, [entity, id, attempt, item.source_seen_at]);
  return { ...item, category_id: null, category_version: null };
}
const ledger = () => Promise.all(['title', 'command', 'audit', 'settlement', 'movement', 'origin_import_origin'].map(table => scalar(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') AS value FROM erp_finance.${table} x`)));
before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name)); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  for (const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0020_cutover_readiness','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import']) await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`, import.meta.url), 'utf8'));
  for (const role of ['admin', 'financeiro', 'consulta', 'estoque', 'fiscal', 'vendas']) {
    users[role] = randomUUID();
    await db.query('INSERT INTO auth.users VALUES($1)', [users[role]]);
    await db.query('INSERT INTO erp_access.membership(user_id,role) VALUES($1,$2)', [users[role], role]);
  }
  today = await scalar("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS value");
  await db.exec("INSERT INTO origin_sync.resource_state(resource) VALUES('independent_import_seed')");
  const contactSource = await raw('contacts', '101', { id: '101', nome: 'Synthetic contact', email: 'PRIVATE-EMAIL', numeroDocumento: 'PRIVATE-DOCUMENT' });
  contact = randomUUID();
  await db.query("INSERT INTO erp_catalog.record(id,entity,name) VALUES($1,'contacts','Synthetic contact')", [contact]);
  await db.query('INSERT INTO erp_catalog.contact(record_id) VALUES($1)', [contact]);
  await db.query("INSERT INTO erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) VALUES('contacts','101',$1,1,'{}','[]')", [contactSource.source_hash]);
  await db.query("INSERT INTO erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) VALUES('contacts','101',$1,$2,$2,'synced')", [contact, contactSource.source_hash]);
});
after(async () => db?.close());

test('039 independent: finalized refresh evidence belongs to this exact source and latest attempt', async () => {
  const a = await source(), b = await source();
  assert.equal((await preview([a])).can_apply, true);
  const attempt = await scalar("SELECT current_attempt AS value FROM origin_finance_refresh.origin WHERE entity='receivables' AND source_id=$1", [b.source_id]);
  await db.query("UPDATE origin_finance_refresh.origin SET current_attempt=$2 WHERE entity='receivables' AND source_id=$1", [a.source_id, attempt]);
  const review = await preview([a]);
  assert.equal(review.can_apply, false);
  assert.ok(review.items[0].blockers.includes('REFRESH_NOT_VERIFIED'));
  const c = await source(), pending = randomUUID();
  await db.query("INSERT INTO origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status) VALUES($1,'receivables',$2,$3,$4,$5,$6,'1')", [pending, c.source_id, randomUUID(), randomUUID(), c.source_hash, c.source_seen_at]);
  await db.query("UPDATE origin_finance_refresh.origin SET current_attempt=$2 WHERE entity='receivables' AND source_id=$1", [c.source_id, pending]);
  assert.ok((await preview([c])).items[0].blockers.includes('REFRESH_NOT_VERIFIED'));
});

test('039 independent: staging CAS includes observation and contact changes after preview', async () => {
  const item = await source(), review = await preview([item]);
  await db.query("UPDATE origin_sync.raw_record SET last_seen_at=last_seen_at+interval '1 second' WHERE entity='receivables' AND source_id=$1", [item.source_id]);
  const before = await ledger();
  await assert.rejects(() => apply([item], review), code('40001'));
  assert.deepEqual(await ledger(), before);
  const second = await source(), secondReview = await preview([second]);
  await db.query('UPDATE erp_catalog.record SET human_edited=true,version=version+1 WHERE id=$1', [contact]);
  try {
    await assert.rejects(() => apply([second], secondReview), code('40001'));
    assert.ok((await preview([second])).items[0].blockers.includes('CONTACT_NOT_READY'));
  } finally { await db.query('UPDATE erp_catalog.record SET human_edited=false,version=version+1 WHERE id=$1', [contact]); }
});

test('039 independent: TTL is proven by the finalized detail attempt, not by later polling', async () => {
  const expired = await source({}, { ageMinutes: 61 });
  const recentPoll = await scalar("UPDATE origin_sync.raw_record SET last_seen_at=clock_timestamp() WHERE entity='receivables' AND source_id=$1 RETURNING to_jsonb(last_seen_at) AS value", [expired.source_id]);
  expired.source_seen_at = recentPoll;
  const review = await preview([expired]);
  assert.equal(review.can_apply, false);
  assert.equal(review.valid_until, null);
  assert.ok(review.items[0].blockers.includes('REFRESH_EXPIRED'));
  const missing = await source();
  await db.query("UPDATE origin_finance_refresh.origin SET current_attempt=null WHERE entity='receivables' AND source_id=$1", [missing.source_id]);
  assert.ok((await preview([missing])).items[0].blockers.includes('REFRESH_NOT_VERIFIED'));
  const candidate = await source(), before = await ledger();
  await db.exec('BEGIN READ ONLY');
  try { assert.equal((await preview([candidate])).can_apply, true); }
  finally { await db.exec('ROLLBACK'); }
  assert.deepEqual(await ledger(), before);
});

test('039 independent: service-only boundaries and duplicate acknowledgement precede any import', async () => {
  const item = await source();
  for (const role of ['financeiro', 'consulta', 'estoque', 'fiscal', 'vendas']) await assert.rejects(() => preview([item], 'invalid', users[role]), code('42501'));
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try { await assert.rejects(() => scalar('SELECT public.erp_origin_financial_import_preview($1,$2,$3::jsonb,true) AS value', [users.admin, 'receivables', JSON.stringify([item])]), code('42501')); }
    finally { await db.exec('RESET ROLE'); }
  }
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,'erp_finance.origin_import_origin','SELECT,INSERT,UPDATE,DELETE') AS value", [role]), false);
  assert.equal(await scalar("SELECT relrowsecurity AS value FROM pg_class WHERE oid='erp_finance.origin_import_origin'::regclass"), true);
  await assert.rejects(() => rpc('erp_origin_financial_import_preview', { p_user_id: users.admin, p_entity: 'receivables', p_items: [item], p_duplicate_reviewed: false }), code('22023'));
  await assert.rejects(() => preview([item, item]), code('22023'));
});

test('039 independent: a late error rolls back the entire batch, command, evidence and audit', async () => {
  const first = await source(), last = await source({ historico: 'Synthetic forced failure' }), review = await preview([first, last]);
  assert.equal(review.can_apply, true);
  await db.exec("CREATE FUNCTION public.test_import_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.description='Synthetic forced failure' THEN RAISE EXCEPTION 'synthetic late failure' USING errcode='22023';END IF;RETURN NEW;END $$;CREATE TRIGGER z_test_import_late_failure BEFORE INSERT ON erp_finance.title FOR EACH ROW EXECUTE FUNCTION public.test_import_late_failure();");
  const before = await ledger();
  try { await assert.rejects(() => apply([first, last], review), code('22023')); assert.deepEqual(await ledger(), before); }
  finally { await db.exec('DROP TRIGGER z_test_import_late_failure ON erp_finance.title;DROP FUNCTION public.test_import_late_failure();'); }
});

test('039 independent: cancellation preserves provenance; replay cannot recreate or erase current state', async () => {
  const item = await source(), review = await preview([item]), command = randomUUID(), result = await apply([item], review, command);
  const title = result.batch.items[0].title_id;
  await execute('title_cancel', { id: title, expected_version: 1, note: 'Synthetic cancellation after import' });
  const before = await ledger(), replay = await apply([item], review, command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.batch, result.batch);
  assert.deepEqual(await ledger(), before);
  const current = await rpc('erp_origin_financial_import_batch', { p_user_id: users.admin, p_command_id: command });
  assert.equal(current.current_titles[0].cancelled, true);
  assert.equal((await preview([item])).items[0].status, 'already_imported');
  await db.query("UPDATE erp_access.membership SET role='financeiro' WHERE user_id=$1", [users.admin]);
  try { await assert.rejects(() => apply([item], review, command), code('42501')); }
  finally { await db.query("UPDATE erp_access.membership SET role='admin' WHERE user_id=$1", [users.admin]); }
  await assert.rejects(() => execute('account_save', { expected_version: 0, name: 'Wrong command scope', kind: 'cash' }, command), code('40001'));
  const other = randomUUID();
  await execute('account_save', { expected_version: 0, name: 'Existing financial command', kind: 'cash' }, other);
  const another = await source(), anotherReview = await preview([another]);
  await assert.rejects(() => apply([another], anotherReview, other), code('40001'));
});

test('039 independent: imported core is immutable but ordinary description and due date remain editable', async () => {
  const item = await source(), result = await apply([item], await preview([item])), title = result.batch.items[0].title_id;
  for (const patch of [{ amount_cents: '2600' }, { source_reference: 'Changed identity' }]) await assert.rejects(() => execute('title_update', { id: title, expected_version: 1, ...patch }), code('40001'));
  await assert.rejects(() => db.query('DELETE FROM erp_finance.title WHERE id=$1', [title]), code('40001'));
  const changed = await execute('title_update', { id: title, expected_version: 1, description: 'Reviewed native description', due_on: today });
  assert.equal(changed.record.description, 'Reviewed native description');
  assert.equal(changed.record.amount_cents, '2570');
  await assert.rejects(() => db.query("INSERT INTO erp_cnab.billing_title(title_id,profile_id,remittance_id,control,document_number,snapshot) VALUES($1,$2,$3,'TEST','TEST','{}')", [title, randomUUID(), randomUUID()]), code('40001'));
  for (const role of ['admin', 'financeiro', 'consulta']) {
    const origin = await rpc('erp_origin_financial_import_title_origin', { p_user_id: users[role], p_title_id: title });
    assert.equal(origin.origin.core_fields_locked, true);
    assert.equal(origin.origin.cnab_reservation_blocked, true);
    assert.doesNotMatch(JSON.stringify(origin), /PRIVATE|payload|evidence|contact_name/);
  }
  for (const role of ['estoque', 'fiscal', 'vendas']) await assert.rejects(() => rpc('erp_origin_financial_import_title_origin', { p_user_id: users[role], p_title_id: title }), code('42501'));
  const category = (await execute('category_save', { expected_version: 0, name: 'Synthetic native recategorization', kind: 'receivable' })).record;
  const recategorized = await execute('title_update', { id: title, expected_version: changed.record.version, category_id: category.id });
  assert.equal(recategorized.record.category_id, category.id);
});

test('039 independent: evidence remains a bounded whitelist and category CAS prevents stale confirmation', async () => {
  const item = await source({ linkBoleto: 'PRIVATE-URL', idTransacao: 'PRIVATE-TRANSACTION', arbitrary: { secret: 'PRIVATE-PAYLOAD' } });
  const category = (await execute('category_save', { expected_version: 0, name: 'Synthetic import category', kind: 'receivable' })).record;
  item.category_id = category.id; item.category_version = category.version;
  const first = await preview([item]);
  await execute('category_save', { id: category.id, expected_version: category.version, name: 'Renamed category', kind: 'receivable' });
  const before = await ledger();
  await assert.rejects(() => apply([item], first), code('40001'));
  assert.deepEqual(await ledger(), before);
  item.category_version = category.version + 1;
  const result = await apply([item], await preview([item]));
  const origin = await scalar('SELECT evidence AS value FROM erp_finance.origin_import_origin WHERE title_id=$1', [result.batch.items[0].title_id]);
  assert.doesNotMatch(JSON.stringify(origin), /PRIVATE-|linkBoleto|idTransacao|arbitrary|payload|email|numeroDocumento/);
  assert.equal(origin.category_version, category.version + 1);
  await assert.rejects(() => db.query("UPDATE erp_finance.origin_import_origin SET evidence='{}' WHERE title_id=$1", [result.batch.items[0].title_id]), code('55000'));
  await assert.rejects(() => db.query("UPDATE erp_finance.command SET result='{}' WHERE id=$1", [result.batch.id]), code('55000'));
});

test('039 independent: missing, partial, recurring and malformed identities are not repaired or inferred', async () => {
  const variants = [
    [{ situacao: 3 }, 'STATUS_NOT_OPEN'], [{ saldo: 25.69 }, 'BALANCE_NOT_FULL'],
    [{ ocorrencia: { tipo: 2, numeroParcelas: 1 } }, 'OCCURRENCE_NOT_UNIQUE'],
    [{ ocorrencia: { tipo: 1, numeroParcelas: 2 } }, 'OCCURRENCE_NOT_UNIQUE'],
    [{ ocorrencia: null }, 'OCCURRENCE_NOT_UNIQUE'], [{ historico: '' }, 'DESCRIPTION_INVALID'],
    [{ contato: { id: '101' + '0'.repeat(198) } }, 'CONTACT_NOT_READY'],
    [{ valor: 0.001, saldo: 0.001 }, 'AMOUNT_INVALID']
  ];
  for (const [patch, blocker] of variants) {
    const item = await source(patch), reviewed = await preview([item]);
    assert.equal(reviewed.can_apply, false);
    assert.ok(reviewed.items[0].blockers.includes(blocker), `${blocker}: ${JSON.stringify(reviewed.items[0].blockers)}`);
  }
});

test('039 independent: 25 maximum principals retain exact totals beyond IEEE754 without movements', async () => {
  const items = [];
  for (let index = 0; index < 25; index++) items.push(await source({}, { entity: 'payables', money: '9999999999999.99' }));
  const review = await preview(items, 'payables');
  assert.equal(review.can_apply, true);
  assert.equal(review.summary.total_cents, '24999999999999975');
  const result = await apply(items, review, randomUUID(), 'payables');
  assert.equal(result.batch.total_cents, '24999999999999975');
  const exposed = await api('/batches/' + result.batch.id);
  assert.equal(exposed.batch.total_cents, '24999999999999975');
  assert.equal(exposed.current_titles.reduce((sum, title) => sum + BigInt(title.amount_cents), 0n).toString(), exposed.batch.total_cents);
  assert.equal(new Set(result.batch.items.map(item => item.title_id)).size, 25);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.settlement'), 0);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement'), 0);
});

test('039 independent: HTTP binds preview/receipt scope and projects private upstream fields away', async () => {
  const item = await source(), body = { entity: 'receivables', duplicate_reviewed: true, items: [item] };
  const reviewed = await api('/preview', body);
  assert.equal(reviewed.can_apply, true);
  const evil = [
    v => v.entity = 'payables', v => v.items[0].source_id = '99999999',
    v => v.items[0].proposed.amount_cents = '2571', v => v.summary.total_cents = '2571',
    v => v.items[0].proposed.category_id = randomUUID(), v => v.settles_titles = true,
    v => v.items[0].proposed.kind = 'payable'
  ];
  for (const change of evil) {
    const response = structuredClone(reviewed); change(response);
    await assert.rejects(() => api('/preview', body, async () => response), error => error.status === 502);
  }
  const extra = structuredClone(reviewed);
  extra.secret = 'PRIVATE'; extra.items[0].payload = { secret: 'PRIVATE' }; extra.items[0].proposed.email = 'PRIVATE';
  assert.doesNotMatch(JSON.stringify(await api('/preview', body, async () => extra)), /PRIVATE|payload|email/);
  const command = randomUUID(), applyBody = { ...body, command_id: command, preview_hash: reviewed.preview_hash, confirm_import: true };
  const result = await api('/apply', applyBody), current = await api('/batches/' + command);
  assert.equal(result.batch.id, current.batch.id);
  const wrong = structuredClone(result); wrong.batch.items[0].source_id = '777';
  await assert.rejects(() => api('/apply', applyBody, async () => wrong), error => error.status === 502);
  const differentCurrent = structuredClone(current); differentCurrent.current_titles[0].contact_id = randomUUID();
  await assert.rejects(() => api('/batches/' + command, undefined, async () => differentCurrent), error => error.status === 502);
  for (const path of ['/origins/receivables/1%2F2', '/titles/' + randomUUID() + '/origin?raw=true', '/batches/' + command + '?actor=other']) await assert.rejects(() => api(path), error => error.status === 400);
});
