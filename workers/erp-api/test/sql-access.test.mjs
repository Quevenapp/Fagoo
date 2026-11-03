import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

let db;
const roles = ['admin','consulta','vendas','financeiro','estoque','fiscal'];
const ids = Object.fromEntries(roles.map((role, index) => [role, `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const missing = 'a0000000-0000-4000-8000-000000000099';
const entities = ['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce'];
const expected = { admin: entities, consulta: entities, vendas: ['contacts','products','sales_orders','sales_proposals'],
  financeiro: ['contacts','receivables','payables'], estoque: ['contacts','products','purchase_orders'], fiscal: ['contacts','products','sales_orders','purchase_orders','nfe','nfce'] };
const sqlError = code => error => error.code === code;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const list = (user, entity, limit = 25, offset = 0, query = null, status = null, from = null, to = null) =>
  scalar('SELECT public.erp_read_records($1::uuid,$2,$3::int,$4::int,$5,$6,$7::date,$8::date) AS value', [user,entity,limit,offset,query,status,from,to]);
async function seed(entity, id, payload) {
  await db.query("INSERT INTO origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) VALUES($1,'erp_access_test',$2,$3::jsonb,$4)", [entity,id,JSON.stringify(payload),'a'.repeat(64)]);
}

before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);');
  for (const name of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql']) {
    await db.exec(await readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_access.membership'), 0, 'migration must not create an administrator');
  for (const role of roles) {
    await db.query('INSERT INTO auth.users(id) VALUES($1)', [ids[role]]);
    await db.query('INSERT INTO erp_access.membership(user_id,role) VALUES($1,$2)', [ids[role],role]);
  }
  await db.query('INSERT INTO auth.users(id) VALUES($1)', [missing]);
  await db.exec("INSERT INTO origin_sync.resource_state(resource) VALUES('erp_access_test')");
});
after(async () => db?.close());

test('membership and staging remain private with RLS and service-only RPCs', async () => {
  assert.equal(await scalar("SELECT relrowsecurity AS value FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='erp_access' AND relname='membership'"), true);
  for (const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(() => scalar('SELECT public.erp_access_me($1::uuid) AS value', [ids.admin]), sqlError('42501'));
      await assert.rejects(() => list(ids.admin,'contacts'), sqlError('42501'));
      await assert.rejects(() => db.query('SELECT * FROM erp_access.membership'), sqlError('42501'));
      await assert.rejects(() => db.query('SELECT * FROM origin_sync.raw_record'), sqlError('42501'));
    } finally { await db.exec('RESET ROLE'); }
  }
  await db.exec('SET ROLE service_role');
  try {
    await assert.rejects(() => db.query('SELECT * FROM erp_access.membership'), sqlError('42501'));
    await assert.rejects(() => db.query('SELECT * FROM origin_sync.raw_record'), sqlError('42501'));
    await assert.rejects(() => scalar('SELECT erp_access.resources_for_role(\'admin\') AS value'), sqlError('42501'));
    await assert.rejects(() => scalar('SELECT public.erp_access_me($1::uuid) AS value', [missing]), sqlError('42501'));
  } finally { await db.exec('RESET ROLE'); }
});

test('each role is restricted to its explicit entity list inside the database', async () => {
  await db.exec('SET ROLE service_role');
  try {
    for (const role of roles) {
      const me = await scalar('SELECT public.erp_access_me($1::uuid) AS value', [ids[role]]);
      assert.equal(me.role, role);
      assert.equal(me.user_id, ids[role]);
      assert.deepEqual([...me.resources].sort(), [...expected[role]].sort());
      assert.deepEqual(Object.keys(me).sort(), ['data_mode','resources','role','user_id']);
      for (const entity of entities) {
        if (expected[role].includes(entity)) assert.equal((await list(ids[role],entity)).entity, entity);
        else await assert.rejects(() => list(ids[role],entity), sqlError('42501'));
      }
    }
  } finally { await db.exec('RESET ROLE'); }
});

test('summaries preserve long IDs as text, resolve supplier names, and exclude raw fiscal URLs and sensitive fields', async () => {
  const id = '90071992547409931234';
  await seed('contacts', id, { nome:'Fornecedor Sintético', codigo:'C-01', email:'never-return@example.test', numeroDocumento:'private-document', endereco:{ rua:'private-address' } });
  await seed('purchase_orders', '77', { numero:123,data:'2026-10-15',total:200.1,fornecedor:{id},situacao:{id:1,valor:99},observacoes:'private-note' });
  await seed('sales_proposals', '88', { numero:124,data:'2026-10-14',total:80.5,contato:{id},situacao:2 });
  for (const entity of ['nfe','nfce']) await seed(entity,id,{ numero:'900',dataEmissao:'2026-10-15 10:00:00',valorNota:123.45,serie:1,tipo:1,situacao:6,contato:{id,nome:'Cliente Sintético',email:'private-email'},xml:'private-signed-url',linkDanfe:'private-url',chaveAcesso:'private-key',itens:[{secret:'private-item'}] });
  const purchase = (await list(ids.estoque,'purchase_orders')).items[0];
  assert.equal(purchase.counterparty_id,id);
  assert.equal(purchase.counterparty_name,'Fornecedor Sintético');
  assert.equal(purchase.status,'1');
  assert.equal(purchase.amount,'200.1');
  assert.equal((await list(ids.vendas,'sales_proposals')).items[0].counterparty_name,'Fornecedor Sintético');
  for (const entity of ['nfe','nfce']) {
    const item = (await list(ids.fiscal,entity)).items[0];
    assert.equal(item.id,id);
    assert.equal(item.model,entity === 'nfe' ? '55' : '65');
    assert.equal(item.amount,'123.45');
    assert.equal(item.date,'2026-10-15');
    assert.doesNotMatch(JSON.stringify(item), /private-|xml|linkDanfe|chaveAcesso|itens/);
  }
  assert.doesNotMatch(JSON.stringify(await list(ids.admin,'contacts')), /never-return|private-/);
});

test('pagination is bounded, deterministic, filtered and does not interpret wildcard or SQL input', async () => {
  for (const [id,name,status] of [['01','Produto A','A'],['02','Produto B','I'],['03','Produto % literal','A']]) await seed('products',id,{nome:name,codigo:id,situacao:status,preco:10});
  const first = await list(ids.estoque,'products',2,0);
  assert.deepEqual(first.items.map(row=>row.id),['01','02']);
  assert.equal(first.total,3); assert.equal(first.has_more,true); assert.equal(first.next_offset,2);
  const last = await list(ids.estoque,'products',2,2);
  assert.deepEqual(last.items.map(row=>row.id),['03']); assert.equal(last.has_more,false); assert.equal(last.next_offset,null);
  assert.equal((await list(ids.admin,'products',25,0,'%',null)).total,1);
  assert.equal((await list(ids.admin,'products',25,0,"' OR 1=1 --",null)).total,0);
  assert.equal((await list(ids.admin,'products',25,0,null,'I')).total,1);
  assert.equal((await list(ids.admin,'nfe',25,0,null,null,'2026-10-16','2026-10-17')).total,0);
  for (const [limit,offset] of [[0,0],[101,0],[25,-1],[25,100001]]) await assert.rejects(() => list(ids.admin,'products',limit,offset),sqlError('22023'));
  await assert.rejects(() => list(ids.admin,'products',25,0,'x'.repeat(121)),sqlError('22023'));
  await assert.rejects(() => list(ids.admin,'nfe',25,0,null,null,'2026-10-17','2026-10-16'),sqlError('22023'));
  await assert.rejects(() => list(ids.admin,'credentials'),sqlError('42501'));
});

test('deactivation immediately denies access; anonymous signup cannot self-enroll', async () => {
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[ids.vendas]);
  await assert.rejects(() => scalar('SELECT public.erp_access_me($1::uuid) AS value',[ids.vendas]),sqlError('42501'));
  await assert.rejects(() => list(ids.vendas,'contacts'),sqlError('42501'));
  await assert.rejects(() => list(missing,'contacts'),sqlError('42501'));
  await db.exec('SET ROLE authenticated');
  try { await assert.rejects(() => db.query("INSERT INTO erp_access.membership(user_id,role) VALUES($1,'admin')",[missing]),sqlError('42501')); }
  finally { await db.exec('RESET ROLE'); }
});

test('unexpected nested payload values are not serialized into allowed scalar fields', async () => {
  await seed('contacts','nested',{nome:{token:'private-token'},codigo:['private-code'],situacao:{secret:'private-status'}});
  const item=(await list(ids.admin,'contacts')).items.find(row=>row.id==='nested');
  assert.equal(item.name,null); assert.equal(item.code,null); assert.equal(item.status,null);
  assert.doesNotMatch(JSON.stringify(item), /private-/);
});
