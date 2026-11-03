import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{randomUUID}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';
import{parseCnabRoute,executeCnabRoute}from'../src/cnab.mjs';
import{parseCnabOperationalRoute,executeCnabOperationalRoute}from'../src/cnab-operational.mjs';
import{PROFILES,CNPJ,returnFile}from'../../../packages/cnab-core/test/fixtures.mjs';
import{generateRemittance,generateOperationalRemittance}from'../../../packages/cnab-core/src/index.mjs';
import{parseCnabReviewRoute,executeCnabReviewRoute}from'../src/cnab-review.mjs';
let db,today,contact,profile,firstBody,firstAck,approvalBody;const users={},objects=new Map();let ordinal=0;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
const state=code=>error=>error.code===code;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,pairs.map(([k,v])=>k==='p_event_hashes'||k==='p_controls'?v:v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const native=(action,data)=>rpc('erp_finance_execute',{p_user_id:users.financeiro,p_command_id:randomUUID(),p_action:action,p_data:data});
async function storeFile({bucket,path,bytes,upsert}){assert.equal(bucket,'brufap-cnab');assert.equal(upsert,false);const key=bucket+'/'+path;if(objects.has(key))return;objects.set(key,bytes.slice());await db.query('insert into storage.objects values($1,$2,$3)',[bucket,path,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);}
const getFile=async({bucket,path})=>objects.get(bucket+'/'+path)?.slice()||new Response(null,{status:404});
const ports=extra=>({userId:users.financeiro,rpc,storeFile,getFile,...extra});
function request(path,body){return new Request('https://test.invalid'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});}
const api=async(path,body,extra)=>executeCnabOperationalRoute(await parseCnabOperationalRoute(request('/v1/cobranca-operacional'+path,body)),ports(extra));
const legacy=async(path,body,extra)=>executeCnabRoute(await parseCnabRoute(request('/v1/cnab'+path,body)),ports(extra));
const human=async(path,body,extra)=>executeCnabReviewRoute(await parseCnabReviewRoute(request('/v1/conferencia-retornos'+path,body)),ports(extra));
const company=()=>scalar('select(select version from erp_company.identity where singleton)v');
async function newProfile(bank='itau'){
 const account=(await native('account_save',{expected_version:0,name:'CONTA SINTETICA '+(++ordinal),kind:'bank'})).record,{accountId,...base}=PROFILES[bank];
 const data={...base,account:bank==='itau'?String(12345+ordinal):String(123456+ordinal).padStart(9,'0'),account_id:account.id,ourNumberStart:bank==='itau'?'00000001':null,remittanceSequenceStart:'1'};
 return(await legacy('/profiles',{expected_version:0,command_id:randomUUID(),data},{userId:users.admin})).body.profile;
}
async function current(id){return(await api('/profiles')).body.items.find(x=>x.profile.id===id);}
async function approval(id,enabled=true,extra={}){const s=await current(id),body={command_id:randomUUID(),expected_approval_version:s.approval.approval_version,expected_profile_version:s.profile.version,expected_identity_version:await company()??null,enabled,confirmed_on:today,reference:'DECLARACAO SINTETICA SEM EVIDENCIA BANCARIA',...extra};return{body,result:await api(`/profiles/${id}/approval`,body,{userId:users.admin})};}
async function title(){return(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:'TITULO FICTICIO',issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];}
const previewBody=b=>{const{preview_hash,...v}=b;return{...v,confirm_operational:false};};
async function generation(id){const s=await current(id),t=await title(),b={command_id:randomUUID(),profile_id:id,expected_version:s.profile.version,expected_approval_version:s.approval.approval_version||1,generated_on:today,confirm_operational:true,titles:[{title_id:t.id,expected_version:t.version,document_number:'T'+String(++ordinal).padStart(8,'0'),...(s.profile.bank==='077'?{payment_limit_days:30}:{})}]};return{...b,preview_hash:s.approval.effective_enabled?(await api('/remittances/preview',previewBody(b))).body.preview_hash:'a'.repeat(64)};}
const financeDigest=()=>scalar("select md5(jsonb_build_object('titles',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.title t),'settlements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.settlement t),'movements',(select jsonb_agg(to_jsonb(t)order by id)from erp_finance.movement t))::text)v");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0024_cnab_human_review','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import','0042_cnab_operational'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 await db.exec("insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");
 for(const role of['admin','financeiro','consulta','vendas']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 today=await scalar("select(clock_timestamp()at time zone'America/Sao_Paulo')::date::text v");
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PAGADOR SINTETICO',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']}})).record;
});
after(()=>db?.close());
test('042 missing identity and approval block operational use; admin approval cannot be supplied by finance',async()=>{
 profile=await newProfile();const status=(await current(profile.id)).approval;assert.equal(status.effective_enabled,false);assert.ok(status.issues.includes('COMPANY_IDENTITY_MISSING'));
 await assert.rejects(()=>api('/remittances',generationBodyPlaceholder()),state('40001'));
 function generationBodyPlaceholder(){return{command_id:randomUUID(),profile_id:profile.id,expected_version:1,expected_approval_version:1,generated_on:today,confirm_operational:true,preview_hash:'a'.repeat(64),titles:[{title_id:randomUUID(),expected_version:1,document_number:'TESTE'}]};}
 await assert.rejects(()=>approval(profile.id),state('40001'));
 await rpc('erp_company_save_identity',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:0,p_data:{legal_name:'EMPRESA FICTICIA TESTE',cnpj:CNPJ,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}});
 const value=await approval(profile.id);approvalBody=value.body;assert.equal(value.result.body.approval.effective_enabled,true);
 await assert.rejects(()=>api(`/profiles/${profile.id}/approval`,approvalBody),state('42501'));
 await assert.rejects(()=>api('/profiles',undefined,{userId:users.vendas}),state('42501'));
});
test('042 preview is read-only, actual generation is explicit, exact and never settles a title',async()=>{
 firstBody=await generation(profile.id);const nativeBefore=await financeDigest(),before=await scalar('select count(*)::int v from erp_cnab.audit');
 const preview=(await api('/remittances/preview',previewBody(firstBody))).body;assert.equal(preview.total_cents,'12345');assert.equal(preview.persisted,false);assert.equal(preview.preview_hash,firstBody.preview_hash);assert.equal(preview.items[0].payer.document_mask,'*******8909');assert.equal((await current(profile.id)).profile.next_sequence,'1');assert.equal(await scalar('select count(*)::int v from erp_cnab.audit'),before);
 firstAck=(await api('/remittances',firstBody)).body;assert.equal(firstAck.state,'ready');assert.equal(firstAck.filename,'ITAU_COBRANCA_0000001.REM');assert.equal(firstAck.purpose,'operational');assert.equal(firstAck.bankTransmissionPerformed,false);assert.equal(await financeDigest(),nativeBefore);
 const replay=(await api('/remittances',firstBody)).body;assert.equal(replay.id,firstAck.id);assert.equal(replay.replayed,true);assert.equal((await current(profile.id)).profile.next_sequence,'2');
 const downloaded=await api(`/files/remittance/${firstAck.id}`,undefined,{userId:users.consulta});assert.equal(downloaded.bytes.length,1206);
 const r=await rpc('erp_cnab_operational_reservation',{p_user_id:users.admin,p_id:firstAck.id,p_expected_approval:1});assert.equal(r.snapshot.titles[0].ourNumber,'00000001');
 await assert.rejects(()=>generateRemittance(r.snapshot),e=>e.code==='CNAB_PRODUCTION_GENERATION_UNAVAILABLE');assert.equal((await generateOperationalRemittance(r.snapshot)).fileHash,firstAck.file_hash);
});
test('042 homologation and operational paths share counters but never expose each other artifacts',async()=>{
 const body=await generation(profile.id),{expected_approval_version,confirm_operational,preview_hash,...homologation}=body,h=(await legacy('/remittances',homologation)).body;
 assert.equal(h.sequence,'2');const op=(await api('/remittances',await generation(profile.id))).body;assert.equal(op.sequence,'3');assert.equal((await current(profile.id)).profile.next_sequence,'4');
 assert.equal((await current(profile.id)).approval.effective_enabled,true);
 const homoList=(await legacy('/remittances')).body.items,opList=(await api('/remittances')).body.items;assert.ok(homoList.some(x=>x.id===h.id));assert.ok(!homoList.some(x=>x.id===op.id));assert.ok(!opList.some(x=>x.id===h.id));
 for(const id of[firstAck.id,op.id]){await assert.rejects(()=>legacy(`/files/remittance/${id}`),state('P0002'));await assert.rejects(()=>legacy(`/remittances/${id}/resume`,{}),state('P0002'));await assert.rejects(()=>rpc('erp_cnab_finalize',{p_user_id:users.admin,p_command_id:randomUUID(),p_id:id,p_hash:'a'.repeat(64),p_size:1206,p_path:'x',p_manifest:[]}),state('P0002'));}
 await assert.rejects(()=>api(`/remittances/${h.id}/resume`,{expected_approval_version:1}),state('P0002'));await assert.rejects(()=>api(`/files/remittance/${h.id}`),state('P0002'));
 await assert.rejects(()=>db.query("update erp_cnab.remittance set purpose='homologation'where id=$1",[op.id]),state('40001'));
 await assert.rejects(()=>legacy('/remittances',{...firstBody,purpose:'operational'}),e=>e.status===400);
});
test('042 uncertain upload consumes counters once; revoke and reconfirm require current approval before resume',async()=>{
 const b=await generation(profile.id),before=BigInt((await current(profile.id)).profile.next_sequence);await assert.rejects(()=>api('/remittances',b,{storeFile:async()=>{throw new Error('synthetic interruption');}}),/synthetic interruption/);
 const id=await scalar('select remittance_id v from erp_cnab.billing_title where title_id=$1',[b.titles[0].title_id]);assert.equal((await current(profile.id)).profile.next_sequence,(before+1n).toString());
 await approval(profile.id,false);await assert.rejects(()=>api('/remittances',b),state('40001'));await assert.rejects(()=>api(`/remittances/${id}/resume`,{expected_approval_version:1}),state('40001'));await assert.rejects(()=>api(`/files/remittance/${firstAck.id}`),state('40001'));
 assert.equal((await api(`/profiles/${profile.id}/approval`,approvalBody,{userId:users.admin})).body.replayed,true);assert.equal((await current(profile.id)).approval.effective_enabled,false);
 await approval(profile.id,true);await assert.rejects(()=>api('/remittances',b),state('40001'));await assert.rejects(()=>api(`/remittances/${id}/resume`,{expected_approval_version:1}),state('40001'));
 const resumed=(await api(`/remittances/${id}/resume`,{expected_approval_version:3})).body;assert.equal(resumed.id,id);assert.equal(resumed.state,'ready');assert.equal((await current(profile.id)).profile.next_sequence,(before+1n).toString());
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.financeiro]);await assert.rejects(()=>api(`/remittances/${id}/resume`,{expected_approval_version:3}),state('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.financeiro]);
});
test('042 download rechecks authority after bytes and rejects corruption or approval races',async()=>{
 await assert.rejects(()=>api(`/files/remittance/${firstAck.id}`,undefined,{getFile:async()=>new Uint8Array([1])}),e=>e.code==='ERP_CNAB_STORED_FILE_MISMATCH');
 await assert.rejects(()=>api(`/files/remittance/${firstAck.id}`,undefined,{getFile:async args=>{const bytes=await getFile(args);await approval(profile.id,false);return bytes;}}),state('40001'));await approval(profile.id,true);
 await assert.rejects(()=>rpc('erp_cnab_operational_finalize',{p_user_id:users.admin,p_id:firstAck.id,p_command_id:randomUUID(),p_hash:firstAck.file_hash,p_size:firstAck.byte_size,p_path:'x',p_manifest:[],p_expected_approval:null}),state('22023'));
});
test('042 identity/config changes invalidate clearance and captured files; counters do not',async()=>{
 const data=await scalar('select data v from erp_company.identity where singleton');await rpc('erp_company_save_identity',{p_user_id:users.admin,p_command_id:randomUUID(),p_expected_version:1,p_data:{...data,trade_name:'EMPRESA FICTICIA ATUALIZADA'}});
 assert.ok((await current(profile.id)).approval.issues.includes('OPERATIONAL_APPROVAL_STALE'));await assert.rejects(()=>api(`/files/remittance/${firstAck.id}`),state('40001'));await approval(profile.id,true);
 await assert.rejects(()=>api(`/files/remittance/${firstAck.id}`),state('40001'));
 const s=await current(profile.id);await rpc('erp_cnab_approve',{p_user_id:users.admin,p_id:profile.id,p_expected_version:s.profile.version,p_command_id:randomUUID(),p_data:{contract_verified:false,policy_verified:true,reference:'SYNTHETIC CHANGE'}});
 assert.ok((await current(profile.id)).approval.issues.includes('BANK_CONTRACT_OR_POLICY_PENDING'));await assert.rejects(()=>api('/remittances/preview',previewBody(generationFallback())),state('40001'));
 function generationFallback(){return{...firstBody,command_id:randomUUID(),expected_version:s.profile.version+1,expected_approval_version:s.approval.approval_version};}
});
test('042 Inter112 remains bank-assigned and requires its own explicit operational approval',async()=>{
 const inter=await newProfile('inter');await approval(inter.id,true);const b=await generation(inter.id),r=(await api('/remittances',b)).body;assert.equal(r.filename,'CI400_001_0000001.REM');const snap=await rpc('erp_cnab_operational_reservation',{p_user_id:users.admin,p_id:r.id,p_expected_approval:1});assert.equal(snap.snapshot.titles[0].ourNumber,undefined);assert.equal(await scalar('select our_number v from erp_cnab.billing_title where title_id=$1',[b.titles[0].title_id]),null);
});
test('042 039 origins cannot preview or reserve a new boleto until legacy binding exists',async()=>{
 const p=await newProfile();await approval(p.id);const b=await generation(p.id),t=b.titles[0].title_id,command=await scalar("select id v from erp_finance.command where result->'items'->0->>'id'=$1",[t]);
 await db.query("insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence)values('receivables','999990042',$1,$2,'{}')",[t,command]);
 await assert.rejects(()=>api('/remittances/preview',previewBody(b)),state('40001'));await assert.rejects(()=>api('/remittances',b),state('40001'));assert.equal((await current(p.id)).profile.next_sequence,'1');
});
test('042 legacy return import rejects operational title controls before any return persistence',async()=>{
 const p=await newProfile();await approval(p.id);const ack=(await api('/remittances',await generation(p.id))).body,snap=await rpc('erp_cnab_operational_reservation',{p_user_id:users.admin,p_id:ack.id,p_expected_approval:1}),bt=snap.snapshot.titles[0],day=x=>x.slice(8,10)+x.slice(5,7)+x.slice(2,4);
 const bytes=returnFile({profile:snap.snapshot.profile,generatedDate:day(today),events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:bt.ourNumber,amount:bt.amountCents,paid:bt.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]});
 const before=await scalar('select count(*)::int v from erp_cnab.return_file');await assert.rejects(()=>legacy('/returns',{profile_id:p.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'SYNTHETIC'}),state('40001'));assert.equal(await scalar('select count(*)::int v from erp_cnab.return_file'),before);
});
test('042 private tables/functions stay service-only; safe lists omit raw banking identity and payer',async()=>{
 const tables=(await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_cnab'and c.relkind='r'")).rows;assert.ok(tables.every(t=>t.relrowsecurity));
 for(const role of['anon','authenticated','service_role'])for(const t of tables)assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')v",[role,'erp_cnab.'+t.relname]),false);
 const functions=(await db.query("select oid::regprocedure::text name from pg_proc where proname like 'erp_cnab_operational_%'")).rows;for(const f of functions){assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')v",[f.name]),true);for(const role of['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')v",[role,f.name]),false);}
 assert.doesNotMatch(JSON.stringify((await api('/profiles')).body),/"cnpj"|"agency"|"accountDigit"|"payer"|"snapshot"|"object_path"/);
});
test('042 legacy human-review flow still works for homologation while every legacy read rejects operational evidence',async()=>{
 const p=await newProfile(),b=await generation(p.id),{expected_approval_version,confirm_operational,preview_hash,...h}=b,ack=(await legacy('/remittances',h)).body;
 const snap=await rpc('erp_cnab_reservation',{p_user_id:users.admin,p_id:ack.id}),bt=snap.snapshot.titles[0],day=x=>x.slice(8,10)+x.slice(5,7)+x.slice(2,4);
 const bytes=returnFile({profile:snap.snapshot.profile,generatedDate:day(today),events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:bt.ourNumber,amount:bt.amountCents,paid:bt.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]});
 const imported=(await legacy('/returns',{profile_id:p.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'FICTITIOUS_REVIEW'})).body;
 // SQL 246: the homologation import keeps the Nº Retorno (sequence of the .RET) in the evidence too.
 assert.equal(await scalar("select evidence->>'fileSequence' v from erp_cnab.return_file where id=$1",[imported.id]),'00001');
 const event=(await human(`/files/${imported.id}`)).items[0].event_id,detail=await human(`/events/${event}?file_id=${imported.id}&line=2`);
 const reviewBody={file_id:imported.id,line:2,command_id:randomUUID(),expected_review_version:0,expected_context_hash:detail.context_hash,status:'confirmed',reason:'Conferência fictícia de homologação.'};
 assert.equal((await human(`/events/${event}/review`,reviewBody)).record.status,'confirmed');
 assert.equal((await human(`/events/${event}/review`,reviewBody)).replayed,true);
 assert.equal((await legacy(`/files/return/${imported.id}`)).bytes.length,bytes.length);
 // Owner-only synthetic fixture represents future043 evidence, never an operational bank import.
 const file=randomUUID(),opEvent=randomUUID(),hash='d'.repeat(64),eventHash='e'.repeat(64);
 await db.query("insert into erp_cnab.return_file(id,profile_id,file_hash,object_path,byte_size,generated_on,century,record_count,warnings,evidence,actor,purpose)values($1,$2,$3,$4,1206,$5,2000,3,'[]','{}',$6,'operational')",[file,p.id,hash,`profiles/${p.id}/returns/${hash}.ret`,today,users.admin]);
 await db.query("insert into erp_cnab.return_event(id,profile_id,event_hash,payload,proposed_action,reason,purpose)values($1,$2,$3,'{}','REVIEW','SYNTHETIC_ONLY','operational')",[opEvent,p.id,eventHash]);
 await db.query("insert into erp_cnab.return_occurrence values($1,2,$2,$3,false)",[file,opEvent,'f'.repeat(64)]);
 const deny=[['erp_cnab_file',{p_kind:'return',p_id:file}],['erp_cnab_review',{p_file_id:file,p_limit:25,p_after:1}],['erp_cnab_human_review_get',{p_event_id:opEvent,p_file_id:file,p_line:2}],['erp_cnab_human_review_verify',{p_event_id:opEvent,p_file_id:file,p_line:2}],['erp_cnab_human_review_list',{p_file_id:file,p_limit:25,p_after:1}],['erp_cnab_human_review_history',{p_event_id:opEvent,p_limit:25,p_before:null}],['erp_cnab_human_review_save',{p_event_id:opEvent,p_file_id:file,p_line:2,p_command_id:randomUUID(),p_expected_review_version:0,p_expected_context_hash:'a'.repeat(64),p_status:'confirmed',p_reason:'SYNTHETIC'}]];
 for(const[name,args]of deny)await assert.rejects(()=>rpc(name,{p_user_id:users.admin,...args}),state('P0002'),name);
 assert.ok(!(await legacy('/returns')).body.items.some(x=>x.id===file));
 await assert.rejects(()=>rpc('erp_cnab_return_context',{p_user_id:users.admin,p_profile_id:p.id,p_file_hash:hash,p_event_hashes:[],p_controls:[]}),state('40001'));
 await assert.rejects(()=>rpc('erp_cnab_return_commit',{p_user_id:users.admin,p_command_id:randomUUID(),p_profile_id:p.id,p_file:{hash,size:1206,path:'x',generated_on:today,century:2000,record_count:2,warnings:[],evidence:{}},p_events:[],p_decisions:[]}),state('40001'));
 await assert.rejects(()=>db.query("update erp_cnab.return_file set purpose='homologation'where id=$1",[file]),state('40001'));await assert.rejects(()=>db.query("update erp_cnab.return_event set purpose='homologation'where id=$1",[opEvent]),state('40001'));
 await assert.rejects(()=>db.query('insert into erp_cnab.return_occurrence values($1,3,$2,$3,false)',[imported.id,opEvent,'f'.repeat(64)]),state('40001'));
 assert.equal(await scalar('select count(*)::int v from erp_finance.settlement'),0);assert.equal(await scalar('select count(*)::int v from erp_finance.movement'),0);
});
test('042 HTTP refuses purpose tampering, unsupported return writes, missing approval CAS and changed acknowledgement identity',async()=>{
 const p=await newProfile();await approval(p.id);const b=await generation(p.id);
 for(const bad of[{...b,purpose:'operational'},{...b,confirm_operational:false},{...b,expected_approval_version:null},{...b,titles:[...b.titles,b.titles[0]]},{...b,generated_on:'2026-02-30'}])await assert.rejects(()=>api('/remittances',bad),e=>e.status===400);
 await assert.rejects(()=>parseCnabOperationalRoute(new Request('https://test.invalid/v1/cobranca-operacional/returns',{method:'POST'})),e=>e.status===405);
 await assert.rejects(()=>api(`/remittances/${randomUUID()}/resume`,{}),e=>e.status===400);
 await assert.rejects(()=>api('/profiles?secret=1'),e=>e.status===404);
 const ack=(await api('/remittances',b)).body;
 await assert.rejects(()=>api('/remittances',b,{rpc:async(name,args)=>{const v=await rpc(name,args);return name==='erp_cnab_operational_finalize'?{...v,id:randomUUID()}:v;}}),e=>e.code==='ERP_CNAB_OPERATIONAL_INVALID_RESPONSE');
 assert.equal((await api('/remittances',b)).body.id,ack.id);
});
test('042 preview hash binds payer revisions and exact contents; stale confirmation rolls every reservation back',async()=>{
 const p=await newProfile();await approval(p.id);const b=await generation(p.id),before=await scalar('select count(*)::int v from erp_cnab.command');
 await db.query("update erp_catalog.record set name='PAGADOR FICTICIO REVISADO',version=version+1 where id=$1",[contact.id]);
 await assert.rejects(()=>api('/remittances',b),e=>e.code==='40001'&&e.message==='erp_cnab_operational_preview_changed');
 assert.equal((await current(p.id)).profile.next_sequence,'1');assert.equal(await scalar('select count(*)::int v from erp_cnab.command'),before);assert.equal(await scalar('select count(*)::int v from erp_cnab.billing_title where title_id=$1',[b.titles[0].title_id]),0);
 const revised=(await api('/remittances/preview',previewBody(b))).body;assert.notEqual(revised.preview_hash,b.preview_hash);assert.equal(revised.items[0].payer.name,'PAGADOR FICTICIO REVISADO');
 await assert.rejects(()=>api('/remittances/preview',previewBody(b),{rpc:async(name,args)=>{const v=await rpc(name,args);if(name==='erp_cnab_operational_reserve')v.preview_items[0].title.payer.name='OTHER FICTITIOUS PAYER';return v;}}),e=>e.code==='ERP_CNAB_OPERATIONAL_INVALID_RESPONSE');
 const ack=(await api('/remittances',{...b,preview_hash:revised.preview_hash})).body;assert.equal(ack.state,'ready');
 await assert.rejects(()=>api('/remittances',{...b,preview_hash:'a'.repeat(64)}),state('40001'));
});
test('042 finalization rejects a revocation during storage, and explicit current authorization resumes the same reserved sequence',async()=>{
 const p=await newProfile();await approval(p.id);const b=await generation(p.id);
 await assert.rejects(()=>api('/remittances',b,{storeFile:async input=>{await storeFile(input);await approval(p.id,false);}}),state('40001'));
 const id=await scalar('select remittance_id v from erp_cnab.billing_title where title_id=$1',[b.titles[0].title_id]);assert.equal(await scalar('select state v from erp_cnab.remittance where id=$1',[id]),'reserved');
 await approval(p.id,true);assert.equal((await api(`/remittances/${id}/resume`,{expected_approval_version:3})).body.state,'ready');assert.equal((await current(p.id)).profile.next_sequence,'2');
});
test('042 approval audit failure is atomic and cannot leave an enabled head or reusable partial command',async()=>{
 const p=await newProfile(),count=await scalar('select count(*)::int v from erp_cnab.command');
 await db.exec("create function public.test042_reject_audit()returns trigger language plpgsql as $$begin if NEW.action='operational_approve'then raise exception 'SYNTHETIC_AUDIT_FAILURE';end if;return NEW;end$$;create trigger test042_audit before insert on erp_cnab.audit for each row execute function public.test042_reject_audit()");
 try{await assert.rejects(()=>approval(p.id),/SYNTHETIC_AUDIT_FAILURE/);assert.equal((await current(p.id)).approval.approval_version,0);assert.equal(await scalar('select count(*)::int v from erp_cnab.command'),count);assert.equal(await scalar('select count(*)::int v from erp_cnab.operational_approval_revision where profile_id=$1',[p.id]),0);}finally{await db.exec('drop trigger test042_audit on erp_cnab.audit;drop function public.test042_reject_audit()');}
 assert.equal((await approval(p.id)).result.body.approval.approval_version,1);
});
test('042 Unicode whitespace cannot stand in for a bank authorization reference',async()=>{
 const p=await newProfile(),identity=await company();await assert.rejects(()=>approval(p.id,true,{reference:'\u00a0\u2000\uFEFF'}),e=>e.status===400);
 await assert.rejects(()=>rpc('erp_cnab_operational_approve',{p_user_id:users.admin,p_profile_id:p.id,p_command_id:randomUUID(),p_expected_approval:0,p_expected_profile:1,p_expected_identity:identity,p_enabled:true,p_confirmed_on:today,p_reference:'\u00a0\u2000\uFEFF'}),state('22023'));
 const v=await approval(p.id,true,{reference:'\u00a0REFERENCIA SINTETICA\u00a0'});assert.equal(v.result.body.approval.reference,'\u00a0REFERENCIA SINTETICA\u00a0');assert.equal((await api(`/profiles/${p.id}/approval`,v.body,{userId:users.admin})).body.replayed,true);
});
