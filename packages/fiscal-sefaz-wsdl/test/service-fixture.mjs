// In-memory database, inert SecureContext and EventEmitter HTTPS driver. No A1 or remote I/O.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSecureContext} from 'node:tls';
import {PGlite} from '@electric-sql/pglite';
import {fixture as transport,plan} from './fixtures.mjs';
import {createWsdlService,createWsdlPreparationAuthorizer} from '../src/service.mjs';
export const hash=v=>createHash('sha256').update(v).digest('hex');
const TYPES={begin:['uuid','uuid','text','text','int','int','boolean'],use:['uuid','uuid','uuid'],finish:['uuid','uuid','uuid','text','int','jsonb'],fail:['uuid','uuid','uuid','text'],command:['uuid','uuid']};
const KEYS={begin:['p_user_id','p_command_id','p_model','p_operation','p_expected_a1_version','p_expected_identity_version','p_confirmed'],use:['p_user_id','p_attempt_id','p_lease_id'],finish:['p_user_id','p_attempt_id','p_lease_id','p_wsdl_hash','p_size_bytes','p_evidence'],fail:['p_user_id','p_attempt_id','p_lease_id','p_error_code'],command:['p_user_id','p_command_id']};
export async function serviceFixture({model='55',transportOptions={}}={}){
 const db=new PGlite(),actor=randomUUID(),files=new Map(),calls={rpc:[],put:[],read:[],custody:[]},buffers=[];
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 try{
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;");
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company','0041_a1_custody','0051_fiscal_wsdl'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role,active)values($1,'admin',true)",[actor]);
  await db.exec("insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);");
  const identity={legal_name:'Fictícia WSDL',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'Rua Teste',number:'1',complement:null,district:'Centro',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null};
  await scalar('select public.erp_company_save_identity($1::uuid,0,$2::uuid,$3::jsonb)value',[actor,randomUUID(),JSON.stringify(identity)]);
  const cmd=randomUUID(),r=await scalar("select public.erp_a1_reserve($1::uuid,$2::uuid,$3,'configure',0,1,'Confirmação sintética')value",[actor,cmd,hash(cmd)]),envelopeHash=hash('synthetic encrypted placeholder');
  const meta={profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:hash('synthetic certificate'),holder_cnpj:identity.cnpj,not_before:new Date(Date.now()-86400000).toISOString(),not_after:new Date(Date.now()+86400000).toISOString(),rsa_bits:2048,presented_chain:[hash('synthetic certificate')],validated_at:new Date().toISOString(),key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false};
  await db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-a1-vault',`credentials/${r.credential_id}/${envelopeHash}.json`,JSON.stringify({size:256,mimetype:'application/json'})]);
  await scalar('select public.erp_a1_finalize($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,256,\'synthetic\')value',[actor,cmd,r.lease_id,JSON.stringify(meta),envelopeHash]);
  const input={actor,commandId:randomUUID(),model,operation:'protocol',expectedA1Version:1,expectedIdentityVersion:1,confirmed:true};
  const callSql=async(name,args)=>{const action=name.replace('erp_fiscal_wsdl_','');assert.ok(Object.hasOwn(TYPES,action));await db.exec('set role service_role');try{return await scalar(`select public.${name}(${TYPES[action].map((t,i)=>`$${i+1}::${t}`).join(',')})value`,KEYS[action].map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]));}finally{await db.exec('reset role');}};
  const rpc=async(name,args,o)=>{assert.ok(!o.signal.aborted&&o.deadline>Date.now());calls.rpc.push({name,args:structuredClone(args)});return callSql(name,args);};
  const authorizer=createWsdlPreparationAuthorizer({rpc});
  const custody=async(value,action,o)=>{calls.custody.push(value);assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.execution));await authorizer(value,o);const session={secureContext:createSecureContext(),metadata:{fingerprint_sha256:meta.fingerprint_sha256,holder_cnpj:meta.holder_cnpj,not_before:meta.not_before,not_after:meta.not_after,client_auth_usage:'explicit_client_auth',presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,can_emit:false,can_transmit:false},signal:o.signal,deadline:o.deadline};return action(session);};
  const storage={
   async read(o){calls.read.push(o.key);assert.equal(o.bucket,'brufap-fiscal-artifacts');const bytes=files.get(o.key);return bytes?new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}}):null;},
   async putImmutable(o){calls.put.push(o.key);assert.equal(o.bucket,'brufap-fiscal-artifacts');assert.match(o.key,/^wsdl\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/);assert.equal(o.upsert,false);assert.equal(o.ifNoneMatch,'*');assert.equal(o.contentType,'application/octet-stream');assert.equal(hash(o.bytes),o.key.slice(-68,-4));buffers.push(o.bytes);if(files.has(o.key))return{status:409,requires_readback:true};files.set(o.key,Buffer.from(o.bytes));await db.query('insert into storage.objects values($1,$2,$3::jsonb)',[o.bucket,o.key,JSON.stringify({size:o.bytes.length,mimetype:o.contentType})]);return{status:201,requires_readback:true};}
  };
  const wire=transport({plan:plan(model),...transportOptions}),requestImpl=(...args)=>{assert.ok(calls.rpc.some(x=>x.name==='erp_fiscal_wsdl_use'));return wire.requestImpl(...args);};
  const ports={rpc,storage,requestImpl,withPreparedTlsSession:custody},service=(patch={})=>createWsdlService({...ports,...patch});
  const command=()=>callSql('erp_fiscal_wsdl_command',{p_user_id:actor,p_command_id:input.commandId});
  return{db,actor,input,meta,calls,files,buffers,wire,ports,service,callSql,command,close:()=>db.close()};
 }catch(error){await db.close();throw error;}
}
