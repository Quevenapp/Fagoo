import test from 'node:test';import assert from 'node:assert/strict';import {createHandler} from '../src/index.mjs';
import {ACTOR,page,detail} from './helpers/stock-observations-response-fixture.mjs';
const BASE='/v1/estoque-origin-observado',env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic087',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
const req=(path='?warehouse_source_id=007',extra={})=>new Request('https://api.synthetic.test'+BASE+path,{headers,...extra});
test('087 real API exposes only list/detail read RPCs and injects authenticated actor',async()=>{
 for(const [path,name,value]of[['?warehouse_source_id=007','erp_origin_stock_observations',page()],['/001?warehouse_source_id=007','erp_origin_stock_observation_detail',detail()]]){
  const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR,user_metadata:{role:'admin'}}:value);}}),r=await h(req(path),env);
  assert.equal(r.status,200);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/'+name));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);assert.equal(JSON.parse(calls[1].o.body).p_warehouse_source_id,'007');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).native_effects,false);
 }
});
test('087 malformed requests cannot reach business RPC, mutation methods/CORS/anonymous are refused',async()=>{
 const calls=[],h=createHandler({fetchImpl:async url=>{calls.push(url);return Response.json({id:ACTOR});}});
 assert.equal((await h(req('?warehouse_source_id=007',{method:'POST',body:'{}'}),env)).status,405);assert.equal(calls.length,0);
 for(const path of['','?warehouse_source_id=0','?warehouse_source_id=007&actor='+ACTOR,'/capture?warehouse_source_id=007','/001?warehouse_source_id=007&limit=25'])assert.ok([400,404].includes((await h(req(path),env)).status));
 assert.ok(calls.every(url=>url.endsWith('/auth/v1/user')));
 const anonymous=createHandler({fetchImpl:async()=>Response.json({id:ACTOR,is_anonymous:true})});assert.equal((await anonymous(req(),env)).status,403);
 assert.equal((await h(req('?warehouse_source_id=007',{headers:{...headers,Origin:'https://other.invalid'}}),env)).status,403);
});
test('087 current SQL ACL/notfound errors are closed and never reclassified as a zero balance',async()=>{
 for(const [code,status]of[['42501',403],['P0002',404],['22023',400],['XX000',502]]){
  let rpc=0;const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):(rpc++,Response.json({code,message:'PRIVATE-RAW'},{status:500}))}),r=await h(req(),env);
  assert.equal(r.status,status);assert.equal(rpc,1);const text=await r.text();assert.doesNotMatch(text,/PRIVATE-RAW|physical|warehouse/);
 }
});
test('087 response bound and body/identity validation are isolated from legacy routes',async()=>{
 for(const [value,size,status]of[[page(),262144,200],[page(),262145,502],[{...page(),warehouse:{...page().warehouse,source_id:'7'}},null,502],[{...page(),native_effects:true},null,502]]){
  const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json',...(size?{'Content-Length':String(size)}:{})}})});
  assert.equal((await h(req(),env)).status,status);
 }
});
test('087 abort before auth and total deadline after auth prevent business dispatch',async()=>{
 const stop=new AbortController();stop.abort();let calls=0;const h=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:ACTOR});}});
 assert.equal((await h(req('?warehouse_source_id=007',{signal:stop.signal}),env)).status,400);assert.equal(calls,0);
 const original=Date.now;let now=0;Date.now=()=>now;
 try{const late=createHandler({fetchImpl:async()=>{calls++;now=21000;return Response.json({id:ACTOR});}}),r=await late(req(),env);assert.equal(r.status,408);assert.equal(calls,1);}finally{Date.now=original;}
});
