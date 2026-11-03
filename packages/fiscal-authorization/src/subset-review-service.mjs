/** Authenticated composition port for068. No custody, fiscal grant, transport or Storage writer. */
import {prepareAuthorization} from './index.mjs';
import {pinnedCandidateCertificate} from './pinned-certificate.mjs';
import {ruleEngine} from './rule-profiles.mjs';
import {CURRENT_RULE_PROFILE_HASH,RULE_PROFILE_V1_HASH} from './rule-profile-registry.mjs';
import {fields,need,id,int,sha,stamp,freeze,canonical,declaration,recordText,captureArgs,projectSubsetReview,SUBSET_REVIEW_FLAGS} from './subset-review-dto.mjs';
import {projectResponse as signedResponse} from '../../fiscal-signed-rpc/src/dto.mjs';
import {scope,readBody,cancel} from './service-common.mjs';

export const SUBSET_SERVICE_REQUEST_BYTES=147456;
export const SUBSET_SERVICE_RESPONSE_BYTES=1048576;
export const SUBSET_SAVE_BLOCKERS=Object.freeze(['CANDIDATE_NOT_CURRENT','BUSINESS_BASIS_CHANGED','DRAFT_ARCHIVED','SOURCE_CANCELLED','A1_CHANGED','SERIES_DISABLED','CERTIFICATE_TIME_INVALID','PROFILE_WINDOW_CLOSED','EXISTING_CREDIT_EVIDENCE_READ_ONLY']);
const CURRENT=['artifact_current','basis_changed','draft_archived','source_cancelled','a1_changed','is_latest_candidate','series_enabled','certificate_time_valid_now'];
const PREFIX='erp_fiscal_subset_review_',STATES=['22023','40001','42501','55000','P0002'];
export class SubsetReviewServiceError extends Error{
 constructor(code,{commandId=null,recoveryRequired=false}={}){super(code);this.name='SubsetReviewServiceError';this.code=code;this.command_id=commandId;this.recovery_required=recoveryRequired;}
}
// Signed DTOs have their own closed key set (including a1_version); the068
// declaration canonicalizer intentionally accepts a narrower alphabet.
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const boundedOutput=v=>{need(Buffer.byteLength(JSON.stringify(v))<=SUBSET_SERVICE_RESPONSE_BYTES,'SUBSET_REVIEW_SERVICE_RESPONSE_LIMIT');return freeze(v);};
const choice=(v,values)=>need(typeof v==='string'&&values.includes(v),'SUBSET_REVIEW_CHOICES_INVALID');
/** Capture every choice before the first await. Hashes and credit evidence are never accepted here. */
export function captureSubsetReviewChoices(input){
 const v=fields(input,['document','items']),d=fields(v.document,['operation','recipient_regime','acquisition_purpose','payment','excluded_groups']);
 choice(d.operation,['internal_normal_sale','outside_scope','unreviewed']);choice(d.recipient_regime,['regular_icms','simples','noncontributor','unreviewed']);choice(d.acquisition_purpose,['resale','industrialization','final_consumption','unreviewed']);choice(d.payment,['matches_signed_document','unreviewed']);choice(d.excluded_groups,['not_applicable','applies','unreviewed']);
 need(Array.isArray(v.items)&&int(v.items.length,1,250),'SUBSET_REVIEW_CHOICES_INVALID');
 const ds=Object.getOwnPropertyDescriptors(v.items);need(Reflect.ownKeys(ds).length===v.items.length+1,'SUBSET_REVIEW_CHOICES_INVALID');
 const items=Array.from({length:v.items.length},(_,i)=>{
  const descriptor=ds[String(i)];need(descriptor?.enumerable&&Object.hasOwn(descriptor,'value'),'SUBSET_REVIEW_CHOICES_INVALID');
  const x=fields(descriptor.value,['position','classification','benefit','pis_cofins','gtin','st','fcp','credit']);need(x.position===i+1&&x.credit===null,'SUBSET_REVIEW_CREDIT_EVIDENCE_UNAVAILABLE');
  choice(x.classification,['reviewed_physical_goods','outside_scope','unreviewed']);choice(x.benefit,['not_applicable','applies','unreviewed']);choice(x.pis_cofins,['normal_unified_simples','other','unreviewed']);choice(x.gtin,['reviewed_absent','reviewed_identifiers','unreviewed']);choice(x.st,['documented_prior_retention','not_applicable','unreviewed']);choice(x.fcp,['documented_prior_retention','not_applicable','unreviewed']);return x;
 });return freeze({document:d,items});
}
function capture(action,input){
 const keys=action==='context'?['actor','candidateId']:action==='command'?['actor','commandId']:['actor','candidateId','commandId','expectedCandidateVersion','signedHash','expectedReviewVersion','expectedFactsHash','expectedProfileHash','validUntil','choices'];
 const x=fields(input,keys);need(id(x.actor)&&id(action==='command'?x.commandId:x.candidateId));
 if(action==='save'){
  need(id(x.commandId)&&int(x.expectedCandidateVersion)&&int(x.expectedReviewVersion,0,2147483646)&&sha(x.signedHash)&&sha(x.expectedFactsHash)&&sha(x.expectedProfileHash)&&stamp(x.validUntil));x.choices=captureSubsetReviewChoices(x.choices);
 }
 need(Buffer.byteLength(JSON.stringify(x))<=SUBSET_SERVICE_REQUEST_BYTES,'SUBSET_REVIEW_SERVICE_REQUEST_LIMIT');return freeze(x);
}
function publicReview(v){
 let receipt=null,declaration=null;if(v.receipt){const{schema,...r}=v.receipt;receipt=r;const b=recordText(v.record_text);declaration={document:b.document,items:b.items.map(({item_hash,...item})=>item)};}
 return{receipt,current:v.current,declaration};
}
function blockers(source,review,at,manifest){
 const c=source.current,out=[];if(!c.artifact_current||!c.is_latest_candidate)out.push('CANDIDATE_NOT_CURRENT');
 for(const [key,code]of [['basis_changed','BUSINESS_BASIS_CHANGED'],['draft_archived','DRAFT_ARCHIVED'],['source_cancelled','SOURCE_CANCELLED'],['a1_changed','A1_CHANGED']])if(c[key])out.push(code);
 if(!c.series_enabled)out.push('SERIES_DISABLED');if(!c.certificate_time_valid_now)out.push('CERTIFICATE_TIME_INVALID');
 if(at<Date.parse(manifest.timePolicy.validFrom)||at>=Date.parse(manifest.timePolicy.reviewBefore))out.push('PROFILE_WINDOW_CLOSED');
 if(review.record_text&&recordText(review.record_text).items.some(x=>x.credit!==null))out.push('EXISTING_CREDIT_EVIDENCE_READ_ONLY');return out;
}
export function createSubsetReviewService(configuration){
 const c=fields(configuration,['signedRpc','reviewRpc','storage'],['profileHash']),storage=fields(c.storage,['read']);need(typeof c.signedRpc==='function'&&typeof c.reviewRpc==='function'&&typeof storage.read==='function');
 const signedRpc=c.signedRpc,reviewRpc=c.reviewRpc,read=storage.read,profileHash=c.profileHash??CURRENT_RULE_PROFILE_HASH;
 const {inspectSpCrt1Candidate,projectSpCrt1CandidateReview,createSpCrt1ReviewReader,evaluateSpCrt1Rules,manifest}=ruleEngine(profileHash);
 const lookup=profileHash===RULE_PROFILE_V1_HASH?'get':'latest';
 async function metadata(x,s){
  const args=freeze({p_user_id:x.actor,p_candidate_id:x.candidateId});
  const raw=await s.bounded(()=>signedRpc('erp_fiscal_signed_get',args,{signal:s.signal,deadline:s.deadline}));s.check();
  const v=signedResponse('erp_fiscal_signed_get',raw,args);need(v.current.state==='stored'&&v.artifact,'SUBSET_REVIEW_CANDIDATE_NOT_STORED');return v;
 }
 async function review(action,args,s){
  const name=PREFIX+action,owned=captureArgs(name,args),v=await s.bounded(()=>reviewRpc(name,owned,{signal:s.signal,deadline:s.deadline}));s.check();return projectSubsetReview(name,v,owned);
 }
 async function source(x,s){
  const before=await metadata(x,s),r=before.receipt,a=before.artifact;let response,bytes;
  try{
   if(x.signedHash!==undefined)need(a.signed_hash===x.signedHash&&r.version===x.expectedCandidateVersion,'40001');
   const pending=Promise.resolve().then(()=>{s.check();return read(Object.freeze({bucket:'brufap-fiscal-artifacts',key:`candidates/${r.candidate_id}/${a.signed_hash}.xml`,signal:s.signal,deadline:s.deadline}));});
   try{response=await s.bounded(()=>pending);}catch(error){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw error;}
   bytes=await readBody(response,s,{expectedHash:a.signed_hash,expectedSize:a.size_bytes});s.check();
   const cert=pinnedCandidateCertificate({signedBytes:bytes,signedHash:a.signed_hash,signedSize:a.size_bytes,certificateFingerprint:r.certificate_fingerprint,model:r.model,now:new Date(a.created_at)});
   need(cert.referenceDigest===a.evidence.signature.reference_digest,'SUBSET_REVIEW_SOURCE_MISMATCH');
   // Inspection only: this private envelope is never persisted, returned or dispatched.
   // Its local batch marker does not reserve an idLote; facts exclude that envelope.
   const request=prepareAuthorization({signedBytes:bytes,expectedSignedHash:a.signed_hash,expectedModel:r.model,expectedIssuerCnpj:cert.issuerCnpj,expectedHolderCnpj:cert.issuerCnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:r.certificate_fingerprint,now:new Date(a.created_at),batchId:'1'});
   const handle=inspectSpCrt1Candidate({candidateId:r.candidate_id,request}),projection=projectSpCrt1CandidateReview(handle);
   const after=await metadata(x,s);need(same(before.receipt,after.receipt)&&same(before.artifact,after.artifact),'40001');s.check();
   return{source:after,handle,...projection};
  }finally{bytes?.fill(0);cancel(response?.body);}
 }
 const getArgs=(x,p)=>({p_user_id:x.actor,p_candidate_id:x.candidateId,p_candidate_version:p.source.receipt.version,p_signed_hash:p.handle.signedHash,p_facts_hash:p.handle.factsHash,p_profile_hash:p.handle.profileHash});
 async function context(x,s){
  const p=await source(x,s),v=await review(lookup,getArgs(x,p),s),at=Date.now();let evidence=null;
  // Inactive/expired declarations remain readable. They never become current evidence.
  if(v.receipt&&v.receipt.profile_hash===profileHash&&v.current.is_latest&&v.current.reviewer_active&&v.current.within_validity&&Date.parse(v.receipt.reviewed_at)<=at&&Date.parse(v.receipt.valid_until)>at){
   const reviewBytes=Buffer.from(v.record_text,'utf8');try{evidence=await createSpCrt1ReviewReader({readReview:async()=>reviewBytes})({candidate:p.handle,now:new Date(at),signal:s.signal,deadline:s.deadline});}finally{reviewBytes.fill(0);}
  }
  const report=evaluateSpCrt1Rules({candidate:p.handle,reviewEvidence:evidence,now:new Date(at)}),after=await metadata(x,s);
  need(same(after.receipt,p.source.receipt)&&same(after.artifact,p.source.artifact),'40001');const saveBlockers=blockers(after,v,Date.now(),manifest);s.check();
  return boundedOutput({...SUBSET_REVIEW_FLAGS,kind:'context',read_only:true,candidate:{candidate_id:x.candidateId,candidate_version:after.receipt.version,model:p.handle.model,signed_hash:p.handle.signedHash,facts_hash:p.handle.factsHash,profile:p.handle.profile,profile_hash:p.handle.profileHash},facts:p.facts,labels:p.labels,source_current:Object.fromEntries(CURRENT.map(k=>[k,after.current[k]])),review:{...publicReview(v),matches_profile:v.receipt?.profile_hash===profileHash},report,save_available:saveBlockers.length===0,save_blockers:saveBlockers});
 }
 async function perform(action,input,options){
  let x,s,dispatched=false;
  try{
   x=capture(action,input);s=scope(options);if(action==='context')return await context(x,s);
   let v;if(action==='command')v=await review('command',{p_user_id:x.actor,p_command_id:x.commandId},s);
   else{
    // GET-first idempotency survives profile changes and no longer depends on current XML/A1.
    let previous;try{previous=await review('command',{p_user_id:x.actor,p_command_id:x.commandId},s);}catch(error){if(error?.code!=='P0002')throw error;}
    if(previous){
     const r=previous.receipt,d=publicReview(previous).declaration;
     need(r.candidate_id===x.candidateId&&r.candidate_version===x.expectedCandidateVersion&&r.signed_hash===x.signedHash&&r.facts_hash===x.expectedFactsHash&&r.profile_hash===x.expectedProfileHash&&r.review_version===x.expectedReviewVersion+1&&r.valid_until===x.validUntil&&canonical(d)===canonical(x.choices),'40001');
     s.check();return boundedOutput({...SUBSET_REVIEW_FLAGS,kind:'save',read_only:false,command_id:x.commandId,replayed:true,...publicReview(previous)});
    }
    need(x.expectedProfileHash===profileHash,'40001');
    const p=await source(x,s);need(p.handle.factsHash===x.expectedFactsHash&&p.handle.profileHash===x.expectedProfileHash,'40001');
    const current=await review(lookup,getArgs(x,p),s);
    need(!current.record_text||recordText(current.record_text).items.every(i=>i.credit===null),'SUBSET_REVIEW_EXISTING_CREDIT_READ_ONLY');
    need(x.choices.items.length===p.facts.items.length,'SUBSET_REVIEW_CHOICES_INVALID');
    const d=declaration({document:x.choices.document,items:x.choices.items.map((i,n)=>({...i,item_hash:p.facts.items[n].itemHash}))});
    const args={p_user_id:x.actor,p_command_id:x.commandId,p_candidate_id:x.candidateId,p_expected_candidate_version:p.source.receipt.version,p_signed_hash:p.handle.signedHash,p_expected_review_version:x.expectedReviewVersion,p_facts_hash:p.handle.factsHash,p_profile_hash:p.handle.profileHash,p_schema:p.source.artifact.evidence.xsd,p_valid_until:x.validUntil,p_declaration_text:canonical(d)};
    // Capture/validate before the dispatch marker. No retry or follow-up write exists.
    captureArgs(PREFIX+'save',args);s.check();dispatched=true;v=await review('save',args,s);
   }
   const result=boundedOutput({...SUBSET_REVIEW_FLAGS,kind:action,read_only:action==='command',command_id:x.commandId,replayed:v.replayed,...publicReview(v)});s.check();return result;
  }catch(error){
   let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
   if(typeof code!=='string'||!/^[A-Z0-9_]{1,90}$/.test(code))code='SUBSET_REVIEW_SERVICE_UNAVAILABLE';
   throw new SubsetReviewServiceError(code,{commandId:x?.commandId??null,recoveryRequired:dispatched&&!STATES.includes(code)});
  }finally{s?.close();}
 }
 return Object.freeze({context:(input,options={})=>perform('context',input,options),save:(input,options={})=>perform('save',input,options),command:(input,options={})=>perform('command',input,options)});
}
