/** Trusted-composition adapter. This factory does NOT authenticate a session or HMAC. */
import {AuthorizationHttpError,MAX_RESPONSE_BYTES,data,need,route,scope,readBounded,parsePayload,freeze} from './protocol.mjs';
import {publicResult} from './dto.mjs';
const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const HTTP_CODES=['AUTHORIZATION_INVALID_REQUEST','AUTHORIZATION_NOT_FOUND','AUTHORIZATION_METHOD_NOT_ALLOWED','AUTHORIZATION_UNAUTHENTICATED','AUTHORIZATION_BODY_INVALID','AUTHORIZATION_BODY_TOO_LARGE','AUTHORIZATION_ENCODING_UNSUPPORTED','AUTHORIZATION_BODY_TIMEOUT','AUTHORIZATION_CONTENT_TYPE_UNSUPPORTED','AUTHORIZATION_REQUEST_UNCONFIRMED','AUTHORIZATION_RESPONSE_INVALID','AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE'];
const SQL_ERRORS={'42501':[403,'AUTHORIZATION_FORBIDDEN'],'40001':[409,'AUTHORIZATION_CONFLICT'],'55000':[409,'AUTHORIZATION_CONFLICT'],P0002:[404,'AUTHORIZATION_NOT_FOUND'],'22023':[400,'AUTHORIZATION_INVALID_REQUEST']};
const getters=Object.fromEntries(['url','method','headers','body','signal'].map(k=>[k,Object.getOwnPropertyDescriptor(Request.prototype,k).get]));
function requestSnapshot(request){
 try{
  // Use native getters, never request-owned overrides or a duck-typed request.
  need(request instanceof Request);
  const v=Object.fromEntries(Object.entries(getters).map(([k,get])=>[k,get.call(request)]));
  v.headers=new Headers(v.headers);return v;
 }catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_INVALID_REQUEST');}
}
function reply(value,status=200){
 const json=JSON.stringify(value);need(new TextEncoder().encode(json).length<=MAX_RESPONSE_BYTES,502,'AUTHORIZATION_RESPONSE_INVALID');
 return new Response(json,{status,headers:HEADERS});
}
function sanitized(error){
 // Never invoke an accessor on an arbitrary port exception, or include its text.
 let code,status;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;status=Object.getOwnPropertyDescriptor(error,'status')?.value;}catch{}
 if(error instanceof AuthorizationHttpError&&HTTP_CODES.includes(code)&&[400,401,404,405,408,413,415,502,503].includes(status))return{status,code};
 if(code==='AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE')return{status:503,code};
 if(typeof code==='string'&&Object.hasOwn(SQL_ERRORS,code)){const[status,closed]=SQL_ERRORS[code];return{status,code:closed};}
 return{status:503,code:'AUTHORIZATION_SERVICE_UNAVAILABLE'};
}
export function createAuthorizationHttpBoundary(configuration){
 const c=data(configuration,['service']),service=data(c.service,['preview','run','recover','command','history']);
 need(Object.values(service).every(fn=>typeof fn==='function'));
 // All method references are captured now; a caller cannot replace them in flight.
 return async(request,verifiedContext)=>{
  let message,s,bytes,selected,payload,commandId=null,recoverDispatched=false;
  try{
   message=requestSnapshot(request);s=scope(verifiedContext,message.signal);
   const url=new URL(message.url);need(['https:','http:'].includes(url.protocol)&&!url.search&&!url.hash&&!url.username&&!url.password);
   selected=route(url.pathname,message.method);const method=service[selected.action];
   if(selected.method==='POST')need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(message.headers.get('content-type')??''),415,'AUTHORIZATION_CONTENT_TYPE_UNSUPPORTED');
   s.check();bytes=await readBounded(message,selected.limit,s);s.check();payload=parsePayload(bytes,selected);commandId=selected.commandId??payload.command_id??null;
   // Deliberately unconditional: even a synthetic/enabled service cannot submit here.
   need(selected.action!=='run',503,'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
   let input,binding={action:selected.action};
   if(selected.action==='preview'){input={actor:s.actor,candidateId:payload.candidate_id,signedHash:payload.signed_hash};binding={...binding,candidateId:input.candidateId,signedHash:input.signedHash};}
   else if(selected.action==='history'){input={actor:s.actor,candidateId:selected.candidateId,limit:payload.limit,before:payload.before};binding={...binding,candidateId:input.candidateId,limit:input.limit,before:input.before};}
   else{input={actor:s.actor,commandId};binding={...binding,commandId};}
   freeze(input);freeze(binding);const options=Object.freeze({signal:s.signal,deadline:s.deadline});
   const value=await s.bounded(()=>{recoverDispatched=selected.action==='recover';return method(input,options);});
   s.check();const out=publicResult(value,binding);s.check();return reply(out);
  }catch(error){
   const failure=sanitized(error);return reply({error:failure.code,recovery_required:recoverDispatched,...(commandId?{command_id:commandId}:{})},failure.status);
  }finally{
   s?.close();bytes?.fill(0);try{void message?.body?.cancel().catch(()=>{});}catch{}
  }
 };
}
