/** Local, sequential 055 execution. No CLI, secret lookup, network default or automatic POST retry. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UUID,SOURCE,copyJson,requireBatch,proposalBatchDigest,proposalBatchScope,proposalBatchOperation} from './proposal_batch_port.mjs';
import {PROPOSAL_PLAN_PROFILE,proposalReviewCore,proposalEligible,proposalNativeInventory} from './plan_proposal_batch.mjs';
const HASH=/^[a-f0-9]{64}$/;
const bodyFor=item=>({source_id:item.source_id,preview_hash:item.preview.preview_hash,command_id:item.command_id,confirm_import:true,duplicate_reviewed:true});

async function checkedPlan(plan,approvedPlanHash){
 const p=copyJson(plan);requireBatch(typeof approvedPlanHash==='string'&&HASH.test(approvedPlanHash)&&proposalBatchDigest(p)===approvedPlanHash,'PLAN_NOT_APPROVED');
 requireBatch(p.profile===PROPOSAL_PLAN_PROFILE&&typeof p.plan_id==='string'&&UUID.test(p.plan_id)&&p.duplicate_reviewed===true&&p.coverage_certified===false&&Array.isArray(p.items)&&p.items.length>=1&&p.items.length<=50&&Array.isArray(p.native_baseline)&&p.native_baseline.length<=2500,'PLAN_INVALID');
 const sources=new Set(),commands=new Set([p.plan_id]);
 for(const item of p.items){requireBatch(typeof item.source_id==='string'&&SOURCE.test(item.source_id)&&!sources.has(item.source_id)&&typeof item.command_id==='string'&&UUID.test(item.command_id)&&!commands.has(item.command_id),'PLAN_DUPLICATE');sources.add(item.source_id);commands.add(item.command_id);
  const op=await proposalBatchOperation('preview',{source_id:item.source_id});item.preview=op.project(item.preview);requireBatch(proposalEligible(item.preview)&&proposalBatchDigest(proposalReviewCore(item.preview))===item.review_hash,'PLAN_PREVIEW_INVALID');}
 let after=null;for(let n=0;n<p.native_baseline.length;n+=25){const rows=p.native_baseline.slice(n,n+25),op=await proposalBatchOperation('native',{after});op.project({data_mode:'erp_native',operational_effects:false,kind:'sales_proposals',items:rows,limit:25,has_more:false,next_cursor:null});for(const row of rows){requireBatch(after===null||row.id>after,'PLAN_BASELINE_INVALID');after=row.id;}}
 return p;
}
async function syncDir(directory){const h=await fs.open(directory,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
async function save(directory,file,value,initial=false){
 const bytes=JSON.stringify(copyJson(value),null,2)+'\n',path=initial?file:file+'.tmp-'+randomUUID();requireBatch(Buffer.byteLength(bytes)<=16*1048576,'STATE_SIZE_LIMIT');let h;
 try{h=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await h.writeFile(bytes);await h.sync();await h.close();h=null;if(!initial)await fs.rename(path,file);await syncDir(directory);}
 finally{await h?.close();if(!initial)await fs.unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function read(file){let h;try{h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await h.stat();requireBatch(st.isFile()&&(st.mode&0o077)===0&&st.size<=16*1048576,'STATE_FILE_INVALID');return copyJson(JSON.parse(await h.readFile('utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}finally{await h?.close();}}
function checkReceipt(receipt,item,p){
 const preview=item.preview,b=bodyFor(item);
 requireBatch(receipt.command_id===b.command_id&&receipt.source_id===b.source_id&&receipt.preview_hash===b.preview_hash&&receipt.duplicate_reviewed===true&&receipt.policy==='origin-open-proposal-v2','RECEIPT_BINDING_INVALID');
 requireBatch(['source_hash','source_version','source_number','source_status'].every(k=>receipt[k]===preview[k]),'RECEIPT_SOURCE_CHANGED');
 requireBatch(receipt.document.status==='draft'&&receipt.document.version===1&&receipt.document.date===preview.proposed.date&&receipt.document.contact_id===preview.proposed.contact_id&&receipt.document.total===preview.proposed.totals.total&&!p.native_baseline.some(d=>d.id===receipt.document.id),'RECEIPT_DOCUMENT_INVALID');return receipt;
}
function result(state,outcome,extra={}){return{outcome,total:state.items.length,verified:state.items.filter(i=>i.state==='verified').length,pending:state.items.filter(i=>['pending','acknowledged'].includes(i.state)).length,creates_draft:true,stock_effects:false,financial_effects:false,fiscal_effects:false,coverage_certified:false,...extra};}
function compareInventory(actual,p,state){
 const expected=[...p.native_baseline,...state.items.filter(i=>i.receipt).map(i=>i.receipt.document)],map=new Map(actual.map(d=>[d.id,d])),ids=new Set(expected.map(d=>d.id));
 requireBatch(ids.size===expected.length,'RECEIPT_DOCUMENT_DUPLICATE');
 return{missing:expected.filter(d=>!map.has(d.id)).length,changed:expected.filter(d=>map.has(d.id)&&proposalBatchDigest(d)!==proposalBatchDigest(map.get(d.id))).length,unexpected:actual.filter(d=>!ids.has(d.id)).length};
}
const inventoryChanged=v=>v.missing+v.changed+v.unexpected>0;

/**
 * approvedPlanHash identifies the separate immutable review. mode defaults to GET-only recovery.
 * A pending state is deliberately irreversible here: even 404 cannot authorize another POST.
 * Existing documents are only inventoried/read; this port has no update/status/conversion method.
 */
