import test from'node:test';import assert from'node:assert/strict';
import{createHandler}from'../src/index.mjs';
import{originSyncFreshnessResponse,parseIntegrationProgressRoute,executeIntegrationProgressRoute,integrationProgressMethods,freshnessStatus,FRESHNESS_ENTITIES,FRESHNESS_PATH}from'../src/integration-progress.mjs';
import{RESOURCES}from'../../origin-sync/src/resources.mjs';
import{freshnessResponse,measureEntity,freshnessStamp}from'./helpers/origin-sync-freshness-response.mjs';
const uid='a0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,options={})=>new Request(`https://api.example.test${path}`,options);
const authed=(options={})=>({...options,headers:{Authorization:'Bearer synthetic',...options.headers}});
const upstream=(rpcResponse,calls=[])=>createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):rpcResponse();}});
const invalid=e=>e.status===502&&e.code==='ERP_UPSTREAM_INVALID_RESPONSE';

test('101 lane catalog covers every collector variant exactly once, under its canonical entity',()=>{
 const lanes=FRESHNESS_ENTITIES.flatMap(([entity,,list])=>list.map(([resource,lane])=>({entity,resource,lane})));
 assert.deepEqual([...new Set(lanes.map(x=>x.resource))].sort(),RESOURCES.map(r=>r.id).sort());
 assert.deepEqual(FRESHNESS_ENTITIES.map(x=>x[0]).sort(),[...new Set(RESOURCES.map(r=>r.entity))].sort());
 for(const x of lanes){
  const resource=RESOURCES.find(r=>r.id===x.resource);assert.equal(resource.entity,x.entity,x.resource);
  // Undated sweeps have one lane; modified-date windows only need recent; document-date windows also need history.
  const expected=!resource.fromParam?['sweep']:resource.mode==='modified'?['recent']:['recent','history'];
  assert.deepEqual(lanes.filter(y=>y.resource===x.resource).map(y=>y.lane),expected,x.resource);
 }
 assert.deepEqual(Object.fromEntries(FRESHNESS_ENTITIES.map(([e,l])=>[e,l])),{contacts:'A',products:'A',sales_orders:'A',nfe:'A',nfce:'A',
  sales_proposals:'B',purchase_orders:'B',service_orders:'B',receivables:'B',payables:'B',cash_entries:'B',stock_balances:'B',
  sellers:'C',payment_methods:'C',warehouses:'C',product_categories:'C',financial_categories:'C',ledger_accounts:'C'});
});

