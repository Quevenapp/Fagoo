import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before,after,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { stockRoute,stockMethods,stockOperation,stockResponse } from '../../workers/erp-api/src/stock.mjs';
let db;
const roles=['admin','consulta','estoque','vendas','fiscal','financeiro'];
const users=Object.fromEntries(roles.map((role,i)=>[role,`d0000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const errorIs=code=>error=>error.code===code;
const catalog=(entity,data)=>scalar('select public.erp_catalog_save($1::uuid,$2,null,0,$3::uuid,$4::jsonb) value',[users.admin,entity,randomUUID(),JSON.stringify(data)]);
const balance=(product,warehouse=null,user=users.estoque)=>scalar('select public.erp_stock_balances($1::uuid,$2::uuid,$3::uuid) value',[user,product,warehouse]);
const post=(items,{kind='receipt',command=randomUUID(),user=users.estoque,date='2024-10-15',reason='Movimento sintético',reference=null}={})=>scalar(
  'select public.erp_stock_post($1::uuid,$2::uuid,$3,$4::date,$5,$6::jsonb,$7) value',[user,command,kind,date,reason,JSON.stringify(items),reference]);
const reverse=(id,versions,{command=randomUUID(),date='2024-10-16',user=users.estoque}={})=>scalar(
  'select public.erp_stock_reverse($1::uuid,$2::uuid,$3::uuid,$4::date,$5,$6::jsonb) value',[user,id,command,date,'Estorno sintético',JSON.stringify(versions)]);
const line=(f,quantity,expected_version=0,warehouse=f.a)=>({product_id:f.product,warehouse_id:warehouse,quantity,expected_version});
const version=(f,expected_version,warehouse=f.a)=>({product_id:f.product,warehouse_id:warehouse,expected_version});
async function fixture(kind='P'){
  const product=(await catalog('products',{name:'Produto de teste',unit:'UN',kind,price:'10.0000'})).record.id;
  const a=(await catalog('warehouses',{name:'Depósito sintético A'})).record.id;
  const b=(await catalog('warehouses',{name:'Depósito sintético B'})).record.id;
  return{product,a,b};
}
before(async()=>{
  db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0009_erp_stock']){
    await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  }
  for(const role of roles){await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
});
after(async()=>db?.close());

test('stock roles, RLS and grants reject unauthorized reads, writes and direct table access',async()=>{
  const f=await fixture();
  for(const role of ['anon','authenticated','service_role']){
    await db.exec(`set role ${role}`);
    try{
      for(const table of ['balance','movement','entry','command'])await assert.rejects(()=>db.query(`select * from erp_stock.${table}`),errorIs('42501'));
      if(role!=='service_role')await assert.rejects(()=>balance(f.product),errorIs('42501'));
      else assert.equal((await balance(f.product,f.a)).items[0].quantity,'0.000000');
    }finally{await db.exec('reset role');}
  }
  for(const role of ['consulta','vendas','fiscal','financeiro'])await assert.rejects(()=>post([line(f,'1')],{user:users[role]}),errorIs('42501'));
  await assert.rejects(()=>balance(f.product,null,users.financeiro),errorIs('42501'));
  for(const role of ['admin','consulta','estoque','vendas','fiscal'])assert.equal((await balance(f.product,f.a,users[role])).items.length,1);
  assert.equal(await scalar("select bool_and(relrowsecurity) value from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='erp_stock' and relkind='r'"),true);
});

test('receipt, exact fractional issue and command replay preserve a single immutable ledger',async()=>{
  const f=await fixture(),command=randomUUID();
  const receipt=await post([line(f,'10.123456')],{command});
  assert.equal(receipt.movement.items[0].balance_after,'10.123456');
  assert.equal((await post([line(f,'10.123456')],{command})).replayed,true);
  assert.equal((await balance(f.product,f.a)).items[0].version,1);
  await assert.rejects(()=>post([line(f,'10')],{command}),errorIs('40001'));
  await post([line(f,'-0.123456',1)],{kind:'issue'});
  assert.equal((await balance(f.product,f.a)).items[0].quantity,'10.000000');
  const journal=await scalar('select sum(quantity)::text value from erp_stock.entry where product_id=$1 and warehouse_id=$2',[f.product,f.a]);
  assert.equal(journal,'10.000000');
  await assert.rejects(()=>db.query('update erp_stock.entry set quantity=2 where movement_id=$1',[receipt.movement.id]),errorIs('40001'));
  await assert.rejects(()=>db.query('delete from erp_stock.movement where id=$1',[receipt.movement.id]),errorIs('40001'));
});

test('CAS and insufficient stock roll back all lines, newly created balances, movement and command',async()=>{
  const f=await fixture();await post([line(f,'5')]);
  const before=await scalar('select count(*)::int value from erp_stock.movement');
  await assert.rejects(()=>post([line(f,'1',0)]),errorIs('40001'));
  await assert.rejects(()=>post([line(f,'-6',1)],{kind:'issue'}),errorIs('22023'));
  await assert.rejects(()=>post([line(f,'2',1),line(f,'-1',0,f.b)],{kind:'adjustment'}),errorIs('22023'));
  assert.equal((await balance(f.product,f.a)).items[0].quantity,'5.000000');
  assert.equal(await scalar('select count(*)::int value from erp_stock.balance where product_id=$1 and warehouse_id=$2',[f.product,f.b]),0);
  assert.equal(await scalar('select count(*)::int value from erp_stock.movement'),before);
});

test('transfer requires one product, two distinct warehouses and conservation of exact quantity',async()=>{
  const f=await fixture();await post([line(f,'8')]);
  const result=await post([line(f,'-3',1),line(f,'3',0,f.b)],{kind:'transfer'});
  assert.equal(result.movement.items.length,2);
  assert.equal((await balance(f.product,f.a)).items[0].quantity,'5.000000');
  assert.equal((await balance(f.product,f.b)).items[0].quantity,'3.000000');
  for(const items of [[line(f,'-1',2)],[line(f,'-1',2),line(f,'2',1,f.b)],[line(f,'-1',2),line(f,'1',2)]])
    await assert.rejects(()=>post(items,{kind:'transfer'}),errorIs('22023'));
});

test('reversal creates opposite entries once, checks current versions and leaves original unchanged',async()=>{
  const f=await fixture();await post([line(f,'10')]);
  const transfer=await post([line(f,'-2',1),line(f,'2',0,f.b)],{kind:'transfer'});
  const command=randomUUID(),versions=[version(f,2),version(f,1,f.b)];
  const reversed=await reverse(transfer.movement.id,versions,{command});
  assert.equal(reversed.movement.reverses_id,transfer.movement.id);
  assert.equal((await reverse(transfer.movement.id,versions,{command})).replayed,true);
  await assert.rejects(()=>reverse(transfer.movement.id,[version(f,3),version(f,2,f.b)]),errorIs('40001'));
  await assert.rejects(()=>reverse(reversed.movement.id,[version(f,3),version(f,2,f.b)]),errorIs('P0002'));
  assert.equal((await balance(f.product,f.a)).items[0].quantity,'10.000000');
  assert.equal((await balance(f.product,f.b)).items[0].quantity,'0.000000');
  const original=await scalar('select erp_stock.movement_dto($1::uuid) value',[transfer.movement.id]);
  assert.equal(original.reversed_by,reversed.movement.id);
  assert.equal(original.items.find(item=>item.warehouse_id===f.a).quantity,'-2.000000');
});

test('reversing consumed receipt cannot invent negative stock and reversal date cannot precede original',async()=>{
  const f=await fixture();const receipt=await post([line(f,'3')]);
  await assert.rejects(()=>reverse(receipt.movement.id,[version(f,1)],{date:'2024-10-14'}),errorIs('22023'));
  await post([line(f,'-2',1)],{kind:'issue'});
  await assert.rejects(()=>reverse(receipt.movement.id,[version(f,2)]),errorIs('22023'));
  assert.equal((await balance(f.product,f.a)).items[0].quantity,'1.000000');
});

test('service products, inactive destinations and missing units cannot create movements',async()=>{
  const service=await fixture('S');await assert.rejects(()=>post([line(service,'1')]),errorIs('22023'));
  const f=await fixture();await db.query('update erp_catalog.record set active=false where id=$1',[f.a]);
  await assert.rejects(()=>post([line(f,'1')]),errorIs('22023'));
  await db.query('update erp_catalog.record set active=true where id=$1',[f.a]);
  await db.query('update erp_catalog.product set unit=null where record_id=$1',[f.product]);
  await assert.rejects(()=>post([line(f,'1')]),errorIs('22023'));
});

test('catalog cannot change the unit or product kind after a stock entry, even through catalog RPC',async()=>{
  const f=await fixture();await post([line(f,'1')]);
  for(const data of [{unit:'KG'},{kind:'S'}])await assert.rejects(()=>scalar(
    'select public.erp_catalog_save($1::uuid,\'products\',$2::uuid,1,$3::uuid,$4::jsonb) value',[users.admin,f.product,randomUUID(),JSON.stringify(data)]),errorIs('40001'));
  const changed=await scalar('select public.erp_catalog_save($1::uuid,\'products\',$2::uuid,1,$3::uuid,$4::jsonb) value',[users.admin,f.product,randomUUID(),JSON.stringify({price:'11.00'})]);
  assert.equal(changed.record.version,2);
});

test('input rejects floating JSON, rounding, overflow, unknown fields, future dates and forged reversal',async()=>{
  const f=await fixture();
  for(const quantity of [1,'1e2','1,2','0','-0.000000','1.0000001','1000000000000','NaN'])
    await assert.rejects(()=>post([line(f,quantity)]),errorIs('22023'));
  for(const item of [{...line(f,'1'),extra:true},{...line(f,'1'),expected_version:-1},{...line(f,'1'),expected_version:'0'},{...line(f,'1'),product_id:'invalid'}])
    await assert.rejects(()=>post([item]),errorIs('22023'));
  await assert.rejects(()=>post([line(f,'1')],{date:'2100-01-01'}),errorIs('22023'));
  await assert.rejects(()=>post([line(f,'1')],{kind:'reversal'}),errorIs('22023'));
  await assert.rejects(()=>post([line(f,'1')],{reason:'  '}),errorIs('22023'));
  assert.equal(await scalar('select count(*)::int value from erp_stock.entry where product_id=$1',[f.product]),0);
});

test('archive permits a conservative reversal but blocks new movement; revoked member cannot replay',async()=>{
  const f=await fixture(),command=randomUUID();const first=await post([line(f,'2')],{command});
  await db.query('update erp_catalog.record set active=false where id in($1,$2)',[f.product,f.a]);
  await assert.rejects(()=>post([line(f,'1',1)]),errorIs('22023'));
  await reverse(first.movement.id,[version(f,1)]);
  await db.query('update erp_access.membership set active=false where user_id=$1',[users.estoque]);
  await assert.rejects(()=>post([line(f,'2')],{command}),errorIs('42501'));
  await db.query('update erp_access.membership set active=true where user_id=$1',[users.estoque]);
});

test('HTTP stock contract executes real SQL and projects only allowed quantities and movement fields',async()=>{
  const api=async(path,method='GET',input)=>{
    const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
    const request=new Request(url,{method,headers:input?{'Content-Type':'application/json'}:{},body:input?JSON.stringify(input):undefined});
    const operation=await stockOperation(request,route,url.searchParams);
    const args={...operation.args,p_user_id:users.estoque},keys=Object.keys(args);
    await db.exec('set role service_role');
    try{
      const result=await scalar(`select public.${operation.rpc}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')}) value`,keys.map(key=>typeof args[key]==='object'&&args[key]!==null?JSON.stringify(args[key]):args[key]));
      return stockResponse({...result,private:'hidden',...(result.movement?{movement:{...result.movement,actor:'hidden'}}:{})},route,operation);
    }finally{await db.exec('reset role');}
  };
  const f=await fixture();
  // Since migration 105 the balances DTO also carries the default/ignored warehouse flags and the reserved quantity; the
  // 009-only projection is refused (deploy order DB → API). The 105 projection is checked in workers/erp-api/test.
  await assert.rejects(api(`/v1/estoque/saldos?product_id=${f.product}&warehouse_id=${f.a}`),error=>error.status===502);
  const initial={items:[{quantity:(await balance(f.product,f.a)).items[0].quantity}]};
  assert.equal(initial.items[0].quantity,'0.000000');
  const created=await api('/v1/estoque/movimentos','POST',{command_id:randomUUID(),kind:'receipt',occurred_on:'2024-10-15',reason:'Recebimento sintético',items:[line(f,'1.123456')]});
  assert.equal(created.movement.items[0].balance_after,'1.123456');assert.equal(created.movement.actor,undefined);
  const listed=await api(`/v1/estoque/movimentos?product_id=${f.product}&limit=1`);
  assert.equal(listed.items[0].id,created.movement.id);
  // Since migration 145 the estorno answer also carries balance_adjustments (Balanço posterior); the 009-only answer is
  // refused after the reversal is recorded (deploy order DB → API). The 145 projection is checked in workers/erp-api/test.
  await assert.rejects(api(`/v1/estoque/movimentos/${created.movement.id}/estorno`,'POST',{command_id:randomUUID(),occurred_on:'2024-10-16',reason:'Estorno sintético',versions:[version(f,1)]}),error=>error.status===502);
  assert.equal((await balance(f.product,f.a)).items[0].quantity,'0.000000');
});

