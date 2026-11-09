import { FagooError } from './fagoo.mjs';
const BASE='/v1/crm';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const actions=['funnel.save','opportunity.save','opportunity.move','task.save','task.complete','note.add'];
const fail=(status,code)=>{throw new FagooError(status,code);};
export const crmRoute=path=>path===BASE||path.startsWith(BASE+'/');
async function readBody(request){
 if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415,'ERP_INVALID_CONTENT_TYPE');
 if(!request.body||Number(request.headers.get('content-length'))>32768)fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>32768)fail(413,'ERP_BODY_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}const body=JSON.parse(text+decoder.decode());if(!body||Array.isArray(body)||typeof body!=='object')fail(400,'ERP_INVALID_INPUT');return body;
 }catch(error){if(error instanceof FagooError)throw error;fail(400,'ERP_INVALID_INPUT');}finally{void reader.cancel().catch(()=>{});}
}
export async function handleCrm({request,userId,deviceId,rpc}){
 if(deviceId)fail(403,'ERP_FORBIDDEN');if(!userId)fail(401,'ERP_UNAUTHENTICATED');
 const url=new URL(request.url),match=/^\/v1\/crm\/units\/([^/]+)\/(snapshot|contacts|commands|links|history)(?:\/([^/]+))?$/.exec(url.pathname);
 if(!match)fail(404,'ERP_NOT_FOUND');const [,unit,section,id]=match;if(!UUID.test(unit)||id&&!UUID.test(id))fail(400,'ERP_INVALID_INPUT');
 const args={p_user_id:userId,p_unit_id:unit};
 if(section==='links'){
  if(request.method==='GET'&&id){if(url.search)fail(400,'ERP_INVALID_QUERY');return Response.json(await rpc('fagoo_relationship_link_receipt',{...args,p_command_id:id}));}
  if(request.method==='GET'&&!id){const ticket=url.searchParams.get('ticket_id');if([...url.searchParams.keys()].some(k=>k!=='ticket_id')||url.searchParams.getAll('ticket_id').length!==1||!UUID.test(ticket??''))fail(400,'ERP_INVALID_QUERY');return Response.json(await rpc('fagoo_relationship_link_read',{...args,p_ticket_id:ticket}));}
  if(request.method==='POST'&&!id){if(url.search)fail(400,'ERP_INVALID_QUERY');const value=await readBody(request);if(Object.keys(value).some(k=>!['command_id','ticket_id','contact_id','expected_version'].includes(k))||!['command_id','ticket_id','contact_id'].every(k=>UUID.test(value[k]??''))||!Number.isSafeInteger(value.expected_version??0)||(value.expected_version??0)<0)fail(400,'ERP_INVALID_INPUT');return Response.json(await rpc('fagoo_relationship_link',{...args,p_command_id:value.command_id,p_ticket_id:value.ticket_id,p_contact_id:value.contact_id,p_expected_version:value.expected_version??0}));}
  fail(405,'ERP_METHOD_NOT_ALLOWED');
 }
 if(section==='history'){
  const contact=url.searchParams.get('contact_id');if(request.method!=='GET'||id)fail(405,'ERP_METHOD_NOT_ALLOWED');if([...url.searchParams.keys()].some(k=>k!=='contact_id')||url.searchParams.getAll('contact_id').length!==1||!UUID.test(contact??''))fail(400,'ERP_INVALID_QUERY');return Response.json(await rpc('fagoo_relationship_history',{...args,p_contact_id:contact}));
 }
 if(request.method==='GET'&&section==='commands'&&id){if(url.search)fail(400,'ERP_INVALID_QUERY');return Response.json(await rpc('fagoo_crm_receipt',{...args,p_command_id:id}));}
 if(request.method==='GET'&&!id&&['snapshot','contacts'].includes(section)){
  if([...url.searchParams.keys()].some(k=>!['query','contact_id'].includes(k))||url.searchParams.getAll('query').length>1||url.searchParams.getAll('contact_id').length>1)fail(400,'ERP_INVALID_QUERY');
  const query=url.searchParams.get('query')??'',contact=url.searchParams.get('contact_id');if(query.length>160||contact&&!UUID.test(contact))fail(400,'ERP_INVALID_QUERY');
  return Response.json(await rpc('fagoo_crm_read',{...args,p_section:section,p_query:query,p_contact_id:contact}));
 }
 if(request.method==='POST'&&section==='commands'&&!id){
  if(url.search)fail(400,'ERP_INVALID_QUERY');const body=await readBody(request);
  if(Object.keys(body).some(k=>!['command_id','action','payload'].includes(k))||!UUID.test(body.command_id??'')||!actions.includes(body.action)||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))fail(400,'ERP_INVALID_INPUT');
  return Response.json(await rpc('fagoo_crm_command',{...args,p_command_id:body.command_id,p_action:body.action,p_payload:body.payload}));
 }
 fail(405,'ERP_METHOD_NOT_ALLOWED');
}
