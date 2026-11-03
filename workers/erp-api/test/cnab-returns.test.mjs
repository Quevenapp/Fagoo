import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{randomUUID}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';
import{parseCnabRoute,executeCnabRoute}from'../src/cnab.mjs';
import{parseCnabOperationalRoute,executeCnabOperationalRoute}from'../src/cnab-operational.mjs';
import{parseCnabReturnsRoute,executeCnabReturnsRoute}from'../src/cnab-returns.mjs';
import{PROFILES,CNPJ,returnFile,replaceField}from'../../../packages/cnab-core/test/fixtures.mjs';
import{ returnDetail as uiDetail,returnReadback as uiReadback,returnFiles as uiFiles,returnEvents as uiEvents }from'../../../apps/erp/src/lib/cnab-returns-model.ts';
let db,today,contact,ordinal=0;const users={},objects=new Map();
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
const state=code=>e=>e.code===code;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([k,v])=>['p_event_hashes','p_controls'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
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
function source(f,patch={},sequence='00001'){return returnFile({bank:f.snapshot.profile.bank,profile:f.snapshot.profile,generatedDate:day(today),fileSequence:sequence,events:[{control:f.bt.control,documentNumber:f.bt.documentNumber,ourNumber:f.bt.ourNumber??'00000000001',amount:f.bt.amountCents,paid:f.bt.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today),...patch}]});}
async function importFile(f,bytes=source(f),extra={}){const body={profile_id:f.profile.id,expected_approval_version:1,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'FICTITIOUS_BANK_DOWNLOAD',...extra},ack=(await api('/files',body)).body;const event=(await api(`/files/${ack.id}/events`)).body.items[0];return{body,bytes,ack,event};}
const preview=async i=>(await api(`/events/${i.event.event_id}/preview`,{file_id:i.ack.id,line:i.event.line})).body;
const command=(i,p)=>({file_id:i.ack.id,line:i.event.line,command_id:randomUUID(),expected_approval_version:p.context.profile.approval_version,context_hash:p.context_hash,confirm:true});
const current=t=>rpc('erp_finance_get',{p_user_id:users.financeiro,p_entity:'titles',p_id:t});
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0024_cnab_human_review','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import','0042_cnab_operational','0043_cnab_operational_returns'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");for(const role of['admin','financeiro','consulta','vendas']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 today=await scalar("select(clock_timestamp()at time zone'America/Sao_Paulo')::date::text v");
 await rpc('erp_company_save_identity',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:0,p_data:{legal_name:'EMPRESA FICTICIA TESTE',cnpj:CNPJ,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}});
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PAGADOR SINTETICO',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']}})).record;
});
after(()=>db?.close());
test('043 import and preview do not post; exact06 creates one payment/movement and current readback is separate',async()=>{
 const f=await prepare(),i=await importFile(f),before=await scalar('select count(*)::int v from erp_finance.settlement');
 const p=await preview(i);assert.equal(p.bytes_verified,true);assert.equal(p.context.settlement.allowed,true);assert.equal(p.context.binding.allowed,false);assert.equal(await scalar('select count(*)::int v from erp_finance.settlement'),before);
 assert.equal(uiDetail(p,{event_id:i.event.event_id,file_id:i.ack.id,line:2},true).context.event.paid_cents,'12345');assert.ok(uiFiles((await api('/files')).body).items.some(x=>x.id===i.ack.id));assert.equal(uiEvents((await api(`/files/${i.ack.id}/events`)).body,i.ack.id).items[0].event_id,i.event.event_id);
 const b=command(i,p),ack=(await api(`/events/${i.event.event_id}/settle`,b)).body;assert.equal(ack.financialMutationPerformed,true);assert.equal(ack.receipt.principal_cents,'12345');assert.equal(ack.receipt.account_id,f.account.id);
 const read=(await api(`/settlements/${b.command_id}`)).body;assert.equal(read.current_title.status,'paid');assert.equal(read.current_account.balance_cents,'12345');assert.equal(read.current_settlement.reversed,false);assert.equal(uiReadback(read,b.command_id,ack.receipt).current_title.status,'paid');
 assert.equal((await api(`/events/${i.event.event_id}/settle`,b)).body.replayed,true);assert.equal(await scalar('select count(*)::int v from erp_finance.settlement'),before+1);
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,{...b,command_id:randomUUID()}),state('40001'));
 const same=await api('/files',i.body);assert.equal(same.body.replayed,true);const duplicate=await importFile(f,source(f,{},'00002'));assert.equal(duplicate.ack.new_events,0);assert.equal(duplicate.ack.duplicate_events,1);assert.equal(duplicate.event.event_id,i.event.event_id);
 // SQL-only synthetic reversal proves immutable dedupe; no browser or real account is involved.
 await native('reverse',{id:f.title.id,expected_version:2,settlement_id:ack.receipt.settlement_id,posted_on:today,note:'ESTORNO SINTETICO DE REGRESSAO'});
 const after=(await api(`/settlements/${b.command_id}`)).body;assert.equal(after.current_title.status,'open');assert.equal(after.current_settlement.reversed,true);assert.deepEqual(after.receipt,ack.receipt);assert.equal(uiReadback(after,b.command_id,ack.receipt).current_settlement.reversed,true);
 assert.equal((await api(`/events/${i.event.event_id}/settle`,b)).body.replayed,true);const p2=await preview(duplicate);assert.ok(p2.context.settlement.issues.includes('OPERATIONAL_PAYMENT_ALREADY_APPLIED'));await assert.rejects(()=>api(`/events/${duplicate.event.event_id}/settle`,command(duplicate,p2)),state('40001'));
});
test('043 Inter112 registration needs explicit binding; payment cannot invent or duplicate a bank number',async()=>{
 const f=await prepare('inter'),paid=await importFile(f),before=await preview(paid);assert.equal(before.context.settlement.allowed,false);assert.ok(before.context.settlement.issues.includes('BANK_NUMBER_NOT_MATCHED'));
 const registration=await importFile(f,source(f,{occurrence:'02',paid:'0'},'00002')),p=await preview(registration);assert.equal(p.context.binding.allowed,true);assert.equal(uiDetail(p,{event_id:registration.event.event_id,file_id:registration.ack.id,line:2},true).context.binding.allowed,true);const b=command(registration,p),ack=(await api(`/events/${registration.event.event_id}/bind`,b)).body;
 assert.equal(ack.our_number,'00000000001');assert.equal((await api(`/events/${registration.event.event_id}/bind`,b)).body.replayed,true);assert.equal((await current(f.title.id)).record.status,'open');
 const ready=await preview(paid);assert.equal(ready.context.settlement.allowed,true);const pay=(await api(`/events/${paid.event.event_id}/settle`,command(paid,ready))).body;assert.equal(pay.receipt.principal_cents,'12345');
 await assert.rejects(()=>db.query("update erp_cnab.operational_binding set our_number='00000000002'where event_id=$1",[registration.event.event_id]),state('42501'));
});
test('043 account/title/context changes block confirmation, with all money and dates supplied by server',async()=>{
 const f=await prepare(),i=await importFile(f),p=await preview(i),b=command(i,p);await native('title_update',{id:f.title.id,expected_version:1,description:'NOVA DESCRICAO SINTETICA'});
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,b),state('40001'));assert.equal((await current(f.title.id)).record.status,'open');
 for(const extra of[{amount_cents:'12345'},{account_id:randomUUID()},{posted_on:today},{fee_cents:'1'},{purpose:'operational'},{confirm:false}])await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,{...b,...extra}),e=>e.status===400);
 const again=await preview(i);assert.equal(again.context.settlement.allowed,true);await native('account_save',{id:f.account.id,expected_version:1,name:f.account.name,kind:'bank',active:false});
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,command(i,again)),state('40001'));assert.ok((await preview(i)).context.settlement.issues.includes('BANK_ACCOUNT_UNAVAILABLE'));
});
test('043 differences, fees, partial and cancellation occurrences stay pending without ledger changes',async()=>{
 for(const patch of[{paid:'12344'},{fee:'1'},{occurrence:'07'},{occurrence:'09'},{creditDate:'000000'}]){const f=await prepare(),i=await importFile(f,source(f,patch)),p=await preview(i);assert.equal(p.context.settlement.allowed,false);await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,command(i,p)),state('40001'));assert.equal((await current(f.title.id)).record.status,'open');}
});
test('043 an audit failure after010 work rolls payment, movement, command and receipt back atomically',async()=>{
 const f=await prepare(),i=await importFile(f),p=await preview(i),b=command(i,p),count=await scalar('select count(*)::int v from erp_finance.settlement');
 await db.exec("create function public.test043_audit()returns trigger language plpgsql as $$begin if NEW.action='operational_settle'then raise exception 'SYNTHETIC_AUDIT_FAILURE';end if;return NEW;end$$;create trigger test043_audit before insert on erp_cnab.audit for each row execute function public.test043_audit()");
 try{await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,b),/SYNTHETIC_AUDIT_FAILURE/);assert.equal((await current(f.title.id)).record.version,1);assert.equal(await scalar('select count(*)::int v from erp_finance.settlement'),count);assert.equal(await scalar('select count(*)::int v from erp_finance.command where id=$1',[b.command_id]),0);assert.equal(await scalar('select count(*)::int v from erp_cnab.operational_settlement where command_id=$1',[b.command_id]),0);}finally{await db.exec('drop trigger test043_audit on erp_cnab.audit;drop function public.test043_audit()');}
 assert.equal((await api(`/events/${i.event.event_id}/settle`,b)).body.replayed,false);
});
test('043 files and permissions are rechecked; legacy routes cannot reach operational return evidence',async()=>{
 const f=await prepare(),i=await importFile(f),p=await preview(i),b=command(i,p);
 await assert.rejects(()=>api(`/events/${i.event.event_id}/preview`,{file_id:i.ack.id,line:2},{getFile:async()=>new Uint8Array([1])}),e=>e.code==='ERP_CNAB_RETURN_FILE_MISMATCH');
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,b,{userId:users.consulta}),state('42501'));await assert.rejects(()=>api('/files',undefined,{userId:users.vendas}),state('42501'));
 await assert.rejects(()=>legacy(`/files/return/${i.ack.id}`),state('P0002'));await assert.rejects(()=>legacy(`/returns/${i.ack.id}/review`),state('P0002'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.financeiro]);await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,b),state('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.financeiro]);
 await assert.rejects(()=>db.query("update erp_cnab.return_event set payload='{}'where id=$1",[i.event.event_id]),state('42501'));await assert.rejects(()=>db.query('delete from erp_cnab.return_occurrence where file_id=$1',[i.ack.id]),state('42501'));
 const file=await api(`/files/${i.ack.id}/download`);assert.deepEqual(file.bytes,i.bytes);assert.equal((await current(f.title.id)).record.status,'open');
});
test('043 a bank/account/beneficiary mismatch is rejected before private persistence',async()=>{
 const f=await prepare(),valid=source(f),count=await scalar('select count(*)::int v from erp_cnab.return_file'),stored=objects.size;
 for(const [pos,value]of[[24,'99999'],[4,'00000000000000'],[83,'110'],[94,'X']])
  await assert.rejects(()=>importFile(f,replaceField(valid,2,pos,value)),e=>e.status===400&&e.code.startsWith('CNAB_'));
 assert.equal(await scalar('select count(*)::int v from erp_cnab.return_file'),count);assert.equal(objects.size,stored);
});
test('043 prior manual payment remains a blocker after reversal; imported039 origins also need a separate future binding',async()=>{
 const f=await prepare(),i=await importFile(f),settled=await native('settle',{id:f.title.id,expected_version:1,account_id:f.account.id,posted_on:today,principal_cents:'12345'});
 await native('reverse',{id:f.title.id,expected_version:2,settlement_id:settled.settlement.id,posted_on:today,note:'ESTORNO SINTETICO'});
 const p=await preview(i);assert.ok(p.context.settlement.issues.includes('PRIOR_SETTLEMENT_HISTORY'));await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,command(i,p)),state('40001'));
 const g=await prepare(),j=await importFile(g),createCommand=await scalar("select id v from erp_finance.command where result->'items'->0->>'id'=$1",[g.title.id]);
 await db.query("insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence)values('receivables',$1,$2,$3,'{}')",[String(900000+ordinal),g.title.id,createCommand]);
 const q=await preview(j);assert.ok(q.context.settlement.issues.includes('LEGACY_BANK_BINDING_REQUIRED'));await assert.rejects(()=>api(`/events/${j.event.event_id}/settle`,command(j,q)),state('40001'));assert.equal((await current(g.title.id)).record.status,'open');
});
test('043 Inter112 cannot bind the same number to two titles, and cancellation/ambiguous amount cannot settle',async()=>{
 const f=await prepare('inter'),i=await importFile(f,source(f,{occurrence:'02',paid:'0'})),p=await preview(i);await api(`/events/${i.event.event_id}/bind`,command(i,p));
 const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:'SEGUNDO TITULO SINTETICO',issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];
 const b={command_id:randomUUID(),profile_id:f.profile.id,expected_version:2,expected_approval_version:1,generated_on:today,titles:[{title_id:title.id,expected_version:1,document_number:'SEGUNDO',payment_limit_days:30}],confirm_operational:false};
 const pre=(await op('/remittances/preview',b)).body,r=(await op('/remittances',{...b,confirm_operational:true,preview_hash:pre.preview_hash})).body;
 const s=await rpc('erp_cnab_operational_reservation',{p_user_id:users.admin,p_id:r.id,p_expected_approval:1}),g={...f,title,snapshot:s.snapshot,bt:s.snapshot.titles[0]};
 const j=await importFile(g,source(g,{occurrence:'02',paid:'0'},'00002')),q=await preview(j);assert.ok(q.context.binding.issues.includes('BANK_NUMBER_ALREADY_USED'));await assert.rejects(()=>api(`/events/${j.event.event_id}/bind`,command(j,q)),state('40001'));
 for(const patch of[{occurrence:'07',paid:'0',creditDate:'000000'},{paid:'12500'}]){
  const next=await importFile(f,source(f,patch,'00003')),review=await preview(next);assert.equal(review.context.settlement.allowed,false);
  assert.ok(review.context.settlement.issues.includes(patch.occurrence?'EXACT_PAYMENT_06_REQUIRED':'TRAILER_AGGREGATE_AMBIGUOUS'));assert.equal((await current(f.title.id)).record.status,'open');
 }
});
test('043 future or pre-issue dates and missing exact references never create a payment',async()=>{
 const next=await scalar("select((clock_timestamp()at time zone'America/Sao_Paulo')::date+1)::text v"),prior=await scalar("select((clock_timestamp()at time zone'America/Sao_Paulo')::date-1)::text v");
 for(const patch of[{occurrenceDate:day(next),creditDate:day(next)},{occurrenceDate:day(prior),creditDate:day(prior)},{control:'UNKNOWN-CONTROL'},{documentNumber:'UNKNOWN'}]){
  const f=await prepare(),i=await importFile(f,source(f,patch)),p=await preview(i);assert.equal(p.context.settlement.allowed,false);
  await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,command(i,p)),state('40001'));assert.equal((await current(f.title.id)).record.version,1);
 }
});
test('043 authorization is rechecked after bytes and receipt stays readable after disaorigin the profile',async()=>{
 const f=await prepare(),i=await importFile(f),p=await preview(i),b=command(i,p);let changed=false;
 await assert.rejects(()=>api(`/events/${i.event.event_id}/preview`,{file_id:i.ack.id,line:2},{getFile:async args=>{const data=await getFile(args);if(!changed){changed=true;await native('title_update',{id:f.title.id,expected_version:1,description:'ALTERACAO DURANTE LEITURA'});}return data;}}),e=>e.code==='ERP_CNAB_RETURN_CONTEXT_CHANGED');
 const ready=await preview(i),body=command(i,ready);await api(`/events/${i.event.event_id}/settle`,body);
 await op(`/profiles/${f.profile.id}/approval`,{command_id:randomUUID(),expected_approval_version:1,expected_profile_version:2,expected_identity_version:1,enabled:false,confirmed_on:today,reference:'SYNTHETIC DISABLE'},{userId:users.admin});
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,body),state('40001'));
 assert.equal((await api(`/settlements/${body.command_id}`)).body.current_title.status,'paid');
 await assert.rejects(()=>api(`/files/${i.ack.id}/download`),state('40001'));
 await op(`/profiles/${f.profile.id}/approval`,{command_id:randomUUID(),expected_approval_version:2,expected_profile_version:2,expected_identity_version:1,enabled:true,confirmed_on:today,reference:'SYNTHETIC RECONFIRM'},{userId:users.admin});
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,body),state('40001'));const renewed=await preview(i);assert.ok(renewed.context.settlement.issues.includes('OPERATIONAL_PAYMENT_ALREADY_APPLIED'));
 assert.equal((await api(`/settlements/${body.command_id}`)).body.receipt.command_id,body.command_id);
});
test('043 command collision, wrong proof and changed ACK identity are rejected without a second effect',async()=>{
 const f=await prepare(),i=await importFile(f),p=await preview(i),b=command(i,p),existing=await scalar('select id v from erp_finance.command limit 1');
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,{...b,command_id:existing}),state('40001'));
 await assert.rejects(()=>api(`/events/${i.event.event_id}/preview`,{file_id:randomUUID(),line:2}),state('P0002'));
 const ack=(await api(`/events/${i.event.event_id}/settle`,b)).body;
 for(const patch of[{account_id:randomUUID()},{title_id:randomUUID()},{principal_cents:'1',net_cash_cents:'1'},{file_hash:'0'.repeat(64)}])
  await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,b,{rpc:async(name,args)=>name==='erp_cnab_operational_settle'?{...ack,receipt:{...ack.receipt,...patch}}:rpc(name,args)}),e=>e.code==='ERP_CNAB_RETURN_INVALID_RESPONSE');
 assert.equal(await scalar('select count(*)::int v from erp_cnab.operational_settlement where title_id=$1',[f.title.id]),1);
});
test('043 empty and repeated-event files have bounded pagination and strict projected identities',async()=>{
 const f=await prepare('inter'),empty=returnFile({bank:'077',profile:f.snapshot.profile,generatedDate:day(today),events:[]});
 const body={profile_id:f.profile.id,expected_approval_version:1,command_id:randomUUID(),file_base64:Buffer.from(empty).toString('base64'),obtained_from_bank:true,reference_id:'SYNTHETIC_EMPTY'},ack=(await api('/files',body)).body;
 const blank=(await api(`/files/${ack.id}/events`)).body;assert.deepEqual(blank.items,[]);assert.equal(blank.has_more,false);
 await assert.rejects(()=>api(`/files/${ack.id}/events`,undefined,{rpc:async(name,args)=>name==='erp_cnab_operational_events'?{...blank,file_id:randomUUID()}:rpc(name,args)}),e=>e.code==='ERP_CNAB_RETURN_INVALID_RESPONSE');
 const e={control:f.bt.control,documentNumber:f.bt.documentNumber,ourNumber:'00000000001',amount:'12345',paid:'0',occurrence:'02',dueDate:day(today),occurrenceDate:day(today),creditDate:'000000'};
 const twice=await importFile(f,returnFile({bank:'077',profile:f.snapshot.profile,generatedDate:day(today),events:[e,e]}));assert.equal(twice.ack.new_events,1);assert.equal(twice.ack.duplicate_events,1);
 const first=(await api(`/files/${twice.ack.id}/events?limit=1`)).body,last=(await api(`/files/${twice.ack.id}/events?limit=1&after=${first.next_cursor}`)).body;
 assert.equal(first.items[0].event_id,last.items[0].event_id);assert.equal(last.items[0].duplicate,true);assert.equal(last.has_more,false);
 assert.doesNotMatch(JSON.stringify(first),/payer|cnpj|object_path|payload|accountDigit/);
});
test('043 private tables/functions have no browser grants and readonly readers cannot invoke proof or writes',async()=>{
 for(const table of['operational_binding','operational_settlement']){
  assert.equal(await scalar('select relrowsecurity v from pg_class where oid=$1::regclass',['erp_cnab.'+table]),true);
  for(const role of['anon','authenticated','service_role'])assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')v",[role,'erp_cnab.'+table]),false);
 }
 const names=(await db.query("select oid::regprocedure::text name from pg_proc where proname in('erp_cnab_operational_return_profile','erp_cnab_operational_return_commit','erp_cnab_operational_event','erp_cnab_operational_return_verify','erp_cnab_operational_bind','erp_cnab_operational_settle','erp_cnab_operational_settlement_get','erp_cnab_operational_events','erp_cnab_operational_return_file')")).rows;
 for(const f of names){assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')v",[f.name]),true);for(const role of['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,f.name]),false);}
 const f=await prepare(),i=await importFile(f);assert.equal((await api(`/events/${i.event.event_id}?file_id=${i.ack.id}&line=2`,undefined,{userId:users.consulta})).body.bytes_verified,false);
 await assert.rejects(()=>api(`/events/${i.event.event_id}/preview`,{file_id:i.ack.id,line:2},{userId:users.consulta}),state('42501'));
});
test('043 homologation evidence cannot be promoted, read or applied by operational endpoints',async()=>{
 const f=await prepare(),data=source(f,{control:'HOMO-UNMATCHED',documentNumber:'HOMO'}),old=(await legacy('/returns',{profile_id:f.profile.id,command_id:randomUUID(),file_base64:Buffer.from(data).toString('base64'),obtained_from_bank:true,reference_id:'FICTITIOUS_HOMO'})).body;
 const event=await scalar('select event_id v from erp_cnab.return_occurrence where file_id=$1',[old.id]),count=await scalar('select count(*)::int v from erp_cnab.return_file');
 await assert.rejects(()=>importFile(f,data),state('40001'));assert.equal(await scalar('select count(*)::int v from erp_cnab.return_file'),count);
 for(const path of[`/files/${old.id}/events`,`/files/${old.id}/download`,`/events/${event}?file_id=${old.id}&line=2`])await assert.rejects(()=>api(path),state('P0002'));
 await assert.rejects(()=>api(`/events/${event}/preview`,{file_id:old.id,line:2}),state('P0002'));
});
test('043 upload or post-storage failure leaves no file/event command, and retry keeps the original identity',async()=>{
 const f=await prepare(),data=source(f),body={profile_id:f.profile.id,expected_approval_version:1,command_id:randomUUID(),file_base64:Buffer.from(data).toString('base64'),obtained_from_bank:true,reference_id:'SYNTHETIC_RETRY'},count=await scalar('select count(*)::int v from erp_cnab.return_file');
 await assert.rejects(()=>api('/files',body,{storeFile:async()=>{throw new Error('SYNTHETIC_STORAGE_FAILURE');}}),/SYNTHETIC_STORAGE_FAILURE/);
 await assert.rejects(()=>api('/files',body,{getFile:async()=>new Uint8Array([1])}),e=>e.code==='ERP_CNAB_RETURN_FILE_MISMATCH');
 assert.equal(await scalar('select count(*)::int v from erp_cnab.return_file'),count);assert.equal(await scalar('select count(*)::int v from erp_cnab.command where id=$1',[body.command_id]),0);
 const ack=(await api('/files',body)).body;assert.equal((await api('/files',body)).body.id,ack.id);assert.equal(await scalar('select count(*)::int v from erp_cnab.return_file'),count+1);assert.equal((await current(f.title.id)).record.version,1);
});
test('043 a changed native principal cannot reinterpret the immutable original bank remittance',async()=>{
 const f=await prepare();await native('title_update',{id:f.title.id,expected_version:1,amount_cents:'23456'});
 const i=await importFile(f,source(f,{amount:'23456',paid:'23456'})),p=await preview(i);
 assert.equal(p.context.title.amount_cents,'23456');assert.equal(p.context.event.amount_cents,'23456');
 assert.ok(p.context.settlement.issues.includes('REMITTANCE_SNAPSHOT_DIFFERS'));assert.equal(p.context.settlement.allowed,false);
 await assert.rejects(()=>api(`/events/${i.event.event_id}/settle`,command(i,p)),state('40001'));assert.equal((await current(f.title.id)).record.status,'open');
});