test('HTTP stock parsing rejects unsafe bodies, excess list size and ambiguous parameters before RPC',async()=>{
  assert.equal(stockRoute('/v1/estoque/movimentos/bad/estorno'),null);
  assert.deepEqual(stockMethods(stockRoute('/v1/estoque/movimentos')),['GET','POST']);
  const f=await fixture();
  for(const suffix of ['&limit=26','&limit=1&limit=2','&after=bad','&raw=true']){
    const url=new URL(`https://api.example.test/v1/estoque/movimentos?product_id=${f.product}${suffix}`);
    await assert.rejects(()=>stockOperation(new Request(url),stockRoute(url.pathname),url.searchParams),e=>e.status===400);
  }
  const base={command_id:randomUUID(),kind:'receipt',occurred_on:'2024-10-15',reason:'Recebimento sintético',items:[line(f,'1')]};
  for(const input of [{...base,actor:users.admin},{...base,occurred_on:'2024-02-30'},{...base,items:[line(f,1)]},{...base,items:[line(f,'1e2')]},{...base,items:[line(f,'1'),line(f,'1')]},{...base,items:[line(f,'-1')]}]){
    const request=new Request('https://api.example.test/v1/estoque/movimentos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    await assert.rejects(()=>stockOperation(request,stockRoute('/v1/estoque/movimentos'),new URLSearchParams()),e=>e.status===400);
  }
});
