import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseFiscalReviewRoute,executeFiscalReviewRoute} from '../src/fiscal-review.mjs';
import {fiscalReviewView} from '../../../apps/erp/src/lib/fiscal-review-model.ts';
import {reviewBasis,reviewIds} from '../../../packages/fiscal-core/test/review-fixtures.mjs';
let db,contact,product,draft;const users={};
const sqlError=code=>e=>e.code===code;
async function rpc(name,args={}){const entries=Object.entries(args);await db.exec('set role service_role');try{return(await db.query('select public.'+name+'('+entries.map(([k],i)=>k+'=>$'+(i+1)).join(',')+') value',entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}finally{await db.exec('reset role');}}
const raw=(id=draft.record.id,revision=1,actor=users.fiscal)=>rpc('erp_fiscal_draft_review',{p_user_id:actor,p_id:id,p_revision:revision});
const route=(id,query='revision=1',method='GET')=>parseFiscalReviewRoute(new Request('https://synthetic.invalid/v1/rascunhos-fiscais/'+id+'/conferencia'+(query?'?'+query:''),{method}));
const api=(id=draft.record.id,query='revision=1',port=rpc)=>executeFiscalReviewRoute(route(id,query),{userId:users.fiscal,rpc:port});
const catalog=(entity,data,id=null,version=0)=>rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:data});
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0016_company','0022_fiscal_drafts','0023_product_details','0029_fiscal_review'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 for(const role of['admin','fiscal','consulta','estoque','vendas','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await catalog('contacts',{name:'Contato de teste',person_type:'J',document:'11222333000181',street:'Rua fictícia',number:'1',district:'Centro',city:'Piracicaba',state:'SP',postal_code:'13400000'})).record;
 product=(await catalog('products',{name:'Produto de teste',code:'FICT-029',unit:'UN',kind:'P',format:'S',ncm:'00000000',gtin:'SEM GTIN',origin:'0',cest:'1234567',gtin_tax:'SEM GTIN',description:'PRIVATE-NOT-EXPOSED'})).record;
 const order=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[
  {product_id:product.id,description:'Linha com precisão exata',code:'FICT-029',unit:'UN',quantity:'1.230000',unit_price:'10'},
  {product_id:product.id,description:'Linha com precisão a revisar',code:'FICT-029',unit:'UN',quantity:'1.234567',unit_price:'10'},
  {description:'Linha livre',unit:'UN',quantity:'1',unit_price:'1'}],internal_notes:'PRIVATE-NOT-EXPOSED'}})).document;
 draft=await rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:order.id,expected_source_version:order.version,model:'55',preparation:{operation_nature:'Venda fictícia',notes:null}}});
});
after(()=>db?.close());
test('029 reads require active admin/fiscal; service-only RPC preserves the old RLS and immutable history',async()=>{
 for(const actor of[users.admin,users.fiscal])assert.equal((await raw(undefined,1,actor)).draft.record.id,draft.record.id);
 for(const role of['consulta','estoque','vendas','financeiro'])await assert.rejects(()=>raw(undefined,1,users[role]),sqlError('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>raw(),sqlError('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 for(const role of['anon','authenticated']){await db.exec('set role '+role);try{await assert.rejects(()=>db.query('select public.erp_fiscal_draft_review($1,$2,1)',[users.admin,draft.record.id]),sqlError('42501'));}finally{await db.exec('reset role');}}
 await assert.rejects(()=>db.exec('update erp_fiscal_drafts.revision set record=record'),sqlError('42501'));
});
test('029 projects current catalog once per exact UUID while retaining repeated/free items and historical values',async()=>{
 const before=(await db.query('select record from erp_fiscal_drafts.revision where draft_id=$1 and version=1',[draft.record.id])).rows[0].record;
 const basis=await raw();assert.equal(basis.catalog.length,1);assert.equal(basis.catalog[0].product_id,product.id);assert.equal(basis.catalog[0].record.origin,'0');
 assert.ok(!Object.hasOwn(basis.draft.record.snapshot.items[0].product,'origin'));assert.equal(basis.draft.record.snapshot.items.length,3);
 assert.doesNotMatch(JSON.stringify(basis),/PRIVATE-NOT-EXPOSED|created_by|source_id/);
 await catalog('products',{ncm:'12345678',origin:'2'},product.id,product.version);
 const current=await raw();assert.equal(current.catalog[0].record.version,2);assert.equal(current.catalog[0].record.ncm,'12345678');
 assert.equal(current.draft.record.snapshot.items[0].product.ncm,'00000000');assert.equal(current.draft.record.snapshot_hash,draft.record.snapshot_hash);
 assert.deepEqual((await db.query('select record from erp_fiscal_drafts.revision where draft_id=$1 and version=1',[draft.record.id])).rows[0].record,before);
 const response=await api();assert.equal(response.report.items[0].quantity_lexical,'1.23');assert.equal(response.report.items[1].quantity_lexical,null);
 assert.equal(response.report.items[2].catalog_state,'unlinked');assert.ok(response.report.findings.some(f=>f.code==='CATALOG_CHANGED'));
 assert.deepEqual(fiscalReviewView(response,draft.record.id,1,draft.record.snapshot_hash),response);
});
test('029 repeated reads have no mutations or numbering effects and historical views stay bound after archive',async()=>{
 const counts=async()=>(await db.query("select jsonb_build_array((select count(*)from erp_fiscal_drafts.revision),(select count(*)from erp_fiscal_drafts.command),(select count(*)from erp_fiscal_drafts.audit),(select count(*)from erp_finance.title),(select count(*)from erp_stock.movement),(select sum(last_number)from erp_documents.numbering)) value")).rows[0].value;
 const before=await counts();await api();await api();assert.deepEqual(await counts(),before);
 await rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:draft.record.id,expected_version:1,reason:'Encerramento de teste sintético'}});
 const historical=await api();assert.equal(historical.basis.draft.record.version,1);assert.equal(historical.basis.draft.current.version,2);
 assert.ok(historical.report.findings.some(f=>f.code==='DRAFT_ARCHIVED'));assert.equal(historical.can_emit,false);
 await assert.rejects(()=>raw(draft.record.id,99),sqlError('P0002'));
});
test('029 HTTP accepts only exact GET revision and rejects arbitrary actor/input or trust claims',async()=>{
 assert.equal(route(reviewIds.draft.toUpperCase()).id,reviewIds.draft);
 for(const query of['','revision=0','revision=01','revision=2147483648','revision=1&revision=2','revision=1&actor=forged','revision=1&can_emit=true'])assert.throws(()=>route(reviewIds.draft,query),e=>e.status===400);
 for(const method of['POST','PUT','DELETE','PATCH'])assert.throws(()=>route(reviewIds.draft,'revision=1',method),e=>e.status===405);
 assert.equal(parseFiscalReviewRoute(new Request('https://synthetic.invalid/other')),null);
 const valid=reviewBasis();const result=await api(reviewIds.draft,'revision=1',async(name,args)=>{assert.equal(name,'erp_fiscal_draft_review');assert.equal(args.p_user_id,users.fiscal);return valid;});
 assert.equal(result.can_emit,false);
 for(const mutate of[b=>b.draft.emission_enabled=true,b=>b.draft.record.id=reviewIds.order,b=>b.draft.record.version=2,b=>b.catalog[0].record.id=reviewIds.contact,b=>b.draft.record.snapshot.items[0].total='0.00']){
  const bad=reviewBasis();mutate(bad);await assert.rejects(()=>api(reviewIds.draft,'revision=1',async()=>bad),e=>e.status===502);
 }
});
