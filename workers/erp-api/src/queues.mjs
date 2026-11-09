import { FagooError } from './fagoo.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{22,128}$/;
const fail=(status,code)=>{throw new FagooError(status,code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fields={
 'queue.save':['id','name','prefix','priority','regulars_per_priority','active'],
 'config.save':['template','functions','ratings_enabled','media_enabled','call_ttl_seconds','title','footer'],
 'device.panel':['device_id','template','volume','muted'],
 'campaign.save':['id','title','media_url','media_type','sha256','starts_at','expires_at','duration_seconds','priority','surfaces','active'],
 'ticket.issue':['queue_id','priority','phone','print','print_device_id'],
 'ticket.call_next':['desk','queue_ids'],
 'ticket.recall':['ticket_id'],'ticket.start':['ticket_id'],'ticket.complete':['ticket_id'],
 'ticket.absent':['ticket_id','reason'],'ticket.cancel':['ticket_id','reason'],
 'ticket.transfer':['ticket_id','queue_id','desk'],'rating.request':['ticket_id'],
 'print.reprint':['ticket_id','print_device_id','confirmed'],
 'order.create':['code'],'order.transition':['order_id','status'],
};
export const queuesRoute=path=>path==='/v1/queues'||path.startsWith('/v1/queues/')||/^\/v1\/s\/[^/]+\/(estado|nota|push)$/.test(path);
export const queuesPublicRoute=path=>/^\/v1\/queues\/public\/[A-Za-z0-9_-]{22,128}(?:\/(rating|push))?$/.test(path)||/^\/v1\/s\/[^/]+\/(estado|nota|push)$/.test(path);
async function body(request){
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))fail(415,'ERP_INVALID_CONTENT_TYPE');
 if(!request.body||Number(request.headers.get('content-length'))>24576)fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>24576)fail(413,'ERP_BODY_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}const value=JSON.parse(text+decoder.decode());if(!object(value))fail(400,'ERP_INVALID_INPUT');return value;}
 catch(e){if(e instanceof FagooError)throw e;fail(400,'ERP_INVALID_INPUT');}finally{void reader.cancel().catch(()=>{});}
}
function keys(value,allowed){if(Object.keys(value).some(k=>!allowed.includes(k)))fail(400,'ERP_INVALID_INPUT');}
function command(value,device){
 keys(value,['command_id','type','payload','expected_version']);
 if(!UUID.test(value.command_id??'')||!Object.hasOwn(fields,value.type)||!object(value.payload)||value.expected_version!=null&&!integer(value.expected_version,1))fail(400,'ERP_INVALID_INPUT');
 if(device&&!['ticket.issue','print.reprint'].includes(value.type))fail(403,'ERP_FORBIDDEN');
 const p=value.payload;keys(p,fields[value.type]);
 for(const[k,v]of Object.entries(p)){
  if(['id','queue_id','ticket_id','order_id','print_device_id','device_id'].includes(k)&&!UUID.test(v??''))fail(400,'ERP_INVALID_INPUT');
  if(['priority','print','active','confirmed','ratings_enabled','media_enabled','muted'].includes(k)&&k==='priority'&&['queue.save','campaign.save'].includes(value.type)){if(!integer(v,-1000,1000))fail(400,'ERP_INVALID_INPUT');}
  else if(['priority','print','active','confirmed','ratings_enabled','media_enabled','muted'].includes(k)&&typeof v!=='boolean')fail(400,'ERP_INVALID_INPUT');
  if(['regulars_per_priority','call_ttl_seconds','duration_seconds'].includes(k)&&!integer(v,0,3600))fail(400,'ERP_INVALID_INPUT');
  if(['name','prefix','phone','desk','reason','code','title','footer','media_url','media_type','sha256','starts_at','expires_at','template','status'].includes(k)&&(typeof v!=='string'||v.length>2048||/[\u0000-\u001f]/.test(v)))fail(400,'ERP_INVALID_INPUT');
  if(['queue_ids','functions','surfaces'].includes(k)&&(!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=='string'||x.length>80)))fail(400,'ERP_INVALID_INPUT');
  if(k==='queue_ids'&&v.some(x=>!UUID.test(x)))fail(400,'ERP_INVALID_INPUT');
  if(k==='volume'&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1))fail(400,'ERP_INVALID_INPUT');
 }
 return value;
}
function response(value,status=200){return Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
function trackingUrl(env,token){
 if(!env.FAGOO_WEB_ORIGIN||!TOKEN.test(token??''))return undefined;
 let origin;try{origin=new URL(env.FAGOO_WEB_ORIGIN);}catch{fail(503,'ERP_PUBLIC_ORIGIN_INVALID');}
 if(origin.protocol!=='https:'||origin.origin!==env.FAGOO_WEB_ORIGIN||origin.username||origin.password)fail(503,'ERP_PUBLIC_ORIGIN_INVALID');
 return origin.origin+'/senha/'+token;
}
function receiptTracking(env,value){const ticket=(value?.response??value)?.result?.ticket;if(ticket?.public_token){const url=trackingUrl(env,ticket.public_token);if(url)ticket.tracking_url=url;}return value;}
export async function handleQueues({request,env={},userId=null,deviceId=null,rpc}){
 const url=new URL(request.url),publicMatch=/^\/v1\/queues\/public\/([^/]+)(?:\/(rating|push))?$/.exec(url.pathname);
 const legacy=/^\/v1\/s\/([^/]+)\/(estado|nota|push)$/.exec(url.pathname);
 if(legacy){
  const[,token,action]=legacy;if(!TOKEN.test(token))return response({v:1,estado:'indisponivel'},404);
  if(url.search)fail(400,'ERP_INVALID_QUERY');
  if(action==='estado'&&request.method==='GET'){
   const s=await rpc('fagoo_queue_public',{p_token:token});if(!s)return response({v:1,estado:'indisponivel'},404);
   return response({v:1,senha:s.ticket.display_number,fila:s.queue,loja:s.unit,estado:s.ticket.status,guiche:s.ticket.desk,chamada_em:s.ticket.called_at,encerrada:['concluida','ausente','cancelada'].includes(s.ticket.status),ultima_noticia_em:s.server_time,desatualizado:false,nota:s.rating?{convite_aberto:true,respondida:false,expira_em:s.rating.expires_at}:null,intervalo_consulta_s:2});
  }
  if(action==='push'&&request.method==='POST'){const b=await body(request);keys(b,['plataforma','token_push']);if(!['fcm','apns'].includes(b.plataforma)||typeof b.token_push!=='string'||b.token_push.length<8||b.token_push.length>4096)fail(400,'ERP_INVALID_INPUT');const r=await rpc('fagoo_queue_push_subscribe',{p_token:token,p_platform:b.plataforma,p_push_token:b.token_push});return response({ok:true,inscricao:r.status==='active'?'ativa':'desnecessaria'});}
  if(action==='nota'&&request.method==='POST'){const b=await body(request);keys(b,['estrelas','comentario','origem']);if(!integer(b.estrelas,1,5)||b.comentario!=null&&(typeof b.comentario!=='string'||b.comentario.length>500)||b.origem!=null&&!['app','web'].includes(b.origem))fail(400,'ERP_INVALID_INPUT');const s=await rpc('fagoo_queue_public',{p_token:token});if(!s?.rating)return response({ok:false,resultado:'sem_convite'},409);await rpc('fagoo_queue_public_rating',{p_token:token,p_invite_id:s.rating.invite_id,p_stars:b.estrelas,p_comment:b.comentario??null});return response({ok:true,resultado:'registrada'},201);}
  fail(405,'ERP_METHOD_NOT_ALLOWED');
 }
 if(publicMatch){
  if(!TOKEN.test(publicMatch[1])||url.search)fail(400,'ERP_INVALID_INPUT');
  if(request.method==='GET'&&!publicMatch[2]){const result=await rpc('fagoo_queue_public',{p_token:publicMatch[1]});if(!result)fail(404,'ERP_NOT_FOUND');return response(result);}
  if(request.method==='POST'&&publicMatch[2]==='rating'){const b=await body(request);keys(b,['invite_id','stars','comment']);if(!UUID.test(b.invite_id??'')||!integer(b.stars,1,5)||b.comment!=null&&(typeof b.comment!=='string'||b.comment.length>500))fail(400,'ERP_INVALID_INPUT');return response(await rpc('fagoo_queue_public_rating',{p_token:publicMatch[1],p_invite_id:b.invite_id,p_stars:b.stars,p_comment:b.comment??null}));}
  if(request.method==='POST'&&publicMatch[2]==='push'){const b=await body(request);keys(b,['platform','push_token']);if(!['fcm','apns'].includes(b.platform)||typeof b.push_token!=='string'||b.push_token.length<8||b.push_token.length>4096)fail(400,'ERP_INVALID_INPUT');return response(await rpc('fagoo_queue_push_subscribe',{p_token:publicMatch[1],p_platform:b.platform,p_push_token:b.push_token}));}
  fail(405,'ERP_METHOD_NOT_ALLOWED');
 }
 if(!userId&&!deviceId)fail(401,'ERP_UNAUTHENTICATED');
 const match=/^\/v1\/queues\/units\/([^/]+)\/(snapshot|events|history|commands|receipts|effects)(?:\/([^/]+))?$/.exec(url.pathname);
 if(!match)fail(404,'ERP_NOT_FOUND');const[,unit,section,id]=match;if(!UUID.test(unit))fail(400,'ERP_INVALID_INPUT');
 const args={p_user_id:userId,p_device_id:deviceId,p_unit_id:unit};
 if(request.method==='GET'&&section==='snapshot'&&!id){if(url.search)fail(400,'ERP_INVALID_QUERY');return response(await rpc('fagoo_queue_snapshot',args));}
 if(request.method==='GET'&&['events','history'].includes(section)&&!id){
  if([...url.searchParams.keys()].some(k=>k!==(section==='events'?'after':'before'))||[...url.searchParams.values()].length>1)fail(400,'ERP_INVALID_QUERY');
  if(section==='history'){if(deviceId)fail(403,'ERP_FORBIDDEN');const before=url.searchParams.get('before');if(before&&!UUID.test(before))fail(400,'ERP_INVALID_QUERY');return response(await rpc('fagoo_queue_history',{...args,p_before:before}));}
  const raw=url.searchParams.get('after')??'0';if(!/^\d{1,15}$/.test(raw))fail(400,'ERP_INVALID_QUERY');return response(await rpc('fagoo_queue_events',{...args,p_after:Number(raw)}));
 }
 if(url.search)fail(400,'ERP_INVALID_QUERY');
 if(request.method==='GET'&&section==='receipts'&&UUID.test(id??''))return response(receiptTracking(env,await rpc('fagoo_queue_receipt',{...args,p_command_id:id})));
 if(request.method==='POST'&&section==='receipts'&&UUID.test(id??'')){const b=await body(request);keys(b,['cancel']);if(b.cancel!==true)fail(400,'ERP_INVALID_INPUT');return response(receiptTracking(env,await rpc('fagoo_queue_cancel_unconfirmed',{...args,p_command_id:id})));}
 if(request.method==='POST'&&section==='commands'&&!id){const b=command(await body(request),deviceId);return response(receiptTracking(env,await rpc('fagoo_queue_command',{...args,p_command_id:b.command_id,p_type:b.type,p_payload:b.payload,p_expected_version:b.expected_version??null})));}
 if(request.method==='POST'&&section==='effects'){
  if(!deviceId)fail(403,'ERP_FORBIDDEN');const b=await body(request);
  if(id==='claim'){keys(b,['kind','claim_id','after_revision']);if(!['audio','print'].includes(b.kind)||!UUID.test(b.claim_id??'')||!integer(b.after_revision??0))fail(400,'ERP_INVALID_INPUT');const result=await rpc('fagoo_queue_effect_claim',{...args,p_kind:b.kind,p_claim_id:b.claim_id,p_after_revision:b.after_revision??0});
   if(b.kind==='print')for(const job of result.jobs??[]){const url=trackingUrl(env,job.payload?.public_token);if(url)job.payload.tracking_url=url;}
   return response(result);}
  if(id==='ack'){keys(b,['job_id','claim_id','result']);if(!UUID.test(b.job_id??'')||!UUID.test(b.claim_id??'')||!['impresso','played','falhou','incerto','skipped'].includes(b.result))fail(400,'ERP_INVALID_INPUT');return response(await rpc('fagoo_queue_effect_ack',{...args,p_job_id:b.job_id,p_claim_id:b.claim_id,p_result:b.result}));}
 }
 fail(405,'ERP_METHOD_NOT_ALLOWED');
}
