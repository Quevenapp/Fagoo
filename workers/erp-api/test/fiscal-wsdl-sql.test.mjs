import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {prepareWsdlRequest,WSDL_LIMITS} from '../../../packages/fiscal-sefaz-wsdl/src/profile.mjs';
import {WSDL_UNSUPPORTED_CODES} from '../../../packages/fiscal-sefaz-wsdl/src/inspect-wsdl.mjs';
let db,inTest=false;const users={};const hash=v=>createHash('sha256').update(v).digest('hex');
const code=c=>e=>e.code===c;const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function safe(fn){if(!inTest)return fn();await db.exec('savepoint probe');try{const v=await fn();await db.exec('release savepoint probe');return v;}catch(e){await db.exec('rollback to savepoint probe;release savepoint probe');throw e;}}
async function role(name,fn){return safe(async()=>{await db.exec(`set local role ${name}`);try{return await fn();}finally{try{await db.exec('reset role');}catch{}}});}
const rpc=(prefix,name,types,args)=>role('service_role',()=>scalar(`select public.${prefix}_${name}(${types.map((t,i)=>`$${i+1}::${t}`).join(',')})value`,args));
const call=(name,types,args)=>rpc('erp_fiscal_wsdl',name,types,args);
const a1=(name,types,args)=>rpc('erp_a1',name,types,args);
const sql=(s,args=[])=>safe(()=>db.query(s,args));
const identityData={legal_name:'Empresa Fictícia WSDL',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'Rua Teste',number:'1',complement:null,district:'Centro',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null};
const metadata=()=>({profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:hash('synthetic certificate'),holder_cnpj:identityData.cnpj,not_before:new Date(Date.now()-86400000).toISOString(),not_after:new Date(Date.now()+86400000).toISOString(),rsa_bits:2048,presented_chain:[hash('synthetic certificate')],validated_at:new Date().toISOString(),key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false});
async function identity(patch={}){const v=await scalar('select coalesce((select version from erp_company.identity where singleton),0)value');return rpc('erp_company','save_identity',['uuid','int','uuid','jsonb'],[users.admin,v,randomUUID(),JSON.stringify({...identityData,...patch})]);}
async function configure(meta=metadata()){
 const h=await scalar('select version value from erp_a1.head'),iv=await scalar('select version value from erp_company.identity'),id=randomUUID();
 const r=await a1('reserve',['uuid','uuid','text','text','int','int','text'],[users.admin,id,hash(id),'configure',h,iv,'Preparação sintética de teste']);
 const tag=hash(randomUUID());await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)',['brufap-a1-vault',`credentials/${r.credential_id}/${tag}.json`,JSON.stringify({size:256,mimetype:'application/json'})]);
 return a1('finalize',['uuid','uuid','uuid','jsonb','text','int','text'],[users.admin,id,r.lease_id,JSON.stringify(meta),tag,256,'synthetic_key']);
}
async function begin(options={}){const input={actor:users.admin,id:randomUUID(),model:'55',operation:'status',a1Version:await scalar('select version value from erp_a1.head'),identityVersion:await scalar('select version value from erp_company.identity'),confirmed:true,...options};
 const value=await call('begin',['uuid','uuid','text','text','int','int','boolean'],[input.actor,input.id,input.model,input.operation,input.a1Version,input.identityVersion,input.confirmed]);return{...input,value,attempt:value.receipt.attempt_id,lease:value.execution?.lease_id};}
