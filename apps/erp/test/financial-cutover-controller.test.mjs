import test from'node:test';import assert from'node:assert/strict';import{createAccessController,AccessError}from'../src/lib/real-access.ts';
const user='a0000000-0000-4000-8000-000000000001',token='synthetic-access-token';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const auth=()=>({getSession:async()=>({data:{session:{access_token:token,user:{id:user}}},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({error:null}),signOut:async()=>({error:null})});
async function setup(role='admin',fetcher){const calls=[];const controller=createAccessController(auth(),'https://api.synthetic.invalid',async(url,options)=>{calls.push({url,options});return url.endsWith('/me')?json({user_id:user,role,resources:['contacts','products'],data_mode:'staging_readonly'}):fetcher?fetcher(url,options):json({synthetic:true});});const stop=controller.start();await tick();return{controller,calls,stop};}
test('038 controller is GET-only, admin-only, fixed-origin and bounded; slash/dot in search are literal query values',async()=>{
 const{controller,calls,stop}=await setup();try{
  const path='/v1/conferencia-financeira-origin?entity=receivables&q=ABC%2F1%2E2%5C3%23';await controller.financialCutover(path);const call=calls.at(-1);assert.equal(call.url,`https://api.synthetic.invalid${path}`);assert.equal(new URL(call.url).searchParams.get('q'),'ABC/1.2\\3#');assert.equal(call.options.method,'GET');assert.equal(call.options.credentials,'omit');assert.equal(call.options.cache,'no-store');assert.equal(call.options.headers.Authorization,`Bearer ${token}`);
  const before=calls.length;
  for(const path of['https://evil.invalid/v1/conferencia-financeira-origin','//evil.invalid/v1/conferencia-financeira-origin','/v1/conferencia-financeira-origin/receivables/..','/v1/conferencia-financeira-origin/receivables/%2e%2e','/v1/conferencia-financeira-origin/receivables/1%2f2','/v1/conferencia-financeira-origin/receivables/1\\2','/v1/conferencia-financeira-origin?entity=receivables#fragment'])await assert.rejects(()=>controller.financialCutover(path),e=>e instanceof AccessError&&e.status===400);
  for(const options of[{method:'POST'},{method:'PUT'},{body:{}},{method:'GET',body:{}}])await assert.rejects(()=>controller.financialCutover('/v1/conferencia-financeira-origin?entity=receivables',options),e=>e.status===400);assert.equal(calls.length,before);
 }finally{stop();}
 const other=await setup('financeiro');try{await assert.rejects(()=>other.controller.financialCutover('/v1/conferencia-financeira-origin?entity=receivables'),e=>e.status===403);assert.equal(other.calls.length,1);}finally{other.stop();}
});
test('038 controller rejects oversized responses and suppresses a late successful response after abort',async()=>{
 const big=await setup('admin',()=>new Response(' '.repeat(1024*1024+1)));try{await assert.rejects(()=>big.controller.financialCutover('/v1/conferencia-financeira-origin?entity=receivables'),e=>e.status===502);}finally{big.stop();}
 let resolve,signal;const run=await setup('admin',(_url,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});});try{const abort=new AbortController();const pending=run.controller.financialCutover('/v1/conferencia-financeira-origin?entity=receivables',{signal:abort.signal});abort.abort();assert.equal(signal.aborted,true);resolve(json({late:'synthetic'}));await assert.rejects(()=>pending,e=>e.name==='AbortError');}finally{run.stop();}
});
