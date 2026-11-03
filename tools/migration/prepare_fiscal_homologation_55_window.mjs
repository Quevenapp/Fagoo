// Local preparation only. No database driver, HTTP, credentials, UUID generation or apply mode.
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {prepareFiscalHomologation55Baseline,TEMPLATE_SHA256} from './prepare_fiscal_homologation_55_baseline.mjs';
import {inventory,rowSnapshot,securitySnapshot} from './helpers/fiscal55-window-audit.mjs';

export const RULE_HASH='d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6';
export const POLICY_HASH='e70502bf2fa3a720dcd1eb7abf689d90cf61b192e01cdd182cbba816057e4f9b';
export const PROFILE_END='2026-10-26T03:00:00.000Z';
export const FUNCTION_PINS=Object.freeze({
 'public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)':'d4975691e547c220e19c2235f7cf996348b48a8edbfdbbe49fb745d5fd79d75b',
 'erp_fiscal_drafts.capture(uuid)':'a5eb14b0de3a87193fc59e059cdec3cfb090d48fbd4b984efea34c72b94385ed',
 'public.erp_fiscal_reviewed_authorization_preflight(uuid,uuid,text)':'ec6dec94d79c961142d3148be604f103e03f11ba8fb929879e48982d0ae5b8f1',
 'erp_fiscal_subset_review.current_profile_hash()':'75850b49a9e57c42db29ba5bbb5d52c931ea84e858723878db60a62ffd183379',
 'erp_fiscal_reviewed_authorization.manifest(text,text)':'e0bb851620904a8383433d3e00804068719c19cf04602f3eb24797de41d5a8f5'
});
const sha=x=>createHash('sha256').update(x).digest('hex');
const lit=x=>"'"+String(x).replaceAll("'","''")+"'";
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const must=(x,code)=>{if(!x)throw Error(code);};
function copy(x,depth=0){
 must(depth<40,'INPUT_DEPTH');
 if(x===null||typeof x==='string'||typeof x==='boolean')return x;
 if(typeof x==='number'){must(Number.isFinite(x),'INPUT_NUMBER');return x;}
 must(x&&typeof x==='object'&&(Array.isArray(x)||[Object.prototype,null].includes(Object.getPrototypeOf(x))),'INPUT_SHAPE');
 const out=Array.isArray(x)?[]:{};
 for(const k of Reflect.ownKeys(x)){
  if(Array.isArray(x)&&k==='length')continue;
  const d=Object.getOwnPropertyDescriptor(x,k);
  must(typeof k==='string'&&d.enumerable&&Object.hasOwn(d,'value')&&!['__proto__','constructor','prototype'].includes(k),'INPUT_ACCESSOR_OR_KEY');
  out[k]=copy(d.value,depth+1);
 }
 return out;
}
const canonical=x=>JSON.stringify(x&&typeof x==='object'?(Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))]))):x);
const equal=(a,b)=>canonical(a)===canonical(b);
function exact(x,keys,code){must(x&&typeof x==='object'&&!Array.isArray(x)&&equal(Object.keys(x).sort(),[...keys].sort()),code);}
function at(x){must(typeof x==='string'&&Number.isFinite(Date.parse(x)),'INVALID_TIME');return Date.parse(x);}
function heads(p){
 must(Array.isArray(p.authorization_policy_heads)&&p.authorization_policy_heads.length===2,'POLICY_HEADS');
 const a=p.authorization_policy_heads.find(x=>x.model==='55'),b=p.authorization_policy_heads.find(x=>x.model==='65');
 for(const h of[a,b])must(h?.version===5&&h.enabled===false&&h.origin==='operational'&&h.authorization_profile==='reviewed_subset_v1'&&h.binding_reviewed===true&&h.tax_rules_reviewed===false&&h.rule_profile==='sp-crt1-internal-sale-homologation-20261017-v2','POLICY_HEADS');
 must(a.source_manifest_hash===POLICY_HASH&&a.binding_profile==='sp55-authorization-soap12-reviewed-20261016-v1','POLICY55_PROFILE');
 must(Array.isArray(p.receipt_query_policy_heads)&&p.receipt_query_policy_heads.length===2&&new Set(p.receipt_query_policy_heads.map(x=>x.model)).size===2&&p.receipt_query_policy_heads.every(x=>['55','65'].includes(x.model)&&x.enabled===false),'QUERY_HEADS');
 return a;
}
function baseline(p,{initial=false}={}){
 must(p?.contract==='homologation-55-next-baseline-v1'&&p.read_only===true&&!p.error,'BASELINE_CONTRACT');at(p.observed_at);heads(p);
 must(p.selection?.model==='55'&&p.selection.environment==='2'&&p.selection.series===2&&p.selection.unit_price_from==='original_order_item','BASELINE_SELECTION');
 must(p.limits?.can_emit===false&&p.limits.can_transmit===false&&p.limits.tax_rules_validated===false,'BASELINE_LIMITS');
 // The v1 baseline added a customer-role restriction absent from054/022. Keep its
 // literal false in the evidence, but independently check the supported fields.
 must(p.checks&&Object.entries(p.checks).every(([k,v])=>k==='contact_active_pf_customer'||k==='target_unprepared_without_effects'&&!initial||v===true),'BASELINE_CHECKS');
 must(p.catalog?.contact?.active===true&&p.catalog.contact.person_type==='F'&&p.catalog.contact.document_present===true&&p.catalog.contact.document_matches_original_snapshot===true,'CONTACT_ACTIVE_PF');
 for(const key of['candidate_inventory','actor_inventory','related_orders','reservations'])must(Array.isArray(p[key]?.items)&&p[key].truncated===false&&p[key].items.length===p[key].total&&p[key].total<=25,'BASELINE_INCOMPLETE');
 for(const key of['historical_authorizations','historical_revalidations'])must(Array.isArray(p[key]?.items)&&p[key].items.length===p[key].total&&p[key].total<=25,'BASELINE_INCOMPLETE');
 must(p.actor_inventory.total===1&&p.actor_inventory.active_admin_count===1&&p.actor_inventory.active_fiscal_count===0&&p.actor_inventory.items[0].role==='admin'&&uuid(p.actor_inventory.items[0].user_id),'ACTOR_INVENTORY');
 must(p.counts.authorization_attempts===2&&p.counts.authorization_consumed===2&&p.counts.authorization_unresolved===0&&p.counts.receipt_queries===0&&p.counts.receipt_query_consumed===0&&p.protocol062?.attempts===0&&p.protocol062.used===0,'ATTEMPT_INVENTORY');
 must(p.original_order?.number===1&&uuid(p.original_order.id)&&p.original_order.item_count===1&&p.original_order.items.length===1&&p.original_order.total==='84.81','ORIGINAL_ORDER');
 const item=p.original_order.items[0];must(item.code==='345121'&&item.unit==='CX'&&Number(item.quantity)===1&&item.total==='84.81'&&Number(item.discount_percent)===0&&typeof item.unit_price==='string'&&/^\d+(?:\.\d{1,10})?$/.test(item.unit_price),'ORIGINAL_ITEM');
 must(p.a1?.configured===true&&p.a1.company_matches===true&&p.a1.time_valid_at_snapshot===true&&p.a1.private_bucket_metadata_matches===true&&p.a1.object_metadata_matches===true,'A1_METADATA');
 must(p.series55?.model==='55'&&p.series55.series===2&&p.series55.environment==='2'&&p.series55.enabled===true&&p.series55.exclusive_use_confirmed===true&&p.series55.identity_matches===true,'SERIES');
 if(initial)must(p.selection.target_order_id===null&&p.target_order===null&&p.counts.sales_orders===3&&p.candidate_inventory.total===3&&p.reservations.total===3&&p.series55.next_number==='42195','INITIAL_SCOPE');
 return p;
}
export function createFiscal55WindowDraft(baselineInput,{baselineSha256}={}){
 must(hash(baselineSha256),'BASELINE_HASH');const p=baseline(copy(baselineInput),{initial:true});
 return {contract:'homologation-55-window-draft-v1',baseline_sha256:baselineSha256,baseline:p,target:null,approved_at:null,window_seconds:1200,can_generate_enable:false};
}
export async function readFiscal55WindowDraft(path,expectedSha256){
 must(typeof path==='string'&&isAbsolute(path)&&hash(expectedSha256),'BASELINE_FILE');
 const bytes=await readFile(path);must(bytes.length<=262144&&sha(bytes)===expectedSha256,'BASELINE_FILE_CHANGED');
 return createFiscal55WindowDraft(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),{baselineSha256:expectedSha256});
}
function freshPlan(input){
 exact(input,['draft','freshBaseline','freshBaselineSha256','preflight','approvedAt','runtimeFlagsVerified'],'PLAN_OPTIONS');
 const {draft:d,freshBaseline:f,freshBaselineSha256,preflight:pf,approvedAt,runtimeFlagsVerified}=input;
 exact(d,['contract','baseline_sha256','baseline','target','approved_at','window_seconds','can_generate_enable'],'DRAFT_KEYS');
 must(d.contract==='homologation-55-window-draft-v1'&&d.target===null&&d.approved_at===null&&d.window_seconds===1200&&d.can_generate_enable===false&&hash(d.baseline_sha256),'DRAFT_REQUIRED');
 const b=baseline(d.baseline,{initial:true});baseline(f);
 must(hash(freshBaselineSha256)&&runtimeFlagsVerified===true,'FRESH_PROOF_AND_FLAGS_REQUIRED');
 const time=at(approvedAt);must(new Date(time).toISOString()===approvedAt&&time>=at(f.observed_at)&&time-at(f.observed_at)<300000,'PROOF_EXPIRED');
 for(const key of['original_order','catalog','company','a1','actor_inventory','authorization_policy_heads','receipt_query_policy_heads','historical_authorizations','historical_revalidations','protocol062'])must(equal(b[key],f[key]),'BASELINE_CHANGED:'+key);
 must(f.counts.sales_orders===b.counts.sales_orders+1&&f.counts.sales_numbering_last===String(Number(b.counts.sales_numbering_last)+1),'ORDER_INVENTORY_CHANGED');
 const target=f.target_order;must(target&&uuid(target.id)&&target.id===f.selection.target_order_id&&target.id!==b.original_order.id&&target.number===4&&target.version===1&&target.status==='draft','TARGET_ORDER');
 must(target.contact_id===b.original_order.contact_id&&target.item_count===1&&target.items.length===1&&target.total===b.original_order.total,'TARGET_ORDER');
 const item=target.items[0],old=b.original_order.items[0];
 for(const key of['product_id','unit_price','quantity','discount_percent','total','code','unit'])must(item[key]===old[key],'TARGET_EXACT_ITEM');
 for(const key of['finance_postings','stock_postings','stock_reservations','billing_titles'])must(target[key]===0,'TARGET_EFFECTS');
 must(target.fiscal_drafts===1&&target.fiscal_reservations===1,'TARGET_FISCAL_CHAIN');
 for(const key of['candidate_inventory','reservations']){
  must(f[key].total===b[key].total+1,'INVENTORY_DELTA');
  for(const row of b[key].items)must(equal(row,f[key].items.find(x=>x.id===row.id)),'HISTORICAL_INVENTORY_CHANGED');
 }
 const candidate=f.candidate_inventory.items.find(x=>!b.candidate_inventory.items.some(y=>y.id===x.id));
 const reservation=f.reservations.items.find(x=>!b.reservations.items.some(y=>y.id===x.id));
 const actor=b.actor_inventory.items[0].user_id;
 must(candidate&&reservation&&uuid(candidate.id)&&uuid(reservation.id)&&uuid(reservation.draft_id)&&candidate.model==='55'&&candidate.series===2&&candidate.number===42195&&candidate.version===1&&candidate.state==='stored'&&candidate.has_attempt===false&&candidate.source_document_id===target.id&&candidate.reservation_id===reservation.id&&hash(candidate.signed_hash)&&Number.isSafeInteger(candidate.size_bytes)&&candidate.size_bytes>0,'TARGET_CANDIDATE');
 must(reservation.model==='55'&&reservation.environment==='2'&&reservation.series===2&&reservation.number===42195&&reservation.source_document_id===target.id&&reservation.source_document_version===target.version&&reservation.actor===actor&&reservation.series_id===b.series55.id&&reservation.series_version===b.series55.version&&candidate.a1_version===b.a1.version,'TARGET_RESERVATION');
 must(f.series55.id===b.series55.id&&f.series55.version===b.series55.version+1&&f.series55.next_number==='42196','SERIES_CAS');
 must(pf?.preflight_profile==='authorization-reviewed-preflight-v2'&&pf.read_only===true&&pf.tax_rules_validated===false&&equal(pf.blockers,['POLICY_DISABLED'])&&equal(pf.candidate,{candidate_id:candidate.id,candidate_version:candidate.version,model:'55',signed_hash:candidate.signed_hash})&&equal(pf.versions,{identity:b.company.identity_version,a1:b.a1.version,policy:5}),'PREFLIGHT');
 must(time>=at(pf.observed_at)&&time-at(pf.observed_at)<300000,'PREFLIGHT_EXPIRED');
 const review=pf.review;must(review&&uuid(review.review_id)&&Number.isSafeInteger(review.review_version)&&review.review_version>0&&hash(review.review_hash)&&hash(review.facts_hash)&&review.profile_hash===RULE_HASH&&review.reviewed_by===actor&&review.candidate_version===candidate.version&&review.signed_hash===candidate.signed_hash&&at(review.reviewed_at)<=time&&at(review.valid_until)>time+60000,'REVIEW');
 const until=new Date(Math.min(time+1200000,at(PROFILE_END),at(review.valid_until))).toISOString();
 must(at(until)>time+60000,'WINDOW_TOO_SHORT');
 const seed=heads(b),base={...seed};delete base.created_at;
 return {contract:'homologation-55-window-plan-v1',baseline_sha256:d.baseline_sha256,fresh_baseline_sha256:freshBaselineSha256,baseline:b,fresh_baseline:f,
  actor,target:{order_id:target.id,draft_id:reservation.draft_id,reservation_id:reservation.id,candidate_id:candidate.id,candidate_version:candidate.version,signed_hash:candidate.signed_hash,signed_size:candidate.size_bytes,series:2,number:42195},
  preflight:pf,approved_at:approvedAt,window_seconds:1200,runtime_flags_confirmation:'root_verified_before_sql',
  enable_policy:{...base,version:6,enabled:true,valid_from:approvedAt,valid_until:until},
  disable_policy:{...base,version:7,enabled:false,valid_from:approvedAt,valid_until:PROFILE_END}};
}
export function finalizeFiscal55Window(input){return freshPlan(copy(input));}
export function prepareFiscal55PreflightRead(input){
 const p=copy(input);exact(p,['actor','candidateId','signedHash'],'PREFLIGHT_READ_OPTIONS');
 must(uuid(p.actor)&&uuid(p.candidateId)&&hash(p.signedHash),'PREFLIGHT_READ_BINDING');
 return `-- PRIVATE readonly metadata: no grant, A1 bytes, transport or authorization run.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';SET LOCAL standard_conforming_strings=on;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
SELECT jsonb_build_object('contract','homologation-55-preflight-read-v1','read_only',true,'observed_at',statement_timestamp(),
 'selection',jsonb_build_object('actor',${lit(p.actor)},'candidate_id',${lit(p.candidateId)},'signed_hash',${lit(p.signedHash)}),
 'preflight',public.erp_fiscal_reviewed_authorization_preflight(${lit(p.actor)}::uuid,${lit(p.candidateId)}::uuid,${lit(p.signedHash)}),
 'runtime_flags_observed',false,'transport_called',false)AS fiscal55_preflight_read;
ROLLBACK;
`;
}
function checked(input){
 const p=copy(input);exact(p,['contract','baseline_sha256','fresh_baseline_sha256','baseline','fresh_baseline','actor','target','preflight','approved_at','window_seconds','runtime_flags_confirmation','enable_policy','disable_policy'],'PLAN_KEYS');
 const restored=freshPlan({draft:createFiscal55WindowDraft(p.baseline,{baselineSha256:p.baseline_sha256}),freshBaseline:p.fresh_baseline,freshBaselineSha256:p.fresh_baseline_sha256,preflight:p.preflight,approvedAt:p.approved_at,runtimeFlagsVerified:p.runtime_flags_confirmation==='root_verified_before_sql'});
 must(equal(restored,p),'PLAN_CHANGED');must(!JSON.stringify(p).includes('$window55$'),'PLAN_DELIMITER');return p;
}
async function captureBaselineSql(orderId){
 const sql=await prepareFiscalHomologation55Baseline({targetOrderId:orderId});
 const start=sql.indexOf('\nWITH\n');must(start>0&&sql.endsWith('COMMIT;\n'),'BASELINE_TEMPLATE_SHAPE');
 const query=sql.slice(start+1,-'COMMIT;\n'.length);
 must(query.split(' AS fiscal_test55_next_baseline FROM envelope;').length===2,'BASELINE_TEMPLATE_SHAPE');
 return query.replace(' AS fiscal_test55_next_baseline FROM envelope;',' INTO current_baseline FROM envelope;');
}
const pins=Object.entries(FUNCTION_PINS).map(([name,h])=>`IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(${lit(name)}))IS DISTINCT FROM ${lit(h)} THEN RAISE EXCEPTION'window_function_changed' USING ERRCODE='55000';END IF;`).join('\n');
export async function prepareFiscal55WindowSql(input,mode='enable'){
 must(['enable','disable'].includes(mode),'MODE');const p=checked(input),enable=mode==='enable',v=enable?6:7;
 const expected=enable?p.baseline.authorization_policy_heads.find(x=>x.model==='55'):p.enable_policy;
 const capture=enable?await captureBaselineSql(p.target.order_id):'';
 return `-- PRIVATE reviewed preparation only. Append model55 policy; NOT an actor/candidate allowlist.
-- No flags, fiscal grants, A1 private bytes, SOAP, query089 or authorization run.
-- plan_sha256=${sha(canonical(p))}; baseline_template=${TEMPLATE_SHA256}
BEGIN;
SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';SET LOCAL standard_conforming_strings=on;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';
DO $window55$
DECLARE plan_json jsonb:=${lit(JSON.stringify(p))}::jsonb;names text[];after_names text[];object_name text;item jsonb;current_baseline jsonb;
 before_rows jsonb;after_rows jsonb;before_security text;after_security text;preflight jsonb;inserted erp_fiscal_authorization.policy;at timestamptz;
BEGIN
 IF NOT pg_try_advisory_xact_lock(174852920,1) THEN RAISE EXCEPTION'window_fiscal_mutex_busy' USING ERRCODE='55P03';END IF;
 ${inventory('names')}
 IF cardinality(names)<164 OR NOT ARRAY['erp_fiscal_receipt_query.policy','erp_fiscal_receipt_query.query','erp_fiscal_receipt_query.request','erp_fiscal_receipt_query.result','erp_fiscal_receipt_query.audit']::text[]<@names THEN RAISE EXCEPTION'window_inventory_incomplete' USING ERRCODE='55000';END IF;
 FOREACH object_name IN ARRAY names LOOP EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE NOWAIT',object_name);END LOOP;
 IF(SELECT ${enable?'to_jsonb(h)':"to_jsonb(h)-'created_at'"} FROM erp_fiscal_authorization.policy h WHERE model='55' ORDER BY version DESC LIMIT 1)IS DISTINCT FROM ${enable?lit(JSON.stringify(expected))+'::jsonb':"(to_jsonb(jsonb_populate_record(NULL::erp_fiscal_authorization.policy,"+lit(JSON.stringify(expected))+"::jsonb))-'created_at')"} THEN RAISE EXCEPTION'window_policy_head_changed' USING ERRCODE='40001';END IF;
 ${enable?`${pins}
 at:=clock_timestamp();
 IF at<(plan_json->>'approved_at')::timestamptz OR at>=(plan_json->>'approved_at')::timestamptz+interval'5 minutes' OR at<(plan_json#>>'{fresh_baseline,observed_at}')::timestamptz OR at>=(plan_json#>>'{fresh_baseline,observed_at}')::timestamptz+interval'5 minutes' OR at>=(plan_json#>>'{enable_policy,valid_until}')::timestamptz-interval'60 seconds' THEN RAISE EXCEPTION'window_proof_expired' USING ERRCODE='55000';END IF;
 ${capture}
 IF(current_baseline-'observed_at')IS DISTINCT FROM((plan_json->'fresh_baseline')-'observed_at') THEN RAISE EXCEPTION'window_inventory_changed' USING ERRCODE='40001';END IF;
 IF erp_fiscal_subset_review.current_profile_hash()<>${lit(RULE_HASH)} THEN RAISE EXCEPTION'window_profile_changed' USING ERRCODE='40001';END IF;
 preflight:=public.erp_fiscal_reviewed_authorization_preflight((plan_json->>'actor')::uuid,(plan_json#>>'{target,candidate_id}')::uuid,plan_json#>>'{target,signed_hash}');
 IF(preflight-'observed_at')IS DISTINCT FROM((plan_json->'preflight')-'observed_at') THEN RAISE EXCEPTION'window_preflight_changed' USING ERRCODE='40001';END IF;`:
 `-- Cleanup intentionally ignores current actor, A1, review, candidate, clock and new attempts.
 -- Other models/query heads may have changed: preserve their current state; never block closing55 on them.`}
 ${rowSnapshot('before_rows',v)}
 ${securitySnapshot('before_security')}
 INSERT INTO erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
 SELECT x.model,x.version,x.origin,x.enabled,x.binding_profile,x.rule_profile,x.binding_reviewed,x.tax_rules_reviewed,x.source_manifest_hash,x.valid_from,x.valid_until,x.authorization_profile
 FROM jsonb_populate_record(NULL::erp_fiscal_authorization.policy,plan_json->'${enable?'enable_policy':'disable_policy'}')x RETURNING *INTO inserted;
 IF(to_jsonb(inserted)-'created_at')IS DISTINCT FROM(to_jsonb(jsonb_populate_record(NULL::erp_fiscal_authorization.policy,plan_json->'${enable?'enable_policy':'disable_policy'}'))-'created_at') THEN RAISE EXCEPTION'window_append_changed' USING ERRCODE='40001';END IF;
 ${enable?`preflight:=public.erp_fiscal_reviewed_authorization_preflight((plan_json->>'actor')::uuid,(plan_json#>>'{target,candidate_id}')::uuid,plan_json#>>'{target,signed_hash}');
 IF preflight->'blockers'IS DISTINCT FROM'[]'::jsonb OR preflight->'versions'IS DISTINCT FROM jsonb_set(plan_json#>'{preflight,versions}','{policy}','6') OR preflight->'review'IS DISTINCT FROM plan_json#>'{preflight,review}' OR preflight->'candidate'IS DISTINCT FROM plan_json#>'{preflight,candidate}' THEN RAISE EXCEPTION'window_post_append_preflight_changed' USING ERRCODE='40001';END IF;
 IF clock_timestamp()>=(plan_json#>>'{enable_policy,valid_until}')::timestamptz-interval'60 seconds' THEN RAISE EXCEPTION'window_elapsed_during_audit' USING ERRCODE='55000';END IF;`:''}
 ${inventory('after_names')}
 IF names IS DISTINCT FROM after_names THEN RAISE EXCEPTION'window_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowSnapshot('after_rows',v)}
 ${securitySnapshot('after_security')}
 IF before_rows IS DISTINCT FROM after_rows OR before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION'window_preservation_failed' USING ERRCODE='40001';END IF;
 ${enable?`IF clock_timestamp()>=(plan_json#>>'{enable_policy,valid_until}')::timestamptz-interval'60 seconds' OR clock_timestamp()>=(plan_json#>>'{fresh_baseline,observed_at}')::timestamptz+interval'5 minutes' THEN RAISE EXCEPTION'window_elapsed_during_audit' USING ERRCODE='55000';END IF;`:''}
 PERFORM set_config('brufap.fiscal55_window_audit',jsonb_build_object('contract','homologation-55-window-${mode}-v1','mode',${lit(mode)},'plan_sha256',${lit(sha(canonical(p)))},'policy',to_jsonb(inserted),'policy_row_sha256',encode(sha256(convert_to(to_jsonb(inserted)::text,'UTF8')),'hex'),'preserved_tables',cardinality(names),'before',before_rows,'after_historical',after_rows,'before_equals_after',true,'security_sha256',before_security,'security_preserved',true,'candidate_allowlist_enforced',false,'actor_policy_allowlist_enforced',false,'runtime_flags_read_by_sql',false,'tax_rules_validated',false,'can_emit',false,'transport_called',false)::text,true);
END $window55$;
SELECT current_setting('brufap.fiscal55_window_audit')::jsonb AS fiscal55_window_audit;
COMMIT;
`;
}
export function prepareFiscal55WindowReadback(input,mode='enable'){
 must(['enable','disable'].includes(mode),'MODE');const p=checked(input),expected=mode==='enable'?p.enable_policy:p.disable_policy;
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';SET LOCAL standard_conforming_strings=on;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
WITH h AS(SELECT *FROM erp_fiscal_authorization.policy WHERE model='55'ORDER BY version DESC LIMIT 1)
SELECT jsonb_build_object('contract','homologation-55-window-readback-v1','read_only',true,'mode',${lit(mode)},'plan_sha256',${lit(sha(canonical(p)))},'observed_at',statement_timestamp(),
 'expected_policy_matches',coalesce((SELECT(to_jsonb(h)-'created_at')=(to_jsonb(jsonb_populate_record(NULL::erp_fiscal_authorization.policy,${lit(JSON.stringify(expected))}::jsonb))-'created_at') FROM h),false),
 'policy55',(SELECT to_jsonb(h)FROM h),'policy65',(SELECT to_jsonb(x)FROM erp_fiscal_authorization.policy x WHERE model='65'ORDER BY version DESC LIMIT 1),
 'query_heads',(SELECT jsonb_agg(to_jsonb(q)ORDER BY model)FROM(SELECT DISTINCT ON(model)*FROM erp_fiscal_receipt_query.policy ORDER BY model,version DESC)q),
 'window_time_valid',coalesce((SELECT statement_timestamp()>=h.valid_from AND statement_timestamp()<h.valid_until FROM h),false),
 'authorization_attempts',(SELECT count(*)FROM erp_fiscal_authorization.attempt),'authorization_consumed',(SELECT count(*)FROM erp_fiscal_authorization.attempt WHERE used_at IS NOT NULL),
 'receipt_queries',(SELECT count(*)FROM erp_fiscal_receipt_query.query),'protocol_attempts',(SELECT count(*)FROM erp_fiscal_reconciliation.attempt),
 'historical_preservation_proven_by_this_read',false,'runtime_flags_observed',false,'can_emit',false,'transport_called',false)AS fiscal55_window_readback;
COMMIT;
`;
}
export async function writeFiscal55WindowDraft(draft,path){
 const d=copy(draft);must(equal(d,createFiscal55WindowDraft(d.baseline,{baselineSha256:d.baseline_sha256})),'DRAFT_CHANGED');
 must(typeof path==='string'&&isAbsolute(path)&&!/[\x00-\x1f\x7f]/.test(path),'OUTPUT_PATH');
 const text=JSON.stringify(d,null,2)+'\n',file=await open(path,'wx',0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 return {path,sha256:sha(text),size:Buffer.byteLength(text),sql_generated:false,database_executed:false,uuid_generated:false};
}
export async function writeFiscal55WindowBundle(input,prefix){
 const p=checked(input);must(typeof prefix==='string'&&isAbsolute(prefix)&&!/[\x00-\x1f\x7f]/.test(prefix),'OUTPUT_PREFIX');
 const enable=await prepareFiscal55WindowSql(p,'enable'),disable=await prepareFiscal55WindowSql(p,'disable');
 const entries=[['plan.json',JSON.stringify(p,null,2)+'\n'],['enable.sql',enable],['disable.sql',disable],
  ['enable-readback.sql',prepareFiscal55WindowReadback(p,'enable')],['disable-readback.sql',prepareFiscal55WindowReadback(p,'disable')]],files=[];
 for(const[suffix,text]of entries){
  const path=prefix+'-'+suffix,file=await open(path,'wx',0o600);
  try{await file.writeFile(text);await file.sync();}finally{await file.close();}
  files.push({path,sha256:sha(text),size:Buffer.byteLength(text)});
 }
 const manifest={contract:'homologation-55-window-bundle-v1',plan_sha256:sha(canonical(p)),baseline_sha256:p.baseline_sha256,fresh_baseline_sha256:p.fresh_baseline_sha256,files,
  approved_at:p.approved_at,window_seconds:1200,database_executed:false,network_used:false,uuid_generated:false,flags_changed:false};
 const path=prefix+'-manifest.json',text=JSON.stringify(manifest,null,2)+'\n',file=await open(path,'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 return {path,sha256:sha(text),size:Buffer.byteLength(text),...manifest};
}