const use=(r,actor=r.actor,lease=r.lease)=>call('use',['uuid','uuid','uuid'],[actor,r.attempt,lease]);
const command=(r,actor=r.actor)=>call('command',['uuid','uuid'],[actor,r.id]);
const fail=(r,error='WSDL_TIMEOUT',actor=r.actor)=>call('fail',['uuid','uuid','uuid','text'],[actor,r.attempt,r.lease,error]);
const evidence=r=>({profile:'sp-homologation-wsdl-evidence-v1',request_id:r.attempt,model:r.model,operation:r.operation,environment:'2',wsdl_hash:hash('synthetic safe WSDL'),size_bytes:123,received_at:new Date().toISOString(),tls:{protocol:'TLSv1.3',server_identity_verified:true,client_fingerprint:hash('synthetic certificate'),client_chain:'not_evaluated',client_profile:'compatible',revocation:'unknown_offline'},inspection:{inspection_status:'supported',code:null,validation:'structural_evidence_only',target_namespace:'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4',bindings_count:1,operations_count:1,addresses_count:1},binding_verified:false});
async function object(r,e){await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',`wsdl/${r.attempt}/${e.wsdl_hash}.xml`,JSON.stringify({size:e.size_bytes,mimetype:'application/octet-stream'})]);}
const finish=(r,e,actor=r.actor)=>call('finish',['uuid','uuid','uuid','text','int','jsonb'],[actor,r.attempt,r.lease,e.wsdl_hash,e.size_bytes,JSON.stringify(e)]);
before(async()=>{
 db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;");
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company','0041_a1_custody','0051_fiscal_wsdl'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const name of ['admin','otherAdmin','fiscal','consulta','inactive']){users[name]=randomUUID();await db.query('insert into auth.users values($1)',[users[name]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[name],['otherAdmin','inactive'].includes(name)?'admin':name,name!=='inactive']);}
 await db.exec("insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);");
 await identity();await configure();
});
beforeEach(async()=>{await db.exec('begin');inTest=true;});afterEach(async()=>{await db.exec('rollback');inTest=false;});after(async()=>db?.close());

test('051 is RPC-only and private even with a broad unrelated Storage policy',async()=>{
 const tables=(await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_wsdl'and relkind='r'")).rows;assert.equal(tables.length,4);assert.ok(tables.every(t=>t.relrowsecurity));
 for(const who of ['anon','authenticated','service_role'])for(const t of tables)assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[who,`erp_fiscal_wsdl.${t.relname}`]),false);
 const functions=(await db.query("select oid::regprocedure::text signature,prosecdef,proconfig from pg_proc where proname like 'erp_fiscal_wsdl_%'")).rows;assert.equal(functions.length,5);
 for(const f of functions){assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=pg_catalog']);for(const who of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')value",[who,f.signature]),false);assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')value",[f.signature]),true);}
 for(const actor of [users.consulta,users.inactive])await assert.rejects(()=>begin({actor}),code('42501'));
 await db.exec("grant usage on schema storage to anon,authenticated;grant all on storage.objects to anon,authenticated;create policy broad on storage.objects for all to anon,authenticated using(true)with check(true);insert into storage.objects(bucket_id,name,metadata)values('brufap-fiscal-artifacts','hidden','{}'),('other','visible','{}');");
 for(const who of ['anon','authenticated']){assert.equal(await role(who,()=>scalar("select count(*)::int value from storage.objects where bucket_id='brufap-fiscal-artifacts'")),0);await assert.rejects(()=>role(who,()=>db.exec("insert into storage.objects(bucket_id,name)values('brufap-fiscal-artifacts','forbidden')")),code('42501'));}
});
test('fixed endpoints match the existing transport for all eight scopes; confirmation and CAS are explicit',async()=>{
 for(const model of ['55','65'])for(const operation of ['protocol','status','authorization','receipt']){
  const r=await begin({model,operation,actor:users.fiscal}),scope=r.value.execution.scope;assert.equal(scope.endpoint,prepareWsdlRequest({model,operation,requestId:r.attempt}).url);assert.equal(scope.method,'GET');assert.equal(scope.environment,'2');assert.equal(scope.effective_profile,'wsdl-mtls-client-v1');
  assert.equal(r.value.execution.credential.context.purpose,'offline-homologation');assert.equal(r.value.can_emit,false);assert.equal(r.value.binding_verified,false);
 }
 for(const patch of [{model:'57'},{model:null},{operation:'https://evil.test'},{operation:null},{confirmed:false},{confirmed:null},{a1Version:0},{identityVersion:0}])await assert.rejects(()=>begin(patch),code('22023'));
 await assert.rejects(()=>begin({a1Version:2}),code('40001'));await assert.rejects(()=>begin({identityVersion:2}),code('40001'));
});
test('begin replay reopens preparation only; use consumes one nonce before TLS and never repeats',async()=>{
 const r=await begin(),again=await begin(r);assert.deepEqual(again.value,{...r.value,replayed:true});assert.equal(again.lease,r.lease);
 await assert.rejects(()=>begin({...r,operation:'protocol'}),code('40001'));await assert.rejects(()=>begin({...r,actor:users.otherAdmin}),code('40001'));
 await assert.rejects(()=>use(r,users.otherAdmin),code('42501'));await assert.rejects(()=>use(r,r.actor,randomUUID()),code('40001'));
 const used=await use(r);assert.equal(used.grant.nonce,r.value.execution.scope.nonce);assert.equal(used.grant.actor,r.actor);assert.ok(used.grant.issued_at);assert.equal(used.can_transmit,false);
 await assert.rejects(()=>use(r),code('40001'));assert.equal((await begin(r)).value.execution,null);
 const view=await command(r);assert.equal(view.current.grant_consumed,true);assert.equal(view.current.retry_get_allowed,false);assert.doesNotMatch(JSON.stringify(view),/credential_id|envelope_hash|key_id|issuer_cnpj|private_executor|endpoint|nonce|lease_id/);
 assert.equal(await scalar("select count(*)::int value from erp_fiscal_wsdl.audit where action='consume'"),1);
});
test('current role, identity, credential and private object are rechecked before dispatch',async()=>{
 const r=await begin();await db.query('update erp_access.membership set active=false where user_id=$1',[users.admin]);await assert.rejects(()=>use(r),code('42501'));await assert.rejects(()=>command(r),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.admin]);
 await identity({trade_name:'Mudança explícita'});await assert.rejects(()=>use(r),code('40001'));assert.equal((await command(r)).current.company_changed,true);assert.equal((await command(r)).current.grant_consumed,false);
 await configure();const other=await begin();await configure();await assert.rejects(()=>use(other),code('40001'));assert.equal((await command(other)).current.a1_changed,true);
 const absent=await begin();await db.query("delete from storage.objects where bucket_id='brufap-a1-vault'and name=$1",[absent.value.execution.credential.object.key]);await assert.rejects(()=>use(absent),code('40001'));
});
test('finish binds stored bytes metadata, exact evidence and replay; old receipt stays separate from current',async()=>{
 const r=await begin();let e=evidence(r);await assert.rejects(()=>finish(r,e),code('40001'));await use(r);e=evidence(r);
 await assert.rejects(()=>finish(r,e),code('40001'));await object(r,e);const saved=await finish(r,e);assert.equal(saved.current.state,'stored');assert.equal(saved.artifact.wsdl_hash,e.wsdl_hash);assert.equal(saved.artifact.evidence.binding_verified,false);assert.equal(saved.replayed,false);
 await identity({trade_name:'Depois da evidência'});await configure();const replay=await finish(r,e);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,saved.receipt);assert.equal(replay.current.company_changed,true);assert.equal(replay.current.a1_changed,true);assert.equal((await begin(r)).value.execution,null);
 await assert.rejects(()=>finish(r,{...e,wsdl_hash:hash('other')}),code('40001'));await assert.rejects(()=>finish(r,e,users.otherAdmin),code('42501'));
 assert.equal(await scalar('select count(*)::int value from erp_fiscal_wsdl.artifact'),1);assert.equal((await command(r)).read_only,true);
});
test('unsupported but safely parsed WSDL is preserved without claiming a supported binding',async()=>{
 for(const unsupported of WSDL_UNSUPPORTED_CODES){const r=await begin();await use(r);const e=evidence(r);e.inspection={inspection_status:'unsupported',code:unsupported,validation:'structural_evidence_only',target_namespace:null,bindings_count:null,operations_count:null,addresses_count:null};await object(r,e);const saved=await finish(r,e);assert.equal(saved.artifact.evidence.inspection.code,unsupported);assert.equal(saved.binding_verified,false);}
});
test('evidence rejects trust promotion, arbitrary data, stale/wrong bindings and counts outside parser bounds',async()=>{
 const r=await begin();await use(r);const e=evidence(r);await object(r,e);
 const variants=[{...e,binding_verified:true},{...e,secret:'forbidden'},{...e,environment:'1'},{...e,environment:2},{...e,request_id:randomUUID()},{...e,model:'65'},{...e,operation:'protocol'},{...e,received_at:'2026-02-31T00:00:00.000Z'},{...e,received_at:new Date(Date.now()-60000).toISOString()},{...e,received_at:new Date(Date.now()+60000).toISOString()}];
 for(const patch of [{server_identity_verified:false},{client_fingerprint:hash('wrong')},{protocol:'TLSv1.1'},{protocol:null},{client_profile:null},{client_chain:'ICP-approved'},{revocation:'not_revoked'},{password:'secret'}])variants.push({...e,tls:{...e.tls,...patch}});
 for(const patch of [{bindings_count:9},{operations_count:129},{addresses_count:33},{bindings_count:1.5},{code:'RAW_EXCEPTION'},{inspection_status:'unsupported',code:'WSDL_BINDING_UNSUPPORTED'}])variants.push({...e,inspection:{...e.inspection,...patch}});
 for(const value of variants)await assert.rejects(()=>finish(r,value),code('22023'));
 for(const size_bytes of [0,WSDL_LIMITS.body_bytes+1])await assert.rejects(()=>finish(r,{...e,size_bytes}),code('22023'));
 assert.equal((await command(r)).current.state,'dispatched');assert.equal(await scalar('select count(*)::int value from erp_fiscal_wsdl.artifact'),0);
});
test('private bucket, exact path/size/MIME and RLS remain mandatory at finish',async()=>{
 const r=await begin();await use(r);const e=evidence(r);await object(r,e);
 const mutations=["update storage.buckets set public=true where id='brufap-fiscal-artifacts'","update storage.buckets set file_size_limit=8388609 where id='brufap-fiscal-artifacts'","update storage.buckets set allowed_mime_types=array['text/xml']where id='brufap-fiscal-artifacts'","update storage.objects set metadata='{}'where bucket_id='brufap-fiscal-artifacts'","update storage.objects set name='wsdl/another.xml'where bucket_id='brufap-fiscal-artifacts'","alter table storage.objects disable row level security"];
 for(const mutation of mutations){await db.exec('savepoint mutation');await db.exec(mutation);await assert.rejects(()=>finish(r,e),code('40001'));await db.exec('rollback to savepoint mutation;release savepoint mutation');}
 assert.equal((await finish(r,e)).current.state,'stored');
});
test('certificate/company changes after dispatch prevent accepting evidence and allow conservative failure recording',async()=>{
 const r=await begin();await use(r);const e=evidence(r);await object(r,e);await identity({trade_name:'Alterada durante TLS'});await assert.rejects(()=>finish(r,e),code('40001'));
 const result=await fail(r);assert.equal(result.current.state,'uncertain');assert.equal(result.current.retry_get_allowed,false);assert.equal(result.current.recovery_required,true);assert.equal((await fail(r)).replayed,true);
 await assert.rejects(()=>finish(r,e),code('40001'));assert.equal((await begin(r)).value.execution,null);
});
test('failure codes are closed, never expose raw errors and cannot reset a consumed grant',async()=>{
 const before=await begin();await assert.rejects(()=>fail(before,'PASSWORD=sentinel'),code('22023'));assert.equal((await fail(before,'WSDL_CERTIFICATE_REJECTED')).current.state,'failed');await assert.rejects(()=>use(before),code('40001'));
 const after=await begin();await use(after);assert.equal((await fail(after,'WSDL_STORAGE_FAILED')).current.state,'uncertain');await assert.rejects(()=>fail(after,'WSDL_TIMEOUT'),code('40001'));
 assert.equal((await begin(after)).value.execution,null);await assert.rejects(()=>command(after,users.otherAdmin),code('42501'));assert.doesNotMatch(JSON.stringify(await command(after)),/PASSWORD|credential_id|object_hash/);
});
test('expired preparation/dispatch is inspectable but never renewed or automatically repeatable',async()=>{
 // Only the synthetic privileged fixture may override immutable timestamps to avoid a60s wait.
 const r=await begin();await db.exec('alter table erp_fiscal_wsdl.attempt disable trigger guard_attempt');await db.query("update erp_fiscal_wsdl.attempt set expires_at=clock_timestamp()-interval'1 second'where id=$1",[r.attempt]);await db.exec('alter table erp_fiscal_wsdl.attempt enable trigger guard_attempt');
 assert.equal((await command(r)).error_code,'WSDL_GRANT_EXPIRED');assert.equal((await begin(r)).value.execution,null);await assert.rejects(()=>use(r),code('40001'));
 const d=await begin();await use(d);const e=evidence(d);await object(d,e);await db.exec('alter table erp_fiscal_wsdl.attempt disable trigger guard_attempt');await db.query("update erp_fiscal_wsdl.attempt set expires_at=clock_timestamp()-interval'1 second'where id=$1",[d.attempt]);await db.exec('alter table erp_fiscal_wsdl.attempt enable trigger guard_attempt');
 assert.equal((await command(d)).error_code,'WSDL_RESULT_UNCONFIRMED');await assert.rejects(()=>finish(d,e),code('40001'));assert.equal((await fail(d)).current.state,'uncertain');
});
test('audit failure rolls back consume and finish atomically; immutable history cannot be rewritten',async()=>{
 const r=await begin();await db.exec("create function public.reject_wsdl_audit()returns trigger language plpgsql as $$begin if new.action in('consume','store')then raise exception 'synthetic_failure';end if;return new;end$$;create trigger reject_audit before insert on erp_fiscal_wsdl.audit for each row execute function public.reject_wsdl_audit();");
 await assert.rejects(()=>use(r),code('P0001'));assert.equal((await command(r)).current.grant_consumed,false);await db.exec('alter table erp_fiscal_wsdl.audit disable trigger reject_audit');await use(r);await db.exec('alter table erp_fiscal_wsdl.audit enable trigger reject_audit');const e=evidence(r);await object(r,e);
 await assert.rejects(()=>finish(r,e),code('P0001'));assert.equal((await command(r)).current.state,'dispatched');assert.equal(await scalar('select count(*)::int value from erp_fiscal_wsdl.artifact'),0);await db.exec('alter table erp_fiscal_wsdl.audit disable trigger reject_audit');await finish(r,e);
 for(const mutation of ["update erp_fiscal_wsdl.command set receipt='{}'","delete from erp_fiscal_wsdl.artifact","delete from erp_fiscal_wsdl.audit","update erp_fiscal_wsdl.attempt set state='prepared'","delete from erp_fiscal_wsdl.attempt"])await assert.rejects(()=>sql(mutation),code('42501'));
});
test('lease expiring during evidence insertion rolls the entire finish back',async()=>{
 const r=await begin();await use(r);const e=evidence(r);await object(r,e);await db.exec('alter table erp_fiscal_wsdl.attempt disable trigger guard_attempt');await db.query("update erp_fiscal_wsdl.attempt set expires_at=clock_timestamp()+interval'200 milliseconds'where id=$1",[r.attempt]);await db.exec('alter table erp_fiscal_wsdl.attempt enable trigger guard_attempt');
 await db.exec("create function public.delay_wsdl_audit()returns trigger language plpgsql as $$begin if new.action='store'then perform pg_sleep(0.25);end if;return new;end$$;create trigger delay_audit before insert on erp_fiscal_wsdl.audit for each row execute function public.delay_wsdl_audit();");
 await assert.rejects(()=>finish(r,e),code('40001'));assert.equal((await command(r)).current.state,'dispatched');assert.equal(await scalar('select count(*)::int value from erp_fiscal_wsdl.artifact'),0);assert.equal(await scalar("select count(*)::int value from erp_fiscal_wsdl.audit where action='store'"),0);
});
test('certificate expiry blocks first use and evidence acceptance without changing the historical context041',async()=>{
 await configure({...metadata(),not_after:new Date(Date.now()+400).toISOString()});const first=await begin();await new Promise(r=>setTimeout(r,450));
 await assert.rejects(()=>use(first),code('40001'));assert.equal((await command(first)).current.certificate_time_valid_now,false);assert.equal((await command(first)).current.grant_consumed,false);
 await configure({...metadata(),not_after:new Date(Date.now()+400).toISOString()});const second=await begin();await use(second);const e=evidence(second);await object(second,e);await new Promise(r=>setTimeout(r,450));
 await assert.rejects(()=>finish(second,e),code('40001'));assert.equal((await command(second)).current.state,'dispatched');assert.equal(await scalar('select count(*)::int value from erp_fiscal_wsdl.artifact'),0);
 assert.equal(await scalar("select bool_and(context->>'purpose'='offline-homologation')value from erp_a1.credential"),true);
});
test('audit delayed beyond lease cannot return a consumed grant',async()=>{
 const r=await begin();await db.exec('alter table erp_fiscal_wsdl.attempt disable trigger guard_attempt');await db.query("update erp_fiscal_wsdl.attempt set expires_at=clock_timestamp()+interval'200 milliseconds'where id=$1",[r.attempt]);await db.exec('alter table erp_fiscal_wsdl.attempt enable trigger guard_attempt');
 await db.exec("create function public.delay_wsdl_consume()returns trigger language plpgsql as $$begin if new.action='consume'then perform pg_sleep(0.25);end if;return new;end$$;create trigger delay_consume before insert on erp_fiscal_wsdl.audit for each row execute function public.delay_wsdl_consume();");
 await assert.rejects(()=>use(r),code('40001'));assert.equal((await command(r)).current.grant_consumed,false);assert.equal(await scalar("select count(*)::int value from erp_fiscal_wsdl.audit where action='consume'"),0);
});
