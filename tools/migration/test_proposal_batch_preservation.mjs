import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';import {test} from 'node:test';import {randomUUID} from 'node:crypto';
import {executeProposalBatch} from './execute_proposal_batch.mjs';import {proposalBatchOperation} from './proposal_batch_port.mjs';
import {catalogUpdateFixture} from './catalog_update_test_fixture.mjs';import {prepareProposalBatch,proposalBatchDigest as digest} from './plan_proposal_batch.mjs';import {proposalBatchPreservationSql,verifyProposalBatchPreservation,finalizeProposalBatchPreservation} from './proposal_batch_preservation.mjs';
test('055 SQL proof preserves existing records and accepts only the exact reviewed new drafts, numbering and audits',async()=>{
 const f=await catalogUpdateFixture();try{
 await f.db.exec(await readFile(new URL('../../supabase/migrations/202610160015_document_filters.sql',import.meta.url),'utf8'));
 // A minimal empty068-shaped table proves dynamic inventory inclusion; this is not a068 migration test.
 await f.db.exec('create schema erp_fiscal_subset_review;create table erp_fiscal_subset_review.review(id uuid primary key);alter table erp_fiscal_subset_review.review enable row level security;');
 for(const [entity,id,payload]of [['contacts','990001',{id:'990001',nome:'Synthetic proposal contact',situacao:'A',tipo:'J'}],['products','990002',{id:'990002',nome:'Synthetic proposal product',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:40}]]){const hash=await f.stage(entity,id,payload);await f.rpc('erp_catalog_import_origin',{p_user_id:f.actor,p_entity:entity,p_items:[{source_id:id,source_hash:hash}],p_command_id:randomUUID(),p_dry_run:false});}
 const previews=[];for(const id of ['990010','990011']){await f.stage('sales_proposals',id,{id,numero:Number(id),data:'2026-10-16',situacao:'Rascunho',contato:{id:'990001'},total:80,totalProdutos:80,desconto:0,outrasDespesas:0,totalOutrosItens:0,garantia:0,dataProximoContato:'0000-00-00',introducao:'',aosCuidadosDe:'',vendedor:{id:0},loja:{id:0},transporte:{frete:0,freteModalidade:9},itens:[{produto:{id:'990002',descricao:'Synthetic product'},codigo:'QA',unidade:'UN',quantidade:2,valor:40,desconto:0,descricaoDetalhada:''}],parcelas:[],observacoes:'',observacaoInterna:'',prazoEntrega:''});const p=await f.rpc('erp_origin_proposal_import_preview_v2',{p_user_id:f.actor,p_source_id:id});assert.equal(p.can_apply,true);previews.push(p);}
 const inventory=await f.rpc('erp_document_list',{p_user_id:f.actor,p_kind:'sales_proposals',p_limit:25,p_after:null,p_status:null}),audit={profile:'proposal-audit-055-v1',actor:f.actor,project_url:'https://abcdefghijklmnopqrst.supabase.co',read_only:true,coverage_certified:false,coherent_snapshot:false,source_rows:previews.map(p=>({...p,document_id:null})),previews,native_documents:inventory.items};
 const plan=await prepareProposalBatch({audit,selectedSourceIds:previews.map(p=>p.source_id),duplicateReviewed:true}),planHash=digest(plan),sql=proposalBatchPreservationSql(plan,planHash),proof=async()=>(await f.db.exec(sql)).find(x=>x.rows?.[0]?.preservation).rows[0].preservation;
 const before=await proof();assert.equal(before.command_count,0);assert.equal(before.selected.filter(x=>x.document_id!==null).length,0);assert.ok(before.preserved_relations.some(x=>x.schema==='erp_fiscal_subset_review'&&x.table==='review'));
 const port={actor:f.actor,project_url:'https://abcdefghijklmnopqrst.supabase.co',async call(type,input){const op=await proposalBatchOperation(type,input);try{return op.project(await f.rpc(op.rpc,{...op.args,p_user_id:f.actor}));}catch(e){if(e.code==='P0002')e.status=404;throw e;}}};
 const outcome=await executeProposalBatch({plan,approvedPlanHash:planHash,directory:f.directory,port,mode:'apply',confirmCreateDrafts:true});assert.equal(outcome.outcome,'complete');assert.equal(outcome.draft_version_1_verified,true);
 assert.deepEqual(finalizeProposalBatchPreservation({outcome,plan,planHash,before}),{outcome:'preservation_pending',preservation:null});
 const after=await proof(),v=verifyProposalBatchPreservation({plan,planHash,before,after});assert.equal(v.created,2);assert.equal(v.before_proposals,1);assert.equal(v.after_proposals,3);assert.equal(v.operational_effects,false);
 assert.equal(finalizeProposalBatchPreservation({outcome,plan,planHash,before,after}).outcome,'verified');
 assert.throws(()=>finalizeProposalBatchPreservation({outcome:{...outcome,outcome:'verified'},plan,planHash,before,after}),/EXECUTOR_OUTCOME_INVALID/);
 assert.throws(()=>finalizeProposalBatchPreservation({outcome:{...outcome,draft_version_1_verified:false},plan,planHash,before,after}),/EXECUTOR_COMPLETION_INVALID/);
 const tampered=structuredClone(after);tampered.preserved_relations[0].hash='f'.repeat(64);assert.throws(()=>finalizeProposalBatchPreservation({outcome,plan,planHash,before,after:tampered}),/COLLATERAL_PRESERVED_RELATIONS/);
 // These compare to BEFORE and fail even when a selected document or excluded command exists.
 for(const [label,mutate,code]of [
  ['existing row',x=>{x.preserved_relations.find(r=>r.schema==='erp_catalog'&&r.table==='record').hash='f'.repeat(64);},'COLLATERAL_PRESERVED_RELATIONS'],
  ['ACL',x=>{x.preserved_relations[0].access_hash='f'.repeat(64);},'COLLATERAL_PRESERVED_RELATIONS'],
  ['function',x=>{x.functions[0].definition_hash='f'.repeat(64);},'COLLATERAL_FUNCTIONS'],
  ['068 removal',x=>{x.subset068_present=false;},'PROOF_BINDING'],
  ['number gap',x=>{x.numbering=String(BigInt(x.numbering)+1n);},'NUMBERING_CHANGED'],
  ['unexpected content',x=>{x.selected[0].normalized_body_matches=false;},'SELECTED_CONTENT'],
  ['extra audit',x=>{x.audit_count++;},'COMMAND_COUNTS'],
  ['source changed',x=>{x.source_cas[0].hash='f'.repeat(64);},'SOURCE_CHANGED']]){const bad=structuredClone(after);mutate(bad);assert.throws(()=>verifyProposalBatchPreservation({plan,planHash,before,after:bad}),e=>e.message===code,label);}
 await f.db.query('update erp_documents.item set product_snapshot=jsonb_set(product_snapshot,\'{name}\',\'"Changed old snapshot"\') where document_id=$1',[f.document.id]);const changed=await proof();assert.throws(()=>verifyProposalBatchPreservation({plan,planHash,before,after:changed}),/COLLATERAL_PRESERVED_RELATIONS/);
 }finally{await f.close();}
});
