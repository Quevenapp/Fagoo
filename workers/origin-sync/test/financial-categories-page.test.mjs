import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginClient } from '../src/client.mjs';
import { getResource } from '../src/resources.mjs';
import { syncPage, runSync } from '../src/sync.mjs';

const resource = getResource('financial_categories');
const path = '/categorias/receitas-despesas';
const fixed = Date.parse('2026-10-16T20:00:00Z');
const now = new Date(fixed);
const env = { ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true', EXTRA_RESOURCES_ENABLED:'true', SYNC_START_DATE:'2024-01-01', MAX_API_REQUESTS:'20' };
const options = { clock:()=>fixed, deadline:fixed+180000 };
const rows = count => Array.from({length:count},(_,i)=>({id:i+1,idCategoriaPai:i===0?0:1,descricao:`Categoria fictícia ${i+1}`,tipo:1}));
function repository(checkpoint={}) {
  return {
    checkpoint:structuredClone(checkpoint), commits:[],
    async claim(){return {acquired:true,lease_token:'synthetic',checkpoint_version:1,checkpoint:structuredClone(this.checkpoint)};},
    async apply(...args){this.commits.push(args);this.checkpoint=structuredClone(args[5]);return {inserted:args[4].length};},
    async release(){}, async renew(){},
  };
}
function client(source, calls) {
  return new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,maxRequests:11,now:()=>fixed,deadline:fixed+180000,fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET');
    const u=new URL(url);calls.push(u);
    if(u.pathname.endsWith(path)) {
      assert.deepEqual(Object.fromEntries(u.searchParams),{tipo:'0',situacao:'0',pagina:u.searchParams.get('pagina'),limite:'10'});
      return Response.json({data:source(Number(u.searchParams.get('pagina')))});
    }
    const id=Number(u.pathname.split('/').at(-1));
    return Response.json({data:{...rows(id).at(-1),situacao:1}});
  }});
}

test('oversized financial-category page keeps ten-detail batches and closes only after the next empty page',async()=>{
  const db=repository({version:1,failure:{failures:1,code:'ORIGIN_INVALID_LIST_RESPONSE',next_attempt_at:new Date(fixed-1).toISOString()}});
  const listed=rows(63), calls=[], batches=[];
  for(let pass=0;pass<8;pass++){
    const before=calls.length, current=client(page=>page===1?listed:[],calls);
    await syncPage(db,current,resource,'owner',env,now,options);
    const batch=db.commits.at(-1)[4];batches.push(batch);
    assert.ok(batch.length<=10);assert.ok(calls.length-before<=11);
    assert.equal(db.checkpoint.failure,undefined);
    if(pass<6){assert.equal(db.checkpoint.unfiltered.page,1);assert.equal(db.checkpoint.unfiltered.offset,(pass+1)*10);assert.equal(db.checkpoint.unfilteredCompletedAt,undefined);}
    if(pass===6){assert.equal(db.checkpoint.unfiltered.page,2);assert.equal(db.checkpoint.unfiltered.offset,undefined);assert.equal(db.checkpoint.unfilteredCompletedAt,undefined);}
  }
  assert.deepEqual(batches.map(x=>x.length),[10,10,10,10,10,10,3,0]);
  assert.deepEqual(batches.flat().map(x=>x.source_id),listed.map(x=>String(x.id)));
  assert.deepEqual(batches.flat().map(x=>x.payload),listed.map(x=>({...x,situacao:1})));
  assert.deepEqual(calls.filter(u=>u.pathname.endsWith(path)).map(u=>u.searchParams.get('pagina')),['1','1','1','1','1','1','1','2']);
  assert.equal(calls.length,71);assert.equal(db.checkpoint.unfiltered,undefined);
  assert.ok(db.checkpoint.unfilteredCompletedAt);
  assert.equal(Date.parse(db.checkpoint.next_attempt_at)-fixed,900000);
});

test('a short nonempty source page still advances before an empty page proves the sweep ended',async()=>{
  const db=repository(), calls=[];
  const source=page=>page===1?rows(13):page===2?[{id:14}]:[];
  for(let i=0;i<4;i++)await syncPage(db,client(source,calls),resource,'owner',env,now,options);
  assert.deepEqual(db.commits.map(x=>x[4].length),[10,3,1,0]);
  assert.deepEqual(db.commits.flatMap(x=>x[4]).map(x=>x.source_id),rows(14).map(x=>String(x.id)));
  assert.equal(db.checkpoint.unfiltered,undefined);
});

