import test from 'node:test';
import assert from 'node:assert/strict';
import {OriginClient} from '../src/client.mjs';
import {getResource} from '../src/resources.mjs';
import {syncPage,runSync} from '../src/sync.mjs';

const fixed=Date.parse('2026-10-16T20:00:00Z'),now=new Date(fixed);
const env={ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',EXTRA_RESOURCES_ENABLED:'true',SYNC_START_DATE:'2024-01-01',MAX_API_REQUESTS:'20'};
const options={clock:()=>fixed,deadline:fixed+180000};
const sample=()=>({produto:{id:'1'},saldoFisicoTotal:12.125,saldoVirtualTotal:11.25,depositos:[{id:'8',saldoFisico:12.125,saldoVirtual:11.25}]});
const reordered=()=>({depositos:[{saldoVirtual:11.25,saldoFisico:12.125,id:'8'}],saldoVirtualTotal:11.25,produto:{id:'1'},saldoFisicoTotal:12.125});
function repository(ids=['1','2']){
 const states=new Map(),commits=[];
 return{states,commits,async claim(resource){return{acquired:true,lease_token:'synthetic',checkpoint_version:1,checkpoint:structuredClone(states.get(resource)??{})};},async release(){},async renew(){},
 async rpc(name){assert.equal(name,'origin_sync_stock_product_page');return{items:ids,has_more:false,next_cursor:null,coverage_complete:false};},
 async apply(...args){commits.push(args);states.set(args[0],structuredClone(args[5]));return{inserted:args[4].length};}};
}
const run=(repo,client)=>syncPage(repo,client,getResource('stock_balances'),'owner',env,now,options);

test('identical stock across filters deduplicates whole payload despite object-key order and preserves missing products',async()=>{
 const db=repository(),calls=[];
 const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,maxRequests:3,now:()=>fixed,deadline:fixed+180000,fetchImpl:async(url,init)=>{
  assert.equal(init.method,'GET');const u=new URL(url),partition=Number(u.searchParams.get('filtroSaldoEstoque'));calls.push(partition);
  assert.deepEqual(u.searchParams.getAll('idsProdutos[]'),['1','2']);return Response.json({data:partition===0?[]:[partition===1?sample():reordered()]});
 }});
 const result=await run(db,client);assert.deepEqual(calls,[0,1,2]);assert.equal(client.requestsMade,3);
 assert.equal(result.records,1);assert.equal(result.overlaps,1);assert.equal(result.unavailable,1);
 assert.equal(db.commits.length,1);
 const wire=JSON.parse(JSON.stringify(db.commits[0][4]));
 assert.deepEqual(wire,[{source_id:'1',payload:{...sample(),_brufap_stock_capture:{profile:'origin-stock-json-v1',tokens:[
  {path:'/saldoFisicoTotal',lexeme:'12.125'},{path:'/saldoVirtualTotal',lexeme:'11.25'},
  {path:'/depositos/0/saldoFisico',lexeme:'12.125'},{path:'/depositos/0/saldoVirtual',lexeme:'11.25'},
 ]}}}]);
 assert.deepEqual(db.states.get('stock_balances').last_observation,{requested:2,returned:1,unavailable:1,overlaps:1,observed_at:now.toISOString(),coverage_complete:false});
});

test('every differing stock field remains a conflict and the entire batch stays uncommitted',async()=>{
 const changes=[v=>v.saldoFisicoTotal+=0.001,v=>v.saldoVirtualTotal+=0.001,v=>v.depositos[0].saldoFisico+=0.001,v=>v.depositos[0].saldoVirtual+=0.001,v=>v.depositos[0].id='9',v=>v.depositos=[],v=>v.saldoFisicoTotal=String(v.saldoFisicoTotal),v=>delete v.saldoVirtualTotal,v=>v.extra='synthetic'];
 for(const change of changes){
  const db=repository(),later=sample();change(later);let requests=0;
  await assert.rejects(run(db,{async get(_path,p){requests++;return p.filtroSaldoEstoque===0?[]:[p.filtroSaldoEstoque===1?sample():later];}}),/ORIGIN_STOCK_RESPONSE_CONFLICT/);
  assert.equal(requests,3);assert.equal(db.commits.length,1);assert.deepEqual(db.commits[0][4],[]);
  assert.equal(db.states.get('stock_balances').last_observation,undefined);assert.equal(db.states.get('stock_balances').failure.code,'ORIGIN_STOCK_RESPONSE_CONFLICT');
 }
});

test('array ordering is not silently normalized and duplicate rows inside one response stay invalid',async()=>{
 const base=sample();base.depositos.push({id:'9',saldoFisico:0,saldoVirtual:0});
 const reversed=structuredClone(base);reversed.depositos.reverse();
 const db=repository();await assert.rejects(run(db,{async get(_path,p){return p.filtroSaldoEstoque===0?[base]:[reversed];}}),/ORIGIN_STOCK_RESPONSE_CONFLICT/);assert.deepEqual(db.commits[0][4],[]);
 for(const partition of [0,1,2]){const db=repository();await assert.rejects(run(db,{async get(_path,p){return p.filtroSaldoEstoque===partition?[sample(),sample()]:[];}}),/ORIGIN_STOCK_RESPONSE_CONFLICT/);assert.deepEqual(db.commits[0][4],[]);}
});

test('foreign product IDs and duplicated warehouse IDs remain conflicts even if other filters agree',async()=>{
 for(const kind of ['foreign','warehouse']){const db=repository(),value=sample();if(kind==='foreign')value.produto.id='99';else value.depositos.push(structuredClone(value.depositos[0]));
  await assert.rejects(run(db,{async get(){return[value];}}),/ORIGIN_STOCK_RESPONSE_CONFLICT/);assert.deepEqual(db.commits[0][4],[]);
 }
});

test('all-three overlap counts repeated occurrences, not new products or extra HTTP calls',async()=>{
 const db=repository(['1']);let requests=0;
 const result=await run(db,{async get(){requests++;return[sample()];}});
 assert.equal(requests,3);assert.equal(result.overlaps,2);assert.equal(result.records,1);assert.equal(result.unavailable,0);assert.equal(db.commits[0][4].length,1);
});

test('overlap summary remains aggregate in scheduler status without changing coverage or quota',async()=>{
 const db=repository();
 class Client{requestsMade=0;get remainingRequests(){return 20-this.requestsMade;}async get(_path,p){this.requestsMade++;return p.filtroSaldoEstoque===0?[]:[sample()];}}
 const result=await runSync(db,env,{now:()=>now,Client,getToken:async()=> 'synthetic',resources:[getResource('stock_balances')]});
 assert.equal(result.requests,3);assert.equal(result.pages,1);assert.equal(result.records,1);
 const aggregate={batches:1,requested:2,returned:1,unavailable:1,overlaps:1,coverage_complete:false};
 assert.deepEqual(result.stock_balances,aggregate);assert.deepEqual(db.states.get('__scheduler__').lastRun.stock_balances,aggregate);
 assert.doesNotMatch(JSON.stringify(result),/saldoFisico|depositos|payload|source_id/);
});

test('a lost stock batch ACK still sends one unchanged database attempt only',async()=>{
 const db=repository();db.apply=async(...args)=>{db.commits.push(args);throw Error('DATABASE_UNAVAILABLE');};
 await assert.rejects(run(db,{async get(){return[sample()];}}),/DATABASE_UNAVAILABLE/);
 assert.equal(db.commits.length,1);assert.equal(db.commits[0][4].length,1);assert.equal(db.commits[0][5].last_observation.overlaps,2);
});
