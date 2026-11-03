import { isConfiguredBackendOrigin } from '../../../packages/backend-config/src/origin.mjs';
/** CNAB application ports. Core owns bank layouts; this boundary owns authorization inputs and private persistence. */
import { validateProfile, generateRemittance, parseReturn, planReturnReconciliation, CnabError } from '../../../packages/cnab-core/src/index.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const MAX_FILE=4020000;
const MAX_JSON=5500000;
export const CNAB_BUCKET_CONFIG=Object.freeze({id:'brufap-cnab',name:'brufap-cnab',public:false,file_size_limit:MAX_FILE,allowed_mime_types:['application/octet-stream']});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export class CnabApiError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new CnabApiError(400,'ERP_CNAB_INVALID_INPUT');};
const upstream=()=>{throw new CnabApiError(502,'ERP_CNAB_INVALID_RESPONSE');};
const exact=(value,keys)=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))invalid();};
const uuid=value=>typeof value==='string'&&UUID.test(value);
const version=value=>Number.isInteger(value)&&value>=0&&value<=2147483647;
const HASH_PATH=/^profiles\/[a-f0-9-]{36}\/(remittances\/[a-f0-9]{64}\.rem|returns\/[a-f0-9]{64}\.ret)$/;
export const cnabMethods=path=>/^\/v1\/cnab\/(profiles|remittances|returns)$/.test(path)?['GET','POST']:/^\/v1\/cnab\/(profiles\/[^/]+\/approval|remittances\/[^/]+\/resume|remittances\/preview)$/.test(path)?['POST']:['GET'];
async function jsonBody(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')||!request.body||Number(request.headers.get('Content-Length'))>MAX_JSON)invalid();
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0,timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CnabApiError(408,'ERP_CNAB_TIMEOUT')),10000);});
  try{while(true){const{done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>MAX_JSON)invalid();text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
  catch(error){if(error instanceof CnabApiError)throw error;return invalid();}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function decodeFile(value){
  if(typeof value!=='string'||value.length>5360000||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))invalid();
  let binary;try{binary=atob(value);}catch{invalid();}if(!binary.length||binary.length>MAX_FILE)invalid();
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(btoa(binary)!==value)invalid();return bytes;
}
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
async function derivedCommand(id,label){const hex=await hash(new TextEncoder().encode(`brufap-cnab:${id}:${label}`));return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
const pathFor=(profileId,kind,digest)=>{if(!uuid(profileId)||!HASH.test(digest)||!['remittances','returns'].includes(kind))upstream();return `profiles/${profileId}/${kind}/${digest}.${kind==='returns'?'ret':'rem'}`;};
async function readStored(result,expectedSize,expectedHash){
  let bytes;
  if(result instanceof Uint8Array){if(result.length>MAX_FILE)upstream();bytes=result;}
  else{
    if(!(result instanceof Response)||!result.ok||result.redirected||result.status>=300||!result.body||Number(result.headers.get('Content-Length'))>MAX_FILE)upstream();
    const reader=result.body.getReader();let total=0,timer;const chunks=[];
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CnabApiError(504,'ERP_CNAB_TIMEOUT')),20000);});
    try{while(true){const{done,value}=await Promise.race([reader.read(),deadline]);if(done)break;total+=value.length;if(total>MAX_FILE)upstream();chunks.push(value);}bytes=new Uint8Array(total);let offset=0;for(const value of chunks){bytes.set(value,offset);offset+=value.length;}}
    finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  if(bytes.length!==expectedSize||await hash(bytes)!==expectedHash)throw new CnabApiError(409,'ERP_CNAB_STORED_FILE_MISMATCH');
  return bytes;
}
/** Server-only Storage ports. Deadlines include complete response-body consumption. */
export function createCnabStorage({baseUrl,supabaseDeployment,key,fetchImpl=fetch,timeoutMs=20000}){
  let base;try{base=new URL(baseUrl);}catch{throw new CnabApiError(503,'ERP_CNAB_STORAGE_CONFIG');}
  if(!isConfiguredBackendOrigin(baseUrl,supabaseDeployment,{allowTrailingSlash:true})||typeof key!=='string'||key.length<10||key.length>8192||/\s/.test(key))throw new CnabApiError(503,'ERP_CNAB_STORAGE_CONFIG');
  const operation=async({bucket,path,bytes,upsert,signal},method)=>{
    if(bucket!=='brufap-cnab'||!HASH_PATH.test(path)||(method==='POST'&&(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX_FILE||upsert!==false)))upstream();
    const controller=new AbortController();let timer,rejectDeadline;
    const deadline=new Promise((_,reject)=>{rejectDeadline=reject;timer=setTimeout(()=>{controller.abort();reject(new CnabApiError(504,'ERP_CNAB_TIMEOUT'));},timeoutMs);});
    // The same bound covers the socket and the entire body, even if fetch ignores abort.
    deadline.catch(()=>{});
    const abort=()=>{controller.abort();rejectDeadline(new CnabApiError(503,'ERP_CNAB_STORAGE_ABORTED'));};
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    let reader;
    try{
      if(signal?.aborted)throw new CnabApiError(503,'ERP_CNAB_STORAGE_ABORTED');
      const response=await Promise.race([fetchImpl(`${base.origin}/storage/v1/object/${method==='GET'?'authenticated/':''}${bucket}/${path}`,{method,redirect:'manual',signal:controller.signal,
        headers:{apikey:key,Authorization:`Bearer ${key}`,'Cache-Control':'no-store',...(method==='POST'?{'Content-Type':'application/octet-stream','x-upsert':'false'}:{Accept:'application/octet-stream'})},...(method==='POST'?{body:bytes}:{})}),deadline]);
      if(response.redirected||response.status>=300&&response.status<400)throw new CnabApiError(502,'ERP_CNAB_STORAGE_UNAVAILABLE');
      if(method==='POST'){
        // A duplicate immutable key is recovered only by the subsequent GET/hash check.
        if(!response.ok&&![400,409].includes(response.status))throw new CnabApiError(503,'ERP_CNAB_STORAGE_UNAVAILABLE');
        void response.body?.cancel().catch(()=>{});return;
      }
      if(!response.ok||!response.body||Number(response.headers.get('Content-Length'))>MAX_FILE)throw new CnabApiError(502,'ERP_CNAB_STORAGE_UNAVAILABLE');
      reader=response.body.getReader();const chunks=[];let size=0;
      while(true){const{done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>MAX_FILE)upstream();chunks.push(value);}
      const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
    }catch(error){if(error instanceof CnabApiError)throw error;throw new CnabApiError(503,'ERP_CNAB_STORAGE_UNAVAILABLE');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
  };
  return{storeFile:input=>operation(input,'POST'),getFile:input=>operation(input,'GET')};
}
export async function parseCnabRoute(request){
  const url=new URL(request.url),path=url.pathname;if(path!=='/v1/cnab'&&!path.startsWith('/v1/cnab/'))return null;
  if(!cnabMethods(path).includes(request.method))throw new CnabApiError(405,'ERP_METHOD_NOT_ALLOWED');
  if(request.method==='GET'){
    if(path==='/v1/cnab'&&!url.search)return{kind:'access'};
    if(path==='/v1/cnab/profiles'&&!url.search)return{kind:'profiles'};
    if(['/v1/cnab/remittances','/v1/cnab/returns'].includes(path)){
      for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)invalid();
      const limit=url.searchParams.get('limit')||'25',after=url.searchParams.get('after');if(!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(after&&!uuid(after)))invalid();
      return{kind:'files',fileKind:path.endsWith('/returns')?'return':'remittance',limit:Number(limit),after:after||null};
    }
    const review=/^\/v1\/cnab\/returns\/([a-f0-9-]+)\/review$/.exec(path);
    if(review&&uuid(review[1])){for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)invalid();const limit=url.searchParams.get('limit')||'25',after=url.searchParams.get('after')||'1';if(!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||!/^\d{1,5}$/.test(after)||Number(after)<1||Number(after)>10000)invalid();return{kind:'review',id:review[1],limit:Number(limit),after:Number(after)};}
    const file=/^\/v1\/cnab\/files\/(remittance|return)\/([a-f0-9-]+)$/.exec(path);if(file&&uuid(file[2])&&!url.search)return{kind:'file',fileKind:file[1],id:file[2]};
    throw new CnabApiError(404,'ERP_NOT_FOUND');
  }
  if(url.search)invalid();const body=await jsonBody(request);
  const approval=/^\/v1\/cnab\/profiles\/([a-f0-9-]+)\/approval$/.exec(path);
  if(approval&&uuid(approval[1])){
    exact(body,['expected_version','command_id','data']);exact(body.data,['contract_verified','policy_verified','range_verified','reference']);
    if(!uuid(body.command_id)||!version(body.expected_version)||body.expected_version<1||typeof body.data.contract_verified!=='boolean'||typeof body.data.policy_verified!=='boolean'||(body.data.range_verified!==undefined&&typeof body.data.range_verified!=='boolean')||typeof body.data.reference!=='string'||!body.data.reference.trim()||body.data.reference.length>120)invalid();
    return{kind:'approval',id:approval[1],body};
  }
  const resume=/^\/v1\/cnab\/remittances\/([a-f0-9-]+)\/resume$/.exec(path);
  if(resume&&uuid(resume[1])){exact(body,[]);return{kind:'resume',id:resume[1]};}
  if(path==='/v1/cnab/profiles'){
    exact(body,['id','expected_version','command_id','data']);if((body.id!==undefined&&body.id!==null&&!uuid(body.id))||!uuid(body.command_id)||!version(body.expected_version))invalid();
    exact(body.data,['account_id','bank','layout','agency','account','accountDigit','wallet','cnpj','companyName','agreementReference','contractVerified','simpleCollectionPolicyVerified','reservedRange','ourNumberStart','remittanceSequenceStart']);
    if(!uuid(body.data.account_id))invalid();try{validateProfile({...body.data,accountId:body.data.account_id});}catch(error){if(error instanceof CnabError)throw new CnabApiError(400,error.code);throw error;}
    return{kind:'profile_save',body};
  }
  if(path==='/v1/cnab/remittances'||path==='/v1/cnab/remittances/preview'){
    exact(body,['profile_id','expected_version','command_id','generated_on','titles']);if(!uuid(body.profile_id)||!uuid(body.command_id)||!version(body.expected_version)||body.expected_version<1||typeof body.generated_on!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(body.generated_on)||!Array.isArray(body.titles)||body.titles.length<1||body.titles.length>30)invalid();
    const instant=Date.parse(`${body.generated_on}T00:00:00Z`);if(!Number.isFinite(instant)||new Date(instant).toISOString().slice(0,10)!==body.generated_on)invalid();
    for(const title of body.titles){exact(title,['title_id','expected_version','document_number','payment_limit_days']);if(!uuid(title.title_id)||!version(title.expected_version)||title.expected_version<1||typeof title.document_number!=='string'||!/^[A-Z0-9 .&/-]{1,10}$/.test(title.document_number)||(title.payment_limit_days!==undefined&&(!Number.isInteger(title.payment_limit_days)||title.payment_limit_days<1||title.payment_limit_days>60)))invalid();}
    if(new Set(body.titles.map(title=>title.title_id)).size!==body.titles.length)invalid();return{kind:path.endsWith('/preview')?'preview':'generate',body};
  }
  if(path==='/v1/cnab/returns'){
    exact(body,['profile_id','command_id','file_base64','century','obtained_from_bank','reference_id']);if(!uuid(body.profile_id)||!uuid(body.command_id)||(body.century!==undefined&&![1900,2000,2100].includes(body.century))||(body.obtained_from_bank!==undefined&&typeof body.obtained_from_bank!=='boolean')||(body.obtained_from_bank===true&&(typeof body.reference_id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(body.reference_id))))invalid();
    return{kind:'return',body:{...body,file_base64:undefined},bytes:decodeFile(body.file_base64)};
  }
  throw new CnabApiError(404,'ERP_NOT_FOUND');
}
const safety={purpose:'homologation',productionReady:false,financialMutationPerformed:false};
function safeProfile(value){
  if(!object(value)||!uuid(value.id)||!uuid(value.account_id)||!['341','077'].includes(value.bank)||typeof value.account_name!=='string'||typeof value.account_mask!=='string'||typeof value.company_name!=='string'||!version(value.version)||typeof value.contract_verified!=='boolean'||typeof value.policy_verified!=='boolean'||!/^[1-9]\d*$/.test(value.next_sequence||''))upstream();
  return Object.fromEntries(['id','account_id','account_name','bank','wallet','account_mask','company_name','version','contract_verified','policy_verified','next_sequence'].map(key=>[key,value[key]]));
}
function safeResult(value,keys){if(!object(value)||value.productionReady!==false||value.financialMutationPerformed!==false)upstream();return{...Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])),...safety};}

