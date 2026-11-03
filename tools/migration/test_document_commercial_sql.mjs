import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {normalizeDocument} from '../../packages/erp-domain/src/index.mjs';
import {documentsResponse} from '../../workers/erp-api/src/documents.mjs';
import {documentCopyResponse} from '../../workers/erp-api/src/document-copy.mjs';
import {documentServiceConversionResponse} from '../../workers/erp-api/src/document-service-conversion.mjs';
import {originProposalImportResponse} from '../../workers/erp-api/src/origin-proposal-import.mjs';
let db,contact,product,oldBody,oldResult,oldCommand,legacyNormalized,oldImportArgs,oldImportReceipt,oldImportPlan;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v,code=c=>e=>e.code===c;
async function rpc(name,args){const entries=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const ref=()=>({system:'origin',source_id:'1234567890123456789012345678901234567890',label:'Referência sintética'});
const commercial=()=>({introduction:'Introdução\ncomercial',attention_to:'Pessoa sintética',seller_reference:ref(),store_reference:null,business_unit_reference:ref(),transport:{freight_mode:'0',volume_count:'2.000001',gross_weight:'999999999999.999999',delivery_days:'0',carrier_reference:ref(),service_reference:ref(),tracking_code:'QA-SYNTHETIC'}});
const body=(extra={})=>({date:'2026-10-16',contact_id:contact,commercial:commercial(),items:[{product_id:product,description:'Produto fictício',detailed_description:'Detalhe\ncomercial',code:'QA054',unit:'UN',quantity:'2.5',unit_price:'40',discount_percent:'0'}],discount_mode:'amount',discount_value:'2',freight:'0',other_expenses:'3',installments:[{due_date:'2026-11-16',amount:'101',method:null,note:'Parcela sintética',payment_reference:ref()}],...extra});
const save=(kind='sales_proposals',data=body(),doc=null,command=randomUUID(),actor=users.admin)=>rpc('erp_document_save',{p_user_id:actor,p_kind:kind,p_id:doc?.id??null,p_expected_version:doc?.version??0,p_command_id:command,p_body:data});
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Conferência sintética'})).document;
function input(d){const out={};for(const k of ['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','discount_mode','discount_value','freight','other_expenses','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial'])if(Object.hasOwn(d,k))out[k]=d[k];out.items=d.items.map(({gross,discount,total,position,product_snapshot,...row})=>row);out.installments=d.installments.map(({position,...row})=>row);return out;}
const norm=(v,kind='sales_proposals')=>scalar('select erp_documents.normalize($1,$2::jsonb)v',[kind,JSON.stringify(v)]);
const snapshot=()=>scalar("select jsonb_build_object('docs',(select count(*) from erp_documents.document),'items',(select count(*) from erp_documents.item),'commands',(select count(*) from erp_documents.command),'audit',(select count(*) from erp_documents.audit),'numbers',(select jsonb_object_agg(kind,last_number) from erp_documents.numbering),'titles',(select count(*) from erp_finance.title),'stock',(select count(*) from erp_stock.entry),'origins',(select count(*) from erp_documents.origin_import_origin))v");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0032_proposal_service_conversion','0034_document_copy','0052_origin_proposal_import'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','estoque','consulta']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato sintético'}})).record.id;
 product=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto sintético',unit:'UN',price:'40',kind:'P',format:'S'}})).record.id;
 oldBody=body();delete oldBody.commercial;delete oldBody.items[0].detailed_description;delete oldBody.installments[0].note;delete oldBody.installments[0].payment_reference;
 legacyNormalized=await norm(oldBody);oldCommand=randomUUID();oldResult=await save('sales_proposals',oldBody,null,oldCommand);
 await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_054')");
 const stage=async(entity,id,payload)=>db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'synthetic_054',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'))",[entity,id,JSON.stringify(payload)]);
 for(const [entity,id,payload]of [['contacts','95401',{id:'95401',nome:'Contato de origem sintético',situacao:'A',tipo:'J'}],['products','95402',{id:'95402',nome:'Produto de origem sintético',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:40}]]){await stage(entity,id,payload);await rpc('erp_catalog_import_origin',{p_user_id:users.admin,p_entity:entity,p_items:[{source_id:id,source_hash:await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id])}],p_command_id:randomUUID(),p_dry_run:false});}
 await stage('sales_proposals','95403',{id:'95403',numero:54,data:'2026-10-16',situacao:'Rascunho',contato:{id:'95401'},total:40,totalProdutos:40,desconto:0,outrasDespesas:0,transporte:{frete:0,freteModalidade:9},itens:[{produto:{id:'95402',descricao:'Item sintético legado'},codigo:'QA054',unidade:'UN',quantidade:1,valor:40,desconto:0}],parcelas:[]});
 oldImportPlan=await rpc('erp_origin_proposal_import_preview',{p_user_id:users.admin,p_source_id:'95403'});assert.equal(oldImportPlan.can_apply,true);
 oldImportArgs={p_user_id:users.admin,p_source_id:'95403',p_preview_hash:oldImportPlan.preview_hash,p_command_id:randomUUID(),p_confirm_import:true,p_duplicate_reviewed:true};oldImportReceipt=await rpc('erp_origin_proposal_import_apply',oldImportArgs);
 await db.exec(await readFile(new URL('../../supabase/migrations/202610160054_document_commercial.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
test('054 preserves old normalization, command hashes/replays and absent extension shapes',async()=>{
 assert.deepEqual(await norm(oldBody),legacyNormalized);assert.deepEqual(await save('sales_proposals',oldBody,null,oldCommand),{...oldResult,replayed:true});
 assert.equal(Object.hasOwn(oldResult.document,'commercial'),false);assert.equal(Object.hasOwn(oldResult.document.items[0],'detailed_description'),false);
 assert.deepEqual(await norm(oldBody),normalizeDocument('sales_proposals',oldBody));
});
test('054 preserves an applied052 receipt and old replay even after the native draft receives new fields',async()=>{
 const first=await rpc('erp_origin_proposal_import_command',{p_user_id:users.admin,p_command_id:oldImportArgs.p_command_id}),d=first.current_document;
 const v=input(d);v.commercial=commercial();v.items[0].detailed_description='Detalhe acrescentado depois da importação';
 const updated=(await save(d.kind,v,d)).document;assert.equal(updated.version,2);
 assert.deepEqual(await rpc('erp_origin_proposal_import_apply',oldImportArgs),{...oldImportReceipt,replayed:true});
 const read=await rpc('erp_origin_proposal_import_command',{p_user_id:users.admin,p_command_id:oldImportArgs.p_command_id});assert.deepEqual(read.receipt,oldImportReceipt.receipt);assert.deepEqual(read.current_document.commercial,updated.commercial);
 const projected=originProposalImportResponse(read,{type:'command',args:{p_command_id:oldImportArgs.p_command_id}});assert.deepEqual(projected.current_document.commercial,updated.commercial);assert.equal(projected.current_document.items[0].detailed_description,updated.items[0].detailed_description);assert.deepEqual(projected.receipt,read.receipt);
 assert.equal(read.receipt.document.version,1);assert.equal(read.current_document.version,2);assert.equal((await snapshot()).origins,1);
});
test('054 SQL/domain parity covers all kinds, explicit null, zero, exact bounds and Unicode',async()=>{
 const v=body();v.commercial.introduction=' '+ '🧪'.repeat(4000)+' ';v.commercial.seller_reference.label=' '+ '🧪'.repeat(200)+' ';v.items[0].detailed_description=' '+ 'x'.repeat(4000)+' ';v.installments[0].note=' '+ '🧪'.repeat(2000)+' ';
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders'])assert.deepEqual(await norm(v,kind),normalizeDocument(kind,v));
 v.commercial.transport={...v.commercial.transport,volume_count:null,gross_weight:'0',delivery_days:null};assert.deepEqual(await norm(v),normalizeDocument('sales_proposals',v));
 v.commercial=null;v.items[0].detailed_description=null;v.installments[0].note=null;v.installments[0].payment_reference=null;assert.deepEqual(await norm(v),normalizeDocument('sales_proposals',v));
});
test('054 rejects malformed references, omissions, unsupported historic assertions and excessive values consistently',async()=>{
 const changes=[v=>delete v.commercial.introduction,v=>v.commercial.transport={},v=>v.commercial.seller_reference.source_id='01',v=>v.commercial.seller_reference.source_id=1,v=>v.commercial.seller_reference.source_id='1'.repeat(41),v=>v.commercial.seller_reference.verified=true,v=>v.commercial.transport.freight_mode=0,v=>v.commercial.transport.freight_mode='7',v=>v.commercial.transport.volume_count='0.0000001',v=>v.commercial.transport.gross_weight='1000000000000',v=>v.commercial.transport.delivery_days='1000000',v=>v.commercial.transport.delivery_days='00',v=>v.commercial.attention_to='A\nB',v=>v.commercial.introduction='x'.repeat(4001),v=>v.items[0].detailed_description='x'.repeat(4001),v=>v.installments[0].note='x'.repeat(2001),v=>v.installments[0].payment_reference={source_id:'1'},v=>v.items[0].original_discount='10',v=>v.source_evidence={},v=>{v.commercial.transport.freight_mode='9';v.freight='1';v.installments=[];}];
 for(const change of changes){const v=body();change(v);assert.throws(()=>normalizeDocument('sales_proposals',v));await assert.rejects(()=>norm(v),code('22023'));}
});
test('054 save/read preserves fields; legacy omission rejects atomically and explicit null clears intentionally',async()=>{
 const d=(await save()).document,before=await snapshot();
 for(const mutate of [v=>delete v.commercial,v=>delete v.items[0].detailed_description,v=>delete v.installments[0].note,v=>delete v.installments[0].payment_reference]){const v=input(d);mutate(v);await assert.rejects(()=>save(d.kind,v,d),code('40001'));assert.deepEqual(await snapshot(),before);}
 const current=(await rpc('erp_document_get',{p_user_id:users.vendas,p_kind:d.kind,p_id:d.id})).document;assert.deepEqual(current,d);
 const projected=documentsResponse({kind:d.kind,document:current,data_mode:'erp_native',operational_effects:false},{kind:d.kind,id:d.id},{type:'document'}).document;assert.deepEqual(projected.commercial,d.commercial);assert.deepEqual(projected.installments,d.installments);assert.equal(projected.items[0].detailed_description,d.items[0].detailed_description);
 const cleared=input(d);cleared.commercial=null;cleared.items[0].detailed_description=null;cleared.installments[0].note=null;cleared.installments[0].payment_reference=null;
 const updated=(await save(d.kind,cleared,d)).document;assert.equal(updated.version,2);assert.equal(updated.commercial,null);assert.equal(updated.items[0].detailed_description,null);
 await assert.rejects(()=>save(d.kind,input(d),d),code('40001'));assert.equal((await snapshot()).titles,0);assert.equal((await snapshot()).stock,0);
});
test('054 guard also protects line-only and installment-only extensions from old clients',async()=>{
 for(const variant of ['line','installment','commercial']){const v=structuredClone(oldBody);if(variant==='line')v.items[0].detailed_description='Dado a preservar';if(variant==='installment')v.installments[0].payment_reference=ref();if(variant==='commercial')v.commercial=commercial();const d=(await save('sales_proposals',v)).document;await assert.rejects(()=>save(d.kind,structuredClone(oldBody),d),code('40001'));}
});
test('054 copy preserves commercial/details and explicitly resets installments, with fresh line IDs and no source evidence',async()=>{
 const d=(await save()).document,view=await rpc('erp_document_copy_preview',{p_user_id:users.admin,p_kind:d.kind,p_source_id:d.id});assert.deepEqual(view.data.commercial,d.commercial);assert.equal(view.data.items[0].detailed_description,d.items[0].detailed_description);assert.deepEqual(view.data.installments,[]);assert.ok(view.reset_fields.includes('installments'));
 const command=randomUUID(),args={p_user_id:users.admin,p_kind:d.kind,p_source_id:d.id,p_expected_source_version:d.version,p_command_id:command,p_body:view.data};
 const copied=await rpc('erp_document_copy',args);assert.deepEqual(copied.document.commercial,d.commercial);assert.equal(copied.document.items[0].detailed_description,d.items[0].detailed_description);assert.notEqual(copied.document.items[0].id,d.items[0].id);assert.deepEqual(copied.document.installments,[]);assert.equal(copied.document.source_proposal_id,null);
 const previewDto=documentCopyResponse(view,{type:'preview',args:{p_kind:d.kind,p_source_id:d.id}});assert.deepEqual(previewDto.data.commercial,d.commercial);const copyDto=documentCopyResponse(copied,{type:'copy',args});assert.deepEqual(copyDto.document.commercial,d.commercial);assert.equal(copyDto.document.items[0].detailed_description,d.items[0].detailed_description);
 assert.deepEqual(await rpc('erp_document_copy',args),{...copied,replayed:true});const old={...view.data};delete old.commercial;await assert.rejects(()=>rpc('erp_document_copy',{...args,p_command_id:randomUUID(),p_body:old}),code('40001'));
 // A line-only extension still produces a complete, directly usable copy input.
 const line=structuredClone(oldBody);line.items[0].detailed_description='Somente linha';const sd=(await save('sales_proposals',line)).document,p=await rpc('erp_document_copy_preview',{p_user_id:users.admin,p_kind:sd.kind,p_source_id:sd.id});assert.equal(p.data.commercial,null);assert.equal((await rpc('erp_document_copy',{...args,p_source_id:sd.id,p_command_id:randomUUID(),p_body:p.data})).document.items[0].detailed_description,'Somente linha');
});
test('054 both conversions preserve exact current commercial fields and installments without operational effects',async()=>{
 for(const rpcName of ['erp_proposal_convert','erp_proposal_convert_to_service']){let d=(await save()).document;d=await transition(d,'open');d=await transition(d,'approved');const command=randomUUID(),args={p_user_id:users.admin,p_id:d.id,p_expected_version:d.version,p_command_id:command};const r=await rpc(rpcName,args),target=r.sale??r.service_order;
 assert.deepEqual(target.commercial,d.commercial);assert.deepEqual(target.installments,d.installments);assert.equal(target.items[0].detailed_description,d.items[0].detailed_description);assert.notEqual(target.items[0].id,d.items[0].id);assert.equal(target.totals.total,d.totals.total);assert.equal(target.source_proposal_id,d.id);assert.equal(r.operational_effects,false);assert.deepEqual(await rpc(rpcName,args),{...r,replayed:true});const projected=rpcName==='erp_proposal_convert'?documentsResponse(r,{id:d.id},{type:'conversion'}).sale:documentServiceConversionResponse(r,{args}).service_order;assert.deepEqual(projected.commercial,target.commercial);assert.deepEqual(projected.installments,target.installments);assert.equal(projected.items[0].detailed_description,target.items[0].detailed_description);}
 assert.equal((await snapshot()).titles,0);assert.equal((await snapshot()).stock,0);
});
test('054 keeps service-only ACLs and replay authorization; extension fields create no native catalog bindings',async()=>{
 for(const signature of ['erp_document_save(uuid,text,uuid,integer,uuid,jsonb)','erp_document_copy_preview(uuid,text,uuid)','erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)'])for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')v',[role,`public.${signature}`]),role==='service_role');
 for(const signature of ['commercial_reference(jsonb)','commercial_data(jsonb)','has_commercial_data(jsonb)','require_commercial_input(jsonb,jsonb)'])for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')v',[role,`erp_documents.${signature}`]),false);
 await assert.rejects(()=>save('sales_proposals',body(),null,randomUUID(),users.consulta),code('42501'));
 const command=randomUUID(),v=body(),result=await save('sales_proposals',v,null,command,users.vendas);await db.query('update erp_access.membership set active=false where user_id=$1',[users.vendas]);await assert.rejects(()=>save('sales_proposals',v,null,command,users.vendas),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);assert.deepEqual(await save('sales_proposals',v,null,command,users.vendas),{...result,replayed:true});assert.equal(await scalar('select count(*)::int v from erp_catalog.record'),4);
});