test('101 route demands authentication before any RPC and exposes only GET',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 assert.equal((await handle(request(FRESHNESS_PATH),env)).status,401);
 for(const method of['GET','POST','PATCH','DELETE']){
  const response=await handle(request(FRESHNESS_PATH,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization'}}),env);
  assert.equal(response.status,method==='GET'?204:403);assert.equal(response.headers.get('Cache-Control'),'no-store');
 }
 assert.equal(calls,0);assert.deepEqual(integrationProgressMethods(FRESHNESS_PATH),['GET']);
 for(const path of[`${FRESHNESS_PATH}/`,`${FRESHNESS_PATH}/contacts`,'/v1/integracao-origin/frescor2'])assert.equal(integrationProgressMethods(path),null);
});

test('101 strict query: any parameter, method or encoding is refused after login and before the RPC',async()=>{
 for(const[path,options,status]of[[`${FRESHNESS_PATH}?entity=contacts`,{},400],[`${FRESHNESS_PATH}?`+'&',{},400],[`${FRESHNESS_PATH}?p_user_id=${uid}`,{},400],
  [FRESHNESS_PATH,{headers:{'Content-Encoding':'gzip'}},400],[FRESHNESS_PATH,{method:'POST',body:'{}'},405],[FRESHNESS_PATH,{method:'PATCH',body:'{}'},405]]){
  const calls=[],response=await upstream(()=>{throw Error('must not call');},calls)(request(path,authed(options)),env);
  assert.equal(response.status,status,path);assert.ok(calls.every(c=>c.url.endsWith('/auth/v1/user')),path);
 }
 assert.throws(()=>parseIntegrationProgressRoute(new Request(`https://erp.invalid${FRESHNESS_PATH}?x=1&x=2`)),e=>e.status===400);
 assert.deepEqual(parseIntegrationProgressRoute(new Request(`https://erp.invalid${FRESHNESS_PATH}`)),{type:'freshness',rpc:'erp_origin_sync_freshness',args:{}});
});

test('101 binds the verified actor to the fixed RPC and returns only the validated projection',async()=>{
 const value=measureEntity(freshnessResponse(),'contacts',{ageSeconds:120,records:3});value.private='PRIVATE_SECRET';value.entities[0].payload={nome:'PRIVATE_NAME'};value.entities[0].lanes[0].cursor={page:9};value.collector.ciphertext='PRIVATE_TOKEN';
 const calls=[],response=await upstream(()=>Response.json(value),calls)(request(FRESHNESS_PATH,authed()),env);
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_origin_sync_freshness'));assert.deepEqual(JSON.parse(calls[1].options.body),{p_user_id:uid});
 assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-service-key');
 const body=await response.json();assert.doesNotMatch(JSON.stringify(body),/PRIVATE_|cursor|payload|ciphertext/);
 assert.deepEqual(body,originSyncFreshnessResponse(value));assert.equal(body.entities[0].status,'ok');assert.equal(body.entities[0].records,3);
 let rpcCalls=0;const route=parseIntegrationProgressRoute(new Request(`https://erp.invalid${FRESHNESS_PATH}`));
 await executeIntegrationProgressRoute(route,{userId:uid.toUpperCase(),rpc:async(name,args)=>{rpcCalls++;assert.equal(name,'erp_origin_sync_freshness');assert.deepEqual(args,{p_user_id:uid});return freshnessResponse();}});
 assert.equal(rpcCalls,1);
 await assert.rejects(()=>executeIntegrationProgressRoute(route,{userId:'not-a-uuid',rpc:()=>{throw Error('must not call');}}),e=>e.status===401);
 await assert.rejects(()=>executeIntegrationProgressRoute({...route,rpc:'erp_origin_progress'},{userId:uid,rpc:()=>{throw Error('must not call');}}),e=>e.status===404);
});

test('101 database denials, invalid input and outages are mapped like the neighbours, without private detail',async()=>{
 for(const[reply,status,code]of[
  [()=>Response.json({code:'42501',message:'private-detail'},{status:403}),403,'ERP_FORBIDDEN'],
  [()=>Response.json({code:'22023',message:'private-detail'},{status:400}),400,'ERP_INVALID_QUERY'],
  [()=>Response.json({code:'XX000',message:'private-detail'},{status:500}),502,'ERP_UPSTREAM_UNAVAILABLE'],
  [()=>new Response('private-detail',{status:429}),503,'ERP_UPSTREAM_UNAVAILABLE'],
  [()=>{throw new TypeError('private-detail');},503,'ERP_UPSTREAM_UNAVAILABLE'],
  [()=>new Response('{"private-detail":',{status:200,headers:{'Content-Type':'application/json'}}),502,null],
  [()=>new Response(JSON.stringify({pad:'x'.repeat(1048577)}),{status:200,headers:{'Content-Type':'application/json'}}),502,null],
 ]){
  const response=await upstream(reply)(request(FRESHNESS_PATH,authed()),env),text=await response.text();
  assert.equal(response.status,status,text);if(code)assert.equal(JSON.parse(text).error.code,code);assert.doesNotMatch(text,/private-detail/);
 }
});

test('101 every field is validated; inconsistent levels, passes or ages never reach the screen',async()=>{
 const base=()=>measureEntity(freshnessResponse(),'purchase_orders',{ageSeconds:2400,records:2});
 assert.equal(originSyncFreshnessResponse(base()).entities.find(x=>x.entity==='purchase_orders').status,'attention');
 const purchase=v=>v.entities.find(x=>x.entity==='purchase_orders');
 for(const mutate of[
  v=>v.profile='other',v=>v.role='consulta',v=>v.coverage_certified=true,v=>v.erp_mutations=true,v=>v.time_zone='UTC',v=>v.as_of='2026-02-30T00:00:00Z',
  v=>v.levels[0].target_seconds=60,v=>v.levels.pop(),v=>v.entities.pop(),v=>v.entities.reverse(),
  v=>v.entities[0].level='B',v=>v.entities[0].target_seconds=1800,v=>v.entities[0].records=-1,v=>v.entities[0].records=1,
  v=>v.entities[0].lanes.pop(),v=>v.entities[0].lanes[0].resource='contacts_deleted',v=>v.entities[0].lanes[0].lane='history',
  v=>v.entities[0].lanes[0].open=true,v=>v.entities[0].lanes[0].completed_finished_at=freshnessStamp,
  v=>purchase(v).status='ok',v=>purchase(v).status='stale',v=>purchase(v).age_seconds=1800,v=>purchase(v).age_seconds=null,
  v=>purchase(v).freshness_at=purchase(v).lanes[0].completed_started_at,v=>purchase(v).pass_lane='recent',v=>purchase(v).pass_finished_at=freshnessStamp,
  v=>purchase(v).lanes_measured=1,v=>{purchase(v).lanes[1].completed_started_at=null;},
  v=>purchase(v).lanes[0].completed_started_at='2026-10-19T13:30:00.000Z',v=>{purchase(v).lanes[1].completed_finished_at='2026-10-19T13:06:00.000Z';},
  v=>purchase(v).oldest_seen_at='2026-10-19T14:00:00.000Z',v=>purchase(v).last_seen_at=null,
  v=>v.entities[0].status='ok',v=>v.entities[0].freshness_at=freshnessStamp,
  v=>v.collector.oauth_connected=true,v=>v.collector.oauth_expires_at=freshnessStamp,v=>v.collector.last_run_status='running',
  v=>v.collector.last_run_started_at=freshnessStamp,v=>{v.collector.last_run_status='failed';v.collector.last_run_error_count=0;v.collector.last_error_code='ORIGIN_HTTP_401';},
  v=>{v.collector.last_run_status='failed';v.collector.last_run_error_count=1;v.collector.last_error_code='private detail';},
  v=>{v.collector.last_run_status='failed';v.collector.last_run_error_count=1;v.collector.last_error_resource='https://private.invalid';},
 ]){const value=base();mutate(value);assert.throws(()=>originSyncFreshnessResponse(value),invalid,mutate.toString());}
 const value=base();Object.assign(value.collector,{oauth_connected:true,oauth_expires_at:freshnessStamp,last_run_status:'partial',last_run_started_at:freshnessStamp,last_run_finished_at:freshnessStamp,last_run_error_count:2,last_error_code:'ORIGIN_HTTP_429',last_error_resource:'nfe_out'});
 assert.deepEqual(originSyncFreshnessResponse(value).collector,value.collector);
});

test('101 levels are exact at the boundaries: within the level, above it, above three times it',()=>{
 for(const[level,target]of[['A',600],['B',1800],['C',86400]]){
  assert.equal(freshnessStatus(0,target),'ok');assert.equal(freshnessStatus(target,target),'ok');assert.equal(freshnessStatus(target+1,target),'attention');
  assert.equal(freshnessStatus(3*target,target),'attention');assert.equal(freshnessStatus(3*target+1,target),'stale');assert.equal(freshnessStatus(null,target),'stale',level);
 }
 for(const[entity,age,status]of[['sales_orders',600,'ok'],['sales_orders',601,'attention'],['sales_orders',1800,'attention'],['sales_orders',1801,'stale'],['ledger_accounts',259200,'attention'],['ledger_accounts',259201,'stale']]){
  const value=measureEntity(freshnessResponse(),entity,{ageSeconds:age});assert.equal(originSyncFreshnessResponse(value).entities.find(x=>x.entity===entity).status,status,`${entity} ${age}`);
 }
});
