import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;const users={};
const hash=v=>createHash('sha256').update(v).digest('hex');
const code=c=>e=>e.code===c;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function role(name,fn){await db.exec(`set role ${name}`);try{return await fn();}finally{await db.exec('reset role');}}
const rpc=(name,types,args)=>role('service_role',()=>scalar(`select public.erp_a1_${name}(${types.map((t,i)=>`$${i+1}::${t}`).join(',')})value`,args));
const metadata=cnpj=>({profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:hash('synthetic certificate'),holder_cnpj:cnpj,not_before:new Date(Date.now()-86400000).toISOString(),not_after:new Date(Date.now()+86400000).toISOString(),rsa_bits:2048,presented_chain:[hash('synthetic certificate')],validated_at:new Date().toISOString(),key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false});
const identityData={legal_name:'Empresa Fictícia de Custódia',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'Rua de teste',number:'1',complement:null,district:'Centro',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null};
async function identity(patch={}){const version=await scalar('select coalesce((select version from erp_company.identity where singleton),0)value');return role('service_role',()=>scalar('select public.erp_company_save_identity($1::uuid,$2::int,$3::uuid,$4::jsonb)value',[users.admin,version,randomUUID(),JSON.stringify({...identityData,...patch})]));}
const get=(actor=users.admin)=>rpc('metadata',['uuid'],[actor]);
const command=(id,actor=users.admin)=>rpc('command',['uuid','uuid'],[actor,id]);
async function reserve(options={}){
 const current=(await get()).current,co=await scalar('select erp_a1.company()value');
 const input={actor:users.admin,id:randomUUID(),tag:hash(randomUUID()),action:'configure',version:current.version,identityVersion:co?.identity_version,reason:'Conferência fictícia em memória',...options};
 const value=await rpc('reserve',['uuid','uuid','text','text','int','int','text'],[input.actor,input.id,input.tag,input.action,input.version,input.identityVersion,input.reason]);return{...input,value};
}
async function object(reservation,tag=hash(randomUUID()),size=256){await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)on conflict(bucket_id,name)do nothing',['brufap-a1-vault',`credentials/${reservation.value.credential_id}/${tag}.json`,JSON.stringify({size,mimetype:'application/json'})]);return{tag,size};}
const finalize=(r,m,o,key='key_a',actor=r.actor)=>rpc('finalize',['uuid','uuid','uuid','jsonb','text','int','text'],[actor,r.id,r.value.lease_id,JSON.stringify(m),o.tag,o.size,key]);
const reject=(r,error='CERTIFICATE_REJECTED')=>rpc('reject',['uuid','uuid','uuid','text'],[r.actor,r.id,r.value.lease_id,error]);
async function configure(){const r=await reserve(),m=metadata(r.value.context.holder_cnpj),o=await object(r),value=await finalize(r,m,o);return{r,m,o,value};}
async function disable(options={}){const input={actor:users.admin,id:randomUUID(),tag:hash(randomUUID()),version:(await get()).current.version,reason:'Desativação fictícia local',...options};return{...input,value:await rpc('disable',['uuid','uuid','text','int','text'],[input.actor,input.id,input.tag,input.version,input.reason])};}
before(async()=>{
 db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;");
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company','0041_a1_custody'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const name of ['admin','otherAdmin','fiscal','consulta','inactive']){users[name]=randomUUID();await db.query('insert into auth.users values($1)',[users[name]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[name],['otherAdmin','inactive'].includes(name)?'admin':name,name!=='inactive']);}
 await db.exec("insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']);");
});after(async()=>db?.close());
test('empty metadata is explicit and ACL/storage remain private under a broad unrelated policy',async()=>{
 const empty=await get();assert.equal(empty.can_emit,false);assert.equal(empty.can_transmit,false);assert.deepEqual(empty.current,{version:0,state:'unconfigured',credential_id:null,company_identity_version:null,metadata:null,company_changed:false,time_valid_now:false});
 assert.deepEqual(await get(users.fiscal),empty);for(const actor of [users.consulta,users.inactive])await assert.rejects(()=>get(actor),code('42501'));
 const tables=(await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_a1'and relkind='r'")).rows;assert.equal(tables.length,7);assert.ok(tables.every(r=>r.relrowsecurity));
 for(const who of ['anon','authenticated','service_role'])for(const t of tables)assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[who,`erp_a1.${t.relname}`]),false);
 for(const who of ['anon','authenticated'])await assert.rejects(()=>role(who,()=>scalar('select public.erp_a1_metadata($1::uuid)value',[users.admin])),code('42501'));
 await db.exec("grant usage on schema storage to anon,authenticated;grant select,insert,update,delete on storage.objects to anon,authenticated;create policy synthetic_broad on storage.objects for all to anon,authenticated using(true)with check(true);insert into storage.objects(bucket_id,name,metadata)values('brufap-a1-vault','secret','{}'),('other','allowed','{}');");
 for(const who of ['anon','authenticated']){
  assert.equal(await role(who,()=>scalar("select count(*)::int value from storage.objects where bucket_id='brufap-a1-vault'")),0);
  assert.equal(await role(who,()=>scalar("select count(*)::int value from storage.objects where bucket_id='other'")),1);
  await assert.rejects(()=>role(who,()=>db.exec("insert into storage.objects(bucket_id,name)values('brufap-a1-vault','blocked')")),code('42501'));
  await role(who,()=>db.exec("update storage.objects set name='changed'where bucket_id='brufap-a1-vault';delete from storage.objects where bucket_id='brufap-a1-vault'"));
 }
 assert.equal(await scalar("select count(*)::int value from storage.objects where bucket_id='brufap-a1-vault'and name='secret'"),1);
});
test('authorize consumes single-use nonce with strict TTL and action access before any certificate',async()=>{
 const call=(action,actor=users.admin,nonce=randomUUID(),at=new Date().toISOString())=>rpc('authorize',['uuid','text','uuid','timestamptz'],[actor,action,nonce,at]);
 await assert.rejects(()=>call('configure'),code('40001'));
 const nonce=randomUUID();assert.equal((await call('metadata',users.fiscal,nonce)).company,null);await assert.rejects(()=>call('metadata',users.fiscal,nonce),code('40001'));
 for(const delta of [-61000,6000])await assert.rejects(()=>call('metadata',users.admin,randomUUID(),new Date(Date.now()+delta).toISOString()),code('22023'));
 for(const action of ['configure','rewrap','disable','command'])await assert.rejects(()=>call(action,users.fiscal),code('42501'));
 await identity();const authorized=await call('configure');assert.equal(authorized.company.identity_version,1);assert.equal(authorized.company.cnpj,identityData.cnpj);assert.match(authorized.vault_id,/^[a-f0-9-]{36}$/);
});
test('configure checks metadata and exact private object then commits once with public-safe receipt',async()=>{
 const r=await reserve(),m=metadata(r.value.context.holder_cnpj),o={tag:hash('initial object'),size:300};
 assert.equal(r.value.state,'reserved');assert.equal(r.value.metadata,null);assert.equal(r.value.source_object,null);
 await assert.rejects(()=>finalize(r,m,o),code('40001'));assert.equal((await get()).current.version,0);
 await object(r,o.tag,o.size);const saved=await finalize(r,m,o);assert.equal(saved.replayed,false);assert.equal(saved.current.version,1);assert.equal(saved.receipt.version,1);assert.equal(saved.current.state,'configured_offline');assert.equal(saved.current.time_valid_now,true);
 assert.doesNotMatch(JSON.stringify(saved),/bucket|object_hash|key_id|credentials\//);assert.equal(saved.receipt.credential_id,r.value.credential_id);assert.equal(saved.receipt.metadata.can_transmit,false);
 assert.deepEqual(await finalize(r,m,o),{...saved,replayed:true});assert.equal(await scalar('select count(*)::int value from erp_a1.credential'),1);
 assert.equal((await reserve(r)).value.state,'committed');assert.equal((await command(r.id)).receipt.credential_id,r.value.credential_id);
 await assert.rejects(()=>finalize(r,{...m,rsa_bits:4096},o),code('40001'));await assert.rejects(()=>command(r.id,users.otherAdmin),code('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.admin]);await assert.rejects(()=>finalize(r,m,o),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.admin]);
});
test('reservation arguments and actor are bound even before finalize, with lease takeover fencing',async()=>{
 const r=await reserve();for(const patch of [{tag:hash('different')},{reason:'Outro motivo conferido'},{actor:users.otherAdmin},{action:'rewrap'},{version:r.version+1},{identityVersion:r.identityVersion+1}])await assert.rejects(()=>reserve({...r,...patch}),code('40001'));
 await assert.rejects(()=>reserve(r),code('40001'));
 await db.query("update erp_a1.command set lease_until=clock_timestamp()-interval'1 second'where command_id=$1",[r.id]);
 const resumed=await reserve(r);assert.equal(resumed.value.credential_id,r.value.credential_id);assert.deepEqual(resumed.value.context,r.value.context);assert.notEqual(resumed.value.lease_id,r.value.lease_id);
 const m=metadata(r.value.context.holder_cnpj),o=await object(r);
 await assert.rejects(()=>finalize(r,m,o),code('40001'));await assert.rejects(()=>reject(r),code('40001'));
 assert.equal((await finalize(resumed,m,o)).state,'committed');
});
test('two reserved commands cannot both replace the same head; identity edit also invalidates configure',async()=>{
 const one=await reserve(),two=await reserve();await finalize(one,metadata(one.value.context.holder_cnpj),await object(one));await assert.rejects(async()=>finalize(two,metadata(two.value.context.holder_cnpj),await object(two)),code('40001'));
 const pending=await reserve();await identity({trade_name:'Atualizada durante upload'});await assert.rejects(async()=>finalize(pending,metadata(pending.value.context.holder_cnpj),await object(pending)),code('40001'));
 assert.equal((await get()).current.company_changed,true);
});
test('rewrap preserves old immutable identity/metadata despite company change and rotates only key object',async()=>{
 const before=(await get()).current,r=await reserve({action:'rewrap'});assert.equal(r.value.context.company_identity_version,before.company_identity_version);assert.notEqual(r.value.context.company_identity_version,r.identityVersion);assert.deepEqual(r.value.metadata,before.metadata);assert.equal(r.value.source_object.key_id,'key_a');
 const o=await object(r);await assert.rejects(()=>finalize(r,r.value.metadata,o,'key_a'),code('40001'));await assert.rejects(()=>finalize(r,{...r.value.metadata,legacy_provider_enabled:true},o,'key_b'),code('40001'));
 const result=await finalize(r,r.value.metadata,o,'key_b');assert.equal(result.current.credential_id,before.credential_id);assert.equal(result.current.company_changed,true);assert.deepEqual(result.current.metadata,before.metadata);assert.equal(result.current.version,before.version+1);
});
test('disable is versioned and old committed replay never reactivates a prior credential',async()=>{
 const configured=await configure(),disabled=await disable();assert.equal(disabled.value.current.state,'disabled');assert.equal(disabled.value.current.metadata,null);assert.equal(disabled.value.current.time_valid_now,false);
 const replay=await finalize(configured.r,configured.m,configured.o);assert.equal(replay.receipt.state,'configured_offline');assert.equal(replay.current.state,'disabled');
 const newer=await configure(),oldDisable=await disable(disabled);assert.equal(oldDisable.value.receipt.state,'disabled');assert.equal(oldDisable.value.current.credential_id,newer.value.current.credential_id);assert.equal(oldDisable.value.replayed,true);
 await assert.rejects(()=>disable({...disabled,reason:'Outro motivo para o mesmo comando'}),code('40001'));
});
test('rejection is allowlisted and immutable, does not mutate selected head and cannot overwrite a commit',async()=>{
 const before=(await get()).current,r=await reserve();await assert.rejects(()=>reject(r,'RAW_SECRET_ERROR'),code('22023'));
 const rejected=await reject(r);assert.equal(rejected.state,'rejected');assert.equal(rejected.replayed,false);assert.deepEqual(rejected.current,before);assert.equal((await reject(r)).replayed,true);
 assert.equal((await reserve(r)).value.state,'rejected');await assert.rejects(()=>reject(r,'HOLDER_MISMATCH'),code('40001'));
 const configured=await configure();await assert.rejects(()=>reject(configured.r),code('40001'));assert.equal((await command(configured.r.id)).state,'committed');
});
test('metadata rejects unsupported trust, malformed timestamps, payload fields and stale validation',async()=>{
 const r=await reserve(),m=metadata(r.value.context.holder_cnpj),o=await object(r);
 for(const patch of [{can_transmit:true},{a1_policy_verified:true},{holder_cnpj:'00000000000000'},{password:'never-store-this'},{profile:'guess'},{rsa_bits:null},{pfx_mac_iterations:'x'},{pfx_mac_iterations:1.5},{pfx_mac_iterations:1000001},{not_before:'2026-02-31T00:00:00.000Z'},{validated_at:'today'},{presented_chain:[]},{presented_chain:[m.fingerprint_sha256,m.fingerprint_sha256]}])await assert.rejects(()=>finalize(r,{...m,...patch},o),code('22023'));
 await assert.rejects(()=>finalize(r,{...m,validated_at:new Date(Date.now()-121000).toISOString()},o),code('40001'));
 const expired={...m,not_before:new Date(Date.now()-86400000*2).toISOString(),validated_at:new Date(Date.now()-7200000).toISOString(),not_after:new Date(Date.now()-3600000).toISOString()};await assert.rejects(()=>finalize(r,expired,o),code('40001'));
 assert.equal((await command(r.id)).state,'pending');assert.doesNotMatch(JSON.stringify(await get()),/password|never-store-this/);
});
test('private Storage metadata, bucket limits and active RLS are required before selection',async()=>{
 const r=await reserve(),m=metadata(r.value.context.holder_cnpj),o=await object(r);
 for(const sql of ["update storage.buckets set public=true","update storage.buckets set file_size_limit=1500001","update storage.buckets set allowed_mime_types=array['application/json','text/plain']","update storage.objects set metadata=jsonb_build_object('size',999,'mimetype','application/json')where bucket_id='brufap-a1-vault'","alter table storage.objects disable row level security"]){
  await db.exec('begin');try{await db.exec(sql);await db.exec('set local role service_role');await assert.rejects(()=>scalar('select public.erp_a1_finalize($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text,$6::int,$7::text)value',[r.actor,r.id,r.value.lease_id,JSON.stringify(m),o.tag,o.size,'key_a']),code('40001'));}finally{await db.exec('rollback');}
 }
 assert.equal((await finalize(r,m,o)).state,'committed');
});
test('failure of audit rolls back metadata, object selection and command atomically',async()=>{
 const r=await reserve(),m=metadata(r.value.context.holder_cnpj),o=await object(r),before=(await get()).current;
 await db.exec("create function public.fail_a1_audit()returns trigger language plpgsql as $$begin raise exception 'synthetic audit failure';end$$;create trigger synthetic_failure before insert on erp_a1.audit for each row execute function public.fail_a1_audit();");
 await assert.rejects(()=>finalize(r,m,o),code('P0001'));await db.exec('drop trigger synthetic_failure on erp_a1.audit;drop function public.fail_a1_audit()');
 assert.deepEqual((await get()).current,before);assert.equal((await command(r.id)).state,'pending');assert.equal(await scalar('select count(*)::int value from erp_a1.credential where id=$1',[r.value.credential_id]),0);assert.equal(await scalar('select count(*)::int value from erp_a1.sealed_object where hash=$1',[o.tag]),0);
 assert.equal((await finalize(r,m,o)).state,'committed');
});
test('committed credential, encrypted object metadata, nonce, audit and command cannot be rewritten',async()=>{
 for(const sql of ["update erp_a1.installation set vault_id=gen_random_uuid()","update erp_a1.credential set metadata=metadata||'{\"can_transmit\":true}'","update erp_a1.sealed_object set key_id='changed'","delete from erp_a1.nonce","delete from erp_a1.audit","update erp_a1.command set result='{}'where state='committed'","delete from erp_a1.command where state='rejected'"])await assert.rejects(()=>db.exec(sql),code('42501'));
 await assert.rejects(()=>db.exec('update erp_a1.head set version=version'),code('40001'));
});
test('expired certificate may only be rewrapped as custody, never represented as time-valid',async()=>{
 const r=await reserve(),m={...metadata(r.value.context.holder_cnpj),not_after:new Date(Date.now()+300).toISOString()},o=await object(r);
 await finalize(r,m,o);await new Promise(resolve=>setTimeout(resolve,350));
 assert.equal((await get()).current.time_valid_now,false);
 const rewrapped=await reserve({action:'rewrap'}),result=await finalize(rewrapped,m,await object(rewrapped),'expired_key_rotation');
 assert.equal(result.current.time_valid_now,false);assert.equal(result.can_emit,false);assert.equal(result.can_transmit,false);assert.deepEqual(result.current.metadata,m);
});
