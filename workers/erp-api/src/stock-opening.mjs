/** Negative stock policy and reviewed Origin opening adoption (migration100). Strict routes, closed DTOs, bounded I/O. */
import{StockOpeningError,STOCK_OPENING_BASE,STOCK_POLICY_BASE,STOCK_OPENING_MAX_BYTES,STOCK_OPENING_BODY_BYTES,STOCK_OPENING_GROUPS,
 stockOpeningSourceId,stockOpeningUuid,captureStockOpeningQuery,captureStockOpeningBatch,captureStockOpeningApply,captureStockPolicyInput,
 parseStockOpeningWarehouses,parseStockOpeningPage,parseStockOpeningBatch,parseStockOpeningResult,parseStockPolicy,parseStockPolicyResult}from'../../../packages/erp-domain/src/stock-opening-dto.mjs';
export{StockOpeningError,STOCK_OPENING_MAX_BYTES,STOCK_OPENING_BASE,STOCK_POLICY_BASE};
const routes=new WeakSet(),fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new StockOpeningError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const under=(path,base)=>path===base||path.startsWith(base+'/');
export const stockOpeningRoute=path=>typeof path==='string'&&(under(path,STOCK_OPENING_BASE)||under(path,STOCK_POLICY_BASE));
const OPENING_ACTION=/^\/v1\/saldo-abertura-estoque\/([0-9]{1,40})\/(lote|adotar)$/;
export function stockOpeningMethods(path){
 if(!stockOpeningRoute(path))return null;
 if(path===STOCK_POLICY_BASE)return['GET','POST'];
 return OPENING_ACTION.test(path)?['POST']:['GET'];
}
async function body(request){
 need(/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')&&request.body,400,'ERP_INVALID_INPUT');
 const length=request.headers.get('content-length');need(length===null||/^[0-9]+$/.test(length)&&Number(length)<=STOCK_OPENING_BODY_BYTES,400,'ERP_INVALID_INPUT');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),deadline=Date.now()+5000;let timer,buffer='',size=0,rejectAbort;
 const abort=()=>rejectAbort?.(new StockOpeningError(408,'ERP_REQUEST_TIMEOUT'));
 const wait=new Promise((_,reject)=>{rejectAbort=reject;timer=setTimeout(abort,5000);request.signal.addEventListener('abort',abort,{once:true});});wait.catch(()=>{});
 try{const check=()=>need(!request.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');check();
  for(;;){check();const r=await Promise.race([reader.read(),wait]);check();if(r.done)break;need(r.value instanceof Uint8Array&&r.value.byteLength>0,400,'ERP_INVALID_INPUT');size+=r.value.byteLength;need(size<=STOCK_OPENING_BODY_BYTES,400,'ERP_INVALID_INPUT');buffer+=decoder.decode(r.value,{stream:true});}
  const value=JSON.parse(buffer+decoder.decode());check();return value;}
 catch(e){if(e instanceof StockOpeningError)throw e;return fail(400,'ERP_INVALID_INPUT');}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);try{void reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
}
const noQuery=u=>need(!u.search,400,'ERP_INVALID_QUERY');
export async function parseStockOpeningRoute(request){
 need(request instanceof Request);const u=new URL(request.url);if(!stockOpeningRoute(u.pathname))return null;
 need(request.url.length<=4096&&!u.hash&&(!request.headers.has('content-encoding')||request.headers.get('content-encoding')==='identity'));
 need(stockOpeningMethods(u.pathname).includes(request.method),405,'ERP_METHOD_NOT_ALLOWED');
 let action,rpc,args,input,mutation=false;const path=u.pathname;
 if(path===STOCK_POLICY_BASE){noQuery(u);
  if(request.method==='GET'){action='policy';rpc='erp_stock_policy_get';args={};}
  else{action='policy-set';mutation=true;input=captureStockPolicyInput(await body(request));rpc='erp_stock_policy_set';
   args={p_command_id:input.command_id,p_expected_version:input.expected_version,p_allow_negative:input.allow_negative,p_reason:input.reason,p_confirmed:true};}
 }else if(path.startsWith(STOCK_POLICY_BASE+'/comandos/')){noQuery(u);const id=path.slice((STOCK_POLICY_BASE+'/comandos/').length);need(stockOpeningUuid(id),404,'ERP_NOT_FOUND');action='policy-command';rpc='erp_stock_policy_command';args={p_command_id:id};
 }else if(path===STOCK_OPENING_BASE){noQuery(u);action='warehouses';rpc='erp_stock_opening_warehouses';args={};
 }else if(path.startsWith(STOCK_OPENING_BASE+'/comandos/')){noQuery(u);const id=path.slice((STOCK_OPENING_BASE+'/comandos/').length);need(stockOpeningUuid(id),404,'ERP_NOT_FOUND');action='command';rpc='erp_stock_opening_command';args={p_command_id:id};
 }else{
  const page=/^\/v1\/saldo-abertura-estoque\/([0-9]{1,40})$/.exec(path),act=OPENING_ACTION.exec(path);
  const source=page?.[1]??act?.[1];need(source&&stockOpeningSourceId(source),404,'ERP_NOT_FOUND');
  if(page){
   for(const k of u.searchParams.keys())need(['limit','after','grupo'].includes(k)&&u.searchParams.getAll(k).length===1,400,'ERP_INVALID_QUERY');
   const limit=u.searchParams.get('limit'),group=u.searchParams.get('grupo');need(limit===null||/^[1-9][0-9]?$/.test(limit),400,'ERP_INVALID_QUERY');
   need(group===null||STOCK_OPENING_GROUPS.includes(group),400,'ERP_INVALID_QUERY');
   const q=captureStockOpeningQuery({limit:limit===null?25:Number(limit),after:u.searchParams.get('after'),group});
   action='page';rpc='erp_stock_opening_page';args={p_warehouse_source_id:source,p_limit:q.limit,p_after:q.after,p_group:q.group};
  }else{noQuery(u);
   if(act[2]==='lote'){action='batch';input=captureStockOpeningBatch(await body(request));rpc='erp_stock_opening_batch';args={p_warehouse_source_id:source,p_occurred_on:input.occurred_on,p_limit:input.limit};}
   else{action='apply';mutation=true;input=captureStockOpeningApply(await body(request));rpc='erp_stock_opening_apply';
    args={p_warehouse_source_id:source,p_occurred_on:input.occurred_on,p_items:input.items,p_preview_hash:input.preview_hash,p_command_id:input.command_id,p_confirmed:true};}
  }
 }
 if(request.method==='GET')need(request.body===null&&(!request.headers.has('content-length')||request.headers.get('content-length')==='0'));
 const route=Object.freeze({action,rpc,mutation,args:Object.freeze(args),...(input?{input}:{})});routes.add(route);return route;
}
function parse(route,args,result){
 switch(route.action){
  case'policy':return parseStockPolicy(result);
  case'policy-set':return parseStockPolicyResult(result,{commandId:args.p_command_id,input:route.input});
  case'policy-command':return parseStockPolicyResult(result,{commandId:args.p_command_id,lookup:true});
  case'warehouses':return parseStockOpeningWarehouses(result);
  case'page':return parseStockOpeningPage(result,{warehouseSourceId:args.p_warehouse_source_id,limit:args.p_limit,after:args.p_after,group:args.p_group});
  case'batch':return parseStockOpeningBatch(result,{warehouseSourceId:args.p_warehouse_source_id,occurredOn:args.p_occurred_on,limit:args.p_limit});
  case'apply':return parseStockOpeningResult(result,{commandId:args.p_command_id,warehouseSourceId:args.p_warehouse_source_id,input:route.input});
  default:return parseStockOpeningResult(result,{commandId:args.p_command_id,lookup:true});
 }
}
const KNOWN={42501:[403,'ERP_ACCESS_DENIED'],22023:[400,'ERP_INVALID_INPUT'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],
 ERP_ACCESS_DENIED:[403,'ERP_ACCESS_DENIED'],ERP_FORBIDDEN:[403,'ERP_ACCESS_DENIED'],ERP_NOT_FOUND:[404,'ERP_NOT_FOUND'],ERP_CONFLICT:[409,'ERP_CONFLICT'],ERP_INVALID_INPUT:[400,'ERP_INVALID_INPUT'],ERP_INVALID_QUERY:[400,'ERP_INVALID_INPUT']};
export async function executeStockOpeningRoute(route,context){
 need(context&&typeof context==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(context)));const c={};
 for(const k of Reflect.ownKeys(context)){const d=Object.getOwnPropertyDescriptor(context,k);need(typeof k==='string'&&['userId','rpc','signal','timeoutMs'].includes(k)&&d.enumerable&&Object.hasOwn(d,'value'));c[k]=d.value;}
 const{userId,rpc,signal,timeoutMs=20000}=c;
 need(routes.has(route),404,'ERP_NOT_FOUND');need(stockOpeningUuid(userId)&&typeof rpc==='function',403,'ERP_ACCESS_DENIED');need(signal===undefined||signal instanceof AbortSignal);need(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=20000);
 const call=rpc,args=Object.freeze({...route.args,p_user_id:userId}),controller=new AbortController(),deadline=Date.now()+timeoutMs;let timer,dispatched=false;
 const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const timeout=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new StockOpeningError(408,'ERP_REQUEST_TIMEOUT')),{once:true});timer=setTimeout(cancel,timeoutMs);});timeout.catch(()=>{});
 try{
  need(!controller.signal.aborted,408,'ERP_REQUEST_TIMEOUT');
  const result=await Promise.race([Promise.resolve().then(()=>{need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');dispatched=true;return call(route.rpc,args,{signal:controller.signal,deadline});}),timeout]);
  need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');
  const value=parse(route,args,result);need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');return value;
 }catch(e){
  const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,code=d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:null;
  if(code&&Object.hasOwn(KNOWN,code)&&!(e instanceof StockOpeningError&&e.status===502))throw new StockOpeningError(...KNOWN[code]);
  // A dispatched mutation without a validated answer may have committed: only a GET of the same command can tell.
  if(route.mutation&&dispatched)throw new StockOpeningError(503,'ERP_RESULT_UNCONFIRMED');
  if(e instanceof StockOpeningError)throw e;throw new StockOpeningError(502,'ERP_UPSTREAM_UNAVAILABLE');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
}
