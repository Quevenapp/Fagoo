import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {ORIGIN_PROPOSAL_IMPORT_BASE as BASE,ORIGIN_PROPOSAL_IMPORT_RESPONSE_BYTES,ORIGIN_PROPOSAL_IMPORT_ISSUES,parseOriginProposalImportRoute as parse,executeOriginProposalImportRoute as execute,originProposalImportResponse as response,originProposalImportRoute,originProposalImportMethods} from '../src/origin-proposal-import.mjs';

let db,contact,product,serial=9522000000;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args){
 const entries=Object.entries(args);assert.match(name,/^erp_[a-z_]+$/);for(const[k]of entries)assert.match(k,/^p_[a-z_]+$/);
 await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}
}
const request=(path='',method='GET',data)=>new Request('https://example.invalid'+BASE+path,{method,...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});
const api=async(path='',method='GET',data,user=users.admin)=>execute(await parse(request(path,method,data)),{userId:user,rpc});
const fixture=id=>({id,numero:52,data:'2026-10-16',situacao:'Pendente',contato:{id:'9521000001'},total:25.7,totalProdutos:25.7,desconto:0,outrasDespesas:0,totalOutrosItens:0,
 itens:[{produto:{id:'9521000002',descricao:'Produto fictício'},codigo:'QA-052',unidade:'UN',quantidade:2,valor:12.85,desconto:0}],parcelas:[],transporte:{frete:0,freteModalidade:9}});
async function stage(entity,id,payload){await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'synthetic_052_api',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'))",[entity,id,JSON.stringify(payload)]);}
async function source(edit=()=>{}){const id=String(++serial),p=fixture(id);edit(p);await stage('sales_proposals',id,p);return id;}
async function catalog(entity,id,payload){await stage(entity,id,payload);const s=await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id]);const result=await rpc('erp_catalog_import_origin',{p_user_id:users.admin,p_entity:entity,p_items:[{source_id:id,source_hash:s}],p_command_id:randomUUID(),p_dry_run:false});return result.items[0].record_id;}
const plan=id=>api('/preview','POST',{source_id:id});
const applyBody=(p,command=randomUUID())=>({source_id:p.source_id,preview_hash:p.preview_hash,command_id:command,confirm_import:true,duplicate_reviewed:true});
const ledger=()=>scalar("select jsonb_build_object('documents',(select count(*) from erp_documents.document),'commands',(select count(*) from erp_documents.command),'origins',(select count(*) from erp_documents.origin_import_origin),'numbers',(select jsonb_object_agg(kind,last_number)from erp_documents.numbering),'stock',(select count(*)from erp_stock.entry),'finance',(select count(*)from erp_finance.title))v");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0052_origin_proposal_import'])await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','estoque','fiscal','consulta']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_052_api')");
 contact=await catalog('contacts','9521000001',{id:'9521000001',nome:'Contato fictício 052',situacao:'A',tipo:'J'});
 product=await catalog('products','9521000002',{id:'9521000002',nome:'Produto fictício 052',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:12.85});
});
after(()=>db?.close());

