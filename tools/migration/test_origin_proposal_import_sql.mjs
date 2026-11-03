import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

// One embedded database, sequential scenarios. No network, production or Docker.
let db,contact,product,serial=9520000000;
const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
const code=wanted=>e=>e.code===wanted;
async function rpc(name,args){
 const entries=Object.entries(args);await db.exec('set role service_role');
 try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}
 finally{await db.exec('reset role');}
}
const preview=(id,actor=users.admin)=>rpc('erp_origin_proposal_import_preview',{p_user_id:actor,p_source_id:id});
const apply=(id,plan,command=randomUUID(),actor=users.admin,extra={})=>rpc('erp_origin_proposal_import_apply',{
 p_user_id:actor,p_source_id:id,p_preview_hash:plan.preview_hash,p_command_id:command,p_confirm_import:true,p_duplicate_reviewed:true,...extra});
const issue=(plan,name)=>plan.issues.some(i=>i.code===name);
async function stage(entity,id,payload){
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'synthetic_052',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'))",[entity,id,JSON.stringify(payload)]);
}
function fixture(id,patch={}){return {id,numero:52,data:'2026-10-16',situacao:'Pendente',contato:{id:'9521000001'},
 total:25.7,totalProdutos:25.7,desconto:0,outrasDespesas:0,totalOutrosItens:0,
 transporte:{frete:0,freteModalidade:9},itens:[{produto:{id:'9521000002',descricao:'Produto sintético'},codigo:'QA52',unidade:'UN',quantidade:2,valor:12.85,desconto:0,descricaoDetalhada:''}],
 parcelas:[],observacoes:'Condição comercial sintética',observacaoInterna:'Nota interna sintética',...patch};}
async function source(patch={},mutate){const id=String(++serial),p=fixture(id,patch);mutate?.(p);await stage('sales_proposals',id,p);return id;}
async function catalog(entity,id,payload){await stage(entity,id,payload);const r=await rpc('erp_catalog_import_origin',{p_user_id:users.admin,p_entity:entity,p_items:[{source_id:id,source_hash:await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id])}],p_command_id:randomUUID(),p_dry_run:false});return r.items[0].record_id;}
const ledger=()=>scalar("select jsonb_build_object('documents',(select count(*) from erp_documents.document),'items',(select count(*) from erp_documents.item),'commands',(select count(*) from erp_documents.command),'origins',(select count(*) from erp_documents.origin_import_origin),'audit',(select count(*) from erp_documents.audit),'numbers',(select jsonb_object_agg(kind,last_number) from erp_documents.numbering),'stock',(select count(*) from erp_stock.entry),'finance',(select count(*) from erp_finance.title))v");
before(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0052_origin_proposal_import'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','estoque','fiscal','consulta']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_052')");
 contact=await catalog('contacts','9521000001',{id:'9521000001',nome:'Contato fictício 052',situacao:'A',tipo:'J'});
 product=await catalog('products','9521000002',{id:'9521000002',nome:'Produto fictício 052',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:12.85});
});
after(()=>db?.close());

