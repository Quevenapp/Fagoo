/** One explicitly reviewed update batch. No CLI, secrets, network defaults or automatic POST retry. */
import fs from 'node:fs/promises';import {constants} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {adoptionDigest} from './execute_proposal_product_adoption.mjs';
import {checkedUpdatePlan,captureUpdate as copy,requireUpdate as need,updateArgs} from './catalog_update_preservation.mjs';
import {catalogImportResponse} from '../../workers/erp-api/src/catalog-import.mjs';
export {catalogUpdatePreservationSql} from './catalog_update_preservation.mjs';
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const equal=(a,b)=>adoptionDigest(a)===adoptionDigest(b),bounded=v=>{need(Buffer.byteLength(JSON.stringify(v))<=2*1024*1024,'LOCAL_DATA_LIMIT');return v;};
const catalog=(raw,p,type='preview')=>catalogImportResponse(raw,{entity:'products'},{type,args:updateArgs(p)});
const core=p=>({...p,items:p.items.map(({last_seen_at,...rest})=>rest)});
const stamp=(at,now)=>{const time=Date.parse(at);need(Number.isFinite(time)&&time<=now+5000&&now-time<=300000,'EXPORT_STALE');};
function scope(ports,options){
 const get=(o,k)=>{const d=Object.getOwnPropertyDescriptor(o,k);need(!d||'value'in d,'PORT_ACCESSOR');return d?.value;};
 const now=get(options,'now')??Date.now,external=get(options,'signal'),deadline=get(options,'deadline')??now()+600000;
 need(typeof now==='function'&&Number.isFinite(deadline)&&deadline>now()&&deadline<=now()+600000&&(!external||external instanceof AbortSignal),'DEADLINE_INVALID');
 const owned=Object.fromEntries(['receipt','preservation','proposal','catalog','apply'].map(k=>[k,get(ports,k)]));need(['receipt','preservation','proposal','catalog'].every(k=>typeof owned[k]==='function'),'PORT_REQUIRED');
 const abort=new AbortController();let reject,calls=0;const stopped=new Promise((_,r)=>{reject=r;});stopped.catch(()=>{});
 const cancel=()=>{abort.abort();reject(new Error('UPDATE_INTERRUPTED'));},check=()=>need(!abort.signal.aborted&&now()<deadline,'UPDATE_INTERRUPTED');
 const timer=setTimeout(cancel,Math.max(1,deadline-now()));external?.addEventListener('abort',cancel,{once:true});if(external?.aborted)cancel();
 return{now,check,async call(k,arg){check();need(++calls<=110&&typeof owned[k]==='function','PORT_SCOPE');const a=copy(arg);const raw=await Promise.race([Promise.resolve().then(()=>{check();return owned[k](a,{signal:abort.signal,deadline});}),stopped]);check();return bounded(copy(raw));},close(){clearTimeout(timer);external?.removeEventListener('abort',cancel);abort.abort();}};
}
function ack(raw,p){const r=catalog(raw,p,'apply');need(r.items.every((x,i)=>{const e=p.expected[i];return x.action==='update'&&x.error===null&&x.record_id===e.record_id&&x.source_id===e.source_id&&x.source_hash===e.source_hash&&x.source_version===e.source_version;}),'RECEIPT_MISMATCH');return r;}
function ledger(raw,p,s){
 need(raw?.profile==='catalog-import-receipt-export-v1'&&raw.read_only===true&&raw.actor===p.actor&&raw.command_id===p.command_id&&raw.body_hash===adoptionDigest(updateArgs(p))&&typeof raw.found==='boolean'&&typeof raw.request_matches==='boolean'&&typeof raw.namespace_conflict==='boolean','LEDGER_INVALID');stamp(raw.exported_at,s.now());
 need(!raw.namespace_conflict&&(!raw.found?raw.request_matches===false&&raw.receipt===null:raw.request_matches===true),'LEDGER_CONFLICT');return raw.found?ack(raw.receipt,p):null;
}
function proof(raw,p,hash,now){
 need(raw?.profile==='catalog-update-preservation-v1'&&raw.read_only===true&&raw.plan_hash===hash&&raw.actor===p.actor&&raw.command_id===p.command_id,'PRESERVATION_BINDING');stamp(raw.exported_at,now);
 need(raw.catalog_count===p.baseline.catalog_count&&raw.native_proposals?.count===p.baseline.document_count&&raw.native_proposals.draft_version_1===p.baseline.document_count,'BASELINE_COUNTS');
 need(Array.isArray(raw.selected)&&raw.selected.length===p.expected.length&&new Set(raw.selected.map(x=>x.source_id)).size===p.expected.length,'PRESERVATION_SELECTION');
 need(Array.isArray(raw.preserved_relations)&&raw.preserved_relations.length>0&&new Set(raw.preserved_relations.map(x=>x.schema+'.'+x.table)).size===raw.preserved_relations.length&&raw.preserved_relations.every(x=>HASH.test(x.hash)&&HASH.test(x.access_hash)&&Number.isSafeInteger(x.count)&&x.count>=0),'RELATION_PROOF');
 for(const key of ['erp_catalog.record','erp_catalog.product','erp_catalog.origin','erp_catalog.source_snapshot','erp_catalog.command','erp_catalog.import_review_command','erp_catalog.audit','erp_documents.document','erp_documents.item','erp_documents.command','erp_documents.origin_import_origin','erp_stock.entry','erp_finance.title'])need(raw.preserved_relations.some(x=>x.schema+'.'+x.table===key),'RELATION_MISSING');
 need(Array.isArray(raw.functions)&&raw.functions.every(x=>typeof x.signature==='string'&&HASH.test(x.definition_hash)&&HASH.test(x.access_hash))&&new Set(raw.functions.map(x=>x.signature)).size===raw.functions.length,'FUNCTION_PROOF');
 for(const name of ['erp_catalog.data(','erp_catalog.map_origin(','erp_catalog.write_fields(','erp_catalog.validate_data(','erp_catalog.import_review_plan(','erp_catalog_import_origin(','erp_catalog_import_apply('])need(raw.functions.some(x=>x.signature.replace(/^public\./,'').startsWith(name)),'FUNCTION_MISSING');
 return raw;
}
function before(raw,p,hash,now){
 const r=proof(raw,p,hash,now);need(r.command_rows?.inner===0&&r.command_rows.review===0&&Array.isArray(r.audit)&&r.audit.length===0,'COMMAND_ALREADY_RECORDED');
 const expectedWitness=p.expected.flatMap(e=>e.witnesses.map(w=>({product_id:e.source_id,proposal_id:w.source_id,source_hash:w.source_hash,source_version:w.source_version,open_status:true,already_imported:false,exact_product_reference:true}))).sort((a,b)=>a.product_id.localeCompare(b.product_id)||a.proposal_id.localeCompare(b.proposal_id));
 need(equal([...r.witnesses].sort((a,b)=>a.product_id.localeCompare(b.product_id)||a.proposal_id.localeCompare(b.proposal_id)),expectedWitness),'WITNESS_CHANGED');
 for(const e of p.expected){const x=r.selected.find(x=>x.source_id===e.source_id);
  need(x.id===e.record_id&&x.version===e.record_version&&x.source_hash===e.source_hash&&x.source_version===e.source_version&&x.active===true&&x.expected_active===true&&x.source_simple_product===true&&x.human_edited===false&&x.stock_locked===false&&x.candidate_retained===false&&x.native_document_usage===e.native_document_usage,'PRODUCT_CAS_CHANGED');
  need(x.capture?.profile==='origin-price-json-v1'&&x.capture.source==='detail'&&x.capture.source_hash===e.source_hash&&x.capture.source_version===e.source_version&&HASH.test(x.capture.response_sha256)&&UUID.test(x.capture.capture_id)&&x.numeric_price===true,'CAPTURE_REQUIRED');
  const at=Date.parse(x.capture.observed_at),seen=Date.parse(x.source_seen_at);need(Number.isFinite(at)&&Number.isFinite(seen)&&at<=Date.parse(r.exported_at)+5000&&seen<=Date.parse(r.exported_at)+5000&&at<=seen+5000,'CAPTURE_TIME_INVALID');
  need(HASH.test(x.data_hash)&&HASH.test(x.expected_data_hash)&&HASH.test(x.stable_record_hash)&&HASH.test(x.dto_hash)&&HASH.test(x.expected_snapshot_hash),'PRODUCT_PROOF');
  const fields=Object.keys({...x.before_data,...x.expected_data}).filter(k=>!equal(x.before_data[k]??null,x.expected_data[k]??null)).sort();
  need(equal(fields,e.allowed_changes.map(c=>c.field).sort())&&equal(fields,x.changed_fields),'FULL_DATA_DELTA');
  for(const c of e.allowed_changes)need(equal(x.before_data[c.field],c.before)&&equal(x.expected_data[c.field],c.after),'APPROVED_DELTA_CHANGED');
  need(x.target_snapshot_hash===null&&x.target_snapshot_semantic_hash===null||HASH.test(x.target_snapshot_hash)&&x.target_snapshot_semantic_hash===x.expected_snapshot_hash,'TARGET_SNAPSHOT_CONFLICT');
 }
 return r;
}
// Observation timestamps may advance under normal collection; content/capture identity stays explicit.
const comparison=r=>({...r,exported_at:null,selected:r.selected.map(({source_seen_at,...x})=>x)});
async function refresh(p,hash,s){
 const preservation=before(await s.call('preservation',{plan_hash:hash,command_id:p.command_id}),p,hash,s.now());
 const witness=new Map(p.expected.flatMap(e=>e.witnesses.map(w=>[w.source_id,w])));
 for(const [id,w] of witness){const x=await s.call('proposal',id);need(x?.dry_run===true&&x.persisted===false&&x.source_id===id&&x.source_hash===w.source_hash&&x.source_version===w.source_version&&['Rascunho','Pendente','Aguardando'].includes(x.source_status)&&x.existing===null&&Array.isArray(x.bindings),'PROPOSAL_CHANGED');
  for(const e of p.expected.filter(e=>e.witnesses.some(z=>z.source_id===id)))need(x.bindings.some(b=>b.entity==='products'&&b.source_id===e.source_id&&b.source_hash===e.source_hash&&b.source_version===e.source_version&&b.record_id===e.record_id),'PROPOSAL_PRODUCT_CHANGED');
 }
 const preview=catalog(await s.call('catalog',p.items),p);
 need(equal(core(preview),core(catalog(p.preview,p)))&&preview.items.every((x,i)=>x.action==='update'&&x.operation_action==='update'&&!x.human_edited&&!x.stock_locked&&!x.candidate_retained&&x.error===null&&x.record_id===p.expected[i].record_id&&x.record_version===p.expected[i].record_version),'PREVIEW_CHANGED');
 stamp(preservation.exported_at,s.now());return{preservation,preview:core(preview)};
}
export async function prepareCatalogUpdateReview({plan,planHash,ports,...options}){
 const p=checkedUpdatePlan(plan,planHash),s=scope(ports,options);try{need(ledger(await s.call('receipt',updateArgs(p)),p,s)===null,'COMMAND_ALREADY_RECORDED');const fresh=await refresh(p,planHash,s);return{profile:'catalog-updates-review-v1',plan_hash:planHash,actor:p.actor,command_id:p.command_id,body_hash:adoptionDigest(updateArgs(p)),created_at:new Date(s.now()).toISOString(),...fresh,operational_effects:false};}finally{s.close();}
}
export function verifyCatalogUpdatePreservation(raw,review,plan,planHash,now=Date.now()){
 const p=checkedUpdatePlan(plan,planHash),r=proof(copy(raw),p,planHash,now),b=review.preservation;
 need(equal(r.preserved_relations,b.preserved_relations)&&equal(r.functions,b.functions),'UNSELECTED_OR_HISTORICAL_CHANGED');
 need(r.command_rows.inner===1&&r.command_rows.review===1&&r.audit?.length===p.expected.length&&new Set(r.audit.map(x=>x.record_id)).size===p.expected.length,'COMMAND_EFFECTS_CHANGED');
 for(const e of p.expected){const x=r.selected.find(x=>x.source_id===e.source_id),old=b.selected.find(x=>x.source_id===e.source_id),a=r.audit.find(x=>x.record_id===e.record_id);
  need(x.id===e.record_id&&x.version===e.expected_record_version&&x.updated_by===p.actor&&Date.parse(x.updated_at)>=Date.parse(b.exported_at)-5000&&x.active===old.expected_active&&!x.human_edited&&!x.candidate_retained&&!x.stock_locked&&x.native_document_usage===old.native_document_usage&&x.stable_record_hash===old.stable_record_hash&&x.data_hash===old.expected_data_hash&&equal(x.before_data,old.expected_data),'SELECTED_DATA_CHANGED');
  need(x.source_hash===e.source_hash&&x.source_version===e.source_version&&x.applied_hash===e.source_hash&&x.latest_hash===e.source_hash&&x.origin_state==='synced','CURRENT_ORIGIN_CHANGED');
  need(x.target_snapshot_semantic_hash===old.expected_snapshot_hash&&HASH.test(x.target_snapshot_hash)&&(old.target_snapshot_hash===null||x.target_snapshot_hash===old.target_snapshot_hash),'SNAPSHOT_CHANGED');
  need(a.actor===p.actor&&a.entity==='products'&&a.action==='import_update'&&a.before_hash===old.dto_hash&&a.after_hash===x.dto_hash,'AUDIT_CHANGED');
 }
 return r;
}
async function syncDir(dir){const f=await fs.open(dir,constants.O_RDONLY);try{await f.sync();}finally{await f.close();}}
async function save(dir,path,value,initial=false){const target=initial?path:path+'.tmp-'+randomUUID(),f=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(JSON.stringify(bounded(value),null,2)+'\n');await f.sync();}finally{await f.close();}if(!initial)await fs.rename(target,path);await syncDir(dir);}
async function read(path){let f;try{f=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await f.stat();need(st.isFile()&&(st.mode&0o077)===0&&st.size<=2*1024*1024,'STATE_INVALID');return JSON.parse(await f.readFile('utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}finally{await f?.close();}}
export function catalogUpdateReceiptExportSql(plan,planHash){const p=checkedUpdatePlan(plan,planHash),a=updateArgs(p),input=JSON.stringify(a).replaceAll("'","''");return `begin read only;\nset local statement_timeout='15s';\nwith args as(select '${input}'::jsonb a), expected as(select a,encode(sha256(convert_to(jsonb_build_object('actor',(a->>'p_user_id')::uuid,'entity',a->>'p_entity','items',a->'p_items','preview',a->>'p_preview_hash')::text,'UTF8')),'hex') h from args), found as(select c.* from erp_catalog.import_review_command c,expected e where c.command_id=(e.a->>'p_command_id')::uuid)\nselect jsonb_build_object('profile','catalog-import-receipt-export-v1','read_only',true,'exported_at',clock_timestamp(),'actor',e.a->>'p_user_id','command_id',e.a->>'p_command_id','body_hash','${adoptionDigest(a)}','found',f.command_id is not null,'request_matches',coalesce(f.actor=(e.a->>'p_user_id')::uuid and f.request_hash=e.h,false),'namespace_conflict',f.command_id is null and exists(select 1 from erp_catalog.command c where c.command_id=(e.a->>'p_command_id')::uuid),'receipt',case when f.actor=(e.a->>'p_user_id')::uuid and f.request_hash=e.h then f.result else null end)receipt_export from expected e left join found f on true;\ncommit;\n`;}
export async function executeReviewedCatalogUpdates({plan,planHash,review,approvedReviewHash,directory,ports,recoverOnly=false,...options}){
 const p=checkedUpdatePlan(plan,planHash),r=bounded(copy(review)),a=updateArgs(p);need(typeof recoverOnly==='boolean'&&HASH.test(approvedReviewHash)&&adoptionDigest(r)===approvedReviewHash&&r.profile==='catalog-updates-review-v1'&&r.plan_hash===planHash&&r.actor===p.actor&&r.command_id===p.command_id&&r.body_hash===adoptionDigest(a)&&r.operational_effects===false,'REVIEW_NOT_APPROVED');
 const s=scope(ports,options),lockPath=join(directory,'catalog-reviewed-updates.lock'),file=join(directory,`catalog-reviewed-updates-${p.command_id}.json`);let lock,state;
 try{
  const st=await fs.lstat(directory);need(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o022)===0,'DIRECTORY_INVALID');
  lock=await fs.open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await lock.writeFile(JSON.stringify({owner:randomUUID(),pid:process.pid}));await lock.sync();await syncDir(directory);
  state=await read(file);if(state)need(state.profile==='catalog-updates-state-v1'&&state.plan_hash===planHash&&state.review_hash===approvedReviewHash&&state.command_id===p.command_id&&state.body_hash===r.body_hash&&['pending','acknowledged','verified','current_changed'].includes(state.state),'STATE_BINDING_INVALID');
  let result=state?.receipt?ack(state.receipt,p):null;
  if(!result){result=ledger(await s.call('receipt',a),p,s);if(!result&&state)return{outcome:'uncertain',requires_ledger_export:true,dispatched:false};}
  if(!result&&recoverOnly)return{outcome:'not_recorded',requires_ledger_export:true,dispatched:false};
  if(!result){const fresh=await refresh(p,planHash,s);need(equal(fresh.preview,r.preview)&&equal(comparison(fresh.preservation),comparison(r.preservation)),'REVIEW_CHANGED');s.check();
   state={profile:'catalog-updates-state-v1',plan_hash:planHash,review_hash:approvedReviewHash,command_id:p.command_id,body_hash:r.body_hash,state:'pending',sent_at:new Date(s.now()).toISOString(),receipt:null};await save(directory,file,state,true);
   try{s.check();result=ack(await s.call('apply',a),p);}catch{return{outcome:'uncertain',requires_ledger_export:true,dispatched:true};}
  }
  state={...(state??{profile:'catalog-updates-state-v1',plan_hash:planHash,review_hash:approvedReviewHash,command_id:p.command_id,body_hash:r.body_hash}),state:'acknowledged',receipt:result};await save(directory,file,state,!(await read(file)));
  let current,post;try{current=catalog(await s.call('catalog',p.items),p);post=await s.call('preservation',{plan_hash:planHash,command_id:p.command_id});}catch{return{outcome:'acknowledged',readback_pending:true,receipt:result};}
  let code=null;try{need(current.items.every((x,i)=>{const e=p.expected[i];return x.action==='unchanged'&&x.operation_action==='unchanged'&&x.record_id===e.record_id&&x.record_version===e.expected_record_version&&x.source_hash===e.source_hash&&x.source_version===e.source_version&&x.origin_state==='synced'&&!x.human_edited&&!x.stock_locked&&!x.candidate_retained&&x.error===null&&x.changes.length===0;}),'CURRENT_CHANGED');verifyCatalogUpdatePreservation(post,r,p,planHash,s.now());}catch(e){code=/^[A-Z_]+$/.test(e.message)?e.message:'PRESERVATION_INVALID';}
  if(code==='EXPORT_STALE'||post.command_rows?.inner===0&&post.command_rows?.review===0)return{outcome:'acknowledged',readback_pending:true,preservation_export_required:true,receipt:result};
  state={...state,state:code?'current_changed':'verified',current,preservation:post,checked_at:new Date(s.now()).toISOString(),code};await save(directory,file,state);return{outcome:state.state,code,receipt:result,current,operational_effects:false};
 }finally{s.close();if(lock){await lock.close();await fs.unlink(lockPath);await syncDir(directory);}}
}
export const recoverReviewedCatalogUpdates=input=>executeReviewedCatalogUpdates({...input,recoverOnly:true});
