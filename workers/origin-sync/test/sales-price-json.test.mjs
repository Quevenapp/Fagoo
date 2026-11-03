import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {OriginClient} from '../src/client.mjs';
import {Repository} from '../src/repository.mjs';
import {priceCapture} from '../src/price-json.mjs';
import {purchasePriceCapture} from '../src/purchase-price-json.mjs';
import {parseSalesPriceJson,salesPriceCapture,salesPriceEndpoint} from '../src/sales-price-json.mjs';
import {syncPage,runSync} from '../src/sync.mjs';
import {getResource} from '../src/resources.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex'),token='99999999.1234567891';
const source=`{"data":{"id":1,"itens":[{"id":9,"produto":{"id":2,"valor":${token}},"valor":${token},"valorLista":${token},"quantidade":${token},"desconto":${token}},{"valor":"1.23"},{"valor":null},{}],"total":${token},"parcelas":[{"valor":${token}}],"ativo":true}}`;
const client=(text,options={})=>new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>new Response(text),...options});
test('078 preserves only sale item valor as exact numeric; IDs/list price/discount and totals keep their contracts',async()=>{
 const p=await client(source,{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1');
 assert.match(JSON.stringify(p),/"valor":99999999\.1234567891/);assert.equal(p.id,1);assert.equal(p.ativo,true);assert.equal(p.itens[0].id,9);assert.equal(p.itens[0].produto.id,2);
 for(const n of[p.itens[0].produto.valor,p.itens[0].valorLista,p.itens[0].quantidade,p.itens[0].desconto,p.total,p.parcelas[0].valor])assert.equal(n,Number(token));
 assert.equal(p.itens[1].valor,'1.23');assert.equal(p.itens[2].valor,null);assert.equal(Object.hasOwn(p.itens[3],'valor'),false);
 assert.deepEqual(salesPriceCapture(p),{profile:'origin-sales-price-json-v1',response_sha256:hash(source),source:'detail',tokens:[{path:'/itens/0/valor',lexeme:token}]});
 assert.equal(priceCapture(p),null);assert.equal(purchasePriceCapture(p),null);assert.throws(()=>p.itens[0].valor=0);assert.throws(()=>salesPriceCapture(p).tokens.pop());
});
test('078 default/off and other flags do not capture sales; lists/objects-as-array and purchases do not acquire its profile',async()=>{
 for(const options of [{},{salesPriceCaptureEnabled:false},{priceCaptureEnabled:true},{purchasePriceCaptureEnabled:true}]){const p=await client(source,options).get('/pedidos/vendas/1');assert.equal(p.itens[0].valor,Number(token));assert.equal(salesPriceCapture(p),null);}
 const list=await client('{"data":['+source.slice(8,-1)+']}',{salesPriceCaptureEnabled:true}).get('/pedidos/vendas');assert.equal(salesPriceCapture(list[0]),null);assert.equal(list[0].itens[0].valor,Number(token));
 const purchase=await client(source,{salesPriceCaptureEnabled:true}).get('/pedidos/compras/1');assert.equal(purchase.itens[0].valor,Number(token));assert.equal(salesPriceCapture(purchase),null);
 const object=await client(`{"data":{"id":1,"itens":{"0":{"valor":${token}}}}}`,{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1');assert.deepEqual(salesPriceCapture(object).tokens,[]);assert.equal(object.itens['0'].valor,Number(token));
 for(const path of ['/pedidos/vendas','/pedidos/vendas/1/','/pedidos/compras/1','/produtos/1'])assert.equal(salesPriceEndpoint(path),null);
 assert.throws(()=>client(source,{salesPriceCaptureEnabled:'true'}),{code:'ORIGIN_INVALID_CLIENT_CONFIG'});
});
test('original token exponent/zeros remain evidence, response bytes are copied before digest, IDs remain safe',async()=>{
 for(const [lexeme,numeric]of[['1.2300e2','123'],['-0.000','0'],['0.12345678901234567890123456789','0.12345678901234567890123456789']]){
  const text=`{"data":{"id":1,"itens":[{"valor":${lexeme}}]}}`,bytes=new TextEncoder().encode(text),pending=parseSalesPriceJson(text,bytes,'sales_detail');bytes.fill(0);const p=(await pending).data;
  assert.equal(salesPriceCapture(p).response_sha256,hash(text));assert.equal(salesPriceCapture(p).tokens[0].lexeme,lexeme);assert.equal(JSON.stringify(p.itens[0]),`{"valor":${numeric}}`);
 }
 await assert.rejects(parseSalesPriceJson(source,new TextEncoder().encode(source+' '),'sales_detail'),{code:'ORIGIN_INVALID_JSON'});
 await assert.rejects(parseSalesPriceJson(source,new TextEncoder().encode(source),'purchase_detail'),{code:'ORIGIN_PRICE_CAPTURE_UNAVAILABLE'});
 for(const id of ['9007199254740993','1.5','-1'])await assert.rejects(client(`{"data":{"id":${id},"itens":[{"valor":${token}}]}}`,{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1'),e=>['ORIGIN_UNSAFE_NUMBER','ORIGIN_INVALID_ID_NUMBER'].includes(e.code));
 const text='\ufeff'+source,p=await client(new TextEncoder().encode(text),{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1');assert.equal(salesPriceCapture(p).response_sha256,hash(text));
});
test('078 strict grammar fails closed on duplicates, UTF8, malformed/excessive tokens and bounded complexity',async()=>{
 for(const text of ['{"data":{"itens":[{"valor":1,"v\\u0061lor":2}]}}','{"data":{"itens":[{"valor":1e129}]}}','{"data":{"itens":[{"valor":01}]}}'])await assert.rejects(client(text,{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1'),e=>/^ORIGIN_(DUPLICATE_JSON_KEY|PRICE_TOKEN_LIMIT|INVALID_JSON)$/.test(e.code));
 await assert.rejects(client(new Uint8Array([0xff]),{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1'),{code:'ORIGIN_INVALID_JSON'});
 await assert.rejects(client('{"data":{"itens":['+'{"valor":1},'.repeat(4096)+'{"valor":1}]}}',{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1'),{code:'ORIGIN_PRICE_TOKEN_LIMIT'});
 await assert.rejects(client('{"data":'+ '['.repeat(65)+'1'+']'.repeat(65)+'}',{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1'),{code:'ORIGIN_RESPONSE_COMPLEXITY_LIMIT'});
});
test('sales page keeps GET count and checkpoint contract; detail404 never uses list values',async()=>{
 for(const missing of[false,true]){const calls=[],writes=[];const c=client('',{salesPriceCaptureEnabled:true,fetchImpl:async url=>{calls.push(url);return url.includes('/vendas/1')?(missing?new Response('',{status:404}):new Response(source)):Response.json({data:[{id:1}]});}});
  const repo={claim:async()=>({acquired:true,lease_token:'synthetic',checkpoint:{},checkpoint_version:0}),release:async()=>{},apply:async(...args)=>{writes.push(args);return{sales_price_captures:1};}};
  const run=()=>syncPage(repo,c,getResource('sales_orders'),'synthetic',{SYNC_START_DATE:'2026-01-01'},new Date('2026-10-17T12:00:00Z'));
  if(missing){await assert.rejects(run(),{status:404});assert.equal(writes.length,0);}else{const r=await run();assert.equal(r.sales_price_captures,1);assert.equal(writes[0][4][0].price_capture.profile,'origin-sales-price-json-v1');}
  assert.equal(calls.length,2);
 }
});
test('repository uses explicit078 RPC and retries only identical captured body/UUID; missing schema has no fallback',async()=>{
 const payload=await client(source,{salesPriceCaptureEnabled:true}).get('/pedidos/vendas/1');
 for(const status of[503,404]){const calls=[],records=[{source_id:'1',payload,price_capture:salesPriceCapture(payload)}];const repo=new Repository({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{sleep:async()=>{},fetchImpl:async(url,options)=>{calls.push({url,body:options.body});records[0].source_id='changed';return calls.length===1?new Response('',{status}):Response.json({ok:true});}});
  const r=repo.apply('sales_orders','sales_orders','actor',{lease_token:'fence',checkpoint_version:0},records,{});if(status===404)await assert.rejects(r,/DATABASE_HTTP_404/);else await r;
  assert.equal(calls.length,status===404?1:2);assert.ok(calls.every(c=>c.url.endsWith('/origin_sync_apply_sales_price_batch')));assert.match(calls[0].body,/"valor":99999999\.1234567891/);assert.equal(JSON.parse(calls[0].body).p_records[0].source_id,'1');if(calls.length===2)assert.equal(calls[0].body,calls[1].body);
 }
});
test('sales flags/counters are isolated, false by default and preserve current120 budget/configuration',async()=>{
 let options;class FakeClient{constructor(_token,o){options=o;}get remainingRequests(){return 0;}}
 const repo={claim:async()=>({acquired:true,lease_token:'fence',checkpoint_version:0,checkpoint:{}}),apply:async()=>({}),release:async()=>{}};
 const xmlCollector=async()=>({errors:[],stop_json:false});
 const r=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',XML_SYNC_ENABLED:'true',XML_RESIDUAL_ENABLED:'true',MAX_API_REQUESTS:'240',PRICE_CAPTURE_ENABLED:'true',PURCHASE_PRICE_CAPTURE_ENABLED:'true',SALES_PRICE_CAPTURE_ENABLED:'true'},{Client:FakeClient,getToken:async()=>'synthetic',xmlCollector});
 assert.equal(options.maxRequests,120);assert.equal(options.salesPriceCaptureEnabled,true);assert.equal(options.purchasePriceCaptureEnabled,true);assert.equal(options.priceCaptureEnabled,true);
 assert.deepEqual(r.sales_price_capture,{profile:'origin-sales-price-json-v1',records:0,coverage_complete:false});assert.equal(r.price_capture.profile,'origin-price-json-v1');assert.equal(r.purchase_price_capture.profile,'origin-purchase-price-json-v1');
 const off=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true'},{Client:FakeClient,getToken:async()=>'synthetic'});assert.equal(options.salesPriceCaptureEnabled,false);assert.equal(Object.hasOwn(off,'sales_price_capture'),false);
 const config=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');for(const [key,value]of [['SALES_PRICE_CAPTURE_ENABLED','true'],['PURCHASE_PRICE_CAPTURE_ENABLED','true'],['PRICE_CAPTURE_ENABLED','true'],['XML_RESIDUAL_ENABLED','true'],['MAX_API_REQUESTS','120']])assert.match(config,new RegExp(`"${key}":\\s*"${value}"`));
});
test('real client shares120 calls and700ms cadence across sales/purchases/products and stops after exhausted retry',async()=>{
 let clock=0;const starts=[];const c=client('',{now:()=>clock,sleep:async ms=>{clock+=ms;},intervalMs:700,maxRequests:120,salesPriceCaptureEnabled:true,purchasePriceCaptureEnabled:true,priceCaptureEnabled:true,fetchImpl:async url=>{starts.push(clock);return new Response(url.includes('/produtos/')?'{"data":{"id":1,"preco":1.2345678912}}':source);}});
 for(let i=0;i<120;i++)await c.get(['/pedidos/vendas/1','/pedidos/compras/1','/produtos/1'][i%3]);
 await assert.rejects(c.get('/pedidos/vendas/1'),{code:'ORIGIN_REQUEST_BUDGET_EXHAUSTED'});assert.equal(starts.length,120);assert.ok(starts.slice(1).every((x,i)=>x-starts[i]>=700));
 const limited=client('',{salesPriceCaptureEnabled:true,maxRequests:1,fetchImpl:async()=>new Response('',{status:429,headers:{'Retry-After':'0'}}),sleep:async()=>{}});
 await assert.rejects(limited.get('/pedidos/vendas/1'),e=>e.code==='ORIGIN_REQUEST_BUDGET_EXHAUSTED'&&e.status===429);assert.equal(limited.requestsMade,1);
});