test('read-only SQL preview projects exact bindings, money, decimals and optional fields',async()=>{
 const id=await source(p=>{p.outrasDespesas=1.01;p.total=26.71;p.parcelas=[{valor:26.71,dataVencimento:'2026-11-15',numeroDias:30}];p.observacoes='Texto\ncomercial';}),before=await ledger();
 const p=await plan(id);assert.equal(p.can_apply,true);assert.deepEqual(p.issues,[]);assert.equal(p.proposed.contact_id,contact);assert.equal(p.proposed.items[0].product_id,product);
 assert.equal(p.proposed.totals.total,'26.71');assert.equal(p.proposed.items[0].quantity,'2.000000');assert.equal(p.proposed.installments[0].amount,'26.71');assert.equal(p.proposed.notes,'Texto\ncomercial');
 assert.deepEqual([p.creates_draft,p.financial_effects,p.stock_effects,p.fiscal_effects],[true,false,false,false]);assert.deepEqual(await ledger(),before);
});
test('blocked SQL previews retain unavailable mappings and fixed issues, never a partial proposed document',async()=>{
 for(const change of [p=>p.contato.id='999',p=>p.itens[0].produto.id='999',p=>p.itens[0].produto.id=null,p=>p.situacao='Concluído',p=>p.desconto=null,p=>p.total=1,p=>p.transporte.freteModalidade=1,p=>p.parcelas=[{valor:25.7,dataVencimento:'2026-11-15',numeroDias:1}],p=>p.itens=[null],p=>p.itens=[]]){
  const id=await source(change),p=await plan(id);assert.equal(p.can_apply,false);assert.equal(p.proposed,null);assert.ok(p.issues.length);assert.ok(p.issues.every(i=>ORIGIN_PROPOSAL_IMPORT_ISSUES.includes(i.code)));
  await assert.rejects(()=>api('/apply','POST',applyBody(p)),e=>e.status===409&&e.code==='ERP_CONFLICT');
 }
});
test('apply only creates a draft, receipt is historical, GET current survives edit and exact replay',async()=>{
 const p=await plan(await source()),input=applyBody(p),ack=await api('/apply','POST',input),id=ack.receipt.document.id;
 assert.equal(ack.receipt.document.status,'draft');assert.equal(ack.receipt.document.version,1);assert.equal(ack.replayed,false);assert.equal(ack.current_document,undefined);
 const first=await api('/commands/'+input.command_id);assert.equal(first.current_document.id,id);assert.equal(first.current_document.notes,null);
 const body={...p.proposed,notes:'Alteração posterior',date:'2026-10-17'};delete body.totals;body.items=body.items.map(({gross,discount,total,position,...row})=>row);body.installments=body.installments.map(({position,...row})=>row);
 await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_proposals',p_id:id,p_expected_version:1,p_command_id:randomUUID(),p_body:body});
 const before=await ledger(),current=await api('/origins/'+p.source_id),replay=await api('/apply','POST',input);
 assert.equal(current.current_document.version,2);assert.equal(current.current_document.notes,body.notes);assert.equal(current.current_document.date,'2026-10-17');assert.deepEqual(current.receipt,ack.receipt);assert.deepEqual(replay.receipt,ack.receipt);assert.equal(replay.replayed,true);assert.deepEqual(await ledger(),before);
 const blocked=await plan(p.source_id);assert.equal(blocked.existing.document_id,id);assert.ok(blocked.issues.some(i=>i.code==='ALREADY_IMPORTED'));
 assert.equal(before.finance,0);assert.equal(before.stock,0);
});
test('document origin is minimal under document ACL; administrative staging and replay remain admin-only',async()=>{
 const p=await plan(await source()),body=applyBody(p),done=await api('/apply','POST',body),id=done.receipt.document.id;
 for(const role of ['admin','vendas','financeiro','consulta']){const v=await api('/documents/'+id.toUpperCase()+'/origin','GET',undefined,users[role]);assert.equal(v.document_id,id);assert.equal(v.origin.source_id,p.source_id);assert.equal(v.origin.system,'origin');assert.equal(v.receipt,undefined);assert.equal(v.current_document,undefined);}
 for(const role of ['estoque','fiscal'])await assert.rejects(()=>api('/documents/'+id+'/origin','GET',undefined,users[role]),e=>e.status===403);
 for(const role of ['vendas','financeiro','consulta','estoque','fiscal'])for(const[path,method,data]of [['','GET'],['/preview','POST',{source_id:p.source_id}],['/apply','POST',body],['/commands/'+body.command_id,'GET']])await assert.rejects(()=>api(path,method,data,users[role]),e=>e.status===403);
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.admin]);try{await assert.rejects(()=>api('/apply','POST',body),e=>e.status===403);}finally{await db.query('update erp_access.membership set active=true where user_id=$1',[users.admin]);}
});
test('source list paginates canonical IDs without duplicates and treats search literally',async()=>{
 for(let i=0;i<27;i++)await source();const before=await ledger(),a=await api('?limit=25'),b=await api('?limit=25&after='+a.next_cursor);
 assert.equal(a.items.length,25);assert.equal(a.has_more,true);assert.equal(a.next_cursor,a.items.at(-1).source_id);assert.equal(a.items.some(x=>b.items.some(y=>x.source_id===y.source_id)),false);
 assert.ok(a.items.every(x=>x.requires_preview===true&&x.can_apply===undefined));assert.equal((await api('?q=%25')).items.length,0);assert.deepEqual(await ledger(),before);
});
test('strict routes, body limits, canonical source IDs and explicit confirmations',async()=>{
 assert.equal(await parse(new Request('https://example.invalid/v1/other')),null);assert.equal(originProposalImportRoute(BASE),true);assert.deepEqual(originProposalImportMethods(BASE+'/apply'),['POST']);
 const p=await plan(await source()),input=applyBody(p),post=(v,method='POST')=>parse(request('/apply',method,v));
 for(const patch of [{source_id:1},{source_id:'01'},{source_id:'1'.repeat(41)},{source_id:['1']},{command_id:null},{preview_hash:'X'.repeat(64)},{confirm_import:false},{duplicate_reviewed:false},{actor:users.admin},{data:{total:'0'}}])await assert.rejects(()=>post({...input,...patch}),e=>e.status===400);
 for(const path of ['?limit=0','?limit=26','?limit=01','?limit=1&limit=1','?status=draft','?after=01','?q='+encodeURIComponent('\u0001'),'/commands/bad','/origins/01','/origins/%31','/documents/'+randomUUID()+'/origin?raw=true'])await assert.rejects(()=>parse(request(path)),e=>[400,404].includes(e.status));
 await assert.rejects(()=>parse(request('/preview','GET')),e=>e.status===405);await assert.rejects(()=>parse(request('/preview?x=1','POST',{source_id:p.source_id})),e=>e.status===400);
 await assert.rejects(()=>parse(new Request('https://example.invalid'+BASE+'/apply',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(4097)})),e=>e.status===413);
 await assert.rejects(()=>parse(new Request('https://example.invalid'+BASE+'/apply',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:'{}'})),e=>e.status===400);
 await assert.rejects(()=>parse(new Request('https://example.invalid'+BASE+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([0xff])})),e=>e.status===400);
 const r=await parse(request('/apply','POST',{...input,command_id:input.command_id.toUpperCase()}));assert.equal(r.args.p_command_id,input.command_id);assert.ok(Object.isFrozen(r.args));assert.throws(()=>r.args.p_source_id='1',TypeError);
 await assert.rejects(()=>execute({...r},{userId:users.admin,rpc}),e=>e.status===404);await assert.rejects(()=>execute(r,{userId:'bad',rpc:()=>assert.fail()}),e=>e.status===401);
});
test('preview rejects mismatched or fabricated mapping, totals, claims and issue fields; strips private extras',async()=>{
 const p=await plan(await source()),route=await parse(request('/preview','POST',{source_id:p.source_id}));
 for(const change of [v=>v.source_id='1',v=>v.source_version='9223372036854775808',v=>v.can_apply=false,v=>v.proposed.totals.total='0.00',v=>v.proposed.items[0].product_id=randomUUID(),v=>v.bindings[1].record_id=randomUUID(),v=>v.bindings[1].unit='KG',v=>v.bindings[1].active=false,v=>v.bindings[0].applied_hash='a'.repeat(64),v=>v.proposed.items[0].discount_percent='1.0000',v=>v.proposed.items[0].id=randomUUID(),v=>v.proposed.payment_terms='Não veio da origem',v=>v.source_seen_at='2026-02-30T10:00:00Z',v=>v.financial_effects=true,v=>v.warnings.push('RAW'),v=>v.issues.push({code:'RAW',field:'payload',position:null})]){const v=structuredClone(p);change(v);assert.throws(()=>response(v,route),e=>e.status===502);}
 const v=structuredClone(p);v.secret='PRIVATE';v.bindings[0].payload='PRIVATE';v.proposed.raw='PRIVATE';v.proposed.items[0].raw='PRIVATE';assert.doesNotMatch(JSON.stringify(response(v,route)),/PRIVATE|payload/);
 const blocked=await plan(await source(x=>x.contato.id='999')),broute=await parse(request('/preview','POST',{source_id:blocked.source_id}));blocked.proposed=p.proposed;assert.throws(()=>response(blocked,broute),e=>e.status===502);
});
test('receipt/current binding rejects wrong source, command, document, timestamps and premature status',async()=>{
 const p=await plan(await source()),body=applyBody(p),ack=await api('/apply','POST',body),post=await parse(request('/apply','POST',body)),read=await parse(request('/commands/'+body.command_id)),current=await api('/commands/'+body.command_id);
 for(const change of [v=>v.receipt.command_id=randomUUID(),v=>v.receipt.source_id='1',v=>v.receipt.preview_hash='a'.repeat(64),v=>v.receipt.document.version=2,v=>v.receipt.document.status='approved',v=>v.receipt.imported_at='2026-09-31T10:00:00Z']){const v=structuredClone(ack);change(v);assert.throws(()=>response(v,post),e=>e.status===502);}
 for(const change of [v=>v.current_document.id=randomUUID(),v=>v.current_document.number='999',v=>v.current_document.version=0,v=>v.current_document.source_proposal_id=randomUUID(),v=>v.current_document.totals.total='0.00',v=>v.current_document.status='approved']){const v=structuredClone(current);change(v);assert.throws(()=>response(v,read),e=>e.status===502);}
 const stripped=response({...current,raw:'PRIVATE',receipt:{...current.receipt,actor:users.admin,raw:'PRIVATE'},current_document:{...current.current_document,raw:'PRIVATE'}},read);assert.doesNotMatch(JSON.stringify(stripped),/PRIVATE|"actor"/);
});
test('CAS conflicts and domain failures use safe codes without upstream diagnostics',async()=>{
 const p=await plan(await source()),body=applyBody(p),route=await parse(request('/apply','POST',body));await db.query("update origin_sync.raw_record set last_seen_at=last_seen_at+interval '1 second' where entity='sales_proposals' and source_id=$1",[p.source_id]);
 await assert.rejects(()=>execute(route,{userId:users.admin,rpc}),e=>e.status===409&&e.code==='ERP_CONFLICT');
 for(const[error,status,code]of [[{code:'22023',message:'PRIVATE'},422,'ERP_VALIDATION_FAILED'],[{code:'42501',detail:'PRIVATE'},403,'ERP_FORBIDDEN'],[{code:'40001'},409,'ERP_CONFLICT'],[{code:'P0002'},404,'ERP_NOT_FOUND'],[new Error('PRIVATE'),503,'ERP_RESULT_UNCONFIRMED']])await assert.rejects(()=>execute(route,{userId:users.admin,rpc:async()=>{throw error;}}),e=>e.status===status&&e.code===code&&!e.message.includes('PRIVATE'));
});
test('lost apply ACK uses command lookup and exact replay, never a second import',async()=>{
 const p=await plan(await source()),body=applyBody(p),route=await parse(request('/apply','POST',body));let calls=0;
 await assert.rejects(()=>execute(route,{userId:users.admin,rpc:async(name,args)=>{calls++;await rpc(name,args);throw new Error('lost response');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const current=await api('/commands/'+body.command_id),before=await ledger(),replay=await api('/apply','POST',body);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,current.receipt);assert.deepEqual(await ledger(),before);assert.equal(calls,1);
 await assert.rejects(()=>api('/commands/'+randomUUID()),e=>e.status===404);const other=await source();await assert.rejects(()=>api('/apply','POST',{...body,source_id:other}),e=>e.status===409);
});
test('abort before dispatch sends nothing; after dispatch or invalid ACK stays uncertain, reads do not retry',async()=>{
 const p=await plan(await source()),route=await parse(request('/apply','POST',applyBody(p))),stop=new AbortController();stop.abort();let calls=0;
 await assert.rejects(()=>execute(route,{userId:users.admin,signal:stop.signal,rpc:()=>calls++}),e=>e.status===400);assert.equal(calls,0);
 const active=new AbortController();let entered;const began=new Promise(resolve=>entered=resolve);const pending=execute(route,{userId:users.admin,signal:active.signal,rpc:()=>{calls++;entered();return new Promise(()=>{});}});await began;active.abort();await assert.rejects(()=>pending,e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');assert.equal(calls,1);
 await assert.rejects(()=>execute(route,{userId:users.admin,timeoutMs:5,rpc:()=>new Promise(()=>{})}),e=>e.status===503);
 await assert.rejects(()=>execute(route,{userId:users.admin,rpc:async()=>({raw:'PRIVATE'})}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const read=await parse(request('/preview','POST',{source_id:p.source_id}));await assert.rejects(()=>execute(read,{userId:users.admin,rpc:async()=>{throw new Error('PRIVATE');}}),e=>e.status===502&&e.code==='ERP_UPSTREAM_UNAVAILABLE');
});
test('maximum 250-line Unicode proposal and exact six/four decimals fit the bounded API',async()=>{
 const id=await source(p=>{p.itens=Array.from({length:250},(_,i)=>({...p.itens[0],produto:{...p.itens[0].produto,descricao:'😀'.repeat(200)},codigo:String(i),quantidade:1.234567,valor:12.3456}));p.totalProdutos=3810;p.total=3810;p.observacoes='📝'.repeat(4000);});
 const p=await plan(id);assert.equal(p.can_apply,true);assert.equal(p.proposed.items.length,250);assert.equal(p.proposed.items[0].quantity,'1.234567');assert.equal(p.proposed.items[0].unit_price,'12.3456');assert.equal(p.proposed.items[249].total,'15.24');
 assert.ok(new TextEncoder().encode(JSON.stringify(p)).length<ORIGIN_PROPOSAL_IMPORT_RESPONSE_BYTES);
 const ack=await api('/apply','POST',applyBody(p)),read=await api('/commands/'+ack.receipt.command_id);assert.equal(read.current_document.items[0].description,'😀'.repeat(200));assert.equal(read.current_document.notes,'📝'.repeat(4000));
});
test('issue allowlist matches applied SQL and list validates literal query, ordering and cursor',async()=>{
 const sql=await readFile(new URL('../../../supabase/migrations/202610160052_origin_proposal_import.sql',import.meta.url),'utf8');
 const emitted=[...new Set([...sql.matchAll(/origin_import_issue\('([A-Z_]+)'/g)].map(m=>m[1]))].sort();assert.deepEqual([...ORIGIN_PROPOSAL_IMPORT_ISSUES].sort(),emitted);
 const page=await api('?limit=2'),route=await parse(request('?limit=2'));
 for(const change of [v=>v.next_cursor='1',v=>v.items.reverse(),v=>v.items[0].requires_preview=false,v=>v.items[0].source_id='01',v=>v.items[0].source_version=1]){const v=structuredClone(page);change(v);assert.throws(()=>response(v,route),e=>e.status===502);}
 const mismatch=await parse(request('?limit=2&q=never-matches'));assert.throws(()=>response(page,mismatch),e=>e.status===502);
 const id=await source(),planRoute=await parse(request('/preview','POST',{source_id:id})),p=await plan(id);p.source_version='9223372036854775807';p.source_seen_at='2026-10-16T17:00:00.123456-03:00';assert.equal(response(p,planRoute).source_version,p.source_version);
});
test('independent SQL to HTTP to UI interop preserves preview, blocked issues and historical/current identities',async()=>{
 const {checkedProposalPage,checkedProposalPreview,checkedProposalAck,checkedProposalCurrent}=await import('../../../apps/erp/src/lib/origin-proposal-import-model.ts');
 const id=await source(),raw=await plan(id),preview=checkedProposalPreview(raw,id),body=applyBody(raw),ack=checkedProposalAck(await api('/apply','POST',body),body,preview);
 const current=checkedProposalCurrent(await api('/commands/'+body.command_id),{request:body,preview,ack});assert.equal(current.receipt.document.id,ack.receipt.document.id);assert.equal(current.current_document.version,1);assert.equal(current.current_document.total,raw.proposed.totals.total);
 const page=checkedProposalPage(await api());assert.ok(page.items.length<=25);
 const blockedId=await source(p=>{p.situacao='Concluído';p.itens=Array.from({length:50},()=>({...p.itens[0],desconto:1}));});const blocked=checkedProposalPreview(await plan(blockedId),blockedId);assert.ok(blocked.issues.length>=50);assert.equal(blocked.can_apply,false);assert.equal(blocked.proposed,null);
});
