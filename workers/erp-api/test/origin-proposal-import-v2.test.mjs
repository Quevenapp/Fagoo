import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';

// One embedded database. Synthetic values only; no network, real imports or effects.
let db,contact,product,serial=9550000000,legacyId,legacyArgs,legacyAck;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v,code=c=>e=>e.code===c;
async function rpc(name,args){const entries=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const preview=(id,actor=users.admin)=>rpc('erp_origin_proposal_import_preview_v2',{p_user_id:actor,p_source_id:id});
const applyArgs=(id,p,command=randomUUID(),actor=users.admin)=>({p_user_id:actor,p_source_id:id,p_preview_hash:p.preview_hash,p_command_id:command,p_confirm_import:true,p_duplicate_reviewed:true});
const apply=(id,p,command=randomUUID(),actor=users.admin)=>rpc('erp_origin_proposal_import_apply_v2',applyArgs(id,p,command,actor));
const read=command=>rpc('erp_origin_proposal_import_command_v2',{p_user_id:users.admin,p_command_id:command});
const issue=(p,name)=>p.issues.some(i=>i.code===name);
async function stage(entity,id,payload){await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'synthetic_055',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'))",[entity,id,JSON.stringify(payload)]);}
function fixture(id){return {id,numero:55,data:'2026-10-16',situacao:'Rascunho',contato:{id:'9551000001'},
 total:76,totalProdutos:80,desconto:5,outrasDespesas:1,totalOutrosItens:0,garantia:0,dataProximoContato:'0000-00-00',
 introducao:'Introdução\ncomercial fictícia',aosCuidadosDe:'Pessoa sintética',vendedor:{id:'9551000090'},loja:{id:'9551000091',unidadeNegocio:{id:'9551000092'}},
 transporte:{frete:0,freteModalidade:0,quantidadeVolumes:2,pesoBruto:1.234567,prazoEntrega:0,contato:{id:'9551000093',nome:'Transportador fictício'},volumes:{id:'9551000094',servico:'Entrega sintética',codigoRastreamento:'QA055'}},
 itens:[{produto:{id:'9551000002',descricao:'Produto fictício'},codigo:'QA055',unidade:'UN',quantidade:2,valor:40,desconto:10,descricaoDetalhada:'Detalhe\ncomercial'}],
 parcelas:[{dataVencimento:'2026-11-15',numeroDias:30,valor:76,observacoes:'Nota de parcela',formaPagamento:{id:'9551000095'}}],observacoes:'Condição pública',observacaoInterna:'Observação interna',prazoEntrega:'Prazo declarado'};}
async function source(mutate=()=>{}){const id=String(++serial),p=fixture(id);mutate(p);await stage('sales_proposals',id,p);return id;}
const legacy=p=>{Object.assign(p,{total:80,desconto:0,outrasDespesas:0,dataProximoContato:null,introducao:'',aosCuidadosDe:'',loja:{id:0},vendedor:{id:0},transporte:{frete:0,freteModalidade:9},parcelas:[]});p.itens[0].desconto=0;p.itens[0].descricaoDetalhada='';};
async function catalog(entity,id,payload){await stage(entity,id,payload);const r=await rpc('erp_catalog_import_origin',{p_user_id:users.admin,p_entity:entity,p_items:[{source_id:id,source_hash:await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id])}],p_command_id:randomUUID(),p_dry_run:false});return r.items[0].record_id;}
const ledger=()=>scalar("select jsonb_build_object('documents',(select count(*) from erp_documents.document),'items',(select count(*) from erp_documents.item),'commands',(select count(*) from erp_documents.command),'origins',(select count(*) from erp_documents.origin_import_origin),'audit',(select count(*) from erp_documents.audit),'numbers',(select jsonb_object_agg(kind,last_number) from erp_documents.numbering),'stock',(select count(*) from erp_stock.entry),'finance',(select count(*) from erp_finance.title),'catalog',(select count(*) from erp_catalog.record))v");
function editable(d){const v={};for(const k of ['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','discount_mode','discount_value','freight','other_expenses','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial'])if(Object.hasOwn(d,k))v[k]=d[k];v.items=d.items.map(({gross,discount,total,position,product_snapshot,...r})=>r);v.installments=d.installments.map(({position,...r})=>r);return v;}
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Teste sintético'})).document;
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0032_proposal_service_conversion','0034_document_copy','0052_origin_proposal_import','0054_document_commercial'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','estoque','fiscal','consulta']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_055')");
 contact=await catalog('contacts','9551000001',{id:'9551000001',nome:'Contato sintético 055',situacao:'A',tipo:'J'});
 product=await catalog('products','9551000002',{id:'9551000002',nome:'Produto sintético 055',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:40});
 legacyId=await source(legacy);const p=await rpc('erp_origin_proposal_import_preview',{p_user_id:users.admin,p_source_id:legacyId});assert.equal(p.can_apply,true);legacyArgs=applyArgs(legacyId,p);legacyAck=await rpc('erp_origin_proposal_import_apply',legacyArgs);
 await db.exec(await readFile(new URL('../../../supabase/migrations/202610160055_origin_proposal_import_v2.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());


import {ORIGIN_PROPOSAL_IMPORT_V2_BASE as BASE,ORIGIN_PROPOSAL_IMPORT_V2_RESPONSE_BYTES as MAX,parseOriginProposalImportV2Route as parse,executeOriginProposalImportV2Route as execute,originProposalImportV2Response as response} from '../src/origin-proposal-import-v2.mjs';
import {parseOriginProposalImportRoute as oldParse,executeOriginProposalImportRoute as oldExecute} from '../src/origin-proposal-import.mjs';
const request=(path='',method='GET',data)=>new Request('https://example.invalid'+BASE+path,{method,...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});
const api=async(path='',method='GET',data,user=users.admin)=>execute(await parse(request(path,method,data)),{userId:user,rpc});
const plan=id=>api('/preview','POST',{source_id:id});
const bodyFor=(p,command=randomUUID())=>({source_id:p.source_id,preview_hash:p.preview_hash,command_id:command,confirm_import:true,duplicate_reviewed:true});
test('055 SQL→HTTP preview preserves commercial fields and exact evidence without a second line discount',async()=>{
 const before=await ledger(),p=await plan(await source());assert.equal(p.policy,'origin-open-proposal-v2');assert.equal(p.can_apply,true);assert.equal(p.proposed.totals.total,'76.00');assert.equal(p.proposed.discount_value,'5.00');assert.equal(p.source_evidence.items[0].discount_observed,'10.000000');assert.equal(p.proposed.items[0].discount_percent,'0.0000');assert.equal(p.proposed.commercial.transport.gross_weight,'1.234567');assert.equal(p.proposed.installments[0].note,'Nota de parcela');assert.equal(p.proposed.installments[0].payment_reference.source_id,'9551000095');assert.equal((await ledger()).documents,before.documents);
 for(const [state,value]of [['missing',undefined],['null',null],['empty',''],['zero_date','0000-00-00'],['date','2026-11-01']]){const p=await plan(await source(x=>{if(value===undefined)delete x.dataProximoContato;else x.dataProximoContato=value;}));assert.equal(p.source_evidence.next_contact.state,state);assert.equal(p.source_evidence.next_contact.value,value??null);assert.equal(p.transformations.length,state==='zero_date'?5:4);}
 const blocked=await plan(await source(x=>x.contato.id='999'));assert.equal(blocked.proposed,null);assert.equal(blocked.source_evidence,null);assert.deepEqual(blocked.transformations,[]);
});
test('055 historical body and item links stay immutable beside edited current and exact replay',async()=>{
 const p=await plan(await source()),body=bodyFor(p),ack=await api('/apply','POST',body),first=await api('/commands/'+body.command_id);assert.equal(ack.receipt.policy,p.policy);assert.deepEqual(first.historical_evidence.normalized_body,p.proposed);assert.equal(first.historical_evidence.item_links[0].native_item_id,first.current_document.items[0].id);
 const edit=editable(first.current_document);edit.commercial.attention_to='Revisão posterior';edit.items[0].detailed_description='Nova descrição';edit.installments[0].note=null;
 await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_proposals',p_id:first.current_document.id,p_expected_version:1,p_command_id:randomUUID(),p_body:edit});
 const current=await api('/origins/'+p.source_id),again=await api('/apply','POST',body);assert.deepEqual(current.receipt,ack.receipt);assert.deepEqual(current.historical_evidence,first.historical_evidence);assert.equal(current.current_document.version,2);assert.equal(current.current_document.commercial.attention_to,'Revisão posterior');assert.equal(again.replayed,true);assert.deepEqual(again.receipt,ack.receipt);
});
test('055 cannot reinterpret 052 receipts or replay a command under a different policy',async()=>{
 const oldRoute=await oldParse(new Request('https://example.invalid/v1/importacao-orcamentos-origin/commands/'+legacyArgs.p_command_id));const old=await oldExecute(oldRoute,{userId:users.admin,rpc});assert.equal(old.policy,'origin-open-proposal-v1');assert.equal(old.receipt.policy,undefined);
 await assert.rejects(()=>api('/commands/'+legacyArgs.p_command_id),e=>e.status===404);const p=await plan(await source());await assert.rejects(()=>api('/apply','POST',bodyFor(p,legacyArgs.p_command_id)),e=>e.status===409);
 const body=bodyFor(p);await api('/apply','POST',body);const newUnderOld=await oldParse(new Request('https://example.invalid/v1/importacao-orcamentos-origin/commands/'+body.command_id));await assert.rejects(()=>oldExecute(newUnderOld,{userId:users.admin,rpc}),e=>e.status===404);
});
test('055 validates evidence/body/receipt bindings and strips unrelated upstream fields',async()=>{
 const p=await plan(await source()),route=await parse(request('/preview','POST',{source_id:p.source_id}));
 for(const change of [v=>v.policy='origin-open-proposal-v1',v=>v.source_evidence.products_total='79.00',v=>v.source_evidence.global_discount_observed='0.00',v=>v.source_evidence.items[0].quantity='3.000000',v=>v.source_evidence.items[0].unit_price='41.0000',v=>v.source_evidence.items[0].discount_unit='percent',v=>v.source_evidence.items[0].discount_observed='1e2',v=>v.source_evidence.next_contact.state='date',v=>v.transformations.pop(),v=>delete v.proposed.commercial,v=>delete v.proposed.items[0].detailed_description,v=>delete v.proposed.installments[0].payment_reference]){const v=structuredClone(p);change(v);assert.throws(()=>response(v,route),e=>e.status===502);}
 const body=bodyFor(p),ack=await api('/apply','POST',body),current=await api('/commands/'+body.command_id),get=await parse(request('/commands/'+body.command_id));
 for(const change of [v=>v.receipt.policy='origin-open-proposal-v1',v=>v.historical_evidence.item_links[0].native_item_id=randomUUID(),v=>v.historical_evidence.normalized_body.date='2026-10-17',v=>v.historical_evidence.source_evidence.total='77.00',v=>v.historical_evidence.transformations.reverse(),v=>v.current_document.items[0].detailed_description='Other initial content']){const v=structuredClone(current);change(v);assert.throws(()=>response(v,get),e=>e.status===502);}
 const stripped=response({...current,raw:'PRIVATE',receipt:{...ack.receipt,actor:'PRIVATE'},current_document:{...current.current_document,raw:'PRIVATE'}},get);assert.doesNotMatch(JSON.stringify(stripped),/PRIVATE|"actor"/);
});
test('055 strict paths, actor injection and confirmations reject unreviewed writes',async()=>{
 const p=await plan(await source()),body=bodyFor(p);for(const patch of [{source_id:'01'},{source_id:1},{policy:'v2'},{p_user_id:users.admin},{confirm_import:false},{duplicate_reviewed:false},{preview_hash:null}])await assert.rejects(()=>parse(request('/apply','POST',{...body,...patch})),e=>e.status===400);
 for(const path of ['?limit=26','?after=01','?q=a&q=b','/commands/not-uuid','/documents/'+randomUUID()+'/origin'])await assert.rejects(()=>parse(request(path)),e=>[400,404].includes(e.status));
 const r=await parse(request('/apply','POST',body));assert.equal(r.rpc,'erp_origin_proposal_import_apply_v2');assert.ok(Object.isFrozen(r.args));await assert.rejects(()=>execute({...r},{userId:users.admin,rpc}),e=>e.status===404);await assert.rejects(()=>execute(r,{userId:'bad',rpc}),e=>e.status===401);
 for(const role of ['vendas','financeiro','fiscal','consulta','estoque'])await assert.rejects(()=>api('/apply','POST',body,users[role]),e=>e.status===403);
});
test('055 lost commit stays recoverable by command; malformed ACK/abort never retries automatically',async()=>{
 const p=await plan(await source()),body=bodyFor(p),route=await parse(request('/apply','POST',body));let writes=0;
 await assert.rejects(()=>execute(route,{userId:users.admin,rpc:async(n,a)=>{writes++;await rpc(n,a);throw Error('PRIVATE');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const current=await api('/commands/'+body.command_id),before=await ledger();assert.equal((await api('/apply','POST',body)).replayed,true);assert.deepEqual(await ledger(),before);assert.equal(current.receipt.command_id,body.command_id);assert.equal(writes,1);
 const stop=new AbortController();let enter;const entered=new Promise(r=>enter=r);const pending=execute(route,{userId:users.admin,signal:stop.signal,rpc:()=>{writes++;enter();return new Promise(()=>{});}});await entered;stop.abort();await assert.rejects(()=>pending,e=>e.status===503);assert.equal(writes,2);
 await assert.rejects(()=>execute(route,{userId:users.admin,rpc:async()=>({raw:'PRIVATE'})}),e=>e.status===503&&!e.message.includes('PRIVATE'));
});
test('055 maximum 250-line read includes historical/current within bounded response and leaves effects empty',async()=>{
 const p=await plan(await source(x=>{x.itens=Array.from({length:250},(_,i)=>({...x.itens[0],quantidade:1,valor:0.01,desconto:i/1000000,descricaoDetalhada:'😀'.repeat(100)}));x.totalProdutos=2.5;x.total=2.5;x.desconto=0;x.outrasDespesas=0;x.parcelas=[];}));assert.equal(p.can_apply,true);const body=bodyFor(p);await api('/apply','POST',body);const got=await api('/commands/'+body.command_id);assert.equal(got.historical_evidence.item_links.length,250);assert.ok(Buffer.byteLength(JSON.stringify(got))<MAX);assert.equal(got.historical_evidence.source_evidence.items[249].discount_observed,'0.000249');const count=await ledger();assert.equal(count.stock,0);assert.equal(count.finance,0);
});
test('review055 next-contact evidence stays within the documented raw sentinel/date contract',async()=>{
 for(const value of [' 2026-11-01 ','   ']){const p=await preview(await source(x=>x.dataProximoContato=value));assert.equal(p.can_apply,false,'noncanonical evidence '+JSON.stringify(p.source_evidence?.next_contact));}
});
test('055 minimal document origin declares v1/v2 policy without exposing historical evidence',async()=>{
 const p=await plan(await source()),body=bodyFor(p),ack=await api('/apply','POST',body);
 for(const [id,policy]of [[legacyAck.receipt.document.id,'origin-open-proposal-v1'],[ack.receipt.document.id,'origin-open-proposal-v2']]){const r=await oldParse(new Request('https://example.invalid/v1/importacao-orcamentos-origin/documents/'+id+'/origin'));const out=await oldExecute(r,{userId:users.vendas,rpc});assert.equal(out.origin.policy,policy);assert.equal(out.origin.source_evidence,undefined);assert.equal(out.receipt,undefined);}
});
test('055 current accepts legacy omission after explicit commercial clearing; historical v2 stays complete',async()=>{
 const p=await plan(await source()),body=bodyFor(p);await api('/apply','POST',body);const first=await api('/commands/'+body.command_id),edit=editable(first.current_document);
 edit.commercial=null;edit.items.forEach(x=>x.detailed_description=null);edit.installments.forEach(x=>{x.note=null;x.payment_reference=null;});
 const save=(data,version)=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_proposals',p_id:first.current_document.id,p_expected_version:version,p_command_id:randomUUID(),p_body:data});
 const cleared=(await save(edit,1)).document,legacyBody=editable(cleared);delete legacyBody.commercial;legacyBody.items.forEach(x=>delete x.detailed_description);legacyBody.installments.forEach(x=>{delete x.note;delete x.payment_reference;});legacyBody.notes='Cliente legado após limpeza explícita';
 const saved=(await save(legacyBody,2)).document;assert.equal(saved.version,3);assert.equal(Object.hasOwn(saved,'commercial'),false);
 const got=await api('/commands/'+body.command_id);assert.equal(got.current_document.version,3);assert.equal(Object.hasOwn(got.current_document,'commercial'),false);assert.deepEqual(got.historical_evidence,first.historical_evidence);assert.equal(got.receipt.document.version,1);
});
test('052/055 mapped product with missing unit remains a valid blocked preview; applicable null unit is rejected',async()=>{
 const id=await source(legacy);await db.query('update erp_catalog.product set unit=null where record_id=$1',[product]);try{
 for(const [base,parseRoute,executeRoute]of [[BASE,parse,execute],['/v1/importacao-orcamentos-origin',oldParse,oldExecute]]){
  const route=await parseRoute(new Request('https://example.invalid'+base+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source_id:id})}));const result=await executeRoute(route,{userId:users.admin,rpc});assert.equal(result.can_apply,false);assert.equal(result.proposed,null);assert.equal(result.bindings[1].valid,true);assert.equal(result.bindings[1].unit,null);assert.ok(result.issues.some(x=>x.code==='PRODUCT_UNIT_MISMATCH'));
 }
 }finally{await db.query("update erp_catalog.product set unit='UN' where record_id=$1",[product]);}
 const p=await plan(await source()),route=await parse(request('/preview','POST',{source_id:p.source_id}));p.bindings[1].unit=null;assert.throws(()=>response(p,route),e=>e.status===502);
});
test('055 SQL→HTTP→UI accepts current edits, preserved evidence, v1 history and 250 items',async()=>{
 const ui=await import('../../../apps/erp/src/lib/origin-proposal-import-v2-model.ts'),oldUi=await import('../../../apps/erp/src/lib/origin-proposal-import-model.ts');
 for(const count of [1,250]){
  const id=await source(x=>{if(count===250){x.itens=Array.from({length:count},(_,i)=>({...x.itens[0],quantidade:1,valor:0.01,desconto:i/1000000}));x.totalProdutos=2.5;x.total=2.5;x.desconto=0;x.outrasDespesas=0;x.parcelas=[];}}),raw=await plan(id),preview=ui.checkedProposalV2Preview(raw,id),body=bodyFor(raw),ack=ui.checkedProposalV2Ack(await api('/apply','POST',body),body,preview),initialRaw=await api('/commands/'+body.command_id),initial=ui.checkedProposalV2Current(initialRaw,{request:body,preview,ack});
  assert.equal(initial.historical_evidence.item_links.length,count);assert.equal(initial.current_document.total,raw.proposed.totals.total);
  const edit=editable(initialRaw.current_document);edit.commercial=null;edit.items.forEach(x=>x.detailed_description=null);edit.installments.forEach(x=>{x.note=null;x.payment_reference=null;});
  const save=(data,version)=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_proposals',p_id:ack.receipt.document.id,p_expected_version:version,p_command_id:randomUUID(),p_body:data});
  const cleared=(await save(edit,1)).document,legacy=editable(cleared);delete legacy.commercial;legacy.items.forEach(x=>delete x.detailed_description);legacy.installments.forEach(x=>{delete x.note;delete x.payment_reference;});legacy.notes='Revisão posterior pelo cliente legado';await save(legacy,2);
  const latest=ui.checkedProposalV2Current(await api('/commands/'+body.command_id),{request:body,preview,ack});assert.equal(latest.current_document.version,3);assert.deepEqual(latest.historical_evidence,initial.historical_evidence);assert.deepEqual(ui.checkedProposalV2Ack(await api('/apply','POST',body),body,preview).receipt,ack.receipt);
 }
 const page=ui.checkedProposalV2Page(await api());assert.ok(page.items.length<=25);
 const id=await source(x=>x.contato.id='999'),blocked=ui.checkedProposalV2Preview(await plan(id),id);assert.equal(blocked.can_apply,false);assert.equal(blocked.source_evidence,null);
 const oldRoute=await oldParse(new Request('https://example.invalid/v1/importacao-orcamentos-origin/commands/'+legacyArgs.p_command_id)),old=oldUi.checkedProposalCurrent(await oldExecute(oldRoute,{userId:users.admin,rpc}),{commandId:legacyArgs.p_command_id});assert.equal(old.receipt.document.id,legacyAck.receipt.document.id);
});
