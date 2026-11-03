import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseFinanceRoute, executeFinanceRoute, financeMethods } from '../src/finance.mjs';
let db; let today; let contact; const users = {};
const code = expected => error => error.code === expected;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
async function rpc(name, args, types) {
  await db.exec('SET ROLE service_role');
  try { return await scalar(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}::${types[i]}`).join(',')}) AS value`, args); }
  finally { await db.exec('RESET ROLE'); }
}
const execute = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_execute',[user,command,action,JSON.stringify(data)],['uuid','uuid','text','jsonb']);
const get = (entity,id,user=users.consulta) => rpc('erp_finance_get',[user,entity,id],['uuid','text','uuid']);
const list = (entity,opts={}) => rpc('erp_finance_list',[opts.user||users.consulta,entity,opts.limit||25,opts.after||null,opts.q||null,opts.status||null,opts.kind||null,opts.from||null,opts.to||null,opts.parent||null],['uuid','text','int','uuid','text','text','text','date','date','uuid']);
const account = async () => (await execute('account_save',{expected_version:0,name:'Conta sintética',kind:'bank'})).record;
const titles = async (amount='10000',kind='receivable',installments=[{amount_cents:amount,due_on:today}]) => (await execute('title_create_group',{kind,contact_id:contact.id,description:'Título sintético',issued_on:today,total_cents:amount,installments})).items;
before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name)); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  for (const file of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql','202610160006_erp_catalog.sql','202610160008_erp_documents.sql','202610160009_erp_stock.sql','202610160010_erp_finance.sql','202610160011_catalog_stock_lock_order.sql','202610160014_erp_cnab.sql','202610160017_document_finance.sql','202610160018_document_stock.sql','202610160019_document_effect_flags.sql']) await db.exec(await readFile(new URL(`../../../supabase/migrations/${file}`,import.meta.url),'utf8'));
  for (const role of ['admin','financeiro','consulta','vendas','estoque','fiscal','inactive','unlisted']) {
    users[role]=randomUUID(); await db.query('INSERT INTO auth.users(id) VALUES($1)',[users[role]]);
    if (role!=='unlisted') await db.query('INSERT INTO erp_access.membership(user_id,role,active) VALUES($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);
  }
  today=await scalar("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS value");
  contact=(await rpc('erp_catalog_save',[users.admin,'contacts',null,0,randomUUID(),JSON.stringify({name:'Contato sintético',roles:['customer','supplier']})],['uuid','text','uuid','int','uuid','jsonb'])).record;
});
after(async()=>db?.close());

test('finance tables are private with RLS and permissions are rechecked in service-only RPCs',async()=>{
  const tables=(await db.query("SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='erp_finance' AND c.relkind='r'")).rows;
  assert.equal(tables.length,10); assert.ok(tables.every(row=>row.relrowsecurity));
  for(const role of ['anon','authenticated','service_role']) for(const table of tables) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS value",[role,`erp_finance.${table.relname}`]),false);
  for(const role of ['anon','authenticated']) {await db.exec(`SET ROLE ${role}`);try{await assert.rejects(()=>scalar('SELECT public.erp_finance_access($1) AS value',[users.admin]),code('42501'));}finally{await db.exec('RESET ROLE');}}
  for(const role of ['admin','financeiro','consulta']) assert.deepEqual(await rpc('erp_finance_access',[users[role]],['uuid']),{read:true,write:role!=='consulta',data_mode:'erp_native'});
  for(const role of ['vendas','estoque','fiscal','inactive','unlisted']) await assert.rejects(()=>list('titles',{user:users[role]}),code('42501'));
  await assert.rejects(()=>execute('account_save',{expected_version:0,name:'Negada',kind:'cash'},users.consulta),code('42501'));
});

test('accounts start at zero and opening is explicit, audited, exact, replayable and only once',async()=>{
  const a=await account(); assert.equal(a.balance_cents,'0'); assert.equal(a.opening_recorded,false);
  const command=randomUUID(); const data={id:a.id,expected_version:a.version,amount_cents:'-12345',posted_on:today,note:'Abertura sintética'};
  const opened=await execute('opening',data,users.financeiro,command); assert.equal(opened.record.balance_cents,'-12345'); assert.equal(opened.record.version,2);
  const replay=await execute('opening',data,users.financeiro,command); assert.equal(replay.replayed,true);
  await assert.rejects(()=>execute('opening',{...data,expected_version:2}),code('40001'));
  await assert.rejects(()=>execute('opening',{...data,amount_cents:'-12346'},users.financeiro,command),code('40001'));
  const movement=await list('movements',{parent:a.id}); assert.equal(movement.items.length,1); assert.equal(movement.items[0].delta_cents,'-12345'); assert.equal(movement.items[0].actor,undefined);
});

