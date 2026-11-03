import {createDispatchBoundary} from './dispatch-boundary.mjs';
/** Authenticate internal bytes before delegating to the read-only HTTP boundary. */
import {createReviewBoundary} from './review-boundary.mjs';
import {createRevalidationBoundary} from './revalidation-boundary.mjs';
import {createReceiptQueryBoundary} from './receipt-query-boundary.mjs';
import {isMutationAction} from './review-protocol.mjs';
import {createAuthorizationHttpBoundary} from '../../fiscal-authorization-http/src/handler.mjs';
import {AuthorizationRuntimeError,ERROR_CODES,need,route,parsePayload,readBounded,requestScope,captureRequest,PUBLIC_PREFIX,INTERNAL_PREFIX} from './protocol.mjs';
import {data} from '../../fiscal-authorization-http/src/protocol.mjs';
import {digest,verifyRuntimeRequest} from './auth.mjs';
const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
export function createAuthorizationRuntimeHandler(configuration){
 const {service,reviewService,revalidationService,receiptQueryService,dispatch,transportSecret,transportKeyId,audience,now=Date.now}=data(configuration,['service','transportSecret','transportKeyId','audience'],['now','reviewService','dispatch','revalidationService','receiptQueryService']);
 need(transportSecret instanceof Uint8Array&&transportSecret.buffer instanceof ArrayBuffer&&transportSecret.length===32&&typeof transportKeyId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(transportKeyId)&&typeof audience==='string'&&/^[A-Za-z0-9_-]{1,64}-authorization$/.test(audience)&&typeof now==='function',503,'AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID');
 const reviewed=dispatch===undefined?null:createDispatchBoundary(dispatch);
 const revalidation=revalidationService===undefined?null:createRevalidationBoundary(revalidationService);
 const receiptQuery=receiptQueryService===undefined?null:createReceiptQueryBoundary(receiptQueryService);
 const boundary=createAuthorizationHttpBoundary({service}),review=reviewService===undefined?null:createReviewBoundary(reviewService),secret=new Uint8Array(transportSecret),stops=new Set();let disposed=false,active=0;
 const handler=async request=>{
  let bytes,total,selected,message,commandId=null,forwarded=false,admitted=false;
  try{
   need(!disposed,503,'AUTHORIZATION_RUNTIME_FAILED');message=captureRequest(request);
   const url=new URL(message.url);need(url.origin==='http://runtime.internal'&&!url.search&&!url.hash&&!url.username&&!url.password,400,'AUTHORIZATION_INVALID_REQUEST');
   selected=route(url.pathname,message.method);const header=message.headers.get('authorization'),contentType=message.headers.get('content-type');
   total=requestScope(message.signal,Date.now()+45000);stops.add(total.stop);
   const claims=await total.bounded(()=>verifyRuntimeRequest({header,secretBytes:secret,keyId:transportKeyId,audience,method:selected.method,path:selected.path,now:now()}));
   total.check();need(!disposed,503,'AUTHORIZATION_RUNTIME_FAILED');need(active<2,503,'AUTHORIZATION_RUNTIME_BUSY');active++;admitted=true;
   if(selected.method==='POST')need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType??''),415,'AUTHORIZATION_CONTENT_TYPE_UNSUPPORTED');
   bytes=await readBounded(message,{limit:selected.limit,signal:total.signal,deadline:Math.min(total.deadline,Date.now()+10000)});
   need(await total.bounded(()=>digest(bytes))===claims.body_hash,401,'AUTHORIZATION_BODY_AUTHENTICATION_FAILED');total.check();
   const payload=parsePayload(bytes,selected);commandId=selected.commandId??payload.command_id??null;
   if(selected.receiptQuery){need(receiptQuery!==null,503,'AUTHORIZATION_SERVICE_UNAVAILABLE');forwarded=true;return await total.bounded(()=>receiptQuery(selected,payload,claims.actor,total));}
   if(selected.revalidation){need(revalidation!==null,503,'AUTHORIZATION_SERVICE_UNAVAILABLE');forwarded=true;return await total.bounded(()=>revalidation(selected,payload,claims.actor,total));}
   if(selected.dispatch){need(reviewed!==null,503,'AUTHORIZATION_SERVICE_UNAVAILABLE');forwarded=true;return await total.bounded(()=>reviewed(selected,payload,claims.actor,total));}
   if(selected.review){need(review!==null,503,'AUTHORIZATION_SERVICE_UNAVAILABLE');forwarded=true;return await total.bounded(()=>review(selected,payload,claims.actor,total));}
   const path=PUBLIC_PREFIX+url.pathname.slice(INTERNAL_PREFIX.length),inner=new Request('http://runtime.internal'+path,{method:selected.method,headers:selected.method==='POST'?{'Content-Type':'application/json'}:{},...(selected.method==='POST'?{body:bytes}:{}),signal:total.signal});
   forwarded=true;return await total.bounded(()=>boundary(inner,{actor:claims.actor,signal:total.signal,deadline:total.deadline}));
  }catch(error){
   const known=error instanceof AuthorizationRuntimeError&&ERROR_CODES.includes(error.code),status=known?error.status:503;
   return Response.json({error:known?error.code:'AUTHORIZATION_RUNTIME_FAILED',recovery_required:forwarded&&isMutationAction(selected?.action),...(commandId?{command_id:commandId}:{})},{status,headers});
  }finally{if(total){stops.delete(total.stop);total.close();}bytes?.fill(0);try{void message?.body?.cancel().catch(()=>{});}catch{}if(admitted)active--;}
 };
 handler.dispose=()=>{if(disposed)return;disposed=true;secret.fill(0);for(const stop of stops)stop();stops.clear();};return handler;
}
