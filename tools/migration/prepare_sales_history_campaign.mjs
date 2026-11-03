/** Local composition only: no network, credentials, command creation or execution loop. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {captureUpdate} from './catalog_update_preservation.mjs';
import {parseSalesHistoryCommand} from '../../packages/erp-domain/src/origin-sales-history-dto.mjs';
import {prepareSalesHistoryBatch,prepareSalesHistoryBatchPreview} from './prepare_sales_history_batch.mjs';
import {batchSettings,batchSqlString as q,salesHistoryBatchAuditBlock} from './sales_history_batch_audit.mjs';

export const CAMPAIGN_DEPENDENCIES=Object.freeze({
 'prepare_sales_history_batch.mjs':'8de0ec8c1ef63867aabd4007ba46b3cab61fdd92cc2fe74527c9ce442e8c1f4c',
 'sales_history_batch_audit.mjs':'4d8cacbdd9283ecb1a64b8ad45c4b4e52e79a69bccc7c181832031a6f991b5ae',
});
const sha=v=>createHash('sha256').update(v).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error('CAMPAIGN_'+code);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&v.length===64;
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const id=v=>typeof v==='string'&&v.length<=40&&/^[1-9][0-9]*$/.test(v)&&!/[^0-9]/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function own(v,keys){need(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'INPUT');const out={};for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&keys.includes(k)&&d.enumerable&&Object.hasOwn(d,'value'),'INPUT');out[k]=d.value;}return out;}
function bytes(v,max=8388608){need(v instanceof Uint8Array&&[Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(v))&&['buffer','byteOffset','byteLength','length'].every(k=>!Object.hasOwn(v,k))&&v.buffer instanceof ArrayBuffer&&v.byteLength>0&&v.byteLength<=max,'BYTES');return Uint8Array.from(v);}
function decode(v,expected){const b=bytes(v);need(hash(expected)&&sha(b)===expected,'PROOF_HASH');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{throw Error('CAMPAIGN_PROOF_JSON');}}
const encode=v=>new TextEncoder().encode(JSON.stringify(v));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const admin=actor=>`DO $campaign_admin$ BEGIN PERFORM erp_cutover.require_admin(${q(actor)}::uuid);END $campaign_admin$;\n`;
const readonly=body=>`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${batchSettings}${body}\nCOMMIT;\n`;
async function dependencies(){for(const [name,expected]of Object.entries(CAMPAIGN_DEPENDENCIES))need(sha(await readFile(new URL(name,import.meta.url)))===expected,'DEPENDENCY_CHANGED');}
function previousInput(value){
 const p=own(value,['proofBytes','expectedProofSha256','commands','preparedAt','expectedPlanSha256']);
 const now=typeof p.preparedAt==='string'?Date.parse(p.preparedAt):NaN;
 need(Number.isSafeInteger(now)&&now>0&&new Date(now).toISOString()===p.preparedAt&&hash(p.expectedPlanSha256),'PREVIOUS_PLAN');
 return{proofBytes:bytes(p.proofBytes),expectedProofSha256:p.expectedProofSha256,commands:captureUpdate(p.commands),now,expectedPlanSha256:p.expectedPlanSha256};
}
async function prior(p){const {expectedPlanSha256,...input}=p;const result=await prepareSalesHistoryBatch(input);need(result.plan_sha256===expectedPlanSha256,'PREVIOUS_PLAN');return result;}
function selection(value){const s=captureUpdate(value);need(Object.keys(s).sort().join(',')==='actor,sourceIds'&&uuid(s.actor)&&Array.isArray(s.sourceIds)&&s.sourceIds.length>=1&&s.sourceIds.length<=25&&s.sourceIds.every(id)&&new Set(s.sourceIds).size===s.sourceIds.length,'SELECTION');return s;}
function block(sql,start,end){need(sql.split(start).length===2&&sql.split(end).length===2,'TEMPLATE_CHANGED');const a=sql.indexOf(start),b=sql.indexOf(end);need(a>=0&&b>a,'TEMPLATE_CHANGED');return sql.slice(a,b);}

/** One ID-only inventory of the observed API scope. Invalid inputs remain visible, never repaired. */
export function prepareSalesHistoryCampaignInventory(input){
 const x=captureUpdate(input);need(Object.keys(x).join(',')==='actor'&&uuid(x.actor),'INVENTORY_INPUT');
 return readonly(`${admin(x.actor)}DO $campaign_inventory$ DECLARE r origin_sync.raw_record;v jsonb;state text;cs text;pending jsonb:='[]';preserved jsonb;counts jsonb:='{}';captures jsonb:='{}';n integer:=0;BEGIN
 IF(SELECT count(*)FROM origin_sync.raw_record WHERE entity='sales_orders')>20000 OR(SELECT count(*)FROM erp_sales_history.snapshot)>20000 THEN RAISE EXCEPTION 'campaign_inventory_limit' USING ERRCODE='54000';END IF;
 FOR r IN SELECT * FROM origin_sync.raw_record WHERE entity='sales_orders'ORDER BY source_id COLLATE "C"LOOP
  n:=n+1;state:='valid';cs:='unavailable';
  BEGIN v:=erp_sales_history.input(r);cs:=v#>>'{price_capture_verification,state}';
  EXCEPTION WHEN SQLSTATE '22023'THEN IF SQLERRM='sales_history_source_invalid'THEN state:='invalid';ELSIF SQLERRM='sales_history_source_too_large'THEN state:='too_large';ELSE RAISE;END IF;END;
  counts:=jsonb_set(counts,ARRAY[state],to_jsonb(coalesce((counts->>state)::integer,0)+1));captures:=jsonb_set(captures,ARRAY[cs],to_jsonb(coalesce((captures->>cs)::integer,0)+1));
  IF NOT EXISTS(SELECT 1 FROM erp_sales_history.snapshot s WHERE s.source_id=r.source_id)THEN pending:=pending||jsonb_build_array(jsonb_build_object('source_id',r.source_id,'source_validation',state,'capture_state',cs));END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_id',s.source_id,'command_id',s.command_id,'history_id',s.history_id,'source_present',EXISTS(SELECT 1 FROM origin_sync.raw_record origin_row WHERE origin_row.entity='sales_orders'AND origin_row.source_id=s.source_id))ORDER BY s.source_id COLLATE "C"),'[]')INTO preserved FROM erp_sales_history.snapshot s;
 PERFORM erp_cutover.require_admin(${q(x.actor)}::uuid);
 PERFORM set_config('brufap.sales_history_campaign_inventory',jsonb_build_object('profile','sales-history-083-campaign-inventory-v1','actor',${q(x.actor)},'observed_at',statement_timestamp(),'read_only',true,
 'scope','current_api_sales_orders_exact_ids','api_source_count',n,'pending_count',jsonb_array_length(pending),'pending',pending,'preserved',preserved,'source_validation_counts',counts,'current_capture_counts',captures,
 'backup_compared',false,'coverage_certified',false,'native_effects',false,'can_convert',false,'commands_minted',false,'captures_performed',0)::text,true);
 END $campaign_inventory$;
 SELECT current_setting('brufap.sales_history_campaign_inventory')::jsonb AS sales_history_campaign_inventory;`);
}

