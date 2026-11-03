// Synthetic086 concurrency and preservation checks; one disposable PG17 cluster, no TCP.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { bootstrap } from './helpers/stock-reservation-fixture.mjs';

const bin = process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin === 'string' && isAbsolute(bin));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')));
assert.match(execFileSync(join(bin, 'postgres'), ['--version'], { env, encoding: 'utf8' }), /PostgreSQL\) 17\./);
const root = await mkdtemp('/Volumes/Dev/tmp/brufap-warehouse-import086-'), socket = join(root, 's'), port = '56586';
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
async function race(name, firstSql, secondSql, { secondError = null, release = 'commit;', during = null } = {}) {
  const first = session(), second = session();
  first.write(`begin;set local statement_timeout='20s';${firstSql}\n\\echo HELD`);
  try {
    await first.marker('HELD'); second.end(`set application_name=${quote(name)};begin;set local statement_timeout='20s';${secondSql}commit;`);
    await waitLock(name); if (during) await during(); first.end(release); const a = ok(await first.done), b = await second.done;
    if (secondError) rejected(b, secondError); else ok(b);
    results.push({ scenario: name, passed: true, lock_wait_observed: true }); return { first: a, second: b };
  } finally { first.end('rollback;'); second.end('rollback;'); await Promise.allSettled([first.done, second.done]); }
}
const sourceHash = 'f371f88512c63eca7f2d05f7f2b070d32c61845341cc775b39ed9ee9bac6e25c';
const admin = randomUUID(), other = randomUUID(); let serial = 8600000;
const nativeArgs = (command = randomUUID()) => ({ p_user_id: admin, p_entity: 'warehouses', p_id: null, p_expected_version: 0, p_command_id: command, p_data: { name: 'Depósito nativo sintético086' } });
const scalar = async sql => ok(await run(sql)).out.trim();
const object = async sql => result(await run(sql));
async function stage(patch = {}) {
  const id = String(++serial), payload = { id, descricao: `Depósito fonte ${id}`, situacao: 0, padrao: false, desconsiderarSaldo: false, ...patch };
  ok(await run(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('warehouses','warehouses_active',${quote(id)},${quote(payload)}::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',${quote(payload)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'));`));
  return id;
}
const sourceTuple = id => object(`select jsonb_build_object('p_source_id',source_id,'p_source_hash',version_hash,'p_source_version',version::text) from origin_sync.raw_record where entity='warehouses' and source_id=${quote(id)};`);
async function args(id, command = randomUUID(), actor = admin) {
  const s = await sourceTuple(id), p = await rpc('erp_origin_warehouse_preview', { p_user_id: actor, ...s });
  assert.equal(p.can_create, true);
  return { p_user_id: actor, ...s, p_preview_hash: p.preview_hash, p_command_id: command, p_confirmed: true };
}
const importSql = a => rpcSql('erp_origin_warehouse_import', a);
const apply = a => rpc('erp_origin_warehouse_import', a);
const lookup = (id, actor = admin) => rpc('erp_origin_warehouse_command', { p_user_id: actor, p_command_id: id });
const sourceLock = id => `select pg_advisory_xact_lock(174853086,hashtext(${quote(id)}));`;
const commandLock = id => `select pg_advisory_xact_lock(174852906,hashtext(${quote(id)}));`;
const rawLock = id => `select source_id from origin_sync.raw_record where entity='warehouses' and source_id=${quote(id)} for update;`;
const revoke = `update erp_access.membership set active=false where user_id='${admin}';`;
const restore = () => run(`update erp_access.membership set active=true where user_id='${admin}';`).then(ok);
const mutablePrevious = ['origin_sync.raw_record', 'erp_access.membership', 'erp_catalog.record', 'erp_catalog.warehouse', 'erp_catalog.command', 'erp_catalog.audit'];
async function fingerprints() {
  const all = await object(`select coalesce(jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p') and (n.nspname~'^(erp|origin)_' or n.nspname='auth' and c.relname='users' or n.nspname='storage' and c.relname in('buckets','objects')) and n.nspname<>'erp_warehouse_import';`);
  const out = {};
  for (const name of all.filter(n => !mutablePrevious.includes(n))) {
    assert.match(name, /^[a-z0-9_]+\.[a-z0-9_]+$/);
    out[name] = await object(`select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''))) from ${name} t;`);
  }
  return out;
}
const catalogRows = () => object(`select jsonb_build_object('record',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from erp_catalog.record t),'warehouse',(select coalesce(jsonb_agg(to_jsonb(t) order by record_id),'[]') from erp_catalog.warehouse t),'command',(select coalesce(jsonb_agg(to_jsonb(t) order by command_id),'[]') from erp_catalog.command t),'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from erp_catalog.audit t));`);
const sourceState = (id, command) => object(`select jsonb_build_object('binding',(select to_jsonb(b) from erp_warehouse_import.binding b where source_id=${quote(id)}),'command',(select to_jsonb(c) from erp_warehouse_import.command c where command_id=${quote(command)}),'catalog_command',(select to_jsonb(c) from erp_catalog.command c where command_id=${quote(command)}),'native_count',(select count(*) from erp_catalog.record),'audit_count',(select count(*) from erp_catalog.audit));`);
const immutableTables = () => object(`select jsonb_build_object('binding',(select coalesce(jsonb_agg(to_jsonb(b) order by source_id),'[]') from erp_warehouse_import.binding b),'command',(select coalesce(jsonb_agg(to_jsonb(c) order by command_id),'[]') from erp_warehouse_import.command c));`);
const procSql = `select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(p)::text,E'\n' order by p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname~'^(erp|origin)_' or n.nspname='public' and p.proname~'^(erp|origin)_') and n.nspname<>'erp_warehouse_import' and p.proname not like 'erp_origin_warehouse_%';`;

try {
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { env, stdio: 'pipe', timeout: 20000 });
  execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`, '-w', 'start'], { env, stdio: 'pipe', timeout: 20000 }); started = true;
  assert.equal(await scalar('show listen_addresses;'), ''); ok(await run(bootstrap));
  const dir = new URL('../../supabase/migrations/', import.meta.url), files = (await readdir(dir)).filter(n => /^202610160\d{3}_.+\.sql$/.test(n) && +n.slice(9, 12) <= 85).sort();
  assert.equal(files.length, 85); for (const name of files) ok(await run(await readFile(new URL(name, dir), 'utf8')));
  ok(await run(`insert into auth.users values('${admin}'),('${other}');insert into erp_access.membership(user_id,role) values('${admin}','admin'),('${other}','admin');`));
  ok(await run("insert into origin_sync.resource_state(resource) values('warehouses_active');"));
  const warehouse = (await rpc('erp_catalog_save', nativeArgs())).record;
  const product = (await rpc('erp_catalog_save', { ...nativeArgs(), p_entity: 'products', p_data: { name: 'Produto protegido086', unit: 'UN', kind: 'P', format: 'S', price: '1.23' } })).record;
  const contact = (await rpc('erp_catalog_save', { ...nativeArgs(), p_entity: 'contacts', p_data: { name: 'Contato protegido086' } })).record;
  await rpc('erp_document_save', { p_user_id: admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-17', contact_id: contact.id, items: [{ product_id: product.id, description: 'Linha protegida086', unit: 'UN', quantity: '1', unit_price: '1.23' }] } });
  ok(await run(`insert into erp_stock.balance(product_id,warehouse_id,quantity,unit,version) values('${product.id}','${warehouse.id}',123.456789,'UN',3);
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents) values('${randomUUID()}',1,1,'receivable','${contact.id}','Título protegido086','2026-10-17','2026-11-17',12345);
  insert into storage.buckets(id,name,public) values('synthetic086','synthetic086',false);insert into storage.objects values('synthetic086','protected','{}');`));
  const initial = await fingerprints(), initialCatalog = await catalogRows(), functions = await object(procSql);
  const source = await readFile(new URL('202610160086_origin_warehouse_import.sql', dir), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), sourceHash); ok(await run(source));
  assert.deepEqual(await fingerprints(), initial); assert.deepEqual(await object(procSql), functions);
  {
    const id = await stage(), a = await args(id), before = await sourceState(id, a.p_command_id);
    const r = await race('086_same_uuid_atomic_inactive_replay', importSql(a), importSql(a), { during: async () => assert.deepEqual(await sourceState(id, a.p_command_id), before) });
    const first = result(r.first), second = result(r.second);
    assert.equal(first.receipt.binding.record.active, false); assert.equal(first.receipt.binding.record.version, 1); assert.equal(first.receipt.binding.record.human_edited, false);
    assert.notEqual(first.receipt.binding.record.id, warehouse.id); assert.deepEqual(second.receipt, first.receipt); assert.equal(second.replayed, true);
    assert.equal(await scalar(`select count(*) from erp_catalog.audit where command_id='${a.p_command_id}' and after_data->'active'='false'::jsonb;`), '1');
  }
  {
    const id = await stage({ situacao: 1 }), a = await args(id), b = { ...a, p_command_id: randomUUID() };
    const r = await race('086_same_source_two_commands_one_native_record', importSql(a), importSql(b));
    assert.equal(result(r.first).receipt.outcome, 'created'); assert.equal(result(r.second).receipt.outcome, 'already_linked');
    assert.deepEqual(result(r.first).receipt.binding, result(r.second).receipt.binding);
    assert.equal(await scalar(`select count(*) from erp_catalog.audit where command_id in('${a.p_command_id}','${b.p_command_id}');`), '1');
  }
  for (const originalFirst of [true, false]) {
    const id = await stage(), a = await args(id), n = nativeArgs(a.p_command_id);
    const r = await race(`086_catalog006_collision_${originalFirst ? 'native_first' : 'warehouse_first'}`, originalFirst ? rpcSql('erp_catalog_save', n) : importSql(a), originalFirst ? importSql(a) : rpcSql('erp_catalog_save', n), { secondError: '40001' });
    const state = await sourceState(id, a.p_command_id);
    assert.equal(state.binding === null, originalFirst); assert.ok(result(r.first));
  }
  {
    const firstId = await stage(), secondId = await stage(), a = await args(firstId), b = await args(secondId, a.p_command_id);
    await race('086_same_uuid_different_source_conflict', importSql(a), importSql(b), { secondError: '40001' });
    assert.equal((await sourceState(secondId, randomUUID())).binding, null);
    await race('086_same_uuid_other_admin_conflict', commandLock(a.p_command_id), importSql({ ...a, p_user_id: other }), { secondError: '40001' });
  }
  {
    const id = await stage(), a = await args(id), before = await sourceState(id, a.p_command_id);
    await race('086_raw_cas_change_after_wait', rawLock(id), importSql(a), { secondError: '40001', release: `update origin_sync.raw_record set version=version+1 where entity='warehouses' and source_id=${quote(id)};commit;` });
    assert.deepEqual(await sourceState(id, a.p_command_id), before);
  }
  {
    const id = await stage(), a = await args(id), old = await object(`select jsonb_build_object('at',last_seen_at) from origin_sync.raw_record where entity='warehouses' and source_id=${quote(id)};`);
    const r = await race('086_raw_last_seen_reobserved_not_false_cas', rawLock(id), importSql(a), { release: `update origin_sync.raw_record set last_seen_at=last_seen_at+interval '1 minute' where entity='warehouses' and source_id=${quote(id)};commit;` });
    assert.notEqual(result(r.second).receipt.binding.source.last_seen_at, old.at);
  }
  for (const lock of ['command', 'source', 'raw']) {
    const id = await stage(), a = await args(id), before = await sourceState(id, a.p_command_id);
    await race(`086_revocation_after_${lock}_wait`, lock === 'command' ? commandLock(a.p_command_id) : lock === 'source' ? sourceLock(id) : rawLock(id), importSql(a), { secondError: '42501', release: revoke + 'commit;' });
    assert.deepEqual(await sourceState(id, a.p_command_id), before); await restore();
  }
  {
    const id = await stage(), a = await args(id), before = await sourceState(id, a.p_command_id);
    await race('086_revocation_and_source_change_returns_acl_first', rawLock(id), importSql(a), { secondError: '42501', release: revoke + `update origin_sync.raw_record set version=version+1 where entity='warehouses' and source_id=${quote(id)};commit;` });
    assert.deepEqual(await sourceState(id, a.p_command_id), before); await restore();
  }
  for (const mode of ['create', 'replay', 'already_linked']) {
    const id = await stage(), a = await args(id); if (mode !== 'create') await apply(a);
    const request = mode === 'already_linked' ? { ...a, p_command_id: randomUUID() } : a, before = await sourceState(id, request.p_command_id), immutable = await immutableTables();
    await race(`086_revocation_after_membership_wait_${mode}`, `select user_id from erp_access.membership where user_id='${admin}' for update;`, importSql(request), { secondError: '42501', release: revoke + 'commit;' });
    assert.deepEqual(await sourceState(id, request.p_command_id), before); assert.deepEqual(await immutableTables(), immutable); await restore();
  }
  {
    const id = await stage(), a = await args(id); await apply(a); const before = await immutableTables();
    await race('086_revocation_after_command_wait_replay', commandLock(a.p_command_id), importSql(a), { secondError: '42501', release: revoke + 'commit;' });
    assert.deepEqual(await immutableTables(), before); rejected(await run('begin;' + rpcSql('erp_origin_warehouse_command', { p_user_id: admin, p_command_id: a.p_command_id }) + 'commit;'), '42501'); await restore();
  }
  {
    const id = await stage(), a = await args(id);
    const r = await race('086_final_membership_lock_blocks_later_revocation', importSql(a), revoke);
    assert.equal(result(r.first).receipt.outcome, 'created');
    rejected(await run('begin;' + rpcSql('erp_origin_warehouse_command', { p_user_id: admin, p_command_id: a.p_command_id }) + 'commit;'), '42501'); await restore();
  }
  {
    const id = await stage(), a = await args(id), before = await sourceState(id, a.p_command_id), immutable = await immutableTables(), records = await catalogRows();
    rejected(await run('begin;' + importSql(a) + 'select 1/0;commit;'), '22012');
    assert.deepEqual(await sourceState(id, a.p_command_id), before); assert.deepEqual(await immutableTables(), immutable); assert.deepEqual(await catalogRows(), records);
    results.push({ scenario: '086_late_error_rolls_back_record_binding_commands_audit', passed: true });
  }
  {
    const id = await stage(), a = await args(id), first = await apply(a), before = await immutableTables();
    await rpc('erp_catalog_set_active', { p_user_id: admin, p_entity: 'warehouses', p_id: first.current.record.id, p_expected_version: 1, p_command_id: randomUUID(), p_active: true });
    ok(await run(`delete from origin_sync.raw_record where entity='warehouses' and source_id=${quote(id)};`));
    const history = await lookup(a.p_command_id), replay = await apply(a);
    assert.deepEqual(history.receipt, first.receipt); assert.deepEqual(replay.receipt, first.receipt); assert.equal(history.current.record_state, 'changed'); assert.equal(history.current.source_state, 'missing'); assert.deepEqual(await immutableTables(), before);
    for (const table of ['binding', 'command']) rejected(await run(`update erp_warehouse_import.${table} set source_id=source_id where source_id=${quote(id)};`), '55000');
    rejected(await run('begin;' + rpcSql('erp_origin_warehouse_command', { p_user_id: other, p_command_id: a.p_command_id }) + 'commit;'), '42501');
    results.push({ scenario: '086_historical_receipt_immutable_despite_native_change_and_source_missing', passed: true });
  }
  assert.deepEqual(await fingerprints(), initial); assert.deepEqual(await object(procSql), functions);
  const finalCatalog = await catalogRows(); for (const [kind, rows] of Object.entries(initialCatalog)) for (const row of rows) assert.ok(finalCatalog[kind].some(v => JSON.stringify(v) === JSON.stringify(row)), `Prior ${kind} row preserved`);
  const security = await object(`select jsonb_build_object('private_tables',(select count(*) from pg_class c where c.relnamespace='erp_warehouse_import'::regnamespace and c.relkind='r' and c.relrowsecurity and not has_table_privilege('service_role',c.oid,'SELECT')),'service_rpc',(select count(*) from pg_proc p where pronamespace='public'::regnamespace and proname like 'erp_origin_warehouse_%' and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')),'grant_option',(select count(*) from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where (p.pronamespace='erp_warehouse_import'::regnamespace or p.proname like 'erp_origin_warehouse_%') and a.grantee<>p.proowner and a.is_grantable));`);
  assert.deepEqual(security, { private_tables: 2, service_rpc: 4, grant_option: 0 });
  results.push({ scenario: '086_prior_tables_catalog_rows_routines_and_acl_preserved', passed: true });
  console.log(JSON.stringify({ profile: 'warehouse-import-086-postgres-v1', source_sha256: sourceHash, postgres: '17-native', private_unix_socket: true, tcp: false, remote_executed: false, protected_unchanged_tables: Object.keys(initial).length, original_catalog_rows_preserved: true, scenarios: results }, null, 2));
} finally {
  for (const child of children) child.kill('SIGKILL');
  if (started || existsSync(join(root, 'data', 'postmaster.pid'))) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { env, stdio: 'ignore', timeout: 15000 });
  assert.match(root, /^\/Volumes\/Dev\/tmp\/brufap-warehouse-import086-[A-Za-z0-9]+$/); await rm(root, { recursive: true, force: true });
}