test('052 preview is read-only, derives exact links and preserves commercial values without effects',async()=>{
 const id=await source({outrasDespesas:1.01,total:26.71,parcelas:[{dataVencimento:'2026-11-15',numeroDias:30,valor:26.71,formaPagamento:{id:0},observacoes:''}]}),before=await ledger();
 await db.exec('begin read only');let p;try{p=await preview(id);}finally{await db.exec('rollback');}
 assert.deepEqual(p.issues,[]);assert.equal(p.can_apply,true);assert.equal(p.proposed.contact_id,contact);assert.equal(p.proposed.items[0].product_id,product);
 assert.equal(p.proposed.totals.total,'26.71');assert.equal(p.proposed.items[0].quantity,'2.000000');assert.equal(p.proposed.installments[0].amount,'26.71');assert.equal(p.proposed.installments[0].method,null);
 assert.equal(p.coverage_certified,false);assert.equal(p.cutoff_at,null);assert.equal(p.persisted,false);assert.deepEqual(await ledger(),before);
});
test('052 admits only three documented text situations; unknown, numeric and closed states never apply',async()=>{
 for(const status of ['Rascunho','Pendente','Aguardando','Aprovado','Concluído','Não aprovado','Em aberto',1,null]){
  const p=await preview(await source({situacao:status}));assert.equal(p.can_apply,['Rascunho','Pendente','Aguardando'].includes(status));
  if(!p.can_apply)assert.equal(issue(p,'STATUS_OUTSIDE_PROFILE'),true);
 }
});
test('052 documented empty reference objects are accepted without creating or matching a catalog',async()=>{
 const id=await source({loja:{id:0,unidadeNegocio:{id:0}},vendedor:{id:0},
  transporte:{frete:0,freteModalidade:9,contato:{id:0,nome:''},volumes:{id:0,servico:'',codigoRastreamento:''},quantidadeVolumes:0,pesoBruto:0,prazoEntrega:0}});
 assert.deepEqual((await preview(id)).issues,[]);
 for(const shape of [{id:'0'},{id:0,nome:'Transportador sem ID'},{id:0,email:'private@example.invalid'}]){
  const p=await preview(await source({},p=>p.transporte.contato=shape));assert.equal(issue(p,'TRANSPORT_FIELD_UNSUPPORTED'),true);
 }
});
test('052 absence, null, numeric strings, discounts, unsupported fields and mismatched totals remain explicit blockers',async()=>{
 const changes=[
  [p=>delete p.desconto,'DISCOUNT_UNSUPPORTED'],[p=>p.desconto=null,'DISCOUNT_UNSUPPORTED'],[p=>p.desconto=1,'DISCOUNT_UNSUPPORTED'],
  [p=>p.total='25.70','AMOUNTS_MISSING_OR_INVALID'],[p=>delete p.transporte.frete,'AMOUNTS_MISSING_OR_INVALID'],[p=>p.total=25.71,'SOURCE_TOTAL_MISMATCH'],
  [p=>p.totalProdutos=25.71,'SOURCE_TOTAL_MISMATCH'],[p=>p.itens[0].desconto=0.5,'DISCOUNT_UNSUPPORTED'],
  [p=>p.itens[0].quantidade=1.0000001,'ITEM_DECIMAL_INVALID'],[p=>p.itens[0].valor=1.00001,'ITEM_DECIMAL_INVALID'],
  [p=>p.itens[0].descricaoDetalhada='Texto adicional que não pode sumir','ITEM_DETAIL_UNSUPPORTED'],
  [p=>p.transporte.contato={id:123},'TRANSPORT_FIELD_UNSUPPORTED'],[p=>p.loja={id:12},'COMMERCIAL_REFERENCE_UNSUPPORTED'],
  [p=>p.transporte.frete=2,'TRANSPORT_CONFLICT'],[p=>p.itens[0].unidade='CX','PRODUCT_UNIT_MISMATCH'],
  [p=>p.introducao='Termo contratual','COMMERCIAL_FIELD_UNSUPPORTED'],[p=>p.novoCampoComercial=1,'SOURCE_FIELDS_UNSUPPORTED'],
  [p=>p.parcelas=[{valor:25.7,dataVencimento:'2026-11-15',formaPagamento:{id:17}}],'INSTALLMENT_FIELD_UNSUPPORTED'],
  [p=>p.parcelas=[{valor:25.7,dataVencimento:'2026-11-15',numeroDias:29}],'INSTALLMENT_DAYS_CONFLICT'],
  [p=>p.parcelas=[{valor:25.69,dataVencimento:'2026-11-15'}],'INSTALLMENT_TOTAL_MISMATCH'],
  [p=>p.data='2026-02-30','SOURCE_DATE_INVALID'],[p=>p.dataProximoContato='0000-00-00','SOURCE_DATE_INVALID'],
  [p=>p.observacoes='x'.repeat(4001),'SOURCE_TEXT_INVALID'],[p=>delete p.itens[0].produto.descricao,'ITEM_TEXT_INVALID']
 ];
 for(const[change,expected]of changes){const id=await source({},change),p=await preview(id);assert.equal(p.can_apply,false,expected);assert.equal(issue(p,expected),true,JSON.stringify(p.issues));await assert.rejects(()=>apply(id,p),code('40001'));}
});
test('052 exact IDs never fall back to matching name/code, inactive or edited catalog candidates',async()=>{
 for(const edit of [p=>p.contato.id='999',p=>p.itens[0].produto.id='999',p=>p.contato.id=['9521000001'],p=>p.itens[0].produto.id='09521000002']){
  const p=await preview(await source({},edit));assert.equal(p.can_apply,false);
 }
 const id=await source();
 for(const update of ["active=false","human_edited=true"]){
  await db.query(`update erp_catalog.record set ${update} where id=$1`,[product]);assert.equal(issue(await preview(id),'PRODUCT_MAPPING_UNAVAILABLE'),true);
  await db.query('update erp_catalog.record set active=true,human_edited=false where id=$1',[product]);
 }
 await db.query("update erp_catalog.origin set state='source_changed',candidate='{}' where record_id=$1",[contact]);assert.equal(issue(await preview(id),'CONTACT_MAPPING_UNAVAILABLE'),true);
 await db.query("update erp_catalog.origin set state='synced',candidate=null where record_id=$1",[contact]);
 await db.query("update erp_catalog.product set format='V' where record_id=$1",[product]);assert.equal(issue(await preview(id),'PRODUCT_MAPPING_UNAVAILABLE'),true);
 await db.query("update erp_catalog.product set format='S' where record_id=$1",[product]);
});
test('052 source observation/version/hash and catalog version are all CAS inputs',async()=>{
 for(const variant of ['seen','version','hash','parent']){
  const id=await source(),p=await preview(id),before=await ledger();
  if(variant==='parent')await db.query('update erp_catalog.record set version=version+1 where id=$1',[product]);
  else await db.query(`update origin_sync.raw_record set ${variant==='seen'?"last_seen_at=last_seen_at+interval '1 second'":variant==='version'?'version=version+1':"version_hash=repeat('a',64)"} where entity='sales_proposals' and source_id=$1`,[id]);
  await assert.rejects(()=>apply(id,p),code('40001'));assert.deepEqual(await ledger(),before);
 }
});
test('052 atomic create assigns local number, preserves line order, records origin and never updates an edited draft',async()=>{
 const id=await source(),p=await preview(id),command=randomUUID(),ack=await apply(id,p,command),docId=ack.receipt.document.id;
 assert.equal(ack.receipt.document.kind,'sales_proposals');assert.equal(ack.receipt.document.status,'draft');assert.equal(ack.receipt.document.version,1);assert.notEqual(ack.receipt.document.number,'52');
 const read=()=>rpc('erp_origin_proposal_import_command',{p_user_id:users.admin,p_command_id:command});
 const first=await read();assert.equal(first.current_document.source_proposal_id,null);assert.deepEqual(first.current_document.effect_flags,{finance_active:false,stock_active:false});
 const body={...p.proposed,notes:'Editado localmente depois da importação'};delete body.totals;
 body.items=body.items.map(({gross,discount,total,position,...item})=>item);body.installments=body.installments.map(({position,...item})=>item);
 await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_proposals',p_id:docId,p_expected_version:1,p_command_id:randomUUID(),p_body:body});
 const before=await ledger(),replay=await apply(id,p,command);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,ack.receipt);assert.deepEqual(await ledger(),before);
 const current=await read();assert.equal(current.receipt.document.version,1);assert.equal(current.current_document.version,2);assert.equal(current.current_document.notes,body.notes);
 const again=await preview(id);assert.equal(issue(again,'ALREADY_IMPORTED'),true);await assert.rejects(()=>apply(id,again),code('40001'));
 const origin=await rpc('erp_origin_proposal_import_origin',{p_user_id:users.admin,p_source_id:id});assert.equal(origin.current_document.version,2);
 for(const role of ['admin','vendas','financeiro','consulta'])assert.equal((await rpc('erp_origin_proposal_document_origin',{p_user_id:users[role],p_document_id:docId})).origin.source_id,id);
 for(const role of ['estoque','fiscal'])await assert.rejects(()=>rpc('erp_origin_proposal_document_origin',{p_user_id:users[role],p_document_id:docId}),code('42501'));
 assert.equal((await ledger()).stock,0);assert.equal((await ledger()).finance,0);
 await assert.rejects(()=>db.query('delete from erp_documents.origin_import_origin where document_id=$1',[docId]),code('42501'));
 await assert.rejects(()=>db.query('update erp_documents.command set result=result where command_id=$1',[command]),code('42501'));
});
test('052 command008 collision, actor/role checks and duplicate acknowledgement precede writes',async()=>{
 const id=await source(),p=await preview(id),command=randomUUID();await apply(id,p,command);
 for(const role of ['vendas','financeiro','consulta','estoque','fiscal']){
  await assert.rejects(()=>preview(id,users[role]),code('42501'));await assert.rejects(()=>apply(id,p,command,users[role]),code('42501'));
 }
 await db.query("update erp_access.membership set role='consulta' where user_id=$1",[users.admin]);
 await assert.rejects(()=>apply(id,p,command),code('42501'));await db.query("update erp_access.membership set role='admin' where user_id=$1",[users.admin]);
 const next=await source(),nextPlan=await preview(next);
 await assert.rejects(()=>apply(next,nextPlan,command),code('40001'));
 await assert.rejects(()=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_proposals',p_id:null,p_expected_version:0,p_command_id:command,p_body:{}}),code('40001'));
 await assert.rejects(()=>apply(next,nextPlan,randomUUID(),users.admin,{p_duplicate_reviewed:false}),code('22023'));
});
test('052 a failure after document/items creation rolls back origin, command, audit and numbering together',async()=>{
 const id=await source(),p=await preview(id),before=await ledger();
 await db.exec("create function public.qa052_fail() returns trigger language plpgsql as $$ begin if new.action='origin_import_proposal' then raise exception 'synthetic rollback' using errcode='23514';end if;return new;end $$;create trigger qa052_fail before insert on erp_documents.audit for each row execute function public.qa052_fail();");
 try{await assert.rejects(()=>apply(id,p),code('23514'));assert.deepEqual(await ledger(),before);}finally{await db.exec('drop trigger qa052_fail on erp_documents.audit;drop function public.qa052_fail()');}
});
test('052 preserves six/four decimal inputs and checks line rounding instead of accepting different source totals',async()=>{
 const id=await source({total:15.24,totalProdutos:15.24},p=>{p.itens[0].quantidade=1.234567;p.itens[0].valor=12.3456;});
 const p=await preview(id);assert.deepEqual(p.issues,[]);assert.equal(p.proposed.items[0].quantity,'1.234567');assert.equal(p.proposed.items[0].unit_price,'12.3456');assert.equal(p.proposed.items[0].total,'15.24');
 const lines=Array.from({length:250},(_,i)=>({...fixture('1').itens[0],codigo:String(i),quantidade:1,valor:0.01}));
 const max=await preview(await source({itens:lines,total:2.5,totalProdutos:2.5}));assert.equal(max.can_apply,true);assert.equal(max.proposed.items.length,250);assert.equal(max.proposed.items[249].position,250);
 assert.equal((await preview(await source({itens:[...lines,lines[0]]}))).can_apply,false);
});
test('052 RLS and grants isolate direct tables/helpers while service-only RPCs remain explicit',async()=>{
 assert.equal(await scalar("select relrowsecurity v from pg_class where oid='erp_documents.origin_import_origin'::regclass"),true);
 const funcs=await scalar("select jsonb_agg(jsonb_build_object('name',p.proname,'anon',has_function_privilege('anon',p.oid,'execute'),'auth',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute')))v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'erp_origin_proposal_%'");
 assert.equal(funcs.length,6);for(const f of funcs)assert.deepEqual([f.anon,f.auth,f.service],[false,false,true]);
 assert.equal(await scalar("select has_table_privilege('service_role','erp_documents.origin_import_origin','select')v"),false);
 assert.equal(await scalar("select has_function_privilege('service_role','erp_documents.origin_proposal_plan(uuid,text)','execute')v"),false);
 const evidence=await scalar("select jsonb_agg(evidence)v from erp_documents.origin_import_origin");assert.doesNotMatch(JSON.stringify(evidence),/document_links|numeroDocumento|@|payload/);
});
test('052 discovery paginates exact IDs and literal search without exposing raw data or implying eligibility',async()=>{
 const list=args=>rpc('erp_origin_proposal_import_sources',{p_user_id:users.admin,...args});
 const first=await list({});assert.equal(first.items.length,25);assert.equal(first.has_more,true);assert.equal(first.next_cursor,first.items.at(-1).source_id);
 const second=await list({p_after:first.next_cursor});assert.equal(first.items.some(a=>second.items.some(b=>a.source_id===b.source_id)),false);
 assert.ok(first.items.every(i=>i.requires_preview));assert.doesNotMatch(JSON.stringify(first),/payload|contato|observacaoInterna|PRIVATE/);
 assert.equal((await list({p_query:'%'})).items.length,0);assert.equal((await list({p_query:first.items[0].source_id})).items[0].source_id,first.items[0].source_id);
 await assert.rejects(()=>list({p_limit:26}),code('22023'));
});