/** Ports must use the fixed Supabase host and service credential, redirect refusal, timeouts, private bucket and no upsert. */
export async function executeCnabRoute(route,{userId,rpc,storeFile,getFile}){
  if(!uuid(userId))throw new CnabApiError(401,'ERP_UNAUTHENTICATED');
  const call=(name,args={})=>rpc(name,{...args,p_user_id:userId});
  try{
    if(route.kind==='access'){const value=await call('erp_cnab_access');if(value.read!==true||typeof value.write!=='boolean'||typeof value.configure!=='boolean')upstream();return{type:'json',body:{read:true,write:value.write,configure:value.configure,...safety}};}
    if(route.kind==='profiles'){const value=await call('erp_cnab_profiles');if(!Array.isArray(value.items)||value.items.length>100)upstream();return{type:'json',body:{items:value.items.map(safeProfile),...safety}};}
    if(route.kind==='files'){
      const value=await call('erp_cnab_files',{p_kind:route.fileKind,p_limit:route.limit,p_after:route.after});
      if(!Array.isArray(value.items)||value.items.length>route.limit||typeof value.has_more!=='boolean'||(value.next_cursor!==null&&!uuid(value.next_cursor)))upstream();
      const items=value.items.map(row=>{if(!object(row)||!uuid(row.id)||!uuid(row.profile_id)||row.kind!==route.fileKind||!['ready','reserved'].includes(row.state)||(row.file_hash!==null&&!HASH.test(row.file_hash))||typeof row.filename!=='string'||!/^[A-Za-z0-9_-]{1,80}\.(REM|RET)$/.test(row.filename))upstream();return Object.fromEntries(['id','profile_id','kind','state','sequence','generated_on','created_at','file_hash','byte_size','titles','filename'].map(key=>[key,row[key]]));});
      return{type:'json',body:{...safeResult(value,['limit','has_more','next_cursor']),items}};
    }
    if(route.kind==='profile_save'){const b=route.body,value=await call('erp_cnab_profile_save',{p_id:b.id||null,p_expected_version:b.expected_version,p_command_id:b.command_id,p_data:b.data});return{type:'json',body:{profile:safeProfile(value.profile),replayed:value.replayed===true,...safety}};}
    if(route.kind==='approval'){const b=route.body,value=await call('erp_cnab_approve',{p_id:route.id,p_expected_version:b.expected_version,p_command_id:b.command_id,p_data:b.data});return{type:'json',body:{profile:safeProfile(value.profile),replayed:value.replayed===true,...safety}};}
    if(route.kind==='generate'||route.kind==='resume'||route.kind==='preview'){
      const b=route.body,reserved=route.kind==='resume'?{id:route.id}:await call('erp_cnab_reserve',{p_profile_id:b.profile_id,p_expected_version:b.expected_version,p_command_id:b.command_id,p_generated_on:b.generated_on,p_titles:b.titles,p_preview:route.kind==='preview'});
      if(route.kind==='preview'){
        if(reserved.preview!==true||reserved.profile_id!==b.profile_id||reserved.profile_version!==b.expected_version)upstream();
        const generated=await generateRemittance(reserved.snapshot);
        return{type:'json',body:{preview:true,profile_id:b.profile_id,sequence:reserved.snapshot.remittanceSequence,total_cents:generated.totalCents,titles:generated.manifest.length,warnings:generated.warnings,...safety}};
      }
      if(!uuid(reserved.id))upstream();
      const reservation=await call('erp_cnab_reservation',{p_id:reserved.id});if(reservation.id!==reserved.id||(b&&reservation.profile_id!==b.profile_id)||!uuid(reservation.profile_id)||!object(reservation.snapshot)||reservation.snapshot.purpose!=='homologation')upstream();
      const generated=await generateRemittance(reservation.snapshot);const path=pathFor(reservation.profile_id,'remittances',generated.fileHash);
      if(reservation.state!=='ready')await storeFile({bucket:'brufap-cnab',path,bytes:generated.bytes,upsert:false});
      await readStored(await getFile({bucket:'brufap-cnab',path}),generated.bytes.length,generated.fileHash);
      const value=await call('erp_cnab_finalize',{p_id:reserved.id,p_command_id:await derivedCommand(`${userId}:${reserved.id}`,'finalize'),p_hash:generated.fileHash,p_size:generated.bytes.length,p_path:path,p_manifest:generated.manifest});
      return{type:'json',body:{...safeResult(value,['id','profile_id','sequence','state','file_hash','byte_size','replayed']),filename:generated.filename,warnings:generated.warnings}};
    }
    if(route.kind==='return'){
      const b=route.body,profile=await call('erp_cnab_profile_context',{p_profile_id:b.profile_id});const parsed=await parseReturn(route.bytes,{profile,century:b.century??2000});
      const context=await call('erp_cnab_return_context',{p_profile_id:b.profile_id,p_file_hash:parsed.fileHash,p_event_hashes:parsed.events.map(event=>event.eventHash),p_controls:parsed.events.map(event=>event.control)});
      // SQL 246: Nº Retorno (sequence of the Itaú .RET header, equal to the trailer's) is kept in the evidence, as in the operational import.
      const sequence=parsed.bank==='341'&&/^\d{5}$/.test(parsed.trailer?.fileSequence??'')?{fileSequence:parsed.trailer.fileSequence}:{};
      const evidence=b.obtained_from_bank===true?{source:'authenticated-bank-download',fileHash:parsed.fileHash,accountId:profile.accountId,reviewedBy:userId,referenceId:b.reference_id,...sequence}:{...sequence};
      const plan=planReturnReconciliation({parsed,titles:context.titles,seenFileHashes:context.seenFileHashes,seenEventHashes:context.seenEventHashes,evidence});
      const path=pathFor(b.profile_id,'returns',parsed.fileHash);await storeFile({bucket:'brufap-cnab',path,bytes:route.bytes,upsert:false});await readStored(await getFile({bucket:'brufap-cnab',path}),route.bytes.length,parsed.fileHash);
      const value=await call('erp_cnab_return_commit',{p_command_id:b.command_id,p_profile_id:b.profile_id,p_file:{hash:parsed.fileHash,size:route.bytes.length,path,generated_on:parsed.generatedOn,century:parsed.century,record_count:parsed.recordCount,warnings:parsed.warnings,evidence},p_events:parsed.events,p_decisions:plan.decisions});
      return{type:'json',body:{...safeResult(value,['id','profile_id','file_hash','duplicate_file','new_events','duplicate_events','replayed']),canSettle:false,originAuthenticated:false}};
    }
    if(route.kind==='review'){
      const value=await call('erp_cnab_review',{p_file_id:route.id,p_limit:route.limit,p_after:route.after});if(!Array.isArray(value.items)||value.items.length>route.limit||typeof value.has_more!=='boolean')upstream();
      const keys=['line','event_id','event_hash','duplicate','billing_title_id','action','reason','control','document_number','our_number','occurrence','kind','amount_cents','paid_cents','occurrence_date','credit_date'];
      const items=value.items.map(item=>{if(!object(item)||!uuid(item.event_id)||!HASH.test(item.event_hash)||item.canSettle!==false)upstream();return{...Object.fromEntries(keys.map(key=>[key,item[key]])),canSettle:false};});
      return{type:'json',body:{...safeResult(value,['id','profile_id','file_hash','warnings','has_more','next_cursor','limit']),items,canSettle:false,originAuthenticated:false}};
    }
    if(route.kind==='file'){
      const file=await call('erp_cnab_file',{p_kind:route.fileKind,p_id:route.id});const expected=pathFor(file.profile_id,route.fileKind==='return'?'returns':'remittances',file.hash);
      if(file.id!==route.id||file.path!==expected||!HASH_PATH.test(file.path)||!Number.isInteger(file.size)||file.size<1||file.size>MAX_FILE||typeof file.filename!=='string'||!/^[A-Za-z0-9_-]{1,80}\.(REM|RET)$/.test(file.filename))upstream();
      const bytes=await readStored(await getFile({bucket:'brufap-cnab',path:file.path}),file.size,file.hash);
      const current=await call('erp_cnab_file',{p_kind:route.fileKind,p_id:route.id});
      if(current.path!==file.path||current.hash!==file.hash||current.size!==file.size)throw new CnabApiError(409,'ERP_CNAB_STORED_FILE_MISMATCH');
      return{type:'download',bytes,filename:file.filename};
    }
    throw new CnabApiError(404,'ERP_NOT_FOUND');
  }catch(error){if(error instanceof CnabError)throw new CnabApiError(400,error.code);throw error;}
}
