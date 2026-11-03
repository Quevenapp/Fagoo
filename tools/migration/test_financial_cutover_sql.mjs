import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {parseFinancialCutoverRoute,executeFinancialCutoverRoute,financialCutoverMethods,FINANCIAL_CUTOVER_ISSUES} from '../../workers/erp-api/src/financial-cutover.mjs';
import {financialCutoverPage,financialCutoverDetail,financialIssueLabels} from '../../apps/erp/src/lib/financial-cutover-model.ts';
let db;const users=Object.fromEntries(['admin','consulta','financeiro','fiscal','vendas','estoque'].map(r=>[r,randomUUID()]));
const hash='a'.repeat(64),otherHash='b'.repeat(64);const err=code=>e=>e.code===code;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args){await db.exec('set role service_role');try{const pairs=Object.entries(args);return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) v`,pairs.map(([,v])=>v));}finally{await db.exec('reset role');}}
const source=async(entity,id,extra={},raw=null)=>db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'financial_review_seed',$2,$3::jsonb,$4)",[entity,id,raw??JSON.stringify({id,situacao:1,valor:123.45,saldo:123.45,dataEmissao:'2026-10-01',vencimento:'2026-11-20',contato:{id:'101',nome:'NO-RAW-NAME',numeroDocumento:'PRIVATE-DOCUMENT'},...extra}),hash]);
const list=(entity='receivables',extra={})=>rpc('erp_cutover_financial_list',{p_user_id:users.admin,p_entity:entity,...extra});
const get=(sourceId,entity='receivables')=>rpc('erp_cutover_financial_get',{p_user_id:users.admin,p_entity:entity,p_source_id:sourceId});
const prefix='/v1/conferencia-financeira-origin';
async function api(path,rpcImpl=rpc,userId=users.admin){return executeFinancialCutoverRoute(parseFinancialCutoverRoute(new Request(`https://erp.invalid${prefix}${path}`)),{userId,rpc:rpcImpl});}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0010_erp_finance','0020_cutover_readiness','0030_origin_finance_refresh','0038_financial_cutover_review'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const[role,id]of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 await db.exec("insert into origin_sync.resource_state(resource)values('financial_review_seed')");
 await source('contacts','101',{nome:'Contato apenas API'});
 const native=randomUUID();await db.query("insert into erp_catalog.record(id,entity,name)values($1,'contacts','Contato nativo sintético')",[native]);await db.query('insert into erp_catalog.contact(record_id)values($1)',[native]);
 await db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)values('contacts','101',$1,1,'{}','[]')",[hash]);
 await db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)values('contacts','101',$1,$2,$2,'synced')",[native,hash]);
 await source('receivables','1001',{numeroDocumento:'DOC-001',historico:'Descrição sintética',numeroBanco:'000123',portador:{id:'9'},formaPagamento:{id:10},categoria:{id:11},contaContabil:{id:12},borderos:[13,'0014'],ocorrencia:{tipo:2,numeroParcelas:3},origem:{id:15,tipoOrigem:'venda',numero:'0015',url:'https://private.invalid/secret'},linkBoleto:'https://private.invalid/token',linkQRCodePix:'PRIVATE-PIX',idTransacao:'PRIVATE-TX'});
 await source('payables','1001',{situacao:3,saldo:10.01});
});
after(()=>db?.close());

