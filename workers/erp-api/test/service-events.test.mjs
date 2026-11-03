import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseServiceEventsRoute,executeServiceEventsRoute,serviceEventsResponse,serviceEventsMethods,SERVICE_EVENTS_RESPONSE_BYTES} from '../src/service-events.mjs';
let db,contact;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function rpc(name,args){await db.exec('set role service_role');try{const entries=Object.entries(args);return await scalar(`select public.${name}(${entries.map(([k],i)=>k+'=>$'+(i+1)).join(',')})value`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0012_erp_attachments','0049_service_order_events'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 for(const role of['admin','vendas','financeiro','consulta','estoque','fiscal']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato fictício',document:'PRIVATE_DOCUMENT',email:'private@example.invalid'}})).record;
});after(()=>db?.close());
const body=(patch={})=>({date:'2026-10-16',contact_id:contact.id,items:[{description:'Serviço fictício',unit:'UN',quantity:'1.250000',unit_price:'10.0000'}],equipment:'Equipamento fictício',serial_number:'TEST-001',technician:'Técnico fictício',internal_notes:'PRIVATE_COMMERCIAL',...patch});
const save=(d,patch={})=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:'service_orders',p_id:d?.id??null,p_expected_version:d?.version??0,p_command_id:randomUUID(),p_body:body(patch)}).then(r=>r.document);
const transition=(d,status)=>rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'service_orders',p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Mudança fictícia'}).then(r=>r.document);
const event=(type='reception',patch={})=>({type,occurred_on:'2026-10-16',declarant_name:'Pessoa fictícia',declarant_role:'customer',details:type==='reception'?{accessories:null,apparent_condition:'Condição declarada'}:type==='delivery'?{delivered_condition:'Condição de entrega declarada',tests_summary:null}:{decision:'approved',channel:'phone'},notes:null,attachment_id:null,corrects_event_id:null,correction_reason:null,confirm_record:true,...patch});
const input=(d,data=event(),command=randomUUID())=>({command_id:command,expected_document_version:d.version,data});
const base=d=>'/v1/ordens-servico/'+d.id+'/eventos';
const request=(path,value,options={})=>new Request('https://api.example.test'+path,{method:value===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)}),...options});
const parse=(path,value,options)=>parseServiceEventsRoute(request(path,value,options));
const exec=async(path,value,actor=users.admin)=>executeServiceEventsRoute(await parse(path,value),{userId:actor,rpc});
const err=status=>e=>e.status===status;

test('049 SQL→HTTP preserves exact amounts, immutable declaration and current context after transition/cancellation',async()=>{
 let d=await save(null,{items:[{description:'Valor máximo fictício',unit:'UN',quantity:'1000',unit_price:'999999999.9999'}],other_expenses:'0.09'});d=await transition(d,'quoted');
 const payload=input(d,event('customer_decision',{declarant_name:'\u00a0 Pessoa fictícia \u200b',notes:'  Nota\ncom quebra  '})),first=await exec(base(d),payload);
 assert.equal(first.record.total,'999999999999.99');assert.equal(first.record.declarant_name,'Pessoa fictícia');assert.equal(first.record.notes,'Nota\ncom quebra');assert.equal(first.current.approval_basis_matches_current,true);assert.equal(first.record.actor_id,users.admin);assert.equal(first.replayed,false);
 for(const field of['consent_verified','signature_verified','changes_document_status','financial_mutation_performed','stock_mutation_performed'])assert.equal(first[field],false);
 assert.doesNotMatch(JSON.stringify(first),/PRIVATE|example.invalid|internal_notes|object_key|bucket/);
 d=await transition(d,'approved');let current=await exec(base(d)+'/'+first.record.id);assert.equal(current.current.document_version_changed,true);assert.equal(current.current.commercial_content_changed,false);assert.equal(current.current.approval_basis_matches_current,false);
 d=await transition(d,'cancelled');const replay=await exec(base(d),payload);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);assert.equal(replay.can_record,false);assert.deepEqual(replay.allowed_event_types,[]);assert.equal(replay.current.document_status,'cancelled');
 await assert.rejects(()=>exec(base(d),input(d)),err(409));
});

