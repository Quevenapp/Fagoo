import './synthetic-october-clock.mjs';
// All records, reviews, certificates, sockets and byte stores are synthetic local fixtures.
// This port simulates the proposed068 atomic review CAS; it does not test a deployed SQL068.
import assert from 'node:assert/strict';
import {randomUUID,X509Certificate} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {fileURLToPath} from 'node:url';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {prepareAuthorization} from '../src/index.mjs';
import {createAuthorizationValidator} from '../src/validator.mjs';
import {createReviewedAuthorizationService} from '../src/operational-service.mjs';
import {createReviewedAuthorizationTransport} from '../src/operational-transport.mjs';
import {reviewedAuthorizationBinding} from '../src/authorization-soap-binding.mjs';
import {SUBSET_LEDGER_PROFILE,SUBSET_POLICY_HASHES} from '../src/operational-dto.mjs';
import {SP_CRT1_RULE_MANIFEST} from '../src/sp-crt1-rule-manifest.mjs';
import {FLAGS,preparationEvidence,resultEvidence,same} from '../src/service-dto.mjs';
import {hash,AuthorizationServiceError} from '../src/service-common.mjs';
import {wire} from '../../fiscal-reconciliation/test/protocol-wire.mjs';
import {fiscalResponse} from './service-fixtures.mjs';
const clone=x=>structuredClone(x),canonical=v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
export {hash,HOLDER};
export function reviewRecord(q,{version=1,edit=()=>{}}={}){
 const r={id:'d0000000-0000-4000-8000-000000000001',version,candidate_id:q.candidateId,signed_hash:q.signedHash,facts_hash:q.factsHash,profile:q.profile,profile_hash:q.profileHash,reviewed_by:'d0000000-0000-4000-8000-000000000002',reviewed_at:'2026-10-16T11:00:00Z',valid_until:'2026-10-25T23:59:59Z',document:{operation:'internal_normal_sale',recipient_regime:'noncontributor',acquisition_purpose:'final_consumption',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:q.items.map(x=>({position:x.position,item_hash:x.itemHash,classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:'reviewed_absent',st:'not_applicable',fcp:'not_applicable',credit:null}))};edit(r);return{...r,review_hash:hash(canonical(r))};
}
export async function operationalFixture({model='55',count=1,credential:provided,editXml=x=>x}={}){
 const credential=provided??await credentials(),signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});
 const unsigned=editXml(buildBusinessXml(businessFixture({model,count})).unsignedXml),fp=hash(credential.certificateDer),cert=new X509Certificate(credential.certificateDer);
 let signed;try{signed=createSignedHomologationCandidate({xml:unsigned,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(unsigned),expectedCertificateFingerprint:fp,now:NOW});}finally{disposeSigner(signer);}
 const bytes=Buffer.from(signed.signedXml),actor=randomUUID(),candidateId=randomUUID(),commandId=randomUUID();
 const input={actor,commandId,candidateId,signedHash:signed.xmlDigest,expectedIdentityVersion:1,expectedA1Version:2,expectedPolicyVersion:3,confirmed:true};
 const request=prepareAuthorization({signedBytes:bytes,expectedSignedHash:signed.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedHolderCnpj:HOLDER,expectedCertificate:credential.certificate,expectedCertificateFingerprint:fp,now:NOW,batchId:'1'});
 const calls={ledger:[],read:[],put:[],review:[],custody:[],validate:[],transport:[]},files=new Map([[`candidates/${candidateId}/${signed.xmlDigest}.xml`,bytes]]),state={known:null,reviewVersion:1,reviewMissing:false,reviewEdit:()=>{},acl:true,issuer:true,current:true,beforeUse:()=>{},responseOptions:{},used:0};
 const candidate={state:'stored',attempt_count:1,lease_until:null,unsigned_artifact_current:true,basis_changed:false,draft_archived:false,source_cancelled:false,series_enabled:true,a1_version:2,a1_changed:false,certificate_time_valid_now:true,latest_candidate_id:candidateId,latest_candidate_version:1,is_latest_candidate:true,artifact_current:true};
 const code=c=>{throw new AuthorizationServiceError(c);};
 const view=action=>{const k=state.known;return{...FLAGS,command_id:commandId,receipt:clone(k.receipt),current:clone(k.current),artifact:clone(k.artifact),error_code:k.error_code,recovery:clone(k.context),...(action==='command'?{read_only:true}:{replayed:action!=='begin'||k.replayed}),...(action==='begin'?{execution:!k.current.grant_consumed&&['prepared','request_ready'].includes(k.current.state)&&state.current?clone(k.context):null}:{})};};
 const envelope=v=>({ledger_profile:SUBSET_LEDGER_PROFILE,view:v,rule_review:clone(state.known?.proof??null),observation:clone(state.known?.observation??null)});
 const ledger=async(action,args,o)=>{
  calls.ledger.push({action,args:clone(args)});assert.ok(o.signal instanceof AbortSignal);if(!state.acl||!state.issuer)code('42501');assert.equal(args.p_user_id,actor);
  if(action==='begin'){
   assert.equal(args.p_command_id,commandId);if(!state.current)code('40001');
   if(!state.known){const now=Date.now(),at=new Date(now).toISOString(),expires=new Date(now+55000).toISOString(),attempt=randomUUID(),intent=randomUUID();
    const receipt={candidate_id:candidateId,candidate_version:1,unsigned_job_id:randomUUID(),reservation_id:randomUUID(),draft_id:randomUUID(),model,signed_hash:signed.xmlDigest,signed_size:bytes.length,signing_a1_version:2,basis_hash:'b'.repeat(64),completion_version:1,completion_hash:'c'.repeat(64),attempt_id:attempt,intent_id:intent,ordinal:'1',command_id:commandId,batch_id:'1',environment:'2',origin:'synthetic',policy_version:3,identity_version:1,a1_version:2,created_at:at};
    const context={private_executor_only:true,attempt_id:attempt,intent_id:intent,command_id:commandId,actor,lease_id:randomUUID(),nonce:randomUUID(),expires_at:expires,purpose:'sp-authorization-homologation-v1',environment:'2',model,origin:'synthetic',policy_version:3,binding_profile:reviewedAuthorizationBinding(model).profile,rule_profile:SP_CRT1_RULE_MANIFEST.profile,policy_manifest_hash:SUBSET_POLICY_HASHES[model],candidate_id:candidateId,signed_hash:signed.xmlDigest,signed_size:bytes.length,batch_id:'1',access_key:request.accessKey,reference_digest:request.referenceDigest,issuer_cnpj:HOLDER,identity_version:1,a1_version:2,credential_id:randomUUID(),envelope_hash:'d'.repeat(64),certificate_fingerprint:fp,request_hash:null,request_size:null};
    state.known={receipt,context,current:{state:'prepared',grant_consumed:false,used_at:null,expires_at:expires,lease_expired:false,finished_at:null,identity_changed:false,a1_changed:false,policy_changed:false,policy_enabled:true,candidate:clone(candidate),recovery_required:false,authorized_in_homologation:false},artifact:null,error_code:null,proof:null,observation:null,replayed:false};
   }else state.known.replayed=true;
   return envelope(view(action));
  }
  if(!state.known)code('P0002');const k=state.known;
  if(action==='command')return envelope(view(action));
  if(action==='history'){const v=view('command');delete v.recovery;v.recoverable_by_actor=k.current.recovery_required;return{ledger_profile:SUBSET_LEDGER_PROFILE,page:{...FLAGS,read_only:true,candidate_id:candidateId,items:[v],limit:args.p_limit,has_more:false,next_cursor:null},rule_reviews:[clone(k.proof)],observations:[clone(k.observation)]};}
  assert.equal(args.p_attempt_id,k.context.attempt_id);assert.equal(args.p_lease_id,k.context.lease_id);
  if(action==='prepare'){
   preparationEvidence(args.p_evidence);assert.equal(args.p_evidence.tax_rules_validated,false);if(k.current.grant_consumed)code('40001');
   k.context.request_hash=args.p_request_hash;k.context.request_size=args.p_request_size;k.proof=clone(args.p_rule_review);k.current.state='request_ready';return envelope(view(action));
  }
  if(action==='use'){
   await state.beforeUse();if(!state.current||k.current.grant_consumed||!same(k.proof,args.p_rule_review)||k.proof.review_version!==state.reviewVersion||state.reviewMissing)code('40001');
   k.current.grant_consumed=true;k.current.used_at=new Date().toISOString();k.current.state='dispatched';k.current.recovery_required=true;state.used++;
   return envelope({...FLAGS,private_executor_only:true,grant:{...clone(k.context),issued_at:k.current.used_at}});
  }
  if(action==='finish'){
   const evidence=resultEvidence(args.p_evidence);assert.equal(k.current.grant_consumed,true);assert.equal(evidence.origin,'synthetic');assert.equal(evidence.tls_origin_verified,false);
   const root=`authorization/${k.context.attempt_id}`,stored=files.get(`${root}/responses/${k.context.request_hash}.xml`),meta=files.get(`${root}/observations/${k.context.request_hash}.json`);
   assert.equal(hash(stored),args.p_response_hash);assert.equal(stored.length,args.p_response_size);assert.equal(hash(meta),args.p_observation_hash);assert.equal(meta.length,args.p_observation_size);
   if(args.p_processed_hash)assert.equal(hash(files.get(`${root}/processed/${args.p_processed_hash}.xml`)),args.p_processed_hash);
   k.artifact={response_hash:args.p_response_hash,response_size:args.p_response_size,evidence,processed_hash:args.p_processed_hash,processed_size:args.p_processed_size,created_at:new Date().toISOString()};
   k.observation={sha256:args.p_observation_hash,size_bytes:args.p_observation_size};k.current.state=evidence.outcome==='authorization_declared'?'authorization_observed':evidence.outcome==='invalid_response'?'review_required':evidence.outcome;k.current.finished_at=k.artifact.created_at;k.current.recovery_required=false;k.error_code=null;return envelope(view(action));
  }
  if(action==='fail'){k.current.state=k.current.grant_consumed?'submission_uncertain':'failed_before_dispatch';k.current.finished_at=new Date().toISOString();k.current.recovery_required=k.current.grant_consumed;k.error_code=args.p_error_code;return envelope(view(action));}
  throw Error('unknown fixture operation');
 };
 const storage={read:async v=>{calls.read.push(v.key);const b=files.get(v.key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream','content-length':String(b.length)}}):null;},putImmutable:async v=>{assert.equal(v.upsert,false);assert.equal(v.ifNoneMatch,'*');assert.equal(hash(v.bytes),v.sha256);calls.put.push(v.key);const exists=files.has(v.key);if(!exists)files.set(v.key,Buffer.from(v.bytes));return{status:exists?409:201,requires_readback:true};}};
 const validateReal=createAuthorizationValidator({pythonPath:process.env.BRUFAP_TEST_PYTHON??'/Users/bruno/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',validatorPath:fileURLToPath(new URL('../validator.py',import.meta.url))});
 const validate=async(v,o)=>{calls.validate.push(v.kind);return validateReal(v,o);};
 const readReview=async(q,o)=>{calls.review.push(q);assert.equal(q.actor,actor);assert.equal(q.candidateVersion,1);return state.reviewMissing?null:Buffer.from(JSON.stringify(reviewRecord(q,{version:state.reviewVersion,edit:state.reviewEdit})));};
 const secureContext=createSecureContext(),anchor=hash('synthetic local server anchor');
 const metadata={fingerprint_sha256:fp,holder_cnpj:HOLDER,not_before:cert.validFromDate.toISOString(),not_after:cert.validToDate.toISOString(),client_auth_usage:'unrestricted_absent',presented_chain_links_checked:false,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,can_emit:false,can_transmit:false};
 const custody=async(v,action,o)=>{calls.custody.push(v);await action({secureContext,metadata,signal:o.signal,deadline:o.deadline});};
 const soapResponse=(opts={})=>Buffer.from(`<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">${fiscalResponse(request,opts).toString().replaceAll('2026-10-16T09:01:00-03:00',new Date(Date.now()-10800000).toISOString().slice(0,19)+'-03:00')}</nfeResultMsg></Body></Envelope>`);
 let nextWire;const requestImpl=(o,cb)=>{assert.equal(state.used,1);calls.transport.push(o);nextWire=wire({body:soapResponse(state.responseOptions)});return nextWire.requestImpl(o,cb);};
 const transport=createReviewedAuthorizationTransport({requestImpl,serverTrustAnchorSha256:anchor,attestServerContext:c=>{assert.equal(c,secureContext);return{server_trust_profile:'synthetic-mtls-v1',server_trust_anchor_sha256:anchor};}});
 const ports={ledger,storage,validate,readReview,withPreparedSession:custody,transport,syntheticDispatchEnabled:true};
 return{input,ports,state,calls,files,credential,request,metadata,soapResponse,service:patch=>createReviewedAuthorizationService({...ports,...patch}),close(){bytes.fill(0);if(!provided)credential.privateDer.fill(0);}};
}
