// Closed synthetic089 port. Real signed NFe, source reader, SOAP parser and Python XSD; no database/network.
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sourceFixture,realValidate} from './receipt-query-source-fixture.mjs';
import {receiptResponse} from './receipt-fixtures.mjs';
import {createReceiptValidator} from '../src/receipt-validator.mjs';
import {receiptValidationContext} from '../src/receipt-core.mjs';
import {RECEIPT_QUERY_LEDGER_FLAGS as FLAGS} from '../src/receipt-query-ledger-dto.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST as M,RECEIPT_QUERY_SOURCE_MANIFEST_HASH as MH} from '../src/receipt-query-manifest.mjs';
import {SP_RECEIPT_QUERY_SERVER_TRUST,SP_RECEIPT_QUERY_ROOT_HASH} from '../src/receipt-query-server-trust.mjs';
import {createReceiptQueryService} from '../src/receipt-query-service.mjs';
import {hash} from '../src/service-common.mjs';
const clone=structuredClone,now=()=>new Date().toISOString(),err=code=>Object.assign(Error(code),{code});
export const receiptValidate=createReceiptValidator({pythonPath:process.env.BRUFAP_TEST_PYTHON??'/Users/bruno/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',validatorPath:fileURLToPath(new URL('../receipt-validator.py',import.meta.url))});
export function serviceFixture(f,model='55',kind='authorization'){
 const x=sourceFixture(f,model,kind),actor=x.input.actor,files=new Map(),calls=[],state={record:null,beginArgs:null,policyOff:false,denied:false,variant:{batch:'105'},raw:null,hooks:{},sessionCalls:0,transports:0,sourceCalls:0};
 const policy={model,version:2,enabled:true,profile:M.profile,manifest_hash:MH,origin:'operational',binding_profile:`sp${model}-receipt-soap12-reviewed-20261016-v1`,lease_seconds:60,cadence_seconds:60,max_queries_per_hour:10,valid_from:new Date(Date.now()-86400000).toISOString(),valid_until:new Date(Date.now()+86400000).toISOString(),created_at:now()};
 const pending=()=>({state:'pending',query_ids:[],selected_query_id:null,protocol:null,resolution_hash:hash('pending resolver')});
 const selection=()=>({source_kind:kind,source_command_id:x.source.source_command_id,expected_authorization_command_id:x.source.authorization_command_id,expected_attempt_id:x.source.authorization_attempt_id,expected_candidate_id:x.source.candidate_id,expected_candidate_version:1,expected_signed_hash:x.source.signed_hash,expected_source_binding_hash:x.source.source_binding_hash,expected_chain_hash:hash(state.record?'chain changed':'chain empty'),expected_identity_version:1,expected_a1_version:2,expected_query_policy_version:2});
 const view=()=>{const r=clone(state.record);r.current.lease_expired=Date.now()>=Date.parse(r.current.expires_at);return r;};
 const context=()=>{
  const blockers=['SOURCE_VALIDATION_REQUIRED'];if(state.policyOff)blockers.push('POLICY_DISABLED');if(state.record&&!state.record.current.finished_at)blockers.push('QUERY_ACTIVE');const resolution=state.record?.resolution??pending();if(resolution.state!=='pending')blockers.push('RESOLUTION_CLOSED');
  return{...FLAGS,read_only:true,source:clone(x.source),observed_at:now(),chain_hash:selection().expected_chain_hash,resolution:clone(resolution),policy:{...policy,enabled:!state.policyOff},heads:{identity_version:1,a1_version:2},selection:selection(),next_query_at:null,blockers,source_validation_required:true,private_eligible_for_attested_source:blockers.length===1,history:state.record?[view()]:[]};
 };
 const rpc=async(action,args,options)=>{
  calls.push(action);if(state.denied)throw err('42501');if(state.hooks.before)await state.hooks.before(action,args);
  let output;
  if(action==='context')output=context();
  else if(action==='history')output={...FLAGS,read_only:true,authorization_command_id:x.source.authorization_command_id,authorization_attempt_id:x.source.authorization_attempt_id,observed_at:now(),chain_hash:selection().expected_chain_hash,resolution:clone(state.record?.resolution??pending()),items:state.record?[view()]:[],next_before:null,limit:args.p_limit};
  else if(action==='command'){if(!state.record)throw err('P0002');output={...view(),read_only:true,replayed:true,execution:null};}
  else if(action==='begin'){
   if(state.record){if(JSON.stringify(args)!==JSON.stringify(state.beginArgs))throw err('40001');output={...view(),replayed:true,execution:null};}
   else{state.beginArgs=clone(args);const s=x.source,o=s.original_source.recovery,created_at=now(),expires_at=new Date(Date.parse(created_at)+60000).toISOString();
    const identity=Object.fromEntries(['authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','candidate_version','signed_hash','model','environment','origin'].map(k=>[k,s[k]]));
    const receipt={query_id:args.p_command_id,actor,...identity,ordinal:1,identity_version:1,a1_version:2,query_policy_version:2,created_at,expires_at};
    const recovery={private_executor_only:true,purpose:'sp-receipt-query-homologation-v1',query_id:args.p_command_id,actor,...identity,signed_size:s.signed_size,lease_id:randomUUID(),nonce:randomUUID(),created_at,expires_at,policy:clone(policy),identity_version:1,a1_version:2,...Object.fromEntries(['credential_id','envelope_hash','certificate_fingerprint','access_key','reference_digest','issuer_cnpj'].map(k=>[k,o[k]])),receipt_number:args.p_source_validation.receipt_number,request_hash:null,request_size:null};
    state.record={...FLAGS,query_id:args.p_command_id,receipt,source:clone(s),source_validation:clone(args.p_source_validation),current:{state:'prepared',grant_consumed:false,used_at:null,expires_at,lease_expired:false,finished_at:null,recovery_required:false},request:null,artifact:null,recovery,resolution:pending(),error_code:null};output={...view(),replayed:false,execution:clone(recovery)};
   }
  }else if(action==='prepare'){
   Object.assign(state.record.recovery,{request_hash:args.p_request_hash,request_size:args.p_request_size});state.record.request={query_id:state.record.query_id,sha256:args.p_request_hash,size_bytes:args.p_request_size,evidence:clone(args.p_evidence),created_at:now()};state.record.current.state='request_ready';output={...view(),replayed:false};
  }else if(action==='use'){
   const issued_at=now();Object.assign(state.record.current,{state:'dispatched',grant_consumed:true,used_at:issued_at,recovery_required:true});output={...FLAGS,private_executor_only:true,grant:{...clone(state.record.recovery),issued_at}};
  }else if(action==='finish'){
   const e=args.p_evidence,t=now(),outcome=e.outcome==='authorization_declared'?'authorized_homologation':e.outcome==='invalid_response'?'review_required':e.outcome;
   state.record.artifact={query_id:state.record.query_id,response_hash:args.p_response_hash,response_size:args.p_response_size,observation_hash:args.p_observation_hash,observation_size:args.p_observation_size,evidence:clone(e),processed_hash:args.p_processed_hash,processed_size:args.p_processed_size,created_at:t};Object.assign(state.record.current,{state:outcome,finished_at:t,recovery_required:false});
   if(['authorized_homologation','rejected'].includes(outcome))state.record.resolution={state:outcome,query_ids:[state.record.query_id],selected_query_id:state.record.query_id,protocol:{state:outcome,access_key:state.record.recovery.access_key,receipt_number:e.receipt_number,reference_digest:e.reference_digest,cstat:e.cstat,protocol_cstat:e.protocol_cstat,protocol_number:e.protocol_number,received_at:e.received_at},resolution_hash:hash('resolution '+state.record.query_id)};
   if(outcome==='review_required')state.record.resolution={...pending(),state:'review_required'};output={...view(),replayed:false};
  }else if(action==='fail'){
   Object.assign(state.record.current,{state:state.record.current.grant_consumed?'uncertain':'failed_before_dispatch',finished_at:now()});state.record.error_code=args.p_error_code;output={...view(),replayed:false};
  }else throw err('22023');
  if(state.hooks.after)await state.hooks.after(action,args,output);return output;
 };
 const storage={read:async r=>files.has(r.key)?new Response(Buffer.from(files.get(r.key)),{headers:{'content-type':'application/octet-stream'}}):null,putImmutable:async r=>{if(!files.has(r.key))files.set(r.key,Buffer.from(r.bytes));return{status:201,requires_readback:true};}};
 const ports={rpc,storage,readSource:async()=>{state.sourceCalls++;return x.read();},validate:receiptValidate,validateProcessed:realValidate,withPreparedSession:async(input,action)=>{state.sessionCalls++;state.request=input.request;await action({synthetic:true});},transport:async(input)=>{
  state.transports++;const q=state.request,payload=receiptResponse({...q,...receiptValidationContext(q)},state.variant),bytes=state.raw??Buffer.from(`<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="${input.request.binding.serviceNamespace}">${payload}</nfeResultMsg></Body></Envelope>`);
  return{response:new Response(Buffer.from(bytes),{headers:{'content-type':'application/soap+xml; charset=utf-8'}}),tls:{origin:'operational',protocol:'TLSv1.2',server_identity_verified:true,server_trust_profile:SP_RECEIPT_QUERY_SERVER_TRUST,server_trust_anchor_sha256:SP_RECEIPT_QUERY_ROOT_HASH}};
 }};
 return{x,actor,files,calls,state,ports,contextInput:{source_kind:kind,source_command_id:x.source.source_command_id,expected_attempt_id:x.source.authorization_attempt_id},input:()=>({actor,request:{...selection(),command_id:randomUUID(),confirmed:true}}),service:patch=>createReceiptQueryService({...ports,enabled:true,...patch}),age(){const r=state.record;for(const o of [r.receipt,r.recovery])for(const k of ['created_at','expires_at'])o[k]=new Date(Date.parse(o[k])-120000).toISOString();r.current.expires_at=r.recovery.expires_at;if(r.current.used_at)r.current.used_at=new Date(Date.parse(r.current.used_at)-120000).toISOString();if(r.request)r.request.created_at=new Date(Date.parse(r.request.created_at)-120000).toISOString();}};
}
