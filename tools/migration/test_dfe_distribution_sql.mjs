import test,{before,beforeEach,after}from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{randomUUID,createHash}from'node:crypto';
import{gzipSync}from'node:zlib';
import{PGlite}from'@electric-sql/pglite';
import{buildAccessKey,cnpjCheckDigits}from'../../packages/fiscal-core/src/identity.mjs';
import{parseDistributionResponse,buildDistributionRequest}from'../../packages/fiscal-xml/src/distribution.mjs';
import{parseDfeDistributionRoute,executeDfeDistributionRoute}from'../../workers/erp-api/src/dfe-distribution.mjs';
let db;const users={},NS='http://www.portalfiscal.inf.br/nfe',bucket='brufap-received-dfe';
const code=c=>e=>e.code===c,hash=v=>createHash('sha256').update(v).digest('hex');
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function as(role,fn){await db.exec(`set role ${role}`);try{return await fn();}finally{await db.exec('reset role');}}
async function rpc(name,args={}){const pairs=Object.entries(args);return as('service_role',()=>scalar(`select public.erp_dfe_${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v)));}
const co={legal_name:'EMPRESA FICTICIA DFE',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'RUA DE TESTE',number:'1',complement:null,district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP',phone:null,email:null};
const key=buildAccessKey({cUF:'35',cnpj:'12345678000195',model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
async function identity(patch={}){const v=await scalar('select coalesce((select version from erp_company.identity where singleton),0)value');return as('service_role',()=>scalar('select public.erp_company_save_identity($1::uuid,$2::int,$3::uuid,$4::jsonb)value',[users.admin,v,randomUUID(),JSON.stringify({...co,...patch})]));}
async function config(patch={}){const current=(await rpc('settings',{p_user_id:users.admin,p_environment:'2'})).current,iv=await scalar('select version value from erp_company.identity where singleton');const args={p_user_id:users.admin,p_command_id:randomUUID(),p_environment:'2',p_expected_version:current?.version??0,p_expected_identity_version:iv,p_coordinator:'brufap',p_checkpoint:current?.checkpoint??'000000000000000',p_checkpoint_confirmed:true,p_other_consumers_reviewed:true,p_collection_requested:true,p_reason:'Coordenação fictícia explicitamente conferida',...patch};return{args,value:await rpc('configure',args)};}
async function reserve(c=null,patch={}){c??=(await config()).value.current;const args={p_user_id:users.fiscal,p_command_id:randomUUID(),p_channel_id:c.id,p_expected_version:c.version,...patch};return{args,value:await rpc('reserve',args)};}
const leased=r=>({p_user_id:r.args.p_user_id,p_attempt_id:r.value.attempt_id,p_lease_id:r.value.lease_id});
const dispatch=r=>rpc('dispatch',leased(r));
const finish=(r,m)=>rpc('finalize',{...leased(r),p_manifest:m});
const get=r=>rpc('command',{p_user_id:r.args.p_user_id,p_command_id:r.args.p_command_id});
const settings=()=>rpc('settings',{p_user_id:users.admin,p_environment:'2'});
const expire=r=>db.query("update erp_dfe.attempt set lease_until=clock_timestamp()-interval'1 second'where id=$1",[r.value.attempt_id]);
const list=(r,extra={})=>rpc('documents',{p_user_id:users.consulta,p_channel_id:r.args.p_channel_id,...extra});
async function stored(bytes){const h=hash(bytes);await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)on conflict do nothing',[bucket,`objects/${h}.xml`,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);return h;}
const xmlFor=(kind='invoice_summary')=>kind==='invoice_summary'?`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resNFe>`:kind==='invoice'?`<nfeProc xmlns="${NS}" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><tpAmb>2</tpAmb></ide><dest><CNPJ>${co.cnpj}</CNPJ></dest></infNFe></NFe><protNFe><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infProt></protNFe></nfeProc>`:kind==='event_summary'?`<resEvento xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resEvento>`:kind==='event'?`<procEventoNFe xmlns="${NS}" versao="1.00"><evento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></evento><retEvento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></retEvento></procEventoNFe>`:'<unknown xmlns="urn:future"/>';
const schemas={invoice_summary:'resNFe_v1.01.xsd',invoice:'procNFe_v4.00.xsd',event_summary:'resEvento_v1.01.xsd',event:'procEventoNFe_v1.00.xsd',unsupported:'future_v9.00.xsd'};
async function manifest(r,{status='138',kinds=['invoice_summary'],last,max,nsus,upload=true}={}){
 if(status!=='138')kinds=[];const nsu=(n)=>String(n).padStart(15,'0');const base=BigInt(r.value.request.lastNsu);last=last===undefined?nsu(base+BigInt(kinds.length)):last;max=max===undefined?last:max;
 const docs=kinds.map((kind,i)=>({xml:xmlFor(kind),schema:schemas[kind],nsu:nsus?nsus[i]:nsu(base+BigInt(i+1))}));
 const zip=docs.map(d=>`<docZip${d.nsu===null?'':` NSU="${d.nsu}"`} schema="${d.schema}">${gzipSync(d.xml).toString('base64')}</docZip>`).join('');
 const bytes=Buffer.from(`<retDistDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${r.value.request.environment}</tpAmb><verAplic>TESTE</verAplic><cStat>${status}</cStat><xMotivo>FICTICIO</xMotivo><dhResp>2026-10-16T10:01:00-03:00</dhResp>${last===null?'':`<ultNSU>${last}</ultNSU>`}${max===null?'':`<maxNSU>${max}</maxNSU>`}${docs.length?`<loteDistDFeInt>${zip}</loteDistDFeInt>`:''}</retDistDFeInt>`);
 const parsed=await parseDistributionResponse(bytes,{request:r.value.request});
 const m={request_hash:parsed.requestHash,response_hash:parsed.responseHash,response_size:bytes.length,status:parsed.status,last_nsu:parsed.lastNsu,max_nsu:parsed.maxNsu,documents:parsed.documents.map(d=>({nsu:d.nsu,schema:d.schema,kind:d.kind,access_key:d.accessKey,recipient_match:d.recipientMatch,quarantined:d.quarantined,hash:d.sha256,size:d.sizeBytes,compressed_hash:d.compressedSha256})),issues:parsed.issues};
 if(upload){await stored(bytes);for(const d of parsed.documents)await stored(Buffer.from(d.xml));}return{m,parsed,bytes};
}
before(async()=>{
 db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant select,insert,update,delete on storage.objects to anon,authenticated;create policy broad on storage.objects for all to anon,authenticated using(true)with check(true);");
 for(const n of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company','0041_a1_custody','0045_dfe_distribution'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${n}.sql`,import.meta.url),'utf8'));
 for(const role of['admin','fiscal','consulta','vendas','financeiro','estoque']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 await identity();await db.query('insert into storage.buckets values($1,$1,false,8388608,$2::text[])',[bucket,['application/octet-stream']]);
});
beforeEach(async()=>{await db.exec('truncate erp_dfe.channel,erp_dfe.command,erp_dfe.attempt,erp_dfe.object,erp_dfe.document,erp_dfe.attempt_document,erp_dfe.audit cascade;delete from storage.objects;update erp_access.membership set active=true;');await db.query('update storage.buckets set public=false,file_size_limit=8388608,allowed_mime_types=$1::text[]where id=$2',[['application/octet-stream'],bucket]);if(await scalar('select data->>\'cnpj\' value from erp_company.identity where singleton')!==co.cnpj)await identity();});
after(()=>db?.close());
test('045 has seven private RLS tables and twelve service-only RPCs; broad Storage policies do not expose documents',async()=>{
 const tables=(await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_dfe'and c.relkind='r'")).rows;assert.equal(tables.length,7);assert.ok(tables.every(t=>t.relrowsecurity));
 for(const role of['anon','authenticated','service_role'])for(const t of tables)assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[role,`erp_dfe.${t.relname}`]),false);
 const functions=(await db.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and proname like 'erp_dfe_%'")).rows;assert.equal(functions.length,12);
 for(const f of functions){assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')value",[f.signature]),true);for(const r of['anon','authenticated'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')value',[r,f.signature]),false);}
 await stored(Buffer.from('PRIVATE SYNTHETIC'));for(const role of['anon','authenticated']){assert.equal(await as(role,()=>scalar('select count(*)::int value from storage.objects where bucket_id=$1',[bucket])),0);await assert.rejects(()=>as(role,()=>db.query('insert into storage.objects values($1,\'blocked\',\'{}\')',[bucket])),code('42501'));}
 for(const role of['admin','fiscal','consulta'])assert.equal((await rpc('settings',{p_user_id:users[role],p_environment:'2'})).current,null);
 for(const role of['vendas','financeiro','estoque'])await assert.rejects(()=>rpc('settings',{p_user_id:users[role],p_environment:'2'}),code('42501'));
});
test('configuration is explicit, versioned and admin-only; nothing silently chooses zero or authorizes transport',async()=>{
 await assert.rejects(()=>config({p_user_id:users.fiscal}),code('42501'));
 for(const patch of[{p_checkpoint:null},{p_checkpoint:'0'},{p_coordinator:'external'},{p_other_consumers_reviewed:false},{p_reason:'\u00a0\u00a0\u00a0'}])await assert.rejects(()=>config(patch),code('22023'));
 const pending=await config({p_coordinator:'unconfirmed',p_checkpoint:null,p_checkpoint_confirmed:false,p_other_consumers_reviewed:false,p_collection_requested:false});assert.equal(pending.value.current.checkpoint,null);assert.equal(pending.value.can_query,false);
 await assert.rejects(()=>reserve(pending.value.current),code('40001'));
 const ready=await config({p_checkpoint:'000000000000005'});assert.equal(ready.value.current.checkpoint,'000000000000005');assert.equal(ready.value.transport_enabled,false);assert.equal((await rpc('configure',ready.args)).replayed,true);
 await assert.rejects(()=>rpc('configure',{...ready.args,p_reason:'Outro contexto'}),code('40001'));
});
test('a single active attempt and a single dispatch ticket survive lost reserve and dispatch responses',async()=>{
 const r=await reserve(),again=await rpc('reserve',r.args);assert.equal(again.lease_id,r.value.lease_id);
 assert.equal(r.value.request_hash,buildDistributionRequest(r.value.request).requestHash);await assert.rejects(()=>reserve(r.value.current),code('40001'));
 const{m}=await manifest(r);await assert.rejects(()=>finish(r,m),code('40001'));
 assert.equal((await dispatch(r)).dispatch_ticket_issued,true);assert.equal((await dispatch(r)).dispatch_ticket_issued,false);assert.equal((await get(r)).state,'dispatched');
});
test('parser-to-SQL batch preserves summary, full invoice, event and unknown quarantine separately, with safe pagination',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r,{kinds:['invoice_summary','invoice','event_summary','event','unsupported']});const saved=await finish(r,m);
 assert.equal(saved.current.checkpoint,'000000000000005');assert.equal(saved.receipt.documents,5);assert.equal(saved.current.paused,false);assert.equal(saved.financial_mutation_performed,false);
 const docs=(await list(r)).items;assert.equal(docs.length,5);assert.equal(docs.filter(d=>d.is_complete_invoice).length,1);assert.equal(docs.find(d=>d.kind==='unsupported').quarantined,true);assert.equal(docs.find(d=>d.kind==='invoice_summary').is_complete_invoice,false);
 const summary=docs.find(d=>d.kind==='invoice_summary'),object=await rpc('object',{p_user_id:users.fiscal,p_document_id:summary.id});assert.match(object.filename,/^RESUMO_NFE_/);assert.equal(object.object_key,`objects/${summary.xml_hash}.xml`);assert.equal(object.sefaz_authorized,false);
 const page=await list(r,{p_limit:2});assert.equal(page.has_more,true);assert.equal(page.next_cursor,page.items.at(-1).id);assert.ok((await list(r,{p_limit:2,p_after:page.next_cursor})).items.every(d=>d.id>page.next_cursor));
 assert.doesNotMatch(JSON.stringify(docs),/bucket|object_key|password|PFX|xMotivo/);assert.deepEqual(await finish(r,m),{...saved,replayed:true});assert.equal((await rpc('reserve',r.args)).state,'stored');
 await assert.rejects(()=>finish(r,{...m,response_hash:hash('changed')}),code('40001'));
});
test('missing any object or a private bucket mismatch rolls back the entire manifest and checkpoint',async()=>{
 const r=await reserve();await dispatch(r);const{m,bytes,parsed}=await manifest(r,{kinds:['invoice_summary','invoice'],upload:false});await stored(bytes);await stored(Buffer.from(parsed.documents[0].xml));
 await assert.rejects(()=>finish(r,m),code('55000'));assert.equal(await scalar('select count(*)::int value from erp_dfe.object'),0);assert.equal((await settings()).current.checkpoint,r.value.request.lastNsu);assert.equal((await list(r)).items.length,0);
 await stored(Buffer.from(parsed.documents[1].xml));await db.query('update storage.buckets set public=true where id=$1',[bucket]);await assert.rejects(()=>finish(r,m),code('55000'));
 await db.query('update storage.buckets set public=false,file_size_limit=8388609 where id=$1',[bucket]);await assert.rejects(()=>finish(r,m),code('55000'));
 await db.query('update storage.buckets set file_size_limit=8388608,allowed_mime_types=$1::text[]where id=$2',[['application/xml'],bucket]);await assert.rejects(()=>finish(r,m),code('55000'));
 await db.query('update storage.buckets set allowed_mime_types=$1::text[]where id=$2',[['application/octet-stream'],bucket]);assert.equal((await finish(r,m)).state,'stored');
});
test('137 and exhausted138 impose at least one hour; incomplete138 can prepare the next batch without claiming completeness',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r,{status:'137'}),start=Date.now();const result=await finish(r,m);assert.ok(Date.parse(result.current.not_before)>=start+3600000);assert.equal(result.current.checkpoint,r.value.request.lastNsu);await assert.rejects(()=>reserve(result.current),code('40001'));
 await db.exec("update erp_dfe.channel set not_before=clock_timestamp()-interval'1 second'");const next=await reserve((await settings()).current);await dispatch(next);const more=await manifest(next,{max:'000000000000009'});const saved=await finish(next,more.m);assert.equal(saved.current.checkpoint,'000000000000001');assert.equal(saved.current.paused,false);assert.ok(Date.parse(saved.current.not_before)<Date.now());
 const third=await reserve(saved.current);assert.equal(third.value.request.lastNsu,'000000000000001');
});
test('656 stores response evidence, pauses and never adopts the reported cursor or bypasses cooldown through reconfiguration',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r,{status:'656',last:'000000000000123',max:'000000000000123'});const saved=await finish(r,m);assert.equal(saved.state,'review');assert.equal(saved.current.paused,true);assert.equal(saved.current.checkpoint,'000000000000000');assert.equal(saved.receipt.reported_last_nsu,'000000000000123');
 await assert.rejects(()=>config({p_checkpoint:'000000000000123'}),code('40001'));const reviewed=await config();assert.equal(reviewed.value.current.not_before,saved.current.not_before);await assert.rejects(()=>reserve(reviewed.value.current),code('40001'));
});
test('cursor gaps and missing NSUs are stored as review evidence without advancing; stripped parser issues are rejected',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r,{last:'000000000000003',max:'000000000000003',nsus:['000000000000003']});await assert.rejects(()=>finish(r,{...m,issues:[]}),code('22023'));const result=await finish(r,m);assert.equal(result.state,'review');assert.equal(result.current.checkpoint,'000000000000000');assert.deepEqual(result.receipt.issues,['NSU_GAP_OBSERVED']);assert.equal((await list(r)).items[0].nsu,'000000000000003');
});
test('after dispatch an expired lease permits result recovery only; stale owners cannot finalize or resend',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r);await expire(r);
 const stale=await rpc('reserve',r.args);assert.equal(stale.state,'dispatched');assert.equal(stale.lease_id,r.value.lease_id);await assert.rejects(()=>dispatch(r),code('40001'));
 const recovered={...r,value:await rpc('recover',{p_user_id:users.fiscal,p_attempt_id:r.value.attempt_id})};assert.notEqual(recovered.value.lease_id,r.value.lease_id);assert.equal(recovered.value.recovery_only,true);assert.equal((await dispatch(recovered)).dispatch_ticket_issued,false);
 await assert.rejects(()=>finish(r,m),code('40001'));assert.equal((await finish(recovered,m)).state,'stored');
});
test('uncertain responses remain held; failure allowlist and bounded renewals do not unlock another query',async()=>{
 const r=await reserve();await dispatch(r);await assert.rejects(()=>rpc('uncertain',{...leased(r),p_error_code:'SECRET_RAW_ERROR'}),code('22023'));
 const u=await rpc('uncertain',{...leased(r),p_error_code:'RESPONSE_LOST'});assert.equal(u.state,'uncertain');assert.equal((await dispatch(r)).dispatch_ticket_issued,false);await assert.rejects(()=>reserve(u.current),code('40001'));
 await db.query("update erp_dfe.attempt set lease_started_at=clock_timestamp()-interval'11 minutes'where id=$1",[r.value.attempt_id]);await assert.rejects(()=>rpc('renew',leased(r)),code('40001'));
});
test('administrative abandonment requires expired ownership and pauses without resetting NSU, with permanent replay',async()=>{
 const r=await reserve();await dispatch(r);const args={p_user_id:users.admin,p_command_id:randomUUID(),p_attempt_id:r.value.attempt_id,p_expected_version:r.value.current.version,p_confirm_pause:true,p_reason:'Resposta fictícia indisponível; coordenação será revista'};
 await assert.rejects(()=>rpc('abandon',args),code('40001'));await expire(r);await assert.rejects(()=>rpc('abandon',{...args,p_user_id:users.fiscal}),code('42501'));
 const saved=await rpc('abandon',args);assert.equal(saved.current.collection_requested,false);assert.equal(saved.current.paused,true);assert.equal(saved.current.active_attempt_id,null);assert.equal(saved.current.checkpoint,r.value.request.lastNsu);assert.equal((await get(r)).state,'abandoned');assert.equal((await rpc('abandon',args)).replayed,true);
 const{m}=await manifest(r);await assert.rejects(()=>finish(r,m),code('40001'));await assert.rejects(()=>config({p_checkpoint:'000000000000009'}),code('40001'));
});
test('identity edits and revoked membership are rechecked before mutation and replay; no cross-company read',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r);await identity({trade_name:'CONTEXTO NOVO'});await assert.rejects(()=>finish(r,m),code('40001'));assert.equal((await settings()).current.company_changed,true);
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>get(r),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 await identity({cnpj:'12345678000195'});await assert.rejects(()=>get(r),code('42501'));await assert.rejects(()=>list(r),code('42501'));
});
test('strict manifest rejects spoofed trust, numeric IDs, wrong kinds/model, more than50 or32MiB and foreign fields',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r);const bads=[{...m,can_query:true},{...m,last_nsu:1},{...m,status:138},{...m,request_hash:hash('other')},{...m,documents:[{...m.documents[0],kind:'invoice'}]},{...m,documents:[{...m.documents[0],access_key:key.slice(0,20)+'65'+key.slice(22)}]},{...m,documents:[{...m.documents[0],schema:'../../secret.xsd'}]},{...m,documents:Array(51).fill(m.documents[0])}];
 for(const bad of bads)await assert.rejects(()=>finish(r,bad),code('22023'));
 const huge={...m,last_nsu:'000000000000005',max_nsu:'000000000000005',documents:Array.from({length:5},(_,i)=>({...m.documents[0],nsu:String(i+1).padStart(15,'0'),size:8388608}))};await assert.rejects(()=>finish(r,huge),code('22023'));assert.equal((await list(r)).items.length,0);
 const base='12ABC34501DE',cnpj=base+cnpjCheckDigits(base),alpha=buildAccessKey({cUF:'35',cnpj,model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});assert.equal(await scalar('select erp_dfe.key55($1)value',[alpha]),true);
});
test('terminal history cannot be changed and an audit failure rolls back documents, receipt and checkpoint',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r);await db.exec("create function public.synthetic_fail_dfe()returns trigger language plpgsql as $$begin if new.action='finalize'then raise exception 'synthetic audit failure';end if;return new;end$$;create trigger synthetic_fail before insert on erp_dfe.audit for each row execute function public.synthetic_fail_dfe();");
 await assert.rejects(()=>finish(r,m));assert.equal((await get(r)).state,'dispatched');assert.equal((await list(r)).items.length,0);assert.equal((await settings()).current.checkpoint,r.value.request.lastNsu);
 await db.exec('drop trigger synthetic_fail on erp_dfe.audit;drop function public.synthetic_fail_dfe()');await finish(r,m);
 for(const table of['object','document','attempt_document','audit','attempt','command'])await assert.rejects(()=>db.exec(`delete from erp_dfe.${table}`),code('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>finish(r,m),code('42501'));
});
test('an NSU observed during review is deduplicated when recovered; different bytes cannot replace it or partly commit a later batch',async()=>{
 const first=await reserve();await dispatch(first);const observed=await manifest(first,{last:'000000000000003',nsus:['000000000000003']});const old=await finish(first,observed.m);assert.equal(old.state,'review');
 await config();await db.exec("update erp_dfe.channel set not_before=clock_timestamp()-interval'1 second'");const next=await reserve((await settings()).current);await dispatch(next);const complete=await manifest(next,{kinds:['invoice_summary','invoice_summary','invoice_summary']});
 const changed=structuredClone(complete.m),bytes=Buffer.from(xmlFor()+' ');await stored(bytes);changed.documents[2].hash=hash(bytes);changed.documents[2].size=bytes.length;
 await assert.rejects(()=>finish(next,changed),code('40001'));assert.equal((await list(next)).items.length,1);assert.equal((await settings()).current.checkpoint,'000000000000000');
 const saved=await finish(next,complete.m);assert.equal(saved.current.checkpoint,'000000000000003');assert.equal((await list(next)).items.length,3);assert.equal(await scalar('select count(*)::int value from erp_dfe.attempt_document'),4);
 const replay=await finish(first,observed.m);assert.equal(replay.receipt.state,'review');assert.equal(replay.receipt.checkpoint_after,'000000000000000');assert.equal(replay.current.checkpoint,'000000000000003');assert.equal(replay.replayed,true);
});
test('missing cursors or document NSU are preserved only for review, including diagnostic137',async()=>{
 const r=await reserve();await dispatch(r);const absent=await manifest(r,{status:'137',last:null,max:null});const result=await finish(r,absent.m);assert.equal(result.state,'review');assert.deepEqual(result.receipt.issues,['RESPONSE_CURSOR_MISSING']);assert.equal(result.current.checkpoint,r.value.request.lastNsu);
 await config();await db.exec("update erp_dfe.channel set not_before=clock_timestamp()-interval'1 second'");const next=await reserve((await settings()).current);await dispatch(next);const missing=await manifest(next,{nsus:[null]});const saved=await finish(next,missing.m);assert.equal(saved.state,'review');assert.deepEqual(saved.receipt.issues,['CURSOR_WITHOUT_DOCUMENT','DOCUMENT_NSU_MISSING']);assert.equal((await list(next)).items[0].nsu,null);assert.equal(saved.current.checkpoint,'000000000000000');
});
test('fifty documents and15-digit NSUs retain exact arithmetic; foreign actors cannot recover someone else\'s command',async()=>{
 const initial=await config({p_checkpoint:'999999999999900'}),r=await reserve(initial.value.current);await dispatch(r);const full=await manifest(r,{kinds:Array(50).fill('invoice_summary'),max:'999999999999951'});const result=await finish(r,full.m);assert.equal(result.current.checkpoint,'999999999999950');assert.equal((await list(r,{p_limit:50})).items.length,50);
 await assert.rejects(()=>rpc('command',{p_user_id:users.admin,p_command_id:r.value.attempt_id}),code('42501'));await assert.rejects(()=>rpc('finalize',{...leased(r),p_user_id:users.admin,p_manifest:full.m}),code('42501'));
 const next=await reserve(result.current);await expire(next);const renewed=await rpc('reserve',next.args);assert.notEqual(renewed.lease_id,next.value.lease_id);assert.equal(renewed.state,'reserved');assert.equal((await dispatch({...next,value:renewed})).dispatch_ticket_issued,true);await assert.rejects(()=>dispatch(next),code('40001'));
});
test('identical bytes without NSU deduplicate only the content record while every attempt and position stays observable',async()=>{
 const r=await reserve();await dispatch(r);const first=await manifest(r,{kinds:['invoice_summary','invoice_summary'],nsus:[null,null]});await finish(r,first.m);
 assert.equal((await list(r)).items.length,1);assert.equal(await scalar('select count(*)::int value from erp_dfe.attempt_document'),2);assert.equal((await list(r)).items[0].nsu,null);
 await config();await db.exec("update erp_dfe.channel set not_before=clock_timestamp()-interval'1 second'");const next=await reserve((await settings()).current);await dispatch(next);const again=await manifest(next,{nsus:[null]});await finish(next,again.m);
 assert.equal((await list(next)).items.length,1);assert.equal(await scalar('select count(*)::int value from erp_dfe.attempt_document'),3);assert.equal((await settings()).current.checkpoint,'000000000000000');
});
test('terminal replay after a same-CNPJ identity revision keeps its old receipt separate from current configuration',async()=>{
 const r=await reserve();await dispatch(r);const{m}=await manifest(r);const saved=await finish(r,m);await identity({trade_name:'NOME ATUALIZADO APOS COLETA FICTICIA'});
 const replay=await finish(r,m);assert.deepEqual(replay.receipt,saved.receipt);assert.equal(replay.current.company_changed,true);const rebound=await config();
 const latest=await finish(r,m);assert.deepEqual(latest.receipt,saved.receipt);assert.equal(latest.current.version,rebound.value.current.version);assert.equal(latest.current.company_changed,false);assert.equal((await list(r)).items.length,1);
});
const http=async(path,{actor=users.admin,body,fetchObject}={})=>executeDfeDistributionRoute(await parseDfeDistributionRoute(new Request('https://synthetic.invalid/v1/notas-recebidas'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})),{userId:actor,rpc:(name,args)=>rpc(name.replace(/^erp_dfe_/,''),args),fetchObject});
test('real SQL settings/configure/replay are accepted by the strict HTTP boundary without exposing runtime context',async()=>{
 assert.equal((await http('/settings?environment=2')).body.current,null);
 const iv=await scalar('select version value from erp_company.identity where singleton'),body={command_id:randomUUID(),environment:'2',expected_version:0,expected_identity_version:iv,coordinator:'external',checkpoint:null,checkpoint_confirmed:false,other_consumers_reviewed:false,collection_requested:false,reason:'Outro consumidor fictício; checkpoint não fornecido'};
 const saved=await http('/settings',{body});assert.equal(saved.body.current.checkpoint,null);assert.equal(saved.body.current.has_active_attempt,false);assert.equal(saved.body.can_query,false);
 await identity({trade_name:'EMPRESA FICTICIA REVISAO DE IDENTIDADE'});const again=await http('/settings',{body});assert.equal(again.body.replayed,true);assert.equal(again.body.receipt.company_changed,false);assert.equal(again.body.current.company_changed,true);
 const read=await http(`/commands/${body.command_id}`);assert.deepEqual(read.body,again.body);assert.doesNotMatch(JSON.stringify(read),/active_attempt_id|lease_id|interestedCnpj|request_hash/);
 await assert.rejects(()=>http('/settings',{actor:users.fiscal,body:{...body,command_id:randomUUID()}}),e=>e.status===403);
});
test('real parser→SQL→HTTP preserves all five document kinds and authenticated byte-exact downloads',async()=>{
 const r=await reserve();await dispatch(r);const result=await manifest(r,{kinds:['invoice_summary','invoice','event_summary','event','unsupported']});await finish(r,result.m);
 const listed=await http(`/documents?channel_id=${r.args.p_channel_id}`,{actor:users.consulta});assert.equal(listed.body.items.length,5);assert.equal(listed.body.items.filter(x=>x.is_complete_invoice).length,1);
 const first=await http(`/documents?channel_id=${r.args.p_channel_id}&limit=2`);assert.equal(first.body.has_more,true);assert.equal((await http(`/documents?channel_id=${r.args.p_channel_id}&limit=2&after=${first.body.next_cursor}`)).body.items.length,2);
 for(const d of listed.body.items){const source=result.parsed.documents.find(x=>x.sha256===d.xml_hash);const out=await http(`/documents/${d.id}/download`,{actor:users.fiscal,fetchObject:async(path,options)=>{assert.equal(path,`/storage/v1/object/authenticated/${bucket}/objects/${d.xml_hash}.xml`);assert.equal(options.redirect,'manual');return new Response(new TextEncoder().encode(source.xml),{headers:{'Content-Type':'application/octet-stream'}});}});assert.equal(hash(out.bytes),d.xml_hash);assert.equal(out.bytes.length,d.size_bytes);if(d.kind==='invoice_summary')assert.match(out.filename,/^RESUMO_NFE_/);if(d.kind==='unsupported')assert.match(out.filename,/^QUARENTENA_/);}
 await assert.rejects(()=>http(`/commands/${r.value.attempt_id}`,{actor:users.fiscal}),e=>e.status===404);
});
