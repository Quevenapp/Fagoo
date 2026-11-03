/** Human review of canonical return events. This boundary never posts to the financial ledger. */
import {parseReturn,CnabError} from '../../../packages/cnab-core/src/index.mjs';
const PREFIX='/v1/conferencia-retornos',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const SAFETY=Object.freeze({purpose:'homologation',productionReady:false,canSettle:false,financialMutationPerformed:false,originAuthenticated:false});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&UUID.test(v),digest=v=>typeof v==='string'&&HASH.test(v);
const text=(v,n)=>typeof v==='string'&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const version=v=>integer(v,1,2147483647),line=v=>integer(v,2,9999);
const cents=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,14})$/.test(v);
const bool=v=>typeof v==='boolean',nullable=(v,check)=>v===null||check(v);
const day=v=>text(v,10)&&/^(19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const timestamp=v=>text(v,100)&&Number.isFinite(Date.parse(v));
const pick=(v,keys)=>Object.fromEntries(keys.map(key=>[key,v[key]]));
const code=v=>typeof v==='string'&&/^[A-Z0-9_]{1,100}$/.test(v);
const WARNINGS=v=>Array.isArray(v)&&v.length<=30&&v.every(code);
export class CnabReviewError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new CnabReviewError(400,'ERP_CNAB_REVIEW_INVALID_INPUT');};
const bad=()=>{throw new CnabReviewError(502,'ERP_CNAB_REVIEW_INVALID_RESPONSE');};
const mismatch=()=>{throw new CnabReviewError(409,'ERP_CNAB_REVIEW_FILE_MISMATCH');};
const exact=(v,keys)=>{if(!object(v)||Object.keys(v).some(key=>!keys.includes(key)))invalid();};
function safeEnvelope(value){if(!object(value)||Object.entries(SAFETY).some(([key,v])=>value[key]!==v))bad();}
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')||!request.body||Number(request.headers.get('Content-Length'))>8192)invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,value='',timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CnabReviewError(408,'ERP_CNAB_REVIEW_TIMEOUT')),10000);});
 try{while(true){const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192)invalid();value+=decoder.decode(chunk.value,{stream:true});}return JSON.parse(value+decoder.decode());}
 catch(error){if(error instanceof CnabReviewError)throw error;invalid();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function cnabReviewMethods(path){return /\/(preview|review)$/.test(path)?['POST']:['GET'];}
export async function parseCnabReviewRoute(request){
 const url=new URL(request.url);if(url.pathname!==PREFIX&&!url.pathname.startsWith(`${PREFIX}/`))return null;
 const match=/^\/v1\/conferencia-retornos\/(files|events)\/([a-f0-9-]+)(?:\/(history|preview|review))?$/i.exec(url.pathname);
 if(!match||!id(match[2])||!['files','events'].includes(match[1])||(match[1]==='files'&&match[3]))throw new CnabReviewError(404,'ERP_NOT_FOUND');
 if(!cnabReviewMethods(url.pathname).includes(request.method))throw new CnabReviewError(405,'ERP_METHOD_NOT_ALLOWED');
 const operation=match[1]==='files'?'list':match[3]||'get',args=match[1]==='files'?{p_file_id:match[2].toLowerCase()}:{p_event_id:match[2].toLowerCase()};
 if(request.method==='GET'){
  const allowed=operation==='get'?['file_id','line']:operation==='history'?['limit','before']:['limit','after'];
  for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)invalid();
  if(operation==='get'){
   const fileId=url.searchParams.get('file_id'),n=url.searchParams.get('line');
   if(!id(fileId)||!/^\d{1,4}$/.test(n||'')||!line(Number(n)))invalid();args.p_file_id=fileId.toLowerCase();args.p_line=Number(n);
  }else{
   const n=url.searchParams.get('limit')??'25',cursor=url.searchParams.get(operation==='history'?'before':'after');
   if(!/^\d{1,3}$/.test(n)||!integer(Number(n),1,100)||(cursor!==null&&(!/^[1-9][0-9]{0,9}$/.test(cursor)||!integer(Number(cursor),1,operation==='history'?2147483647:10000))))invalid();
   args.p_limit=Number(n);args[operation==='history'?'p_before':'p_after']=cursor===null?(operation==='history'?null:1):Number(cursor);
  }
 }else{
  if(url.search)invalid();const data=await body(request);
  exact(data,operation==='preview'?['file_id','line']:['file_id','line','command_id','expected_review_version','expected_context_hash','status','reason']);
  if(!id(data.file_id)||!line(data.line))invalid();args.p_file_id=data.file_id.toLowerCase();args.p_line=data.line;
  if(operation==='review'){
   if(!id(data.command_id)||!integer(data.expected_review_version,0,2147483646)||!digest(data.expected_context_hash)
    ||!['confirmed','pending_issue'].includes(data.status)||!text(data.reason,1000)||data.reason.trim().length<3)invalid();
   Object.assign(args,{p_command_id:data.command_id.toLowerCase(),p_expected_review_version:data.expected_review_version,
    p_expected_context_hash:data.expected_context_hash,p_status:data.status,p_reason:data.reason});
  }
 }
 return {operation,rpc:`erp_cnab_human_review_${operation==='review'?'save':operation}`,args};
}
function context(v){
 if(!object(v)||v.version!==1||!object(v.event)||!object(v.occurrence)||!object(v.profile)||!object(v.proposal)||!object(v.comparison))bad();
 const e=v.event,o=v.occurrence,p=v.profile,c=v.comparison;
 if(!id(e.id)||!digest(e.hash)||!['341','077'].includes(e.bank)||!(e.bank==='341'?e.wallet==='109':['110','112'].includes(e.wallet))
  ||!text(e.control,25)||!text(e.document_number,10)||!nullable(e.our_number,x=>text(x,20))||!/^\d{2}$/.test(e.occurrence||'')||!code(e.kind)
  ||!nullable(e.due_on,day)||!day(e.occurred_on)||!nullable(e.credited_on,day)||!cents(e.amount_cents)||!cents(e.paid_cents)||!WARNINGS(e.warnings))bad();
 const adjustmentKeys=['fee','iof','abatement','discount','interest','otherCredits'];
 if(e.adjustments!==null&&(!object(e.adjustments)||Object.keys(e.adjustments).length!==6||adjustmentKeys.some(key=>!cents(e.adjustments[key]))))bad();
 if((e.bank==='341')!==(e.adjustments!==null)||!id(o.file_id)||!digest(o.file_hash)||!line(o.line)||!digest(o.line_hash)||!bool(o.duplicate)||!day(o.generated_on)
  ||!bool(o.declared_bank_origin)||!(o.declared_bank_origin?typeof o.reference_id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(o.reference_id):o.reference_id===null)||!WARNINGS(o.warnings))bad();
 if(!id(p.id)||!version(p.version)||p.bank!==e.bank||p.wallet!==e.wallet||!id(p.account_id)||!text(p.account_name,200)||!/^\*{3}\d{3}$/.test(p.account_mask||'')
  ||!version(p.account_version)||!bool(p.account_active)||!bool(p.contract_verified)||!bool(p.policy_verified))bad();
 let billing=null,title=null;
 if(v.billing!==null){const b=v.billing;if(!object(b)||!id(b.id)||!id(b.remittance_id)||!['reserved','ready'].includes(b.remittance_state)||!text(b.control,25)||!text(b.document_number,10)||!nullable(b.our_number,x=>text(x,20)))bad();billing=pick(b,['id','remittance_id','remittance_state','control','document_number','our_number']);}
 if(v.title!==null){const t=v.title;if(!object(t)||!id(t.id)||!version(t.version)||!['receivable','payable'].includes(t.kind)||!text(t.description,240)||!day(t.issued_on)||!day(t.due_on)||t.due_on<t.issued_on
   ||!cents(t.amount_cents)||BigInt(t.amount_cents)===0n||!cents(t.settled_cents)||!cents(t.balance_cents)||BigInt(t.amount_cents)!==BigInt(t.settled_cents)+BigInt(t.balance_cents)||!bool(t.cancelled))bad();
  title=pick(t,['id','version','kind','description','issued_on','due_on','amount_cents','settled_cents','balance_cents','cancelled']);}
 if((billing===null)!==(title===null)||!bool(c.source_linked)||c.source_linked!==(billing!==null)||!bool(c.has_adjustments)||!code(c.reason)
  ||!['REVIEW','SKIP','PROPOSE_BANK_NUMBER_BINDING_REVIEW','PROPOSE_SETTLEMENT_REVIEW'].includes(v.proposal.action)||!code(v.proposal.reason))bad();
 const comparisons=['reference_matches','bank_number_matches','amount_matches','due_matches','fully_open','paid_matches_balance'];
 if(comparisons.some(key=>c.source_linked?!bool(c[key]):c[key]!==null))bad();
 const calculated={has_adjustments:e.adjustments!==null&&Object.values(e.adjustments).some(x=>x!=='0')};
 if(billing&&title)Object.assign(calculated,{reference_matches:billing.control===e.control&&billing.document_number===e.document_number,
  bank_number_matches:billing.our_number!==null&&billing.our_number===e.our_number,amount_matches:title.amount_cents===e.amount_cents,
  due_matches:title.due_on===e.due_on,fully_open:!title.cancelled&&title.settled_cents==='0',paid_matches_balance:title.balance_cents===e.paid_cents});
 if(Object.entries(calculated).some(([key,val])=>c[key]!==val))bad();
 const expectedReason=!billing?'UNLINKED_EVENT':!calculated.reference_matches?'REFERENCE_CHANGED':billing.our_number===null?'BANK_NUMBER_UNBOUND'
  :!calculated.bank_number_matches?'BANK_NUMBER_CHANGED':!calculated.amount_matches||!calculated.due_matches?'TITLE_AMOUNT_OR_DUE_DATE_CHANGED'
  :e.kind!=='PAID'?'NON_PAYMENT_EVENT':!calculated.fully_open?'TITLE_NOT_FULLY_OPEN':!e.credited_on||!e.occurred_on?'PAYMENT_DATES_MISSING'
  :!calculated.paid_matches_balance||calculated.has_adjustments?'PAYMENT_AMOUNTS_REQUIRE_REVIEW'
  :o.warnings.includes('INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION')?'TRAILER_AGGREGATE_REQUIRES_REVIEW'
  :!o.declared_bank_origin?'BANK_ORIGIN_DECLARATION_MISSING':billing.remittance_state!=='ready'?'REMITTANCE_NOT_READY'
  :!p.account_active?'ACCOUNT_INACTIVE':'EXACT_MATCH_HOMOLOGATION_ONLY';
 if(c.reason!==expectedReason)bad();
 return {version:1,event:{...pick(e,['id','hash','bank','wallet','control','document_number','our_number','occurrence','kind','due_on','occurred_on','credited_on','amount_cents','paid_cents','warnings']),adjustments:e.adjustments===null?null:pick(e.adjustments,adjustmentKeys)},
  occurrence:pick(o,['file_id','file_hash','line','line_hash','duplicate','generated_on','declared_bank_origin','reference_id','warnings']),
  profile:pick(p,['id','version','bank','wallet','account_id','account_name','account_mask','account_version','account_active','contract_verified','policy_verified']),
  billing,title,proposal:pick(v.proposal,['action','reason']),comparison:pick(c,['source_linked',...comparisons,'has_adjustments','reason'])};
}
function revision(v,eventId){
 if(!object(v)||v.event_id!==eventId||!version(v.version)||!['confirmed','pending_issue'].includes(v.status)||!text(v.reason,1000)||v.reason.trim().length<3||!digest(v.context_hash)||!timestamp(v.reviewed_at))bad();
 const c=context(v.context);if(c.event.id!==eventId)bad();
 return {...pick(v,['event_id','version','status','reason','context_hash','reviewed_at']),context:c};
}
function detail(v,args){
 safeEnvelope(v);if(v.event_id!==args.p_event_id||!digest(v.context_hash)||!integer(v.review_version,0,2147483647)||v.bytes_verified!==false)bad();
 const c=context(v.context);if(c.event.id!==args.p_event_id||c.occurrence.file_id!==args.p_file_id||c.occurrence.line!==args.p_line)bad();
 let review=null;
 if(v.review!==null){review=revision(v.review,args.p_event_id);if(review.version!==v.review_version||v.review.context_changed!==(review.context_hash!==v.context_hash))bad();review.context_changed=v.review.context_changed;}
 else if(v.review_version!==0)bad();
 return {...SAFETY,event_id:v.event_id,context_hash:v.context_hash,review_version:v.review_version,context:c,review,bytes_verified:false};
}
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
async function sha(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
async function privateBytes(source,size){
 if(source instanceof Uint8Array){if(source.length!==size)mismatch();return source;}
 if(!(source instanceof Response)||!source.ok||source.redirected||!source.body||Number(source.headers.get('Content-Length'))>4020000)bad();
 const reader=source.body.getReader(),parts=[];let total=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CnabReviewError(504,'ERP_CNAB_REVIEW_TIMEOUT')),20000);});
 try{while(true){const row=await Promise.race([reader.read(),deadline]);if(row.done)break;total+=row.value.byteLength;if(total>size||total>4020000)mismatch();parts.push(row.value);}if(total!==size)mismatch();
  const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function verify(route,call,getFile){
 if(typeof getFile!=='function')throw new CnabReviewError(503,'ERP_CNAB_REVIEW_STORAGE_UNAVAILABLE');
 const args=pick(route.args,['p_event_id','p_file_id','p_line']),v=await call('erp_cnab_human_review_verify',args);
 if(!object(v)||!object(v.file)||!object(v.profile)||!object(v.payload))bad();const d=detail(v.detail,args),f=v.file;
 const expected=`profiles/${d.context.profile.id}/returns/${d.context.occurrence.file_hash}.ret`;
 if(f.id!==args.p_file_id||f.profile_id!==d.context.profile.id||f.hash!==d.context.occurrence.file_hash||f.path!==expected||!integer(f.size,1,4020000)||![1900,2000,2100].includes(f.century)||v.profile.accountId!==d.context.profile.account_id)bad();
 const bytes=await privateBytes(await getFile({bucket:'brufap-cnab',path:expected}),f.size);if(await sha(bytes)!==f.hash)mismatch();
 let parsed;try{parsed=await parseReturn(bytes,{profile:v.profile,century:f.century});}catch(error){if(error instanceof CnabError)mismatch();throw error;}
 const event=parsed.events.find(item=>item.line===args.p_line);
 if(!event||event.eventHash!==d.context.event.hash||event.lineHash!==d.context.occurrence.line_hash||parsed.fileHash!==f.hash)mismatch();
 const {eventHash,lineHash,line:lineNumber,...payload}=event;
 if(canonical(payload)!==canonical(v.payload))mismatch();
 const projectedEvent={id:args.p_event_id,hash:eventHash,bank:event.bank,wallet:event.wallet,control:event.control,document_number:event.documentNumber,
  our_number:event.ourNumber,occurrence:event.occurrence,kind:event.kind,due_on:event.dueDate,occurred_on:event.occurrenceDate,credited_on:event.creditDate,
  amount_cents:event.amountCents,paid_cents:event.paidCents,adjustments:event.adjustments,warnings:event.warnings};
 if(canonical(projectedEvent)!==canonical(d.context.event)||parsed.generatedOn!==d.context.occurrence.generated_on
  ||canonical(parsed.warnings)!==canonical(d.context.occurrence.warnings)||d.context.profile.account_mask!==`***${v.profile.account.slice(-3)}`)mismatch();
 return {...d,bytes_verified:true};
}
export async function executeCnabReviewRoute(route,{userId,rpc,getFile}){
 if(!id(userId))throw new CnabReviewError(401,'ERP_UNAUTHENTICATED');
 const call=(name,args)=>rpc(name,{...args,p_user_id:userId});
 if(route.operation==='preview')return verify(route,call,getFile);
 if(route.operation==='review')await verify(route,call,getFile);
 const v=await call(route.rpc,route.args);safeEnvelope(v);
 if(route.operation==='get')return detail(v,route.args);
 if(route.operation==='review'){
  if(v.event_id!==route.args.p_event_id||!bool(v.replayed))bad();const r=revision(v.record,route.args.p_event_id);
  // PostgreSQL btrim(text) removes ASCII spaces, not Unicode whitespace.
  if(r.version!==route.args.p_expected_review_version+1||r.status!==route.args.p_status||r.reason!==route.args.p_reason.replace(/^ +| +$/g,'')||r.context_hash!==route.args.p_expected_context_hash
   ||r.context.occurrence.file_id!==route.args.p_file_id||r.context.occurrence.line!==route.args.p_line)bad();
  return {...SAFETY,event_id:v.event_id,record:r,replayed:v.replayed};
 }
 if(!Array.isArray(v.items)||v.items.length>route.args.p_limit||v.limit!==route.args.p_limit||!bool(v.has_more)||(v.has_more?!integer(v.next_cursor,1,2147483647):v.next_cursor!==null)||v.has_more&&v.items.length!==route.args.p_limit)bad();
 if(route.operation==='history'){
  if(v.event_id!==route.args.p_event_id)bad();const items=v.items.map(row=>revision(row,v.event_id));let previous=route.args.p_before??2147483648;
  for(const r of items){if(r.version>=previous)bad();previous=r.version;}if(v.has_more&&v.next_cursor!==previous)bad();
  return {...SAFETY,event_id:v.event_id,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
 }
 if(route.operation!=='list'||v.file_id!==route.args.p_file_id)bad();let previous=route.args.p_after;
 const items=v.items.map(row=>{
  if(!object(row)||!line(row.line)||row.line<=previous||!id(row.event_id)||!digest(row.event_hash)||!bool(row.duplicate)||!code(row.kind)||!text(row.control,25)||!text(row.document_number,10)||!cents(row.amount_cents)||!cents(row.paid_cents)
   ||!integer(row.review_version,0,2147483647)||!(row.review_version===0?row.review_status==='pending':['confirmed','pending_issue'].includes(row.review_status))||!bool(row.context_changed)||(row.review_version===0&&row.context_changed))bad();previous=row.line;
  return pick(row,['line','event_id','event_hash','duplicate','kind','control','document_number','amount_cents','paid_cents','review_version','review_status','context_changed']);
 });
 if(v.has_more&&v.next_cursor!==previous)bad();return {...SAFETY,file_id:v.file_id,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
}
