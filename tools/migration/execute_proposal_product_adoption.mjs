/** One reviewed create-only batch. No CLI, environment, credentials or default network. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {planProposalProductAdoption,validateAdoptionEvidence} from './plan_proposal_product_adoption.mjs';
import {catalogImportResponse} from '../../workers/erp-api/src/catalog-import.mjs';
import {checkedContactAdoptionPlan,refreshContactAdoption} from './contact_adoption_policy.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw new Error(c);};
const clone=v=>structuredClone(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const adoptionDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
// The original planner published a JSON.stringify digest, not a canonical digest.
const planDigest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bounded=v=>{need(Buffer.byteLength(JSON.stringify(v))<=2*1024*1024,'ADOPTION_FILE_LIMIT');return v;};
function checkedPlan(value,expectedHash,entity='products'){
 if(entity==='contacts')return checkedContactAdoptionPlan(value,expectedHash);
 const p=bounded(clone(value));need(HASH.test(expectedHash)&&planDigest(p)===expectedHash,'PLAN_HASH_MISMATCH');
 need(p.profile==='proposal-product-adoption-plan-v1'&&p.read_only===true&&p.apply_enabled===false&&p.requires_root_review===true&&p.requires_repreview_before_apply===true&&UUID.test(p.actor)&&UUID.test(p.plan_id)&&p.batches?.length===1,'PLAN_SCOPE');
 const b=p.batches[0];need(UUID.test(b.command_id)&&b.command_id!==p.plan_id&&b.entity==='products'&&HASH.test(b.preview_hash)&&b.items?.length>=1&&b.items.length<=50&&b.evidence?.length===b.items.length&&b.mapper_review?.length===b.items.length,'BATCH_SCOPE');
 const e=validateAdoptionEvidence({profile:'proposal-product-adoption-evidence-v1',read_only:true,exported_at:p.evidence_exported_at,has_more:false,items:b.evidence});
 need(e.items.every((x,i)=>x.source_id===b.items[i].source_id&&x.source_hash===b.items[i].source_hash&&Object.keys(b.items[i]).length===2),'BATCH_BINDING');
 return p;
}
function argsFor(p){const b=p.batches[0];return{p_user_id:p.actor,p_entity:b.entity,p_items:clone(b.items),p_command_id:b.command_id,p_preview_hash:b.preview_hash};}
function catalog(value,p,type='preview'){
 const args=argsFor(p);return catalogImportResponse(value,{entity:p.batches[0].entity},{type,args});
}
const profilePrefix=p=>p.batches[0].entity==='contacts'?'proposal-contact-adoption':'proposal-product-adoption';
const previewCore=p=>({...p,items:p.items.map(({last_seen_at,...v})=>v)});
function receipt(raw,p){
 const r=catalog(raw,p,'apply'),b=p.batches[0],ids=new Set();
 need(r.items.every((x,i)=>x.action==='create'&&x.error===null&&UUID.test(x.record_id)&&!ids.has(x.record_id)&&Boolean(ids.add(x.record_id))&&x.source_hash===b.items[i].source_hash&&x.source_version===b.evidence[i].source_version),'RECEIPT_MISMATCH');
 return r;
}
function session(ports,options={}){
 const now=options.now??Date.now,external=options.signal,deadline=options.deadline??now()+600000;
 need(typeof now==='function'&&Number.isFinite(deadline)&&deadline>now()&&deadline<=now()+600000,'DEADLINE_INVALID');
 const captured=Object.fromEntries(['evidence','receipt','proposal','catalog','apply'].map(k=>[k,ports[k]]));
 need(['evidence','receipt','proposal','catalog'].every(k=>typeof captured[k]==='function'),'PORT_REQUIRED');
 const abort=new AbortController();let rejectAbort,calls=0;
 const stopped=new Promise((_,reject)=>{rejectAbort=reject;});stopped.catch(()=>{});
 const cancel=()=>{abort.abort();rejectAbort(new Error('ADOPTION_UNCONFIRMED'));};
 const timer=setTimeout(cancel,Math.max(1,deadline-now()));external?.addEventListener('abort',cancel,{once:true});if(external?.aborted)cancel();
 return{now,deadline,check(){need(!abort.signal.aborted&&now()<deadline,'ADOPTION_DEADLINE');},
  async call(k,arg){this.check();need(++calls<=110&&typeof captured[k]==='function','PORT_SCOPE');const own=clone(arg);return clone(await Promise.race([Promise.resolve().then(()=>{this.check();return captured[k](own,{signal:abort.signal,deadline});}),stopped]));},
  close(){clearTimeout(timer);external?.removeEventListener('abort',cancel);abort.abort();}};
}
function freshExport(raw,now){
 const e=validateAdoptionEvidence(raw),at=Date.parse(e.exported_at);
 need(at<=now+5000&&now-at<=300000,'EVIDENCE_EXPORT_STALE');
 need(e.items.every(x=>Date.parse(x.capture.observed_at)<=at+5000&&Date.parse(x.source_seen_at)<=at+5000&&Date.parse(x.capture.observed_at)<=Date.parse(x.source_seen_at)+5000),'EVIDENCE_TIME_ORDER');return e;
}
async function refresh(p,s){
 if(p.batches[0].entity==='contacts')return refreshContactAdoption(p,s,adoptionDigest);
 const b=p.batches[0],e=freshExport(await s.call('evidence',{plan_id:p.plan_id,command_id:b.command_id}),s.now()),byId=new Map(e.items.map(x=>[x.source_id,x]));
 const selected=b.evidence.map(old=>{const x=byId.get(old.source_id);need(x&&['source_hash','source_version','proposal_id','proposal_hash','proposal_version'].every(k=>x[k]===old[k]),'EVIDENCE_CHANGED');return x;});
 let full;const reader={proposal:id=>s.call('proposal',id),catalog:async items=>{full=catalog(await s.call('catalog',items),p);return full;}};
 let n=0;const replanned=await planProposalProductAdoption({evidence:{...e,items:selected},readers:reader,actor:p.actor,now:()=>new Date(s.now()),uuid:()=>n++?b.command_id:p.plan_id});
 need(replanned.summary.blocked===0&&replanned.batches.length===1&&replanned.summary.planned===b.items.length,'CREATE_REVIEW_CHANGED');
 need(replanned.batches[0].preview_hash===b.preview_hash&&adoptionDigest(replanned.batches[0].mapper_review)===adoptionDigest(b.mapper_review),'MAPPER_REVIEW_CHANGED');
 freshExport(e,s.now());return{preview:previewCore(full),evidence_digest:adoptionDigest(e),evidence_exported_at:e.exported_at};
}
function ledger(raw,p,s){
 const a=argsFor(p);need(raw?.profile==='catalog-import-receipt-export-v1'&&raw.read_only===true&&raw.actor===p.actor&&raw.command_id===a.p_command_id&&raw.body_hash===adoptionDigest(a)&&typeof raw.found==='boolean'&&typeof raw.request_matches==='boolean'&&typeof raw.namespace_conflict==='boolean','LEDGER_EXPORT_INVALID');
 const at=Date.parse(raw.exported_at);need(Number.isFinite(at)&&at<=s.now()+5000&&s.now()-at<=300000,'LEDGER_EXPORT_STALE');
 need(!raw.namespace_conflict&&(!raw.found?raw.request_matches===false&&raw.receipt===null:raw.request_matches===true),'LEDGER_COMMAND_CONFLICT');
 return raw.found?receipt(raw.receipt,p):null;
}
/** Creates a separate review; does not change the immutable original plan or assign a UUID. */
async function prepareReview({plan,planHash,ports,...options},entity){
 const p=checkedPlan(plan,planHash,entity),s=session(ports,options);
 try{need(ledger(await s.call('receipt',argsFor(p)),p,s)===null,'COMMAND_ALREADY_RECORDED');const checked=await refresh(p,s);
  return{profile:profilePrefix(p)+'-review-v1',plan_hash:planHash,actor:p.actor,command_id:p.batches[0].command_id,body_hash:adoptionDigest(argsFor(p)),created_at:new Date(s.now()).toISOString(),...checked,operational_effects:false};
 }finally{s.close();}
}
export const prepareAdoptionReview=input=>prepareReview(input,'products');
export const prepareContactAdoptionReview=input=>prepareReview(input,'contacts');
async function syncDir(directory){const d=await fs.open(directory,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}}
async function writeState(directory,file,state,initial=false){
 const target=initial?file:file+'.tmp-'+randomUUID();const f=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await f.writeFile(JSON.stringify(bounded(state),null,2)+'\n');await f.sync();}finally{await f.close();}
 if(!initial)await fs.rename(target,file);await syncDir(directory);
}
async function readState(file){
 let f;try{f=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await f.stat();need(st.isFile()&&(st.mode&0o077)===0&&st.size<=2*1024*1024,'STATE_FILE_INVALID');return JSON.parse(await f.readFile('utf8'));}
 catch(e){if(e.code==='ENOENT')return null;throw e;}finally{await f?.close();}
}
/** Generates administrative READ ONLY SQL. Caller must export it; this module never executes SQL. */
function receiptExportSql(plan,planHash,entity){
 const p=checkedPlan(plan,planHash,entity),a=argsFor(p),input=JSON.stringify(a).replaceAll("'","''"),body=adoptionDigest(a);
 return `begin read only;\nwith args as(select '${input}'::jsonb a), expected as(select a,encode(sha256(convert_to(jsonb_build_object('actor',(a->>'p_user_id')::uuid,'entity',a->>'p_entity','items',a->'p_items','preview',a->>'p_preview_hash')::text,'UTF8')),'hex') h from args), found as(select c.* from erp_catalog.import_review_command c,expected e where c.command_id=(e.a->>'p_command_id')::uuid)\nselect jsonb_build_object('profile','catalog-import-receipt-export-v1','read_only',true,'exported_at',clock_timestamp(),'actor',e.a->>'p_user_id','command_id',e.a->>'p_command_id','body_hash','${body}','found',f.command_id is not null,'request_matches',coalesce(f.actor=(e.a->>'p_user_id')::uuid and f.request_hash=e.h,false),'namespace_conflict',f.command_id is null and exists(select 1 from erp_catalog.command c where c.command_id=(e.a->>'p_command_id')::uuid),'receipt',case when f.actor=(e.a->>'p_user_id')::uuid and f.request_hash=e.h then f.result else null end) receipt_export from expected e left join found f on true;\ncommit;\n`;
}
export const adoptionReceiptExportSql=(plan,planHash)=>receiptExportSql(plan,planHash,'products');
export const contactAdoptionReceiptExportSql=(plan,planHash)=>receiptExportSql(plan,planHash,'contacts');
/** Explicit single dispatch only. Pending/uncertain always requires a matching ledger export. */
async function executeReview({plan,planHash,review,approvedReviewHash,directory,ports,recoverOnly=false,...options},entity){
 need(typeof recoverOnly==='boolean','RECOVERY_MODE_INVALID');
 const p=checkedPlan(plan,planHash,entity),r=bounded(clone(review)),a=argsFor(p),prefix=profilePrefix(p);
 need(HASH.test(approvedReviewHash)&&adoptionDigest(r)===approvedReviewHash&&r.profile===prefix+'-review-v1'&&r.plan_hash===planHash&&r.actor===p.actor&&r.command_id===a.p_command_id&&r.body_hash===adoptionDigest(a)&&r.operational_effects===false,'REVIEW_NOT_APPROVED');
 const st=await fs.lstat(directory);need(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o022)===0,'STATE_DIRECTORY_INVALID');
 const s=session(ports,options),lockPath=join(directory,prefix+'.lock'),file=join(directory,`${prefix}-${a.p_command_id}.json`);let lock,state;
 try{
  lock=await fs.open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await lock.writeFile(JSON.stringify({owner:randomUUID(),pid:process.pid}));await lock.sync();await syncDir(directory);
  state=await readState(file);
  if(state)need(state.profile===prefix+'-state-v1'&&state.plan_hash===planHash&&state.review_hash===approvedReviewHash&&state.command_id===a.p_command_id&&state.body_hash===r.body_hash&&['pending','acknowledged','verified','current_changed'].includes(state.state),'STATE_BINDING_INVALID');
  let ack=state?.receipt?receipt(state.receipt,p):null;
  if(!ack){ack=ledger(await s.call('receipt',a),p,s);if(!ack&&state) return{outcome:'uncertain',requires_ledger_export:true,dispatched:false};}
  if(!ack&&recoverOnly)return{outcome:'not_recorded',requires_ledger_export:true,dispatched:false};
  if(!ack){
   const checked=await refresh(p,s);need(adoptionDigest(checked.preview)===adoptionDigest(r.preview),'FULL_PREVIEW_CHANGED');s.check();
   state={profile:prefix+'-state-v1',plan_hash:planHash,review_hash:approvedReviewHash,command_id:a.p_command_id,body_hash:r.body_hash,state:'pending',sent_at:new Date(s.now()).toISOString(),receipt:null};
   await writeState(directory,file,state,true);s.check();
   // Everything after durable pending is uncertain until a validated receipt is durable.
   try{ack=receipt(await s.call('apply',a),p);}catch{return{outcome:'uncertain',requires_ledger_export:true,dispatched:true};}
  }
  state={...(state??{profile:prefix+'-state-v1',plan_hash:planHash,review_hash:approvedReviewHash,command_id:a.p_command_id,body_hash:r.body_hash}),state:'acknowledged',receipt:ack};
  await writeState(directory,file,state,!(await readState(file)));
  let current;try{current=catalog(await s.call('catalog',a.p_items),p);}catch{return{outcome:'acknowledged',readback_pending:true,receipt:ack};}
  const same=current.items.every((x,i)=>x.action==='unchanged'&&x.operation_action==='unchanged'&&x.record_id===ack.items[i].record_id&&x.record_version===1&&x.source_hash===ack.items[i].source_hash&&x.source_version===ack.items[i].source_version&&x.origin_state==='synced'&&!x.human_edited&&!x.candidate_retained&&!x.stock_locked&&x.error===null&&['A','S'].includes(x.source_status)&&x.changes.length===0);
  state={...state,state:same?'verified':'current_changed',current,checked_at:new Date(s.now()).toISOString()};await writeState(directory,file,state);
  return{outcome:state.state,receipt:ack,current,operational_effects:false};
 }finally{s.close();if(lock){await lock.close();await fs.unlink(lockPath);await syncDir(directory);}}
}
export const executeReviewedAdoption=input=>executeReview(input,'products');
export const executeReviewedContactAdoption=input=>executeReview(input,'contacts');
export const recoverReviewedAdoption=input=>executeReview({...input,recoverOnly:true},'products');
export const recoverReviewedContactAdoption=input=>executeReview({...input,recoverOnly:true},'contacts');
