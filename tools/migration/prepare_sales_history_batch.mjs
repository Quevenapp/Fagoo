/** Opt-in SQL generation only. No network/database ports, UUID creation or implicit selection. */
import {createHash} from 'node:crypto';
import {captureUpdate} from './catalog_update_preservation.mjs';
import {parseSalesHistoryCapturePreview} from '../../packages/erp-domain/src/origin-sales-history-dto.mjs';
import {SOURCE_HASHES,batchSqlString as q,batchSettings,batchLocks,salesHistoryBatchAuditBlock} from './sales_history_batch_audit.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),need=(v,c)=>{if(!v)throw Error('BATCH_'+c);};
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const id=v=>typeof v==='string'&&v.length<=40&&/^[1-9][0-9]*$/.test(v),hash=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const own=(v,keys)=>{need(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'INPUT');const d=Object.getOwnPropertyDescriptors(v);need(Reflect.ownKeys(d).every(k=>typeof k==='string'&&keys.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')),'INPUT');return Object.fromEntries(Object.entries(d).map(([k,x])=>[k,x.value]));};
function selection(input){const x=captureUpdate(input);need(uuid(x.actor)&&Array.isArray(x.sourceIds)&&x.sourceIds.length>=1&&x.sourceIds.length<=25&&x.sourceIds.every(id)&&new Set(x.sourceIds).size===x.sourceIds.length&&Object.keys(x).sort().join(',')==='actor,sourceIds','SELECTION');return x;}
const admin=actor=>`DO $batch_admin$ BEGIN PERFORM erp_cutover.require_admin(${q(actor)}::uuid);END $batch_admin$;\n`;
const readonly=(body)=>`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${batchSettings}${body}\nCOMMIT;\n`;

/** Bounded aggregate diagnosis and an ID-only pending page; never infers selection or completeness. */
export function prepareSalesHistoryBatchDiagnostic(input){
 const x=captureUpdate(input);need(Object.keys(x).every(k=>['actor','after','limit'].includes(k))&&uuid(x.actor)&&(x.after===undefined||x.after===null||id(x.after))&&(x.limit===undefined||Number.isInteger(x.limit)&&x.limit>=1&&x.limit<=25),'DIAGNOSTIC_INPUT');
 const after=x.after??null,limit=x.limit??25;
 return readonly(`${admin(x.actor)}DO $batch_diagnostic$ DECLARE r origin_sync.raw_record;h erp_sales_history.snapshot;v jsonb;cs text;vs text;
 counts jsonb:='{}';captures jsonb:='{}';page jsonb:='[]';n integer:=0;covered integer:=0;pending integer:=0;same integer:=0;changed integer:=0;invalid integer:=0;origin_missing integer;more boolean:=false;
 BEGIN
 IF(SELECT count(*)FROM origin_sync.raw_record WHERE entity='sales_orders')>20000 THEN RAISE EXCEPTION 'batch_source_limit' USING ERRCODE='54000';END IF;
 FOR r IN SELECT * FROM origin_sync.raw_record WHERE entity='sales_orders'ORDER BY source_id COLLATE "C"LOOP
  n:=n+1;v:=NULL;vs:='valid';cs:='unavailable';
  BEGIN v:=erp_sales_history.input(r);cs:=v#>>'{price_capture_verification,state}';
  EXCEPTION WHEN SQLSTATE '22023'THEN
   IF SQLERRM='sales_history_source_invalid'THEN vs:='invalid';ELSIF SQLERRM='sales_history_source_too_large'THEN vs:='too_large';ELSE RAISE;END IF;
  END;
  counts:=jsonb_set(counts,ARRAY[vs],to_jsonb(coalesce((counts->>vs)::integer,0)+1));captures:=jsonb_set(captures,ARRAY[cs],to_jsonb(coalesce((captures->>cs)::integer,0)+1));
  SELECT * INTO h FROM erp_sales_history.snapshot WHERE source_id=r.source_id;
  IF FOUND THEN covered:=covered+1;IF h.observation->>'source_hash'=r.version_hash AND h.observation->>'source_version'=r.version::text THEN same:=same+1;ELSE changed:=changed+1;END IF;
  ELSE pending:=pending+1;IF vs<>'valid'THEN invalid:=invalid+1;END IF;
   IF vs='valid'AND(${after===null?'true':`r.source_id COLLATE "C">${q(after)} COLLATE "C"`})THEN
    IF jsonb_array_length(page)<${limit} THEN page:=page||jsonb_build_array(jsonb_build_object('source_id',r.source_id,'capture_state',cs));ELSE more:=true;END IF;
   END IF;
  END IF;
 END LOOP;
 SELECT count(*)INTO origin_missing FROM erp_sales_history.snapshot hist WHERE NOT EXISTS(SELECT 1 FROM origin_sync.raw_record rawsrc WHERE rawsrc.entity='sales_orders'AND rawsrc.source_id=hist.source_id);
 PERFORM set_config('brufap.sales_history_batch_diagnostic',jsonb_build_object('profile','sales-history-083-batch-diagnostic-v1','observed_at',statement_timestamp(),'read_only',true,'actor',${q(x.actor)},
 'scope','current_api_sales_orders_exact_ids','api_source_count',n,'history_snapshot_count',(SELECT count(*)FROM erp_sales_history.snapshot),'history_command_count',(SELECT count(*)FROM erp_sales_history.command),
 'api_ids_preserved',covered,'api_ids_pending',pending,'pending_invalid_or_too_large',invalid,'preserved_source_content_same',same,'preserved_source_content_changed',changed,'history_origin_missing',origin_missing,
 'source_validation_counts',counts,'current_capture_counts',captures,'pending_page',page,'after',${after===null?'NULL':q(after)},'limit',${limit},'has_more',more,'next_after',CASE WHEN more THEN page->-1->>'source_id'END,
 'backup_compared',false,'coverage_certified',false,'native_effects',false,'captures_performed',0,'commands_minted',false)::text,true);
 END $batch_diagnostic$;
 SELECT current_setting('brufap.sales_history_batch_diagnostic')::jsonb AS sales_history_batch_diagnostic;`);
}

/** Explicit ID set only; no command IDs or snapshot writes. Existing receipts stay visible for review. */
export async function prepareSalesHistoryBatchPreview(input){
 const x=selection(input),audit=await salesHistoryBatchAuditBlock(),ids=q(JSON.stringify(x.sourceIds));
 return readonly(`${admin(x.actor)}${audit}DO $batch_preview$ DECLARE source_id text;v jsonb;items jsonb:='[]';counts jsonb:='{}';cs text;BEGIN
 FOR source_id IN SELECT jsonb_array_elements_text(${ids}::jsonb)LOOP
  v:=public.erp_origin_sales_history_preview(${q(x.actor)}::uuid,source_id);cs:=v#>>'{capture,state}';
  items:=items||jsonb_build_array(jsonb_build_object('source_id',source_id,'preview',v));counts:=jsonb_set(counts,ARRAY[cs],to_jsonb(coalesce((counts->>cs)::integer,0)+1));
 END LOOP;
 PERFORM set_config('brufap.sales_history_batch_preview',jsonb_build_object('profile','sales-history-083-batch-preview-v1','read_only',true,'actor',${q(x.actor)},'observed_at',statement_timestamp(),
 'selection',${ids}::jsonb,'items',items,'capture_state_counts',counts,'audit',current_setting('brufap.sales_history_batch_audit')::jsonb,
 'commands_minted',false,'captures_performed',0,'native_effects',false,'can_convert',false,'coverage_certified',false)::text,true);
 END $batch_preview$;
 SELECT current_setting('brufap.sales_history_batch_preview')::jsonb AS sales_history_batch_preview;`);
}

function contracts(a){const c={...a};delete c.rows;delete c.history;return c;}
export function reviewSalesHistoryBatch(input){
 const x=own(input,['proofBytes','expectedProofSha256','commands','now']),bytes=x.proofBytes;
 need(bytes instanceof Uint8Array&&[Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(bytes))&&['buffer','byteOffset','byteLength','length'].every(k=>!Object.hasOwn(bytes,k))&&bytes.buffer instanceof ArrayBuffer&&bytes.byteLength>0&&bytes.byteLength<=8388608,'PROOF_BYTES');
 const copy=Uint8Array.from(bytes);need(hash(x.expectedProofSha256)&&sha(copy)===x.expectedProofSha256,'PROOF_HASH');
 let p;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(copy));}catch{throw Error('BATCH_PROOF_JSON');}
 const now=x.now??Date.now(),observed=Date.parse(p.observed_at);need(Number.isSafeInteger(now)&&now>0&&Number.isFinite(observed)&&observed<=now+30000&&now-observed<600000,'PROOF_TIME');
 need(p.profile==='sales-history-083-batch-preview-v1'&&p.read_only===true&&uuid(p.actor)&&p.commands_minted===false&&p.captures_performed===0&&p.native_effects===false&&p.can_convert===false&&p.coverage_certified===false,'PROOF_SCOPE');
 const sel=selection({actor:p.actor,sourceIds:p.selection}).sourceIds,n=sel.length,c=captureUpdate(x.commands);
 need(Array.isArray(c)&&c.length===n&&c.every(v=>Object.keys(v).sort().join(',')==='command_id,source_id'&&uuid(v.command_id)&&id(v.source_id))&&new Set(c.map(v=>v.command_id)).size===n,'COMMANDS');
 const a=p.audit;need(a?.profile==='sales-history-083-batch-audit-v1'&&a.function_contracts_valid===true&&a.source_sha256?.['083']===SOURCE_HASHES['083']&&a.new_service_only_rpcs===5&&a.new_private_helpers===9&&a.protected_table_count>=152&&a.total_table_count===a.protected_table_count+2&&hash(a.metadata_sha256),'AUDIT');
 need(a.rows&&Object.keys(a.rows).length===a.protected_table_count&&Object.entries(a.rows).every(([k,v])=>/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(k)&&Number.isSafeInteger(v.count)&&v.count>=0&&hash(v.sha256)),'AUDIT_ROWS');
 need(Array.isArray(a.history?.snapshots)&&Array.isArray(a.history?.commands)&&a.history.snapshots.length<=20000&&a.history.snapshots.length===a.history.commands.length,'HISTORY');
 const seen=new Set();for(const s of a.history.snapshots){need(uuid(s.command_id)&&id(s.source_id)&&typeof s.history_id==='string'&&s.history_id.startsWith('bsh_')&&hash(s.row_sha256)&&!seen.has(s.command_id),'HISTORY');seen.add(s.command_id);const rows=a.history.commands.filter(v=>v.command_id===s.command_id);need(rows.length===1&&rows[0].history_id===s.history_id&&hash(rows[0].row_sha256),'HISTORY');}
 need(Array.isArray(p.items)&&p.items.length===n,'ITEMS');const counts={};const items=sel.map(source_id=>{
  const rows=p.items.filter(v=>v.source_id===source_id),cmd=c.filter(v=>v.source_id===source_id);need(rows.length===1&&cmd.length===1&&!seen.has(cmd[0].command_id)&&!a.history.snapshots.some(v=>v.source_id===source_id),'ITEM_BINDING');
  const v=parseSalesHistoryCapturePreview(rows[0].preview,{sourceId:source_id});need(v.existing===null,'ALREADY_CAPTURED');counts[v.capture.state]=(counts[v.capture.state]??0)+1;
  return{source_id,source_hash:v.source.source_hash,source_version:v.source.source_version,snapshot_hash:v.snapshot_hash,capture_state:v.capture.state,command_id:cmd[0].command_id};
 });need(p.capture_state_counts&&Object.keys(counts).length===Object.keys(p.capture_state_counts).length&&Object.entries(counts).every(([k,v])=>p.capture_state_counts[k]===v),'CAPTURE_COUNTS');
 const plan={profile:'sales-history-083-batch-v1',actor:p.actor,proof_sha256:x.expectedProofSha256,proof_observed_at:p.observed_at,prepared_at:new Date(now).toISOString(),not_after:new Date(Math.min(now+600000,observed+600000)).toISOString(),items,expected_contracts:contracts(a),can_convert:false,native_effects:false,coverage_certified:false};
 return freeze({plan,plan_sha256:sha(JSON.stringify(plan))});
}

export async function prepareSalesHistoryBatch(input){
 const reviewed=reviewSalesHistoryBatch(input),{plan,plan_sha256}=reviewed,n=plan.items.length,audit=await salesHistoryBatchAuditBlock(),literal=q(JSON.stringify(plan));
 const capture=`DO $batch_capture$ DECLARE p constant jsonb:=${literal}::jsonb;e jsonb;a jsonb;BEGIN
 PERFORM erp_cutover.require_admin((p->>'actor')::uuid);a:=current_setting('brufap.sales_history_batch_audit')::jsonb;
 IF clock_timestamp()>=(p->>'not_after')::timestamptz OR clock_timestamp()<(p->>'prepared_at')::timestamptz-interval '30 seconds'THEN RAISE EXCEPTION 'batch_review_expired' USING ERRCODE='40001';END IF;
 IF(a-'rows'-'history')IS DISTINCT FROM p->'expected_contracts'THEN RAISE EXCEPTION 'batch_contracts_changed' USING ERRCODE='40001';END IF;
 PERFORM set_config('brufap.sales_history_batch_before',a::text,true);
 FOR e IN SELECT value FROM jsonb_array_elements(p->'items')LOOP
  IF EXISTS(SELECT 1 FROM erp_sales_history.command WHERE command_id=(e->>'command_id')::uuid)OR EXISTS(SELECT 1 FROM erp_sales_history.snapshot WHERE command_id=(e->>'command_id')::uuid OR source_id=e->>'source_id')THEN RAISE EXCEPTION 'batch_item_already_exists' USING ERRCODE='40001';END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'items')LOOP
  PERFORM public.erp_origin_sales_history_capture((p->>'actor')::uuid,e->>'source_id',e->>'source_hash',e->>'source_version',e->>'snapshot_hash',(e->>'command_id')::uuid);
 END LOOP;
 -- batch captures complete: exact delta and preservation checks follow
 END $batch_capture$;\nSET CONSTRAINTS ALL IMMEDIATE;\n`;
 const check=strict=>`DO $batch_result$ DECLARE p constant jsonb:=${literal}::jsonb;e jsonb;c erp_sales_history.command;s erp_sales_history.snapshot;receipt jsonb;receipts jsonb:='[]';a jsonb;b jsonb;kept_s jsonb;kept_c jsonb;ok_count integer:=0;missing integer:=0;old_same boolean;history_same boolean;delta_exact boolean;BEGIN
 PERFORM erp_cutover.require_admin((p->>'actor')::uuid);a:=current_setting('brufap.sales_history_batch_audit')::jsonb;
 ${strict?`b:=current_setting('brufap.sales_history_batch_before')::jsonb;
 old_same:=(a-'history')IS NOT DISTINCT FROM(b-'history');
 SELECT coalesce(jsonb_agg(v ORDER BY v->>'command_id'),'[]')INTO kept_s FROM jsonb_array_elements(a#>'{history,snapshots}')v WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'items')i WHERE i->>'command_id'=v->>'command_id');
 SELECT coalesce(jsonb_agg(v ORDER BY v->>'command_id'),'[]')INTO kept_c FROM jsonb_array_elements(a#>'{history,commands}')v WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'items')i WHERE i->>'command_id'=v->>'command_id');
 history_same:=kept_s=b#>'{history,snapshots}'AND kept_c=b#>'{history,commands}';
 delta_exact:=jsonb_array_length(a#>'{history,snapshots}')=jsonb_array_length(b#>'{history,snapshots}')+${n} AND jsonb_array_length(a#>'{history,commands}')=jsonb_array_length(b#>'{history,commands}')+${n};`:'old_same:=NULL;history_same:=NULL;delta_exact:=NULL;'}
 FOR e IN SELECT value FROM jsonb_array_elements(p->'items')LOOP
  SELECT * INTO c FROM erp_sales_history.command WHERE command_id=(e->>'command_id')::uuid;
  IF NOT FOUND THEN missing:=missing+1;receipts:=receipts||jsonb_build_array(jsonb_build_object('command_id',e->>'command_id','source_id',e->>'source_id','state','not_found'));CONTINUE;END IF;
  SELECT * INTO s FROM erp_sales_history.snapshot WHERE history_id=c.history_id;
  receipt:=jsonb_build_object('command_id',c.command_id,'history_id',s.history_id,'source',erp_sales_history.source(s.observation),'snapshot_hash',s.snapshot_hash,'captured_at',s.captured_at);
  IF c.actor=(p->>'actor')::uuid AND s.command_id=c.command_id AND s.source_id=e->>'source_id'AND s.snapshot_hash=e->>'snapshot_hash'
   AND s.observation->>'source_hash'=e->>'source_hash'AND s.observation->>'source_version'=e->>'source_version'AND s.observation#>>'{price_capture_verification,state}'=e->>'capture_state'
   AND c.request_hash=encode(sha256(convert_to(jsonb_build_object('profile','origin-sales-history-v1','actor',p->>'actor','source_id',e->>'source_id','source_hash',e->>'source_hash','source_version',e->>'source_version','snapshot_hash',e->>'snapshot_hash')::text,'UTF8')),'hex')
   AND c.receipt=receipt AND s.snapshot_hash=encode(sha256(convert_to(s.observation::text,'UTF8')),'hex')AND(public.erp_origin_sales_history_command((p->>'actor')::uuid,c.command_id)->'receipt')=receipt
  THEN ok_count:=ok_count+1;receipts:=receipts||jsonb_build_array(jsonb_build_object('command_id',c.command_id,'source_id',s.source_id,'state','confirmed','receipt',receipt));
  ELSE receipts:=receipts||jsonb_build_array(jsonb_build_object('command_id',e->>'command_id','source_id',e->>'source_id','state','conflict'));END IF;
 END LOOP;
 ${strict?`IF old_same IS DISTINCT FROM true OR history_same IS DISTINCT FROM true OR delta_exact IS DISTINCT FROM true OR ok_count<>${n} THEN RAISE EXCEPTION 'batch_postcondition_failed' USING ERRCODE='40001';END IF;`:''}
 PERFORM set_config('brufap.sales_history_batch_result',jsonb_build_object('profile','sales-history-083-batch-result-v1','plan_sha256','${plan_sha256}','proof_sha256',p->>'proof_sha256','observed_at',clock_timestamp(),
 'outcome',CASE WHEN ok_count=${n} AND old_same THEN 'verified'WHEN ok_count=${n} THEN 'receipts_confirmed'WHEN missing=${n} THEN 'not_found'ELSE 'conflict'END,
 'old_152_unchanged',old_same,'existing_history_unchanged',history_same,'exact_delta',delta_exact,'expected_count',${n},'expected_receipts_confirmed',ok_count,'missing',missing,'receipts',receipts,
 'before_audit',b,'current_audit',a,'snapshot_count',jsonb_array_length(a#>'{history,snapshots}'),'command_count',jsonb_array_length(a#>'{history,commands}'),
 'native_effects',false,'can_convert',false,'capture_rpc_calls',${strict?n:0},'commit_acknowledgement_required',${strict},'automatic_resend_allowed',false)::text,true);
 END $batch_result$;
 SELECT current_setting('brufap.sales_history_batch_result')::jsonb AS sales_history_batch_result;`;
 return freeze({...reviewed,applySql:`-- One explicit batch. Never retry automatically after uncertain COMMIT.\nBEGIN;\n${batchSettings}${admin(plan.actor)}${batchLocks}\n${audit}${capture}${audit}${check(true)}\nCOMMIT;\n`,recoverySql:readonly(`${admin(plan.actor)}${audit}${check(false)}`)});
}
