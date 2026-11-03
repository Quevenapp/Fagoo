/** Runs after HMAC verification; its service has no certificate or SEFAZ transport port. */
import {AuthorizationHttpError,data,need,freeze,uuid} from '../../fiscal-authorization-http/src/protocol.mjs';
import {revalidationBinding,projectRevalidationResult,MAX_REVALIDATION_RESPONSE_BYTES} from './revalidation-protocol.mjs';
const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const SQL={'42501':[403,'AUTHORIZATION_FORBIDDEN'],'40001':[409,'AUTHORIZATION_CONFLICT'],'55000':[409,'AUTHORIZATION_CONFLICT'],P0002:[404,'AUTHORIZATION_NOT_FOUND'],'22023':[400,'AUTHORIZATION_INVALID_REQUEST']};
function reply(value,status=200){const json=JSON.stringify(value);need(new TextEncoder().encode(json).length<=MAX_REVALIDATION_RESPONSE_BYTES,502,'AUTHORIZATION_RESPONSE_INVALID');return new Response(json,{status,headers:HEADERS});}
function failure(error){
 let code,status,recovery;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;status=Object.getOwnPropertyDescriptor(error,'status')?.value;recovery=Object.getOwnPropertyDescriptor(error,'recovery_required')?.value;}catch{}
 if(Object.hasOwn(SQL,code??'')){const[status,name]=SQL[code];return{status,code:name,definitive:recovery!==true};}
 if(error instanceof AuthorizationHttpError&&code==='AUTHORIZATION_RESPONSE_INVALID'&&status===502)return{status,code,definitive:false};
 return{status:503,code:'AUTHORIZATION_SERVICE_UNAVAILABLE',definitive:false};
}
export function createRevalidationBoundary(service){
 const captured=data(service,['context','revalidate','command']);need(Object.values(captured).every(x=>typeof x==='function'),503,'AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID');
 return async(selected,payload,actor,s)=>{
  let dispatched=false;const commandId=selected.commandId??payload.command_id??null;
  try{
   need(uuid(actor),401,'AUTHORIZATION_UNAUTHENTICATED');const binding=revalidationBinding(selected,payload),method=selected.action==='revalidationContext'?'context':selected.action==='revalidationRun'?'revalidate':'command';
   const input=method==='context'?{actor,authorizationCommandId:selected.authorizationCommandId,expectedAttemptId:selected.expectedAttemptId}:method==='command'?{actor,commandId}:{actor,request:payload};
   freeze(input);const options=Object.freeze({signal:s.signal,deadline:s.deadline});
   const value=await s.bounded(()=>{dispatched=method==='revalidate';return captured[method](input,options);});s.check();
   const out=projectRevalidationResult(value,binding);s.check();return reply(out);
  }catch(error){const f=failure(error),uncertain=dispatched&&!f.definitive;return reply({error:f.code,recovery_required:uncertain,...(commandId?{command_id:commandId}:{})},uncertain&&f.status<500?503:f.status);}
 };
}
