import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {homeResponse,homeOperation,HomeError} from '../../workers/erp-api/src/home.mjs';
let db,contact,product,warehouse,today;
const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const denied=e=>e.code==='42501';
async function role(name,fn){await db.exec(`set role ${name}`);try{return await fn();}finally{await db.exec('reset role');}}
const home=actor=>role('service_role',()=>scalar('select public.erp_home_summary($1) value',[actor??users.admin]));
const catalog=async(entity,data)=>(await scalar('select public.erp_catalog_save($1,$2,null,0,$3,$4::jsonb) value',[users.admin,entity,randomUUID(),JSON.stringify(data)])).record.id;
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0021_home_summary'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const roleName of ['admin','consulta','vendas','financeiro','estoque','fiscal','inactive']){
  users[roleName]=randomUUID();await db.query('insert into auth.users values($1)',[users[roleName]]);
  await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[roleName],roleName==='inactive'?'admin':roleName,roleName!=='inactive']);
 }
 today=(await home()).business_date;
 contact=await catalog('contacts',{name:'Cliente de teste do painel'});
 product=await catalog('products',{name:'Produto de teste do painel',kind:'P',unit:'UN',format:'S'});
 warehouse=await catalog('warehouses',{name:'Depósito de teste do painel'});
});
after(async()=>db?.close());
test('021 service-only RPC denies absent/inactive memberships and anonymous execution',async()=>{
 for(const actor of [users.inactive,randomUUID(),null])await assert.rejects(()=>role('service_role',()=>scalar('select public.erp_home_summary($1) value',[actor])),denied);
 for(const who of ['anon','authenticated'])await assert.rejects(()=>role(who,()=>scalar('select public.erp_home_summary($1) value',[users.admin])),denied);
 const result=await home();assert.equal(result.business_date,today);assert.equal(result.timezone,'America/Sao_Paulo');
 assert.equal(result.catalog.find(c=>c.entity==='contacts').active,1);assert.equal(result.stock.positions,0);
 assert.equal(result.finance.accounts.recorded_balance_cents,'0');assert.deepEqual(homeResponse(result),result);
});
test('021 role projections follow existing module permissions and never reveal unauthorized aggregates',async()=>{
 const expected={admin:[3,4,true,true],consulta:[3,4,true,true],vendas:[2,3,true,false],financeiro:[1,4,false,true],estoque:[3,2,true,false],fiscal:[2,2,true,false]};
 for(const [who,[catalogCount,documentCount,stock,finance]] of Object.entries(expected)){
  const result=homeResponse(await home(users[who]));assert.equal(result.catalog.length,catalogCount);assert.equal(result.documents.length,documentCount);
  assert.equal(result.stock!==null,stock);assert.equal(result.finance!==null,finance);
  if(!finance)assert.doesNotMatch(JSON.stringify(result),/balance_cents|receivable|payable/);
  if(['estoque','fiscal'].includes(who))assert.equal(result.documents.some(d=>d.kind==='service_orders'),false);
 }
});
test('021 financial buckets use São Paulo due date, exact outstanding cents, and exclude cancelled or paid titles',async()=>{
 const insert=async({offset,amount='999999999999999',settled='0',cancelled=false,kind='receivable'})=>db.query(
  'insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents,cancelled) values($1,1,1,$2,$3,$4,$5::date-30,$5::date+$6::int,$7::bigint,$8::bigint,$9)',
  [randomUUID(),kind,contact,'Título fictício',today,offset,amount,settled,cancelled]);
 for(let i=0;i<12;i++)await insert({offset:-1});
 await insert({offset:0,amount:'10000',settled:'2501'});
 await insert({offset:1,amount:'200'});await insert({offset:7,amount:'301'});await insert({offset:8,amount:'400'});
 await insert({offset:-1,cancelled:true});await insert({offset:0,amount:'50',settled:'50'});
 await insert({offset:0,amount:'2000',kind:'payable'});
 const result=homeResponse(await home()),rows=result.finance.titles.find(t=>t.kind==='receivable').buckets;
 assert.deepEqual(rows,[{bucket:'overdue',count:12,balance_cents:'11999999999999988'},{bucket:'today',count:1,balance_cents:'7499'},
  {bucket:'next_7_days',count:2,balance_cents:'501'},{bucket:'later',count:1,balance_cents:'400'}]);
 assert.equal(result.finance.titles.find(t=>t.kind==='payable').buckets[1].balance_cents,'2000');
});
test('021 cash balance includes archived accounts but identifies active openings still pending',async()=>{
 const active=randomUUID(),archived=randomUUID();
 await db.query("insert into erp_finance.account(id,name,kind,active,opening_recorded)values($1,'Conta A','bank',true,false),($2,'Conta B','cash',false,true)",[active,archived]);
 for(const [id,delta] of [[active,'1500'],[archived,'-2000']])await db.query("insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,actor,command_id)values($1,'opening',$2,$3,$4,$5)",[id,delta,today,users.admin,randomUUID()]);
 const row=homeResponse(await home()).finance.accounts;
 assert.deepEqual(row,{active:1,archived:1,opening_pending:1,recorded_balance_cents:'-500'});
});
test('021 stock counts positions without mixing units, and document statuses reconcile to total',async()=>{
 const kg=await catalog('products',{name:'Peso fictício',kind:'P',unit:'KG',format:'S'});
 await db.query("insert into erp_stock.balance(product_id,warehouse_id,quantity,unit)values($1,$2,3.123456,'UN'),($3,$2,0,'KG')",[product,warehouse,kg]);
 await db.query("insert into erp_documents.document(kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by)values('sales_orders',1,'open',$1,'{}','{}',0,$2,$2),('sales_orders',2,'cancelled',$1,'{}','{}',0,$2,$2)",[contact,users.admin]);
 const result=homeResponse(await home());
 assert.deepEqual(result.stock,{positions:2,positive_positions:1,zero_positions:1,products:2,warehouses:1});
 const sales=result.documents.find(d=>d.kind==='sales_orders');assert.equal(sales.count,2);
 assert.equal(sales.statuses.find(s=>s.status==='cancelled').count,1);assert.equal(sales.statuses.find(s=>s.status==='open').count,1);
 assert.equal(await scalar('select count(*)::int value from erp_finance.command'),0);
});
test('021 boundary rejects query/method tricks and malformed or overprivileged projections',async()=>{
 const operation=homeOperation(new Request('https://example.invalid/v1/inicio'),new URLSearchParams());assert.equal(operation.rpc,'erp_home_summary');
 assert.throws(()=>homeOperation(new Request('https://example.invalid',{method:'POST'}),new URLSearchParams()),e=>e instanceof HomeError&&e.status===405);
 assert.throws(()=>homeOperation(new Request('https://example.invalid'),new URLSearchParams('actor=anything')),e=>e.status===400);
 const base=await home();const reject=mutate=>{const value=structuredClone(base);mutate(value);assert.throws(()=>homeResponse(value),e=>e.status===502);};
 reject(v=>v.business_date='2026-02-30');reject(v=>v.catalog[0].active=-1);reject(v=>v.documents[0].count=99);
 reject(v=>v.finance.titles[0].buckets[0].balance_cents=1);reject(v=>v.stock.positive_positions=99);reject(v=>v.role='vendas');
 const safe=homeResponse({...base,payload:{secret:'discard'},actor:randomUUID()});assert.equal(safe.payload,undefined);assert.equal(safe.actor,undefined);
 const selling=await home(users.vendas);selling.finance=base.finance;assert.throws(()=>homeResponse(selling),e=>e.status===502);
});
