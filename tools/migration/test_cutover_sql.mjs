import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before,after,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parseCutoverRoute,executeCutoverRoute,cutoverMethods } from '../../workers/erp-api/src/cutover.mjs';
let db;const admin=randomUUID(),viewer=randomUUID(),sha='a'.repeat(64),file='b'.repeat(64),hash='c'.repeat(64);
const err=code=>e=>e.code===code;
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0].v;
async function rpc(name,args){await db.exec('set role service_role');try{const pairs=Object.entries(args);return await value(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) v`,pairs.map(([,v])=>v));}finally{await db.exec('reset role');}}
const list=(entity,extra={})=>rpc('erp_cutover_records',{p_user_id:admin,p_backup_sha:sha,p_entity:entity,...extra});
const backup=(entity,id,n,payload)=>db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data) values($1,'csv',$2,$3,$4)",[sha,file,n,JSON.stringify({entity,source_id:id,payload})]);
const source=(entity,id,payload)=>db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'test',$2,$3,$4)",[entity,id,JSON.stringify(payload),hash]);
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0020_cutover_readiness']) await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const [id,role]of[[admin,'admin'],[viewer,'consulta']]){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 await db.query("insert into origin_backup.batch(backup_sha,manifest,status,finished_at)values($1,'{}','stored_with_issues',now())",[sha]);
 await db.exec("insert into origin_sync.resource_state(resource)values('test')");
 await backup('contacts','101',1,{ID:'101',Nome:'Contato fictício',Código:'001',Situação:'Ativo','CNPJ / CPF':'PII-SECRET',Observações:'private notes'});
 await backup('contacts','102',2,{ID:'102',Nome:'Contato só backup'});
 await backup('contacts','102',3,{ID:'102',Nome:'Outra ocorrência preservada'});
 await source('contacts','101',{id:101,nome:'Contato API',email:'secret@example.invalid',numeroDocumento:'PII-SECRET'});
 await source('contacts','103',{id:103,nome:'Contato só API'});
 await backup('receivables','201',4,{'Valor documento':'1.234,56','Valor recebido':'34,56',Situação:'aberto','Conta financeira':'Conta privada','Data vencimento':'20/10/2026',Cliente:'PII-SECRET','Número no banco':'BANK-SECRET'});
 await source('receivables','201',{id:201,situacao:7,valor:1234.56,saldo:1200,contato:{id:101,nome:'PII-SECRET'},vencimento:'2026-10-20',linkBoleto:'https://secret.invalid/token',historico:'PRIVATE'});
 await source('receivables','202',{id:202,situacao:3,valor:'100.001',saldo:null,contato:{id:999}});
 await backup('stock_snapshot',null,5,{'ID Produto':'301','Nome do Produto':'Peça fictícia','Depósito*':'Depósito de origem','Movimentação de Estoque*':'1.234,123456','Tipo de lançamento*':''});
 await source('products','301',{id:301,nome:'Peça API',tipo:'P',unidade:'UN',estoque:{saldoFisicoTotal:999999,depositos:[{id:99,saldoFisico:123}]}});
});
after(()=>db?.close());
test('020 read-only admin RPCs deny direct roles and membership downgrade',async()=>{
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(()=>value('select public.erp_cutover_summary($1) v',[admin]),err('42501'));await assert.rejects(()=>value("select erp_cutover.decimal_value('1','api',2) v"),err('42501'));}finally{await db.exec('reset role');}}
 await assert.rejects(()=>rpc('erp_cutover_summary',{p_user_id:viewer}),err('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[admin]);await assert.rejects(()=>list('contacts'),err('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[admin]);
});
test('020 preserves duplicate backup rows, only exact IDs reconcile, pagination includes API-only',async()=>{
 const first=await list('contacts',{p_limit:2});assert.equal(first.items.length,2);assert.equal(first.has_more,true);assert.equal(first.items[0].source_id,'103');assert.equal(first.items[0].backup,null);
 assert.equal(first.items[1].source_id,'101');assert.ok(first.items[1].backup);assert.ok(first.items[1].api);
 const second=await list('contacts',{p_limit:2,p_after:first.next_cursor});assert.equal(second.has_more,false);assert.equal(second.items.length,2);assert.equal(new Set(second.items.map(x=>x.key)).size,2);
 assert.ok(second.items.every(x=>x.checks.includes('DUPLICATE_BACKUP_SOURCE_ID')&&x.api===null));
 assert.equal((await list('contacts',{p_query:'%'})).items.length,0);
 const filtered=await list('contacts',{p_query:'101'});assert.equal(filtered.items.length,1);assert.equal(filtered.items[0].source_id,'101');
});
test('020 financial source values stay separate; Confirmado never becomes Aberto or computed balance',async()=>{
 const r=(await list('receivables',{p_query:'201'})).items[0];assert.equal(r.backup.amount,'1234.56');assert.equal(r.backup.paid,'34.56');assert.equal(r.api.balance,'1200.00');assert.equal(r.api.status_label,'Confirmado');
 assert.equal('balance'in r.backup,false);assert.equal(r.checks.includes('SOURCE_OPEN_OR_PARTIAL_REQUIRES_REVIEW'),false);assert.equal(r.backup.financial_account_present,true);
 const bad=(await list('receivables',{p_query:'202'})).items[0];assert.equal(bad.api.amount,null);assert.equal(bad.api.balance,null);assert.ok(bad.checks.includes('API_AMOUNT_UNAVAILABLE'));assert.ok(bad.checks.includes('SOURCE_OPEN_OR_PARTIAL_REQUIRES_REVIEW'));
 assert.equal(JSON.stringify(r).includes('BANK-SECRET'),false);assert.equal(JSON.stringify(r).includes('PII-SECRET'),false);assert.equal(JSON.stringify(r).includes('linkBoleto'),false);
});
test('020 stock quantity is evidence only; no aggregation, warehouse guess, or absence→zero',async()=>{
 const r=(await list('stock_snapshot')).items[0];assert.equal(r.source_id,'301');assert.equal(r.backup.quantity,'1234.123456');assert.equal(r.backup.stock_mode,'');assert.equal(r.api.product_kind,'P');
 assert.ok(r.checks.includes('WAREHOUSE_MAPPING_NOT_DEFINED'));assert.ok(r.checks.includes('STOCK_SEMANTICS_REQUIRE_REVIEW'));
 assert.equal(JSON.stringify(r).includes('999999'),false);assert.equal('balance'in (r.native??{}),false);
 const summary=await rpc('erp_cutover_summary',{p_user_id:admin});const s=summary.batches[0].counts.find(x=>x.entity==='stock_snapshot');assert.equal(s.distinct_ids,1);assert.equal(s.ids_seen_in_api,1);assert.equal(s.missing_id_rows,0);
});
test('020 exact parsers reject mixed, excessive precision, blanks and unknown shapes without rounding',async()=>{
 const parse=(v,f,s)=>value('select erp_cutover.decimal_value($1,$2,$3) v',[v,f,s]);
 assert.equal(await parse('1.234,56','csv',2),'1234.56');assert.equal(await parse('-0,000001','csv',6),'-0.000001');assert.equal(await parse('12','api',2),'12.00');
 for(const [v,f,s]of[['1,234.56','csv',2],['','csv',2],['1.001','api',2],['1e3','api',2],['NaN','api',2],['100000000000000','api',2],['0.0000001','api',6]])assert.equal(await parse(v,f,s),null);
});
test('020 summary measures preserved coverage only and makes no mutations',async()=>{
 const before=await value('select (select count(*) from erp_catalog.record)+(select count(*) from erp_catalog.command)+(select count(*) from origin_backup.record)+(select count(*) from origin_sync.raw_record) v');
 const r=await rpc('erp_cutover_summary',{p_user_id:admin});assert.equal(r.reconciled,false);assert.equal(r.cutoff_at,null);assert.equal(r.batches.length,1);const c=r.batches[0].counts.find(x=>x.entity==='contacts');assert.deepEqual(c,{entity:'contacts',rows:3,distinct_ids:2,ids_seen_in_api:1,missing_id_rows:0});
 const after=await value('select (select count(*) from erp_catalog.record)+(select count(*) from erp_catalog.command)+(select count(*) from origin_backup.record)+(select count(*) from origin_sync.raw_record) v');assert.equal(after,before);
 const flags=await value("select bool_and(provolatile='s') v from pg_proc where proname in('erp_cutover_summary','erp_cutover_records')");assert.equal(flags,true);
 await assert.rejects(()=>list('contacts',{p_backup_sha:'d'.repeat(64)}),err('P0002'));await assert.rejects(()=>list('cash_movements'),err('22023'));
});
test('020 native catalog link is exact and notices a newer collected hash without modifying it',async()=>{
 const id=randomUUID(),old='d'.repeat(64);await db.query("insert into erp_catalog.record(id,entity,name)values($1,'contacts','Contato nativo fictício')",[id]);
 await db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)values('contacts','101',$1,1,'{}','[]')",[old]);
 await db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)values('contacts','101',$1,$2,$2,'synced')",[id,old]);
 const r=(await list('contacts',{p_query:'101'})).items[0];assert.equal(r.native.record_id,id);assert.equal(r.native.source_changed_since_apply,true);assert.equal(r.native.candidate_pending,false);
 assert.equal(await value('select applied_hash v from erp_catalog.origin where record_id=$1',[id]),old);
});
test('020 multiple stock rows for one product in different depots stay legitimate distinct evidence',async()=>{
 await backup('stock_snapshot',null,6,{'ID Produto':'301','Nome do Produto':'Peça fictícia','Depósito*':'Outro depósito','Movimentação de Estoque*':'2,000000','Tipo de lançamento*':''});
 const r=await list('stock_snapshot');assert.equal(r.items.length,2);assert.deepEqual(r.items.map(i=>i.backup.quantity),['1234.123456','2.000000']);
 assert.ok(r.items.every(i=>i.checks.includes('STOCK_PRODUCT_MULTIPLE_ROWS')&&!i.checks.includes('DUPLICATE_BACKUP_SOURCE_ID')));
 assert.equal(new Set(r.items.map(i=>i.key)).size,2);
});
test('020 nested contact IDs cannot truncate into an existing native identity',async()=>{
 const id=randomUUID(),prefix='9'.repeat(200);await db.query("insert into erp_catalog.record(id,entity,name)values($1,'contacts','Prefixo fictício')",[id]);
 await db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)values('contacts',$1,$2,1,'{}','[]')",[prefix,hash]);
 await db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)values('contacts',$1,$2,$3,$3,'synced')",[prefix,id,hash]);
 await source('receivables','203',{id:203,situacao:1,valor:1,saldo:1,contato:{id:prefix+'1'}});
 const bad=(await list('receivables',{p_query:'203'})).items[0];assert.equal(bad.api.contact_source_id,null);assert.equal(bad.api.native_contact_id,null);assert.ok(bad.checks.includes('NO_NATIVE_CONTACT_LINK'));
 await source('receivables','204',{id:204,situacao:1,valor:1,saldo:1,contato:{id:prefix}});
 const exact=(await list('receivables',{p_query:'204'})).items[0];assert.equal(exact.api.contact_source_id,prefix);assert.equal(exact.api.native_contact_id,id);
 for(const nested of [null,{},[],true,''])assert.equal(await value('select erp_cutover.exact_id($1::jsonb) v',[JSON.stringify(nested)]),null);
});
test('020 HTTP rejects writes/unknown query and projects source records without arbitrary payloads',async()=>{
 const request=(path,method='GET')=>new Request(`https://erp.invalid${path}`,{method});
 assert.equal(cutoverMethods('/v1/preparacao-virada')[0],'GET');assert.equal(parseCutoverRoute(request('/v1/else')),null);
 assert.throws(()=>parseCutoverRoute(request('/v1/preparacao-virada','POST')),e=>e.status===405);
 for(const tail of ['?limit=100','?q=a&q=b','?actor=me','?after=%00','?limit=-1'])assert.throws(()=>parseCutoverRoute(request(`/v1/preparacao-virada/${sha}/contacts${tail}`)),e=>e.status===400);
 const r=parseCutoverRoute(request(`/v1/preparacao-virada/${sha}/receivables?q=201`));const dto=await executeCutoverRoute(r,{userId:admin,rpc});assert.equal(dto.items[0].api.status_label,'Confirmado');
 const raw=await rpc(r.rpc,{p_user_id:admin,...r.args});raw.items[0].raw_payload={secret:true};raw.items[0].api.secret='discard';const projected=await executeCutoverRoute(r,{userId:admin,rpc:async()=>raw});assert.equal(JSON.stringify(projected).includes('secret'),false);
 raw.items[0].api.status_label='Aberto';await assert.rejects(()=>executeCutoverRoute(r,{userId:admin,rpc:async()=>raw}),e=>e.status===502);
 const summaryRoute=parseCutoverRoute(request('/v1/preparacao-virada'));assert.equal((await executeCutoverRoute(summaryRoute,{userId:admin,rpc})).data_mode,'cutover_readonly');
 const rawSummary=await rpc(summaryRoute.rpc,{p_user_id:admin});rawSummary.limitations[1]=rawSummary.limitations[0];await assert.rejects(()=>executeCutoverRoute(summaryRoute,{userId:admin,rpc:async()=>rawSummary}),e=>e.status===502);
});
