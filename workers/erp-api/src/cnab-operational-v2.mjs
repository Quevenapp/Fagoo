/** Explicit Itaú 109 v2 HTTP boundary. Composition supplies authenticated actor and fixed-host ports. */
import {CnabError,generateOperationalRemittanceV2,validateOperationalRemittanceV2} from '../../../packages/cnab-core/src/index.mjs';

export const CNAB_OPERATIONAL_V2_PREFIX='/v1/cobranca-operacional-v2';
export const CNAB_OPERATIONAL_V2_BODY_BYTES=65536;
export const CNAB_OPERATIONAL_V2_RESPONSE_BYTES=262144;
export const CNAB_OPERATIONAL_V2_FILE_BYTES=24924; // 30 pairs of details plus header/trailer, CRLF included.
const PRIVATE_BYTES=1048576,ROUTES=new WeakSet(),ENCODINGS=['itau109-no-charges-v1','itau109-origin-observed-v1'];
const FLAGS=Object.freeze({purpose:'operational',productionReady:false,bankTransmissionPerformed:false,
 financialMutationPerformed:false,originAuthenticated:false,contract:'itau109-operational-v2'});
const FLAG_KEYS=Object.keys(FLAGS),ISSUES=['OPERATIONAL_APPROVAL_MISSING','OPERATIONAL_APPROVAL_DISABLED','COMPANY_IDENTITY_MISSING',
 'BENEFICIARY_CNPJ_MISMATCH','BANK_ACCOUNT_INACTIVE','BANK_CONTRACT_OR_POLICY_PENDING','OPERATIONAL_APPROVAL_STALE'];