export async function executeProposalBatch({plan,approvedPlanHash,directory,port,mode='recover',confirmCreateDrafts=false,...options}){
 const p=await checkedPlan(plan,approvedPlanHash);requireBatch(mode==='recover'||mode==='apply'&&confirmCreateDrafts===true,'EXECUTION_NOT_CONFIRMED');
 const st=await fs.lstat(directory);requireBatch(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o022)===0,'STATE_DIRECTORY_INVALID');
 const s=proposalBatchScope(port,options);
 const file=join(directory,`proposal-batch-${p.plan_id}.json`),lockFile=join(directory,'proposal-import.lock');let lock,state;
 try{
  requireBatch(s.actor===p.actor&&s.project_url===p.project_url,'ACTOR_PROJECT_MISMATCH');
  lock=await fs.open(lockFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await lock.writeFile(JSON.stringify({owner:randomUUID(),pid:process.pid}));await lock.sync();await syncDir(directory);
  state=await read(file);
  if(state){requireBatch(state.profile==='proposal-batch-state-055-v1'&&state.plan_hash===approvedPlanHash&&state.actor===p.actor&&state.plan_id===p.plan_id&&state.items.length===p.items.length,'STATE_BINDING_INVALID');
   for(const[i,e]of state.items.entries()){const item=p.items[i];requireBatch(e.command_id===item.command_id&&proposalBatchDigest(e.body)===proposalBatchDigest(bodyFor(item))&&['prepared','pending','acknowledged','verified','current_changed'].includes(e.state),'STATE_ITEM_INVALID');
    if(e.receipt){const op=await proposalBatchOperation('apply',e.body),ack=op.project({data_mode:'proposal_import_review',policy:'origin-open-proposal-v2',entity:'sales_proposals',creates_draft:true,stock_effects:false,financial_effects:false,fiscal_effects:false,coverage_certified:false,cutoff_at:null,dry_run:false,persisted:true,replayed:true,receipt:e.receipt});checkReceipt(ack.receipt,item,p);}
    requireBatch(e.state==='prepared'||e.state==='pending'||e.receipt!==null,'STATE_RECEIPT_MISSING');
   }
  }else{state={profile:'proposal-batch-state-055-v1',plan_id:p.plan_id,plan_hash:approvedPlanHash,actor:p.actor,created_at:new Date().toISOString(),items:p.items.map(item=>({command_id:item.command_id,body:bodyFor(item),state:'prepared',receipt:null,current:null}))};await save(directory,file,state,true);}
  async function readback(index){
   const item=p.items[index],entry=state.items[index],current=await s.call('command',{command_id:item.command_id}),receipt=checkReceipt(current.receipt,item,p);
   if(entry.receipt)requireBatch(proposalBatchDigest(entry.receipt)===proposalBatchDigest(receipt),'HISTORICAL_RECEIPT_CHANGED');
   requireBatch(proposalBatchDigest(current.historical_evidence.normalized_body)===proposalBatchDigest(item.preview.proposed)&&proposalBatchDigest(current.historical_evidence.source_evidence)===proposalBatchDigest(item.preview.source_evidence)&&proposalBatchDigest(current.historical_evidence.transformations)===proposalBatchDigest(item.preview.transformations),'HISTORICAL_EVIDENCE_CHANGED');
   requireBatch(!state.items.some((e,n)=>n!==index&&e.receipt?.document.id===receipt.document.id),'RECEIPT_DOCUMENT_DUPLICATE');
   const d=current.current_document,same=d.version===1&&d.status==='draft'&&d.effect_flags.finance_active===false&&d.effect_flags.stock_active===false;
   // Keep the durable journal small. The immutable reviewed content is in the plan; current
   // content has been checked above and is represented separately by metadata and digest.
   const currentEvidence={document:{id:d.id,version:d.version,status:d.status,updated_at:d.updated_at,effect_flags:d.effect_flags},document_hash:proposalBatchDigest(d),historical_evidence_hash:proposalBatchDigest(current.historical_evidence)};
   Object.assign(entry,{receipt,current:currentEvidence,state:same?'verified':'current_changed',checked_at:new Date().toISOString()});await save(directory,file,state);return same;
  }
  // Receipt first, including an unstarted local command. A previous process may have committed.
  for(let i=0;i<p.items.length;i++){
   const e=state.items[i];try{if(!await readback(i))return result(state,'current_changed');}
   catch(error){if(error.status===404&&e.state==='prepared'&&e.receipt===null)continue;return result(state,e.receipt?'acknowledged':'unresolved',{recovery_required:true});}
  }
  if(mode==='recover'&&state.items.some(e=>e.state==='prepared'))return result(state,'prepared',{dispatched:false});
  const before=compareInventory(await proposalNativeInventory(s),p,state);if(inventoryChanged(before))return result(state,'baseline_changed',{inventory:before,dispatched:false});
  for(let i=0;i<p.items.length;i++){
   const item=p.items[i],entry=state.items[i];if(entry.state==='verified')continue;
   requireBatch(entry.state==='prepared'&&entry.receipt===null,'COMMAND_REQUIRES_RECOVERY');
   const preview=await s.call('preview',{source_id:item.source_id});
   if(!proposalEligible(preview)||proposalBatchDigest(proposalReviewCore(preview))!==item.review_hash)return result(state,'source_changed',{stopped_before_next_dispatch:true});
   Object.assign(entry,{state:'pending',sent_at:new Date().toISOString(),observed_before_send:preview.source_seen_at});await save(directory,file,state);s.check();
   try{
    const ack=await s.call('apply',entry.body);checkReceipt(ack.receipt,item,p);entry.receipt=ack.receipt;entry.state='acknowledged';await save(directory,file,state);
   }catch{
    // There is exactly one dispatch attempt. Recover only by querying this command UUID.
    try{if(!await readback(i))return result(state,'current_changed');}catch{return result(state,entry.receipt?'acknowledged':'unresolved',{recovery_required:true});}
   }
   if(entry.state!=='verified'){try{if(!await readback(i))return result(state,'current_changed');}catch{return result(state,'acknowledged',{recovery_required:true});}}
  }
  const inventory=compareInventory(await proposalNativeInventory(s),p,state);state.final_inventory={...inventory,checked_at:new Date().toISOString(),coherent_snapshot:false};await save(directory,file,state);
  return result(state,inventoryChanged(inventory)?'baseline_changed':'complete',{inventory,draft_version_1_verified:state.items.every(e=>e.state==='verified')});
 }finally{s.close();if(lock){await lock.close();await fs.unlink(lockFile);await syncDir(directory);}}
}
