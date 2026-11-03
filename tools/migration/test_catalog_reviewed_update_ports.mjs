import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {adoptionDigest} from './execute_proposal_product_adoption.mjs';
import {createReviewedCatalogUpdatePorts} from './catalog_reviewed_update_ports.mjs';
const H='a'.repeat(64),P='b'.repeat(64),projectUrl='https://abcdefghijklmnopqrst.supabase.co';
function plan(){return{profile:'reviewed-catalog-updates-v1',read_only:true,apply_enabled:false,requires_root_review:true,entity:'products',actor:randomUUID(),plan_id:randomUUID(),command_id:randomUUID(),preview_hash:P,project_url:projectUrl,items:[{source_id:'1001',source_hash:H}],expected:[{source_id:'1001',source_hash:H,source_version:'2',record_id:randomUUID(),record_version:3,expected_record_version:4,kind:'origin_only',allowed_changes:[],witnesses:[{source_id:'2001',source_hash:H,source_version:'1'}]}]};}
function response(url,v){const r=new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;}
const args=p=>({p_user_id:p.actor,p_entity:'products',p_items:p.items,p_command_id:p.command_id,p_preview_hash:p.preview_hash});
const ack=p=>({entity:'products',data_mode:'erp_native',operational_effects:false,dry_run:false,replayed:false,preview_hash:P,items:[{source_id:'1001',source_hash:H,source_version:'2',record_id:p.expected[0].record_id,action:'update',error:null}]});
const config=(p,fetchImpl)=>({plan:p,planHash:adoptionDigest(p),projectUrl,secret:'synthetic-only-key-with-no-permission',fetchImpl,readPreservation:async()=>({proof:true}),readReceipt:async()=>({receipt:true})});
test('port defaults to prepare: no apply, fixed project/selection and no credential or raw response in diagnostics',async()=>{
 const p=plan();let calls=0;const port=createReviewedCatalogUpdatePorts(config(p,async()=>{calls++;throw Error('unreachable');}));
 try{await assert.rejects(port.ports.apply(args(p),{}),/CATALOG_RPC_SCOPE/);assert.equal(calls,0);assert.equal(port.stats().applies,0);await assert.rejects(port.ports.catalog([{source_id:'1002',source_hash:H}],{}),/CATALOG_RPC_SCOPE/);await assert.rejects(port.ports.proposal('2002',{}),/CATALOG_RPC_SCOPE/);assert.equal(calls,0);}finally{port.dispose();}
 assert.throws(()=>createReviewedCatalogUpdatePorts({...config(p,()=>{}),projectUrl:'https://differentproject1234.supabase.co'}),/PORT_CONFIGURATION/);
});
test('reviewed mode dispatches exactly once with captured actor/body and explicit transport headers; dispose closes port',async()=>{
 const p=plan(),original=structuredClone(p),seen=[];const port=createReviewedCatalogUpdatePorts({...config(p,async(url,init)=>{seen.push({url,init});return response(url,ack(original));}),mode:'apply-reviewed'});
 p.actor=randomUUID();p.items[0].source_hash='f'.repeat(64);
 const result=await port.ports.apply(args(original),{});assert.equal(result.items[0].record_id,original.expected[0].record_id);assert.equal(seen.length,1);
 const {url,init}=seen[0];assert.equal(url,projectUrl+'/rest/v1/rpc/erp_catalog_import_apply');assert.deepEqual(JSON.parse(init.body),args(original));assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.headers.Accept,'application/json');assert.equal(init.headers['Accept-Encoding'],'identity');assert.ok(init.signal instanceof AbortSignal);
 await assert.rejects(port.ports.apply(args(original),{}),/CATALOG_RPC_SCOPE/);assert.equal(seen.length,1);port.dispose();await assert.rejects(port.ports.apply(args(original),{}),/CATALOG_RPC_DEADLINE/);
});

test('file wrapper keeps pending recovery read-only, requires distinct proof files and never sends a second POST',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const {runCatalogUpdateFileStep}=await import('./catalog_reviewed_update_run.mjs');
 const directory=await mkdtemp(join(tmpdir(),'brufap-update-files-'));const p=plan(),planHash=adoptionDigest(p),a=args(p),bodyHash=adoptionDigest(a),review={profile:'catalog-updates-review-v1',plan_hash:planHash,actor:p.actor,command_id:p.command_id,body_hash:bodyHash,operational_effects:false},approvedReviewHash=adoptionDigest(review);
 const paths={planPath:join(directory,'plan.json'),reviewPath:join(directory,'review.json'),beforePath:join(directory,'before.json'),postPath:join(directory,'post.json'),ledgerPath:join(directory,'ledger.json')};
 const ledger={profile:'catalog-import-receipt-export-v1',read_only:true,exported_at:new Date().toISOString(),actor:p.actor,command_id:p.command_id,body_hash:bodyHash,found:false,request_matches:false,namespace_conflict:false,receipt:null};
 const state={profile:'catalog-updates-state-v1',plan_hash:planHash,review_hash:approvedReviewHash,command_id:p.command_id,body_hash:bodyHash,state:'pending',receipt:null};let calls=0;
 try{for(const [path,data]of [[paths.planPath,p],[paths.reviewPath,review],[paths.beforePath,{}],[paths.postPath,{}],[paths.ledgerPath,ledger],[join(directory,`catalog-reviewed-updates-${p.command_id}.json`),state]])await writeFile(path,JSON.stringify(data),{flag:'wx',mode:0o600});
 const options={...paths,mode:'recover-readonly',planHash,approvedReviewHash,directory,projectUrl,secret:'synthetic-only-key-with-no-permission',fetchImpl:()=>{calls++;throw Error('must not call');}};
 const result=await runCatalogUpdateFileStep(options);assert.equal(result.outcome,'uncertain');assert.equal(result.applies,0);assert.equal(calls,0);assert.equal(result.requires_ledger_export,true);assert.doesNotMatch(JSON.stringify(result),/actor|record_id|source_id|receipt|secret/);
 await assert.rejects(runCatalogUpdateFileStep({...options,postPath:paths.beforePath}),/FILE_PATH_SCOPE/);await assert.rejects(runCatalogUpdateFileStep({...options,postPath:undefined}),/POST_EXPORT_REQUIRED/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
