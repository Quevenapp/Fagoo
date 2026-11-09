const BASE='/v1/fagoo';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const fagooRoute=path=>path===BASE||path.startsWith(BASE+'/');
export class FagooError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status,code)=>{throw new FagooError(status,code);};
export async function sha256(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
async function body(request){
 if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415,'ERP_INVALID_CONTENT_TYPE');
 if(Number(request.headers.get('content-length'))>70000)fail(413,'ERP_BODY_TOO_LARGE');
 if(!request.body)fail(400,'ERP_INVALID_INPUT');
 const reader=request.body.getReader();let length=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>70000)fail(413,'ERP_BODY_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();
  const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'ERP_INVALID_INPUT');return value;
 }catch(error){if(error instanceof FagooError)throw error;fail(400,'ERP_INVALID_INPUT');}finally{void reader.cancel().catch(()=>{});}
}
export async function handleFagoo({request,userId,deviceId,rpc,context}){
 const url=new URL(request.url),path=url.pathname;
 if(url.search)fail(400,'ERP_INVALID_QUERY');
 if(deviceId){if(path===BASE+'/device'&&request.method==='GET')return Response.json(context);fail(403,'ERP_FORBIDDEN');}
 if(!userId)fail(401,'ERP_UNAUTHENTICATED');
 if(path===BASE+'/context'&&request.method==='GET')return Response.json(context??await rpc('fagoo_context',{p_user_id:userId}));
 if(path===BASE+'/setup'&&request.method==='GET')return Response.json(await rpc('fagoo_setup',{p_user_id:userId}));
 const receipt=new RegExp('^'+BASE+'/commands/([a-f0-9-]+)$','i').exec(path);
 if(receipt&&request.method==='GET'){
  if(!UUID.test(receipt[1]))fail(400,'ERP_INVALID_INPUT');
  return Response.json(await rpc('fagoo_command_receipt',{p_user_id:userId,p_command_id:receipt[1]}));
 }
 if(path===BASE+'/device/exit'&&request.method==='POST'){
  const value=await body(request);if(!UUID.test(value.device_id??''))fail(400,'ERP_INVALID_INPUT');
  return Response.json(await rpc('fagoo_device_exit',{p_user_id:userId,p_device_id:value.device_id}));
 }
 if(path===BASE+'/commands'&&request.method==='POST'){
  const value=await body(request);
  if(!UUID.test(value.command_id??'')||!['unit.save','member.save','device.save','device.issue'].includes(value.action)||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload)||Object.keys(value).some(k=>!['command_id','action','payload'].includes(k)))fail(400,'ERP_INVALID_INPUT');
  if(Object.hasOwn(value.payload,'token_hash'))fail(400,'ERP_INVALID_INPUT');
  let token;
  if(value.action==='device.issue'){
   token='fgd_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
   value.payload.token_hash=await sha256(token);
  }
  const result=await rpc('fagoo_command',{p_user_id:userId,p_command_id:value.command_id,p_action:value.action,p_payload:value.payload});
  // Never persist the bearer secret in a command receipt, audit or database. After an uncertain issue, explicitly rotate.
  return Response.json({...result,...(token?result.replayed?{rotation_required:true}:{token}:{} )});
 }
 fail(404,'ERP_NOT_FOUND');
}

/** Shared boundary; caller authenticates against Fagoo Auth and the real MFA/access gate. */
export async function handleFagooBoundary({request,env,settings,authenticate,rpc,route,publicRoute=false}){
 const headers=new Headers({'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
 const origin=request.headers.get('Origin'),methods=['GET','POST','PUT','PATCH','DELETE'];
 try{
  if(origin!==null){if(!settings.origins.includes(origin))fail(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
  if(request.method==='OPTIONS'){
   const requested=(request.headers.get('Access-Control-Request-Headers')??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
   if(!origin||!methods.includes(request.headers.get('Access-Control-Request-Method'))||requested.some(h=>!['authorization','content-type','if-none-match','idempotency-key'].includes(h)))fail(403,'ERP_PREFLIGHT_DENIED');
   headers.set('Access-Control-Allow-Methods',methods.join(', '));headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, If-None-Match, Idempotency-Key');return new Response(null,{status:204,headers});
  }
  if(!methods.includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
  let userId=null,deviceId=null,context=null;
  if(!publicRoute){
   const auth=request.headers.get('Authorization')??'',device=/^FagooDevice (fgd_[a-f0-9]{64})$/.exec(auth),path=new URL(request.url).pathname;
   if(device){
    if(!(path.startsWith('/v1/queues/')||path==='/v1/fagoo/device'))fail(403,'ERP_FORBIDDEN');
    context=await rpc('fagoo_device_auth',{p_token_hash:await sha256(device[1])});
    if(!context||!UUID.test(context.id??'')||context.mode!=='panel')fail(403,'ERP_FORBIDDEN');
    deviceId=context.id;
   }else{
    const token=/^Bearer ([^\s]+)$/.exec(auth)?.[1];if(!token||token.length>8192)fail(401,'ERP_UNAUTHENTICATED');
    userId=await authenticate(token);
    context=await rpc('fagoo_context',{p_user_id:userId});
    if(context?.user_id!==userId||!Array.isArray(context.units))fail(403,'ERP_FORBIDDEN');
   }
  }
  const response=await route({request,env,userId,deviceId,rpc,context});
  if(!(response instanceof Response))fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
  const combined=new Headers(response.headers);headers.forEach((v,k)=>combined.set(k,v));combined.set('Access-Control-Expose-Headers','ETag');
  return new Response(response.body,{status:response.status,headers:combined});
 }catch(error){
  // Only controlled HTTP errors escape; database details and secrets are never exposed.
  const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500;
  const code=/^ERP_[A-Z0-9_]+$/.test(error?.code??'')?error.code:status===500?'ERP_INTERNAL_ERROR':'ERP_REQUEST_FAILED';
  return Response.json({error:{code}},{status,headers});
 }
}
