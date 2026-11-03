// Synthetic in-memory fixtures only. No network, local secret, disk DB or real company.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {buildAccessKey} from '../../fiscal-core/src/identity.mjs';
import {createDfeBatchOrchestrator} from '../src/batch.mjs';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export const BUCKET='brufap-received-dfe',NS='http://www.portalfiscal.inf.br/nfe';
const company={legal_name:'EMPRESA FICTICIA ORQUESTRADOR',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'RUA DE TESTE',number:'1',complement:null,district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP',phone:null,email:null};
const key=buildAccessKey({cUF:'35',cnpj:'12345678000195',model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
const schemas={invoice_summary:'resNFe_v1.01.xsd',invoice:'procNFe_v4.00.xsd',event_summary:'resEvento_v1.01.xsd',event:'procEventoNFe_v1.00.xsd',unsupported:'future_v9.00.xsd'};
const document=kind=>kind==='invoice_summary'?`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resNFe>`:kind==='invoice'?`<nfeProc xmlns="${NS}" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><tpAmb>2</tpAmb></ide><dest><CNPJ>${company.cnpj}</CNPJ></dest></infNFe></NFe><protNFe><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infProt></protNFe></nfeProc>`:kind==='event_summary'?`<resEvento xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resEvento>`:kind==='event'?`<procEventoNFe xmlns="${NS}" versao="1.00"><evento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></evento><retEvento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></retEvento></procEventoNFe>`:'<unknown xmlns="urn:future"/>';
export function responseBytes(request,{status='138',kinds=['invoice_summary'],last,max,nsus,environment=request.environment,distinct=false}={}){
 if(status!=='138')kinds=[];const nsu=n=>String(n).padStart(15,'0'),base=BigInt(request.lastNsu);
 last=last===undefined?nsu(base+BigInt(kinds.length)):last;max=max===undefined?last:max;
 const docs=kinds.map((kind,i)=>({xml:document(kind)+(distinct?'\n'.repeat(i+1):''),schema:schemas[kind],nsu:nsus?nsus[i]:nsu(base+BigInt(i+1))}));
 const zipped=docs.map(d=>`<docZip${d.nsu===null?'':` NSU="${d.nsu}"`} schema="${d.schema}">${gzipSync(d.xml).toString('base64')}</docZip>`).join('');
 return Buffer.from(`<retDistDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${environment}</tpAmb><verAplic>TESTE</verAplic><cStat>${status}</cStat><xMotivo>FICTICIO</xMotivo><dhResp>2026-10-16T10:01:00-03:00</dhResp>${last===null?'':`<ultNSU>${last}</ultNSU>`}${max===null?'':`<maxNSU>${max}</maxNSU>`}${docs.length?`<loteDistDFeInt>${zipped}</loteDistDFeInt>`:''}</retDistDFeInt>`);
}
export async function fixture(){
 const db=new PGlite(),users={admin:randomUUID(),fiscal:randomUUID(),consulta:randomUUID()},files=new Map(),calls={rpc:[],put:[],read:[],transport:[],authorization:[]};
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;");
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company','0041_a1_custody','0045_dfe_distribution'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 for(const [role,id] of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 await db.query('insert into storage.buckets values($1,$1,false,8388608,$2::text[])',[BUCKET,['application/octet-stream']]);
 const identity=async(patch={})=>scalar('select public.erp_company_save_identity($1::uuid,$2::int,$3::uuid,$4::jsonb)value',[users.admin,await scalar('select coalesce((select version from erp_company.identity where singleton),0)value'),randomUUID(),JSON.stringify({...company,...patch})]);
 await identity();let queue=Promise.resolve();
 const rpc=(name,args)=>{
  assert.match(name,/^erp_dfe_[a-z_]+$/);for(const key of Object.keys(args))assert.match(key,/^p_[a-z_]+$/);
  calls.rpc.push({name,args:structuredClone(args)});
  const run=async()=>{await db.exec('set role service_role');try{const pairs=Object.entries(args);return await scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')})value`,pairs.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}};
  const value=queue.then(run,run);queue=value.catch(()=>{});return value;
 };
 const settings=()=>rpc('erp_dfe_settings',{p_user_id:users.admin,p_environment:'2'});
 const configure=async(patch={})=>{const c=(await settings()).current;return rpc('erp_dfe_configure',{p_user_id:users.admin,p_command_id:randomUUID(),p_environment:'2',p_expected_version:c?.version??0,p_expected_identity_version:await scalar('select version value from erp_company.identity where singleton'),p_coordinator:'brufap',p_checkpoint:c?.checkpoint??'000000000000000',p_checkpoint_confirmed:true,p_other_consumers_reviewed:true,p_collection_requested:true,p_reason:'Coordenação sintética de teste confirmada',...patch});};
 const job=async(patch={})=>{const c=(await configure(patch)).current;return{actor:users.fiscal,commandId:randomUUID(),channelId:c.id,expectedVersion:c.version};};
 const put=async({bucket,key,bytes,contentType,upsert,ifNoneMatch,signal,deadline})=>{
  assert.equal(bucket,BUCKET);assert.match(key,/^(?:objects\/[a-f0-9]{64}|responses\/[a-f0-9-]{36}\/[a-f0-9]{64})\.xml$/);assert.equal(contentType,'application/octet-stream');assert.equal(upsert,false);assert.equal(ifNoneMatch,'*');assert.ok(signal instanceof AbortSignal);assert.ok(Date.now()<deadline);
  const copy=Buffer.from(bytes);calls.put.push({key,hash:hash(copy),size:copy.length,upsert,ifNoneMatch});
  if(files.has(key))return{status:409};
  await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)',[bucket,key,JSON.stringify({size:copy.length,mimetype:contentType})]);files.set(key,copy);return{status:201};
 };
 const read=async({bucket,key,signal,deadline})=>{assert.equal(bucket,BUCKET);assert.ok(signal instanceof AbortSignal);assert.ok(Date.now()<deadline);calls.read.push(key);const bytes=files.get(key);return bytes?new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}}):null;};
 const transport={exchange:async(plan,options)=>{calls.transport.push({plan,options});const bytes=responseBytes(plan.request);return{bytes,request_hash:plan.request_hash,wire_hash:plan.wire_hash,response_hash:hash(bytes)};}};
 // This fixture is intentionally not an A1 authorization implementation.
 const authorize=async(context,callback)=>{calls.authorization.push(context);return callback({secureContext:Object.freeze({synthetic:true})});};
 const ports={rpc,storage:{putImmutable:put,read},transport,withAuthorizedCredential:authorize};
 const orchestrator=(overrides={})=>createDfeBatchOrchestrator({...ports,...overrides,storage:overrides.storage??ports.storage});
 const reserve=j=>rpc('erp_dfe_reserve',{p_user_id:j.actor,p_command_id:j.commandId,p_channel_id:j.channelId,p_expected_version:j.expectedVersion});
 const dispatch=(j,r)=>rpc('erp_dfe_dispatch',{p_user_id:j.actor,p_attempt_id:j.commandId,p_lease_id:r.lease_id});
 const command=j=>rpc('erp_dfe_command',{p_user_id:j.actor,p_command_id:j.commandId});
 const documents=j=>rpc('erp_dfe_documents',{p_user_id:users.consulta,p_channel_id:j.channelId});
 const expire=j=>db.query("update erp_dfe.attempt set lease_until=clock_timestamp()-interval'1 second'where id=$1",[j.commandId]);
 const reset=async()=>{await queue;await db.exec('truncate erp_dfe.channel,erp_dfe.command,erp_dfe.attempt,erp_dfe.object,erp_dfe.document,erp_dfe.attempt_document,erp_dfe.audit cascade;delete from storage.objects;update erp_access.membership set active=true;');files.clear();for(const values of Object.values(calls))values.length=0;};
 return{db,users,files,calls,scalar,rpc,identity,settings,configure,job,ports,orchestrator,reserve,dispatch,command,documents,expire,reset,close:()=>db.close()};
}
