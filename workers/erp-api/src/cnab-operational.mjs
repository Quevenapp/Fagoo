/** Explicit operational CNAB remittances. No bank transmission, return settlement or browser Storage URLs. */
import {generateOperationalRemittance,CnabError} from '../../../packages/cnab-core/src/index.mjs';

const PREFIX='/v1/cobranca-operacional',MAX_JSON=65536,MAX_FILE=4020000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),uuid=x=>typeof x==='string'&&UUID.test(x);
const version=(x,min=1)=>Number.isInteger(x)&&x>=min&&x<=2147483647;
const date=x=>typeof x==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const historicalDate=x=>typeof x==='string'&&/^(19|20)\d{2}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const time=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x)&&Number.isFinite(Date.parse(x));
const text=(x,max)=>typeof x==='string'&&Array.from(x).length<=max&&!/[\u0000-\u001f\u007f]/.test(x);
const SAFETY=Object.freeze({purpose:'operational',productionReady:false,bankTransmissionPerformed:false,financialMutationPerformed:false,originAuthenticated:false});
export const CNAB_OPERATIONAL_ISSUES=Object.freeze(['OPERATIONAL_APPROVAL_MISSING','OPERATIONAL_APPROVAL_DISABLED','COMPANY_IDENTITY_MISSING','BENEFICIARY_CNPJ_MISMATCH','BANK_ACCOUNT_INACTIVE','BANK_CONTRACT_OR_POLICY_PENDING','OPERATIONAL_APPROVAL_STALE']);
export class CnabOperationalError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new CnabOperationalError(400,'ERP_CNAB_OPERATIONAL_INVALID_INPUT');};
const upstream=()=>{throw new CnabOperationalError(502,'ERP_CNAB_OPERATIONAL_INVALID_RESPONSE');};
function exact(value,keys){if(!object(value)||Object.keys(value).some(k=>!keys.includes(k)))invalid();}
function safety(value){if(!object(value)||Object.entries(SAFETY).some(([k,v])=>value[k]!==v))upstream();}
function pagination(url){for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)invalid();const limit=url.searchParams.get('limit')||'25',after=url.searchParams.get('after');if(!/^\d{1,3}$/.test(limit)||+limit<1||+limit>100||(after!==null&&!uuid(after)))invalid();return{limit:+limit,after:after?.toLowerCase()||null};}
export function cnabOperationalMethods(path){return /^\/v1\/cobranca-operacional\/(profiles\/[^/]+\/approval|remittances\/[^/]+\/resume|remittances\/preview)$/.test(path)?['POST']:path===PREFIX+'/remittances'?['GET','POST']:['GET'];}
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body||Number(request.headers.get('content-length'))>MAX_JSON)invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,value='',timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CnabOperationalError(408,'ERP_CNAB_OPERATIONAL_TIMEOUT')),10000);});
 try{while(true){const chunk=await Promise.race([reader.read(),timeout]);if(chunk.done)break;size+=chunk.value.length;if(size>MAX_JSON)invalid();value+=decoder.decode(chunk.value,{stream:true});}return JSON.parse(value+decoder.decode());}
 catch(error){if(error instanceof CnabOperationalError)throw error;invalid();}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function parseCnabOperationalRoute(request){
 const url=new URL(request.url),path=url.pathname;if(path!==PREFIX&&!path.startsWith(PREFIX+'/'))return null;
 if(url.hash)invalid();if(!cnabOperationalMethods(path).includes(request.method))throw new CnabOperationalError(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.method==='GET'){
  if(path===PREFIX+'/profiles'&&!url.search)return{kind:'profiles'};
  if(path===PREFIX+'/remittances')return{kind:'files',...pagination(url)};
  const file=new RegExp('^'+PREFIX+'/files/remittance/([^/]+)$').exec(path);if(file&&uuid(file[1])&&!url.search)return{kind:'file',id:file[1].toLowerCase()};
  throw new CnabOperationalError(404,'ERP_NOT_FOUND');
 }
 if(url.search)invalid();const b=await body(request);
 const approval=new RegExp('^'+PREFIX+'/profiles/([^/]+)/approval$').exec(path);
 if(approval&&uuid(approval[1])){
  exact(b,['command_id','expected_approval_version','expected_profile_version','expected_identity_version','enabled','confirmed_on','reference']);
  if(!uuid(b.command_id)||!version(b.expected_approval_version,0)||b.expected_approval_version===2147483647||!version(b.expected_profile_version)||(b.expected_identity_version!==null&&!version(b.expected_identity_version))||typeof b.enabled!=='boolean'||!date(b.confirmed_on)||!text(b.reference,200)||b.reference.replace(/^ +| +$/g,'').length<3||!b.reference.trim())invalid();
  return{kind:'approval',id:approval[1].toLowerCase(),body:{...b,command_id:b.command_id.toLowerCase()}};
 }
 const resume=new RegExp('^'+PREFIX+'/remittances/([^/]+)/resume$').exec(path);
 if(resume&&uuid(resume[1])){exact(b,['expected_approval_version']);if(!version(b.expected_approval_version))invalid();return{kind:'resume',id:resume[1].toLowerCase(),body:b};}
 if([PREFIX+'/remittances',PREFIX+'/remittances/preview'].includes(path)){
  exact(b,['command_id','profile_id','expected_version','expected_approval_version','generated_on','titles','confirm_operational','preview_hash']);
  const preview=path.endsWith('/preview');
  if(preview?b.preview_hash!==undefined:typeof b.preview_hash!=='string'||!HASH.test(b.preview_hash))invalid();
  if(!uuid(b.command_id)||!uuid(b.profile_id)||!version(b.expected_version)||!version(b.expected_approval_version)||!date(b.generated_on)||typeof b.confirm_operational!=='boolean'||(!preview&&!b.confirm_operational)||!Array.isArray(b.titles)||b.titles.length<1||b.titles.length>30)invalid();
  const titles=b.titles.map(t=>{exact(t,['title_id','expected_version','document_number','payment_limit_days']);if(!uuid(t.title_id)||!version(t.expected_version)||typeof t.document_number!=='string'||!/^[A-Z0-9 .&/-]{1,10}$/.test(t.document_number)||t.document_number!==t.document_number.trim()||(t.payment_limit_days!==undefined&&(!Number.isInteger(t.payment_limit_days)||t.payment_limit_days<1||t.payment_limit_days>60)))invalid();return{...t,title_id:t.title_id.toLowerCase()};});
  if(new Set(titles.map(t=>t.title_id)).size!==titles.length)invalid();return{kind:preview?'preview':'generate',body:{...b,command_id:b.command_id.toLowerCase(),profile_id:b.profile_id.toLowerCase(),titles}};
 }
 throw new CnabOperationalError(404,'ERP_NOT_FOUND');
}
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
async function finalizeCommand(user,id,approval){const h=await digest(new TextEncoder().encode(`brufap-cnab-operational:${user}:${id}:approval:${approval}`));return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
const pathFor=(profile,hash)=>{if(!uuid(profile)||!HASH.test(hash))upstream();return`profiles/${profile}/remittances/${hash}.rem`;};
async function stored(result,size,hash){
 let bytes;
 if(result instanceof Uint8Array)bytes=result;
 else{
  if(!(result instanceof Response)||!result.ok||result.redirected||result.status>=300||!result.body||Number(result.headers.get('content-length'))>MAX_FILE)upstream();
  const reader=result.body.getReader();let timer,total=0;const chunks=[],timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CnabOperationalError(504,'ERP_CNAB_OPERATIONAL_TIMEOUT')),20000);});
  try{while(true){const chunk=await Promise.race([reader.read(),timeout]);if(chunk.done)break;total+=chunk.value.length;if(total>MAX_FILE)upstream();chunks.push(chunk.value);}bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}}
  finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 if(bytes.length>MAX_FILE||bytes.length!==size||await digest(bytes)!==hash)throw new CnabOperationalError(409,'ERP_CNAB_STORED_FILE_MISMATCH');return bytes;
}
function approvalDto(a){
 if(!object(a)||!uuid(a.profile_id)||!version(a.approval_version,0)||!version(a.profile_version)||(a.identity_version!==null&&!version(a.identity_version))||typeof a.enabled!=='boolean'||typeof a.effective_enabled!=='boolean'||!Array.isArray(a.issues)||a.issues.length>CNAB_OPERATIONAL_ISSUES.length||new Set(a.issues).size!==a.issues.length||a.issues.some(x=>!CNAB_OPERATIONAL_ISSUES.includes(x))||a.effective_enabled!==(a.issues.length===0))upstream();
 if(a.approval_version===0){if(a.enabled||a.reference!==null||a.confirmed_on!==null||a.reviewed_at!==null)upstream();}else if(!text(a.reference,200)||!date(a.confirmed_on)||!time(a.reviewed_at))upstream();
 return Object.fromEntries(['profile_id','approval_version','enabled','effective_enabled','profile_version','identity_version','reference','confirmed_on','reviewed_at','issues'].map(k=>[k,a[k]]));
}
function profileDto(p){if(!object(p)||!uuid(p.id)||!uuid(p.account_id)||!['341','077'].includes(p.bank)||!text(p.account_name,120)||!text(p.account_mask,80)||!text(p.company_name,100)||!text(p.wallet,3)||!version(p.version)||typeof p.contract_verified!=='boolean'||typeof p.policy_verified!=='boolean'||typeof p.next_sequence!=='string'||!/^[1-9]\d{0,7}$/.test(p.next_sequence))upstream();return Object.fromEntries(['id','account_id','account_name','bank','wallet','account_mask','company_name','version','contract_verified','policy_verified','next_sequence'].map(k=>[k,p[k]]));}
function readyDto(v,id,profile,sequence,generated){safety(v);if(v.id!==id||v.profile_id!==profile||v.state!=='ready'||v.file_hash!==generated.fileHash||v.byte_size!==generated.bytes.length||v.sequence!==sequence||typeof v.sequence!=='string'||!/^[1-9]\d{0,6}$/.test(v.sequence)||typeof v.replayed!=='boolean')upstream();return{id:v.id,profile_id:v.profile_id,state:'ready',sequence:v.sequence,file_hash:v.file_hash,byte_size:v.byte_size,replayed:v.replayed,...SAFETY};}
function previewItems(reserved,b){
 return reserved.preview_items.map((x,i)=>{
  const t=x?.title,p=t?.payer,snapshot=reserved.snapshot.titles[i];
  if(!object(x)||x.finance_title_id!==b.titles[i].title_id||x.finance_title_version!==b.titles[i].expected_version||!version(x.contact_version)||!object(t)||!object(p)||!object(snapshot)||!object(snapshot.payer)||t.documentNumber!==b.titles[i].document_number||!text(p.name,40)||typeof p.document!=='string'||!/^\d{11,14}$/.test(p.document)||!text(p.address,40)||!text(p.neighborhood,100)||!text(p.city,100)||!text(p.state,2)||typeof p.postalCode!=='string'||!/^\d{8}$/.test(p.postalCode)||typeof t.amountCents!=='string'||!/^[1-9]\d{0,12}$/.test(t.amountCents)||!historicalDate(t.issuedOn)||!historicalDate(t.dueOn))upstream();
  // The review projection must describe the exact payer/amount encoded by the core.
  for(const key of['documentNumber','amountCents','issuedOn','dueOn','ourNumber','paymentLimitDays'])if(t[key]!==snapshot[key])upstream();
  for(const key of['type','document','name','address','neighborhood','city','state','postalCode'])if(p[key]!==snapshot.payer[key])upstream();
  return{title_id:x.finance_title_id,title_version:x.finance_title_version,contact_version:x.contact_version,document_number:t.documentNumber,amount_cents:t.amountCents,issued_on:t.issuedOn,due_on:t.dueOn,payer:{name:p.name,document_mask:'*'.repeat(p.document.length-4)+p.document.slice(-4),address:p.address,neighborhood:p.neighborhood,city:p.city,state:p.state,postal_code:p.postalCode}};
 });
}
function fileDto(v,id){safety(v);if(v.id!==id||!uuid(v.profile_id)||!HASH.test(v.hash)||!Number.isInteger(v.size)||v.size<1||v.size>MAX_FILE||v.path!==pathFor(v.profile_id,v.hash)||!version(v.approval_version)||typeof v.filename!=='string'||!/^(ITAU_COBRANCA_|CI400_001_)\d{7}\.REM$/.test(v.filename))upstream();return{id:v.id,profile_id:v.profile_id,hash:v.hash,size:v.size,path:v.path,filename:v.filename,approval_version:v.approval_version};}

