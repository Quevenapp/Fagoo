import test from'node:test';import assert from'node:assert/strict';
import{parseStockOpeningRoute as parse,executeStockOpeningRoute as execute,stockOpeningMethods,stockOpeningRoute}from'../src/stock-opening.mjs';
import{parseStockOpeningPage,parseStockOpeningBatch,parseStockOpeningResult,parseStockPolicyResult,captureStockOpeningApply,stockOpeningIntent}from'../../../packages/erp-domain/src/stock-opening-dto.mjs';
import{createHandler}from'../src/index.mjs';
import{ACTOR,COMMAND,SOURCE,page,batch,intent,result,warehouses,policyView,policyInput,policyResult,deferred}from'./helpers/stock-opening-response-fixture.mjs';
const req=(path,body,init={})=>new Request('https://synthetic.invalid'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)}),...init});
const OPENING='/v1/saldo-abertura-estoque',POLICY='/v1/politica-estoque';

test('100 closed routes: methods, query parameters, IDs and bodies are strict',async()=>{
 assert.equal(stockOpeningRoute('/v1/saldo-abertura-estoquex'),false);assert.equal(await parse(req('/v1/estoque/saldos')),null);
 assert.deepEqual(stockOpeningMethods(POLICY),['GET','POST']);assert.deepEqual(stockOpeningMethods(`${OPENING}/${SOURCE}/adotar`),['POST']);assert.deepEqual(stockOpeningMethods(`${OPENING}/${SOURCE}`),['GET']);
 const route=await parse(req(`${OPENING}/${SOURCE}?limit=50&after=9105&grupo=invalid`));assert.deepEqual({...route.args},{p_warehouse_source_id:SOURCE,p_limit:50,p_after:'9105',p_group:'invalid'});assert.ok(Object.isFrozen(route.args));
 for(const path of[`${OPENING}/${SOURCE}?limit=51`,`${OPENING}/${SOURCE}?limit=0`,`${OPENING}/${SOURCE}?limit=01`,`${OPENING}/${SOURCE}?grupo=other`,`${OPENING}/${SOURCE}?after=0`,`${OPENING}/${SOURCE}?q=x`,
  `${OPENING}/${SOURCE}?limit=1&limit=2`,`${OPENING}?limit=1`,`${POLICY}?x=1`,`${OPENING}/comandos/${COMMAND}?x=1`])await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const path of[`${OPENING}/0`,`${OPENING}/00`,`${OPENING}/x1`,`${OPENING}/comandos/${COMMAND.toUpperCase()}`,`${OPENING}/comandos/x`,`${POLICY}/comandos/1`])await assert.rejects(()=>parse(req(path)),e=>e.status===404,path);
 await assert.rejects(()=>parse(req(`${OPENING}/${SOURCE}`,{})),e=>e.status===405);await assert.rejects(()=>parse(req(`${OPENING}/${SOURCE}/lote`)),e=>e.status===405);
 const good={occurred_on:'2026-10-18',limit:100};assert.deepEqual({...(await parse(req(`${OPENING}/${SOURCE}/lote`,good))).args},{p_warehouse_source_id:SOURCE,p_occurred_on:'2026-10-18',p_limit:100});
 for(const body of[{...good,limit:101},{...good,occurred_on:'2026-02-30'},{...good,extra:1},{occurred_on:'2026-10-18'},'{',`{"occurred_on":"2026-10-18","limit":1,"pad":"${'x'.repeat(70000)}"}`])
  await assert.rejects(()=>parse(req(`${OPENING}/${SOURCE}/lote`,body)),e=>e.status===400);
 await assert.rejects(()=>parse(req(`${OPENING}/${SOURCE}/lote`,good,{headers:{'content-type':'text/plain'}})),e=>e.status===400);
 await assert.rejects(()=>parse(req(`${OPENING}/${SOURCE}/lote?x=1`,good)),e=>e.status===400);
 const apply=intent();assert.equal((await parse(req(`${OPENING}/${SOURCE}/adotar`,apply))).args.p_items.length,2);
 const item=apply.items[0];
 for(const body of[{...apply,confirmed:false},{...apply,items:[]},{...apply,items:Array.from({length:101},(_,n)=>({...item,product_source_id:String(9000+n)}))},{...apply,items:[item,item]},
  {...apply,items:[{...item,target:'1.5'}]},{...apply,items:[{...item,target:'-0.000000'}]},{...apply,items:[{...item,target:'1000000000000.000000'}]},{...apply,items:[{...item,source_version:1}]},
  {...apply,items:[{...item,extra:true}]},{...apply,items:[(({unit,...rest})=>rest)(item)]},{...apply,items:[{...item,unit:''}]},{...apply,items:[{...item,unit:'U\nN'}]},{...apply,items:[{...item,unit:1}]},{...apply,command_id:COMMAND.toUpperCase()},{...apply,preview_hash:'D'.repeat(64)}])
  await assert.rejects(()=>parse(req(`${OPENING}/${SOURCE}/adotar`,body)),e=>e.status===400);
 assert.equal((await parse(req(POLICY,policyInput()))).args.p_allow_negative,true);
 for(const body of[{...policyInput(),reason:'ok'},{...policyInput(),confirmed:'true'},{...policyInput(),expected_version:-1},{...policyInput(),allow_negative:'true'},{...policyInput(),actor:ACTOR}])
  await assert.rejects(()=>parse(req(POLICY,body)),e=>e.status===400);
 await assert.rejects(()=>parse(new Request('https://synthetic.invalid'+OPENING,{method:'GET',headers:{'content-length':'2'}})),e=>e.status===400);
});

