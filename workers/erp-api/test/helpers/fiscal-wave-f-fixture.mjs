// Synthetic PGlite fixture for wave F of the notas fiscais lane: every migration applied in production (through 202610200266, in
// file order) and then the lane F files 202610200273-276 that exist (or only those up to `upto`; '0' applies none, the production
// state). Every HTTP call goes through the real Worker handler, as in production. No real data.
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
export const APPLIED = name => /^20261\d{7}_.+\.sql$/.test(name) && name.slice(0, 12) <= '202610200266';
export const LANE_F = name => /^2026102002(7[3-6])_.+\.sql$/.test(name);
const snapshots = new Map();
function snapshot(upto) {
  if (!snapshots.has(upto)) snapshots.set(upto, (async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap); await db.exec(AUTH);
      const names = (await readdir(dir)).sort();
      for (const name of names.filter(APPLIED)) await db.exec(await sql(name));
      for (const name of names.filter(LANE_F).filter(name => upto === null || name.slice(0, 12) <= upto)) await db.exec(await sql(name));
      return await db.dumpDataDir('none');
    } finally { await db.close(); }
  })());
  return snapshots.get(upto);
}
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
export const migrationText = sql;
export const COMPANY_CNPJ = '11222333000181';
/** `upto` (a migration prefix such as '202610200273') limits the lane F files; '0' applies none (the production state). */
export async function fiscalWaveFFixture({ upto = null } = {}) {
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
    /** Company identity (016), regime (CRT) and the extra data of Alterar dados da empresa (151). */
    const company = async ({ crt = '1', state = 'SP', identity = {}, extra = null } = {}) => {
      await db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2) on conflict(singleton) do update set data=excluded.data,version=erp_company.identity.version+1", [JSON.stringify({ legal_name: 'Empresa Sintética Ltda', trade_name: 'Sintética', cnpj: COMPANY_CNPJ, ie: '110042490114', state, city: 'São Paulo', municipality_code: '3550308', postal_code: '01001000', street: 'Praça Sintética', number: '1', district: 'Centro', phone: '1130001000', ...identity }), users.admin]);
      await db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,$1,now(),$2) on conflict(singleton) do update set crt=excluded.crt", [crt, users.admin]);
      if (extra) await db.query("insert into erp_company.extra(singleton,version,data,updated_at,updated_by,command_id) values(true,1,erp_company.extra_normalize($1::jsonb),now(),$2,$3) on conflict(singleton) do update set data=excluded.data,version=erp_company.extra.version+1",
        [JSON.stringify({ billing_email: null, cnae: null, company_size: null, contacts: null, employees: null, ie_exempt: false, mobile: null, municipal_registration: null, person_type: 'juridica', revenue: null, segments: ['comercio'], site: null, substitute_ies: [], suframa: null, ...extra }), users.admin, randomUUID()]);
    };
    const nature = async data => (await rpc('erp_fiscal_nature_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
    const invoice = async (data, orders = [], user = users.admin) => (await rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: data, orders } })).invoice;
    const warehouse = async name => (await rpc('erp_stock_warehouse_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: name, p_ignore_balance: false })).warehouse;
    return { db, scalar, rpc, users, call, catalog, setPreference, company, nature, invoice, warehouse, close: () => db.close() };
  } catch (e) { await db.close(); throw e; }
}