const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const sequence=v=>typeof v==='string'&&/^[1-9][0-9]{0,6}$/.test(v);
const size=v=>Number.isInteger(v)&&v>=1206&&v<=CNAB_OPERATIONAL_V2_FILE_BYTES&&v%402===0;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const accountName=v=>typeof v==='string'&&Array.from(v).length>=1&&Array.from(v).length<=200&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const text=(v,max)=>typeof v==='string'&&Array.from(v).length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const equal=(a,b)=>a===b||(Array.isArray(a)&&Array.isArray(b)?a.length===b.length&&a.every((x,i)=>equal(x,b[i])):
 object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k])));
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export class CnabOperationalV2Error extends Error {constructor(status,code){super(code);this.name='CnabOperationalV2Error';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_CNAB_OPERATIONAL_V2_INVALID_INPUT')=>{throw new CnabOperationalV2Error(status,code);};
const bad=()=>fail(502,'ERP_CNAB_OPERATIONAL_V2_INVALID_RESPONSE');
function day(v){return typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function stamp(v){
 if(typeof v!=='string'||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0,n=Date.parse(v);
 return(!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(n)&&new Date(n+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
/** Copy own data properties only, before any asynchronous validation/generation. No getter or toJSON execution. */
function capture(value,max=PRIVATE_BYTES){
 let nodes=0,chars=0;
 const copy=(v,depth)=>{
  if(++nodes>12000||depth>12)bad();
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){chars+=v.length;if(chars>max)bad();return v;}
  if(typeof v==='number'){if(!Number.isFinite(v))bad();return v;}
  if(!v||typeof v!=='object')bad();
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)bad();
  const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);
  if(keys.some(k=>typeof k!=='string'||!Object.hasOwn(d[k],'value')||(!d[k].enumerable&&!(array&&k==='length'))))bad();
  if(array){const length=d.length.value;if(!Number.isInteger(length)||length>300||keys.length!==length+1)bad();return Array.from({length},(_,i)=>{if(!d[i])bad();return copy(d[i].value,depth+1);});}
  return Object.fromEntries(keys.map(k=>[k,copy(d[k].value,depth+1)]));
 };
 try{const result=copy(value,0);if(new TextEncoder().encode(JSON.stringify(result)).length>max)bad();return freeze(result);}
 catch(e){if(e instanceof CnabOperationalV2Error)throw e;bad();}
}
function flags(v,keys){if(!exact(v,[...FLAG_KEYS,...keys])||FLAG_KEYS.some(k=>v[k]!==FLAGS[k]))bad();}
function shape(path){
 const p=CNAB_OPERATIONAL_V2_PREFIX;
 if(path===p+'/profiles')return{kind:'profiles',method:'GET'};
 if(path===p+'/remittances/preview')return{kind:'preview',method:'POST'};
 if(path===p+'/remittances')return{kind:'collection',method:null};
 for(const[kind,prefix,suffix,method]of[['approval','profiles/','/approval','POST'],['resume','remittances/','/resume','POST'],['command','commands/','','GET'],['file','files/remittance/','','GET']]){
  const start=p+'/'+prefix;if(path.startsWith(start)&&path.endsWith(suffix)){const part=path.slice(start.length,suffix?-suffix.length:undefined);if(id(part))return{kind,id:part.toLowerCase(),method};}
 }
 return null;
}
export const cnabOperationalV2Route=path=>typeof path==='string'&&(path===CNAB_OPERATIONAL_V2_PREFIX||path.startsWith(CNAB_OPERATIONAL_V2_PREFIX+'/'));
export const cnabOperationalV2Methods=path=>{const s=shape(path);return s?(s.kind==='collection'?['GET','POST']:[s.method]):null;};
async function body(request){
 if(!request.body||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>CNAB_OPERATIONAL_V2_BODY_BYTES))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});const deadline=Date.now()+5000;let source='',total=0,timer,reject;
 const stopped=new Promise((_,no)=>{reject=no;timer=setTimeout(()=>no(new CnabOperationalV2Error(408,'ERP_BODY_TIMEOUT')),5000);});stopped.catch(()=>{});
 const abort=()=>reject(new CnabOperationalV2Error(400,'ERP_REQUEST_ABORTED'));request.signal.addEventListener('abort',abort,{once:true});
 try{for(;;){if(request.signal.aborted)abort();if(Date.now()>=deadline)fail(408,'ERP_BODY_TIMEOUT');const r=await Promise.race([reader.read(),stopped]);if(Date.now()>=deadline)fail(408,'ERP_BODY_TIMEOUT');if(r.done)break;if(!(r.value instanceof Uint8Array)||r.value.byteLength===0)fail();if((total+=r.value.length)>CNAB_OPERATIONAL_V2_BODY_BYTES)fail(413,'ERP_BODY_TOO_LARGE');source+=decoder.decode(r.value,{stream:true});}
  if(length!==null&&Number(length)!==total)fail();return JSON.parse(source+decoder.decode());
 }catch(e){if(e instanceof CnabOperationalV2Error)throw e;fail();}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export async function parseCnabOperationalV2Route(request){
 const url=new URL(request.url);if(!cnabOperationalV2Route(url.pathname))return null;
 const s=shape(url.pathname);if(!s)fail(404,'ERP_NOT_FOUND');if(!cnabOperationalV2Methods(url.pathname).includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(url.hash||request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')fail();
 let route;
 if(request.method==='GET'){
  if(request.body!==null)fail();
  if(s.kind==='collection'){
   for(const k of url.searchParams.keys())if(!['limit','after'].includes(k)||url.searchParams.getAll(k).length!==1)fail();
   const limit=url.searchParams.get('limit')??'25',after=url.searchParams.get('after');
   if(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>30||after!==null&&!id(after))fail();
   route={kind:'files',limit:Number(limit),after:after?.toLowerCase()??null};
  }else{if(url.search)fail();route={kind:s.kind,...(s.id?{id:s.id}:{})};}
 }else{
  if(url.search)fail();const b=await body(request);
  if(s.kind==='approval'){
   const keys=['command_id','expected_approval_version','expected_profile_version','expected_identity_version','enabled','confirmed_on','reference','allowed_encoding_profiles','compatibility_confirmed','permanent_instructions_acknowledged'];
   if(!exact(b,keys)||!id(b.command_id)||!version(b.expected_approval_version,0)||b.expected_approval_version===2147483647||!version(b.expected_profile_version)||b.expected_identity_version!==null&&!version(b.expected_identity_version)||typeof b.enabled!=='boolean'||!day(b.confirmed_on)||!text(b.reference,200)||Array.from(b.reference.replace(/^ +| +$/g,'')).length<3||!b.reference.trim()
    ||!Array.isArray(b.allowed_encoding_profiles)||b.allowed_encoding_profiles.length>(b.enabled?2:0)||b.enabled&&b.allowed_encoding_profiles.length<1||new Set(b.allowed_encoding_profiles).size!==b.allowed_encoding_profiles.length||b.allowed_encoding_profiles.some(x=>!ENCODINGS.includes(x))
    ||b.compatibility_confirmed!==b.allowed_encoding_profiles.includes(ENCODINGS[1])||b.permanent_instructions_acknowledged!==b.compatibility_confirmed)fail();
   route={kind:'approval',id:s.id,body:{...b,command_id:b.command_id.toLowerCase()}};
  }else if(s.kind==='resume'){
   if(!exact(b,['command_id','expected_approval_version','encoding_profile'])||!id(b.command_id)||!version(b.expected_approval_version)||!ENCODINGS.includes(b.encoding_profile))fail();
   route={kind:'resume',id:s.id,body:{...b,command_id:b.command_id.toLowerCase()}};
  }else{
   const preview=s.kind==='preview',keys=['command_id','profile_id','expected_version','expected_approval_version','generated_on','titles','confirm_operational','encoding_profile','confirm_encoding_profile','zero_daily_title_ids',...(!preview?['preview_hash']:[])];
   if(!exact(b,keys)||!id(b.command_id)||!id(b.profile_id)||!version(b.expected_version)||!version(b.expected_approval_version)||!day(b.generated_on)||!ENCODINGS.includes(b.encoding_profile)||b.confirm_operational!==!preview||b.confirm_encoding_profile!==!preview||!preview&&!hash(b.preview_hash)
    ||!Array.isArray(b.titles)||b.titles.length<1||b.titles.length>30||!Array.isArray(b.zero_daily_title_ids)||b.zero_daily_title_ids.length>30||b.zero_daily_title_ids.some(x=>!id(x)))fail();
   const titles=b.titles.map(t=>{if(!exact(t,['title_id','expected_version','document_number'])||!id(t.title_id)||!version(t.expected_version)||typeof t.document_number!=='string'||!/^[A-Z0-9 .&/-]{1,10}$/.test(t.document_number)||t.document_number!==t.document_number.trim())fail();return{...t,title_id:t.title_id.toLowerCase()};});
   const zeros=b.zero_daily_title_ids.map(x=>x.toLowerCase());
   if(new Set(titles.map(t=>t.title_id)).size!==titles.length||new Set(titles.map(t=>t.document_number)).size!==titles.length||new Set(zeros).size!==zeros.length||zeros.some(x=>!titles.some(t=>t.title_id===x))||b.encoding_profile===ENCODINGS[0]&&zeros.length)fail();
   route={kind:preview?'preview':'generate',body:{...b,command_id:b.command_id.toLowerCase(),profile_id:b.profile_id.toLowerCase(),titles,zero_daily_title_ids:zeros}};
  }
 }
 freeze(route);ROUTES.add(route);return route;
}

function approval(v){
 const keys=['profile_id','approval_version','enabled','effective_enabled','profile_version','identity_version','reference','confirmed_on','reviewed_at','issues','allowed_encoding_profiles','encoding_policy'];
 if(!exact(v,keys)||!id(v.profile_id)||!version(v.approval_version,0)||!version(v.profile_version)||v.identity_version!==null&&!version(v.identity_version)||typeof v.enabled!=='boolean'||typeof v.effective_enabled!=='boolean'
  ||!Array.isArray(v.issues)||v.issues.length>ISSUES.length||new Set(v.issues).size!==v.issues.length||v.issues.some(x=>!ISSUES.includes(x))||v.effective_enabled!==(v.issues.length===0)
  ||!Array.isArray(v.allowed_encoding_profiles)||v.allowed_encoding_profiles.length>2||new Set(v.allowed_encoding_profiles).size!==v.allowed_encoding_profiles.length||v.allowed_encoding_profiles.some(x=>!ENCODINGS.includes(x)))bad();
 if(v.approval_version===0){if(v.enabled||v.reference!==null||v.confirmed_on!==null||v.reviewed_at!==null)bad();}
 else if(!text(v.reference,200)||Array.from(v.reference.replace(/^ +| +$/g,'')).length<3||!v.reference.trim()||!day(v.confirmed_on)||!stamp(v.reviewed_at))bad();
 const p=v.encoding_policy;
 if(p===null){if(!equal(v.allowed_encoding_profiles,[ENCODINGS[0]]))bad();}
 else if(!exact(p,['policy_hash','compatibility_confirmed','permanent_instructions_acknowledged'])||!hash(p.policy_hash)
  ||p.compatibility_confirmed!==v.allowed_encoding_profiles.includes(ENCODINGS[1])||p.permanent_instructions_acknowledged!==p.compatibility_confirmed||v.enabled!==!!v.allowed_encoding_profiles.length)bad();
 return pick(v,keys);
}
function profile(v){
 const keys=['id','account_id','account_name','bank','wallet','account_mask','company_name','version','contract_verified','policy_verified','next_sequence'];
 if(!exact(v,keys)||!id(v.id)||!id(v.account_id)||v.bank!=='341'||v.wallet!=='109'||!accountName(v.account_name)||!text(v.account_mask,80)||!text(v.company_name,100)||!version(v.version)||typeof v.contract_verified!=='boolean'||typeof v.policy_verified!=='boolean'||typeof v.next_sequence!=='string'||!/^[1-9][0-9]{0,7}$/.test(v.next_sequence))bad();
 return pick(v,keys);
}
function receipt(v){
 const ready=v?.state==='ready';flags(v,['id','profile_id','sequence','state','encoding_profile','approval_version','replayed',...(ready?['file_hash','byte_size']:[])]);
 if(!id(v.id)||!id(v.profile_id)||!sequence(v.sequence)||!['reserved','ready'].includes(v.state)||!ENCODINGS.includes(v.encoding_profile)||!version(v.approval_version)||typeof v.replayed!=='boolean'||ready&&(!hash(v.file_hash)||!size(v.byte_size)))bad();return v;
}
function current(v){
 const keys=['id','profile_id','state','sequence','encoding_profile','file_hash','byte_size','created_at','finalized_at'];
 if(!exact(v,keys)||!id(v.id)||!id(v.profile_id)||!sequence(v.sequence)||!['reserved','ready'].includes(v.state)||!ENCODINGS.includes(v.encoding_profile)||!stamp(v.created_at)
  ||(v.state==='ready'?(!hash(v.file_hash)||!size(v.byte_size)||!stamp(v.finalized_at)||Date.parse(v.finalized_at)<Date.parse(v.created_at)):(v.file_hash!==null||v.byte_size!==null||v.finalized_at!==null)))bad();return pick(v,keys);
}
function approvalReceipt(v){
 flags(v,['replayed','profile_id','approval']);const a=approval(v.approval);
 if(v.profile_id!==a.profile_id||typeof v.replayed!=='boolean')bad();return{...FLAGS,replayed:v.replayed,profile_id:v.profile_id,approval:a};
}
function command(v,commandId){
 flags(v,['read_only','command_id','kind','receipt','current']);if(v.read_only!==true||v.command_id!==commandId||!['approval','remittance'].includes(v.kind))bad();
 if(v.kind==='approval'){
  const r=approvalReceipt(v.receipt);if(r.replayed!==false||!exact(v.current,['profile_id','approval'])||v.current.profile_id!==r.profile_id)bad();
  const a=approval(v.current.approval);if(a.profile_id!==r.profile_id||a.approval_version<r.approval.approval_version||a.profile_version<r.approval.profile_version)bad();
  if(a.approval_version===r.approval.approval_version&&['enabled','reference','confirmed_on','reviewed_at','allowed_encoding_profiles','encoding_policy'].some(k=>!equal(a[k],r.approval[k])))bad();
  return{...FLAGS,read_only:true,command_id:commandId,kind:v.kind,receipt:r,current:{profile_id:r.profile_id,approval:a}};
 }
 const r=receipt(v.receipt),c=current(v.current);if(r.replayed!==false||['id','profile_id','sequence','encoding_profile'].some(k=>r[k]!==c[k])||r.state==='ready'&&(c.state!=='ready'||r.file_hash!==c.file_hash||r.byte_size!==c.byte_size))bad();
 return{...FLAGS,read_only:true,command_id:commandId,kind:v.kind,receipt:r,current:c};
}
function files(v,route){
 flags(v,['items','limit','has_more','next_cursor']);if(!Array.isArray(v.items)||v.items.length>route.limit||v.limit!==route.limit||typeof v.has_more!=='boolean'||v.has_more&&v.items.length!==route.limit)bad();
 let previous=route.after;
 const items=v.items.map(x=>{
  const keys=['id','profile_id','kind','state','sequence','generated_on','created_at','file_hash','byte_size','titles','filename','encoding_profile'];
  if(!exact(x,keys)||!id(x.id)||!id(x.profile_id)||previous&&x.id<=previous||x.kind!=='remittance'||!['reserved','ready'].includes(x.state)||!sequence(x.sequence)||!day(x.generated_on)||!stamp(x.created_at)||!Number.isInteger(x.titles)||x.titles<1||x.titles>30
   ||x.encoding_profile!==null&&!ENCODINGS.includes(x.encoding_profile)||x.filename!==`ITAU_COBRANCA_${x.sequence.padStart(7,'0')}.REM`
   ||(x.state==='ready'?(!hash(x.file_hash)||!size(x.byte_size)):(x.file_hash!==null||x.byte_size!==null)))bad();previous=x.id;return pick(x,keys);
 });
 if(v.next_cursor!==(v.has_more?items.at(-1)?.id:null))bad();return{...FLAGS,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
}
function checkedSnapshot(raw,allowPending){try{return validateOperationalRemittanceV2(raw,{allowPending});}catch(e){if(e instanceof CnabError)bad();throw e;}}
function preview(v,b){
 flags(v,['snapshot','profile_id','profile_version','preview','preview_hash','preview_items','encoding_profile','can_reserve','pending']);
 if(v.preview!==true||v.profile_id!==b.profile_id||v.profile_version!==b.expected_version||v.encoding_profile!==b.encoding_profile||!hash(v.preview_hash)||!Array.isArray(v.preview_items)||v.preview_items.length!==b.titles.length||!Array.isArray(v.pending))bad();
 const validated=checkedSnapshot(v.snapshot,true),s=validated.snapshot;
 if(s.encoding_profile!==b.encoding_profile||s.operational_authorization.approval_version!==b.expected_approval_version||s.preview_hash!==v.preview_hash||s.generatedOn!==b.generated_on||s.titles.length!==b.titles.length||v.can_reserve!==validated.canReserve)bad();
 const items=v.preview_items.map((x,i)=>{
  const t=s.titles[i],expected=b.titles[i];
  if(!exact(x,['title','finance_title_id','finance_title_version','contact_version','contact_id'])||x.finance_title_id!==expected.title_id||x.finance_title_version!==expected.expected_version||!version(x.contact_version)||!id(x.contact_id))bad();
  const {id:internalId,control,...publicTitle}=t;
  if(!equal(x.title,publicTitle)||t.documentNumber!==expected.document_number||b.encoding_profile===ENCODINGS[1]&&t.encodingTerms.zeroDailyInterestConfirmed!==b.zero_daily_title_ids.includes(expected.title_id))bad();
  const p=t.payer;
  return{title_id:expected.title_id,title_version:expected.expected_version,contact_version:x.contact_version,document_number:t.documentNumber,amount_cents:t.amountCents,issued_on:t.issuedOn,due_on:t.dueOn,
   payer:{name:p.name,document_mask:'*'.repeat(p.document.length-4)+p.document.slice(-4),address:p.address,neighborhood:p.neighborhood,city:p.city,state:p.state,postal_code:p.postalCode},
   ...(b.encoding_profile===ENCODINGS[1]?{encoding_terms:t.encodingTerms}:{})};
 });
 const pending=validated.pending.map(p=>{const index=s.titles.findIndex(t=>t.id===p.title_id);if(index<0)bad();return{code:'ZERO_DAILY_FIELD_UNCONFIRMED',title_id:b.titles[index].title_id};});
 if(!equal(v.pending,pending))bad();
 return{...FLAGS,preview:true,persisted:false,preview_hash:v.preview_hash,profile_id:b.profile_id,profile_version:b.expected_version,approval_version:b.expected_approval_version,
  encoding_profile:b.encoding_profile,encoding_policy_hash:s.encoding_authorization.policy_hash,sequence:s.remittanceSequence,total_cents:validated.totalCents,titles:items.length,items,warnings:validated.warnings,can_reserve:validated.canReserve,pending};
}
const pathFor=(profileId,digest)=>`profiles/${profileId}/remittances/${digest}.rem`;
function file(v,requestedId){
 flags(v,['id','profile_id','hash','size','path','filename','approval_version','encoding_profile']);
 if(v.id!==requestedId||!id(v.profile_id)||!hash(v.hash)||!size(v.size)||v.path!==pathFor(v.profile_id,v.hash)||!version(v.approval_version)||!ENCODINGS.includes(v.encoding_profile)||typeof v.filename!=='string'||!/^ITAU_COBRANCA_[0-9]{7}\.REM$/.test(v.filename))bad();return v;
}
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
async function finalizeCommand(actor,id,approvalVersion){const h=await digest(new TextEncoder().encode(`brufap-cnab-operational-v2:${actor}:${id}:approval:${approvalVersion}`));return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function portOptions(value){
 try{
  if(!object(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad();
  const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d),allowed=['userId','rpc','storeFile','getFile','signal','timeoutMs'];
  if(keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))bad();
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
 }catch{bad();}
}
function errorCode(error){try{const d=Object.getOwnPropertyDescriptor(error,'code');return d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:null;}catch{return null;}}
function scope(signal,timeoutMs){
 const controller=new AbortController(),deadline=Date.now()+timeoutMs;let reject,timedOut=false;
 const stopped=new Promise((_,no)=>{reject=no;});stopped.catch(()=>{});
 const abort=()=>{controller.abort();reject(new CnabOperationalV2Error(400,'ERP_REQUEST_ABORTED'));};
 const timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new CnabOperationalV2Error(504,'ERP_UPSTREAM_TIMEOUT'));},timeoutMs);
 signal?.addEventListener('abort',abort,{once:true});
 const check=()=>{if(timedOut||Date.now()>=deadline)fail(504,'ERP_UPSTREAM_TIMEOUT');if(signal?.aborted||controller.signal.aborted)fail(400,'ERP_REQUEST_ABORTED');};
 return{signal:controller.signal,deadline,check,async call(fn){check();const value=await Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);check();return value;},close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}};
}
async function stored(value,expectedSize,expectedHash,s){
 let bytes;
 if(value instanceof Uint8Array){if(typeof SharedArrayBuffer!=='undefined'&&value.buffer instanceof SharedArrayBuffer||value.byteLength>CNAB_OPERATIONAL_V2_FILE_BYTES)bad();bytes=new Uint8Array(value);}
 else{
  if(!(value instanceof Response)||value.status!==200||value.redirected||!value.body||value.headers.has('content-encoding')&&value.headers.get('content-encoding')!=='identity'){
   if(value instanceof Response)void value.body?.cancel().catch(()=>{});bad();
  }
  const length=value.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)!==expectedSize)){void value.body.cancel().catch(()=>{});bad();}
  const reader=value.body.getReader(),chunks=[];let total=0;
  try{for(;;){const r=await s.call(()=>reader.read());if(r.done)break;if(!(r.value instanceof Uint8Array)||(total+=r.value.length)>expectedSize)bad();chunks.push(new Uint8Array(r.value));}
   bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}for(const chunk of chunks)chunk.fill(0);}
 }
 if(bytes.length!==expectedSize||await s.call(()=>digest(bytes))!==expectedHash){bytes.fill(0);fail(409,'ERP_CNAB_STORED_FILE_MISMATCH');}return bytes;
}

