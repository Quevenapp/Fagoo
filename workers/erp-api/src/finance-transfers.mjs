/** Internal ledger only; no bank adapter, settlement or title mutation. */
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, PREFIX='/v1/transferencias-internas';
const ROUTES=new WeakSet(), BODY_BYTES=4096;
export const FINANCE_TRANSFERS_RESPONSE_BYTES=262144;
const FLAGS=Object.freeze({scope:'finance_internal_transfer',data_mode:'erp_native',bank_operation_performed:false,title_mutation_performed:false,opening_mutation_performed:false});
const INPUT=['from_account_id','to_account_id','expected_from_version','expected_to_version','amount_cents','posted_on','note','confirmed'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const signed=v=>typeof v==='string'&&/^(?:0|-?[1-9][0-9]{0,29})$/.test(v);
const cents=v=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const kinds=['bank','cash','other'];
export class FinanceTransfersError extends Error{constructor(status,code){super(code);this.name='FinanceTransfersError';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new FinanceTransfersError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
function day(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2100-12-31'&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return(!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
const text=(v,max)=>typeof v==='string'&&Array.from(v).length>=1&&Array.from(v).length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
// 010 accepts TAB/LF/CR in account names. Preserve those existing names in receipts and current views.
const accountName=v=>typeof v==='string'&&Array.from(v).length>=1&&Array.from(v).length<=200&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const note=v=>text(v,500)&&Array.from(v).length>=3&&v===v.replace(/^ +| +$/g,'')&&v.replace(/[\s\u200b\ufeff]/g,'').length>0;
function freeze(v){if(object(v)||Array.isArray(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function shape(path){
 if(path===PREFIX)return{type:'collection'};
 const m=new RegExp(`^${PREFIX}/(?:(commands)/)?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$`,'i').exec(path);
 return m?{type:m[1]?'command':'get',id:m[2].toLowerCase()}:null;
}
export const financeTransfersRoute=path=>typeof path==='string'&&(path===PREFIX||path.startsWith(PREFIX+'/'));
export const financeTransfersMethods=path=>{const s=shape(path);return s?(s.type==='collection'?['GET','POST']:['GET']):null;};
async function body(request){
 if(!request.body||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>BODY_BYTES))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,source='',timer,stop;
 const stopped=new Promise((_,reject)=>{stop=reject;timer=setTimeout(()=>reject(new FinanceTransfersError(408,'ERP_BODY_TIMEOUT')),5000);});stopped.catch(()=>{});
 const abort=()=>stop(new FinanceTransfersError(400,'ERP_REQUEST_ABORTED'));request.signal.addEventListener('abort',abort,{once:true});
 try{for(;;){if(request.signal.aborted)abort();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(size+=part.value.length)>BODY_BYTES)fail(413,'ERP_BODY_TOO_LARGE');source+=decoder.decode(part.value,{stream:true});}
  if(length!==null&&Number(length)!==size)fail();return JSON.parse(source+decoder.decode());
 }catch(error){if(error instanceof FinanceTransfersError)throw error;fail();}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export async function parseFinanceTransfersRoute(request){
 const url=new URL(request.url);if(!financeTransfersRoute(url.pathname))return null;
 const s=shape(url.pathname);if(!s)fail(404,'ERP_NOT_FOUND');if(!financeTransfersMethods(url.pathname).includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')fail();
 let type,args;
 if(request.method==='POST'){
  if(url.search)fail();const v=await body(request);if(!exact(v,['command_id',...INPUT])||!id(v.command_id)||!id(v.from_account_id)||!id(v.to_account_id)||v.from_account_id.toLowerCase()===v.to_account_id.toLowerCase()
   ||!version(v.expected_from_version)||!version(v.expected_to_version)||!cents(v.amount_cents)||!day(v.posted_on)||!note(v.note)||v.confirmed!==true)fail();
  const data=pick(v,INPUT);data.from_account_id=data.from_account_id.toLowerCase();data.to_account_id=data.to_account_id.toLowerCase();
  type='post';args={p_command_id:v.command_id.toLowerCase(),p_data:data};
 }else{
  if(request.body!==null)fail();type=s.type;
  if(s.type==='collection'){
   type='list';for(const key of url.searchParams.keys())if(!['account_id','limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)fail();
   const limit=url.searchParams.get('limit')??'25',account=url.searchParams.get('account_id'),after=url.searchParams.get('after');
   if(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>25||account!==null&&!id(account)||after!==null&&!id(after))fail();
   args={p_account_id:account?.toLowerCase()??null,p_limit:Number(limit),p_after:after?.toLowerCase()??null};
  }else{if(url.search)fail();args=s.type==='get'?{p_id:s.id}:{p_command_id:s.id};}
 }
 const route=freeze({type,rpc:'erp_finance_transfer_'+type,args});ROUTES.add(route);return route;
}
function snapshot(v){
 if(!object(v)||!id(v.id)||!accountName(v.name)||!kinds.includes(v.kind)||!version(v.version_before)||!version(v.version_after)||v.version_after!==v.version_before+1
  ||!signed(v.balance_before_cents)||!signed(v.balance_after_cents)||!(v.opening_on===null||day(v.opening_on)))bad();
 return pick(v,['id','name','kind','version_before','version_after','balance_before_cents','balance_after_cents','opening_on']);
}
function account(v,s){
 if(!object(v)||v.id!==s.id||!accountName(v.name)||!kinds.includes(v.kind)||typeof v.active!=='boolean'||typeof v.opening_recorded!=='boolean'||!version(v.version)||v.version<s.version_after
  ||!signed(v.balance_cents)||!(v.opening_on===null||day(v.opening_on))||v.opening_recorded!==(v.opening_on!==null)||s.opening_on!==null&&v.opening_on!==s.opening_on)bad();
 if(v.version===s.version_after&&(v.name!==s.name||v.kind!==s.kind||!v.active||v.balance_cents!==s.balance_after_cents||v.opening_on!==s.opening_on))bad();
 return pick(v,['id','name','kind','active','opening_recorded','version','balance_cents','opening_on']);
}
function row(value){
 const r=value?.receipt,c=value?.current;if(!object(r)||!id(r.id)||!id(r.command_id)||!cents(r.amount_cents)||!day(r.posted_on)||!note(r.note)||!stamp(r.created_at)||!object(c)||!Array.isArray(r.movements)||r.movements.length!==2)bad();
 const from=snapshot(r.from_account),to=snapshot(r.to_account),amount=BigInt(r.amount_cents);
 if(from.id===to.id||BigInt(from.balance_after_cents)!==BigInt(from.balance_before_cents)-amount||BigInt(to.balance_after_cents)!==BigInt(to.balance_before_cents)+amount
  ||from.opening_on!==null&&from.opening_on>r.posted_on||to.opening_on!==null&&to.opening_on>r.posted_on)bad();
 const movements=r.movements.map((m,i)=>{if(!object(m)||!id(m.id)||m.account_id!==(i?to.id:from.id)||m.kind!==(i?'transfer_in':'transfer_out')||m.delta_cents!==(i?r.amount_cents:'-'+r.amount_cents))bad();return pick(m,['id','account_id','kind','delta_cents']);});
 if(movements[0].id===movements[1].id)bad();
 return{receipt:{...pick(r,['id','command_id','amount_cents','posted_on','note','created_at']),from_account:from,to_account:to,movements},current:{from_account:account(c.from_account,from),to_account:account(c.to_account,to)}};
}
export function financeTransfersResponse(raw,route){
 if(!object(raw)||Object.entries(FLAGS).some(([k,v])=>raw[k]!==v))bad();
 if(route.type==='list'){
  if(raw.read_only!==true||!Array.isArray(raw.items)||raw.limit!==route.args.p_limit||raw.items.length>raw.limit||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==raw.limit)bad();
  let previous=route.args.p_after;const items=raw.items.map(v=>{const item=row(v),r=item.receipt;if(previous!==null&&r.id<=previous||route.args.p_account_id!==null&&![r.from_account.id,r.to_account.id].includes(route.args.p_account_id))bad();previous=r.id;return item;});
  const next=raw.has_more?items.at(-1).receipt.id:null;if(raw.next_cursor!==next)bad();return{...FLAGS,read_only:true,items,limit:raw.limit,has_more:raw.has_more,next_cursor:next};
 }
 const item=row(raw),r=item.receipt;
 if(route.type==='post'){
  const p=route.args.p_data;if(typeof raw.replayed!=='boolean'||r.command_id!==route.args.p_command_id||r.from_account.id!==p.from_account_id||r.to_account.id!==p.to_account_id
   ||r.from_account.version_before!==p.expected_from_version||r.to_account.version_before!==p.expected_to_version||r.amount_cents!==p.amount_cents||r.posted_on!==p.posted_on||r.note!==p.note)bad();
  return{...FLAGS,...item,replayed:raw.replayed};
 }
 if(raw.read_only!==true||route.type==='get'&&r.id!==route.args.p_id||route.type==='command'&&r.command_id!==route.args.p_command_id)bad();
 return{...FLAGS,read_only:true,...item};
}
function mapped(error,mutating,started){
 if(error instanceof FinanceTransfersError){if(mutating&&started&&error.status===502)fail(503,'ERP_RESULT_UNCONFIRMED');throw error;}
 const codes={42501:[403,'ERP_FORBIDDEN'],22023:[400,'ERP_INVALID_QUERY'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT'],55000:[409,'ERP_CONFLICT']};
 if(Object.hasOwn(codes,error?.code))fail(...codes[error.code]);
 if([400,401,403,404,409].includes(error?.status))fail(error.status,({400:'ERP_INVALID_QUERY',401:'ERP_UNAUTHORIZED',403:'ERP_FORBIDDEN',404:'ERP_NOT_FOUND',409:'ERP_CONFLICT'})[error.status]);
 fail(mutating&&started?503:502,mutating&&started?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_UNAVAILABLE');
}
export async function executeFinanceTransfersRoute(route,{userId,rpc,signal,timeoutMs=15000}={}){
 if(!route||!ROUTES.has(route))fail(404,'ERP_NOT_FOUND');if(!id(userId))fail(401,'ERP_UNAUTHORIZED');if(typeof rpc!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))bad();
 const actor=userId.toLowerCase(),controller=new AbortController();let timer,stop,started=false;
 const interrupted=()=>new FinanceTransfersError(started&&route.type==='post'?503:400,started&&route.type==='post'?'ERP_RESULT_UNCONFIRMED':'ERP_REQUEST_ABORTED');
 const stopped=new Promise((_,reject)=>{stop=reject;timer=setTimeout(()=>{controller.abort();reject(new FinanceTransfersError(503,started&&route.type==='post'?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_TIMEOUT'));},timeoutMs);});stopped.catch(()=>{});
 const abort=()=>{controller.abort();stop(interrupted());};signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw interrupted();const raw=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw interrupted();started=true;return rpc(route.rpc,{...route.args,p_user_id:actor},{signal:controller.signal});}),stopped]);
  if(controller.signal.aborted)throw interrupted();const result=financeTransfersResponse(raw,route);if(new TextEncoder().encode(JSON.stringify(result)).length>FINANCE_TRANSFERS_RESPONSE_BYTES)bad();return result;
 }catch(error){mapped(error,route.type==='post',started);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
