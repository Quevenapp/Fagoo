import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseFiscalDraftRoute,executeFiscalDraftRoute} from '../../workers/erp-api/src/fiscal-drafts.mjs';

// Synthetic local data only. PGlite exercises transactions and constraints, not multi-session locking.
let db,contact,product;
const users={};
const code=expected=>error=>error.code===expected;
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args){
 const pairs=Object.entries(args);await db.exec('set role service_role');
 try{return await scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}
 finally{await db.exec('reset role');}
}
const command=(action,data,id=randomUUID(),actor=users.fiscal)=>rpc('erp_fiscal_draft_execute',{p_user_id:actor,p_command_id:id,p_action:action,p_data:data});
const get=(id,revision=null,actor=users.fiscal)=>rpc('erp_fiscal_draft_get',{p_user_id:actor,p_id:id,p_revision:revision});
const createData=(doc,model='55')=>({source_document_id:doc.id,expected_source_version:doc.version,model,preparation:{operation_nature:'Venda de mercadoria',notes:null}});
const create=doc=>command('create',createData(doc));
const body=()=>({date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'Peça fictícia',code:'FICT-1',unit:'UN',quantity:'1.123456',unit_price:'19.1234',discount_percent:'2.1250'},
 {description:'Linha livre fictícia',unit:'UN',quantity:'2',unit_price:'1.2345',discount_percent:'0'}],discount_mode:'amount',discount_value:'0.02',freight:'1.01',other_expenses:'0.03',notes:'Observação comercial',internal_notes:'INTERNAL-SECRET',payment_terms:'Condição demonstrativa'});
async function order(kind='sales_orders',data=body()){
 return (await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:data})).document;
}
async function save(doc,data=body()){
 return(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:doc.kind,p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_body:data})).document;
}
const companyData={legal_name:'Empresa Exemplo Sintética LTDA',trade_name:null,cnpj:'12ABC34501DE35',ie:'ISENTO',postal_code:'13400000',street:'Rua Fictícia',number:'10',complement:null,district:'Centro',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null};
const company=(version,data=companyData)=>rpc('erp_company_save_identity',{p_user_id:users.admin,p_expected_version:version,p_command_id:randomUUID(),p_data:data});
const http=async(path,method='GET',data,fetchRpc=rpc)=>{
 const request=new Request(`https://api.example.test/v1/rascunhos-fiscais${path}`,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
 const route=await parseFiscalDraftRoute(request);return executeFiscalDraftRoute(route,{userId:users.fiscal,rpc:fetchRpc});
};
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0016_company','0022_fiscal_drafts'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','fiscal','vendas','estoque','financeiro','consulta']){
  users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);
 }
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 contact=await catalog('contacts',{name:'Contato Sintético 022',document:'11222333000181',person_type:'J',street:'Rua exemplo',number:'1',district:'Centro',city:'Piracicaba',state:'SP',postal_code:'13400000'});
 product=await catalog('products',{name:'Produto Sintético 022',unit:'UN',kind:'P',format:'S',ncm:'00000000',gtin:null,price:'19.1234',description:'CATALOG-PRIVATE-DESCRIPTION'});
});
after(()=>db?.close());