/** Recover a specific prior batch first, then preview only the supplied next IDs in the same snapshot. */
export async function prepareSalesHistoryBatchHandoff(input){
 const x=own(input,['actor','sourceIds','previous']),s=selection({actor:x.actor,sourceIds:x.sourceIds}),p=previousInput(x.previous);
 await dependencies();const previous=await prior(p);need(previous.plan.actor===s.actor,'ACTOR');need(s.sourceIds.every(id=>!previous.plan.items.some(i=>i.source_id===id)),'OVERLAPPING_SELECTION');
 const previewSql=await prepareSalesHistoryBatchPreview(s),audit=await salesHistoryBatchAuditBlock();
 const recovery=block(previous.recoverySql,'DO $batch_result$',"SELECT current_setting('brufap.sales_history_batch_result')");
 const preview=block(previewSql,'DO $batch_preview$',"SELECT current_setting('brufap.sales_history_batch_preview')");
 const previousHash=previous.plan_sha256,recoveryHash=sha(previous.recoverySql),n=previous.plan.items.length;
 const gate=`DO $campaign_previous$ DECLARE r jsonb:=current_setting('brufap.sales_history_batch_result')::jsonb;BEGIN
 IF r->>'plan_sha256'IS DISTINCT FROM ${q(previousHash)} OR r->>'outcome'IS DISTINCT FROM 'receipts_confirmed'OR(r->>'expected_count')::integer<>${n} OR(r->>'expected_receipts_confirmed')::integer<>${n} OR(r->>'missing')::integer<>0 OR(r->>'capture_rpc_calls')::integer<>0 OR jsonb_array_length(r->'receipts')<>${n} OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'receipts')v WHERE v->>'state'IS DISTINCT FROM 'confirmed')THEN RAISE EXCEPTION 'campaign_previous_receipts_unconfirmed' USING ERRCODE='40001';END IF;
 END $campaign_previous$;\n`;
 const sql=readonly(`${admin(s.actor)}${audit}${recovery}${gate}${preview}
 SELECT jsonb_build_object('profile','sales-history-083-batch-handoff-v1','read_only',true,'actor',${q(s.actor)},'observed_at',statement_timestamp(),
 'previous_plan_sha256',${q(previousHash)},'previous_recovery_sha256',${q(recoveryHash)},'previous_result',current_setting('brufap.sales_history_batch_result')::jsonb,
 'next_preview',current_setting('brufap.sales_history_batch_preview')::jsonb,'next_selection',${q(JSON.stringify(s.sourceIds))}::jsonb,'previous_receipts_confirmed',true,'can_prepare_next',true,
 'commands_minted',false,'captures_performed',0,'native_effects',false,'can_convert',false,'coverage_certified',false) AS sales_history_batch_handoff;`);
 return freeze({profile:'sales-history-083-handoff-sql-v1',previous_plan_sha256:previousHash,previous_recovery_sha256:recoveryHash,next_selection:s.sourceIds,sql,sql_sha256:sha(sql)});
}

