/** Read-only audit and explicit selection. All commercial data is returned to the caller, never logged. */
import {randomUUID} from 'node:crypto';
import {UUID,SOURCE,copyJson,requireBatch,proposalBatchDigest,proposalBatchScope,proposalBatchOperation} from './proposal_batch_port.mjs';
export {proposalBatchDigest};
export const PROPOSAL_PLAN_PROFILE='reviewed-proposals-055-v1';
export const proposalReviewCore=p=>Object.fromEntries(['source_id','source_hash','source_version','source_status','source_number','preview_hash','bindings','proposed','source_evidence','transformations'].map(k=>[k,p[k]]));
export const proposalEligible=p=>p.can_apply===true&&p.existing===null&&p.issues.length===0&&p.bindings.every(b=>b.valid);
const open=new Set(['Rascunho','Pendente','Aguardando']);

export async function proposalNativeInventory(scope,maxPages=100){
 const rows=[],seen=new Set();let after=null;
 for(let n=0;n<maxPages;n++){
  const page=await scope.call('native',{after});let last=after;
  for(const row of page.items){requireBatch(!seen.has(row.id)&&(last===null||row.id>last),'NATIVE_PAGE_ORDER');seen.add(row.id);last=row.id;rows.push(row);}
  requireBatch(page.has_more? page.items.length===25&&page.next_cursor===last:page.next_cursor===null,'NATIVE_CURSOR_INVALID');
  if(!page.has_more)return rows;after=page.next_cursor;
 }
 throw new Error('NATIVE_PAGE_LIMIT');
}

export async function auditProposalBatch({port,maxPages=100,...options}){
 requireBatch(Number.isInteger(maxPages)&&maxPages>=1&&maxPages<=100,'PAGE_LIMIT_INVALID');const s=proposalBatchScope(port,options),started_at=new Date().toISOString();
 try{
  const source_rows=[],previews=[],seen=new Set();let after=null,done=false;
  for(let n=0;n<maxPages;n++){const page=await s.call('sources',{after});for(const row of page.items){requireBatch(!seen.has(row.source_id),'SOURCE_DUPLICATE');seen.add(row.source_id);source_rows.push(row);}if(!page.has_more){done=true;break;}requireBatch(page.next_cursor!==after&&(after===null||page.next_cursor>after),'SOURCE_CURSOR_INVALID');after=page.next_cursor;}
  requireBatch(done,'SOURCE_PAGE_LIMIT');
  for(const row of source_rows){if(row.document_id!==null||!open.has(row.source_status))continue;const p=await s.call('preview',{source_id:row.source_id});
   requireBatch(['source_id','source_hash','source_version','source_status'].every(k=>p[k]===row[k]),'AUDIT_SOURCE_CHANGED');previews.push(p);copyJson(previews);
  }
  const native_documents=await proposalNativeInventory(s,maxPages);
  return copyJson({profile:'proposal-audit-055-v1',actor:s.actor,project_url:s.project_url,started_at,finished_at:new Date().toISOString(),read_only:true,coverage_certified:false,coherent_snapshot:false,source_rows,previews,native_documents,
   summary:{sources:source_rows.length,already_linked:source_rows.filter(r=>r.document_id!==null).length,reviewed:previews.length,eligible:previews.filter(proposalEligible).length,blocked:previews.filter(p=>!proposalEligible(p)).length,native_documents:native_documents.length}});
 }finally{s.close();}
}

/** Explicit IDs only. UUIDs are assigned once; no automatic inclusion of all eligible sources. */
export async function prepareProposalBatch({audit,selectedSourceIds,duplicateReviewed,uuid=randomUUID}){
 const a=copyJson(audit),ids=copyJson(selectedSourceIds,4096);requireBatch(a.profile==='proposal-audit-055-v1'&&a.read_only===true&&a.coverage_certified===false&&a.coherent_snapshot===false&&typeof a.actor==='string'&&UUID.test(a.actor)&&/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(a.project_url),'AUDIT_INVALID');
 requireBatch(duplicateReviewed===true&&Array.isArray(ids)&&ids.length>=1&&ids.length<=50&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&SOURCE.test(id))&&typeof uuid==='function','SELECTION_NOT_REVIEWED');
 requireBatch(Array.isArray(a.previews)&&Array.isArray(a.source_rows)&&Array.isArray(a.native_documents)&&new Set(a.previews.map(p=>p.source_id)).size===a.previews.length,'AUDIT_INVALID');
 const items=[],commands=new Set(),plan_id=uuid();requireBatch(UUID.test(plan_id),'UUID_INVALID');commands.add(plan_id);
 for(const id of ids){const raw=a.previews.find(p=>p.source_id===id),row=a.source_rows.find(r=>r.source_id===id);requireBatch(raw&&row&&row.document_id===null,'SOURCE_NOT_REVIEWED');
  const op=await proposalBatchOperation('preview',{source_id:id}),preview=op.project(raw);requireBatch(proposalEligible(preview)&&['source_hash','source_version','source_status'].every(k=>row[k]===preview[k]),'SOURCE_NOT_ELIGIBLE');
  const command_id=uuid();requireBatch(typeof command_id==='string'&&UUID.test(command_id)&&!commands.has(command_id),'UUID_INVALID');commands.add(command_id);
  items.push({source_id:id,command_id,preview,review_hash:proposalBatchDigest(proposalReviewCore(preview))});
 }
 // Reuse the native DTO even for caller-provided audit JSON; never trust a forged summary.
 const native=[];let after=null;for(let n=0;n<a.native_documents.length;n+=25){const rows=a.native_documents.slice(n,n+25),op=await proposalBatchOperation('native',{after}),page=op.project({data_mode:'erp_native',operational_effects:false,kind:'sales_proposals',items:rows,limit:25,page:null,order:'id',has_more:false,next_cursor:null,total_count:a.native_documents.length,total_amount:'0.00'});
  for(const row of page.items){requireBatch(after===null||row.id>after,'NATIVE_PAGE_ORDER');after=row.id;native.push(row);}}
 return copyJson({profile:PROPOSAL_PLAN_PROFILE,plan_id,actor:a.actor,project_url:a.project_url,created_at:new Date().toISOString(),audit_hash:proposalBatchDigest(a),duplicate_reviewed:true,coverage_certified:false,native_baseline:native,items});
}
