// Synthetic PGlite fixture for the Frente de caixa (PDV) lane: every migration in order (088 skipped, as in finance-parity-db:
// it checks a production-only definition) up to `through`, with the Worker handler wired to the database like production.
// PostgREST sends the SQL message of a refusal; the Worker must reduce it to an allow-listed reason. Users of every role, a cash account (Loja), a bank, formas de pagamento, products with stock and a contact. No real data.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { bootstrap } from '../../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import { createHandler } from '../../src/index.mjs';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const SKIP = new Set(['202610160088_financial_import_authorization_waits.sql']);
const AUTH = 'alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;'
  + 'create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);'
  + 'create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);'
  + 'create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);';
const snapshots = new Map();
function snapshot(through) {
  if (!snapshots.has(through)) snapshots.set(through, (async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap); await db.exec(AUTH);
      const names = (await readdir(dir)).filter(name => name.endsWith('.sql') && !SKIP.has(name) && (!through || name.slice(0, 12) <= through)).sort();
      for (const name of names) await db.exec((await readFile(new URL(name, dir), 'utf8')).replace(/\r\n/g, '\n'));
      return await db.dumpDataDir('none');
    } finally { await db.close(); }
  })());
  return snapshots.get(through);
}
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

export async function posFixture({ through = null } = {}) {
  const db = new PGlite({ loadDataDir: await snapshot(through) });
  try {
    await db.waitReady;
    const scalar = async (text, args = []) => (await db.query(text, args)).rows[0]?.v;
    const types = new Map();
    const argTypes = async name => { if (!types.has(name)) types.set(name, new Map((await db.query("select x.n,x.t from pg_proc p,unnest(p.proargnames,string_to_array(oidvectortypes(p.proargtypes),', ')) x(n,t) where p.proname=$1 and p.pronamespace='public'::regnamespace", [name])).rows.map(r => [r.n, r.t]))); return types.get(name); };
    const rpc = async (name, args) => { const e = Object.entries(args), t = await argTypes(name); await db.exec('set role service_role'); try { return await scalar(`select public.${name}(${e.map(([k], i) => `${k}=>$${i + 1}`).join(',')})v`, e.map(([k, v]) => Array.isArray(v) && t.get(k)?.endsWith('[]') ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : v)); } finally { await db.exec('reset role'); } };
    const users = Object.fromEntries(['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal', 'vendedor', 'inactive'].map(r => [r, randomUUID()]));
    for (const [role, id] of Object.entries(users)) {
      await db.query('insert into auth.users(id,email)values($1,$2)', [id, `${role}@sintetico.test`]);
      await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)', [id, role === 'vendedor' ? 'vendas' : role === 'inactive' ? 'admin' : role, role !== 'inactive']);
    }
    const handler = createHandler({ fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
      try { return Response.json(await rpc(new URL(url).pathname.split('/').at(-1), JSON.parse(options.body))); } catch (e) { if (process.env.POS_FIXTURE_DEBUG) console.log('SQL', e.code, e.message, e.where); return Response.json({ code: e.code, message: e.message, details: 'SYNTHETIC_SQL_DETAIL' }, { status: 400 }); }
    } });
    const call = async (path, method = 'GET', body, user = users.admin) => { const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return { status: response.status, value: await response.json() }; };
    const catalog = async (entity, data) => (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
    const setPreference = async (page, key, value) => { const current = (await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: page })).items.find(item => item.key === key);
      return rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: current.version, value }] }); };
    const account = data => rpc('erp_finance_account_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
    const store = (await account({ account_type: 'cash', name: 'Caixa loja sintética', start_on: '2020-01-01', opening_cents: '0' })).record;
    const bank = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Banco sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' })).record;
    const method = async (description, type, destination = 'caixa', accountId = null) => (await db.query("insert into erp_catalog.payment_method(description,payment_type,destination,account_id,applicable,created_by,updated_by) values($1,$2,$3,$4,'ambos',$5,$5) returning id", [description, type, destination, accountId, users.admin])).rows[0].id;
    const methods = { dinheiro: await method('Dinheiro', '01'), cartao: await method('Cartão de crédito', '03', 'contas'), pix: await method('Pix', '20', 'caixa', bank.id) };
    const warehouse = await catalog('warehouses', { name: 'Depósito sintético PDV' });
    const product = await catalog('products', { name: 'Caneta sintética', code: 'CAN-01', unit: 'UN', kind: 'P', format: 'S', price: '10', gtin: '7891234567895' });
    const other = await catalog('products', { name: 'Caderno sintético', code: 'CAD-01', unit: 'UN', kind: 'P', format: 'S', price: '25.50' });
    const service = await catalog('products', { name: 'Embalagem para presente', code: 'SRV-01', unit: 'UN', kind: 'S', format: 'S', price: '5' });
    const contact = await catalog('contacts', { name: 'Cliente sintético PDV', roles: ['customer'] });
    const consumer = await catalog('contacts', { name: 'Consumidor final', roles: ['customer'] });
    const receive = async (productId, quantity) => { const version = Number(await scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v', [productId, warehouse.id]));
      return rpc('erp_stock_post', { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: today(), p_reason: 'Saldo sintético do PDV', p_items: [{ product_id: productId, warehouse_id: warehouse.id, quantity, expected_version: version }] }); };
    const stock = async productId => scalar('select coalesce((select quantity from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)::text v', [productId, warehouse.id]);
    const balance = async accountId => scalar('select coalesce(sum(delta_cents),0)::text v from erp_finance.movement where account_id=$1', [accountId]);
    return { db, scalar, rpc, users, call, catalog, setPreference, store, bank, methods, warehouse, product, other, service, contact, consumer, receive, stock, balance, close: () => db.close() };
  } catch (e) { await db.close(); throw e; }
}
