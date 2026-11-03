import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {OriginClient} from '../src/client.mjs';
import {priceCapture} from '../src/price-json.mjs';
import {purchasePriceCapture} from '../src/purchase-price-json.mjs';
import {salesPriceCapture} from '../src/sales-price-json.mjs';
let db,legacyBody,legacyAck,baseline,oldWrapper,purchaseBody,purchaseAck,purchaseBaseline;const owner=randomUUID(),code=x=>e=>e.code===x;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
async function rpc(name,args={}){const entries=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const claim=(resource='sales_orders')=>rpc('origin_sync_claim',{p_resource:resource,p_owner:owner,p_ttl_seconds:600});
async function body(records,resource='sales_orders',entity=resource){const l=await claim(resource);return{p_resource:resource,p_entity:entity,p_owner:owner,p_lease_token:l.lease_token,p_batch_id:randomUUID(),p_records:records,p_checkpoint:{synthetic:true},p_expected_checkpoint_version:l.checkpoint_version};}
const apply=b=>rpc(b.p_records.some(r=>Object.hasOwn(r,'price_capture'))?'origin_sync_apply_sales_price_batch':'origin_sync_apply_batch',b);
async function captured(id,token='99999999.1234567891',extra=''){
 const text=`{"data":{"id":"${id}","situacao":{"id":7,"valor":0},"itens":[{"valor":${token},"produto":{"id":2}}]${extra}}}`;
 const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',salesPriceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(text)}),payload=await c.get(`/pedidos/vendas/${id}`);return{source_id:id,payload,price_capture:salesPriceCapture(payload)};
}
const row=id=>scalar("select to_jsonb(r) v from origin_sync.raw_record r where entity='sales_orders' and source_id=$1",[id]);
const checkpoint=()=>scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='sales_orders'");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['001_origin_sync','002_origin_quotes_nfce','005_origin_auxiliary_catalogs','056_origin_reference_fetch','059_origin_price_capture','063_origin_extra_resources','071_origin_purchase_price_capture'])await db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${name}.sql`,import.meta.url),'utf8'));
 legacyBody=await body([{source_id:'1',payload:{id:'1',situacao:{id:7,valor:0},itens:[{valor:1.2,produto:{id:2}}]}}]);legacyAck=await apply(legacyBody);baseline=await row('1');
 const purchaseClient=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',purchasePriceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response('{"data":{"id":"30","itens":[{"valor":99999999.1234567891}]}}')}),purchasePayload=await purchaseClient.get('/pedidos/compras/30');
 purchaseBody=await body([{source_id:'30',payload:purchasePayload,price_capture:purchasePriceCapture(purchasePayload)}],'purchase_orders');
 purchaseAck=await rpc('origin_sync_apply_purchase_price_batch',purchaseBody);purchaseBaseline=await scalar("select to_jsonb(r)v from origin_sync.raw_record r where entity='purchase_orders' and source_id='30'");
 oldWrapper=await scalar("select prosrc v from pg_proc where oid='public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure");
 await assert.rejects(rpc('origin_sync_apply_sales_price_batch',legacyBody),code('42883'));
 await db.exec(await readFile(new URL('../../../supabase/migrations/202610160078_origin_sales_price_capture.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
test('078 changes no staged observation, old wrapper body or legacy receipt; new/private ACL stays closed',async()=>{
 assert.deepEqual(await scalar("select to_jsonb(r)v from origin_sync.raw_record r where entity='purchase_orders' and source_id='30'"),purchaseBaseline);assert.deepEqual(await rpc('origin_sync_apply_purchase_price_batch',purchaseBody),{...purchaseAck,replayed:true});
 assert.deepEqual(await row('1'),baseline);assert.deepEqual(await apply(legacyBody),{...legacyAck,replayed:true});
 assert.equal(await scalar("select prosrc v from pg_proc where oid='origin_sync.apply_batch_legacy_078(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure"),oldWrapper);
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_apply_sales_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','EXECUTE')v",[role]),role==='service_role');
  for(const fn of ['origin_sync.apply_batch_legacy_071(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','origin_sync.apply_batch_legacy_078(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','origin_sync.apply_batch_legacy_059(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','origin_sync.validate_sales_price_capture(jsonb,jsonb)'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')v',[role,fn]),false);
  assert.equal(await scalar("select has_table_privilege($1,'origin_sync.raw_record','SELECT')v",[role]),false);
 }
 assert.equal(await scalar("select count(*)::int v from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid in('public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure,'public.origin_sync_apply_sales_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)'::regprocedure) and a.grantee=(select oid from pg_roles where rolname='service_role') and a.is_grantable"),0);
 assert.equal(await scalar("select count(*)::int v from pg_namespace where nspname like 'erp_%'"),0);
});
test('detail price reaches JSONB as exact number with same content hash grammar and current bound evidence',async()=>{
 const rec=await captured('2'),b=await body([rec]),ack=await apply(b);assert.equal(ack.sales_price_captures,1);assert.equal(ack.inserted,1);
 assert.equal(await scalar("select payload#>>'{itens,0,valor}'v from origin_sync.raw_record where source_id='2'"),'99999999.1234567891');assert.equal(await scalar("select jsonb_typeof(payload#>'{itens,0,valor}')v from origin_sync.raw_record where source_id='2'"),'number');
 const r=await row('2');assert.equal(r.price_capture.source_hash,r.version_hash);assert.equal(r.price_capture.source_version,'1');assert.equal(r.price_capture.capture_id,b.p_batch_id);assert.equal(r.price_capture.profile,'origin-sales-price-json-v1');
 assert.equal(r.version_hash,await scalar("select encode(sha256(convert_to(jsonb_build_object('payload',$1::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex')v",[JSON.stringify(rec.payload)]));
 assert.deepEqual(await apply(b),{...ack,replayed:true});
 await assert.rejects(apply({...b,p_records:[{...rec,price_capture:{...rec.price_capture,response_sha256:'f'.repeat(64)}}]}),code('22023'));
});
test('new capture corrects only current source; same value refresh keeps version/hash and old receipts immutable',async()=>{
 const before=await row('1');await apply(await body([await captured('1','1.2000')]));const one=await row('1');assert.equal(one.version_hash,before.version_hash);assert.equal(one.version,1);
 await apply(await body([await captured('1','1.2e0')]));const two=await row('1');assert.equal(two.version_hash,one.version_hash);assert.equal(two.version,one.version);assert.equal(two.price_capture.tokens[0].lexeme,'1.2e0');assert.notEqual(two.price_capture.capture_id,one.price_capture.capture_id);
 assert.deepEqual(await apply(legacyBody),{...legacyAck,replayed:true});
 const old=await body([{source_id:'3',payload:{id:'3',situacao:{id:7,valor:0},itens:[{valor:99999999.1234567891,produto:{id:2}}]}}]),ack=await apply(old);await apply(await body([await captured('3')]));assert.equal((await row('3')).version,2);assert.deepEqual(await apply(old),{...ack,replayed:true});
});
test('flag rollback permits same-hash observation/replay but rejects degradation atomically',async()=>{
 const old=await row('2'),cp=await checkpoint(),b=await body([{source_id:'2',payload:{id:'2',situacao:{id:7,valor:0},itens:[{valor:99999999.1234567891,produto:{id:2}}]}}]);await assert.rejects(apply(b),code('40001'));assert.deepEqual(await row('2'),old);assert.equal(await checkpoint(),cp);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[b.p_batch_id]),0);
 const unchanged=await body(legacyBody.p_records);assert.equal((await apply(unchanged)).unchanged,1);assert.ok((await row('1')).price_capture);
});
test('all capture fields/tokens and source IDs are closed, complete and profile-specific',async()=>{
 const good=await captured('4');const variants=[{...good.price_capture,profile:'origin-purchase-price-json-v1'},{...good.price_capture,profile:'origin-price-json-v1'},{...good.price_capture,source:'list_fallback'},{...good.price_capture,tokens:[]},{...good.price_capture,tokens:[{path:'/itens/0/valor',lexeme:'1'}]},{...good.price_capture,tokens:[{path:'/total',lexeme:'1'}]},{...good.price_capture,tokens:[...good.price_capture.tokens,...good.price_capture.tokens]},{...good.price_capture,extra:true}];
 for(const c of variants)await assert.rejects(apply(await body([{...good,price_capture:c}])),code('22023'));
 for(const r of [{...good,source_id:'04'},{...good,source_id:'5'},{...good,payload:{...good.payload,id:null}},{...good,source_id:4}])await assert.rejects(apply(await body([r])),code('22023'));
 for(const patch of [{p_resource:'sales_proposals'},{p_entity:'sales_proposals'},{p_records:[{source_id:'4',payload:{id:'4'}}]},{p_records:[]}])await assert.rejects(rpc('origin_sync_apply_sales_price_batch',{...await body([good]),...patch}),code('22023'));
 assert.equal(await row('4'),undefined);
});
test('backup document links and source timestamp are preserved, omissions fail closed rather than erasing provenance',async()=>{
 const rec=await captured('6','1.2'),legacy={source_id:'6',payload:JSON.parse(JSON.stringify(rec.payload)),document_links:[{type:'backup',path:'synthetic-only'}],source_updated_at:'2026-10-01T12:00:00Z'};
 await apply(await body([legacy]));const pre=await row('6');await assert.rejects(apply(await body([rec])),code('40001'));assert.deepEqual(await row('6'),pre);
 await apply(await body([{...rec,document_links:legacy.document_links}]));const post=await row('6');assert.deepEqual(post.document_links,pre.document_links);assert.equal(post.source_updated_at,pre.source_updated_at);assert.equal(post.version_hash,pre.version_hash);assert.equal(post.version,pre.version);
});
test('row failure and stale checkpoint/fence cannot partially store captures or advance cursor',async()=>{
 const a=await captured('7'),b=await captured('8'),batch=await body([a,{...b,source_id:'mismatch'}]),cp=await checkpoint();await assert.rejects(apply(batch),code('22023'));assert.equal(await row('7'),undefined);assert.equal(await checkpoint(),cp);
 await assert.rejects(apply({...batch,p_records:[a],p_expected_checkpoint_version:batch.p_expected_checkpoint_version+1}),code('40001'));
 await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='sales_orders'");await assert.rejects(apply({...batch,p_records:[a]}),code('55000'));assert.equal(await row('7'),undefined);
});
test('committed precise replay survives successor lease; changed payload and actor never reuse a receipt',async()=>{
 const b=await body([await captured('9')]),ack=await apply(b);await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='sales_orders'");const successor=await claim();assert.notEqual(successor.lease_token,b.p_lease_token);assert.deepEqual(await apply(b),{...ack,replayed:true});
 await assert.rejects(apply({...b,p_owner:randomUUID()}),code('22023'));await assert.rejects(apply({...b,p_records:[await captured('9','1')]}),code('22023'));
});
test('lease expiry during capture rolls back raw, checkpoint and receipt together',async()=>{
 const b=await body([await captured('10')]),cp=await checkpoint();await db.exec("create function origin_sync.synthetic_expire_sales() returns trigger language plpgsql as $$begin update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='sales_orders';return new;end;$$;create trigger synthetic_expire_sales after update of price_capture on origin_sync.raw_record for each row execute function origin_sync.synthetic_expire_sales()");
 try{await assert.rejects(apply(b),code('55000'));assert.equal(await row('10'),undefined);assert.equal(await checkpoint(),cp);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[b.p_batch_id]),0);}finally{await db.exec('drop trigger synthetic_expire_sales on origin_sync.raw_record;drop function origin_sync.synthetic_expire_sales()');}
});
test('059 product/proposal evidence,071 purchases and063 extra entities still use unchanged routes and contracts',async()=>{
 for(const [entity,path,resource,text]of [['products','produtos','products_zero','"preco":1.2345678912'],['sales_proposals','propostas-comerciais','sales_proposals','"itens":[{"valor":1.2345678912}]']]){
  const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(`{"data":{"id":"20",${text}}}`)}),payload=await c.get(`/${path}/20`),rec={source_id:'20',payload,price_capture:priceCapture(payload)};const b=await body([rec],resource,entity),r=await rpc('origin_sync_apply_price_batch',b);assert.equal(r.price_captures,1);assert.equal(r.sales_price_captures,undefined);assert.equal(await scalar('select price_capture->>\'profile\'v from origin_sync.raw_record where entity=$1 and source_id=\'20\'',[entity]),'origin-price-json-v1');
 }
 const purchaseNext=await body(purchaseBody.p_records,'purchase_orders'),purchaseResult=await rpc('origin_sync_apply_purchase_price_batch',purchaseNext);assert.equal(purchaseResult.purchase_price_captures,1);assert.equal(purchaseResult.sales_price_captures,undefined);assert.deepEqual(await rpc('origin_sync_apply_purchase_price_batch',purchaseBody),{...purchaseAck,replayed:true});
 const b=await body([{source_id:'21',payload:{id:'21'}}],'service_orders','service_orders'),r=await rpc('origin_sync_apply_batch',b);assert.equal(r.inserted,1);assert.deepEqual(await rpc('origin_sync_apply_batch',b),{...r,replayed:true});
});
