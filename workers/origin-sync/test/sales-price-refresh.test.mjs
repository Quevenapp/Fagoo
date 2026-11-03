import{test}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{OriginClient}from'../src/client.mjs';import{refreshSalesPrices}from'../src/sales-price-refresh.mjs';import{runSync}from'../src/sync.mjs';import{getResource}from'../src/resources.mjs';
const owner=randomUUID(),lease={lease_token:randomUUID()};
const candidate=n=>({source_id:String(850000+n),source_hash:'a'.repeat(64),source_version:'1',source_seen_at:'2026-10-17T00:00:00.123456+00:00'});
function fixture({budget=120,count=40,status=200,advance=0,precise=true,lost=null,recovered='pending',replayed=false}={}){
 const calls=[],urls=[],sleeps=[],token=randomUUID();let time=Date.now();
 const repo={async rpc(name,args,options){calls.push({name,args,options});if(name==='origin_sync_claim')return{acquired:true,lease_token:token};if(name.endsWith('_candidates'))return{items:Array.from({length:count},(_,i)=>candidate(i+1))};
  if(name.endsWith('_begin')){if(lost==='begin')throw new Error('DATABASE_UNAVAILABLE');return{attempt_id:args.p_attempt_id,state:'pending',replayed};}
  if(name.endsWith('_finish')){if(lost==='finish')throw new Error('DATABASE_UNAVAILABLE');return{stored:true,conflict:false,replayed:false};}
  if(name.endsWith('_attempt'))return{attempt_id:args.p_attempt_id,state:recovered,receipt:recovered==='stored'?{sales_price_captures:1,inserted:0,updated:1,unchanged:0}:null};
  if(name.endsWith('_fail')){if(lost==='fail')throw new Error('DATABASE_UNAVAILABLE');return{recorded:true,already_finished:false};}
  if(name==='origin_sync_release'&&lost==='release')throw new Error('DATABASE_TIME_BUDGET');return{released:true};}};
 const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',salesPriceCaptureEnabled:precise,maxRequests:budget,now:()=>time,intervalMs:700,sleep:async ms=>{sleeps.push(ms);time+=ms;},fetchImpl:async url=>{urls.push(url);time+=advance;return status===200?new Response(`{"data":{"id":"${url.split('/').at(-1)}","itens":[{"valor":0.1234567891}]}}`):Response.json({private:'NEVER_PRINT'},{status});}});
 const opts=()=>({owner,lease,deadline:time+160000,now:()=>time,enabled:true,salesPriceCaptureEnabled:true});return{repo,client,calls,urls,sleeps,opts,run:()=>refreshSalesPrices(repo,client,opts())};
}
test('085 off/default/capture-off never touches any port',async()=>{for(const o of[{},{enabled:true},{salesPriceCaptureEnabled:true},{enabled:'true',salesPriceCaptureEnabled:true}]){const r=await refreshSalesPrices({}, {},o);assert.equal(r.status,'disabled');assert.equal(r.requests,0);}});
test('40 attempts and GETs maximum, fixed path, 700ms cadence and at least14 requests remain',async()=>{
 for(const[budget,expected]of[[120,40],[54,40],[53,39],[20,6],[15,1],[14,0]]){const f=fixture({budget}),r=await f.run();assert.equal(r.requests,expected);assert.equal(r.attempted,expected);assert.equal(r.stored,expected);assert.ok(f.client.remainingRequests>=14);assert.ok(f.urls.every(x=>/^https:\/\/api.provider.example\/Api\/v3\/pedidos\/vendas\/[1-9][0-9]*$/.test(x)));assert.ok(f.sleeps.every(x=>x===700));}
});
test('real Client maxAttempts1 suppresses all503/429 retries,401/429 stop cycle,403 stops phase,404 bounded byattempt budget',async()=>{
 for(const status of[401,429,403,404,503]){const f=fixture({status,count:3}),r=await f.run();assert.equal(f.urls.length,[401,429,403].includes(status)?1:3);assert.equal(f.sleeps.length,f.urls.length-1);assert.equal(r.stop_json,[401,429].includes(status));assert.doesNotMatch(JSON.stringify(r),/NEVER_PRINT|synthetic-token|https/);assert.equal(f.calls.filter(x=>x.name.endsWith('_fail')).length,f.urls.length);assert.ok(f.calls.filter(x=>x.name.endsWith('_fail')).every(x=>x.args.p_http_status===status));}
});
test('phase stops at60s and reserves30s before work deadline includingrelease',async()=>{
 const f=fixture({advance:16000}),r=await f.run();assert.equal(f.urls.length,4);assert.equal(r.stop_json,false);assert.equal(r.status,'skipped_time');
 const g=fixture(),opts=g.opts();opts.deadline=opts.now()+34000;assert.equal((await refreshSalesPrices(g.repo,g.client,opts)).status,'skipped_time');assert.equal(g.calls.length,0);
 const h=fixture({count:1}),o=h.opts(),start=o.now();o.deadline=start+40000;await refreshSalesPrices(h.repo,h.client,o);assert.ok(h.calls.every(c=>c.options.deadline===start+10000));
});
test('uncertain begin/finish only reads same attempt then stops entirecycle, never failurewrites oranotherGET',async()=>{
 for(const lost of['begin','finish'])for(const recovered of['missing','pending','stored']){const f=fixture({lost,recovered,count:3}),r=await f.run();assert.equal(r.stop_json,true);assert.equal(f.urls.length,lost==='begin'?0:1);assert.equal(f.calls.filter(c=>c.name.endsWith('_fail')).length,0);assert.equal(f.calls.filter(c=>c.name.endsWith('_begin')).length,1);const begin=f.calls.find(c=>c.name.endsWith('_begin')),read=f.calls.find(c=>c.name.endsWith('_attempt'));assert.equal(read.args.p_attempt_id,begin.args.p_attempt_id);assert.equal(r.recovered,recovered==='stored'?1:0);}
});
test('replayed begin is lookup-only even pending,release/failure ACK errors stop normalcalls',async()=>{
 const a=fixture({replayed:true,count:3}),r=await a.run();assert.equal(r.stop_json,true);assert.equal(a.urls.length,0);assert.equal(a.calls.filter(c=>c.name.endsWith('_attempt')).length,1);
 for(const lost of['fail','release']){const f=fixture({lost,count:2,status:lost==='fail'?404:200}),v=await f.run();assert.equal(v.stop_json,true);assert.equal(f.urls.length,lost==='fail'?1:2);}
});
test('missing capture,wrong identity and malformed candidate refuse finish; candidate copies remainstable',async()=>{
 const a=fixture({precise:false,count:1});assert.equal((await a.run()).stored,0);assert.equal(a.calls.filter(c=>c.name.endsWith('_finish')).length,0);
 for(const items of[[candidate(1),candidate(1)],[{...candidate(1),source_id:'01'}],[{...candidate(1),source_version:'9223372036854775808'}]]){const f=fixture(),rpc=f.repo.rpc;f.repo.rpc=(n,a,o)=>n.endsWith('_candidates')?{items}:rpc(n,a,o);assert.equal((await f.run()).stop_json,true);assert.equal(f.urls.length,0);}
 const f=fixture({count:1}),item=candidate(1),rpc=f.repo.rpc;f.repo.rpc=(n,a,o)=>n.endsWith('_candidates')?{items:[item]}:rpc(n,a,o);const opts=f.opts();opts.heartbeat=async()=>{item.source_id='900';item.source_hash='b'.repeat(64);};await refreshSalesPrices(f.repo,f.client,opts);assert.ok(f.urls[0].endsWith('/850001'));assert.equal(f.calls.find(c=>c.name.endsWith('_begin')).args.p_source_hash,'a'.repeat(64));
});
function syncFixture(){let config,phases=0;const calls=[],commits=[],releases=[],order=[];class Client{constructor(_token,c){config=c;this.requestsMade=0;this.remainingRequests=c.maxRequests;}async get(){calls.push('json');order.push('json');this.requestsMade++;this.remainingRequests--;return[];}}
 const repo={async claim(){return{acquired:true,lease_token:randomUUID(),checkpoint_version:0,checkpoint:{}};},async apply(...a){commits.push(a);},async release(...a){releases.push(a);}};
 const run=async(enabled,stop=false)=>runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2024-01-01',SYNC_TIME_ZONE:'America/Sao_Paulo',MAX_API_REQUESTS:'240',SALES_PRICE_CAPTURE_ENABLED:'true',SALES_PRICE_REFRESH_ENABLED:String(enabled)},
 {Client,getToken:async()=> 'synthetic',resources:[getResource('products_zero')],salesPriceRefresher:async(_r,c,o)=>{order.push('sales');phases++;assert.equal(o.enabled,true);assert.equal(o.salesPriceCaptureEnabled,true);assert.ok(o.deadline<=config.deadline-20000);c.requestsMade+=40;c.remainingRequests-=40;return{status:stop?'partial':'completed',attempted:40,stored:40,conflicts:0,recovered:0,requests:40,errors:stop?[{code:'DATABASE_UNAVAILABLE'}]:[],stop_json:stop};}});
 return{run,calls,commits,releases,order,get config(){return config;},get phases(){return phases;}};}