test('installment groups are atomic, sum exactly, preserve source annotation and never link a fake document FK',async()=>{
  const plan=await titles('10000','receivable',[{amount_cents:'3333',due_on:today},{amount_cents:'3333',due_on:today},{amount_cents:'3334',due_on:today}]);
  assert.equal(new Set(plan.map(row=>row.group_id)).size,1); assert.deepEqual(plan.map(row=>row.installment),[1,2,3]); assert.ok(plan.every(row=>row.installments===3));
  const before=await scalar('SELECT count(*)::int AS value FROM erp_finance.title');
  await assert.rejects(()=>titles('10000','receivable',[{amount_cents:'9999',due_on:today}]),code('22023'));
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.title'),before);
  await assert.rejects(()=>execute('title_update',{id:plan[0].id,expected_version:1,amount_cents:'3334'}),code('40001'));
  const updated=await execute('title_update',{id:plan[0].id,expected_version:1,source_reference:'Anotação sem vínculo validado'}); assert.equal(updated.record.source_reference,'Anotação sem vínculo validado'); assert.equal(updated.record.document_id,undefined);
});

test('partial receivable with charges reconciles principal and cash; reversal is exact and cannot be repeated',async()=>{
  const a=await account(); const [title]=await titles(); const command=randomUUID();
  const data={id:title.id,expected_version:1,account_id:a.id,posted_on:today,principal_cents:'4000',interest_cents:'100',penalty_cents:'50',discount_cents:'25',fee_cents:'20'};
  const paid=await execute('settle',data,users.financeiro,command);
  assert.equal(paid.record.status,'partial'); assert.equal(paid.record.balance_cents,'6000'); assert.equal(paid.settlement.net_cash_cents,'4105'); assert.equal(paid.account.balance_cents,'4105');
  assert.equal((await execute('settle',data,users.financeiro,command)).replayed,true);
  await assert.rejects(()=>execute('settle',{...data,principal_cents:'1'}),code('40001'));
  await assert.rejects(()=>execute('settle',{...data,expected_version:2,principal_cents:'6001'}),code('40001'));
  await assert.rejects(()=>execute('title_cancel',{id:title.id,expected_version:2,note:'Não pode cancelar'}),code('40001'));
  const reversed=await execute('reverse',{id:title.id,expected_version:2,settlement_id:paid.settlement.id,posted_on:today,note:'Reversão sintética'});
  assert.equal(reversed.record.status,'open'); assert.equal(reversed.record.balance_cents,'10000'); assert.equal(reversed.account.balance_cents,'0');
  for(const field of ['principal_cents','interest_cents','penalty_cents','discount_cents','fee_cents','net_cash_cents']) assert.equal(reversed.settlement[field],paid.settlement[field]);
  await assert.rejects(()=>execute('reverse',{id:title.id,expected_version:3,settlement_id:paid.settlement.id,posted_on:today,note:'Duplicada'}),code('40001'));
  await assert.rejects(()=>execute('reverse',{id:title.id,expected_version:3,settlement_id:reversed.settlement.id,posted_on:today,note:'Reversão da reversão'}),code('40001'));
  await assert.rejects(()=>execute('title_update',{id:title.id,expected_version:3,amount_cents:'12000'}),code('40001'));
  const cancelled=await execute('title_cancel',{id:title.id,expected_version:3,note:'Cancelado após reversão'}); assert.equal(cancelled.record.status,'cancelled');
  await assert.rejects(()=>execute('settle',{...data,expected_version:4}),code('40001'));
});