function confirmed(h,previous){
 const plan=previous.plan,r=h.previous_result,n=plan.items.length;
 need(h.profile==='sales-history-083-batch-handoff-v1'&&h.read_only===true&&h.actor===plan.actor&&h.previous_receipts_confirmed===true&&h.can_prepare_next===true&&h.commands_minted===false&&h.captures_performed===0&&h.native_effects===false&&h.can_convert===false&&h.coverage_certified===false,'HANDOFF_SCOPE');
 need(h.previous_plan_sha256===previous.plan_sha256&&h.previous_recovery_sha256===sha(previous.recoverySql)&&r?.plan_sha256===previous.plan_sha256&&r.proof_sha256===plan.proof_sha256,'PREVIOUS_BINDING');
 need(r.profile==='sales-history-083-batch-result-v1'&&r.outcome==='receipts_confirmed'&&r.expected_count===n&&r.expected_receipts_confirmed===n&&r.missing===0&&r.capture_rpc_calls===0&&r.automatic_resend_allowed===false&&r.commit_acknowledgement_required===false&&r.native_effects===false&&r.can_convert===false,'PREVIOUS_UNCONFIRMED');
 need(r.old_152_unchanged===null&&r.existing_history_unchanged===null&&r.exact_delta===null&&r.before_audit===null&&Array.isArray(r.receipts)&&r.receipts.length===n,'RECOVERY_EVIDENCE');
 for(const item of plan.items){const entries=r.receipts.filter(v=>v.command_id===item.command_id);need(entries.length===1&&entries[0].state==='confirmed'&&entries[0].source_id===item.source_id,'RECEIPT_BINDING');const receipt=entries[0].receipt;
  parseSalesHistoryCommand({profile:'origin-sales-history-v1',read_only:true,can_convert:false,native_effects:false,commercial_math_reconciled:false,coverage_certified:false,observed_at:r.observed_at,receipt},{commandId:item.command_id});
  need(receipt.source.source_id===item.source_id&&receipt.source.source_hash===item.source_hash&&receipt.source.source_version===item.source_version&&receipt.snapshot_hash===item.snapshot_hash,'RECEIPT_BINDING');
 }
 const s=selection({actor:h.actor,sourceIds:h.next_selection});need(s.sourceIds.every(id=>!plan.items.some(i=>i.source_id===id)),'OVERLAPPING_SELECTION');
 need(h.next_preview?.actor===h.actor&&same(h.next_preview.selection,s.sourceIds)&&same(h.next_preview.audit,r.current_audit),'SHARED_AUDIT');
}

/** No apply is generated unless all previous receipts match the original immutable plan. */
export async function prepareSalesHistoryBatchFromHandoff(input){
 const x=own(input,['handoffBytes','expectedHandoffSha256','previous','commands','now']),h=decode(x.handoffBytes,x.expectedHandoffSha256),p=previousInput(x.previous),commands=captureUpdate(x.commands),now=x.now??Date.now();
 need(Number.isSafeInteger(now)&&now>0,'TIME');await dependencies();const previous=await prior(p);confirmed(h,previous);
 const observed=Date.parse(h.observed_at);need(Number.isFinite(observed)&&observed<=now+30000&&now-observed<600000&&Date.parse(h.next_preview.observed_at)<=observed+30000,'HANDOFF_TIME');
 const proofBytes=encode(h.next_preview),proofHash=sha(proofBytes),next=await prepareSalesHistoryBatch({proofBytes,expectedProofSha256:proofHash,commands,now});
 const proofText=new TextDecoder().decode(proofBytes);
 return freeze({...next,handoff_sha256:x.expectedHandoffSha256,previous_plan_sha256:previous.plan_sha256,previous_receipts_confirmed:true,previous_preservation_audit_recovered:false,
  derived_preview:{sha256:proofHash,utf8:proofText,provenance:'Exact next_preview value serialized from the SHA-pinned handoff; not the original export bytes.'}});
}
