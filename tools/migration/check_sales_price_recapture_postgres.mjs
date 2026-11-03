// Synthetic085 concurrency checks in one disposable PG17 cluster, private Unix socket, no TCP.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { bootstrap } from './helpers/stock-reservation-fixture.mjs';
import { parseSalesPriceJson, salesPriceCapture } from '../../workers/origin-sync/src/sales-price-json.mjs';

const bin = process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin === 'string' && isAbsolute(bin));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')));
assert.match(execFileSync(join(bin, 'postgres'), ['--version'], { env, encoding: 'utf8' }), /PostgreSQL\) 17\./);
const root = await mkdtemp('/Volumes/Dev/tmp/brufap-sales-recapture085-'), socket = join(root, 's'), port = '56585';
await chmod(root, 0o700); await mkdir(socket, { mode: 0o700 });
let started = false; const children = new Set(), results = [];
const quote = v => v === null ? 'null' : typeof v === 'number' ? String(v) : "'" + (typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll("'", "''") + "'";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function session() {
  const p = spawn(join(bin, 'psql'), ['-XAtq', '-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(p); let out = '', err = '', ended = false;
  const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
  const done = new Promise((resolve, reject) => {
    p.on('error', reject); p.stdin.on('error', () => {});
    p.stdout.on('data', b => { out += b; if (out.length > 2097152) p.kill('SIGKILL'); });
    p.stderr.on('data', b => { err += b; if (err.length > 65536) p.kill('SIGKILL'); });
    p.on('close', code => { ended = true; children.delete(p); clearTimeout(timer); resolve({ code, out, err }); });
  }); done.catch(() => {});
  return { done, write: s => p.stdin.write(s + '\n'), end: s => { if (!p.stdin.writableEnded) p.stdin.end(s + '\n'); }, async marker(v) {
    const until = Date.now() + 10000;
    while (!out.includes(v)) { assert.equal(ended, false, err); assert.ok(Date.now() < until, 'Marker timeout'); await sleep(15); }
  } };
}
async function run(sql) { const s = session(); s.end(sql); return s.done; }
const ok = r => { assert.equal(r.code, 0, r.err); return r; };
const result = r => JSON.parse(ok(r).out.trim().split('\n').findLast(x => x.startsWith('{') || x.startsWith('[')));
const rpcSql = (name, args) => {
  assert.match(name, /^(?:erp|origin_sync)_[a-z0-9_]+$/);
  return `set local role service_role;select public.${name}(${Object.entries(args).map(([k, v]) => { assert.match(k, /^p_[a-z0-9_]+$/); return `${k}=>${quote(v)}`; }).join(',')});`;
};
const rpc = async (name, args) => result(await run('begin;' + rpcSql(name, args) + 'commit;'));
function rejected(r, code) { assert.equal(r.code, 3, r.out); assert.match(r.err, new RegExp(`\\b${code}\\b`)); assert.doesNotMatch(r.err, /\b40P01\b/); }
async function waitLock(name) {
  const until = Date.now() + 10000;
  while (true) {
    const r = ok(await run(`select count(*)from pg_stat_activity where application_name=${quote(name)}and wait_event_type='Lock';`));
    if (r.out.trim() === '1') return; assert.ok(Date.now() < until, `Expected lock wait: ${name}`); await sleep(20);
  }
}
async function race(name, firstSql, secondSql, { secondError = null, release = 'commit;' } = {}) {
  const first = session(), second = session();
  first.write(`begin;set local statement_timeout='20s';${firstSql}\n\\echo HELD`);
  try {
    await first.marker('HELD'); second.end(`set application_name=${quote(name)};begin;set local statement_timeout='20s';${secondSql}commit;`);
    await waitLock(name); first.end(release); const a = ok(await first.done), b = await second.done;
    if (secondError) rejected(b, secondError); else ok(b);
    results.push({ scenario: name, passed: true, lock_wait_observed: true }); return { first: a, second: b };
  } finally { first.end('rollback;'); second.end('rollback;'); await Promise.allSettled([first.done, second.done]); }
}
const admin = randomUUID(); let identity, serial = 8500000;
const protectedRowsSql = `do $$declare r record;v jsonb;all_rows jsonb:='{}';begin
 for r in select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.relkind='r'and(n.nspname like 'erp_%'or n.nspname in('origin_sync','origin_backup','origin_reference_fetch','auth','storage'))
 and n.nspname<>'erp_sales_history'and not(n.nspname='origin_sync'and c.relname in('raw_record','resource_state','batch_inbox'))order by 1,2 loop
 execute format('select jsonb_build_object(''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(x)::text,E''\\n''order by to_jsonb(x)::text),'''')))from %I.%I x',r.ns,r.name)into v;
 all_rows:=all_rows||jsonb_build_object(r.ns||'.'||r.name,v);end loop;perform set_config('brufap.recap_fixture',all_rows::text,false);end$$;select current_setting('brufap.recap_fixture')::jsonb;`;
const protectedRows = async () => result(await run(protectedRowsSql));
const cp = async () => result(await run("select jsonb_build_object('checkpoint',checkpoint,'version',checkpoint_version::text)from origin_sync.resource_state where resource='sales_orders';"));
const raw = async id => result(await run(`select to_jsonb(r)from origin_sync.raw_record r where entity='sales_orders'and source_id=${quote(id)};`));
const history = async id => result(await run(`select jsonb_build_object('snapshots',(select coalesce(jsonb_agg(to_jsonb(s)order by s.history_id),'[]')from erp_sales_history.snapshot s where s.source_id=${quote(id)}),'commands',(select coalesce(jsonb_agg(to_jsonb(c)order by c.command_id),'[]')from erp_sales_history.command c join erp_sales_history.snapshot s using(history_id)where s.source_id=${quote(id)}));`));
const callSql = (name, args = {}, ids = identity) => rpcSql('origin_sync_sales_price_' + name, { ...ids, ...args });
const call = (name, args = {}, ids = identity) => rpc('origin_sync_sales_price_' + name, { ...ids, ...args });
async function acquire(owner = randomUUID()) {
  const claim = resource => rpc('origin_sync_claim', { p_resource: resource, p_owner: owner, p_ttl_seconds: 600 });
  const a = await claim('__scheduler__'), b = await claim('sales_orders'); assert.ok(a.acquired && b.acquired);
  return identity = { p_owner: owner, p_lease_token: a.lease_token, p_resource_token: b.lease_token };
}
const leaseRefresh = () => run("update origin_sync.resource_state set lease_expires_at=clock_timestamp()+interval '10 minutes'where resource in('__scheduler__','sales_orders');").then(ok);
async function sale() {
  const id = String(++serial), payload = { id, numero: serial, data: '2026-10-17', contato: { id: 21 }, itens: [{ unidade: 'CX', quantidade: 2, valor: 1.23 }], total: 2.46 };
  ok(await run(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('sales_orders','sales_orders',${quote(id)},${quote(payload)}::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',${quote(payload)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'));`)); return id;
}
async function prepare(id) {
  const r = await raw(id); return { p_attempt_id: randomUUID(), p_source_id: id, p_source_hash: r.version_hash, p_source_version: String(r.version), p_source_seen_at: r.last_seen_at };
}
const begin = async id => { const args = await prepare(id); await call('begin', args); return { args, identity: { ...identity } }; };
async function body(id, token = '99999999.1234567891') {
  const wire = `{"data":{"id":"${id}","itens":[{"valor":${token}}]}}`, p = await parseSalesPriceJson(wire, new TextEncoder().encode(wire), 'sales_detail');
  return { p_payload: p.data, p_price_capture: salesPriceCapture(p.data) };
}
const finishArgs = async (j, b) => ({ p_attempt_id: j.args.p_attempt_id, ...(b ?? await body(j.args.p_source_id)) });
const finishSql = async (j, b) => callSql('finish', await finishArgs(j, b), j.identity);
const finish = async (j, b) => call('finish', await finishArgs(j, b), j.identity);
async function captureArgs(id) {
  const p = await rpc('erp_origin_sales_history_preview', { p_user_id: admin, p_source_id: id });
  return { p_user_id: admin, p_source_id: id, p_source_hash: p.source.source_hash, p_source_version: p.source.source_version, p_snapshot_hash: p.snapshot_hash, p_command_id: randomUUID() };
}
const snapshotJob = async j => result(await run(`select jsonb_build_object('raw',(select to_jsonb(r)from origin_sync.raw_record r where entity='sales_orders'and source_id=${quote(j.args.p_source_id)}),'attempt',(select to_jsonb(a)from origin_sales_price_refresh.attempt a where id=${quote(j.args.p_attempt_id)}),'origin',(select to_jsonb(o)from origin_sales_price_refresh.origin o where source_id=${quote(j.args.p_source_id)}),'batches',(select coalesce(jsonb_agg(to_jsonb(b)),'[]')from origin_sync.batch_inbox b where batch_id=${quote(j.args.p_attempt_id)}),'checkpoint',(select jsonb_build_object('checkpoint',checkpoint,'version',checkpoint_version)from origin_sync.resource_state where resource='sales_orders'));`));
const noBatch = async j => assert.equal(ok(await run(`select count(*)from origin_sync.batch_inbox where batch_id=${quote(j.args.p_attempt_id)};`)).out.trim(), '0');
async function normalArgs(id, captured) {
  const r = await raw(id), state = await cp(), b = await body(id, '1.2345678912');
  return { p_resource: 'sales_orders', p_entity: 'sales_orders', p_owner: identity.p_owner, p_lease_token: identity.p_resource_token, p_batch_id: randomUUID(),
    p_records: [{ source_id: id, payload: captured ? b.p_payload : { ...r.payload, numero: serial + 1 }, document_links: r.document_links, source_updated_at: r.source_updated_at, ...(captured ? { price_capture: b.p_price_capture } : {}) }], p_checkpoint: state.checkpoint, p_expected_checkpoint_version: state.version };
}

try {
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { env, stdio: 'pipe', timeout: 20000 });
  execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`, '-w', 'start'], { env, stdio: 'pipe', timeout: 20000 }); started = true;
  assert.equal(ok(await run('show listen_addresses;')).out.trim(), ''); ok(await run(bootstrap));
  const dir = new URL('../../supabase/migrations/', import.meta.url), files = (await readdir(dir)).filter(n => /^202610160\d{3}_.+\.sql$/.test(n) && +n.slice(9, 12) <= 84).sort();
  assert.equal(files.length, 84); for (const name of files) ok(await run(await readFile(new URL(name, dir), 'utf8')));
  ok(await run(`insert into auth.users values('${admin}');insert into erp_access.membership(user_id,role)values('${admin}','admin');insert into origin_sync.resource_state(resource,checkpoint)values('sales_orders','{"page":31,"window":{"from":"2026-10-01","to":"2026-10-17"}}');`));
  const contact = (await rpc('erp_catalog_save', { p_user_id: admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Contato sintético085' } })).record;
  await rpc('erp_document_save', { p_user_id: admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-17', contact_id: contact.id, items: [{ description: 'Pedido preservado085', unit: 'UN', quantity: '1', unit_price: '1.2345678912' }] } });
  ok(await run(`insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents)values('${randomUUID()}',1,1,'receivable','${contact.id}','Título preservado085','2026-10-17','2026-11-17',123);insert into storage.buckets(id,name,public)values('synthetic085','synthetic085',false);insert into storage.objects values('synthetic085','synthetic','{}');`));
  const historicalId = await sale(); await rpc('erp_origin_sales_history_capture', await captureArgs(historicalId)); const initialHistory = await history(historicalId), initial = await protectedRows();
  const procSql = `select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(p)::text,E'\n'order by p.oid)))from pg_proc p where p.oid=any((select array_agg(oid)from pg_proc where pronamespace in(select oid from pg_namespace where nspname like 'erp_%'or nspname in('public','origin_sync','origin_backup','origin_reference_fetch')))::oid[]);`;
  const functions = result(await run(procSql));
  const source = await readFile(new URL('202610160085_origin_sales_price_refresh.sql', dir), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), 'f1e6415523bc171bd1de4ae357bec22be29c90aac442e2ea202a7bfbf5da39fe'); ok(await run(source));
  assert.deepEqual(await protectedRows(), initial); assert.deepEqual(result(await run(procSql.replace("where p.oid=any", "where p.proname not like 'origin_sync_sales_price_%'and p.oid=any"))), functions);
  await acquire();
  {
    const id = await sale(), args = await prepare(id), r = await race('085_same_begin_uuid', callSql('begin', args), callSql('begin', args));
    assert.equal(result(r.first).replayed, false); assert.equal(result(r.second).replayed, true);
    await race('085_same_begin_body_conflict', "select resource from origin_sync.resource_state where resource='__scheduler__'for update;", callSql('begin', { ...args, p_source_version: '99' }), { secondError: '40001' });
  }
  for (const stage of ['begin', 'finish']) {
    const id = await sale(), args = await prepare(id), j = { args, identity: { ...identity } }; if (stage === 'finish') await call('begin', args);
    const capture = await captureArgs(id), beforeRaw = await raw(id), beforeCp = await cp();
    const r = await race(`083_capture_before085_${stage}`, rpcSql('erp_origin_sales_history_capture', capture), stage === 'begin' ? callSql('begin', args) : await finishSql(j), { secondError: stage === 'begin' ? '40001' : null });
    if (stage === 'finish') assert.equal(result(r.second).conflict, true);
    assert.deepEqual(await raw(id), beforeRaw); assert.deepEqual(await cp(), beforeCp); await noBatch(j);
    assert.equal((await history(id)).snapshots.length, 1);
  }
  {
    const id = await sale(), j = await begin(id), capture = await captureArgs(id), beforeCp = await cp();
    const r = await race('085_finish_before083_stale_capture', await finishSql(j), rpcSql('erp_origin_sales_history_capture', capture), { secondError: '40001' });
    assert.equal(result(r.first).stored, true); assert.equal((await history(id)).snapshots.length, 0);
    const current = await cp(); assert.deepEqual(current.checkpoint, beforeCp.checkpoint); assert.equal(BigInt(current.version), BigInt(beforeCp.version) + 1n);
    assert.equal(ok(await run(`select payload#>>'{itens,0,valor}'from origin_sync.raw_record where entity='sales_orders'and source_id=${quote(id)};`)).out.trim(), '99999999.1234567891');
  }
  for (const captured of [false, true]) {
    const id = await sale(), j = await begin(id), args = await normalArgs(id, captured), name = captured ? 'origin_sync_apply_sales_price_batch' : 'origin_sync_apply_batch';
    const r = await race(`normal_${captured ? '078' : '005'}_before085_finish`, rpcSql(name, args), await finishSql(j));
    assert.equal(result(r.second).conflict, true); await noBatch(j); const stored = await raw(id);
    assert.equal(stored.payload.itens[0].valor, captured ? 1.2345678912 : 1.23);
    assert.equal(ok(await run(`select payload#>>'{itens,0,valor}'from origin_sync.raw_record where entity='sales_orders'and source_id=${quote(id)};`)).out.trim(), captured ? '1.2345678912' : '1.23');
    assert.equal((await cp()).version, String(BigInt(args.p_expected_checkpoint_version) + 1n));
  }
  {
    const id = await sale(), j = await begin(id), normal = await normalArgs(id, true);
    await race('085_finish_before078_old_checkpoint', await finishSql(j), rpcSql('origin_sync_apply_sales_price_batch', normal), { secondError: '40001' });
  }
  for (const [field, expression] of [['last_seen_at', "last_seen_at+interval '1 second'"], ['version', 'version+1'], ['document_links', "'[\"synthetic-new-link\"]'::jsonb"]]) {
    const id = await sale(), j = await begin(id), beforeCp = await cp();
    const r = await race(`085_raw_${field}_changes_during_wait`, `select source_id from origin_sync.raw_record where entity='sales_orders' and source_id=${quote(id)} for update;`, await finishSql(j), { release: `update origin_sync.raw_record set ${field}=${expression} where entity='sales_orders' and source_id=${quote(id)};commit;` });
    assert.equal(result(r.second).conflict, true); await noBatch(j); assert.deepEqual(await cp(), beforeCp);
  }
  for (const resource of ['__scheduler__', 'sales_orders']) {
    const id = await sale(), j = await begin(id), before = await snapshotJob(j);
    await race(`085_${resource}_expires_during_wait`, `select resource from origin_sync.resource_state where resource=${quote(resource)}for update;`, await finishSql(j), { secondError: '55000', release: `update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource=${quote(resource)};commit;` });
    assert.deepEqual(await snapshotJob(j), before); await leaseRefresh();
  }
  for (const resource of ['__scheduler__', 'sales_orders']) {
    const id = await sale(), j = await begin(id), before = await snapshotJob(j), old = resource === '__scheduler__' ? identity.p_lease_token : identity.p_resource_token;
    await race(`085_${resource}_fence_changes_during_wait`, `select resource from origin_sync.resource_state where resource=${quote(resource)}for update;`, await finishSql(j), { secondError: '55000', release: `update origin_sync.resource_state set lease_token='${randomUUID()}'where resource=${quote(resource)};commit;` });
    assert.deepEqual(await snapshotJob(j), before); ok(await run(`update origin_sync.resource_state set lease_token=${quote(old)}where resource=${quote(resource)};`));
  }
  {
    const id = await sale(), args = await prepare(id), j = { args, identity: { ...identity } }, before = await snapshotJob(j);
    ok(await run("update origin_sync.resource_state set lease_expires_at=clock_timestamp()+interval '1 second'where resource='__scheduler__';"));
    await race('085_begin_expiry_after_source_wait_rolls_back_queue', `select pg_advisory_xact_lock(174853084,hashtext(${quote(id)}));`, callSql('begin', args), { secondError: '55000', release: 'select pg_sleep(1.05);commit;' });
    assert.deepEqual(await snapshotJob(j), before); await leaseRefresh();
  }
  {
    const id = await sale(), j = await begin(id), before = await snapshotJob(j);
    ok(await run("update origin_sync.resource_state set lease_expires_at=clock_timestamp()+interval '1 second'where resource='__scheduler__';"));
    await race('085_expiry_after_source_wait_rolls_back078_and_queue', `select pg_advisory_xact_lock(174853084,hashtext(${quote(id)}));`, await finishSql(j), { secondError: '55000', release: 'select pg_sleep(1.05);commit;' });
    assert.deepEqual(await snapshotJob(j), before); await leaseRefresh();
  }
  {
    const id = await sale(), j = await begin(id), b = await body(id), r = await race('085_same_finish_after_ack_loss', await finishSql(j, b), await finishSql(j, b));
    const ack = result(r.first); assert.deepEqual(result(r.second), { ...ack, replayed: true });
    const before = await snapshotJob(j); rejected(await run('begin;' + await finishSql(j, await body(id, '1')) + 'commit;'), '40001'); assert.deepEqual(await snapshotJob(j), before);
    results.push({ scenario: '085_same_uuid_different_response_refused', passed: true });
    await rpc('erp_origin_sales_history_capture', await captureArgs(id)); const capturedHistory = await history(id);
    ok(await run("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource in('__scheduler__','sales_orders');")); await acquire();
    assert.equal((await call('attempt', { p_attempt_id: j.args.p_attempt_id }, j.identity)).state, 'stored');
    assert.deepEqual(await finish(j, b), { ...ack, replayed: true }); assert.deepEqual(await snapshotJob(j), before); assert.deepEqual(await history(id), capturedHistory);
    rejected(await run('begin;' + callSql('attempt', { p_attempt_id: j.args.p_attempt_id }) + 'commit;'), '55000');
    results.push({ scenario: '085_historical_lookup_and_replay_after_turnover_and083', passed: true });
  }
  {
    const id = await sale(), j = await begin(id);
    ok(await run("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource in('__scheduler__','sales_orders');")); await acquire();
    ok(await run(`update origin_sales_price_refresh.origin set next_attempt_at=clock_timestamp()-interval '1 second'where source_id=${quote(id)};`));
    const next = await begin(id); assert.equal((await call('attempt', { p_attempt_id: j.args.p_attempt_id }, j.identity)).state, 'superseded');
    rejected(await run('begin;' + await finishSql(j) + 'commit;'), '55000'); assert.equal((await finish(next)).stored, true); await noBatch(j);
    results.push({ scenario: '085_pending_turnover_supersedes_old_fences_without_repeat', passed: true });
  }
  {
    const id = await sale(), j = await begin(id), before = await snapshotJob(j), r = await run('begin;' + await finishSql(j) + 'select 1/0;commit;');
    rejected(r, '22012'); assert.deepEqual(await snapshotJob(j), before); results.push({ scenario: '085_late_transaction_error_rolls_back_all_effects', passed: true });
  }
  assert.deepEqual(await protectedRows(), initial); assert.deepEqual(await history(historicalId), initialHistory);
  const security = result(await run(`select jsonb_build_object('private_tables',(select count(*)from pg_class c where c.relnamespace='origin_sales_price_refresh'::regnamespace and c.relkind='r'and c.relrowsecurity and not has_table_privilege('service_role',c.oid,'SELECT')),'service_rpc',(select count(*)from pg_proc p where pronamespace='public'::regnamespace and proname like 'origin_sync_sales_price_%'and has_function_privilege('service_role',p.oid,'EXECUTE')and not has_function_privilege('anon',p.oid,'EXECUTE')and not has_function_privilege('authenticated',p.oid,'EXECUTE')),'grant_option',(select count(*)from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where(p.pronamespace='origin_sales_price_refresh'::regnamespace or p.proname like 'origin_sync_sales_price_%')and a.is_grantable));`));
  assert.deepEqual(security, { private_tables: 3, service_rpc: 6, grant_option: 0 });
  results.push({ scenario: '085_native_ledgers_original_history_and_acl_preserved', passed: true });
  console.log(JSON.stringify({ profile: 'sales-price-recapture-085-postgres-v1', source_sha256: createHash('sha256').update(source).digest('hex'), postgres: '17-native', private_unix_socket: true, tcp: false, remote_executed: false, protected_tables: Object.keys(initial).length, scenarios: results }, null, 2));
} finally {
  for (const child of children) child.kill('SIGKILL');
  if (started || existsSync(join(root, 'data', 'postmaster.pid'))) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { env, stdio: 'ignore', timeout: 15000 });
  assert.match(root, /^\/Volumes\/Dev\/tmp\/brufap-sales-recapture085-[A-Za-z0-9]+$/); await rm(root, { recursive: true, force: true });
}