test('payable fees increase outgoing cash; successive partials reach paid with no excess principal',async()=>{
  const a=await account(); const [title]=await titles('10000','payable');
  const first=await execute('settle',{id:title.id,expected_version:1,account_id:a.id,posted_on:today,principal_cents:'4000',fee_cents:'30'});
  assert.equal(first.settlement.net_cash_cents,'4030'); assert.equal(first.account.balance_cents,'-4030');
  const second=await execute('settle',{id:title.id,expected_version:2,account_id:a.id,posted_on:today,principal_cents:'6000'});
  assert.equal(second.record.status,'paid'); assert.equal(second.record.balance_cents,'0'); assert.equal(second.account.balance_cents,'-10030');
  const rows=await list('settlements',{parent:title.id,limit:1}); assert.equal(rows.has_more,true); assert.equal(rows.items.length,1); assert.ok(rows.next_cursor);
  assert.equal((await list('settlements',{parent:title.id,limit:1,after:rows.next_cursor})).items.length,1);
});

test('invalid cents, negative net cash, dates, contact/category references and extra fields fail atomically',async()=>{
  const a=await account(); const [title]=await titles();
  const base={id:title.id,expected_version:1,account_id:a.id,posted_on:today,principal_cents:'100'};
  for(const principal of [100,'1.00','1e2','-1','0','1000000000000000']) await assert.rejects(()=>execute('settle',{...base,principal_cents:principal}),code('22023'));
  await assert.rejects(()=>execute('settle',{...base,fee_cents:'101'}),code('22023'));
  await assert.rejects(()=>execute('settle',{...base,discount_cents:'101'}),code('22023'));
  for(const date of ['2026-02-30','2101-01-01','1900-01-01','2099-01-01']) await assert.rejects(()=>execute('settle',{...base,posted_on:date}),code('22023'));
  await assert.rejects(()=>execute('settle',{...base,bank_api:true}),code('22023'));
  assert.equal((await get('titles',title.id)).record.version,1); assert.equal((await get('accounts',a.id)).record.balance_cents,'0');
  await assert.rejects(()=>execute('title_create_group',{kind:'receivable',contact_id:randomUUID(),description:'Inválido',issued_on:today,total_cents:'1',installments:[{amount_cents:'1',due_on:today}]}),code('22023'));
});

test('category/account CAS and archive semantics preserve existing state; membership revocation blocks writes',async()=>{
  const a=await account(); const archived=await execute('account_save',{id:a.id,expected_version:1,name:'Arquivada',kind:'bank',active:false});
  const rename=await execute('account_save',{id:a.id,expected_version:2,name:'Renomeada',kind:'bank'}); assert.equal(rename.record.active,false);
  await assert.rejects(()=>execute('account_save',{id:a.id,expected_version:1,name:'Desatualizada',kind:'bank'}),code('40001'));
  const [title]=await titles(); await assert.rejects(()=>execute('settle',{id:title.id,expected_version:1,account_id:archived.record.id,posted_on:today,principal_cents:'1'}),code('22023'));
  const category=await execute('category_save',{expected_version:0,name:'Categoria sintética',kind:'payable'}); assert.equal(category.record.kind,'payable');
  await assert.rejects(()=>execute('title_create_group',{kind:'receivable',contact_id:contact.id,category_id:category.record.id,description:'Incompatível',issued_on:today,total_cents:'1',installments:[{amount_cents:'1',due_on:today}]}),code('22023'));
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[users.financeiro]);
  await assert.rejects(()=>execute('account_save',{expected_version:0,name:'Negada',kind:'cash'}),code('42501'));
  await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1',[users.financeiro]);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM origin_sync.raw_record'),0);
});

