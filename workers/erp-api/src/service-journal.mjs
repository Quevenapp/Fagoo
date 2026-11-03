const PREFIX='/v1/ordens-servico',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,SEQUENCE=/^[1-9][0-9]{0,9}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=v=>typeof v==='string'&&UUID.test(v);
const version=v=>Number.isInteger(v)&&v>0&&v<=2147483647;
export class ServiceJournalError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new ServiceJournalError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
export const serviceJournalMethods=path=>path.startsWith(`${PREFIX}/`)&&path.includes('/diario')?path.endsWith('/diario')?['GET','POST']:['GET']:null;
const clean=v=>typeof v==='string'?v.replace(/^ +| +$/g,''):null;
const validText=v=>typeof v==='string'&&[...v].length<=4000&&/[^ \t\r\n]/.test(v)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body)fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))fail();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='',timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new ServiceJournalError(408,'ERP_REQUEST_TIMEOUT'));},10000);});
 try{for(;;){const{done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>32768)fail();text+=decoder.decode(value,{stream:true});}text+=decoder.decode();const value=JSON.parse(text);if(!object(value))fail();return value;}
 catch(error){if(error instanceof ServiceJournalError)throw error;fail();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function parseServiceJournalRoute(request){
 const url=new URL(request.url);if(!serviceJournalMethods(url.pathname))return null;
 const match=/^\/v1\/ordens-servico\/([a-fA-F0-9-]+)\/diario(?:\/([a-fA-F0-9-]+))?$/.exec(url.pathname);
 if(!match||!UUID.test(match[1])||(match[2]&&!UUID.test(match[2])))fail(404,'ERP_NOT_FOUND');
 if(!['GET','POST'].includes(request.method)||(match[2]&&request.method!=='GET'))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.headers.has('Content-Encoding')&&request.headers.get('Content-Encoding')!=='identity')fail();
 const args={p_document_id:match[1].toLowerCase()};
 if(request.method==='GET'){
  if(match[2]){if(url.searchParams.size)fail();return{type:'get',rpc:'erp_service_journal_get',args:{...args,p_entry_id:match[2].toLowerCase()}};}
  for(const key of url.searchParams.keys())if(!['limit','before'].includes(key)||url.searchParams.getAll(key).length!==1)fail();
  const limit=url.searchParams.get('limit')??'25',before=url.searchParams.get('before');
  if(!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(before!==null&&!SEQUENCE.test(before)))fail();
  return{type:'list',rpc:'erp_service_journal_list',args:{...args,p_limit:Number(limit),p_before:before}};
 }
 if(url.searchParams.size)fail();const input=await body(request);
 if(Object.keys(input).some(k=>!['command_id','expected_document_version','text'].includes(k))||!uuid(input.command_id)||!version(input.expected_document_version)||!validText(clean(input.text)))fail();
 return{type:'append',rpc:'erp_service_journal_append',args:{...args,p_command_id:input.command_id.toLowerCase(),p_expected_document_version:input.expected_document_version,p_text:input.text}};
}
function entry(value,documentId){
 if(!object(value)||!uuid(value.id)||value.document_id!==documentId||typeof value.sequence!=='string'||!SEQUENCE.test(value.sequence)||!version(value.document_version)
  ||!uuid(value.actor_id)||!validText(value.text)||value.text!==clean(value.text)||typeof value.recorded_at!=='string'||value.recorded_at.length>40
  ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.recorded_at)||!Number.isFinite(Date.parse(value.recorded_at)))bad();
 return{id:value.id.toLowerCase(),document_id:documentId,sequence:value.sequence,document_version:value.document_version,text:value.text,actor_id:value.actor_id.toLowerCase(),recorded_at:value.recorded_at};
}
export function serviceJournalResponse(value,route,userId){
 const id=route.args.p_document_id;
 if(!object(value)||value.scope!=='service_order_journal'||value.document_id!==id||!version(value.document_version)||typeof value.can_write!=='boolean'||value.data_mode!=='erp_native'||value.operational_effects!==false)bad();
 const result={scope:'service_order_journal',document_id:id,document_version:value.document_version,can_write:value.can_write,data_mode:'erp_native',operational_effects:false};
 if(route.type==='list'){
  if(!Array.isArray(value.items)||value.items.length>route.args.p_limit||value.limit!==route.args.p_limit||typeof value.has_more!=='boolean'||(value.has_more&&value.items.length!==value.limit))bad();
  const items=value.items.map(row=>entry(row,id)),ids=new Set();let previous=route.args.p_before?BigInt(route.args.p_before):10000000000n;
  for(const row of items){if(BigInt(row.sequence)>=previous||ids.has(row.id)||row.document_version>value.document_version)bad();previous=BigInt(row.sequence);ids.add(row.id);}
  const next=value.has_more?items.at(-1).sequence:null;if(value.next_before!==next)bad();
  return{...result,items,limit:value.limit,has_more:value.has_more,next_before:next};
 }
 const row=entry(value.entry,id);if(row.document_version>value.document_version)bad();
 if(route.type==='get'&&row.id!==route.args.p_entry_id)bad();
 if(route.type==='append'&&(row.text!==clean(route.args.p_text)||row.actor_id!==userId||row.document_version!==route.args.p_expected_document_version||typeof value.replayed!=='boolean'||!value.can_write))bad();
 return{...result,entry:row,...(route.type==='append'?{replayed:value.replayed}:{})};
}
export async function executeServiceJournalRoute(route,{userId,rpc}){
 if(!uuid(userId))fail(401,'ERP_UNAUTHORIZED');
 if(!route||!['list','get','append'].includes(route.type))fail(404,'ERP_NOT_FOUND');
 const actor=userId.toLowerCase();return serviceJournalResponse(await rpc(route.rpc,{p_user_id:actor,...route.args}),route,actor);
}