test('038 service-only RPCs require active admin before any data or parameter handling',async()=>{
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(()=>scalar('select public.erp_cutover_financial_get($1,$2,$3) v',[users.admin,'receivables','1001']),err('42501'));await assert.rejects(()=>scalar("select erp_cutover.financial_money('{}','valor') v"),err('42501'));}finally{await db.exec('reset role');}}
 for(const[role,user]of Object.entries(users))if(role!=='admin')await assert.rejects(()=>rpc('erp_cutover_financial_list',{p_user_id:user,p_entity:null}),err('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.admin]);await assert.rejects(()=>get('1001'),err('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.admin]);
 assert.equal(await scalar("select bool_and(provolatile='s') v from pg_proc where proname in('erp_cutover_financial_list','erp_cutover_financial_get')"),true);
});
test('038 list and detail expose explicit evidence and exact native contact only',async()=>{
 const r=await api('/receivables/1001');assert.equal(r.data_mode,'financial_cutover_readonly');for(const k of ['persisted','import_enabled','operational_effects','reconciled','coverage_certified'])assert.equal(r[k],false);assert.equal(r.cutoff_at,null);
 const v=r.record;assert.equal(v.amount.value,'123.45');assert.equal(v.balance.cents,'12345');assert.equal(v.contact.match,'matched');assert.equal(v.contact.name,'Contato nativo sintético');assert.equal(v.contact.pending_review,false);assert.equal(v.contact.source_changed_since_apply,false);
 assert.deepEqual(v.banking.bordero_ids,['13','0014']);assert.equal(v.banking.bank_number,'000123');assert.deepEqual(v.installments,{kind:'2',total:'3',index:null,group_id:null,linkage:'not_established'});assert.equal(v.refresh.state,'never_attempted');
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|NO-RAW-NAME|https|numeroDocumento|linkBoleto|payload|imported/);
 const l=await api('?entity=receivables');assert.equal(l.items.length,1);for(const k of ['banking','installments','origin','refresh'])assert.equal(k in l.items[0],false);
 assert.deepEqual(l.page_totals,{amount_cents:'12345',balance_cents:'12345',amount_available_count:1,balance_available_count:1,amount_unavailable_count:0,balance_unavailable_count:0,scope:'current_page_only'});
});
test('038 money keeps missing/null/type/precision/range states and never derives balance',async()=>{
 const money=async p=>scalar("select erp_cutover.financial_money($1::jsonb,'saldo') v",[p]);
 for(const[p,state]of [['{}','missing'],['{"saldo":null}','null'],['{"saldo":"12.34"}','invalid_type'],['{"saldo":true}','invalid_type'],['{"saldo":{}}','invalid_type'],['{"saldo":-1}','invalid_value'],['{"saldo":0.001}','invalid_value'],['{"saldo":100000000000000}','out_of_range']])assert.deepEqual(await money(p),{state,value:null,cents:null});
 assert.deepEqual(await money('{"saldo":99999999999999.99}'),{state:'available',value:'99999999999999.99',cents:'9999999999999999'});
 assert.deepEqual(await money('{"saldo":0.01}'),{state:'available',value:'0.01',cents:'1'});
 await source('receivables','1002',{saldo:null,valor:100,situacao:3,recebido:30});const row=(await get('1002')).record;assert.equal(row.balance.value,null);assert.ok(row.issues.some(i=>i.code==='BALANCE_UNAVAILABLE'));
 await source('receivables','1003',{},'{"id":"1003","situacao":1,"valor":99999999999999.99,"saldo":99999999999999.99,"contato":{"id":"101"},"dataEmissao":"2026-10-01","vencimento":"2026-11-20"}');
 const huge=(await api('/receivables/1003')).record;assert.equal(huge.amount.cents,'9999999999999999');assert.ok(huge.issues.some(i=>i.code==='AMOUNT_EXCEEDS_NATIVE_LIMIT'));
});
test('038 status semantics never relabel Confirmado/Devolvido parcial as open or paid',async()=>{
 for(const[id,code]of [['2001',7],['2002',6],['2003','bad'],['2004',{}]])await source('receivables',id,{situacao:code});
 const all=await api('?entity=receivables&status=all&q=200');assert.deepEqual(all.items.map(i=>i.status.scope),['outside_open_scope','outside_open_scope','unknown','unknown']);assert.equal(all.items[0].status.label,'Confirmado');
 const unknown=await api('?entity=receivables&status=unknown&q=200');assert.deepEqual(unknown.items.map(i=>i.source_id),['2003','2004']);assert.ok(unknown.items.every(i=>i.status.code===null&&i.issues.some(p=>p.code==='SOURCE_STATUS_UNKNOWN')));
 assert.equal((await api('?entity=receivables&q=200')).items.length,0);
});
test('038 exact references cannot match a truncated or similarly named native contact',async()=>{
 await source('receivables','3001',{contato:{id:'0101',nome:'Contato nativo sintético'}});assert.equal((await get('3001')).record.contact.match,'unmatched');
 await source('receivables','3002',{contato:{id:'1'.repeat(201)}});const invalid=(await get('3002')).record;assert.equal(invalid.contact.match,'invalid_reference');assert.equal(invalid.contact.source_id,null);
 for(const[id,contact]of [['3003',null],['3004',[]],['3005',{id:[]}],['3006',{}]]){await source('receivables',id,{contato:contact});const c=(await get(id)).record.contact;assert.ok(['missing_reference','invalid_reference'].includes(c.match));assert.equal(c.record_id,null);}
 await db.exec("update erp_catalog.record set human_edited=true where entity='contacts';update origin_sync.raw_record set version_hash='"+otherHash+"' where entity='contacts'");
 const changed=(await get('1001')).record.contact;assert.equal(changed.pending_review,true);assert.equal(changed.human_edited,true);assert.equal(changed.source_changed_since_apply,true);
 await db.exec("update erp_catalog.record set active=false where entity='contacts'");assert.equal((await get('1001')).record.contact.match,'inactive');await db.exec("update erp_catalog.record set active=true where entity='contacts'");
});
test('038 calendar/date filters, literal query and C-keyset preserve page-only totals',async()=>{
 for(const[id,due]of [['4001','2024-02-29'],['4002','2025-02-29'],['4003','2099-12-31'],['4004','2100-01-01']])await source('receivables',id,{vencimento:due,numeroDocumento:'%_'+id});
 assert.equal((await get('4002')).record.due_on,null);assert.equal((await get('4004')).record.due_on,null);
 const exact=await api('?entity=receivables&from=2024-02-29&to=2024-02-29');assert.deepEqual(exact.items.map(i=>i.source_id),['4001']);
 const literal=await api('?entity=receivables&q=%25_&limit=2');assert.deepEqual(literal.items.map(i=>i.source_id),['4001','4002']);assert.equal(literal.has_more,true);assert.equal(literal.next_cursor,'4002');assert.equal(literal.page_totals.amount_cents,'24690');
 const next=await api('?entity=receivables&q=%25_&limit=2&after=4002');assert.deepEqual(next.items.map(i=>i.source_id),['4003','4004']);assert.equal(next.has_more,false);assert.equal(next.next_cursor,null);
 const empty=await api('?entity=payables&q=unmatched');assert.equal(empty.page_totals.balance_cents,'0');assert.equal(empty.page_totals.balance_available_count,0);
});
test('038 malformed refs/text are unavailable with an issue, never promoted to identifiers',async()=>{
 await source('receivables','5001',{numeroDocumento:'x'.repeat(205),historico:'bad\u0001text',borderos:{bad:true},portador:[],origem:{id:'x'.repeat(201)},ocorrencia:true});
 const r=(await api('/receivables/5001')).record;assert.equal(r.document_number.length,200);assert.equal(r.description,null);assert.equal(r.banking.carrier_id,null);assert.deepEqual(r.banking.bordero_ids,[]);assert.equal(r.origin.id,null);
 for(const code of ['SOURCE_TEXT_TRUNCATED','SOURCE_TEXT_INVALID','REFERENCE_INVALID'])assert.ok(r.issues.some(i=>i.code===code));
 await source('receivables','5002',{borderos:Array.from({length:101},(_,i)=>i+1)});const excess=(await get('5002')).record;assert.deepEqual(excess.banking.bordero_ids,[]);assert.ok(excess.issues.some(i=>i.code==='REFERENCE_INVALID'));
});
test('038 refresh diagnostics remain separate from observation and preserve failed/current states',async()=>{
 const attempt=randomUUID();await db.query("insert into origin_finance_refresh.origin(entity,source_id,last_attempt_at,last_success_at,next_attempt_at)values('receivables','1001',now(),now()-interval '2 days',now()+interval '1 hour')");
 await db.query("insert into origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status,state,finished_at,error_code,http_status)values($1,'receivables','1001',$2,$3,$4,now(),'1','failed',now(),'ORIGIN_HTTP_404',404)",[attempt,randomUUID(),randomUUID(),hash]);
 await db.query("update origin_finance_refresh.origin set current_attempt=$1 where entity='receivables' and source_id='1001'",[attempt]);
 const r=(await api('/receivables/1001')).record;assert.equal(r.status.code,'1');assert.equal(r.balance.cents,'12345');assert.equal(r.refresh.state,'failed');assert.equal(r.refresh.http_status,404);assert.equal(r.refresh.current_source_matches_result,null);assert.ok(r.issues.some(i=>i.code==='REFRESH_FAILED'));
 assert.notEqual(r.observed_at,r.refresh.last_success_at);
});
test('038 GET boundary denies writes/unknown/duplicate/cross-scope queries and invalid actors before RPC',async()=>{
 assert.deepEqual(financialCutoverMethods(prefix),['GET']);assert.equal(financialCutoverMethods(prefix+'-evil'),null);
 for(const method of ['POST','PATCH','DELETE'])assert.throws(()=>parseFinancialCutoverRoute(new Request('https://erp.invalid'+prefix,{method})),e=>e.status===405);
 for(const path of ['?entity=contacts','?entity=payables&limit=26','?entity=payables&entity=receivables','?entity=payables&after=%00','?entity=payables&from=2025-02-29','?entity=payables&from=2026-01-02&to=2026-01-01','?entity=payables&actor=x','/payables/1001?q=x','/payables/%zz'])assert.throws(()=>parseFinancialCutoverRoute(new Request('https://erp.invalid'+prefix+path)),e=>e.status===400);
 await assert.rejects(()=>api('?entity=payables',async()=>assert.fail('RPC reached'),'not-a-uuid'),e=>e.status===403);
 const upper=await api('/payables/1001',async(name,args)=>{assert.equal(args.p_user_id,users.admin);return rpc(name,args);},users.admin.toUpperCase());assert.equal(upper.record.entity,'payables');
 await assert.rejects(()=>get('absent'),err('P0002'));
});
test('038 unlinked refresh evidence preserves observed values without borrowing another source attempt',async()=>{
 for(const id of ['6001','6002','6003','6004'])await source('receivables',id,{valor:25.70,saldo:25.70});
 await db.exec("insert into origin_finance_refresh.origin(entity,source_id,last_attempt_at,last_success_at)values('receivables','6001','2026-10-15T10:00:00Z','2026-10-15T09:00:00Z')");
 await db.exec("insert into origin_finance_refresh.origin(entity,source_id,failures,last_error)values('receivables','6002',1,'ORIGIN_HTTP_404');insert into origin_finance_refresh.origin(entity,source_id)values('receivables','6003'),('receivables','6004')");
 const foreignAttempt=await scalar("select current_attempt v from origin_finance_refresh.origin where entity='receivables' and source_id='1001'");
 await db.query("update origin_finance_refresh.origin set current_attempt=$1 where entity='receivables' and source_id='6003'",[foreignAttempt]);
 for(const id of ['6001','6002','6003']){
  const result=await api('/receivables/'+id),r=result.record;assert.equal(r.balance.cents,'2570');assert.equal(r.refresh.state,'incomplete');
  for(const key of ['last_finished_at','error_code','http_status','current_source_matches_result'])assert.equal(r.refresh[key],null);
  assert.ok(r.issues.some(i=>i.code==='REFRESH_EVIDENCE_INCOMPLETE'&&i.level==='review'));
  assert.equal(financialCutoverDetail(result,'receivables',id).record.refresh.state,'incomplete');
 }
 const own=(await api('/receivables/6001')).record.refresh;assert.equal(new Date(own.last_attempt_at).toISOString(),'2026-10-15T10:00:00.000Z');assert.equal(new Date(own.last_success_at).toISOString(),'2026-10-15T09:00:00.000Z');
 assert.equal((await api('/receivables/6004')).record.refresh.state,'never_attempted');
 const omitted=await get('6001');omitted.record.issues=omitted.record.issues.filter(i=>i.code!=='REFRESH_EVIDENCE_INCOMPLETE');await assert.rejects(()=>api('/receivables/6001',async()=>omitted),e=>e.status===502);
 const leaked=await get('6003');leaked.record.refresh.http_status=404;await assert.rejects(()=>api('/receivables/6003',async()=>leaked),e=>e.status===502);
});
test('038 DTO rejects contradictory amounts, scope, totals and trust while projecting unknown fields away',async()=>{
 const original=await get('1001');const cases=[v=>v.import_enabled=true,v=>v.record.source_id='1002',v=>v.record.entity='payables',v=>v.record.source_hash=[hash],v=>v.record.amount.cents='12346',v=>v.record.balance.state='missing',v=>v.record.status.label='Quitado',v=>v.record.contact.record_id=null,v=>v.record.issues=[],v=>v.record.refresh.state='stored'];
 for(const change of cases){const bad=structuredClone(original);change(bad);await assert.rejects(()=>api('/receivables/1001',async()=>bad),e=>e.status===502);}
 const raw=structuredClone(original);raw.secret='PRIVATE';raw.record.payload={secret:'PRIVATE'};raw.record.banking.bank_token='PRIVATE';const safe=await api('/receivables/1001',async()=>raw);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|payload|bank_token/);
 const page=await list('payables');page.page_totals.balance_cents='0';await assert.rejects(()=>api('?entity=payables',async()=>page),e=>e.status===502);
 assert.equal(Object.keys(FINANCIAL_CUTOVER_ISSUES).length,new Set(Object.keys(FINANCIAL_CUTOVER_ISSUES)).size);
});
test('038 Unicode ordering, bigint versions and bounded text do not coerce or silently match IDs',async()=>{
 for(const id of ['unicode-\ue000','unicode-😀'])await source('payables',id,{historico:'😀'.repeat(240),numeroDocumento:'😀'.repeat(200)});
 await db.query("update origin_sync.raw_record set version=9223372036854775807 where entity='payables' and source_id=$1",['unicode-😀']);
 const result=await api('?entity=payables&q=unicode-');assert.deepEqual(result.items.map(i=>i.source_id),['unicode-\ue000','unicode-😀']);assert.equal(result.items[1].source_version,'9223372036854775807');assert.equal(Array.from(result.items[0].description).length,240);
 const detail=await api('/payables/'+encodeURIComponent('unicode-😀'));assert.equal(detail.record.source_id,'unicode-😀');
 await source('payables','invalid-ref-shape',{ocorrencia:{tipo:[],numeroParcelas:true},origem:{id:1,tipoOrigem:{private:'x'},numero:true}});
 const bad=(await api('/payables/invalid-ref-shape')).record;assert.equal(bad.installments.kind,null);assert.equal(bad.origin.type,null);assert.ok(bad.issues.some(i=>i.code==='REFERENCE_INVALID'));
});
test('038 list/detail are transaction-read-only and leave every source/native ledger row unchanged',async()=>{
 const tables=['origin_sync.raw_record','origin_finance_refresh.origin','origin_finance_refresh.attempt','erp_catalog.record','erp_catalog.origin','erp_catalog.audit','erp_catalog.command','erp_finance.title','erp_finance.settlement','erp_finance.movement','erp_finance.command','erp_finance.audit'];
 const snapshot=()=>Promise.all(tables.map(t=>scalar(`select coalesce(jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text),'[]')v from ${t} x`)));
 const initial=await snapshot();await db.exec('begin read only');try{await list('receivables',{p_status:'all'});await get('1001');}finally{await db.exec('rollback');}assert.deepEqual(await snapshot(),initial);
});
test('038 actual SQL → HTTP → UI projection agrees across all money, contact and status cases',async()=>{
 assert.deepEqual(Object.keys(financialIssueLabels).sort(),Object.keys(FINANCIAL_CUTOVER_ISSUES).sort());
 for(const entity of ['receivables','payables'])for(const status of ['open_partial','all','unknown']){
  const page=await api(`?entity=${entity}&status=${status}`);
  const parsed=financialCutoverPage(page,{entity,status,q:'',from:'',to:''});assert.equal(parsed.items.length,page.items.length);
  for(const row of parsed.items){const detail=await api(`/${entity}/${encodeURIComponent(row.source_id)}`);assert.equal(financialCutoverDetail(detail,entity,row.source_id).record.source_hash,row.source_hash);}
 }
});
