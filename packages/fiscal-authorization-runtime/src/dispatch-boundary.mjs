/** Invoked only after HMAC/body authentication. Distinct from legacy064/read-only routes. */
import {AuthorizationHttpError,data,need,freeze,uuid} from '../../fiscal-authorization-http/src/protocol.mjs';
import {FLAGS,projectDispatchPublic} from './dispatch-public-dto.mjs';
import {DISPATCH_PROFILE,dispatchBinding,isDispatchMutation,MAX_DISPATCH_RESPONSE_BYTES} from './dispatch-protocol.mjs';
const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const SQL={'42501':[403,'AUTHORIZATION_FORBIDDEN'],'40001':[409,'AUTHORIZATION_CONFLICT'],'55000':[409,'AUTHORIZATION_CONFLICT'],P0002:[404,'AUTHORIZATION_NOT_FOUND'],'22023':[400,'AUTHORIZATION_INVALID_REQUEST']};
function reply(value,status=200){const text=JSON.stringify(value);need(new TextEncoder().encode(text).length<=MAX_DISPATCH_RESPONSE_BYTES,502,'AUTHORIZATION_RESPONSE_INVALID');return new Response(text,{status,headers:HEADERS});}
function failure(e){
 let code,status;try{code=Object.getOwnPropertyDescriptor(e,'code')?.value;status=Object.getOwnPropertyDescriptor(e,'status')?.value;}catch{}
 if(['AUTHORIZATION_NFCE_EMISSION_EXPIRED','AUTHORIZATION_NFCE_EMISSION_FUTURE','AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT'].includes(code))return{status:409,code,definitive:true};
 if(code==='AUTHORIZATION_SERVICE_DISABLED')return{status:503,code,definitive:true};
 if(Object.hasOwn(SQL,code??'')){const[status,name]=SQL[code];return{status,code:name,definitive:true};}
 if(e instanceof AuthorizationHttpError&&['AUTHORIZATION_FORBIDDEN','AUTHORIZATION_RESPONSE_INVALID','AUTHORIZATION_SERVICE_UNAVAILABLE'].includes(code))return{status,code,definitive:code==='AUTHORIZATION_FORBIDDEN'};
 return{status:503,code:'AUTHORIZATION_SERVICE_UNAVAILABLE',definitive:false};
}
export function createDispatchBoundary(configuration){
 const p=data(configuration,['service','readAccess'],['enabled']),service=data(p.service,['run','recover','command','history'],['runReviewed','preflight','closeExpired','closureCommand','closureLookup']);
 need(Object.values(service).every(x=>typeof x==='function')&&typeof p.readAccess==='function'&&(p.enabled===undefined||typeof p.enabled==='boolean'),503,'AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID');
 const enabled=p.enabled===true,readAccess=p.readAccess;
 return async(selected,payload,actor,s)=>{
  let dispatched=false;const commandId=selected.commandId??payload.command_id??null;
  try{
   need(uuid(actor),401,'AUTHORIZATION_UNAUTHENTICATED');const binding=dispatchBinding(selected,payload),options=Object.freeze({signal:s.signal,deadline:s.deadline});
   if(binding.action==='run'&&!enabled)return reply({error:'AUTHORIZATION_SERVICE_DISABLED',recovery_required:false,command_id:commandId},503);
   if(binding.action==='status'){
    const access=data(await s.bounded(()=>readAccess(actor,options)),['actor','role'],[],503,'AUTHORIZATION_SERVICE_UNAVAILABLE');s.check();need(access.actor===actor&&['admin','fiscal'].includes(access.role),403,'AUTHORIZATION_FORBIDDEN');
    return reply(projectDispatchPublic({...FLAGS,tax_rules_validated:false,dispatch_profile:DISPATCH_PROFILE,read_only:true,runtime_enabled:enabled,policy_checked:false},binding));
   }
   const input=binding.action==='closureLookup'?{actor,authorizationCommandId:selected.authorizationCommandId,expectedAttemptId:selected.expectedAttemptId}:binding.action==='preflight'?{actor,candidateId:payload.candidate_id,signedHash:payload.signed_hash}:binding.action==='history'?{actor,candidateId:selected.candidateId,limit:payload.limit,before:payload.before}:['run','closeExpired'].includes(binding.action)?{actor,request:payload}:{actor,commandId};freeze(input);
   const method=binding.action==='run'?'runReviewed':binding.action;need(typeof service[method]==='function',503,'AUTHORIZATION_SERVICE_UNAVAILABLE');
   const value=await s.bounded(()=>{dispatched=isDispatchMutation(selected.action);return service[method](input,options);});s.check();const out=projectDispatchPublic(value,binding);s.check();return reply(out);
  }catch(error){const f=failure(error),uncertain=dispatched&&!f.definitive;return reply({error:f.code,recovery_required:uncertain,...(commandId?{command_id:commandId}:{})},uncertain&&f.status<500?503:f.status);}
 };
}
