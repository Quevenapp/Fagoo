/** DEV-only in-memory fixture. It never delegates to fetch, Storage, SQL, A1 or SEFAZ. */
import {REVIEW_FLAGS,projectReviewPublic,type ReviewContext,type ReviewResult,type ReviewSaveInput} from '../../../../packages/fiscal-authorization-runtime/src/review-dto.mjs';
import {REVIEW_PROFILE,REVIEW_PROFILE_HASH,captureReviewInput} from '../../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
import {RULE_PROFILE_V1_HASH,ruleProfileByHash} from '../../../../packages/fiscal-authorization/src/rule-profile-registry.mjs';
import {AUTHORIZATION_QA_ACTOR,authorizationQaCandidate} from './authorization-fixture.ts';

const BASE='/v1/fiscal-authorization';
const clone=<T,>(value:T):T=>structuredClone(value);
export function subsetReviewQaContext(model:'55'|'65'='55',previousProfile=false):ReviewContext {
 const c=authorizationQaCandidate(model),signedHash=c.artifact!.sha256,factsHash=(model==='55'?'b':'c').repeat(64);
 let raw:ReviewContext={...REVIEW_FLAGS,kind:'context',read_only:true,
  candidate:{candidate_id:c.candidate_id,candidate_version:c.candidate_version,model,signed_hash:signedHash,facts_hash:factsHash,profile:REVIEW_PROFILE,profile_hash:REVIEW_PROFILE_HASH},
  facts:{model,environment:'2',crt:'1',issuerUf:'SP',ide:{mod:model,tpAmb:'2',natOp:'VENDA FICTÍCIA PARA QA'},recipient:{indIEDest:model==='55'?'1':'9',ie:model==='55'?'123456789':null,uf:'SP'},items:[{position:1,itemHash:'e'.repeat(64),code:'QA-ITEM-01',ncm:'82055900',cest:null,benefit:null,cfop:model==='55'?'5102':'5101',gtin:'SEM GTIN',gtinTax:'SEM GTIN',icms:{orig:'0',CSOSN:'102'},pis:{CST:'99',vBC:'0.00',pPIS:'0.0000',vPIS:'0.00'},cofins:{CST:'99',vBC:'0.00',pCOFINS:'0.0000',vCOFINS:'0.00'},unsupported:[]}],payments:[{tPag:model==='55'?'15':'01',vPag:'100.00'}],change:null,totals:{vNF:'100.00'},transportMode:'9',additionalInformation:null,unsupported:[]},
  labels:{items:[{position:1,description:'Produto fictício · conferência da interface',unit:'UN',quantity:'1.0000',unit_price:'100.0000',product_total:'100.00'}]},
  source_current:{artifact_current:true,basis_changed:false,draft_archived:false,source_cancelled:false,a1_changed:false,is_latest_candidate:true,series_enabled:true,certificate_time_valid_now:true},
  review:{matches_profile:false,receipt:null,current:{latest_review_id:null,latest_review_version:0,is_latest:false,reviewer_active:false,within_validity:false},declaration:null},
  report:{profile:REVIEW_PROFILE,profileHash:REVIEW_PROFILE_HASH,candidateId:c.candidate_id,signedHash,factsHash,evaluatedAt:'2026-10-16T20:00:00.000Z',review:null,status:'pending_classification',invalidCombinations:[],unsupportedScope:[],pendingClassification:[{code:'BACKEND_CLASSIFICATION_REVIEW_MISSING',kind:'classification_or_evidence_pending',position:null,sources:['lc123']}],temporalPolicy:{validFrom:'2026-10-16T00:00:00-03:00',reviewBefore:'2026-10-26T00:00:00-03:00',kind:'brufap_conservative_review_boundary',officialTaxDeadline:false},coverage:REVIEW_FLAGS.coverage,taxRulesValidated:false,canEmit:false,canTransmit:false,sefazAuthorized:false,operationallyApproved:false},save_available:true,save_blockers:[]
 };
 if(previousProfile){const id=`a7700000-0000-4000-8000-0000000000${model}`,profile=ruleProfileByHash(RULE_PROFILE_V1_HASH)!;raw={...raw,review:{matches_profile:false,receipt:{review_id:id,command_id:id,review_version:2,reviewed_by:AUTHORIZATION_QA_ACTOR,reviewed_at:'2026-10-16T20:00:00.000Z',valid_until:'2026-10-25T15:00:00.000Z',candidate_id:c.candidate_id,candidate_version:c.candidate_version,signed_hash:signedHash,facts_hash:factsHash,profile:profile.profile,profile_hash:profile.profileHash,review_hash:'f'.repeat(64),coverage:REVIEW_FLAGS.coverage},current:{latest_review_id:id,latest_review_version:2,is_latest:true,reviewer_active:true,within_validity:true},declaration:{document:{operation:'internal_normal_sale',recipient_regime:'regular_icms',acquisition_purpose:'resale',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:[{position:1,classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:'reviewed_absent',st:'not_applicable',fcp:'not_applicable',credit:null}]}}};}
 return projectReviewPublic(raw,{action:'context',candidateId:c.candidate_id});
}

export function createSubsetReviewQaFixture(){
 const counts={membership:0,context:0,save:0,committed:0,command:0,lostAck:0,failedLookup:0,forbidden:0};
 const contexts=new Map((['55','65'] as const).map(model=>{const c=subsetReviewQaContext(model);return[c.candidate.candidate_id,c] as const;}));
 const saved=new Map<string,{body:ReviewSaveInput;result:ReviewResult}>(),failed=new Set<string>();
 const error=(status:number,code:string,recovery=false,command?:string)=>Response.json({error:code,recovery_required:recovery,...command?{command_id:command}:{}},{status});
 return{counts,candidate:authorizationQaCandidate,resetScenario(previousProfile:boolean){for(const model of ['55','65'] as const){const c=subsetReviewQaContext(model,previousProfile);contexts.set(c.candidate.candidate_id,c);}saved.clear();failed.clear();},async fetch(input:RequestInfo|URL,init:RequestInit={}):Promise<Response>{
  if(init.signal?.aborted)throw new DOMException('Synthetic request cancelled','AbortError');
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),method=init.method??'GET',path=url.pathname;
  if(!url.search&&!url.hash&&url.origin==='http://127.0.0.1:9011'&&path==='/v1/me'&&method==='GET'){
   counts.membership++;return Response.json({user_id:AUTHORIZATION_QA_ACTOR,role:'admin',resources:[],data_mode:'staging_readonly'});
  }
  if(url.origin!=='https://unsigned.qa.invalid'||url.search||url.hash){counts.forbidden++;throw Error('SYNTHETIC_ROUTE_REFUSED');}
  const candidateMatch=new RegExp(`^${BASE}/candidates/([a-f0-9-]+)/review$`).exec(path),current=candidateMatch?contexts.get(candidateMatch[1]):undefined;
  if(current&&method==='GET'){counts.context++;return Response.json(current);}
  if(current&&method==='POST'){
   counts.save++;let body:ReviewSaveInput;
   try{if(typeof init.body!=='string')throw Error();body=captureReviewInput(JSON.parse(init.body));}catch{return error(400,'AUTHORIZATION_INVALID_REQUEST');}
   const known=saved.get(body.command_id);
   if(known){if(JSON.stringify(body)!==JSON.stringify(known.body)||known.result.receipt.candidate_id!==current.candidate.candidate_id)return error(409,'AUTHORIZATION_CONFLICT');return Response.json({...known.result,replayed:true});}
   const c=current.candidate;
   if(body.expected_candidate_version!==c.candidate_version||body.signed_hash!==c.signed_hash||body.expected_facts_hash!==c.facts_hash||body.expected_profile_hash!==c.profile_hash||body.expected_review_version!==current.review.current.latest_review_version)return error(409,'AUTHORIZATION_CONFLICT');
   const stamp=new Date().toISOString();
   if(Date.parse(body.valid_until)<=Date.parse(stamp)||Date.parse(body.valid_until)>Date.parse(current.report.temporalPolicy.reviewBefore))return error(400,'AUTHORIZATION_INVALID_REQUEST');
   const result=projectReviewPublic({...REVIEW_FLAGS,kind:'save',read_only:false,command_id:body.command_id,replayed:false,
    receipt:{review_id:body.command_id,command_id:body.command_id,review_version:body.expected_review_version+1,reviewed_by:AUTHORIZATION_QA_ACTOR,reviewed_at:stamp,valid_until:body.valid_until,candidate_id:c.candidate_id,candidate_version:c.candidate_version,signed_hash:c.signed_hash,facts_hash:c.facts_hash,profile:c.profile,profile_hash:c.profile_hash,review_hash:'f'.repeat(64),coverage:REVIEW_FLAGS.coverage},
    current:{latest_review_id:body.command_id,latest_review_version:body.expected_review_version+1,is_latest:true,reviewer_active:true,within_validity:true},declaration:body.choices
   },{action:'save',candidateId:c.candidate_id,commandId:body.command_id,input:body});
   saved.set(body.command_id,{body,result});counts.committed++;
   // This QA only demonstrates persistence and recovery; it does not evaluate tax rules.
   const next={...clone(current),review:{matches_profile:true,receipt:clone(result.receipt),current:clone(result.current),declaration:clone(result.declaration)}};
   contexts.set(c.candidate_id,projectReviewPublic(next,{action:'context',candidateId:c.candidate_id}));
   counts.lostAck++;throw new TypeError('SYNTHETIC_REVIEW_ACK_LOST');
  }
  const commandMatch=new RegExp(`^${BASE}/review-commands/([a-f0-9-]+)$`).exec(path);
  if(commandMatch&&method==='GET'){
   counts.command++;const command=commandMatch[1],known=saved.get(command);if(!known)return error(404,'AUTHORIZATION_NOT_FOUND',false,command);
   if(!failed.has(command)){failed.add(command);counts.failedLookup++;return error(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',false,command);}
   return Response.json(projectReviewPublic({...known.result,kind:'command',read_only:true,replayed:false},{action:'command',commandId:command}));
  }
  counts.forbidden++;throw Error('SYNTHETIC_ROUTE_REFUSED');
 }};
}
