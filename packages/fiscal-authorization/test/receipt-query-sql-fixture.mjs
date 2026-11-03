// Synthetic SQL metadata only. No socket, real A1, transport or private customer data.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {revalidationFixture,hash} from './stored-response-revalidation-fixture.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from '../src/receipt-query-manifest.mjs';
export {hash};
export const PREFIX='erp_fiscal_receipt_query_';
export async function receiptQueryFixture(){
 const f=await revalidationFixture();try{
  // Production SQL hashes are captured in UTC;079 includes literal timestamp strings.
  await f.db.exec("set timezone='UTC'");
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160089_fiscal_receipt_query.sql',import.meta.url),'utf8'));
  const call=(action,args)=>f.callSql(PREFIX+action,args);
  const enable=async(enabled=true)=>{const version=Number((await f.db.query('select max(version)+1 v from erp_fiscal_receipt_query.policy')).rows[0].v);
   await f.db.query(`insert into erp_fiscal_receipt_query.policy select model,$1,$2,profile,manifest_hash,origin,binding_profile,lease_seconds,cadence_seconds,max_queries_per_hour,clock_timestamp()-interval'1day',clock_timestamp()+interval'1day',clock_timestamp()from erp_fiscal_receipt_query.policy where version=1`,[version,enabled]);return version;};
  const pending=e=>({...e,outcome:'receipt_pending',cstat:'103',receipt_number:'035000000000001',protocol_cstat:null,protocol_number:null,reference_digest:null,signature_verified:false,processed_xsd_validated:false});
  async function source(model='55',kind='authorization'){
   let c,b,selected;
   if(kind==='revalidation'){
    const x=await f.start(model);c=x.c;b=x.b;const args={...x.args,p_evidence:pending(x.args.p_evidence),p_processed_hash:null,p_processed_size:null};
    selected=await f.callRevalidation('finish',args);
   }else{
    c=await f.candidate(model);const proof=await f.review(c);b=await f.begin(c,Number((await f.db.query('select max(version) v from erp_fiscal_authorization.policy')).rows[0].v));const p=await f.prepare(b,proof);await f.use(b,proof);
    const args=await f.finishArgs(b,p);await f.wire('finish',{...args,p_evidence:pending(args.p_evidence),p_processed_hash:null,p_processed_size:null});
   }
   const contextArgs={p_user_id:f.users.fiscal,p_source_kind:kind,p_source_command_id:kind==='authorization'?c.input.commandId:selected.command_id,p_expected_attempt_id:b.value.receipt.attempt_id};
   const context=await call('context',contextArgs),s=context.source,ev=kind==='authorization'?s.original_source.artifact.evidence:s.selected_revalidation.receipt.evidence;
   // The SQL trusts an authenticated byte validator; this fixture only models its closed evidence.
   const validation={profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,source_binding_hash:s.source_binding_hash,payload_hash:ev.payload_hash,receipt_number:ev.receipt_number,tmed_seconds:0,received_at:ev.received_at,observed_at:new Date(Date.now()-120000).toISOString(),signature_verified:true,xsd_validated:true,context_matched:true,tls_origin_verified:true,tax_rules_validated:false,can_query:false,can_emit:false,can_transmit:false};
   return{c,b,contextArgs,context,validation};
  }
  const beginArgs=async x=>({p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_selection:(await call('context',x.contextArgs)).selection,p_source_validation:x.validation,p_confirmed:true});
  const begin=async x=>{const args=await beginArgs(x);return{args,value:await call('begin',args)};};
  const ids=b=>({p_user_id:f.users.fiscal,p_query_id:b.value.query_id,p_lease_id:b.value.recovery.lease_id});
  const object=async(b,kind,tag,size=32)=>{const key=`receipt-queries/${b.value.query_id}/${kind}/${tag}.${kind==='observations'?'json':'xml'}`;await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)on conflict do nothing',['brufap-fiscal-artifacts',key,JSON.stringify({size,mimetype:'application/octet-stream'})]);return key;};
  const preparation=(b,sha)=>{const c=b.value.recovery;return{profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,...Object.fromEntries(['query_id','nonce','source_binding_hash','signed_hash','model','environment','receipt_number'].map(k=>[k,c[k]])),request_hash:sha,payload_hash:hash('consReciNFe '+c.receipt_number),signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false};};
  const prepare=async b=>{const sha=hash('same receipt SOAP '+b.value.source_validation.receipt_number),args={...ids(b),p_request_hash:sha,p_request_size:32,p_evidence:preparation(b,sha)};await object(b,'requests',sha);return{args,value:await call('prepare',args)};};
  const use=b=>call('use',ids(b));
  const finishArgs=async(b,p,variant='105')=>{const c=b.value.recovery,authorized=['100','150'].includes(variant),rejected=variant==='245',review=variant==='106',rh=hash('query response '+c.query_id+' '+variant),oh=hash('query observation '+c.query_id),ph=authorized?hash('processed '+c.query_id):null;
   const evidence={profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,...Object.fromEntries(['query_id','nonce','source_binding_hash','signed_hash','model','environment','receipt_number'].map(k=>[k,c[k]])),request_hash:p.args.p_request_hash,response_hash:rh,payload_hash:hash('retCons '+variant),outcome:authorized?'authorization_declared':rejected?'rejected':review?'review_required':'receipt_pending',rejection_code:null,cstat:authorized||rejected?'104':variant,protocol_cstat:authorized||rejected?variant:null,protocol_number:authorized?'135260000000001':null,received_at:'2026-10-17T12:00:00.000Z',reference_digest:authorized?c.reference_digest:null,signature_verified:authorized,xsd_validated:true,context_matched:true,processed_xsd_validated:authorized,tls_origin_verified:true,observation_hash:oh,observation_size:128,tax_rules_validated:false,can_emit:false,can_transmit:false};
   await object(b,'responses',p.args.p_request_hash);await object(b,'observations',p.args.p_request_hash,128);if(ph)await object(b,'processed',ph);
   return{...ids(b),p_response_hash:rh,p_response_size:32,p_observation_hash:oh,p_observation_size:128,p_evidence:evidence,p_processed_hash:ph,p_processed_size:ph?32:null};};
  // Test-only passage of time, preserving the entire interval and immutable receipt together.
  const age=async(b,seconds=120)=>{await f.db.exec('alter table erp_fiscal_receipt_query.query disable trigger guard_query');try{await f.db.query(`update erp_fiscal_receipt_query.query set created_at=created_at-$2*interval'1second',expires_at=expires_at-$2*interval'1second',used_at=used_at-$2*interval'1second',finished_at=finished_at-$2*interval'1second',receipt=jsonb_set(jsonb_set(receipt,'{created_at}',to_jsonb(created_at-$2*interval'1second')),'{expires_at}',to_jsonb(expires_at-$2*interval'1second'))where id=$1`,[b.value.query_id,seconds]);}finally{await f.db.exec('alter table erp_fiscal_receipt_query.query enable trigger guard_query');}};
  const counts=async()=>Object.fromEntries(await Promise.all(['query','request','result','audit'].map(async n=>[n,(await f.db.query(`select count(*)::int n from erp_fiscal_receipt_query.${n}`)).rows[0].n])));
  return{...f,queryCall:call,enableQuery:enable,querySource:source,queryBeginArgs:beginArgs,queryBegin:begin,queryIds:ids,queryObject:object,queryPreparation:preparation,queryPrepare:prepare,queryUse:use,queryFinishArgs:finishArgs,ageQuery:age,queryCounts:counts};
 }catch(e){await f.close();throw e;}
}