/** RPCs/Storage must be authenticated fixed-destination ports. This module never authenticates the session itself. */
export async function executeCnabOperationalV2Route(route,options={}){
 if(!route||!ROUTES.has(route))fail(404,'ERP_NOT_FOUND');
 const {userId,rpc,storeFile,getFile,signal,timeoutMs=45000}=portOptions(options);
 if(!id(userId))fail(401,'ERP_UNAUTHENTICATED');
 if(typeof rpc!=='function'||signal!==undefined&&!(signal instanceof AbortSignal)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000
  ||['generate','resume'].includes(route.kind)&&(typeof storeFile!=='function'||typeof getFile!=='function')||route.kind==='file'&&typeof getFile!=='function')bad();
 const actor=userId.toLowerCase(),s=scope(signal,timeoutMs);let writeDispatched=false,reservationKnown=false;
 const call=async(name,args={},write=false)=>{
  const data=capture({...args,p_user_id:actor});
  return s.call(async()=>{if(write)writeDispatched=true;return capture(await rpc(name,data,{signal:s.signal,deadline:s.deadline}));});
 };
 const response=body=>{const projected=capture(body,CNAB_OPERATIONAL_V2_RESPONSE_BYTES);return{type:'json',body:projected};};
 try{
  if(route.kind==='profiles'){
   const v=await call('erp_cnab_operational_profiles_v2');flags(v,['items']);if(!Array.isArray(v.items)||v.items.length>100)bad();
   const seen=new Set(),items=v.items.map(x=>{if(!exact(x,['profile','approval']))bad();const p=profile(x.profile),a=approval(x.approval);if(seen.has(p.id)||a.profile_id!==p.id||a.profile_version!==p.version)bad();seen.add(p.id);return{profile:p,approval:a};});return response({...FLAGS,items});
  }
  if(route.kind==='approval'){
   const b=route.body,v=await call('erp_cnab_operational_approve_v2',{p_profile_id:route.id,p_command_id:b.command_id,p_expected_approval:b.expected_approval_version,p_expected_profile:b.expected_profile_version,p_expected_identity:b.expected_identity_version,p_enabled:b.enabled,p_confirmed_on:b.confirmed_on,p_reference:b.reference,p_allowed_encoding_profiles:b.allowed_encoding_profiles,p_compatibility_confirmed:b.compatibility_confirmed,p_permanent_instructions_acknowledged:b.permanent_instructions_acknowledged},true);
   flags(v,['replayed','profile_id','approval']);const a=approval(v.approval);
   if(v.profile_id!==route.id||typeof v.replayed!=='boolean'||a.profile_id!==route.id||a.approval_version!==b.expected_approval_version+1||a.profile_version!==b.expected_profile_version||a.identity_version!==b.expected_identity_version||a.enabled!==b.enabled||a.reference!==b.reference.replace(/^ +| +$/g,'')||a.confirmed_on!==b.confirmed_on||!equal(a.allowed_encoding_profiles,b.allowed_encoding_profiles)||a.encoding_policy?.compatibility_confirmed!==b.compatibility_confirmed||a.encoding_policy?.permanent_instructions_acknowledged!==b.permanent_instructions_acknowledged)bad();
   return response({...FLAGS,replayed:v.replayed,profile_id:route.id,approval:a});
  }
  if(route.kind==='files')return response(files(await call('erp_cnab_operational_files_v2',{p_limit:route.limit,p_after:route.after}),route));
  if(route.kind==='command')return response(command(await call('erp_cnab_operational_command_v2',{p_command_id:route.id}),route.id));
  if(route.kind==='file'){
   const meta=file(await call('erp_cnab_operational_file_v2',{p_id:route.id}),route.id);
   const bytes=await stored(await s.call(()=>getFile({bucket:'brufap-cnab',path:meta.path,signal:s.signal},{signal:s.signal,deadline:s.deadline})),meta.size,meta.hash,s);
   try{const now=file(await call('erp_cnab_operational_file_v2',{p_id:route.id}),route.id);if(!equal(meta,now))fail(409,'ERP_CNAB_OPERATIONAL_CONTEXT_CHANGED');return{type:'download',bytes,filename:meta.filename,contentType:'application/octet-stream'};}
   catch(e){bytes.fill(0);throw e;}
  }
  const b=route.body,expected=b.expected_approval_version;
  let reserved;
  if(route.kind!=='resume'){
   const v=await call('erp_cnab_operational_reserve_v2',{p_command_id:b.command_id,p_profile_id:b.profile_id,p_expected_version:b.expected_version,p_expected_approval:expected,p_generated_on:b.generated_on,p_titles:b.titles,p_confirm_operational:b.confirm_operational,p_preview:route.kind==='preview',p_preview_hash:route.kind==='preview'?null:b.preview_hash,p_encoding_profile:b.encoding_profile,p_confirm_encoding_profile:b.confirm_encoding_profile,p_zero_daily_title_ids:b.zero_daily_title_ids},route.kind==='generate');
   if(route.kind==='preview')return response(preview(v,b));
   reserved=receipt(v);reservationKnown=true;
   if(reserved.state!=='reserved'||reserved.profile_id!==b.profile_id||reserved.encoding_profile!==b.encoding_profile||reserved.approval_version!==expected)bad();
  }
  const reservationId=reserved?.id??route.id,r=await call('erp_cnab_operational_reservation_v2',{p_id:reservationId,p_expected_approval:expected});
  flags(r,['id','profile_id','state','snapshot','file_hash','object_path','byte_size','approval_version','encoding_profile']);
  if(r.id!==reservationId||!id(r.profile_id)||reserved&&r.profile_id!==reserved.profile_id||!['reserved','ready'].includes(r.state)||r.approval_version!==expected||r.encoding_profile!==b.encoding_profile)bad();
  reservationKnown=true;
  const checked=checkedSnapshot(r.snapshot,false),snapshot=checked.snapshot;
  if(snapshot.encoding_profile!==r.encoding_profile||snapshot.operational_authorization.approval_version>expected||reserved&&snapshot.operational_authorization.approval_version!==expected
   ||reserved&&(snapshot.preview_hash!==b.preview_hash||snapshot.generatedOn!==b.generated_on||snapshot.remittanceSequence!==reserved.sequence||snapshot.titles.length!==b.titles.length||snapshot.titles.some((t,i)=>t.documentNumber!==b.titles[i].document_number||b.encoding_profile===ENCODINGS[1]&&t.encodingTerms.zeroDailyInterestConfirmed!==b.zero_daily_title_ids.includes(b.titles[i].title_id))))bad();
  if(r.state==='reserved'&&(r.file_hash!==null||r.object_path!==null||r.byte_size!==null))bad();
  const generated=await s.call(()=>generateOperationalRemittanceV2(snapshot)),path=pathFor(r.profile_id,generated.fileHash);
  if(!size(generated.bytes.length)||r.state==='ready'&&(r.file_hash!==generated.fileHash||r.byte_size!==generated.bytes.length||r.object_path!==path))bad();
  if(r.state!=='ready'){
   const copy=new Uint8Array(generated.bytes);
   await s.call(async()=>{writeDispatched=true;try{return await storeFile({bucket:'brufap-cnab',path,bytes:copy,upsert:false,signal:s.signal},{signal:s.signal,deadline:s.deadline});}finally{copy.fill(0);}});
  }
  const readback=await stored(await s.call(()=>getFile({bucket:'brufap-cnab',path,signal:s.signal},{signal:s.signal,deadline:s.deadline})),generated.bytes.length,generated.fileHash,s);readback.fill(0);
  const finalCommand=route.kind==='resume'?b.command_id:await s.call(()=>finalizeCommand(actor,r.id,expected));
  const final=receipt(await call('erp_cnab_operational_finalize_v2',{p_id:r.id,p_command_id:finalCommand,p_hash:generated.fileHash,p_size:generated.bytes.length,p_path:path,p_manifest:generated.manifest,p_expected_approval:expected},true));
  if(final.state!=='ready'||final.id!==r.id||final.profile_id!==r.profile_id||final.sequence!==snapshot.remittanceSequence||final.encoding_profile!==snapshot.encoding_profile||final.approval_version!==expected||final.file_hash!==generated.fileHash||final.byte_size!==generated.bytes.length)bad();
  return response({...final,command_id:b.command_id,filename:generated.filename,warnings:generated.warnings});
 }catch(e){
  const codes={ERP_FORBIDDEN:[403,'ERP_FORBIDDEN'],ERP_INVALID_QUERY:[400,'ERP_CNAB_OPERATIONAL_V2_INVALID_INPUT'],ERP_NOT_FOUND:[404,'ERP_NOT_FOUND'],ERP_CONFLICT:[409,'ERP_CONFLICT'],'42501':[403,'ERP_FORBIDDEN'],'22023':[400,'ERP_CNAB_OPERATIONAL_V2_INVALID_INPUT'],'P0002':[404,'ERP_NOT_FOUND'],'40001':[409,'ERP_CONFLICT'],'23505':[409,'ERP_CONFLICT'],'55000':[409,'ERP_CONFLICT']},code=errorCode(e),known=Object.hasOwn(codes,code)?codes[code]:null;
  // Once a reservation was acknowledged, a later rejection cannot erase that committed command.
  if(reservationKnown||writeDispatched&&!known)fail(503,'ERP_RESULT_UNCONFIRMED');
  if(known)fail(...known);if(e instanceof CnabOperationalV2Error)throw e;
  fail(502,'ERP_UPSTREAM_UNAVAILABLE');
 }finally{s.close();}
}