test('financial API contracts execute against real SQL, preserve cent strings and discard unapproved fields',async()=>{
  const api=async(path,method='GET',body,user=users.admin)=>{
    const route=await parseFinanceRoute(new Request(`https://api.example.test${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}));
    return executeFinanceRoute(route,{userId:user,rpc:async(name,args)=>{
      const entries=Object.entries(args);await db.exec('SET ROLE service_role');
      try {const value=await scalar(`SELECT public.${name}(${entries.map(([key],index)=>`${key} => $${index+1}`).join(',')}) AS value`,entries.map(([key,value])=>key==='p_data'?JSON.stringify(value):value));return {...value,raw:'private',...(value.record?{record:{...value.record,actor:'private'}}:{})};}
      finally{await db.exec('RESET ROLE');}
    }});
  };
  assert.deepEqual(await api('/v1/financeiro'),{read:true,write:true,data_mode:'erp_native'});
  const created=await api('/v1/financeiro/actions/account_save','POST',{command_id:randomUUID(),data:{expected_version:0,name:'API sintética',kind:'cash'}});
  assert.equal(created.record.balance_cents,'0');assert.equal(created.raw,undefined);assert.equal(created.record.actor,undefined);
  const opening=await api('/v1/financeiro/actions/opening','POST',{command_id:randomUUID(),data:{id:created.record.id,expected_version:1,amount_cents:'-100',posted_on:today,note:'Teste API'}});
  assert.equal(opening.record.balance_cents,'-100');
  const plan=await api('/v1/financeiro/actions/title_create_group','POST',{command_id:randomUUID(),data:{kind:'receivable',contact_id:contact.id,description:'API parcela',issued_on:today,total_cents:'99',installments:[{amount_cents:'99',due_on:today}]}});
  assert.equal(plan.items[0].amount_cents,'99');
  const settled=await api('/v1/financeiro/actions/settle','POST',{command_id:randomUUID(),data:{id:plan.items[0].id,expected_version:1,account_id:created.record.id,posted_on:today,principal_cents:'99'}});
  assert.equal(settled.account.balance_cents,'-1');assert.equal(settled.record.status,'paid');
  const listed=await api(`/v1/financeiro/settlements?parent_id=${plan.items[0].id}&limit=1`);assert.equal(listed.items[0].principal_cents,'99');assert.equal(listed.items[0].actor,undefined);
  assert.equal((await api(`/v1/financeiro/titles/${plan.items[0].id}`)).record.balance_cents,'0');
});

test('financial route parsing rejects arbitrary operations, numeric money, unsafe queries and malformed commands',async()=>{
  assert.equal(await parseFinanceRoute(new Request('https://api.example.test/v1/records/contacts')),null);
  assert.deepEqual(financeMethods('/v1/financeiro/actions/settle'),['POST']);assert.deepEqual(financeMethods('/v1/financeiro/titles'),['GET']);
  for(const path of ['/v1/financeiro/titles?limit=0','/v1/financeiro/titles?limit=1&limit=2','/v1/financeiro/titles?parent_id=bad','/v1/financeiro/titles?from=2026-02-30','/v1/financeiro/titles?from=2026-10-17&to=2026-10-16','/v1/financeiro/movements','/v1/financeiro/titles?fields=raw']) await assert.rejects(()=>parseFinanceRoute(new Request(`https://api.example.test${path}`)),error=>error.status===400);
  for(const data of [{expected_version:0,name:'x',kind:'cash',actor:users.admin},{expected_version:1,name:'x',kind:'cash'}])await assert.rejects(()=>parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/account_save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),data})})),error=>error.status===400);
  await assert.rejects(()=>parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/opening',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),data:{id:randomUUID(),expected_version:1,amount_cents:100,posted_on:today,note:'Valor numérico rejeitado'}})})),error=>error.status===400);
  await assert.rejects(()=>parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/delete',{method:'POST'})),error=>error.status===404);
  await assert.rejects(()=>parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/titles',{method:'POST'})),error=>error.status===405);
});

test('all accumulated titles reconcile against immutable settlements and cash movements match their signed components',async()=>{
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM erp_finance.title t WHERE t.settled_cents<>(SELECT coalesce(sum(CASE WHEN s.kind='payment' THEN s.principal_cents ELSE -s.principal_cents END),0) FROM erp_finance.settlement s WHERE s.title_id=t.id)`),0);
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM erp_finance.settlement s JOIN erp_finance.title t ON t.id=s.title_id WHERE s.net_cash_cents<>s.principal_cents+s.interest_cents+s.penalty_cents-s.discount_cents+CASE WHEN t.kind='payable' THEN s.fee_cents ELSE -s.fee_cents END`),0);
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM erp_finance.movement m JOIN erp_finance.settlement s ON s.id=m.settlement_id JOIN erp_finance.title t ON t.id=s.title_id WHERE m.delta_cents<>s.net_cash_cents*(CASE WHEN t.kind='receivable' THEN 1 ELSE -1 END)*(CASE WHEN s.kind='payment' THEN 1 ELSE -1 END)`),0);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.command'),await scalar('SELECT count(*)::int AS value FROM erp_finance.audit'));
});
