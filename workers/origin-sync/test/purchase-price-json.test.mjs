import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {OriginClient} from '../src/client.mjs';
import {Repository} from '../src/repository.mjs';
import {priceCapture} from '../src/price-json.mjs';
import {parsePurchasePriceJson,purchasePriceCapture,purchasePriceEndpoint} from '../src/purchase-price-json.mjs';
import {syncPage,runSync} from '../src/sync.mjs';
import {getResource} from '../src/resources.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const token='99999999.1234567891';
const source=`{"data":{"id":1,"itens":[{"produto":{"id":2,"valor":${token}},"valor":${token},"quantidade":1.25},{"valor":"1.23"},{"valor":null}],"total":${token},"parcelas":[{"valor":${token}}],"ativo":true}}`;
const client=(text,options={})=>new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>new Response(text),...options});
test('071 preserves only numeric purchase line prices and records a distinct detail-only profile',async()=>{
 const p=await client(source,{purchasePriceCaptureEnabled:true}).get('/pedidos/compras/1');
 assert.match(JSON.stringify(p),/"valor":99999999\.1234567891/);assert.equal(p.id,1);assert.equal(p.ativo,true);assert.equal(p.itens[0].produto.id,2);
 assert.equal(p.itens[0].produto.valor,Number(token));assert.equal(p.total,Number(token));assert.equal(p.parcelas[0].valor,Number(token));assert.equal(p.itens[1].valor,'1.23');assert.equal(p.itens[2].valor,null);
 assert.deepEqual(purchasePriceCapture(p),{profile:'origin-purchase-price-json-v1',response_sha256:hash(source),source:'detail',tokens:[{path:'/itens/0/valor',lexeme:token}]});assert.equal(priceCapture(p),null);
 assert.throws(()=>p.itens[0].valor=0);assert.throws(()=>purchasePriceCapture(p).tokens.pop());
});
test('default/off, list, sales and nested siorigin prices retain legacy semantics; old059 flag does not activate purchases',async()=>{
 for(const options of [{},{purchasePriceCaptureEnabled:false},{priceCaptureEnabled:true}]){const p=await client(source,options).get('/pedidos/compras/1');assert.equal(p.itens[0].valor,Number(token));assert.equal(purchasePriceCapture(p),null);}
 const list=await client('{"data":['+source.slice(8,-1)+']}',{purchasePriceCaptureEnabled:true}).get('/pedidos/compras');assert.equal(purchasePriceCapture(list[0]),null);assert.equal(list[0].itens[0].valor,Number(token));
 const sale=await client(source,{purchasePriceCaptureEnabled:true}).get('/pedidos/vendas/1');assert.equal(sale.itens[0].valor,Number(token));assert.equal(purchasePriceCapture(sale),null);
 for(const path of ['/pedidos/compras','/pedidos/compras/1/','/pedidos/vendas/1','/produtos/1'])assert.equal(purchasePriceEndpoint(path),null);
 assert.throws(()=>client(source,{purchasePriceCaptureEnabled:'true'}),{code:'ORIGIN_INVALID_CLIENT_CONFIG'});
});
test('capture binds original bytes, copies before digest and never changes unsafe ID validation',async()=>{
 const bytes=new TextEncoder().encode(source),pending=parsePurchasePriceJson(source,bytes,'purchase_detail');bytes.fill(0);const p=(await pending).data;assert.equal(purchasePriceCapture(p).response_sha256,hash(source));
 await assert.rejects(parsePurchasePriceJson(source,new TextEncoder().encode(source+' '),'purchase_detail'),{code:'ORIGIN_INVALID_JSON'});
 for(const id of ['9007199254740993','1.5','-1'])await assert.rejects(client(`{"data":{"id":${id},"itens":[{"valor":${token}}]}}`,{purchasePriceCaptureEnabled:true}).get('/pedidos/compras/1'),e=>['ORIGIN_UNSAFE_NUMBER','ORIGIN_INVALID_ID_NUMBER'].includes(e.code));
});
test('strict purchasedetail grammar rejects duplicate prices, malformed/excessive tokens and invalid UTF8',async()=>{
 for(const text of ['{"data":{"itens":[{"valor":1,"v\\u0061lor":2}]}}','{"data":{"itens":[{"valor":1e129}]}}','{"data":{"itens":[{"valor":01}]}}'])await assert.rejects(client(text,{purchasePriceCaptureEnabled:true}).get('/pedidos/compras/1'),e=>/^ORIGIN_(DUPLICATE_JSON_KEY|PRICE_TOKEN_LIMIT|INVALID_JSON)$/.test(e.code));
 await assert.rejects(client(new Uint8Array([0xff]),{purchasePriceCaptureEnabled:true}).get('/pedidos/compras/1'),{code:'ORIGIN_INVALID_JSON'});
 await assert.rejects(client('{"data":{"itens":['+'{"valor":1},'.repeat(4096)+'{"valor":1}]}}',{purchasePriceCaptureEnabled:true}).get('/pedidos/compras/1'),{code:'ORIGIN_PRICE_TOKEN_LIMIT'});
});
test('purchase page keeps ordinary scheduler/detail count and carries capture; detail404 never falls back to list',async()=>{
 for(const missing of [false,true]){
  const calls=[],writes=[];const c=client('',{purchasePriceCaptureEnabled:true,fetchImpl:async url=>{calls.push(url);return url.includes('/compras/1')?(missing?new Response('',{status:404}):new Response(source)):Response.json({data:[{id:1}]});}});
  const repo={claim:async()=>({acquired:true,lease_token:'synthetic',checkpoint:{},checkpoint_version:0}),release:async()=>{},apply:async(...args)=>{writes.push(args);return{purchase_price_captures:1};}};
  const run=()=>syncPage(repo,c,getResource('purchase_orders'),'synthetic',{SYNC_START_DATE:'2026-01-01'},new Date('2026-10-16T12:00:00Z'));
  if(missing){await assert.rejects(run(),{status:404});assert.equal(writes.length,0);}else{const r=await run();assert.equal(r.purchase_price_captures,1);assert.equal(writes[0][4][0].price_capture.profile,'origin-purchase-price-json-v1');}
  assert.equal(calls.length,2);
 }
});
test('repository uses explicit071 RPC, freezes exact request across retry and never falls back on missing schema',async()=>{
 const payload=await client(source,{purchasePriceCaptureEnabled:true}).get('/pedidos/compras/1'),records=[{source_id:'1',payload,price_capture:purchasePriceCapture(payload)}];
 for(const status of[503,404]){const calls=[];const repo=new Repository({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{sleep:async()=>{},fetchImpl:async(url,options)=>{calls.push({url,body:options.body});return calls.length===1?new Response('',{status}):Response.json({ok:true});}});
  const r=repo.apply('purchase_orders','purchase_orders','actor',{lease_token:'fence',checkpoint_version:0},records,{});if(status===404)await assert.rejects(r,/DATABASE_HTTP_404/);else await r;
  assert.equal(calls.length,status===404?1:2);assert.ok(calls.every(c=>c.url.endsWith('/origin_sync_apply_purchase_price_batch')));assert.match(calls[0].body,/"valor":99999999\.1234567891/);if(calls.length===2)assert.equal(calls[0].body,calls[1].body);
 }
});
test('purchase flag has isolated counters, preserves published true configuration and defaults off in the client',async()=>{
 let options;class FakeClient{constructor(_token,o){options=o;}get remainingRequests(){return 0;}}
 const repo={claim:async()=>({acquired:true,lease_token:'fence',checkpoint_version:0,checkpoint:{}}),apply:async()=>({}),release:async()=>{}};
 const r=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',PRICE_CAPTURE_ENABLED:'true',PURCHASE_PRICE_CAPTURE_ENABLED:'true'},{Client:FakeClient,getToken:async()=>'synthetic'});
 assert.equal(options.purchasePriceCaptureEnabled,true);assert.equal(options.priceCaptureEnabled,true);assert.deepEqual(r.purchase_price_capture,{profile:'origin-purchase-price-json-v1',records:0,coverage_complete:false});assert.equal(r.price_capture.profile,'origin-price-json-v1');
 const off=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true'},{Client:FakeClient,getToken:async()=>'synthetic'});assert.equal(options.purchasePriceCaptureEnabled,false);assert.equal(Object.hasOwn(off,'purchase_price_capture'),false);
 const config=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');assert.match(config,/"PURCHASE_PRICE_CAPTURE_ENABLED":\s*"true"/);assert.match(config,/"PRICE_CAPTURE_ENABLED":\s*"true"/);
});