test('100 DTOs bind the batch to the confirmed intent and reject inconsistent projections',()=>{
 assert.equal(parseStockOpeningPage(page(),{warehouseSourceId:SOURCE}).counts.pending,2);
 for(const mutate of[v=>v.counts.total++,v=>v.items[0].adjustment='1.000000',v=>v.items[2].status='negative',v=>v.items[1].group='positive',v=>v.items[0].receipt={},v=>v.unit_source='origin',
  v=>v.items.reverse(),v=>v.items[3].target='8.000000',v=>v.warehouse.source_id='700002',v=>v.items[0].current={quantity:'-0.000000',version:1},v=>v.items[0].product=null])
 {const bad=page();mutate(bad);assert.throws(()=>parseStockOpeningPage(bad,{warehouseSourceId:SOURCE}),undefined,String(mutate));}
 assert.equal(parseStockOpeningPage(page({allow:true}),{warehouseSourceId:SOURCE}).counts.pending,3);
 const b=parseStockOpeningBatch(batch({allow:true}),{warehouseSourceId:SOURCE,occurredOn:'2026-10-18',limit:100});const sent=stockOpeningIntent(b,COMMAND);
 assert.deepEqual(sent.items.map(i=>i.target),['10.500000','0.000000','-2.250000']);assert.ok(Object.isFrozen(sent.items[0]));
 assert.throws(()=>parseStockOpeningBatch(batch(),{warehouseSourceId:SOURCE,occurredOn:'2026-10-17',limit:100}));
 const bad=batch();bad.items.push(page().items[2]);bad.pending=3;assert.throws(()=>parseStockOpeningBatch(bad,{warehouseSourceId:SOURCE,occurredOn:'2026-10-18',limit:100}));
 assert.equal(parseStockOpeningResult(result(sent),{commandId:COMMAND,input:sent}).receipt.summary.adopted,2);
 for(const mutate of[v=>v.receipt.items[0].target='11.000000',v=>v.receipt.summary.skipped=1,v=>v.current.pop(),v=>v.current[0].state='reversed',v=>v.receipt.items[1].movement_id=COMMAND,v=>v.receipt.command_id=ACTOR,v=>v.receipt.preview_hash='e'.repeat(64),v=>v.current[0].unit='CX'])
 {const r=result(sent);mutate(r);assert.throws(()=>parseStockOpeningResult(r,{commandId:COMMAND,input:sent}),undefined,String(mutate));}
 const skipped=result(sent,{skip:['9101']});assert.equal(parseStockOpeningResult(skipped,{commandId:COMMAND,input:sent}).current.length,2);
 assert.throws(()=>parseStockOpeningResult(result(sent),{commandId:COMMAND,lookup:true}));
 const p=policyInput();assert.equal(parseStockPolicyResult(policyResult(p),{commandId:COMMAND,input:p}).policy.allow_negative,true);
 for(const mutate of[v=>v.receipt.to.version=3,v=>v.receipt.to.allow_negative=false,v=>v.policy.version=0,v=>v.receipt.reason='Outra']){const r=policyResult(p);mutate(r);assert.throws(()=>parseStockPolicyResult(r,{commandId:COMMAND,input:p}));}
 let gets=0;assert.throws(()=>captureStockOpeningApply({...intent(),get command_id(){gets++;return COMMAND;}}));assert.equal(gets,0);
});