test('scheduler defaultoff retains240 prior ceiling; oncaps120/global180s and keeps20s boundedpersistence',async()=>{
 for(const enabled of[false,true]){const f=syncFixture(),r=await f.run(enabled);assert.equal(f.phases,Number(enabled));assert.equal(f.config.maxRequests,enabled?120:240);assert.equal(f.calls.length,2);assert.equal(r.status,'completed');assert.deepEqual(f.order,enabled?['sales','json','json']:['json','json']);const a=f.commits.at(-1),release=f.releases.at(-1);assert.equal(a[0],'__scheduler__');assert.equal(a[6]?.deadline,enabled?f.config.deadline-5000:undefined);assert.equal(release[3]?.deadline,enabled?f.config.deadline:undefined);}
});
test('uncertain DB stops normalJSON but persists cycle and releases scheduler withabsolute deadline',async()=>{const f=syncFixture(),r=await f.run(true,true);assert.equal(f.calls.length,0);assert.equal(r.requests,40);assert.equal(r.status,'partial');assert.equal(f.commits.length,1);assert.equal(f.releases.length,1);});
test('observed401/403/429 survive never-resolving error bodycancel; nosecondGET andexactstatuspersisted',async()=>{
 for(const status of[401,403,429]){const f=fixture({count:2});let gets=0,cancels=0;
  const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',salesPriceCaptureEnabled:true,timeoutMs:20,intervalMs:0,fetchImpl:async()=>{gets++;return new Response(new ReadableStream({cancel(){cancels++;return new Promise(()=>{});}}),{status});}});
  const r=await refreshSalesPrices(f.repo,client,f.opts());assert.equal(gets,1);assert.equal(cancels,1);assert.equal(r.stop_json,status!==403);assert.equal(f.calls.find(c=>c.name.endsWith('_fail')).args.p_http_status,status);assert.match(r.errors[0].code,/ORIGIN_(UNAUTHORIZED|FORBIDDEN|RATE_LIMITED)/);
 }
});
