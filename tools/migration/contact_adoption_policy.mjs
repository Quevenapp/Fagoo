/** Local create-only contact policy. No network, credentials, SQL execution or writes. */
import {createHash} from 'node:crypto';
import {catalogImportResponse} from '../../workers/erp-api/src/catalog-import.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/,ID=/^[1-9][0-9]{0,39}$/;
const need=(v,c)=>{if(!v)throw new Error(c);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const core=p=>({...p,items:p.items.map(({last_seen_at,...row})=>row)});
export function checkedContactAdoptionPlan(value,expectedHash){
 const p=structuredClone(value);
 need(Buffer.byteLength(JSON.stringify(p))<=2097152&&HASH.test(expectedHash)&&hash(p)===expectedHash,'PLAN_HASH_MISMATCH');
 need(p.profile==='proposal-contact-adoption-plan-v1'&&p.read_only===true&&p.apply_enabled===false&&p.requires_root_review===true&&p.requires_repreview_before_apply===true&&p.requires_collision_evidence===true&&UUID.test(p.actor)&&UUID.test(p.plan_id)&&p.batches?.length===1,'PLAN_SCOPE');
 const b=p.batches[0];need(b.entity==='contacts'&&UUID.test(b.command_id)&&b.command_id!==p.plan_id&&HASH.test(b.preview_hash)&&b.items?.length>0&&b.items.length<=50&&b.evidence?.length===b.items.length&&b.mapper_review?.length===b.items.length&&Array.isArray(b.missing_document_review),'BATCH_SCOPE');
 const seen=new Set();b.items.forEach((v,i)=>{
  const e=b.evidence[i];need(Object.keys(v).length===2&&ID.test(v.source_id)&&HASH.test(v.source_hash)&&!seen.has(v.source_id),'BATCH_BINDING');seen.add(v.source_id);
  need(e&&e.source_id===v.source_id&&e.source_hash===v.source_hash&&version(e.source_version)&&ID.test(e.proposal_id)&&HASH.test(e.proposal_hash)&&version(e.proposal_version),'BATCH_BINDING');
 });
 const missing=new Set();for(const e of b.missing_document_review){need(e&&seen.has(e.source_id)&&!missing.has(e.source_id)&&HASH.test(e.signature_hash)&&Array.isArray(e.present_fields)&&e.present_fields.length>1&&e.document_remains_absent===true&&e.create_only_explicitly_reviewed===true,'CONTACT_DOCUMENT_REVIEW_REQUIRED');missing.add(e.source_id);}
 return p;
}
/** The proof contains only hashes, identifiers and match flags, never personal field values. */
export function checkCatalogCollisionEvidence(value,batch,now,missingProof=null){
 const v=structuredClone(value),at=Date.parse(v?.exported_at);
 need(v?.profile==='proposal-catalog-collision-evidence-v1'&&v.read_only===true&&Number.isInteger(v.native_count)&&v.native_count>=0&&HASH.test(v.native_fingerprint)&&Array.isArray(v.items)&&v.items.length<=500&&v.selection_count===v.items.length,'COLLISION_EXPORT_INVALID');
 need(Number.isFinite(at)&&at<=now+5000&&now-at<=300000,'COLLISION_EXPORT_STALE');
 const seen=new Set();for(const row of v.items){const key=row.entity+':'+row.source_id;need(!seen.has(key),'COLLISION_EXPORT_DUPLICATE');seen.add(key);}
 for(let i=0;i<batch.items.length;i++){
  const item=batch.items[i],e=batch.evidence[i],r=v.items.find(x=>x.entity===batch.entity&&x.source_id===item.source_id);
  need(r&&r.reason==='source_present_no_native_binding'&&r.source_hash===item.source_hash&&r.source_version===e.source_version&&r.expected_hash_matches===true&&r.expected_version_matches===true&&r.record_id===null&&r.origin_state===null&&r.applied_hash===null&&r.latest_hash===null&&['A','S'].includes(r.source_status),'COLLISION_SOURCE_CHANGED');
  need(r.code_present===true&&['native_document_collisions','native_code_collisions','selection_document_collisions','selection_code_collisions'].every(k=>Array.isArray(r[k])&&r[k].length===0),'COLLISION_REVIEW_REQUIRED');
  if(batch.entity==='contacts'&&!(r.document_present===true&&r.document_syntax_valid===true)){
   const reviewed=batch.missing_document_review?.find(x=>x.source_id===item.source_id),m=missingProof;
   need(r.document_present===false&&r.document_syntax_valid===null&&reviewed&&m?.profile==='missing-document-contact-evidence-v1'&&m.read_only===true&&m.linking_authorized===false&&Number.isInteger(m.native_contacts)&&m.native_contacts>=0&&Array.isArray(m.items)&&m.items.length===batch.missing_document_review.length,'CONTACT_DOCUMENT_REVIEW_REQUIRED');
   const stamp=Date.parse(m.exported_at);need(Number.isFinite(stamp)&&stamp<=now+5000&&now-stamp<=300000,'COLLISION_EXPORT_STALE');
   const matches=m.items.filter(x=>x.source_id===item.source_id),row=matches[0];
   need(matches.length===1&&row.cas_matches===true&&row.source_hash===item.source_hash&&row.source_version===e.source_version&&row.signature_hash===reviewed.signature_hash&&Array.isArray(row.present_fields)&&hash([...row.present_fields].sort())===hash([...reviewed.present_fields].sort())&&Array.isArray(row.native_candidates)&&row.native_candidates.length===0,'CONTACT_DOCUMENT_REVIEW_REQUIRED');
  }
 }
 return v;
}
export async function refreshContactAdoption(p,s,digest){
 const b=p.batches[0],input=await s.call('evidence',{plan_id:p.plan_id,command_id:b.command_id});
 need(input?.profile==='contact-create-review-evidence-v1'&&input.read_only===true,'COLLISION_EXPORT_INVALID');
 const proof=checkCatalogCollisionEvidence(input.collision,b,s.now(),input.missing_document),cache=new Map();
 for(const e of b.evidence){
  if(!cache.has(e.proposal_id)){
   cache.set(e.proposal_id,await s.call('proposal',e.proposal_id));
  }
  const current=cache.get(e.proposal_id);
  need(current?.dry_run===true&&current.persisted===false&&Array.isArray(current.bindings)&&current.source_id===e.proposal_id&&current.existing===null&&['Rascunho','Pendente','Aguardando'].includes(current.source_status)&&current.source_hash===e.proposal_hash&&current.source_version===e.proposal_version,'PROPOSAL_WITNESS_CHANGED');
  const bound=current.bindings.filter(x=>x.entity==='contacts'&&x.source_id===e.source_id);
  need(bound.length===1&&bound[0].record_id===null&&bound[0].origin_state===null&&bound[0].source_hash===e.source_hash&&bound[0].source_version===e.source_version,'CONTACT_BINDING_CHANGED');
 }
 const args={p_entity:'contacts',p_items:b.items},preview=catalogImportResponse(await s.call('catalog',b.items),{entity:'contacts'},{type:'preview',args});
 need(preview.preview_hash===b.preview_hash,'MAPPER_REVIEW_CHANGED');
 need(preview.items.every((r,i)=>r.source_hash===b.items[i].source_hash&&r.source_version===b.evidence[i].source_version&&r.action==='create'&&r.operation_action==='create'&&r.record_id===null&&r.record_version===null&&r.origin_state===null&&!r.human_edited&&!r.candidate_retained&&!r.stock_locked&&r.error===null&&['A','S'].includes(r.source_status)&&r.changes.some(c=>c.field==='active'&&c.after===true)),'CREATE_REVIEW_CHANGED');
 const mapped=preview.items.map(r=>({source_id:r.source_id,source_hash:r.source_hash,source_version:r.source_version,action:r.action,source_status:r.source_status,changes:r.changes}));
 need(digest(mapped)===digest(b.mapper_review),'MAPPER_REVIEW_CHANGED');
 checkCatalogCollisionEvidence(proof,b,s.now(),input.missing_document);
 return{preview:core(preview),evidence_digest:digest(input),evidence_exported_at:proof.exported_at};
}
