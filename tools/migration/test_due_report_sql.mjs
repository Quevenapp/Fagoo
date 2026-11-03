import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DueReportError, dueReportMethods, parseDueReportRoute, executeDueReportRoute, dueReportResponse } from '../../workers/erp-api/src/due-report.mjs';
let db, contact, today; const users = {};
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const code = expected => error => error.code === expected;
async function role(who, task) { await db.exec(`set role ${who}`); try { return await task(); } finally { await db.exec('reset role'); } }
const report = (from = null, to = null, user = users.admin) => role('service_role', () => scalar('select public.erp_finance_due_report($1,$2,$3) value', [user, from, to]));
const execute = (action, data) => role('service_role', () => scalar('select public.erp_finance_execute($1,$2,$3,$4::jsonb) value', [users.financeiro, randomUUID(), action, JSON.stringify(data)]));
const insert = ({ day, kind = 'receivable', amount = '100', settled = '0', cancelled = false }) => db.query(
  "insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents,cancelled) values($1,1,1,$2,$3,'Somente teste sintético','1900-01-01',$4,$5,$6,$7)",
  [randomUUID(), kind, contact, day, amount, settled, cancelled]);
before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for (const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0010_erp_finance','0026_finance_due_report'])
    await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`, import.meta.url), 'utf8'));
  for (const who of ['admin', 'financeiro', 'consulta', 'vendas', 'estoque', 'fiscal', 'inactive', 'unlisted']) {
    users[who] = randomUUID(); await db.query('insert into auth.users values($1)', [users[who]]);
    if (who !== 'unlisted') await db.query('insert into erp_access.membership(user_id,role,active) values($1,$2,$3)', [users[who], who === 'inactive' ? 'admin' : who, who !== 'inactive']);
  }
  contact = (await scalar('select public.erp_catalog_save($1,$2,null,0,$3,$4::jsonb) value', [users.admin, 'contacts', randomUUID(), JSON.stringify({ name: 'Pessoa sintética relatório', roles: ['customer', 'supplier'] })])).record.id;
  today = (await report()).business_date;
});
after(async () => db?.close());

test('026 is service-only, enforces active financial read roles, and leaves table/RLS privileges private', async () => {
  for (const who of ['anon', 'authenticated']) await assert.rejects(() => role(who, () => scalar('select public.erp_finance_due_report($1) value', [users.admin])), code('42501'));
  for (const who of ['vendas', 'estoque', 'fiscal', 'inactive', 'unlisted']) await assert.rejects(() => report(null, null, users[who]), code('42501'));
  for (const actor of [null, randomUUID()]) await assert.rejects(() => report(null, null, actor), code('42501'));
  for (const who of ['admin', 'financeiro', 'consulta']) assert.equal((await report(null, null, users[who])).role, who);
  for (const who of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("select has_table_privilege($1,'erp_finance.title','SELECT,INSERT,UPDATE,DELETE') value", [who]), false);
  const fn = (await db.query("select prosecdef,provolatile,proconfig from pg_proc where oid='public.erp_finance_due_report(uuid,text,text)'::regprocedure")).rows[0];
  assert.equal(fn.prosecdef, true); assert.equal(fn.provolatile, 's'); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']);
  assert.equal(await scalar("select relrowsecurity value from pg_class where oid='erp_finance.title'::regclass"), true);
});
test('026 defaults to 30 inclusive São Paulo days and includes zero days without inventing titles', async () => {
  const value = await report(); assert.deepEqual(dueReportResponse(value), value);
  assert.equal(value.from, today); assert.equal(value.day_count, 30); assert.equal(value.days.length, 30);
  assert.equal(value.days[0].day, today); assert.equal(value.days.at(-1).day, value.to);
  assert.equal(value.totals.receivable_count, '0'); assert.ok(value.days.every(row => row.difference_cents === '0'));
  assert.equal(value.timezone, 'America/Sao_Paulo'); assert.equal(value.basis, 'outstanding_principal');
});
test('026 validates both calendar dates, inclusive 366-day limit and no partial/default mixed period', async () => {
  for (const [from, to] of [[null,'2024-01-01'],['2024-01-01',null],['2024-01-02','2024-01-01'],['2024-01-01','2025-01-01'],['2023-02-29','2023-03-01'],['2024-02-30','2024-03-01'],['2024-1-1','2024-01-01'],['2024-01-01 ','2024-01-01'],['1899-12-31','1900-01-01'],['2100-12-31','2101-01-01'],['today','today'],['infinity','infinity']])
    await assert.rejects(() => report(from, to), code('22023'));
  for (const period of [['1900-01-01','1900-01-01'],['2100-12-31','2100-12-31'],['2024-02-29','2024-02-29'],['2024-01-01','2024-12-31']]) {
    const value = await report(...period); assert.equal(value.days[0].day, period[0]); assert.equal(value.days.at(-1).day, period[1]);
    dueReportResponse(value, { p_from: period[0], p_to: period[1] });
  }
});
test('026 includes exact boundary dates once, partial principal only, and excludes paid/cancelled/outside titles', async () => {
  for (const item of [{ day:'2024-02-27',amount:'900' },{ day:'2024-02-28',amount:'10001',settled:'2501' },{ day:'2024-02-28',kind:'payable',amount:'9000' },
    { day:'2024-02-29',amount:'1' },{ day:'2024-03-01',amount:'302' },{ day:'2024-03-02',amount:'700' },
    { day:'2024-02-29',amount:'50',settled:'50' },{ day:'2024-03-01',amount:'500',cancelled:true }]) await insert(item);
  const value = dueReportResponse(await report('2024-02-28','2024-03-01'), { p_from:'2024-02-28',p_to:'2024-03-01' });
  assert.deepEqual(value.totals, {receivable_count:'3',receivable_cents:'7803',payable_count:'1',payable_cents:'9000',difference_cents:'-1197'});
  assert.deepEqual(value.days.map(row => [row.day, row.receivable_cents, row.payable_cents]), [['2024-02-28','7500','9000'],['2024-02-29','1','0'],['2024-03-01','302','0']]);
  const longer = await report('2024-02-28','2024-03-05'); assert.equal(longer.days.at(-1).receivable_count,'0');
});
test('026 totals remain exact beyond JS safe integers AND bigint SUM range', async () => {
  await db.query("insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents) select gen_random_uuid(),1,1,'receivable',$1,'Agregado fictício','2023-01-01','2023-01-01',999999999999999 from generate_series(1,10000)", [contact]);
  const value = dueReportResponse(await report('2023-01-01','2023-01-01'), { p_from:'2023-01-01',p_to:'2023-01-01' });
  assert.equal(value.totals.receivable_count,'10000'); assert.equal(value.totals.receivable_cents,'9999999999999990000');
  assert.ok(BigInt(value.totals.receivable_cents) > 9223372036854775807n);
});
test('026 follows real settlement/reversal principal without double-counting movements, charges, or historical events', async () => {
  const account = (await execute('account_save', {expected_version:0,name:'Conta teste vencimentos',kind:'bank'})).record;
  const title = (await execute('title_create_group', {kind:'payable',contact_id:contact,description:'Título teste vencimentos',issued_on:today,total_cents:'101',installments:[{due_on:today,amount_cents:'101'}]})).items[0];
  const baseline = await report(today,today); assert.equal(baseline.totals.payable_cents,'101');
  const first = await execute('settle',{id:title.id,expected_version:1,account_id:account.id,posted_on:today,principal_cents:'51',interest_cents:'100',fee_cents:'10'});
  assert.equal((await report(today,today)).totals.payable_cents,'50');
  await execute('reverse',{id:title.id,expected_version:2,settlement_id:first.settlement.id,posted_on:today,note:'Estorno sintético'});
  const restored = await report(today,today); assert.equal(restored.totals.payable_count,'1'); assert.equal(restored.totals.payable_cents,'101');
  await execute('settle',{id:title.id,expected_version:3,account_id:account.id,posted_on:today,principal_cents:'101'});
  assert.equal((await report(today,today)).totals.payable_count,'0');
});
test('026 performs no writes even when invoked repeatedly in a read-only transaction', async () => {
  const counts = () => scalar("select jsonb_build_object('title',(select count(*) from erp_finance.title),'movement',(select count(*) from erp_finance.movement),'command',(select count(*) from erp_finance.command),'audit',(select count(*) from erp_finance.audit)) value");
  const before = await counts(); await db.exec('begin read only');
  try { await report(); await report('2024-01-01','2024-12-31'); } finally { await db.exec('rollback'); }
  assert.deepEqual(await counts(), before);
});
test('026 HTTP exposes only exact GET route and rejects duplicate/unknown or malformed period arguments', () => {
  assert.deepEqual(dueReportMethods('/v1/relatorios/vencimentos'),['GET']); assert.equal(dueReportMethods('/v1/relatorios/vencimentos/'),null);
  assert.deepEqual(parseDueReportRoute(new Request('https://synthetic.invalid/v1/relatorios/vencimentos')).args,{p_from:null,p_to:null});
  for (const query of ['from=2024-01-01','from=2024-01-01&to=2024-01-01&from=2024-01-01','from=2024-01-01&to=2025-01-01','from=2024-02-30&to=2024-03-01','actor=x','limit=366','from=&to='])
    assert.throws(() => parseDueReportRoute(new Request(`https://synthetic.invalid/v1/relatorios/vencimentos?${query}`)), error => error instanceof DueReportError && error.status===400);
  assert.throws(() => parseDueReportRoute(new Request('https://synthetic.invalid/v1/relatorios/vencimentos',{method:'POST'})), error => error.status===405);
});
test('026 HTTP verifies request period, projection, complete ordered dates, all sums, counts, and role before returning', async () => {
  const route = parseDueReportRoute(new Request('https://synthetic.invalid/v1/relatorios/vencimentos?from=2024-02-28&to=2024-03-01'));
  const value = await executeDueReportRoute(route,{userId:users.consulta,rpc:async(name,args) => {
    assert.equal(name,'erp_finance_due_report'); assert.equal(args.p_user_id,users.consulta); return report(args.p_from,args.p_to,args.p_user_id);
  }}); assert.equal(value.role,'consulta');
  await assert.rejects(() => executeDueReportRoute(route,{userId:null,rpc:()=>{throw Error('must not run');}}), error=>error.status===403);
  for (const mutate of [v=>v.role='vendas',v=>v.days.reverse(),v=>v.days.pop(),v=>v.days[0].receivable_cents='1',v=>v.days[0].receivable_count=1,
    v=>v.days[0].difference_cents='-0',v=>v.totals.receivable_cents='7804',v=>v.from='2024-02-27',v=>v.day_count=2,v=>v.basis='bank_balance',
    v=>v.business_date='1900-01-01',v=>v.as_of='2026-10-16T24:00:00Z']) {
    const raw=structuredClone(value); mutate(raw); assert.throws(()=>dueReportResponse(raw,route.args),error=>error.status===502);
  }
  const raw=structuredClone(value); raw.contact_name='Discard'; raw.days[0].title_id=randomUUID(); raw.totals.raw='Discard';
  assert.deepEqual(dueReportResponse(raw,route.args),value);
});
