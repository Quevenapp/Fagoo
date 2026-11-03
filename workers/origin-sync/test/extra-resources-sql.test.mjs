import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {OriginClient} from '../src/client.mjs';
import {priceCapture} from '../src/price-json.mjs';
import {getResource} from '../src/resources.mjs';
import {syncPage} from '../src/sync.mjs';
let db,oldBody,oldAck,oldSource,publicWrapper;const owner=randomUUID(),code=x=>e=>e.code===x;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args={}){const entries=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) v`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const claim=resource=>rpc('origin_sync_claim',{p_resource:resource,p_owner:owner,p_ttl_seconds:600});
async function body(resource,entity,records,extra={}){const lease=await claim(resource);return {p_resource:resource,p_entity:entity,p_owner:owner,p_lease_token:lease.lease_token,p_batch_id:randomUUID(),p_records:records,p_checkpoint:{version:1,synthetic:true},p_expected_checkpoint_version:lease.checkpoint_version,...extra};}
const apply=b=>rpc('origin_sync_apply_batch',b);
const record=(id,extra={})=>({source_id:id,payload:{id,...extra}});
const page=(lease,extra={})=>rpc('origin_sync_stock_product_page',{p_owner:owner,p_lease_token:lease.lease_token,...extra});
const pairs=[['service_orders','service_orders'],['warehouses_active','warehouses'],['warehouses_inactive','warehouses'],['product_categories','product_categories'],['financial_categories','financial_categories'],['ledger_accounts','ledger_accounts'],['cash_entries_registered','cash_entries'],['cash_entries_deleted','cash_entries'],['stock_balances','stock_balances']];
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['001_origin_sync','002_origin_quotes_nfce','005_origin_auxiliary_catalogs','056_origin_reference_fetch','059_origin_price_capture'])await db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${name}.sql`,import.meta.url),'utf8'));
 oldBody=await body('products_zero','products',[record('111',{preco:1.2345})]);oldAck=await apply(oldBody);
 oldSource=await scalar("select to_jsonb(r) v from origin_sync.raw_record r where entity='products' and source_id='111'");
 publicWrapper=await scalar("select pg_get_functiondef('public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure) v");
 await db.exec(await readFile(new URL('../../../supabase/migrations/202610160063_origin_extra_resources.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
test('063 preserves exact public059 wrapper, old sources/hashes and receipt replay',async()=>{
 assert.equal(await scalar("select pg_get_functiondef('public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure) v"),publicWrapper);
 assert.deepEqual(await scalar("select to_jsonb(r) v from origin_sync.raw_record r where entity='products' and source_id='111'"),oldSource);
 assert.deepEqual(await apply(oldBody),{...oldAck,replayed:true});
 assert.equal(await scalar("select count(*)::int v from pg_namespace where nspname like 'erp_%'"),0);
});
test('new RPC is service-only, private core/raw remain inaccessible and RLS stays active',async()=>{
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_stock_product_page(uuid,uuid,text,integer)','EXECUTE') v",[role]),role==='service_role');
  assert.equal(await scalar("select has_function_privilege($1,'origin_sync.apply_batch_legacy_059(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','EXECUTE') v",[role]),false);
  assert.equal(await scalar("select has_table_privilege($1,'origin_sync.raw_record','SELECT') v",[role]),false);
 }
 assert.equal(await scalar("select bool_and(relrowsecurity) v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='origin_sync' and c.relkind='r'"),true);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(scalar('select public.origin_sync_stock_product_page($1,$2) v',[owner,randomUUID()]),code('42501'));}finally{await db.exec('reset role');}}
});
test('nine checkpoint variants stage seven canonical entities and status includes zero-safe inventory',async()=>{
 const initial=await rpc('origin_sync_status');assert.equal(initial.entities.length,18);assert.equal(initial.entities.find(x=>x.entity==='stock_balances').records,0);
 for(let i=0;i<pairs.length;i++){const [resource,entity]=pairs[i],id=String(700+i),item=entity==='stock_balances'?{source_id:id,payload:{produto:{id},saldoFisicoTotal:0,depositos:[{id:99,saldoFisico:0}]}}:record(id,{synthetic:true});const b=await body(resource,entity,[item]),ack=await apply(b);assert.equal(ack.inserted,1);assert.deepEqual(await apply(b),{...ack,replayed:true});
 const raw=await scalar('select to_jsonb(r) v from origin_sync.raw_record r where entity=$1 and source_id=$2',[entity,id]);assert.deepEqual(raw.payload,item.payload);assert.deepEqual(raw.document_links,[]);assert.equal(raw.source_updated_at,null);assert.equal(raw.price_capture,null);}
 const status=await rpc('origin_sync_status');assert.equal(status.entities.find(x=>x.entity==='warehouses').records,2);assert.equal(JSON.stringify(status).includes('saldoFisico'),false);
});
test('extra resource/entity and ID bindings, derived timestamps and links are rejected before writing',async()=>{
 const base=await body('service_orders','service_orders',[record('900')]);
 for(const change of [{p_resource:'products_zero'},{p_entity:'contacts'},{p_records:[record('900',{id:'901'})]},{p_records:[{...record('900'),source_updated_at:null}]},{p_records:[{...record('900'),document_links:[{x:1}]}]},{p_records:[record('0')]},{p_records:[{source_id:900,payload:{id:900}}]}])await assert.rejects(apply({...base,...change}),code('22023'));
 const stock=await body('stock_balances','stock_balances',[{source_id:'900',payload:{id:'900'}}]);await assert.rejects(apply(stock),code('22023'));
 assert.equal(await scalar("select count(*)::int v from origin_sync.raw_record where source_id='900'"),0);
});
test('CAS/fencing and duplicate IDs roll back the whole extra batch; committed replay survives lease successor',async()=>{
 const b=await body('product_categories','product_categories',[record('901'),record('901')]),version=b.p_expected_checkpoint_version;
 await assert.rejects(apply(b),code('22023'));assert.equal(await scalar("select checkpoint_version::int v from origin_sync.resource_state where resource='product_categories'"),version);
 const good={...b,p_records:[record('901')]},ack=await apply(good);await assert.rejects(apply({...good,p_batch_id:randomUUID()}),code('40001'));
 await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='product_categories'");
 const successor=await claim('product_categories');assert.notEqual(successor.lease_token,b.p_lease_token);
 assert.deepEqual(await apply(good),{...ack,replayed:true});await assert.rejects(apply({...good,p_batch_id:randomUUID(),p_expected_checkpoint_version:version+1}),code('55000'));
});
test('stock cursor pages only observed product IDs, requires exact live lease and never certifies coverage',async()=>{
 await apply(await body('products_zero','products',[record('001'),record('12'),record('2'),record('9007199254740993'),record('legacy-nonnumeric')]));
 const lease=await claim('stock_balances');const first=await page(lease,{p_limit:2});assert.deepEqual(first,{items:['001','111'],has_more:true,next_cursor:'111',coverage_complete:false});
 const second=await page(lease,{p_after:first.next_cursor,p_limit:25});assert.deepEqual(second.items,['12','2','9007199254740993']);assert.equal(second.next_cursor,null);
 for(const change of [{p_limit:26},{p_limit:0},{p_after:'not-id'},{p_after:'0'}])await assert.rejects(page(lease,change),code('22023'));
 await assert.rejects(page(lease,{p_owner:randomUUID()}),code('55000'));
 await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='stock_balances'");await assert.rejects(page(lease),code('55000'));
});
test('missing stock in a later sweep retains earlier observation, not a synthesized zero or deletion',async()=>{
 const before=await scalar("select to_jsonb(r) v from origin_sync.raw_record r where entity='stock_balances' and source_id='708'");
 await apply(await body('stock_balances','stock_balances',[],{p_checkpoint:{version:1,last_observation:{requested:1,returned:0,unavailable:1,coverage_complete:false}}}));
 assert.deepEqual(await scalar("select to_jsonb(r) v from origin_sync.raw_record r where entity='stock_balances' and source_id='708'"),before);
});
test('059 exact-price guard and immutable old receipt still protect already captured products after063',async()=>{
 const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response('{"data":{"id":"999","preco":99999999.1234567891}}')});const payload=await client.get('/produtos/999'),b=await body('products_zero','products',[{source_id:'999',payload,price_capture:priceCapture(payload)}]);
 const ack=await rpc('origin_sync_apply_price_batch',b);assert.equal(ack.price_captures,1);assert.equal(await scalar("select payload->>'preco' v from origin_sync.raw_record where entity='products' and source_id='999'"),'99999999.1234567891');
 await assert.rejects(apply(await body('products_zero','products',[record('999',{preco:2})])),code('40001'));assert.deepEqual(await apply(b),{...ack,replayed:true});
});
test('real collector→RPC commits stock raw only with exact nested warehouse IDs and unavailable count',async()=>{
 const calls=[];const repo={claim,renew:async()=>{},release:(resource,_owner,token)=>rpc('origin_sync_release',{p_resource:resource,p_owner:owner,p_lease_token:token}),rpc,apply:async(resource,entity,_owner,lease,records,checkpoint)=>{calls.push({resource,entity,records,checkpoint});return apply({p_resource:resource,p_entity:entity,p_owner:owner,p_lease_token:lease.lease_token,p_batch_id:randomUUID(),p_records:records,p_checkpoint:checkpoint,p_expected_checkpoint_version:lease.checkpoint_version});}};
 const client={async get(path,p){assert.equal(path,'/estoques/saldos');return p.filtroSaldoEstoque>0?[{produto:{id:'001'},saldoFisicoTotal:2.125,depositos:[{id:'77',saldoFisico:2.125,saldoVirtual:1}]}]:[];}};
 const result=await syncPage(repo,client,getResource('stock_balances'),owner,{SYNC_START_DATE:'2024-01-01'},new Date());assert.equal(result.records,1);assert.ok(result.unavailable>0);assert.equal(calls.length,1);assert.equal(calls[0].checkpoint.last_observation.coverage_complete,false);
 assert.equal(await scalar("select payload#>>'{depositos,0,id}' v from origin_sync.raw_record where entity='stock_balances' and source_id='001'"),'77');
 assert.equal(result.overlaps,1);assert.equal(await scalar("select (checkpoint#>>'{last_observation,overlaps}')::int v from origin_sync.resource_state where resource='stock_balances'"),1);
 assert.equal(await scalar("select count(*)::int v from pg_namespace where nspname like 'erp_%'"),0);
});
