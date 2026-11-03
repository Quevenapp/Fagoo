import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runSync} from '../src/sync.mjs';
import {getResource} from '../src/resources.mjs';
import {handleRequest} from '../src/index.mjs';
const env={ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2024-01-01',MAX_API_REQUESTS:'120'};
const phase={status:'completed',attempted:0,stored:0,conflicts:0,requests:0,errors:[],stop_json:false};
function fixture(){
 const commits=[],calls=[];
 const repo={async claim(){return{acquired:true,lease_token:randomUUID(),checkpoint:{},checkpoint_version:0};},async release(){},async renew(){},
 async rpc(name,args){calls.push({name,args});return{};},async apply(...args){commits.push(args);return{checkpoint_version:1};}};
 class Client{requestsMade=0;remainingRequests=120;async get(){this.requestsMade++;this.remainingRequests--;return[];}}
 return{repo,calls,commits,deps:{getToken:async()=>'synthetic-token',Client,resources:[getResource('contacts')]}};
}
test('056 defaults off and makes no new RPC while preserving all old scheduler phases',async()=>{
 const f=fixture();let calls=0;
 const r=await runSync(f.repo,env,{...f.deps,referenceFetcher:async()=>{calls++;return phase;}});
 assert.equal(calls,0);assert.equal(r.reference_fetch,undefined);assert.equal(r.pages,2);assert.ok(!f.calls.some(x=>x.name.includes('reference')));
});
test('XML and finance retain priority; references share budget before JSON without changing list cursor',async()=>{
 const f=fixture(),order=[];let shared;
 const r=await runSync(f.repo,{...env,XML_SYNC_ENABLED:'true',FINANCE_REFRESH_ENABLED:'true',REFERENCE_FETCH_ENABLED:'true'},{...f.deps,
 xmlCollector:async(_repo,client,options)=>{order.push('xml');shared={client,...options};return phase;},
 financeRefresher:async(_repo,client,options)=>{order.push('finance');assert.equal(client,shared.client);return phase;},
 referenceFetcher:async(_repo,client,options)=>{order.push('references');assert.equal(client,shared.client);assert.equal(options.owner,shared.owner);assert.equal(options.deadline,shared.deadline);return phase;}});
 assert.deepEqual(order,['xml','finance','references']);assert.equal(r.pages,2);assert.equal(f.commits.at(-1)[5].lastRun.reference_fetch,phase);
 assert.equal(f.commits.filter(x=>x[0]==='contacts').length,2);
});
test('401/429 stops global JSON while isolated errors remain safe and visible in lastRun',async()=>{
 for(const status of [401,403,429,500]){
  const f=fixture();const r=await runSync(f.repo,{...env,REFERENCE_FETCH_ENABLED:'true'},{...f.deps,referenceFetcher:async()=>{throw Object.assign(new Error('private payload secret'),{status});}});
  assert.equal(r.pages,[401,429].includes(status)?0:2);assert.equal(r.status,'partial');
  assert.ok(r.errors.some(x=>x.resource==='proposal_references'&&x.code==='REFERENCE_FETCH_PARTIAL'));
  assert.doesNotMatch(JSON.stringify(r),/private payload secret|synthetic-token/);
 }
 const f=fixture();let called=false;
 await runSync(f.repo,{...env,REFERENCE_FETCH_ENABLED:'true',FINANCE_REFRESH_ENABLED:'true'},{...f.deps,financeRefresher:async()=>({...phase,stop_json:true}),referenceFetcher:async()=>{called=true;return phase;}});
 assert.equal(called,false);
});
test('admin aggregate is authenticated, flag gated and has no IDs or raw sources',async()=>{
 const token='synthetic-admin-token-at-least-thirty-two',calls=[];
 const request=auth=>new Request('https://synthetic.invalid/admin/status',{method:'POST',headers:auth?{Authorization:`Bearer ${token}`}:{}});
 const config={...env,INTEGRATION_ADMIN_TOKEN:token};
 const deps={repoFactory:()=>({async rpc(name){calls.push(name);return{entities:[],erp_mutations:false,coverage_complete:false,deletion_inferred:false};}})};
 assert.equal((await handleRequest(request(false),{...config,REFERENCE_FETCH_ENABLED:'true'},deps)).status,401);assert.equal(calls.length,0);
 const off=await(await handleRequest(request(true),config,deps)).json();assert.deepEqual(off.reference_fetch,{enabled:false});assert.ok(!calls.includes('origin_sync_reference_status'));
 const on=await(await handleRequest(request(true),{...config,REFERENCE_FETCH_ENABLED:'true'},deps)).json();assert.equal(on.reference_fetch.enabled,true);assert.equal(on.reference_fetch.erp_mutations,false);assert.ok(calls.includes('origin_sync_reference_status'));
});