test('049 pagination uses exact decimal cursors and corrections remain separate immutable records',async()=>{
 const d=await save(),first=await exec(base(d),input(d)),correction=await exec(base(d),input(d,event('reception',{corrects_event_id:first.record.id,correction_reason:'Correção fictícia declarada'})));
 for(let i=0;i<3;i++)await exec(base(d),input(d,event('reception',{notes:'Registro '+i})));
 const page=await exec(base(d)+'?limit=2',undefined,users.consulta),next=await exec(base(d)+'?limit=2&before='+page.next_before,undefined,users.financeiro);
 assert.deepEqual(page.items.map(x=>x.record.sequence),['5','4']);assert.deepEqual(next.items.map(x=>x.record.sequence),['3','2']);assert.equal(page.can_record,false);
 const original=await exec(base(d)+'/'+first.record.id);assert.equal(original.current.corrected_by_event_id,correction.record.id);assert.deepEqual(original.record,first.record);
 const other=await save();await assert.rejects(()=>exec(base(other)+'/'+first.record.id),err(404));
});

test('049 real ACL is enforced for reads, appends and replay after membership revocation',async()=>{
 const d=await save(),payload=input(d),first=await exec(base(d),payload,users.vendas);
 for(const role of['estoque','fiscal'])await assert.rejects(()=>exec(base(d),undefined,users[role]),err(403));
 for(const role of['financeiro','consulta','estoque','fiscal'])await assert.rejects(()=>exec(base(d),input(d),users[role]),err(403));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.vendas]);
 try{await assert.rejects(()=>exec(base(d),payload,users.vendas),err(403));}finally{await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);}
 assert.equal((await exec(base(d),payload,users.vendas)).record.id,first.record.id);
});

test('049 strict paths, query and body reject overrides and preserve PostgreSQL Unicode normalization',async()=>{
 const d=await save(),url=base(d),payload=input(d);
 assert.deepEqual(serviceEventsMethods(url),['GET','POST']);assert.deepEqual(serviceEventsMethods(url+'/'+randomUUID()),['GET']);
 for(const tail of['?limit=26','?limit=0','?before=01','?before=10000000000','?limit=2&limit=3','?user_id='+users.admin,'/'+randomUUID()+'?limit=1'])await assert.rejects(()=>parse(url+tail),err(400));
 for(const change of[v=>v.actor=users.admin,v=>v.data.total='0',v=>v.data.confirm_record=false,v=>v.data.declarant_name=['Name'],v=>v.data.details.extra='x',v=>v.data.declarant_name='\u00a0\u200b',v=>v.data.occurred_on='2026-02-30',v=>v.data.occurred_on='2100-01-01',v=>v.data.corrects_event_id=randomUUID(),v=>v.data.notes='<script>',v=>v.data.declarant_name='😀'.repeat(201)]){
  const v=structuredClone(payload);change(v);await assert.rejects(()=>parse(url,v),err(400));
 }
 for(const options of[{headers:{'Content-Encoding':'gzip','Content-Type':'application/json'}},{body:new Uint8Array([0xc3,0x28])}])await assert.rejects(()=>parse(url,payload,options),err(400));
 await assert.rejects(()=>parse(url,payload,{body:' '.repeat(65537)}),err(413));
 const long=await exec(url,input(d,event('reception',{declarant_name:'😀'.repeat(200),notes:'😀'.repeat(2000),details:{accessories:'😀'.repeat(1000),apparent_condition:'😀'.repeat(1000)}})));
 assert.equal(Array.from(long.record.declarant_name).length,200);assert.ok(Buffer.byteLength(JSON.stringify(long))<SERVICE_EVENTS_RESPONSE_BYTES);
 const upper=await parse(url.toUpperCase().replace('/V1/ORDENS-SERVICO/','/v1/ordens-servico/').replace('/EVENTOS','/eventos'));
 assert.equal(upper.args.p_document_id,d.id);
});

