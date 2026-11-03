import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {OriginClient} from '../src/client.mjs';
import {priceCapture} from '../src/price-json.mjs';
import {fetchMissingReferences} from '../src/reference-fetch.mjs';
let db,legacyBody,legacyAck;const owner=randomUUID(),code=x=>e=>e.code===x;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args={}) {const entries=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) v`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const claim=async resource=>rpc('origin_sync_claim',{p_resource:resource,p_owner:owner,p_ttl_seconds:600});
async function batch(entity,records,extras={}){const resource=entity==='products'?'products_zero':'sales_proposals',l=await claim(resource);return{p_resource:resource,p_entity:entity,p_owner:owner,p_lease_token:l.lease_token,p_batch_id:randomUUID(),p_records:records,p_checkpoint:{synthetic:true},p_expected_checkpoint_version:l.checkpoint_version,...extras};}
const apply=b=>rpc(b.p_records.some(r=>Object.hasOwn(r,'price_capture'))?'origin_sync_apply_price_batch':'origin_sync_apply_batch',b);
async function captured(id,token='99999999.1234567891',entity='products',lexicalExtra=''){
 const text=entity==='products'?`{"data":{"id":"${id}","preco":${token}${lexicalExtra}}}`:`{"data":{"id":"${id}","itens":[{"valor":${token}}]}}`;
 const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(text)}),p=await c.get(`/${entity==='products'?'produtos':'propostas-comerciais'}/${id}`);return{source_id:id,payload:p,price_capture:priceCapture(p)};
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['001_origin_sync','002_origin_quotes_nfce','005_origin_auxiliary_catalogs','056_origin_reference_fetch'])await db.exec(await readFile(new URL(`../../../supabase/migrations/202610160${f}.sql`,import.meta.url),'utf8'));
 legacyBody=await batch('products',[{source_id:'1',payload:{id:'1',preco:1.2}}]);legacyAck=await apply(legacyBody);
 await assert.rejects(rpc('origin_sync_apply_price_batch',legacyBody),code('42883'));
 await db.exec(await readFile(new URL('../../../supabase/migrations/202610160059_origin_price_capture.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
test('059 legacy receipt/source unchanged, ACL and helper bypass stay private',async()=>{
 assert.deepEqual(await apply(legacyBody),{...legacyAck,replayed:true});assert.equal(await scalar("select price_capture v from origin_sync.raw_record where source_id='1'"),null);
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(await scalar("select has_function_privilege($1,'origin_sync.apply_batch_legacy_059(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','EXECUTE') v",[role]),false);
  assert.equal(await scalar("select has_function_privilege($1,'origin_sync.validate_price_capture(text,jsonb,jsonb)','EXECUTE') v",[role]),false);
  assert.equal(await scalar("select has_table_privilege($1,'origin_sync.raw_record','SELECT') v",[role]),false);
  assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_reference_finish_precise(uuid,uuid,uuid,uuid,jsonb,jsonb)','EXECUTE') v",[role]),role==='service_role');
  assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_apply_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)','EXECUTE') v",[role]),role==='service_role');
 }
});
test('explicit precise entry point cannot accept missing capture or another entity',async()=>{
 const b=await batch('products',[{source_id:'9',payload:{id:'9',preco:1}}]);
 await assert.rejects(rpc('origin_sync_apply_price_batch',b),code('22023'));
 await assert.rejects(rpc('origin_sync_apply_price_batch',{...b,p_entity:'contacts',p_records:[await captured('9')]}),code('22023'));
 assert.equal(await scalar("select count(*)::int v from origin_sync.raw_record where source_id='9'"),0);
});
test('HTTP capture reaches JSONB as exact number; repeated receipt and hash remain stable',async()=>{
 const record=await captured('2'),b=await batch('products',[record]),r=await apply(b);assert.equal(r.price_captures,1);assert.equal(r.inserted,1);assert.deepEqual(await apply(b),{...r,replayed:true});
 const row=await scalar("select jsonb_build_object('value',payload->>'preco','type',jsonb_typeof(payload->'preco'),'version',version::text,'hash',version_hash,'capture',price_capture)v from origin_sync.raw_record where entity='products' and source_id='2'");
 assert.equal(row.value,'99999999.1234567891');assert.equal(row.type,'number');assert.equal(row.version,'1');assert.equal(row.capture.source_hash,row.hash);assert.equal(row.capture.source_version,'1');assert.equal(row.capture.tokens[0].lexeme,row.value);
 assert.equal(row.hash,await scalar("select encode(sha256(convert_to(jsonb_build_object('payload',$1::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex')v",[JSON.stringify(record.payload)]));
 const altered={...record,price_capture:{...record.price_capture,response_sha256:'b'.repeat(64)}};await assert.rejects(apply({...b,p_records:[altered]}),code('22023'));
});
test('same mathematical value updates only observation; metadata never changes origin hash/version',async()=>{
 const a=await captured('1','1.2000');const before=await scalar("select version_hash v from origin_sync.raw_record where source_id='1'");const result=await apply(await batch('products',[a]));assert.equal(result.unchanged,1);
 const b=await captured('1','1.2e0');await apply(await batch('products',[b]));assert.equal(await scalar("select version_hash v from origin_sync.raw_record where source_id='1'"),before);assert.equal(await scalar("select version::text v from origin_sync.raw_record where source_id='1'"),'1');assert.equal(await scalar("select price_capture#>>'{tokens,0,lexeme}' v from origin_sync.raw_record where source_id='1'"),'1.2e0');
 assert.deepEqual(await apply(legacyBody),{...legacyAck,replayed:true});
});
test('rollback flag permits unchanged legacy observations/replay but blocks loss of exact data atomically',async()=>{
 const before=await scalar("select to_jsonb(r) v from origin_sync.raw_record r where source_id='2'");
 const b=await batch('products',[{source_id:'2',payload:{id:'2',preco:99999999.1234567891}}]),cp=await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='products_zero'");
 await assert.rejects(apply(b),code('40001'));assert.deepEqual(await scalar("select to_jsonb(r) v from origin_sync.raw_record r where source_id='2'"),before);assert.equal(await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='products_zero'"),cp);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[b.p_batch_id]),0);
 const unchanged=await batch('products',[{source_id:'1',payload:{id:'1',preco:1.2}}]);assert.equal((await apply(unchanged)).unchanged,1);assert.ok(await scalar("select price_capture is not null v from origin_sync.raw_record where source_id='1'"));
});
test('new exact observation corrects current value once without rewriting old receipt',async()=>{
 const old=await batch('products',[{source_id:'3',payload:{id:'3',preco:99999999.1234567891}}]),ack=await apply(old),hash=await scalar("select version_hash v from origin_sync.raw_record where source_id='3'");
 const precise=await batch('products',[await captured('3')]);assert.equal((await apply(precise)).updated,1);assert.notEqual(await scalar("select version_hash v from origin_sync.raw_record where source_id='3'"),hash);assert.equal(await scalar("select version::text v from origin_sync.raw_record where source_id='3'"),'2');assert.deepEqual(await apply(old),{...ack,replayed:true});
});
test('tokens are complete, exact, path-bounded and unsupported metadata is rejected',async()=>{
 const good=await captured('4');
 const variants=[{...good.price_capture,tokens:[]},{...good.price_capture,tokens:[{path:'/id',lexeme:'4'}]},{...good.price_capture,tokens:[{path:'/preco',lexeme:'1'}]},{...good.price_capture,extra:true},{...good.price_capture,tokens:[{path:'/preco',lexeme:'99999999.1234567891'},{path:'/preco',lexeme:'99999999.1234567891'}]},{...good.price_capture,source:'list_fallback'}];
 for(const c of variants)await assert.rejects(apply(await batch('products',[{...good,price_capture:c}])),code('22023'));
 assert.equal(await scalar("select count(*)::int v from origin_sync.raw_record where source_id='4'"),0);
 const p=await captured('5','0.1234567891','sales_proposals');await apply(await batch('sales_proposals',[p]));assert.equal(await scalar("select payload#>>'{itens,0,valor}' v from origin_sync.raw_record where source_id='5'"),'0.1234567891');
});
test('a second-row failure rolls back payload, observation, receipt and checkpoint',async()=>{
 const first=await captured('6'),second=await captured('7'),b=await batch('products',[first,{...second,source_id:''}]),cp=await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='products_zero'");
 await assert.rejects(apply(b),code('22023'));assert.equal(await scalar("select count(*)::int v from origin_sync.raw_record where source_id in('6','7')"),0);assert.equal(await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='products_zero'"),cp);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[b.p_batch_id]),0);
});
test('expired fence prevents both exact capture and advancing checkpoint',async()=>{
 const b=await batch('products',[await captured('8')]);await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='products_zero'");await assert.rejects(apply(b),code('55000'));assert.equal(await scalar("select count(*)::int v from origin_sync.raw_record where source_id='8'"),0);
});
test('056 HTTP collector uses precise finish, has immutable replay evidence and no list checkpoint write',async()=>{
 await apply(await batch('sales_proposals',[{source_id:'99',payload:{id:'99',situacao:'Rascunho',itens:[{produto:{id:'201'}}]}}]));
 const scheduler=await claim('__scheduler__'),calls=[];const repo={rpc:async(name,args)=>{calls.push({name,args});return rpc(name,args);}};
 const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response('{"data":{"id":"201","preco":99999999999999.9999999999}}')});
 const before=await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='sales_proposals'");
 const result=await fetchMissingReferences(repo,c,{owner,lease:scheduler,deadline:Date.now()+180000});assert.equal(result.stored,1);assert.equal(c.requestsMade,1);
 const call=calls.find(x=>x.name==='origin_sync_reference_finish_precise');assert.ok(call);assert.equal(await scalar("select payload->>'preco' v from origin_sync.raw_record where source_id='201'"),'99999999999999.9999999999');assert.equal(await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='sales_proposals'"),before);
 // Restore the same resource lease for056 replay; collector released it intentionally.
 await db.query("update origin_sync.resource_state set lease_owner=$1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' where resource='proposal_references'",[owner,call.args.p_resource_token]);
 assert.equal((await rpc(call.name,call.args)).replayed,true);await assert.rejects(rpc(call.name,{...call.args,p_price_capture:{...call.args.p_price_capture,response_sha256:'f'.repeat(64)}}),code('40001'));
 await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='proposal_references'");
 await assert.rejects(rpc(call.name,call.args),code('55000'));
 const {p_price_capture:unused,...legacyArgs}=call.args;await assert.rejects(rpc('origin_sync_reference_finish',legacyArgs),code('55000'));
 const successor=await claim('proposal_references');assert.notEqual(successor.lease_token,call.args.p_resource_token);await assert.rejects(rpc(call.name,call.args),code('55000'));
});

test('lease expiring during final observation write rolls the entire batch back',async()=>{
 const b=await batch('products',[await captured('10')]),cp=await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='products_zero'");
 await db.exec("create function origin_sync.synthetic_expire_capture() returns trigger language plpgsql as $$begin update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='products_zero';return new;end;$$;create trigger synthetic_expire_capture after update of price_capture on origin_sync.raw_record for each row execute function origin_sync.synthetic_expire_capture()");
 try{await assert.rejects(apply(b),code('55000'));assert.equal(await scalar("select count(*)::int v from origin_sync.raw_record where source_id='10'"),0);assert.equal(await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='products_zero'"),cp);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[b.p_batch_id]),0);}finally{await db.exec('drop trigger synthetic_expire_capture on origin_sync.raw_record;drop function origin_sync.synthetic_expire_capture()');}
});