test('022 captures exact saved order values and minimal historical snapshots without numbering or side effects',async()=>{
 const doc=await order();const before=await scalar("select jsonb_build_array((select sum(last_number) from erp_documents.numbering),(select count(*) from erp_stock.movement),(select count(*) from erp_finance.title),(select count(*) from erp_finance.movement)) value");
 const result=await create(doc);const r=result.record,s=r.snapshot;
 assert.equal(result.data_mode,'fiscal_draft');assert.equal(result.emission_enabled,false);assert.equal(result.operational_effects,false);assert.equal(r.model,'55');assert.equal(r.environment,'2');assert.equal(r.status,'draft');
 assert.equal(s.document_version,doc.version);assert.equal(s.document_id,doc.id);assert.equal(s.catalog_basis,'document_snapshot');assert.equal(s.contact.id,contact.id);assert.equal(s.contact.version,contact.version);
 for(const key of ['quantity','unit_price','discount_percent','gross','discount','total'])assert.equal(s.items[0][key],doc.items[0][key]);
 for(const [key,value]of Object.entries(s.totals))assert.equal(value,doc.totals[key]);
 assert.equal(s.items[0].product.id,product.id);assert.equal(s.items[0].product.version,product.version);assert.equal(s.items[1].product,null);assert.equal(s.company,null);
 assert.ok(result.pending.includes('COMPANY_IDENTITY_MISSING'));assert.ok(result.pending.includes('ITEM_WITHOUT_CATALOG_LINK'));assert.ok(result.pending.includes('REGIME_UNCONFIRMED'));assert.ok(result.pending.includes('PAYMENT_PLAN_MISSING'));
 assert.doesNotMatch(JSON.stringify(result),/INTERNAL-SECRET|CATALOG-PRIVATE-DESCRIPTION|access_key|secretRef|certificate|series|fiscal_number/);
 assert.deepEqual(await scalar("select jsonb_build_array((select sum(last_number) from erp_documents.numbering),(select count(*) from erp_stock.movement),(select count(*) from erp_finance.title),(select count(*) from erp_finance.movement)) value"),before);
 assert.equal(await scalar('select version value from erp_documents.document where id=$1',[doc.id]),doc.version);
 assert.equal((await http(`/${r.id}`)).record.snapshot.totals.total,doc.totals.total);
});
test('022 only admin/fiscal active actors can access or replay; direct table and RPC roles are denied',async()=>{
 const doc=await order(),input=createData(doc),id=randomUUID();const saved=await command('create',input,id,users.admin);
 for(const role of ['vendas','estoque','financeiro','consulta']){
  await assert.rejects(()=>get(saved.record.id,null,users[role]),code('42501'));
  await assert.rejects(()=>command('create',input,randomUUID(),users[role]),code('42501'));
  await assert.rejects(()=>rpc('erp_fiscal_draft_list',{p_user_id:users[role]}),code('42501'));
 }
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.admin]);
 await assert.rejects(()=>command('create',input,id,users.admin),code('42501'));
 await db.query('update erp_access.membership set active=true where user_id=$1',[users.admin]);
 for(const role of ['anon','authenticated','service_role']){
  await db.exec(`set role ${role}`);try{
   await assert.rejects(()=>scalar('select count(*) value from erp_fiscal_drafts.draft'),code('42501'));
   if(role!=='service_role')await assert.rejects(()=>scalar('select public.erp_fiscal_draft_get($1,$2) value',[users.admin,saved.record.id]),code('42501'));
  }finally{await db.exec('reset role');}
 }
 assert.equal(await scalar("select bool_and(relrowsecurity) value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_drafts' and c.relkind='r'"),true);
});
test('022 rejects unsupported origins, stale/cancelled orders, duplicate active drafts across models, and asserted emission fields',async()=>{
 for(const kind of ['sales_proposals','purchase_orders','service_orders'])await assert.rejects(async()=>create(await order(kind)),code('P0002'));
 const doc=await order(),input=createData(doc);await assert.rejects(()=>command('create',{...input,expected_source_version:doc.version+1}),code('40001'));
 const saved=await create(doc);await assert.rejects(()=>command('create',createData(doc,'65')),code('40001'));
 for(const extra of [{environment:'1'},{number:'123'},{series:'1'},{access_key:'3'.repeat(44)},{xsd_validated:true},{signed:true},{sefazAuthorized:true}])await assert.rejects(()=>command('create',{...input,...extra}),code('22023'));
 await assert.rejects(()=>command('update',{id:saved.record.id,expected_version:1,preparation:{operation_nature:'Teste',verified:true}}),code('22023'));
 const cancelled=await order();await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:cancelled.id,p_expected_version:1,p_command_id:randomUUID(),p_status:'cancelled',p_reason:'Teste sintético'});
 await assert.rejects(()=>command('create',{...createData(cancelled),expected_source_version:2}),code('40001'));
});
test('022 update and refresh enforce CAS and preserve each immutable revision',async()=>{
 let doc=await order();const first=await create(doc),id=first.record.id;
 const edited=await command('update',{id,expected_version:1,preparation:{operation_nature:'Outra preparação',notes:'Nota fiscal ainda não emitida'}});
 assert.equal(edited.record.version,2);assert.equal(edited.record.snapshot_hash,first.record.snapshot_hash);assert.deepEqual((await get(id,1)).record,first.record);
 await assert.rejects(()=>command('update',{id,expected_version:1,preparation:{}}),code('40001'));
 const changed=body();changed.items[0].quantity='4.5';doc=await save(doc,changed);
 const stale=await get(id);assert.equal(stale.current.source_changed,true);assert.ok(stale.pending.includes('SOURCE_DOCUMENT_CHANGED'));assert.equal(stale.record.snapshot.totals.total,first.record.snapshot.totals.total);
 await assert.rejects(()=>command('refresh',{id,expected_version:2,expected_source_version:1}),code('40001'));
 const refreshed=await command('refresh',{id,expected_version:2,expected_source_version:doc.version});
 assert.equal(refreshed.record.version,3);assert.equal(refreshed.current.source_changed,false);assert.equal(refreshed.record.snapshot.totals.total,doc.totals.total);assert.notEqual(refreshed.record.snapshot_hash,first.record.snapshot_hash);
 assert.deepEqual((await get(id,1)).record,first.record);assert.equal((await get(id,1)).current.source_changed,true);
 for(const table of ['revision','audit','command'])await assert.rejects(()=>db.exec(`delete from erp_fiscal_drafts.${table}`),code('42501'));
 assert.equal(await scalar('select count(*)::integer value from erp_fiscal_drafts.revision where draft_id=$1',[id]),3);
 assert.equal(await scalar('select count(*)::integer value from erp_fiscal_drafts.audit where draft_id=$1',[id]),3);
});
test('022 archive is irreversible and old replay never reactivates or duplicates a replacement draft',async()=>{
 const doc=await order(),input=createData(doc),createId=randomUUID();const first=await command('create',input,createId);
 const archiveInput={id:first.record.id,expected_version:1,reason:'Preparação substituída'},archiveId=randomUUID();
 const archived=await command('archive',archiveInput,archiveId);assert.equal(archived.record.version,2);assert.equal(archived.record.status,'archived');
 await assert.rejects(()=>command('update',{id:first.record.id,expected_version:2,preparation:{}}),code('40001'));
 const replacement=await command('create',createData(doc,'65'));assert.notEqual(replacement.record.id,first.record.id);
 const replay=await command('create',input,createId);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);assert.equal(replay.current.status,'archived');assert.equal(replay.current.version,2);assert.ok(replay.pending.includes('DRAFT_ARCHIVED'));
 const archivedReplay=await command('archive',archiveInput,archiveId);assert.deepEqual(archivedReplay.record,archived.record);assert.equal(archivedReplay.replayed,true);
 assert.equal(await scalar("select count(*)::integer value from erp_fiscal_drafts.draft where source_document_id=$1 and status='draft'",[doc.id]),1);
 await assert.rejects(()=>command('create',input,createId,users.admin),code('40001'));
 await assert.rejects(()=>command('create',{...input,model:'65'},createId),code('40001'));
});
test('022 company changes are explicit; captured CRT is human metadata and never enables emission',async()=>{
 const doc=await order(),draft=await create(doc);await company(0);
 let stale=await get(draft.record.id);assert.equal(stale.current.company_changed,true);assert.equal(stale.record.snapshot.company,null);
 let captured=await command('refresh',{id:draft.record.id,expected_version:1,expected_source_version:doc.version});
 assert.equal(captured.record.snapshot.company.identity_version,1);assert.equal(captured.record.snapshot.company.fiscal_version,1);assert.equal(captured.record.snapshot.company.crt,null);assert.equal(captured.current.company_changed,false);
 await rpc('erp_company_confirm_fiscal',{p_user_id:users.fiscal,p_expected_version:1,p_expected_identity_version:1,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Conferência fictícia'});
 stale=await get(draft.record.id);assert.equal(stale.current.company_changed,true);assert.ok(stale.pending.includes('REGIME_UNCONFIRMED'));
 captured=await command('refresh',{id:draft.record.id,expected_version:2,expected_source_version:doc.version});
 assert.equal(captured.record.snapshot.company.crt,'1');assert.equal(captured.record.snapshot.company.fiscal_version,2);assert.equal(captured.pending.includes('REGIME_UNCONFIRMED'),false);
 assert.equal(captured.emission_enabled,false);assert.ok(captured.pending.includes('TAX_REVIEW_REQUIRED'));assert.ok(captured.pending.includes('HOMOLOGATION_NOT_PERFORMED'));
 await company(1,{...companyData,street:'Outra rua sintética'});assert.equal((await get(draft.record.id)).current.company_changed,true);
 assert.deepEqual((await get(draft.record.id,3)).record,captured.record);
 assert.equal((await http(`/${draft.record.id}`)).record.snapshot.company.identity.cnpj,companyData.cnpj);
});
test('022 catalog capture stays tied to historical order snapshots, never silently substitutes current data',async()=>{
 const doc=await order();const currentProduct=await scalar('select version value from erp_catalog.record where id=$1',[product.id]);
 await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:product.id,p_expected_version:currentProduct,p_command_id:randomUUID(),p_data:{name:'Nome posterior',ncm:'11111111'}});
 const draft=await create(doc);assert.equal(draft.record.snapshot.items[0].product.name,doc.items[0].product_snapshot.name);assert.equal(draft.record.snapshot.items[0].product.ncm,doc.items[0].product_snapshot.ncm);
 assert.equal(draft.current.source_changed,false);assert.ok(draft.pending.includes('CATALOG_SNAPSHOTS_REQUIRE_REVIEW'));assert.equal(draft.record.snapshot.catalog_basis,'document_snapshot');
});
test('022 list/revision keyset pagination and historical GET stay scoped and do not expose audit actors',async()=>{
 const doc=await order(),created=await create(doc);const id=created.record.id;
 for(let version=1;version<=3;version++)await command('update',{id,expected_version:version,preparation:{operation_nature:`Revisão ${version}`,notes:null}});
 const first=await http(`/${id}/revisions?limit=2`);assert.equal(first.has_more,true);assert.deepEqual(first.items.map(x=>x.version),[1,2]);
 const second=await http(`/${id}/revisions?limit=2&after=${first.next_cursor}`);assert.equal(second.has_more,false);assert.deepEqual(second.items.map(x=>x.version),[3,4]);
 const historical=await http(`/${id}/revisions/1`);assert.equal(historical.record.version,1);assert.equal(historical.current.version,4);
 const list=await http(`?source_document_id=${doc.id}&model=55&status=draft&limit=1`);assert.equal(list.items.length,1);assert.equal(list.items[0].id,id);assert.equal(list.has_more,false);assert.equal(list.items[0].total,doc.totals.total);
 assert.doesNotMatch(JSON.stringify(list),/actor|created_by|command_id|internal_notes|snapshot/);
 await assert.rejects(()=>get(id,99),code('P0002'));
});
test('022 HTTP rejects malformed bodies, unsafe routes, unsupported methods and client trust claims',async()=>{
 const doc=await order(),input={command_id:randomUUID(),...createData(doc)};
 for(const [path,method,data]of [['','DELETE'],['?model=55&model=65','GET'],['?after=no','GET'],[`/${randomUUID()}/revisions/01`,'GET'],['/other','GET']])
  await assert.rejects(()=>http(path,method,data),e=>[400,404,405].includes(e.status));
 for(const payload of [null,[],{...input,environment:'1'},{...input,verified:true},{...input,preparation:{notes:'a'.repeat(4001)}},{...input,model:55},{...input,expected_source_version:'1'}]){
  const request=new Request('https://api.example.test/v1/rascunhos-fiscais',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await assert.rejects(()=>parseFiscalDraftRoute(request),e=>e.status===400);
 }
 const huge=new Request('https://api.example.test/v1/rascunhos-fiscais',{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(16385)});await assert.rejects(()=>parseFiscalDraftRoute(huge),e=>e.status===400);
 const created=await http('','POST',input);assert.equal(created.record.model,'55');assert.equal(created.replayed,false);
 const uppercase=await http(`/${created.record.id.toUpperCase()}`);assert.equal(uppercase.record.id,created.record.id);
});
test('022 HTTP rejects inconsistent snapshots, source scope, stale flags or forged emission claims and strips extras',async()=>{
 const doc=await order(),saved=await create(doc),path=`/${saved.record.id}`;
 for(const mutate of [v=>v.emission_enabled=true,v=>v.record.environment='1',v=>v.record.id=randomUUID(),v=>v.record.snapshot.document_id=randomUUID(),
  v=>v.record.snapshot.totals.total='0.00',v=>v.record.snapshot.items[0].quantity='2.000000',v=>v.record.snapshot.contact.id=randomUUID(),
  v=>v.current.source_changed=true,v=>v.pending=[],v=>v.pending.push('CLIENT_VERIFIED')]){
  const raw=structuredClone(await get(saved.record.id));mutate(raw);await assert.rejects(()=>http(path,'GET',undefined,async()=>raw),e=>e.status===502);
 }
 const raw=structuredClone(await get(saved.record.id));raw.secret='PRIVATE';raw.record.snapshot.contact.raw={secret:'PRIVATE'};raw.record.snapshot.items[0].product.cost='PRIVATE';raw.record.snapshot.internal_notes='PRIVATE';
 const projected=await http(path,'GET',undefined,async()=>raw);assert.doesNotMatch(JSON.stringify(projected),/PRIVATE/);
});
test('022 mutation DTOs bind historical command revision and source version even on replay',async()=>{
 const doc=await order(),saved=await create(doc),id=saved.record.id;
 const data={command_id:randomUUID(),expected_version:1,preparation:{operation_nature:'Preparação alterada',notes:null}};
 const updated=await http(`/${id}`,'PATCH',data);
 const swapped=structuredClone(updated);swapped.record.version=3;swapped.current.version=3;
 for(const replayed of [false,true]){swapped.replayed=replayed;await assert.rejects(()=>http(`/${id}`,'PATCH',data,async()=>swapped),e=>e.status===502);}
 const wrongState=structuredClone(updated);wrongState.record.status='archived';wrongState.record.archived_at=wrongState.record.updated_at;wrongState.record.archive_reason='Arquivo sintético';wrongState.current.status='archived';wrongState.pending.push('DRAFT_ARCHIVED');
 await assert.rejects(()=>http(`/${id}`,'PATCH',data,async()=>wrongState),e=>e.status===502);
 const refresh={command_id:randomUUID(),expected_version:2,expected_source_version:doc.version};const refreshed=await http(`/${id}/refresh`,'POST',refresh);
 const wrongSource=structuredClone(refreshed);wrongSource.record.source_document_version++;wrongSource.record.snapshot.document_version++;wrongSource.current.source_document_version++;
 await assert.rejects(()=>http(`/${id}/refresh`,'POST',refresh,async()=>wrongSource),e=>e.status===502);
 const latest=structuredClone(await get(id));latest.record.version=2;
 await assert.rejects(()=>http(`/${id}`,'GET',undefined,async()=>latest),e=>e.status===502);
 const omitted=structuredClone(await get(id));omitted.pending=omitted.pending.filter(x=>x!=='ITEM_WITHOUT_CATALOG_LINK');
 await assert.rejects(()=>http(`/${id}`,'GET',undefined,async()=>omitted),e=>e.status===502);
});
test('022 failed audit write rolls back draft, revision and command atomically',async()=>{
 const doc=await order(),id=randomUUID();
 const count=()=>scalar("select jsonb_build_array((select count(*) from erp_fiscal_drafts.draft),(select count(*) from erp_fiscal_drafts.revision),(select count(*) from erp_fiscal_drafts.command),(select count(*) from erp_fiscal_drafts.audit)) value");
 const before=await count();
 await db.exec("create function pg_temp.fail_draft_audit() returns trigger language plpgsql as $$begin raise exception 'synthetic failure' using errcode='P0001';end$$;create trigger test_fail_draft_audit before insert on erp_fiscal_drafts.audit for each row execute function pg_temp.fail_draft_audit();");
 try{await assert.rejects(()=>command('create',createData(doc),id),code('P0001'));assert.deepEqual(await count(),before);}
 finally{await db.exec('drop trigger test_fail_draft_audit on erp_fiscal_drafts.audit');}
 const recovered=await command('create',createData(doc),id);assert.equal(recovered.replayed,false);assert.equal(recovered.record.version,1);
});
test('022 maximum item count remains exact and cancelled source is reported without changing the draft',async()=>{
 const data=body();data.items=Array.from({length:250},(_,i)=>({description:`Item sintético ${i+1}`,unit:'UN',quantity:'0.000001',unit_price:'9999999999.9999',discount_percent:'1.1234'}));
 const doc=await order('sales_orders',data),saved=await create(doc);const detail=await http(`/${saved.record.id}`);
 assert.equal(detail.record.snapshot.items.length,250);assert.equal(detail.record.snapshot.totals.total,doc.totals.total);
 await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:'cancelled',p_reason:'Teste sintético'});
 const stale=await get(saved.record.id);assert.deepEqual(stale.record,saved.record);assert.equal(stale.current.source_status,'cancelled');assert.ok(stale.pending.includes('SOURCE_DOCUMENT_CANCELLED'));
 await assert.rejects(()=>command('refresh',{id:saved.record.id,expected_version:1,expected_source_version:doc.version+1}),code('40001'));
 const archived=await command('archive',{id:saved.record.id,expected_version:1,reason:'Pedido cancelado'});assert.equal(archived.record.status,'archived');
});
test('022 deterministic lock order and uniqueness are explicit; no issuance tables or write effects exist',async()=>{
 const sql=await readFile(new URL('../../supabase/migrations/202610160022_fiscal_drafts.sql',import.meta.url),'utf8');
 const mutation=sql.slice(sql.indexOf('create function public.erp_fiscal_draft_execute'));
 assert.ok(mutation.indexOf('pg_advisory_xact_lock(174852932')<mutation.indexOf('select * into d from erp_documents.document'));
 assert.ok(mutation.indexOf('select * into d from erp_documents.document')<mutation.indexOf('select * into r from erp_fiscal_drafts.draft'));
 assert.ok(mutation.indexOf('select * into r from erp_fiscal_drafts.draft')<mutation.indexOf('pg_advisory_xact_lock(174852920,1)'));
 assert.match(sql,/unique index erp_fiscal_draft_one_active_order[\s\S]*?where status='draft'/);
 assert.doesNotMatch(sql,/\b(?:insert into|update|delete from)\s+erp_(?:stock|finance|documents|company)\./i);
});
