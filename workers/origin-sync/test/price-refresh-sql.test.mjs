import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {OriginClient} from '../src/client.mjs';
import {priceCapture} from '../src/price-json.mjs';
import {refreshProposalPrices} from '../src/price-refresh.mjs';
let db,identity,seq=9600000;const owner=randomUUID(),admin=randomUUID();
const code=c=>e=>e.code===c;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args={}){const es=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${es.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,es.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const claim=resource=>rpc('origin_sync_claim',{p_resource:resource,p_owner:owner,p_ttl_seconds:600});
const call=(name,args={})=>rpc('origin_sync_price_'+name,{...identity,...args});
const list=()=>call('candidates',{p_limit:8});
async function stage(entity,id,payload,links=[]){await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash,source_updated_at) values($1,'synthetic060',$2,$3::jsonb,$4::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links',$4::jsonb)::text,'UTF8')),'hex'),'2026-01-01T00:00:00Z')",[entity,id,JSON.stringify(payload),JSON.stringify(links)]);}
async function pair({status='Rascunho',links=[],price=1.2}={}){const id=String(++seq),proposal=String(++seq);await stage('products',id,{id,preco:price},links);await stage('sales_proposals',proposal,{id:proposal,situacao:status,itens:[{produto:{id}}]});return{id,proposal};}
async function captured(id,token='99999999.1234567891'){const text=`{"data":{"id":"${id}","preco":${token}}}`;const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(text)});const payload=await c.get('/produtos/'+id);return{p_payload:payload,p_price_capture:priceCapture(payload)};}
async function begin(id){const c=(await list()).items.find(x=>x.source_id===id);assert.ok(c);const args={p_attempt_id:randomUUID(),...Object.fromEntries(Object.entries(c).map(([k,v])=>['p_'+k,v]))};const v=await call('begin',args);return{args,v,id};}
const finish=async(a,record=undefined)=>{record??=await captured(a.id);const args={p_attempt_id:a.args.p_attempt_id,...record};return{args,result:await call('finish',args)};};
const effects=()=>scalar("select jsonb_build_object('catalog',(select count(*) from erp_catalog.record),'documents',(select count(*) from erp_documents.document),'commands',(select count(*) from erp_documents.command),'finance',(select count(*) from erp_finance.title),'stock',(select count(*) from erp_stock.entry))v");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const f of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0052_origin_proposal_import','0056_origin_reference_fetch','0059_origin_price_capture','0060_origin_proposal_price_refresh'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${f}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into origin_sync.resource_state(resource,checkpoint)values('synthetic060','{\"unchanged\":true}')");await db.query('insert into auth.users values($1)',[admin]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[admin]);
});
after(()=>db?.close());
beforeEach(async()=>{
 await db.exec("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','\"Concluído\"') where entity='sales_proposals';update origin_price_refresh.scope_state set retry_after=null");
 const s=await claim('__scheduler__'),r=await claim('proposal_prices');identity={p_owner:owner,p_lease_token:s.lease_token,p_resource_token:r.lease_token};
});
test('060 exact pending scope excludes missing products, malformed references and closed proposals',async()=>{
 const a=await pair(),b=await pair({status:'Aguardando'});await pair({status:'Concluído'});const pid=String(++seq);await stage('sales_proposals',pid,{id:pid,situacao:'Pendente',itens:[{produto:{id:'999999'}},{produto:{id:['1']}},{produto:{id:'001'}}]});
 assert.deepEqual((await list()).items.map(x=>x.source_id),[a.id,b.id]);const status=await rpc('origin_sync_price_status');assert.equal(status.pending_products,2);assert.equal(status.coverage_complete,false);assert.equal(status.erp_mutations,false);
});
test('060 existing native proposal origin is excluded using real052 receipt',async()=>{
 const contact='9609001',product='9609002',proposal='9609003';
 await stage('contacts',contact,{id:contact,nome:'Contato sintético',situacao:'A',tipo:'J'});await stage('products',product,{id:product,nome:'Produto sintético',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:1.2});
 for(const [entity,id]of [['contacts',contact],['products',product]])await rpc('erp_catalog_import_origin',{p_user_id:admin,p_entity:entity,p_items:[{source_id:id,source_hash:await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id])}],p_command_id:randomUUID(),p_dry_run:false});
 await stage('sales_proposals',proposal,{id:proposal,numero:60,data:'2026-10-16',situacao:'Rascunho',contato:{id:contact},total:1.2,totalProdutos:1.2,desconto:0,outrasDespesas:0,totalOutrosItens:0,transporte:{frete:0,freteModalidade:9},itens:[{produto:{id:product,descricao:'Produto sintético'},codigo:'SYNTH',unidade:'UN',quantidade:1,valor:1.2,desconto:0,descricaoDetalhada:''}],parcelas:[],observacoes:'',observacaoInterna:''});
 assert.equal((await list()).items.length,1);const attempt=await begin(product),p=await rpc('erp_origin_proposal_import_preview',{p_user_id:admin,p_source_id:proposal});assert.equal(p.can_apply,true);
 await rpc('erp_origin_proposal_import_apply',{p_user_id:admin,p_source_id:proposal,p_preview_hash:p.preview_hash,p_command_id:randomUUID(),p_confirm_import:true,p_duplicate_reviewed:true});assert.deepEqual((await list()).items,[]);assert.equal((await finish(attempt)).result.conflict,true);
});
test('060 exact capture preserves backup links/timestamps, increments only changed payload and has one005 receipt',async()=>{
 const p=await pair({links:[{kind:'synthetic-backup',path:'private/fixture.json'}]}),before=await scalar("select to_jsonb(r)v from origin_sync.raw_record r where entity='products' and source_id=$1",[p.id]),e=await effects(),cp=await scalar("select checkpoint v from origin_sync.resource_state where resource='synthetic060'");
 const a=await begin(p.id),f=await finish(a),row=await scalar("select jsonb_build_object('price',payload->>'preco','links',document_links,'first',first_seen_at,'source',source_updated_at,'version',version::text,'capture',price_capture,'hash',version_hash)v from origin_sync.raw_record where entity='products' and source_id=$1",[p.id]);
 assert.equal(row.price,'99999999.1234567891');assert.equal(row.version,'2');assert.deepEqual(row.links,before.document_links);assert.equal(row.first,before.first_seen_at);assert.equal(row.source,before.source_updated_at);assert.equal(row.capture.source_hash,row.hash);assert.equal(f.result.updated,1);
 assert.deepEqual(await effects(),e);assert.deepEqual(await scalar("select checkpoint v from origin_sync.resource_state where resource='synthetic060'"),cp);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[a.args.p_attempt_id]),1);assert.deepEqual((await list()).items,[]);
 const r=await rpc('origin_sync_price_status');assert.equal(r.current_scope_complete,true);assert.equal(r.captured_products,1);assert.equal(r.coverage_complete,false);
});
test('060 identical price observes once without version/hash change; missing/null/string prices do not loop',async()=>{
 for(const token of ['1.2000','null','"1.2"']){const value=token==='null'?null:token.startsWith('"')?'1.2':1.2,p=await pair({price:value}),a=await begin(p.id),before=await scalar("select version_hash v from origin_sync.raw_record where source_id=$1",[p.id]);const f=await finish(a,await captured(p.id,token));assert.equal(f.result.unchanged,1);assert.equal(await scalar("select version_hash v from origin_sync.raw_record where source_id=$1",[p.id]),before);assert.ok(!(await list()).items.some(x=>x.source_id===p.id));}
 const p=await pair(),a=await begin(p.id);const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>Response.json({data:{id:p.id}})}),payload=await c.get('/produtos/'+p.id);await finish(a,{p_payload:payload,p_price_capture:priceCapture(payload)});assert.ok(!(await list()).items.some(x=>x.source_id===p.id));
});
test('060 committed replay survives expired/successor leases; payload/capture/fence reuse cannot change receipt',async()=>{
 const p=await pair(),a=await begin(p.id),f=await finish(a),old={...identity};await db.exec("update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource in('__scheduler__','proposal_prices')");await claim('__scheduler__');await claim('proposal_prices');
 const replay=await rpc('origin_sync_price_finish',{...old,...f.args});assert.deepEqual(replay,{...f.result,replayed:true});
 await assert.rejects(rpc('origin_sync_price_finish',{...old,...f.args,p_price_capture:{...f.args.p_price_capture,response_sha256:'f'.repeat(64)}}),code('40001'));
 await assert.rejects(rpc('origin_sync_price_finish',{...old,...f.args,p_owner:randomUUID()}),code('55000'));
});
test('060 keeps earlier005 receipt/hash evidence unchanged and list capture does not count as detail coverage',async()=>{
 const p=await pair(),l=await claim('synthetic060'),body={p_resource:'synthetic060',p_entity:'products',p_owner:owner,p_lease_token:l.lease_token,p_batch_id:randomUUID(),p_records:[{source_id:p.id,payload:{id:p.id,preco:99999999.1234567891}}],p_checkpoint:{older:true},p_expected_checkpoint_version:l.checkpoint_version};
 const old=await rpc('origin_sync_apply_batch',body),oldRow=await scalar('select to_jsonb(b)v from origin_sync.batch_inbox b where batch_id=$1',[body.p_batch_id]);
 const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(`{"data":[{"id":"${p.id}","preco":99999999.12345679}]}`)}),[payload]=await client.get('/produtos');
 const current=await claim('synthetic060');await rpc('origin_sync_apply_price_batch',{...body,p_batch_id:randomUUID(),p_lease_token:current.lease_token,p_expected_checkpoint_version:current.checkpoint_version,p_records:[{source_id:p.id,payload:{...payload,_brufap_source:{deleted:true,detail_available:false}},price_capture:priceCapture(payload,'list_fallback')} ]});
 assert.ok((await list()).items.some(x=>x.source_id===p.id));const a=await begin(p.id);await finish(a);assert.deepEqual(await rpc('origin_sync_apply_batch',body),{...old,replayed:true});assert.deepEqual(await scalar('select to_jsonb(b)v from origin_sync.batch_inbox b where batch_id=$1',[body.p_batch_id]),oldRow);
});
test('060 product seen/hash CAS and changed witness yield conflict without005 write or checkpoint advance',async()=>{
 for(const kind of ['seen','hash','witness']){const p=await pair(),a=await begin(p.id),cp=await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='proposal_prices'");
  if(kind==='seen')await db.query("update origin_sync.raw_record set last_seen_at=last_seen_at+interval '1 microsecond' where source_id=$1",[p.id]);
  if(kind==='hash')await db.query("update origin_sync.raw_record set version_hash=repeat('b',64),version=version+1 where source_id=$1",[p.id]);
  if(kind==='witness')await db.query("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','\"Concluído\"') where source_id=$1",[p.proposal]);
  const f=await finish(a);assert.equal(f.result.conflict,true);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[a.args.p_attempt_id]),0);assert.equal(await scalar("select checkpoint_version::text v from origin_sync.resource_state where resource='proposal_prices'"),cp);assert.equal((await call('finish',f.args)).replayed,true);
 }
});
test('060 late lease expiration rolls back payload, capture, checkpoint, ledger and terminal attempt',async()=>{
 const p=await pair(),a=await begin(p.id),before=await scalar('select to_jsonb(r)v from origin_sync.raw_record r where source_id=$1',[p.id]);
 await db.exec("create function origin_price_refresh.expire_test()returns trigger language plpgsql as $$begin update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second' where resource='__scheduler__';return new;end;$$;create trigger expire_test after update of price_capture on origin_sync.raw_record for each row execute function origin_price_refresh.expire_test()");
 try{await assert.rejects(finish(a),code('55000'));assert.deepEqual(await scalar('select to_jsonb(r)v from origin_sync.raw_record r where source_id=$1',[p.id]),before);assert.equal(await scalar('select count(*)::int v from origin_sync.batch_inbox where batch_id=$1',[a.args.p_attempt_id]),0);assert.equal(await scalar('select state v from origin_price_refresh.attempt where id=$1',[a.args.p_attempt_id]),'pending');}finally{await db.exec('drop trigger expire_test on origin_sync.raw_record;drop function origin_price_refresh.expire_test()');}
});
test('060 fail/backoff/fairness never turns404 into deletion and known success cannot become failed',async()=>{
 const p=await pair(),q=await pair(),a=await begin(p.id),before=await scalar('select to_jsonb(r)v from origin_sync.raw_record r where source_id=$1',[p.id]);await call('fail',{p_attempt_id:a.args.p_attempt_id,p_code:'ORIGIN_HTTP_ERROR',p_http_status:404});assert.deepEqual(await scalar('select to_jsonb(r)v from origin_sync.raw_record r where source_id=$1',[p.id]),before);assert.deepEqual((await list()).items.map(x=>x.source_id),[q.id]);
 await db.query("update origin_price_refresh.origin set next_attempt_at=clock_timestamp()-interval '1 second' where source_id=$1",[p.id]);assert.deepEqual((await list()).items.map(x=>x.source_id),[q.id,p.id]);const b=await begin(q.id);await finish(b);assert.equal((await call('fail',{p_attempt_id:b.args.p_attempt_id,p_code:'LOST_ACK',p_http_status:503})).already_finished,true);
 const c=await begin(p.id);await call('fail',{p_attempt_id:c.args.p_attempt_id,p_code:'ORIGIN_HTTP_ERROR',p_http_status:403});assert.deepEqual((await list()).items,[]);
});
test('060 rejects wrong identity/list capture, stale begin and unavailable capture without mutation',async()=>{
 const p=await pair(),a=await begin(p.id);await assert.rejects(finish(a,await captured('9999')),code('22023'));const r=await captured(p.id);await assert.rejects(finish(a,{...r,p_price_capture:{...r.p_price_capture,source:'list'}}),code('22023'));
 await assert.rejects(call('begin',{...a.args,p_attempt_id:randomUUID(),p_product_version:'999'}),code('40001'));assert.equal(await scalar('select state v from origin_price_refresh.attempt where id=$1',[a.args.p_attempt_id]),'pending');
});
test('060 service RPCs only, RLS and private helpers remain inaccessible directly',async()=>{
 for(const role of ['anon','authenticated','service_role']){for(const name of ['origin','attempt','scope_state'])assert.equal(await scalar('select has_table_privilege($1,$2,\'SELECT\')v',[role,'origin_price_refresh.'+name]),false);
  assert.equal(await scalar("select has_function_privilege($1,'public.origin_sync_price_status()','EXECUTE')v",[role]),role==='service_role');assert.equal(await scalar("select has_function_privilege($1,'origin_price_refresh.apply_attempt(origin_price_refresh.attempt,jsonb,jsonb)','EXECUTE')v",[role]),false);
 }
 assert.equal(await scalar("select count(*)::int v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='origin_price_refresh' and c.relkind='r' and c.relrowsecurity"),3);
});
test('060 real client→collector→SQL preserves numeric lexical value and performs no second GET once covered',async()=>{
 const p=await pair(),e=await effects(),calls=[];const repo={rpc:async(n,a)=>{calls.push(n);return rpc(n,a);}};const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(`{"data":{"id":"${p.id}","preco":99999999999999.9999999999}}`)});
 const opts={owner,lease:{lease_token:identity.p_lease_token},deadline:Date.now()+180000,enabled:true,priceCaptureEnabled:true};const r=await refreshProposalPrices(repo,c,opts);assert.equal(r.stored,1);assert.equal(await scalar("select payload->>'preco'v from origin_sync.raw_record where source_id=$1",[p.id]),'99999999999999.9999999999');assert.equal((await refreshProposalPrices(repo,c,opts)).attempted,0);assert.equal(c.requestsMade,1);assert.deepEqual(await effects(),e);assert.ok(!calls.includes('origin_sync_apply_batch'));
});
