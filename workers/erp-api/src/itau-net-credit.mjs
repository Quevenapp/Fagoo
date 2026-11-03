/** Explicit058 adapter. No account/date/money is accepted from the browser. */
import { executeCnabReturnsRoute, projectCnabReturnContext } from './cnab-returns.mjs';
import { planItau109NetCredit, ITAU_NET_CREDIT_POLICY as POLICY } from '../../../packages/cnab-core/src/itau-net-credit.mjs';
const PREFIX='/v1/retornos-itau109', routes=new WeakSet();
export const ITAU_NET_CREDIT_RESPONSE_BYTES=262144;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, HASH=/^[a-f0-9]{64}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v), id=v=>typeof v==='string'&&UUID.test(v), hash=v=>typeof v==='string'&&HASH.test(v);
const integer=(v,min=1,max=2147483647)=>Number.isInteger(v)&&v>=min&&v<=max;
const cents=v=>typeof v==='string'&&/^(0|[1-9]\d{0,14})$/.test(v), signed=v=>typeof v==='string'&&/^-?(0|[1-9]\d{0,18})$/.test(v);
const text=(v,max)=>typeof v==='string'&&Array.from(v).length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const date=v=>typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const financeDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2100-12-31'&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return(!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const canonical=v=>JSON.stringify(v&&typeof v==='object'?(Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))]))):v);
const same=(a,b)=>canonical(a)===canonical(b);
export const ITAU_NET_CREDIT_FLAGS=Object.freeze({policy:POLICY,purpose:'operational',originAuthenticated:false,bankTransmissionPerformed:false});
export class ItauNetCreditError extends Error {constructor(status,code){super(code);this.name='ItauNetCreditError';this.status=status;this.code=code;}}
const invalid=()=>{throw new ItauNetCreditError(400,'ERP_ITAU_NET_CREDIT_INVALID_INPUT');};
const bad=()=>{throw new ItauNetCreditError(502,'ERP_ITAU_NET_CREDIT_INVALID_RESPONSE');};
const exact=(v,keys)=>{if(!object(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))invalid();};
function flags(v){if(!object(v)||Object.entries(ITAU_NET_CREDIT_FLAGS).some(([k,x])=>v[k]!==x))bad();}
function scope(signal,milliseconds=40000){
 const c=new AbortController();let reject;const stopped=new Promise((_,r)=>{reject=r;});stopped.catch(()=>{});
 const abort=()=>{c.abort();reject(new ItauNetCreditError(503,'ERP_ITAU_NET_CREDIT_UNAVAILABLE'));};
 const timer=setTimeout(abort,milliseconds);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 return{signal:c.signal,run:async fn=>{if(c.signal.aborted)throw new ItauNetCreditError(503,'ERP_ITAU_NET_CREDIT_UNAVAILABLE');const v=await Promise.race([Promise.resolve().then(fn),stopped]);if(c.signal.aborted)throw new ItauNetCreditError(503,'ERP_ITAU_NET_CREDIT_UNAVAILABLE');return v;},close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);c.abort();}};
}
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!['','identity'].includes(request.headers.get('content-encoding')||'')||!request.body||Number(request.headers.get('content-length'))>8192)invalid();
 const s=scope(request.signal,10000),reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let n=0,out='';
 try{while(true){const r=await s.run(()=>reader.read());if(r.done)break;n+=r.value.length;if(n>8192)invalid();out+=decoder.decode(r.value,{stream:true});}return JSON.parse(out+decoder.decode());}
 catch(e){if(e instanceof ItauNetCreditError)throw e;invalid();}finally{s.close();void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export function itauNetCreditMethods(path){return /\/events\/[^/]+\/(preview|settle)$/.test(path)?['POST']:['GET'];}
export async function parseItauNetCreditRoute(request){
 const u=new URL(request.url);if(u.pathname!==PREFIX&&!u.pathname.startsWith(PREFIX+'/'))return null;
 if(u.hash||u.search)invalid();if(!itauNetCreditMethods(u.pathname).includes(request.method))throw new ItauNetCreditError(405,'ERP_METHOD_NOT_ALLOWED');
 let route;const command=new RegExp(`^${PREFIX}/commands/([^/]+)$`).exec(u.pathname),event=new RegExp(`^${PREFIX}/events/([^/]+)/(preview|settle)$`).exec(u.pathname);
 if(command&&id(command[1]))route={kind:'command',args:Object.freeze({p_command_id:command[1].toLowerCase()}),signal:request.signal};
 else if(event&&id(event[1])){
  const b=await body(request),keys=['file_id','line','fee_category_id','expected_fee_category_version'];
  exact(b,event[2]==='preview'?keys:[...keys,'command_id','expected_approval_version','context_hash','confirm']);
  if(!id(b.file_id)||!integer(b.line,2,9999)||!id(b.fee_category_id)||!integer(b.expected_fee_category_version))invalid();
  const args={p_event_id:event[1].toLowerCase(),p_file_id:b.file_id.toLowerCase(),p_line:b.line,p_fee_category_id:b.fee_category_id.toLowerCase(),p_expected_fee_category_version:b.expected_fee_category_version};
  if(event[2]==='settle'){if(!id(b.command_id)||!integer(b.expected_approval_version)||!hash(b.context_hash)||b.confirm!==true)invalid();Object.assign(args,{p_command_id:b.command_id.toLowerCase(),p_expected_approval:b.expected_approval_version,p_context_hash:b.context_hash,p_confirm:true});}
  route={kind:event[2],args:Object.freeze(args),signal:request.signal};
 }else throw new ItauNetCreditError(404,'ERP_NOT_FOUND');
 Object.freeze(route);routes.add(route);return route;
}
function plan(base,category,version){try{return planItau109NetCredit({bank:base.event.bank,wallet:base.event.wallet,nominal_cents:base.event.amount_cents,credited_cents:base.event.paid_cents,adjustments:base.event.adjustments,fee_category:category,expected_fee_category_version:version});}catch{bad();}}
export function projectItauNetCreditPreview(v,args){
 flags(v);if(v.productionReady!==false||v.financialMutationPerformed!==false||v.bytes_verified!==false||v.event_id!==args.p_event_id||!hash(v.context_hash)||!object(v.context))bad();
 const c=v.context;if(c.policy!==POLICY||!object(c.category_selection)||c.category_selection.id!==args.p_fee_category_id||c.category_selection.expected_version!==args.p_expected_fee_category_version)bad();
 let b;try{b=projectCnabReturnContext(c.base);}catch{bad();}
 if(b.event.id!==args.p_event_id||b.file.id!==args.p_file_id||b.file.line!==args.p_line)bad();
 const cat=c.category===null?null:pick(c.category,['id','version','name','kind','active']);if(cat&&cat.id!==args.p_fee_category_id)bad();
 const expected=plan(b,cat,args.p_expected_fee_category_version),issues=[...b.settlement.issues.filter(x=>!['PAYMENT_AMOUNT_DIFFERS','PAYMENT_ADJUSTMENTS_UNSUPPORTED'].includes(x)),...expected.issues];
 if(!same(expected,c.plan)||!same(c.settlement,{allowed:issues.length===0,issues}))bad();
 return{...ITAU_NET_CREDIT_FLAGS,productionReady:false,financialMutationPerformed:false,event_id:v.event_id,context_hash:v.context_hash,bytes_verified:false,
  context:{policy:POLICY,base:b,category_selection:pick(c.category_selection,['id','expected_version']),category:cat,plan:expected,settlement:{allowed:issues.length===0,issues}}};
}
function posting(value){
 if(!object(value)||!object(value.fee_category)||!cents(value.principal_cents)||!cents(value.fee_cents)||!cents(value.net_cash_cents))bad();
 const cat=value.fee_category;const p=plan({event:{bank:'341',wallet:'109',amount_cents:value.principal_cents,paid_cents:value.net_cash_cents,adjustments:{fee:value.fee_cents,iof:'0',abatement:'0',discount:'0',interest:'0',otherCredits:'0'}}},{...pick(cat,['id','version','name','kind']),active:true},cat.version);
 if(!p.posting||!same(p.posting,value))bad();return p.posting;
}
export function projectItauNetCreditReceipt(r){
 if(!object(r)||r.policy!==POLICY)bad();for(const k of['command_id','event_id','file_id','profile_id','billing_title_id','title_id','account_id','settlement_id'])if(!id(r[k]))bad();
 for(const k of['event_hash','file_hash','context_hash'])if(!hash(r[k]))bad();
 if(!integer(r.line,2,9999)||!integer(r.approval_version)||!date(r.posted_on)||!stamp(r.created_at)||!Array.isArray(r.movements)||r.movements.length!==2)bad();
 const p=posting(r.posting),movements=r.movements.map((m,i)=>{if(!object(m)||!id(m.id)||m.kind!==p.legs[i].kind||m.delta_cents!==p.legs[i].delta_cents)bad();return pick(m,['id','kind','delta_cents']);});
 if(movements[0].id===movements[1].id)bad();return{...pick(r,['policy','command_id','event_id','event_hash','file_id','file_hash','line','profile_id','approval_version','context_hash','billing_title_id','title_id','account_id','settlement_id','posted_on','created_at']),posting:p,movements};
}
function readback(v,command){
 flags(v);if(v.read_only!==true||v.financialMutationPerformed!==false)bad();const r=projectItauNetCreditReceipt(v.receipt),t=v.current_title,a=v.current_account,s=v.current_settlement,p=r.posting;
 if(r.command_id!==command||!object(t)||t.id!==r.title_id||!integer(t.version)||!text(t.description,240)||!financeDate(t.due_on)||!cents(t.amount_cents)||!cents(t.settled_cents)||!cents(t.balance_cents)||BigInt(t.amount_cents)!==BigInt(t.settled_cents)+BigInt(t.balance_cents)||!['open','partial','paid','cancelled'].includes(t.status)||typeof t.cancelled!=='boolean'
  ||!object(a)||a.id!==r.account_id||!integer(a.version)||!text(a.name,200)||typeof a.active!=='boolean'||!signed(a.balance_cents)
  ||!object(s)||s.id!==r.settlement_id||s.title_id!==r.title_id||s.account_id!==r.account_id||s.kind!=='payment'||s.principal_cents!==p.principal_cents||s.net_cash_cents!==p.net_cash_cents||s.fee_cents!==p.fee_cents||s.interest_cents!=='0'||s.penalty_cents!=='0'||s.discount_cents!=='0'||s.posted_on!==r.posted_on||typeof s.reversed!=='boolean')bad();
 return{...ITAU_NET_CREDIT_FLAGS,read_only:true,financialMutationPerformed:false,receipt:r,current_title:pick(t,['id','version','description','due_on','amount_cents','settled_cents','balance_cents','status','cancelled']),current_account:pick(a,['id','version','name','active','balance_cents']),current_settlement:pick(s,['id','title_id','account_id','kind','posted_on','principal_cents','interest_cents','penalty_cents','discount_cents','fee_cents','net_cash_cents','reversed'])};
}
function error(e,dispatched){
 const code=e?.code,status=e?.status;const sql={'22023':[400,'ERP_INVALID_QUERY'],'42501':[403,'ERP_FORBIDDEN'],'P0002':[404,'ERP_NOT_FOUND'],'40001':[409,'ERP_CONFLICT'],'55000':[409,'ERP_CONFLICT']};
 if(sql[code])return new ItauNetCreditError(...sql[code]);
 if([400,401,403,404,409].includes(status)&&!(e instanceof ItauNetCreditError&&e.code==='ERP_ITAU_NET_CREDIT_INVALID_RESPONSE'))return new ItauNetCreditError(status,({400:'ERP_INVALID_QUERY',401:'ERP_UNAUTHENTICATED',403:'ERP_FORBIDDEN',404:'ERP_NOT_FOUND',409:'ERP_CONFLICT'})[status]);
 if(dispatched)return new ItauNetCreditError(503,'ERP_RESULT_UNCONFIRMED');
 return e instanceof ItauNetCreditError?e:new ItauNetCreditError(502,'ERP_UPSTREAM_UNAVAILABLE');
}
export async function executeItauNetCreditRoute(route,{userId,rpc,getFile}){
 if(!routes.has(route))invalid();if(!id(userId))throw new ItauNetCreditError(401,'ERP_UNAUTHENTICATED');
 const actor=userId.toLowerCase(),s=scope(route.signal);let dispatched=false;
 const call=(name,args)=>s.run(()=>rpc(name,{...args,p_user_id:actor},{signal:s.signal}));
 try{
  if(route.kind==='command')return{type:'json',body:readback(await call('erp_cnab_itau_net_credit_command',route.args),route.args.p_command_id)};
  const selection=pick(route.args,['p_event_id','p_file_id','p_line']);
  const checked=(await s.run(()=>executeCnabReturnsRoute({kind:'preview',args:selection},{userId:actor,rpc:(name,args)=>s.run(()=>rpc(name,args,{signal:s.signal})),getFile:v=>s.run(()=>getFile({...v,signal:s.signal}))}))).body;
  const args=pick(route.args,['p_event_id','p_file_id','p_line','p_fee_category_id','p_expected_fee_category_version']);
  const preview=projectItauNetCreditPreview(await call('erp_cnab_itau_net_credit_preview',args),args);
  if(!same(preview.context.base,checked.context))throw new ItauNetCreditError(409,'ERP_ITAU_NET_CREDIT_CONTEXT_CHANGED');
  if(route.kind==='preview')return{type:'json',body:{...preview,bytes_verified:true}};
  dispatched=true;const v=await call('erp_cnab_itau_net_credit_settle',route.args);flags(v);
  if(v.financialMutationPerformed!==true||typeof v.replayed!=='boolean')bad();const r=projectItauNetCreditReceipt(v.receipt),b=checked.context;
  if(r.command_id!==route.args.p_command_id||r.event_id!==route.args.p_event_id||r.file_id!==route.args.p_file_id||r.line!==route.args.p_line||r.context_hash!==route.args.p_context_hash||r.approval_version!==route.args.p_expected_approval||r.posting.fee_category.id!==route.args.p_fee_category_id||r.posting.fee_category.version!==route.args.p_expected_fee_category_version||r.event_hash!==b.event.hash||r.file_hash!==b.file.hash||r.profile_id!==b.profile.id||r.billing_title_id!==b.billing?.id||r.title_id!==b.title?.id||r.account_id!==b.account.id||r.posted_on!==b.event.credited_on||r.posting.principal_cents!==b.event.amount_cents||r.posting.net_cash_cents!==b.event.paid_cents||r.posting.fee_cents!==b.event.adjustments?.fee)bad();
  return{type:'json',body:{...ITAU_NET_CREDIT_FLAGS,financialMutationPerformed:true,replayed:v.replayed,receipt:r}};
 }catch(e){throw error(e,dispatched);}finally{s.close();}
}