/** Reuse the bounded fixed-host Storage port from createCnabStorage; browser receives no snapshot or path. */
export async function executeCnabOperationalRoute(route,{userId,rpc,storeFile,getFile}){
 if(!uuid(userId))throw new CnabOperationalError(401,'ERP_UNAUTHENTICATED');userId=userId.toLowerCase();const call=(name,args={})=>rpc(name,{...args,p_user_id:userId});
 try{
  if(route.kind==='profiles'){const v=await call('erp_cnab_operational_profiles');safety(v);if(!Array.isArray(v.items)||v.items.length>100)upstream();return{type:'json',body:{...SAFETY,items:v.items.map(x=>{const profile=profileDto(x?.profile),approval=approvalDto(x?.approval);if(approval.profile_id!==profile.id||approval.profile_version!==profile.version)upstream();return{profile,approval};})}};}
  if(route.kind==='approval'){const b=route.body,v=await call('erp_cnab_operational_approve',{p_profile_id:route.id,p_command_id:b.command_id,p_expected_approval:b.expected_approval_version,p_expected_profile:b.expected_profile_version,p_expected_identity:b.expected_identity_version,p_enabled:b.enabled,p_confirmed_on:b.confirmed_on,p_reference:b.reference});safety(v);const approval=approvalDto(v.approval);if(approval.profile_id!==route.id||approval.approval_version!==b.expected_approval_version+1||approval.profile_version!==b.expected_profile_version||approval.identity_version!==b.expected_identity_version||approval.enabled!==b.enabled||approval.confirmed_on!==b.confirmed_on||approval.reference!==b.reference.replace(/^ +| +$/g,'')||typeof v.replayed!=='boolean')upstream();return{type:'json',body:{...SAFETY,approval,replayed:v.replayed}};}
  if(route.kind==='files'){
   const v=await call('erp_cnab_operational_files',{p_kind:'remittance',p_limit:route.limit,p_after:route.after});safety(v);
   if(!Array.isArray(v.items)||v.items.length>route.limit||v.limit!==route.limit||typeof v.has_more!=='boolean'||(v.next_cursor!==null&&!uuid(v.next_cursor))||v.has_more!==(v.next_cursor!==null))upstream();
   let previous=route.after;const items=v.items.map(x=>{if(!object(x)||!uuid(x.id)||!uuid(x.profile_id)||(previous&&x.id<=previous)||x.kind!=='remittance'||!['reserved','ready'].includes(x.state)||typeof x.sequence!=='string'||!/^[1-9]\d{0,6}$/.test(x.sequence)||!date(x.generated_on)||!time(x.created_at)||!Number.isInteger(x.titles)||x.titles<1||x.titles>30||typeof x.filename!=='string'||!/^(ITAU_COBRANCA_|CI400_001_)\d{7}\.REM$/.test(x.filename)||(x.state==='ready'?(!HASH.test(x.file_hash)||!Number.isInteger(x.byte_size)||x.byte_size<1||x.byte_size>MAX_FILE):(x.file_hash!==null||x.byte_size!==null)))upstream();previous=x.id;return Object.fromEntries(['id','profile_id','kind','state','sequence','generated_on','created_at','file_hash','byte_size','titles','filename'].map(k=>[k,x[k]]));});
   if(v.next_cursor!==null&&v.next_cursor!==items.at(-1)?.id)upstream();return{type:'json',body:{...SAFETY,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor}};
  }
  if(route.kind==='file'){const meta=fileDto(await call('erp_cnab_operational_file',{p_id:route.id}),route.id),bytes=await stored(await getFile({bucket:'brufap-cnab',path:meta.path}),meta.size,meta.hash),current=fileDto(await call('erp_cnab_operational_file',{p_id:route.id}),route.id);if(JSON.stringify(meta)!==JSON.stringify(current))throw new CnabOperationalError(409,'ERP_CNAB_OPERATIONAL_CONTEXT_CHANGED');return{type:'download',bytes,filename:meta.filename,contentType:'application/octet-stream'};}
  if(['preview','generate','resume'].includes(route.kind)){
   const b=route.body,approval=b.expected_approval_version,reserved=route.kind==='resume'?{id:route.id}:await call('erp_cnab_operational_reserve',{p_command_id:b.command_id,p_profile_id:b.profile_id,p_expected_version:b.expected_version,p_expected_approval:approval,p_generated_on:b.generated_on,p_titles:b.titles,p_confirm_operational:b.confirm_operational,p_preview:route.kind==='preview',p_preview_hash:route.kind==='preview'?null:b.preview_hash});
   if(route.kind==='preview'){
    if(reserved.preview!==true||reserved.profile_id!==b.profile_id||reserved.profile_version!==b.expected_version||reserved.snapshot?.purpose!=='operational'||reserved.snapshot?.operational_authorization?.approval_version!==approval||typeof reserved.preview_hash!=='string'||!HASH.test(reserved.preview_hash)||reserved.snapshot?.preview_hash!==reserved.preview_hash||!Array.isArray(reserved.preview_items)||reserved.preview_items.length!==b.titles.length)upstream();
    const generated=await generateOperationalRemittance(reserved.snapshot),items=previewItems(reserved,b);return{type:'json',body:{...SAFETY,preview:true,persisted:false,preview_hash:reserved.preview_hash,profile_id:b.profile_id,profile_version:b.expected_version,approval_version:approval,sequence:reserved.snapshot.remittanceSequence,total_cents:generated.totalCents,titles:generated.manifest.length,items,warnings:generated.warnings}};
   }
   if(!uuid(reserved.id))upstream();if(route.kind==='generate'){safety(reserved);if(reserved.profile_id!==b.profile_id||!['reserved','ready'].includes(reserved.state))upstream();}
   const r=await call('erp_cnab_operational_reservation',{p_id:reserved.id,p_expected_approval:approval});safety(r);
   if(r.id!==reserved.id||!uuid(r.profile_id)||(route.kind==='generate'&&r.profile_id!==b.profile_id)||!['reserved','ready'].includes(r.state)||r.approval_version!==approval||r.snapshot?.purpose!=='operational'||!object(r.snapshot.operational_authorization))upstream();
   const generated=await generateOperationalRemittance(r.snapshot),path=pathFor(r.profile_id,generated.fileHash);
   if(r.state!=='ready')await storeFile({bucket:'brufap-cnab',path,bytes:generated.bytes,upsert:false});
   await stored(await getFile({bucket:'brufap-cnab',path}),generated.bytes.length,generated.fileHash);
   const v=await call('erp_cnab_operational_finalize',{p_id:r.id,p_command_id:await finalizeCommand(userId,r.id,approval),p_hash:generated.fileHash,p_size:generated.bytes.length,p_path:path,p_manifest:generated.manifest,p_expected_approval:approval});
   return{type:'json',body:{...readyDto(v,r.id,r.profile_id,r.snapshot.remittanceSequence,generated),filename:generated.filename,warnings:generated.warnings}};
  }
  upstream();
 }catch(error){if(error instanceof CnabError)throw new CnabOperationalError(400,error.code);throw error;}
}
