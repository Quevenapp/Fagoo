// Synthetic PGlite fixture for wave E of the notas fiscais lane: every migration published in production (through 202610200233,
// in file order) and then the lane E files 202610200251-257 that exist (or only those up to `upto`). Every HTTP call goes through
// the real Worker handler, as in production. No real data.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { bootstrap } from '../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import { createHandler } from '../../src/index.mjs';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const sql = async name => (await readFile(new URL(name, dir), 'utf8')).replace(/\r\n/g, '\n');
// Supabase Auth columns and tables read by migrations 117 and 151 (absent from the shared bootstrap stub).
const AUTH = 'alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;'
  + 'create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);'
  + 'create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);'
  + 'create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);';
export const PUBLISHED = name => /^20261\d{7}_.+\.sql$/.test(name) && name.slice(0, 12) <= '202610200233';
export const LANE_E = name => /^2026102002(5[1-7])_.+\.sql$/.test(name);
const snapshots = new Map();
function snapshot(upto) {
  if (!snapshots.has(upto)) snapshots.set(upto, (async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap); await db.exec(AUTH);
      const names = (await readdir(dir)).sort();
      for (const name of names.filter(PUBLISHED)) await db.exec(await sql(name));
      for (const name of names.filter(LANE_E).filter(name => upto === null || name.slice(0, 12) <= upto)) await db.exec(await sql(name));
      return await db.dumpDataDir('none');
    } finally { await db.close(); }
  })());
  return snapshots.get(upto);
}
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
export const migrationText = sql;
/** `upto` (a migration prefix such as '202610200251') limits the lane E files; '0' applies none (the production state). */
export async function fiscalWaveEFixture({ upto = null } = {}) {
  const db = new PGlite({ loadDataDir: await snapshot(upto) });
  try {
    await db.waitReady;
    const scalar = async (text, args = []) => (await db.query(text, args)).rows[0]?.v;
    // PostgREST turns a JSON array into a Postgres array for text[]/uuid[] arguments and keeps JSON for jsonb ones; so does this helper.
    const types = new Map();
    const argTypes = async name => {
      if (!types.has(name)) types.set(name, new Map((await db.query("select x.n,x.t from pg_proc p,unnest(p.proargnames,string_to_array(oidvectortypes(p.proargtypes),', ')) x(n,t) where p.proname=$1 and p.pronamespace='public'::regnamespace", [name])).rows.map(r => [r.n, r.t])));
      return types.get(name);
    };
    const rpc = async (name, args) => {
      const e = Object.entries(args), t = await argTypes(name);
      await db.exec('set role service_role');
      try { return await scalar(`select public.${name}(${e.map(([k], i) => `${k}=>$${i + 1}`).join(',')})v`, e.map(([k, v]) => Array.isArray(v) && t.get(k)?.endsWith('[]') ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : v)); }
      finally { await db.exec('reset role'); }
    };
    const users = Object.fromEntries(['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'].map(r => [r, randomUUID()]));
    for (const [role, id] of Object.entries(users)) {
      await db.query('insert into auth.users(id,email)values($1,$2)', [id, `${role}@sintetico.test`]);
      await db.query('insert into erp_access.membership(user_id,role)values($1,$2)', [id, role]);
    }
    const handler = createHandler({ fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
      try { return Response.json(await rpc(new URL(url).pathname.split('/').at(-1), JSON.parse(options.body))); }
      catch (e) { return Response.json({ code: e.code, message: /^erp_[a-z0-9_]{1,80}$/.test(e.message) ? e.message : 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); }
    } });
    const call = async (path, method = 'GET', body, user = users.admin) => {
      const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
      return { status: response.status, value: await response.json() };
    };
    const catalog = async (entity, data, user = users.admin) => (await rpc('erp_catalog_save', { p_user_id: user, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
    const setPreference = async (page, key, value) => {
      const current = (await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: page })).items.find(item => item.key === key);
      return rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: current.version, value }] });
    };
    const company = async ({ crt = '1', state = 'SP' } = {}) => {
      await db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2) on conflict(singleton) do nothing", [JSON.stringify({ legal_name: 'Empresa Sintética Ltda', trade_name: 'Sintética', cnpj: '11222333000181', ie: '110042490114', state, city: 'São Paulo', municipality_code: '3550308', postal_code: '01001000', street: 'Praça Sintética', number: '1', district: 'Centro' }), users.admin]);
      await db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,$1,now(),$2) on conflict(singleton) do nothing", [crt, users.admin]);
    };
    return { db, scalar, rpc, users, call, catalog, setPreference, company, close: () => db.close() };
  } catch (e) { await db.close(); throw e; }
}