test('100 execution: frozen actor, sanitized SQL refusals, unconfirmed mutations, timeouts and aborts',async()=>{
 const route=await parse(req(`${OPENING}/${SOURCE}/adotar`,intent()));
 for(const[code,status]of[['42501',403],['22023',400],['40001',409],['P0002',404]])await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:()=>{throw{code,message:'PRIVATE_SQL'};}}),e=>e.status===status&&!e.message.includes('PRIVATE'));
 for(const rpc of[()=>{throw Error('PRIVATE');},()=>({...result(),payload:'PRIVATE'}),()=>new Promise(()=>{})])await assert.rejects(()=>execute(route,{userId:ACTOR,rpc,timeoutMs:5}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const hold=deferred();let entered;const seen=new Promise(r=>entered=r);const ctx={userId:ACTOR,rpc:(name,args)=>{entered({name,args});return hold.promise;}};const work=execute(route,ctx);
 const call=await seen;ctx.userId=COMMAND;assert.equal(call.name,'erp_stock_opening_apply');assert.equal(call.args.p_user_id,ACTOR);assert.ok(Object.isFrozen(call.args));hold.resolve(result());assert.equal((await work).replayed,false);
 const read=await parse(req(`${OPENING}/${SOURCE}`));
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>({...page(),extra:1})}),e=>e.status===502);
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>{throw Error('PRIVATE');}}),e=>e.status===502&&e.code==='ERP_UPSTREAM_UNAVAILABLE');
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>new Promise(()=>{}),timeoutMs:5}),e=>e.status===408);
 const stop=new AbortController();stop.abort();let calls=0;await assert.rejects(()=>execute(read,{userId:ACTOR,signal:stop.signal,rpc:()=>calls++}),e=>e.status===408);assert.equal(calls,0);
 await assert.rejects(()=>execute(read,{userId:'not-a-user',rpc:()=>page()}),e=>e.status===403);
 await assert.rejects(()=>execute(read,{userId:ACTOR,rpc:()=>page(),extra:true}),e=>e.status===400);
 await assert.rejects(()=>execute(Object.freeze({...read}),{userId:ACTOR,rpc:()=>page()}),e=>e.status===404);
 assert.equal((await execute(await parse(req(`${OPENING}/comandos/${COMMAND}`)),{userId:ACTOR,rpc:(name,args)=>{assert.equal(name,'erp_stock_opening_command');assert.equal(args.p_command_id,COMMAND);return result(intent(),{replayed:true});}})).replayed,true);
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-100',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
const api=(path,body)=>new Request('https://api.synthetic.test'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('100 real API: authenticated actor, fixed RPC per route, bounded responses and definite versus unconfirmed errors',async()=>{
 for(const[path,body,name,value]of[[OPENING,undefined,'erp_stock_opening_warehouses',warehouses()],[`${OPENING}/${SOURCE}`,undefined,'erp_stock_opening_page',page()],
  [`${OPENING}/${SOURCE}/lote`,{occurred_on:'2026-10-18',limit:100},'erp_stock_opening_batch',batch()],[`${OPENING}/${SOURCE}/adotar`,intent(),'erp_stock_opening_apply',result()],
  [`${OPENING}/comandos/${COMMAND}`,undefined,'erp_stock_opening_command',result(intent(),{replayed:true})],[POLICY,undefined,'erp_stock_policy_get',policyView()],
  [POLICY,policyInput(),'erp_stock_policy_set',policyResult()],[`${POLICY}/comandos/${COMMAND}`,undefined,'erp_stock_policy_command',policyResult(policyInput(),true)]]){
  const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR,user_metadata:{role:'admin'}}:value);}}),r=await h(api(path,body),env);
  assert.equal(r.status,200,path);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/'+name));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);assert.equal(r.headers.get('cache-control'),'no-store');}
 for(const[code,status]of[['42501',403],['22023',400],['40001',409],['P0002',404]]){let writes=0;const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):(writes++,Response.json({code,message:'PRIVATE'},{status:400}))}),r=await h(api(`${OPENING}/${SOURCE}/adotar`,intent()),env);
  assert.equal(r.status,status);assert.equal(writes,1);assert.doesNotMatch(await r.text(),/PRIVATE|synthetic/);}
 let writes=0;const lost=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):(writes++,Response.json({...result(),private:'PRIVATE'}))});
 const r=await lost(api(`${OPENING}/${SOURCE}/adotar`,intent()),env);assert.equal(r.status,503);assert.equal(writes,1);assert.equal((await r.json()).error.code,'ERP_RESULT_UNCONFIRMED');
 for(const size of[262144,262145]){const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify(page()),{headers:{'Content-Type':'application/json','Content-Length':String(size)}})});assert.equal((await h(api(`${OPENING}/${SOURCE}`),env)).status,size===262144?200:502);}
 let calls=0;const none=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:ACTOR});}});
 assert.equal((await none(new Request('https://api.synthetic.test'+OPENING,{method:'DELETE',headers}),env)).status,405);assert.equal(calls,0);
 assert.equal((await none(api(`${OPENING}/${SOURCE}/adotar`,{...intent(),confirmed:false}),env)).status,400);assert.equal(calls,1);
 const anonymous=createHandler({fetchImpl:async()=>Response.json({id:ACTOR,is_anonymous:true})});assert.equal((await anonymous(api(OPENING),env)).status,403);
});

test('100 home summary accepts negative positions (neither positive nor zero) without changing its shape',async()=>{
 const{homeResponse}=await import('../src/home.mjs');const{STATES}=await import('../../../packages/erp-domain/src/index.mjs');
 const base={data_mode:'erp_native',as_of:'2026-10-18T12:00:00Z',business_date:'2026-10-18',timezone:'America/Sao_Paulo',role:'estoque',catalog:['contacts','products','warehouses'].map(entity=>({entity,active:0,archived:0})),
  documents:['sales_orders','purchase_orders'].map(kind=>({kind,count:0,statuses:Object.keys(STATES[kind]).map(status=>({status,count:0}))})),stock:{positions:3,positive_positions:1,zero_positions:1,products:3,warehouses:1},finance:null};
 assert.deepEqual(homeResponse(base).stock,{positions:3,positive_positions:1,zero_positions:1,products:3,warehouses:1});
 assert.throws(()=>homeResponse({...base,stock:{...base.stock,positive_positions:3}}),e=>e.status===502);
});