test('049 DTO refuses swapped scope, forged status/total/consent or inconsistent latest-context fields',async()=>{
 const d=await save(),route=await parse(base(d),input(d)),raw=await rpc(route.rpc,{...route.args,p_user_id:users.admin});
 const projected=serviceEventsResponse({...raw,private:{raw:true}},route,users.admin);assert.equal(projected.private,undefined);
 for(const change of[v=>v.document.id=randomUUID(),v=>v.record.document_id=randomUUID(),v=>v.record.actor_id=randomUUID(),v=>v.record.total=12.5,v=>v.document.total='9999999999999.99',v=>v.consent_verified=true,v=>v.current.document_version_changed=true,v=>v.current.approval_basis_matches_current=true,v=>v.record.recorded_at='2026-02-30T00:00:00Z',v=>v.record.details.accessories='x',v=>v.record.snapshot.contact.email='PRIVATE']){
  const altered=structuredClone(raw);change(altered);
  if(altered.record.snapshot.contact.email){assert.equal(serviceEventsResponse(altered,route,users.admin).record.snapshot.contact.email,undefined);continue;}
  assert.throws(()=>serviceEventsResponse(altered,route,users.admin),err(502));
 }
 const listRoute=await parse(base(d)+'?limit=1'),list=await rpc(listRoute.rpc,{...listRoute.args,p_user_id:users.admin});
 assert.throws(()=>serviceEventsResponse({...list,next_before:'1'},listRoute,users.admin),err(502));
 await assert.rejects(()=>executeServiceEventsRoute({...route},{userId:users.admin,rpc}),err(404));
});

test('049 uncertain append preserves command and recovers historical receipt with fresh current context',async()=>{
 let d=await save();const payload=input(d),route=await parse(base(d),payload);let invoked=0;
 await assert.rejects(()=>executeServiceEventsRoute(route,{userId:users.admin,rpc:async(name,args)=>{invoked++;await rpc(name,args);throw Error('PRIVATE-ACK-LOST');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 assert.equal(invoked,1);d=await transition(d,'quoted');const recovered=await exec(base(d),payload);assert.equal(recovered.replayed,true);assert.equal(recovered.current.document_version_changed,true);assert.equal(recovered.record.document_version,1);
 const fresh=await exec(base(d)+'/'+recovered.record.id);assert.deepEqual(fresh.record,recovered.record);assert.equal(fresh.document.version,d.version);
 assert.equal(await scalar('select count(*)::int value from erp_documents.service_event where document_id=$1',[d.id]),1);
});

test('049 timeout and abort after dispatch remain uncertain; late commit is recovered using the same command',async()=>{
 const d=await save(),payload=input(d),route=await parse(base(d),payload),abort=new AbortController();let entered,release;
 const reached=new Promise(r=>entered=r),pause=new Promise(r=>release=r);let committed;
 const promise=executeServiceEventsRoute(route,{userId:users.admin,signal:abort.signal,rpc:async(name,args,options)=>{committed=await rpc(name,args);entered(options.signal);await pause;return committed;}});
 const signal=await reached;abort.abort();await assert.rejects(()=>promise,e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');assert.equal(signal.aborted,true);release();
 const current=await exec(base(d),payload);assert.equal(current.replayed,true);assert.equal(current.record.id,committed.record.id);
 const stopped=new AbortController();stopped.abort();let calls=0;await assert.rejects(()=>executeServiceEventsRoute(route,{userId:users.admin,signal:stopped.signal,rpc:async()=>{calls++;}}),err(400));assert.equal(calls,0);
 await assert.rejects(()=>executeServiceEventsRoute(route,{userId:users.admin,timeoutMs:10,rpc:()=>new Promise(()=>{})}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
});

test('049 linked attachment snapshot is only metadata from the same OS, with no object path projected',async()=>{
 const d=await save(),url=base(d);await db.exec("insert into storage.buckets values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain']);");
 const reserved=await rpc('erp_attachment_reserve',{p_user_id:users.admin,p_kind:'service_orders',p_document_id:d.id,p_command_id:randomUUID(),p_filename:'anexo-sintetico.txt',p_mime_type:'text/plain',p_size_bytes:10,p_sha256:'a'.repeat(64)}),attachment=reserved.attachment.id,lease=randomUUID();
 await rpc('erp_attachment_claim',{p_user_id:users.admin,p_kind:'service_orders',p_document_id:d.id,p_id:attachment,p_lease:lease});
 await db.query('insert into storage.objects values($1,$2,$3)',['erp-attachments',`documents/${d.id}/${attachment}/${'a'.repeat(64)}`,JSON.stringify({size:10,mimetype:'text/plain'})]);
 await rpc('erp_attachment_finish',{p_user_id:users.admin,p_kind:'service_orders',p_document_id:d.id,p_id:attachment,p_lease:lease,p_sha256:'a'.repeat(64),p_size_bytes:10});
 const saved=await exec(url,input(d,event('reception',{attachment_id:attachment})));assert.equal(saved.record.attachment.id,attachment);assert.equal(saved.record.attachment.sha256,'a'.repeat(64));assert.doesNotMatch(JSON.stringify(saved),/object_key|bucket|lease/);
});
