/** Local SQL preparation only. No credentials, network, UUID minting or SQL execution. */
import {createHash} from 'node:crypto';
import {prepareSalesHistoryReadback,SOURCE_HASHES} from './prepare_sales_history_apply.mjs';
import {captureUpdate} from './catalog_update_preservation.mjs';
import {parseSalesHistoryCapturePreview} from '../../packages/erp-domain/src/origin-sales-history-dto.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),need=(v,c)=>{if(!v)throw Error(c);};
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const q=s=>"'"+s.replaceAll("'","''")+"'";
const EMPTY_GUARD=" IF EXISTS(SELECT 1 FROM erp_sales_history.snapshot)OR EXISTS(SELECT 1 FROM erp_sales_history.command)THEN RAISE EXCEPTION 'sales_history_083_new_tables_not_empty' USING ERRCODE='40001';END IF;";
const MAX_PROOF=1048576;
export function reviewSalesHistoryPilot({proofBytes,expectedProofSha256,commands,now=Date.now()}){
 need(proofBytes instanceof Uint8Array&&proofBytes.byteLength>0&&proofBytes.byteLength<=MAX_PROOF,'PILOT_PROOF_BYTES');
 const bytes=Uint8Array.from(proofBytes);need(hash(expectedProofSha256)&&sha(bytes)===expectedProofSha256,'PILOT_PROOF_HASH');
 let p;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('PILOT_PROOF_JSON');}
 const c=captureUpdate(commands);need(Array.isArray(c)&&c.length===5&&c.every(x=>Object.keys(x).sort().join(',')==='command_id,source_id'&&uuid(x.command_id))&&new Set(c.map(x=>x.command_id)).size===5,'PILOT_COMMANDS');
 need(p.profile==='sales-history-083-pilot5-preview-v1'&&p.read_only===true&&uuid(p.actor)&&p.table_count===154&&p.captures_performed===0&&p.commands_minted===false&&p.native_effects===false&&p.can_convert===false&&p.coverage_certified===false,'PILOT_SCOPE');
 need(Number.isSafeInteger(now)&&now>0&&Number.isFinite(Date.parse(p.observed_at))&&Date.parse(p.observed_at)<=now+30000,'PILOT_TIME');
 need(Array.isArray(p.selection)&&p.selection.length===5&&new Set(p.selection).size===5&&p.selection.every(x=>typeof x==='string'&&x.length<=40&&/^[1-9][0-9]*$/.test(x))&&Array.isArray(p.items)&&p.items.length===5,'PILOT_SELECTION');
 const rb=p.installation_readback;need(rb&&rb.protected_table_count===152&&Object.keys(rb.rows).length===152&&rb.new_tables_empty===true&&rb.function_contracts_valid===true&&rb.new_tables===2&&rb.new_service_only_rpcs===5&&rb.new_private_helpers===9&&rb.source_sha256?.['083']===SOURCE_HASHES['083'],'PILOT_BASELINE');
 need(Object.keys(p.all_rows).length===154&&Object.entries(rb.rows).every(([k,v])=>JSON.stringify(v)===JSON.stringify(p.all_rows[k])),'PILOT_ROWS');
 for(const name of ['snapshot','command'])need(p.all_rows['erp_sales_history.'+name]?.count===0&&p.all_rows['erp_sales_history.'+name]?.sha256===sha(''),'PILOT_HISTORY_NOT_EMPTY');
 const counts={};const items=p.selection.map(source_id=>{
  const rows=p.items.filter(x=>x.source_id===source_id),cmd=c.filter(x=>x.source_id===source_id);need(rows.length===1&&cmd.length===1,'PILOT_ITEM_BINDING');
  const v=parseSalesHistoryCapturePreview(rows[0].preview,{sourceId:source_id});need(v.existing===null,'PILOT_ALREADY_CAPTURED');counts[v.capture.state]=(counts[v.capture.state]??0)+1;
  return Object.freeze({source_id,source_hash:v.source.source_hash,source_version:v.source.source_version,snapshot_hash:v.snapshot_hash,command_id:cmd[0].command_id,capture_state:v.capture.state});
 });
 need(Object.keys(counts).length===Object.keys(p.capture_state_counts).length&&Object.entries(counts).every(([k,v])=>p.capture_state_counts[k]===v),'PILOT_CAPTURE_COUNTS');
 const plan={profile:'sales-history-083-pilot5-v1',actor:p.actor,proof_sha256:expectedProofSha256,proof_observed_at:p.observed_at,prepared_at:new Date(now).toISOString(),not_after:new Date(now+600000).toISOString(),items,expected_before:rb,can_convert:false,native_effects:false,coverage_certified:false};
 return Object.freeze({plan,plan_sha256:sha(JSON.stringify(plan))});
}
const lockBlock=`DO $pilot_locks$ DECLARE r record;BEGIN
 FOR r IN SELECT format('%I.%I',n.nspname,c.relname)name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p')AND(n.nspname~'^(erp|origin)_'OR n.nspname='auth'AND c.relname='users'OR n.nspname='storage'AND c.relname IN('buckets','objects'))ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"LOOP EXECUTE 'LOCK TABLE '||r.name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT';END LOOP;
END $pilot_locks$;`;
/** Returns reviewable SQL only. Caller provides all five UUIDs after reviewing the explicit proof. */
export async function prepareSalesHistoryPilot(input){
 const reviewed=reviewSalesHistoryPilot(input),{plan,plan_sha256}=reviewed;
 const rb=await prepareSalesHistoryReadback(),start=rb.indexOf('DO $readback_083$'),end=rb.indexOf("SELECT current_setting('brufap.sales_history_083_readback')");
 need(start>0&&end>start&&rb.split(EMPTY_GUARD).length===2,'PILOT_READBACK_TEMPLATE_CHANGED');
 const before=rb.slice(start,end),after=before.replace(EMPTY_GUARD,'').replace("'new_tables_empty',true","'new_tables_empty',false");
 need(after!==before&&after.includes("'new_tables_empty',false"),'PILOT_READBACK_TEMPLATE_CHANGED');
 const literal=q(JSON.stringify(plan)),base=`SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';\n`;
 const capture=`DO $pilot_capture$ DECLARE p constant jsonb:=${literal}::jsonb;e jsonb;result jsonb;BEGIN
 PERFORM erp_cutover.require_admin((p->>'actor')::uuid);
 IF clock_timestamp()>=(p->>'not_after')::timestamptz OR clock_timestamp()<(p->>'prepared_at')::timestamptz-interval '30 seconds'THEN RAISE EXCEPTION 'pilot_review_expired' USING ERRCODE='40001';END IF;
 IF (current_setting('brufap.sales_history_083_readback')::jsonb-'rows') IS DISTINCT FROM ((p->'expected_before')-'rows')THEN RAISE EXCEPTION 'pilot_baseline_changed' USING ERRCODE='40001';END IF;
 PERFORM set_config('brufap.sales_history_pilot_before',current_setting('brufap.sales_history_083_readback'),true);
 FOR e IN SELECT value FROM jsonb_array_elements(p->'items')LOOP
  IF EXISTS(SELECT 1 FROM erp_sales_history.command WHERE command_id=(e->>'command_id')::uuid)THEN RAISE EXCEPTION 'pilot_command_exists' USING ERRCODE='40001';END IF;
  result:=public.erp_origin_sales_history_capture((p->>'actor')::uuid,e->>'source_id',e->>'source_hash',e->>'source_version',e->>'snapshot_hash',(e->>'command_id')::uuid);
 END LOOP;
 -- captures complete: final proof must precede COMMIT
END $pilot_capture$;\nSET CONSTRAINTS ALL IMMEDIATE;`;
 const check=(strict)=>`DO $pilot_result$ DECLARE p constant jsonb:=${literal}::jsonb;e jsonb;c erp_sales_history.command;s erp_sales_history.snapshot;receipt jsonb;rows jsonb:='[]';ok_count integer:=0;missing integer:=0;baseline_same boolean;all_exact boolean;BEGIN
 PERFORM erp_cutover.require_admin((p->>'actor')::uuid);
 ${strict?"baseline_same:=(current_setting('brufap.sales_history_083_readback')::jsonb-'new_tables_empty')IS NOT DISTINCT FROM(current_setting('brufap.sales_history_pilot_before')::jsonb-'new_tables_empty');":"baseline_same:=NULL;"}
 FOR e IN SELECT value FROM jsonb_array_elements(p->'items')LOOP
  SELECT * INTO c FROM erp_sales_history.command WHERE command_id=(e->>'command_id')::uuid;
  IF NOT FOUND THEN missing:=missing+1;rows:=rows||jsonb_build_array(jsonb_build_object('source_id',e->>'source_id','command_id',e->>'command_id','state','not_found'));CONTINUE;END IF;
  SELECT * INTO s FROM erp_sales_history.snapshot WHERE history_id=c.history_id;
  receipt:=jsonb_build_object('command_id',c.command_id,'history_id',s.history_id,'source',erp_sales_history.source(s.observation),'snapshot_hash',s.snapshot_hash,'captured_at',s.captured_at);
  IF c.actor=(p->>'actor')::uuid AND s.command_id=c.command_id AND s.source_id=e->>'source_id'AND s.snapshot_hash=e->>'snapshot_hash'
   AND s.observation->>'source_hash'=e->>'source_hash'AND s.observation->>'source_version'=e->>'source_version'AND s.observation#>>'{price_capture_verification,state}'=e->>'capture_state'
   AND c.request_hash=encode(sha256(convert_to(jsonb_build_object('profile','origin-sales-history-v1','actor',p->>'actor','source_id',e->>'source_id','source_hash',e->>'source_hash','source_version',e->>'source_version','snapshot_hash',e->>'snapshot_hash')::text,'UTF8')),'hex')
   AND c.receipt=receipt AND s.snapshot_hash=encode(sha256(convert_to(s.observation::text,'UTF8')),'hex')
   AND (public.erp_origin_sales_history_command((p->>'actor')::uuid,c.command_id)->'receipt')=receipt
  THEN ok_count:=ok_count+1;rows:=rows||jsonb_build_array(jsonb_build_object('source_id',e->>'source_id','command_id',e->>'command_id','state','confirmed','receipt',receipt));
  ELSE rows:=rows||jsonb_build_array(jsonb_build_object('source_id',e->>'source_id','command_id',e->>'command_id','state','conflict'));END IF;
 END LOOP;
 all_exact:=ok_count=5 AND(SELECT count(*)FROM erp_sales_history.snapshot)=5 AND(SELECT count(*)FROM erp_sales_history.command)=5;
 ${strict?"IF NOT baseline_same OR NOT all_exact THEN RAISE EXCEPTION 'pilot_postcondition_failed' USING ERRCODE='40001';END IF;":""}
 PERFORM set_config('brufap.sales_history_pilot_result',jsonb_build_object('profile','sales-history-083-pilot5-result-v1','plan_sha256','${plan_sha256}','proof_sha256',p->>'proof_sha256','observed_at',clock_timestamp(),
 'outcome',CASE WHEN all_exact AND baseline_same THEN 'verified'WHEN all_exact THEN 'receipts_confirmed'WHEN missing=5 THEN 'not_found'ELSE 'conflict'END,
 'old_152_unchanged',baseline_same,'expected_receipts_confirmed',ok_count,'missing',missing,'snapshot_count',(SELECT count(*)FROM erp_sales_history.snapshot),'command_count',(SELECT count(*)FROM erp_sales_history.command),
 'receipts',rows,'before_readback',${strict?"current_setting('brufap.sales_history_pilot_before')::jsonb":"NULL::jsonb"},'current_readback',current_setting('brufap.sales_history_083_readback')::jsonb,'native_effects',false,'can_convert',false,'capture_rpc_calls',${strict?5:0},'commit_acknowledgement_required',${strict},'automatic_resend_allowed',false)::text,true);
END $pilot_result$;
SELECT current_setting('brufap.sales_history_pilot_result')::jsonb AS sales_history_pilot_result;`;
 return Object.freeze({...reviewed,
  applySql:`-- Explicit reviewed five-command capture. Whole transaction only. No retry after uncertainty.\nBEGIN;\n${base}${lockBlock}\n${before}${capture}\n${after}${check(true)}\nCOMMIT;\n`,
  recoverySql:`-- READ ONLY: same five commands; absence never permits automatic resend.\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${base}${after}${check(false)}\nCOMMIT;\n`});
}