test('changed ID order restarts the same page instead of reusing a stale offset',async()=>{
  const db=repository(),calls=[],original=rows(13);
  await syncPage(db,client(()=>original,calls),resource,'owner',env,now,options);
  const fingerprint=db.checkpoint.unfiltered.list_fingerprint;
  const changed=[original.at(-1),...original.slice(0,-1)];
  await syncPage(db,client(()=>changed,calls),resource,'owner',env,now,options);
  assert.deepEqual(db.commits[1][4].map(x=>x.source_id),changed.slice(0,10).map(x=>String(x.id)));
  assert.notEqual(db.checkpoint.unfiltered.list_fingerprint,fingerprint);
  assert.equal(db.checkpoint.unfiltered.offset,10);assert.equal(db.checkpoint.unfiltered.page,1);
});

test('oversize, duplicate and invalid IDs fail without any details or checkpoint advance',async()=>{
  for(const listed of [rows(1001),[{id:1},{id:1}],[{id:0}],[{id:1.5}],[{id:'not-an-id'}]]){
    const db=repository({version:1,unfiltered:{page:3}});let details=0;
    const source={async get(_path,params){if(!params)details++;return listed;}};
    await assert.rejects(syncPage(db,source,resource,'owner',env,now,options));
    assert.equal(details,0);assert.equal(db.commits.length,1);assert.deepEqual(db.commits[0][4],[]);
    assert.deepEqual(db.checkpoint.unfiltered,{page:3});assert.ok(db.checkpoint.failure);
  }
});

test('a failed detail keeps the previous offset and stages no partially read categories',async()=>{
  const db=repository(),calls=[],listed=rows(23);
  await syncPage(db,client(()=>listed,calls),resource,'owner',env,now,options);
  const prior=structuredClone(db.checkpoint);let details=0;
  const source={async get(_path,params){if(params)return listed;if(++details===2)throw Object.assign(Error('ORIGIN_FORBIDDEN'),{code:'ORIGIN_FORBIDDEN',status:403});return {...listed[10],situacao:1};}};
  await assert.rejects(syncPage(db,source,resource,'owner',env,now,options),/ORIGIN_FORBIDDEN/);
  assert.deepEqual(db.commits[1][4],[]);assert.deepEqual(db.checkpoint.unfiltered,prior.unfiltered);
  assert.equal(Date.parse(db.checkpoint.failure.next_attempt_at)-fixed,86400000);
});

test('a lost database response does not manufacture another batch or hide uncertainty',async()=>{
  const db=repository(),calls=[];
  db.apply=async(...args)=>{db.commits.push(args);throw Error('DATABASE_UNAVAILABLE');};
  await assert.rejects(syncPage(db,client(()=>rows(63),calls),resource,'owner',env,now,options),/DATABASE_UNAVAILABLE/);
  assert.equal(db.commits.length,1);assert.equal(db.commits[0][4].length,10);assert.deepEqual(db.checkpoint,{});
});

test('an unfinished source page yields the scheduler to another resource within the existing budget',async()=>{
  const checkpoints=new Map(),commits=[];
  const db={async claim(id){return {acquired:true,lease_token:'synthetic',checkpoint_version:1,checkpoint:structuredClone(checkpoints.get(id)??{})};},async apply(...args){commits.push(args);checkpoints.set(args[0],structuredClone(args[5]));return {inserted:args[4].length};},async release(){},async renew(){}};
  class Client {
    requestsMade=0;get remainingRequests(){return 20-this.requestsMade;}
    async get(url,params){this.requestsMade++;return params?(url===path?rows(63):[]):{id:Number(url.split('/').at(-1))};}
  }
  const runOptions={now:()=>now,Client,getToken:async()=> 'synthetic',resources:[resource,getResource('warehouses_active')]};
  const first=await runSync(db,env,runOptions);
  assert.equal(first.requests,11);assert.equal(checkpoints.get('__scheduler__').nextIndex,1);
  assert.equal(checkpoints.get('financial_categories').unfiltered.offset,10);
  const second=await runSync(db,env,runOptions);
  assert.ok(second.requests<=20);assert.ok(commits.some(x=>x[0]==='warehouses_active'));
});
