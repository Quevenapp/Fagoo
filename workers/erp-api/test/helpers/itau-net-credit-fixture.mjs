import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseCnabRoute,executeCnabRoute} from '../../src/cnab.mjs';
import {parseCnabOperationalRoute,executeCnabOperationalRoute} from '../../src/cnab-operational.mjs';
import {parseCnabReturnsRoute,executeCnabReturnsRoute} from '../../src/cnab-returns.mjs';
import {PROFILES,CNPJ,returnFile,replaceField} from '../../../../packages/cnab-core/test/fixtures.mjs';
export async function createNetCreditFixture({database=null,invokeRpc=null}={}) {
let db,today,contact,ordinal=0;const users={},objects=new Map();
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
const state=code=>e=>e.code===code;
async function rpc(name,args){if(invokeRpc)return invokeRpc(name,args);const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([k,v])=>['p_event_hashes','p_controls'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const native=(action,data,command=randomUUID())=>rpc('erp_finance_execute',{p_user_id:users.financeiro,p_command_id:command,p_action:action,p_data:data});
async function storeFile({bucket,path,bytes,upsert}){assert.equal(bucket,'brufap-cnab');assert.equal(upsert,false);const key=bucket+'/'+path;if(objects.has(key))return;objects.set(key,bytes.slice());await db.query('insert into storage.objects values($1,$2,$3)',[bucket,path,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);}
const getFile=async({bucket,path})=>objects.get(bucket+'/'+path)?.slice()||new Response(null,{status:404});
const ports=extra=>({userId:users.financeiro,rpc,storeFile,getFile,...extra});
const req=(p,b)=>new Request('https://test.invalid'+p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:{});
const op=async(p,b,extra)=>executeCnabOperationalRoute(await parseCnabOperationalRoute(req('/v1/cobranca-operacional'+p,b)),ports(extra));
const api=async(p,b,extra)=>executeCnabReturnsRoute(await parseCnabReturnsRoute(req('/v1/retornos-operacionais'+p,b)),ports(extra));
const legacy=async(p,b,extra)=>executeCnabRoute(await parseCnabRoute(req('/v1/cnab'+p,b)),ports(extra));
const day=x=>x.slice(8,10)+x.slice(5,7)+x.slice(2,4);
async function prepare(bank='itau'){
 const account=(await native('account_save',{expected_version:0,name:'CONTA SINTETICA '+(++ordinal),kind:'bank'})).record,{accountId,...base}=PROFILES[bank];
 const profile=(await legacy('/profiles',{expected_version:0,command_id:randomUUID(),data:{...base,account:bank==='itau'?String(20000+ordinal):String(200000+ordinal).padStart(9,'0'),account_id:account.id,ourNumberStart:bank==='itau'?'00000001':null,remittanceSequenceStart:'1'}},{userId:users.admin})).body.profile;
 await op(`/profiles/${profile.id}/approval`,{command_id:randomUUID(),expected_approval_version:0,expected_profile_version:1,expected_identity_version:1,enabled:true,confirmed_on:today,reference:'SYNTHETIC AUTHORIZATION ONLY'},{userId:users.admin});
 const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:'TITULO SINTETICO',issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];
 const b={command_id:randomUUID(),profile_id:profile.id,expected_version:1,expected_approval_version:1,generated_on:today,titles:[{title_id:title.id,expected_version:1,document_number:'F'+String(ordinal).padStart(8,'0'),...(bank==='inter'?{payment_limit_days:30}:{})}],confirm_operational:false},preview=(await op('/remittances/preview',b)).body;
 const remittance=(await op('/remittances',{...b,confirm_operational:true,preview_hash:preview.preview_hash})).body;
 const reservation=await rpc('erp_cnab_operational_reservation',{p_user_id:users.admin,p_id:remittance.id,p_expected_approval:1});return{bank,profile,account,title,remittance,snapshot:reservation.snapshot,bt:reservation.snapshot.titles[0]};
}
function source(f,patch={},sequence='00001'){
 let bytes=returnFile({bank:f.snapshot.profile.bank,profile:f.snapshot.profile,generatedDate:day(today),fileSequence:sequence,events:[{control:f.bt.control,documentNumber:f.bt.documentNumber,ourNumber:f.bt.ourNumber??'00000000001',amount:f.bt.amountCents,paid:f.bt.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today),...patch}]});
 // Official Itaú detail positions, independent of production layout readers.
 for(const [key,position]of Object.entries({iof:215,abatement:228,discount:241,interest:267,otherCredits:280}))if(patch[key]!==undefined)bytes=replaceField(bytes,2,position,String(patch[key]).padStart(13,'0'));
 return bytes;
}
async function importFile(f,bytes=source(f),extra={}){const body={profile_id:f.profile.id,expected_approval_version:1,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'FICTITIOUS_BANK_DOWNLOAD',...extra},ack=(await api('/files',body)).body;const event=(await api(`/files/${ack.id}/events`)).body.items[0];return{body,bytes,ack,event};}
const preview=async i=>(await api(`/events/${i.event.event_id}/preview`,{file_id:i.ack.id,line:i.event.line})).body;
const command=(i,p)=>({file_id:i.ack.id,line:i.event.line,command_id:randomUUID(),expected_approval_version:p.context.profile.approval_version,context_hash:p.context_hash,confirm:true});
const current=t=>rpc('erp_finance_get',{p_user_id:users.financeiro,p_entity:'titles',p_id:t});

 db=database??new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0024_cnab_human_review','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import','0042_cnab_operational','0043_cnab_operational_returns','0053_finance_transfers','0058_itau_net_credit'])await db.exec(await readFile(new URL(`../../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");for(const role of['admin','financeiro','consulta','vendas']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 today=await scalar("select(clock_timestamp()at time zone'America/Sao_Paulo')::date::text v");
 await rpc('erp_company_save_identity',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:0,p_data:{legal_name:'EMPRESA FICTICIA TESTE',cnpj:CNPJ,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}});
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PAGADOR SINTETICO',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']}})).record;


const category=async()=> (await native('category_save',{expected_version:0,name:'TARIFA FICTICIA',kind:'payable'})).record;
const selection=(i,c)=>({p_event_id:i.event.event_id,p_file_id:i.ack.id,p_line:i.event.line,p_fee_category_id:c.id,p_expected_fee_category_version:c.version});
const netPreview=(i,c)=>rpc('erp_cnab_itau_net_credit_preview',{p_user_id:users.financeiro,...selection(i,c)});
const netCommand=(i,c,p,command=randomUUID())=>({p_user_id:users.financeiro,...selection(i,c),p_expected_approval:1,p_command_id:command,p_context_hash:p.context_hash,p_confirm:true});
return {db,users,today,contact,objects,rpc,native,scalar,ports,prepare,source,importFile,preview,command,current,op,api,category,selection,netPreview,netCommand,close:()=>db.close()};
}
