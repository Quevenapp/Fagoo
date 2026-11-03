import test from'node:test';import assert from'node:assert/strict';
import{ACTOR,COMMAND,HISTORY,publicHistory}from'./helpers/sales-history-public-fixtures.mjs';
import{SALES_HISTORY_BASE as BASE,salesHistoryRoute,salesHistoryMethods,parseSalesHistoryRoute,executeSalesHistoryRoute}from'../src/origin-sales-history.mjs';
import{parseSalesHistoryDetail,parseSalesHistoryPage,parseSalesHistoryCommand,parseSalesHistoryCapturePreview}from'../../../packages/erp-domain/src/origin-sales-history-dto.mjs';
const request=(path='',init)=>new Request('https://synthetic.invalid'+BASE+path,init),route=p=>parseSalesHistoryRoute(request(p));
const bad=e=>e.code==='ERP_UPSTREAM_INVALID_RESPONSE';
test('083 public routes expose GET only and no capture/preview mutation',()=>{
 assert.equal(salesHistoryRoute(BASE),true);assert.deepEqual(salesHistoryMethods(BASE),['GET']);assert.equal(salesHistoryMethods('/v1/sales_orders'),null);assert.equal(parseSalesHistoryRoute(new Request('https://synthetic.invalid/other')),null);
 for(const method of['POST','PUT','DELETE','PATCH','OPTIONS'])assert.throws(()=>parseSalesHistoryRoute(request('',{method})),e=>e.status===405);
 for(const path of['/capture','/preview','/'+HISTORY+'?q=x','/commands/'+COMMAND+'?x=1','/31','/'+HISTORY+'/', '/%62sh_'+HISTORY.slice(4),'?limit=26','?limit=0','?limit=01','?limit=2&limit=3','?after=1','?other=1','?q=%0A','?q='+encodeURIComponent('界'.repeat(101))])assert.throws(()=>route(path));
 assert.throws(()=>parseSalesHistoryRoute(request('',{headers:{'content-length':'1'}})));assert.equal(route('?q=%25').args.p_query,'%');assert.equal(route('?q='+encodeURIComponent('界'.repeat(100))).args.p_query.length,100);
});
test('083 fixed RPCs, captured actor/options and frozen arguments before first await',async()=>{
 const f=publicHistory();for(const[path,action,rpcName,value]of[['','list','erp_origin_sales_history_list',f.page],['/'+HISTORY,'detail','erp_origin_sales_history_detail',f.detail],['/commands/'+COMMAND,'command','erp_origin_sales_history_command',f.command]]){
  let seen;const ctx={userId:ACTOR,rpc:async(name,args,opts)=>{seen={name,args,opts};assert.ok(Object.isFrozen(args));return value;}};const p=executeSalesHistoryRoute(route(path),ctx);ctx.userId='44444444-4444-4444-8444-444444444444';ctx.rpc=()=>assert.fail('changed port');const out=await p;assert.equal(seen.name,rpcName);assert.equal(seen.args.p_user_id,ACTOR);assert.ok(seen.opts.signal instanceof AbortSignal);assert.ok(Number.isFinite(seen.opts.deadline));assert.equal(out.profile,'origin-sales-history-v1');assert.ok(Object.isFrozen(out));assert.equal(route(path).action,action);
 }
});
test('083 no forged routes/accessors/extra capabilities or pre-aborted calls',async()=>{
 let calls=0;const rpc=async()=>{calls++;return publicHistory().page;};await assert.rejects(()=>executeSalesHistoryRoute({action:'list',rpc:'other',args:{}},{userId:ACTOR,rpc}),e=>e.status===404);
 for(const ctx of[{userId:ACTOR,rpc,writer:()=>{}},{get userId(){throw Error('GETTER');},rpc},{userId:ACTOR,get rpc(){throw Error('GETTER');}}])await assert.rejects(()=>executeSalesHistoryRoute(route(''),ctx),e=>e.code==='ERP_INVALID_QUERY');
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(()=>executeSalesHistoryRoute(route(''),{userId:ACTOR,rpc,signal:ctrl.signal}),e=>e.code==='ERP_REQUEST_TIMEOUT');assert.equal(calls,0);
});
test('083 deadline and cancellation close late/noncooperative RPC without accepting a response',async()=>{
 let signal;await assert.rejects(()=>executeSalesHistoryRoute(route(''),{userId:ACTOR,timeoutMs:10,rpc:(_n,_a,o)=>{signal=o.signal;return new Promise(()=>{});}}),e=>e.status===408);assert.equal(signal.aborted,true);
 const ctrl=new AbortController();let resolve;const p=executeSalesHistoryRoute(route(''),{userId:ACTOR,signal:ctrl.signal,rpc:()=>new Promise(r=>{resolve=r;})});await Promise.resolve();ctrl.abort();await assert.rejects(()=>p,e=>e.code==='ERP_REQUEST_TIMEOUT');resolve(publicHistory().page);
});
test('083 errors are sanitized and malformed projections rejected without exposing raw diagnostics',async()=>{
 for(const[code,status,publicCode]of[['42501',403,'ERP_ACCESS_DENIED'],['P0002',404,'ERP_NOT_FOUND'],['22023',400,'ERP_INVALID_QUERY'],['other',502,'ERP_UPSTREAM_UNAVAILABLE']])await assert.rejects(()=>executeSalesHistoryRoute(route(''),{userId:ACTOR,rpc:()=>{throw {code,message:'PRIVATE_SENTINEL'};}}),e=>e.status===status&&e.code===publicCode&&!e.message.includes('PRIVATE'));
 await assert.rejects(()=>executeSalesHistoryRoute(route(''),{userId:ACTOR,rpc:()=>({payload:'PRIVATE_SENTINEL'})}),bad);
});
test('083 DTO preserves exact decimal and invalid observations but binds every current reference to its historical external ID',()=>{
 const f=publicHistory();const d=parseSalesHistoryDetail(f.detail,{historyId:HISTORY});assert.equal(d.items[0].price_lexeme,'9999999999.1234567891');assert.equal(d.commercial.total.value,'1');assert.equal(d.invoice_reference.source_id.value,'0');
 for(const edit of[v=>v.current.customer.source_id='22',v=>v.current.products[0].binding.source_id='21',v=>v.current.source.source_version='2',v=>v.items[0].position=2,v=>v.current.products[0].position=2,v=>v.snapshot.history_id='bsh_44444444-4444-4444-8444-444444444444',v=>v.snapshot.source.source_version='1\n']){const v=publicHistory().detail;edit(v);assert.throws(()=>parseSalesHistoryDetail(v,{historyId:HISTORY}),bad);}
 const v=publicHistory().detail;v.customer.source_id={state:'invalid',kind:'string',value:'021'};v.current.customer={state:'invalid_id',source_id:null,record_id:null,record_version:null,unit:null};v.snapshot.capture={state:'invalid',reason:'UNBOUND_OR_INVALID',profile:'origin-sales-price-json-v1',observed_at:null,response_sha256:null,numeric_tokens:null,scope:'numeric_itens_valor_only'};v.items[0].price_lexeme=null;v.items[0].unit_price={state:'invalid',kind:'string',value:'NAN'};assert.equal(parseSalesHistoryDetail(v,{historyId:HISTORY}).items[0].unit_price.value,'NAN');
});
test('083 lexemes require bound exact tokens, count and numeric equality; no floating-point comparison',()=>{
 for(const edit of[v=>v.items[0].price_lexeme='9999999999.1234567892',v=>v.snapshot.capture.numeric_tokens=0,v=>v.items[0].price_lexeme=null,v=>v.items[0].price_lexeme='1e129',v=>v.items[0].price_lexeme+='\n']){const v=publicHistory().detail;edit(v);assert.throws(()=>parseSalesHistoryDetail(v,{historyId:HISTORY}),bad);}
 const f=publicHistory();f.detail.items[0].price_lexeme='99999999991234567891e-10';assert.equal(parseSalesHistoryDetail(f.detail,{historyId:HISTORY}).items[0].price_lexeme,'99999999991234567891e-10');
});
test('083 DTO closes flags, keys, arrays, getters, size and command/source bindings',()=>{
 const f=publicHistory();assert.equal(parseSalesHistoryCommand(f.command,{commandId:COMMAND}).receipt.command_id,COMMAND);assert.equal(parseSalesHistoryCapturePreview(f.preview,{sourceId:'31'}).existing,null);
 assert.throws(()=>parseSalesHistoryCommand(f.command,{commandId:ACTOR}),bad);assert.throws(()=>parseSalesHistoryCapturePreview(f.preview,{sourceId:'32'}),bad);
 for(const edit of[v=>v.can_convert=true,v=>v.native_effects=true,v=>v.payload={},v=>v.customer.name.value='x'.repeat(1048577),v=>Object.defineProperty(v.customer,'name',{get(){throw Error('getter');},enumerable:true}),v=>v.items.push(v.items[0])]){const v=publicHistory().detail;edit(v);assert.throws(()=>parseSalesHistoryDetail(v,{historyId:HISTORY}),bad);}
 const page=publicHistory().page;page.items.push(page.items[0]);assert.throws(()=>parseSalesHistoryPage(page,{limit:25,after:null}),bad);
});
test('083 time consumed inside DTO parsing cannot return a result after its absolute deadline',async()=>{
 const realNow=Date.now,RealEncoder=globalThis.TextEncoder;let now=0;
 try{Date.now=()=>now;globalThis.TextEncoder=class extends RealEncoder{encode(v){now=200;return super.encode(v);}};
  await assert.rejects(()=>executeSalesHistoryRoute(route(''),{userId:ACTOR,timeoutMs:100,rpc:async()=>publicHistory().page}),e=>e.code==='ERP_REQUEST_TIMEOUT');
 }finally{Date.now=realNow;globalThis.TextEncoder=RealEncoder;}
});
