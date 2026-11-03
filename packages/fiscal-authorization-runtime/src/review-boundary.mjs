/** Called only after HMAC/body authentication. It has no fiscal execution or credential ports. */
import {AuthorizationHttpError,data,need,freeze,uuid} from '../../fiscal-authorization-http/src/protocol.mjs';
import {projectReviewPublic} from './review-dto.mjs';
import {reviewBinding,MAX_REVIEW_RESPONSE_BYTES} from './review-protocol.mjs';
const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const SQL={'42501':[403,'AUTHORIZATION_FORBIDDEN'],'40001':[409,'AUTHORIZATION_CONFLICT'],'55000':[409,'AUTHORIZATION_CONFLICT'],P0002:[404,'AUTHORIZATION_NOT_FOUND'],'22023':[400,'AUTHORIZATION_INVALID_REQUEST']};
const INVALID=['SUBSET_REVIEW_CHOICES_INVALID','SUBSET_REVIEW_CREDIT_EVIDENCE_UNAVAILABLE','SUBSET_REVIEW_EXISTING_CREDIT_READ_ONLY'];
function failure(error){
 let code,status,recovery;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;status=Object.getOwnPropertyDescriptor(error,'status')?.value;recovery=Object.getOwnPropertyDescriptor(error,'recovery_required')?.value;}catch{}
 if(Object.hasOwn(SQL,code??'')){const[status,name]=SQL[code];return{status,code:name,definitive:recovery!==true};}
 if(INVALID.includes(code))return{status:400,code:'AUTHORIZATION_INVALID_REQUEST',definitive:recovery!==true};
 if(code==='SUBSET_REVIEW_SERVICE_REQUEST_LIMIT')return{status:413,code:'AUTHORIZATION_BODY_TOO_LARGE',definitive:recovery!==true};
 if(error instanceof AuthorizationHttpError&&code==='AUTHORIZATION_RESPONSE_INVALID'&&status===502)return{status,code,definitive:false};
 return{status:503,code:'AUTHORIZATION_SERVICE_UNAVAILABLE',definitive:false};
}
function reply(value,status=200){const json=JSON.stringify(value);need(new TextEncoder().encode(json).length<=MAX_REVIEW_RESPONSE_BYTES,502,'AUTHORIZATION_RESPONSE_INVALID');return new Response(json,{status,headers:HEADERS});}
export function createReviewBoundary(service){
 const captured=data(service,['context','save','command']);need(Object.values(captured).every(x=>typeof x==='function'),503,'AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID');
 return async(selected,payload,actor,s)=>{
  let dispatched=false;const commandId=selected.commandId??payload.command_id??null;
  try{
   need(uuid(actor),401,'AUTHORIZATION_UNAUTHENTICATED');const binding=reviewBinding(selected,payload);let input;
   if(binding.action==='context')input={actor,candidateId:selected.candidateId};
   else if(binding.action==='command')input={actor,commandId};
   else input={actor,candidateId:selected.candidateId,commandId,expectedCandidateVersion:payload.expected_candidate_version,signedHash:payload.signed_hash,expectedReviewVersion:payload.expected_review_version,expectedFactsHash:payload.expected_facts_hash,expectedProfileHash:payload.expected_profile_hash,validUntil:payload.valid_until,choices:payload.choices};
   freeze(input);const options=Object.freeze({signal:s.signal,deadline:s.deadline});
   const value=await s.bounded(()=>{dispatched=binding.action==='save';return captured[binding.action](input,options);});s.check();
   const result=projectReviewPublic(value,binding);s.check();return reply(result);
  }catch(error){const f=failure(error),uncertain=dispatched&&!f.definitive;return reply({error:f.code,recovery_required:uncertain,...(commandId?{command_id:commandId}:{})},uncertain&&f.status<500?503:f.status);}
 };
}
