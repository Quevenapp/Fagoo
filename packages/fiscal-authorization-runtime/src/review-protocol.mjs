import {isDispatchMutation,dispatchMutationPath} from './dispatch-protocol.mjs';
import {isRevalidationMutation,revalidationMutationPath} from './revalidation-protocol.mjs';
import {isReceiptQueryMutation,receiptQueryMutationPath} from './receipt-query-protocol.mjs';
/** Web-safe review-only syntax. No actor, item hashes, schema attestations or fiscal grant in browser input. */
import {data,need,uuid,hash,version,freeze,timestamp,AuthorizationHttpError} from '../../fiscal-authorization-http/src/protocol.mjs';
import {CURRENT_RULE_PROFILE_HASH,ruleProfileByHash} from '../../fiscal-authorization/src/rule-profile-registry.mjs';
export const MAX_REVIEW_REQUEST_BYTES=147456,MAX_REVIEW_RESPONSE_BYTES=1048576;
export const REVIEW_PROFILE=ruleProfileByHash(CURRENT_RULE_PROFILE_HASH).profile;
export const REVIEW_PROFILE_HASH=CURRENT_RULE_PROFILE_HASH;
const enums={operation:['internal_normal_sale','outside_scope','unreviewed'],recipient_regime:['regular_icms','simples','noncontributor','unreviewed'],acquisition_purpose:['resale','industrialization','final_consumption','unreviewed'],payment:['matches_signed_document','unreviewed'],excluded_groups:['not_applicable','applies','unreviewed'],classification:['reviewed_physical_goods','outside_scope','unreviewed'],benefit:['not_applicable','applies','unreviewed'],pis_cofins:['normal_unified_simples','other','unreviewed'],gtin:['reviewed_absent','reviewed_identifiers','unreviewed'],st:['documented_prior_retention','not_applicable','unreviewed'],fcp:['documented_prior_retention','not_applicable','unreviewed']};
export function reviewChoices(input){
 const value=data(input,['document','items']),document=data(value.document,['operation','recipient_regime','acquisition_purpose','payment','excluded_groups']);
 for(const[k,v]of Object.entries(document))need(enums[k].includes(v));
 need(Array.isArray(value.items)&&value.items.length>=1&&value.items.length<=250);const ds=Object.getOwnPropertyDescriptors(value.items);need(Reflect.ownKeys(ds).length===value.items.length+1);
 const items=Array.from({length:value.items.length},(_,i)=>{const descriptor=ds[String(i)];need(descriptor?.enumerable&&Object.hasOwn(descriptor,'value'));const item=data(descriptor.value,['position','classification','benefit','pis_cofins','gtin','st','fcp','credit']);need(item.position===i+1&&item.credit===null);for(const k of ['classification','benefit','pis_cofins','gtin','st','fcp'])need(enums[k].includes(item[k]));return item;});
 return freeze({document,items});
}
export function reviewRoute(path,method,prefix){
 const candidate=new RegExp('^'+prefix+'/candidates/([^/]+)/review$').exec(path),command=new RegExp('^'+prefix+'/review-commands/([^/]+)$').exec(path);
 if(!candidate&&!command)return null;
 need(uuid((candidate??command)[1]),404,'AUTHORIZATION_NOT_FOUND');
 need(candidate?['GET','POST'].includes(method):method==='GET',405,'AUTHORIZATION_METHOD_NOT_ALLOWED');
 return Object.freeze({action:candidate?(method==='POST'?'reviewSave':'reviewContext'):'reviewCommand',path,method,review:true,...(candidate?{candidateId:candidate[1]}:{commandId:command[1]}),limit:method==='POST'?MAX_REVIEW_REQUEST_BYTES:0,responseLimit:MAX_REVIEW_RESPONSE_BYTES});
}
export function captureReviewInput(input){
 const p=data(input,['command_id','expected_candidate_version','signed_hash','expected_review_version','expected_facts_hash','expected_profile_hash','valid_until','choices']);
 need(uuid(p.command_id)&&version(p.expected_candidate_version)&&hash(p.signed_hash)&&version(p.expected_review_version,0)&&p.expected_review_version<2147483647&&hash(p.expected_facts_hash)&&ruleProfileByHash(p.expected_profile_hash)!==null&&timestamp(p.valid_until)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.valid_until)&&new Date(p.valid_until).toISOString()===p.valid_until);
 p.choices=reviewChoices(p.choices);return freeze(p);
}
export function parseReviewPayload(bytes,selected){
 need(bytes instanceof Uint8Array&&bytes.buffer instanceof ArrayBuffer&&bytes.length<=selected.limit);
 if(selected.method==='GET'){need(bytes.length===0);return Object.freeze({});}
 let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
 return captureReviewInput(raw);
}
export const reviewBinding=(selected,payload)=>selected.action==='reviewContext'?{action:'context',candidateId:selected.candidateId}:selected.action==='reviewCommand'?{action:'command',commandId:selected.commandId}:{action:'save',candidateId:selected.candidateId,commandId:payload.command_id,input:payload};
export const isMutationAction=action=>isReceiptQueryMutation(action)||isRevalidationMutation(action)||isDispatchMutation(action)||action==='recover'||action==='reviewSave';
/** Only for conservative error recovery; this does not admit or authenticate a route. */
export const mutationPath=(path,method)=>receiptQueryMutationPath(path,method)||revalidationMutationPath(path,method)||dispatchMutationPath(path,method)||method==='POST'&&(path==='/internal/v1/fiscal-authorization/recover'||/^\/internal\/v1\/fiscal-authorization\/candidates\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/review$/.test(path));
