import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planProposalProductAdoption as planWithActor,adoptionRuntimeConfig,validateAdoptionEvidence,savePrivateAdoptionPlan} from './plan_proposal_product_adoption.mjs';
const actor='00000000-0000-4000-8000-000000000001';
const planProposalProductAdoption=options=>planWithActor({actor,...options});
const h='a'.repeat(64),ph='b'.repeat(64),stamp='2026-10-16T10:00:00Z';
function evidence(n=1){return{profile:'proposal-product-adoption-evidence-v1',read_only:true,exported_at:stamp,has_more:false,items:Array.from({length:n},(_,i)=>({source_id:String(i+1),source_hash:h,source_version:'1',source_seen_at:stamp,proposal_id:'999',proposal_hash:ph,proposal_version:'2',source_active:true,source_simple_product:true,capture:{profile:'origin-price-json-v1',source:'detail',response_sha256:'c'.repeat(64),capture_id:randomUUID(),observed_at:stamp,source_hash:h,source_version:'1',numeric_price:true}}))};}
function ports(input){const calls=[];return{calls,
 async proposal(id){calls.push({kind:'proposal',id});return{dry_run:true,persisted:false,source_id:id,source_hash:ph,source_version:'2',source_status:'Rascunho',existing:null,bindings:input.items.map(x=>({entity:'products',source_id:x.source_id,source_hash:x.source_hash,source_version:x.source_version,record_id:null,origin_state:null}))};},
 async catalog(items){calls.push({kind:'catalog',items});return{dry_run:true,operational_effects:false,preview_hash:'d'.repeat(64),items:items.map(x=>({...x,source_version:'1',action:'create',operation_action:'create',record_id:null,record_version:null,origin_state:null,human_edited:false,candidate_retained:false,stock_locked:false,error:null,source_status:'A',changes:[{field:'active',after:true},{field:'kind',after:'P'},{field:'format',after:'S'},{field:'price',after:'12345678901234.1234567891'}]}))};}
};}
test('planner is readonly and batches only unlinked precise products; preserves mapper decimal unchanged',async()=>{
 const input=evidence(51),readers=ports(input),p=await planProposalProductAdoption({evidence:input,readers});assert.equal(p.apply_enabled,false);assert.equal(p.requires_repreview_before_apply,true);assert.equal(p.summary.planned,51);assert.deepEqual(p.batches.map(b=>b.items.length),[50,1]);assert.equal(readers.calls.filter(x=>x.kind==='proposal').length,1);assert.equal(new Set(p.batches.map(b=>b.command_id)).size,2);assert.equal(p.batches[0].mapper_review[0].changes.at(-1).after,'12345678901234.1234567891');
});
test('evidence rejects list/fallback, mismatched hashes, unknown payload fields and truncation',()=>{
 for(const change of [v=>v.has_more=true,v=>v.items[0].capture.source='list_fallback',v=>v.items[0].capture.source_hash=ph,v=>v.items[0].payload={private:true},v=>v.items[0].capture.tokens=[],v=>v.items.push(v.items[0]),v=>v.items[0].source_version='90000000000000000000',v=>v.exported_at='2026-02-30T00:00:00Z']){const v=evidence();change(v);assert.throws(()=>validateAdoptionEvidence(v));}
});
test('source profile/numeric observation cannot be relaxed by the mapper',async()=>{
 for(const change of [v=>v.items[0].source_active=false,v=>v.items[0].source_simple_product=false,v=>v.items[0].capture.numeric_price=false]){const e=evidence();change(e);const r=ports(e),p=await planProposalProductAdoption({evidence:e,readers:r});assert.equal(p.summary.planned,0);assert.equal(r.calls.length,0);}
});
test('imported/changed proposal or newly linked product is omitted before catalog review',async()=>{
 for(const change of [p=>p.existing={document_id:randomUUID()},p=>p.source_hash=h,p=>p.source_status='Concluído',p=>p.bindings[0].record_id=randomUUID(),p=>p.bindings[0].source_version='2']){const e=evidence(),r=ports(e),orig=r.proposal;r.proposal=async id=>{const p=await orig(id);change(p);return p;};const p=await planProposalProductAdoption({evidence:e,readers:r});assert.equal(p.summary.planned,0);assert.equal(r.calls.filter(x=>x.kind==='catalog').length,0);}
});
test('mixed group is repreviewed with exact selected IDs; changed final preview aborts plan',async()=>{
 const e=evidence(2),r=ports(e),orig=r.catalog;let calls=0;r.catalog=async items=>{const p=await orig(items);if(++calls===1)p.items[1].action='update';return p;};
 const p=await planProposalProductAdoption({evidence:e,readers:r});assert.equal(p.summary.planned,1);assert.deepEqual(r.calls.filter(x=>x.kind==='catalog').map(x=>x.items.length),[2,1]);
 const s=ports(e),fn=s.catalog;let n=0;s.catalog=async items=>{const p=await fn(items);if(++n===1)p.items[1].action='update';else p.items[0].source_hash=ph;return p;};await assert.rejects(planProposalProductAdoption({evidence:e,readers:s}),/FINAL_PREVIEW_CHANGED/);
});
test('snapshot is captured before awaits; exact price is checked, never normalized or rounded',async()=>{
 const e=evidence(),r=ports(e),orig=r.proposal;r.proposal=async id=>{const p=await orig(id);e.items[0].source_hash=ph;return p;};const plan=await planProposalProductAdoption({evidence:e,readers:r});assert.equal(plan.batches[0].evidence[0].source_hash,h);
 const bad=evidence(),s=ports(bad),catalog=s.catalog;s.catalog=async items=>{const p=await catalog(items);p.items[0].changes.at(-1).after='0.12345678901';return p;};const blocked=await planProposalProductAdoption({evidence:bad,readers:s});assert.equal(blocked.summary.planned,0);
});
test('private plan file is exclusive0600 and a second save preserves prior bytes',{skip:process.platform==='win32'?'POSIX mode and directory fsync test':false},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'brufap-adoption-plan-'));try{const file=join(dir,'plan.json'),plan=await planProposalProductAdoption({evidence:evidence(),readers:ports(evidence())});await savePrivateAdoptionPlan(file,plan);assert.equal((await stat(file)).mode&0o777,0o600);const before=await readFile(file);await assert.rejects(savePrivateAdoptionPlan(file,{changed:true}),{code:'EEXIST'});assert.deepEqual(await readFile(file),before);}finally{await rm(dir,{recursive:true,force:true});}
});
test('runtime destination and actor must be explicit and canonical',()=>{
 assert.throws(()=>adoptionRuntimeConfig({}),/CONFIGURATION_REQUIRED/);
 for(const url of['http://erp.example.test','https://user:pass@erp.example.test','https://erp.example.test/path','https://erp.example.test?token=x'])assert.throws(()=>adoptionRuntimeConfig({SUPABASE_URL:url,FAGOO_ADOPTION_ACTOR_ID:actor}),/CONFIGURATION_REQUIRED/);
 assert.deepEqual(adoptionRuntimeConfig({SUPABASE_URL:'https://erp.example.test',FAGOO_ADOPTION_ACTOR_ID:actor}),{project:'https://erp.example.test',actor});
});
test('planner never chooses an implicit actor',async()=>{
 const e=evidence();await assert.rejects(planWithActor({evidence:e,readers:ports(e)}),/ADOPTION_PLAN_INVALID/);
});
