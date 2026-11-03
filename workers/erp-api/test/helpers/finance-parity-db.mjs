import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Synthetic PGlite database with every migration in order, for the Origin finance parity tests (108 onward).
// 088 is skipped: it checks the hash of a production-only definition before replacing it and does not
// change the finance ledger. Nothing here reads real data.
const DIR = new URL('../../../../supabase/migrations/', import.meta.url);
const SKIP = new Set(['202610160088_financial_import_authorization_waits.sql']);
const ROLES = ['admin', 'financeiro', 'consulta', 'vendas', 'estoque', 'fiscal', 'inactive'];

export async function financeParityDb({ through, roles = ROLES } = {}) {
  const db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name)); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  const files = (await readdir(DIR)).filter(file => file.endsWith('.sql') && !SKIP.has(file) && (!through || file <= through)).sort();
  const load = async file => db.exec(await readFile(new URL(file, DIR), 'utf8'));
  for (const file of files) await load(file);
  const users = {};
  const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
  const literal = value => Array.isArray(value) ? `{${value.join(',')}}` : value && typeof value === 'object' ? JSON.stringify(value) : value;
  async function rpc(name, args) {
    const pairs = Object.entries(args); await db.exec('SET ROLE service_role');
    try { return await scalar(`SELECT public.${name}(${pairs.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) AS value`, pairs.map(([, value]) => literal(value))); }
    finally { await db.exec('RESET ROLE'); }
  }
  async function addUsers() {
    for (const role of roles) {
      users[role] = randomUUID(); await db.query('INSERT INTO auth.users(id) VALUES($1)', [users[role]]);
      await db.query('INSERT INTO erp_access.membership(user_id,role,active) VALUES($1,$2,$3)', [users[role], role === 'inactive' ? 'admin' : role, role !== 'inactive']);
    }
  }
  const contact = async data => (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { roles: ['customer', 'supplier'], ...data } })).record;
  return { db, files, load, users, scalar, rpc, addUsers, contact };
}
