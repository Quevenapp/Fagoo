import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {OriginClient} from '../src/client.mjs';
import {Repository} from '../src/repository.mjs';
import {priceCapture,canonicalPriceToken} from '../src/price-json.mjs';
import {syncPage} from '../src/sync.mjs';
import {getResource} from '../src/resources.mjs';
const textHash=s=>createHash('sha256').update(s).digest('hex');
function client(text,enabled=true,path='/produtos/1') {const c=new OriginClient('synthetic-only',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:enabled,intervalMs:0,fetchImpl:async()=>new Response(text)});return c.get(path);}

test('selective prices preserve original token and numeric wire value beyond IEEE754',async()=>{
 for(const token of ['99999999.1234567891','99999999999999.9999999999','0.1234567890123456789','-0','1.23000','1.2e-8']){
  const text=`{"data":{"id":1,"preco":${token},"ativo":true,"codigo":"001"}}`,payload=await client(text),wire=JSON.stringify(payload);
  assert.ok(wire.includes(`"preco":${canonicalPriceToken(token)}`));assert.equal(typeof payload.id,'number');assert.equal(payload.ativo,true);assert.equal(payload.codigo,'001');
  assert.deepEqual(priceCapture(payload),{profile:'origin-price-json-v1',source:'detail',response_sha256:textHash(text),tokens:[{path:'/preco',lexeme:token}]});
  assert.throws(()=>payload.preco=0,TypeError);assert.throws(()=>priceCapture(payload).tokens.push({}),TypeError);
 }
});
test('proposal captures only line price; siorigin valor, totals and numeric strings retain existing semantics',async()=>{
 const token='12345678.1234567891',text=`{"data":{"id":1,"itens":[{"valor":${token},"produto":{"id":"001","valor":${token}}},{"valor":"1.23456"},{"valor":null},{}],"parcelas":[{"valor":${token}}],"total":${token}}}`;
 const p=await client(text,true,'/propostas-comerciais/1');assert.deepEqual(priceCapture(p).tokens,[{path:'/itens/0/valor',lexeme:token}]);
 assert.equal(p.itens[0].produto.valor,Number(token));assert.equal(p.parcelas[0].valor,Number(token));assert.equal(p.total,Number(token));assert.equal(p.itens[1].valor,'1.23456');assert.equal(p.itens[2].valor,null);assert.equal(Object.hasOwn(p.itens[3],'valor'),false);
});
test('flag off and other endpoints retain legacy parsing; no evidence is invented',async()=>{
 const text='{"data":{"id":1,"preco":99999999.1234567891}}';
 for(const [enabled,path] of [[false,'/produtos/1'],[true,'/contatos/1']]){const p=await client(text,enabled,path);assert.equal(p.preco,99999999.12345679);assert.equal(priceCapture(p),null);}
 for(const value of ['null','"1.23"','true']){const p=await client(`{"data":{"id":1,"preco":${value}}}`);assert.deepEqual(priceCapture(p).tokens,[]);assert.equal(typeof p.preco,typeof JSON.parse(value));}
});
test('IDs unsafe or fractional remain rejected, including large numbers next to captured price',async()=>{
 for(const id of ['9007199254740993','1.5','-1'])await assert.rejects(client(`{"data":{"id":${id},"preco":99999999999999.9999999999}}`),e=>['ORIGIN_UNSAFE_NUMBER','ORIGIN_INVALID_ID_NUMBER'].includes(e.code));
 await assert.rejects(client('{"data":{"id":1,"preco":1,"other":1e999}}'),{code:'ORIGIN_UNSAFE_NUMBER'});
});
test('strict grammar rejects duplicate/escaped keys, malformed JSON and excessive token expansion',async()=>{
 for(const text of ['{"data":{"preco":1,"preco":2}}','{"data":{"preco":1,"pr\\u0065co":2}}','{"data":{"preco":01}}','{"data":{"preco":1,}}','{"data":{"preco":1}} true','{"data":{"preco":+1}}','{"data":{"preco":1e129}}'])await assert.rejects(client(text),e=>/^ORIGIN_(INVALID_JSON|DUPLICATE_JSON_KEY|PRICE_TOKEN_LIMIT)$/.test(e.code));
 const p=await client('{"data":{"id":1,"preco":1,"__proto__":{"polluted":true},"text":"preco:123.456"}}');assert.equal({}.polluted,undefined);assert.equal(Object.hasOwn(p,'__proto__'),true);
 await assert.rejects(client('{"data":'+('['.repeat(65))+'0'+(']'.repeat(65))+'}'),{code:'ORIGIN_RESPONSE_COMPLEXITY_LIMIT'});
});
test('invalid UTF8, size and incomplete bodies remain bounded',async()=>{
 const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(new Uint8Array([0xff]))});await assert.rejects(c.get('/produtos/1'),{code:'ORIGIN_INVALID_JSON'});
 const c2=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response('{}',{headers:{'content-length':'8388609'}})});await assert.rejects(c2.get('/produtos/1'),{code:'ORIGIN_RESPONSE_SIZE_LIMIT'});
});
test('repository captures exact RPC body once before await and retries preserve it',async()=>{
 const payload=await client('{"data":{"id":1,"preco":99999999.1234567891}}'),body={p_records:[{source_id:'1',payload,price_capture:priceCapture(payload)}]},bodies=[];
 const repo=new Repository({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{sleep:async()=>{},fetchImpl:async(_url,options)=>{bodies.push(options.body);body.p_records=[];return bodies.length===1?new Response('',{status:503}):Response.json({ok:true});}});
 await repo.rpc('origin_sync_apply_batch',body);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.match(bodies[0],/"preco":99999999\.1234567891/);assert.match(bodies[0],/"source_id":"1"/);
});
test('deleted product fallback carries list evidence and original price; normal detail carries detail evidence',async()=>{
 for(const fallback of [false,true]){
  const text='{"data":[{"id":1,"preco":99999999.1234567891}]}';let applied;
  const c=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0,fetchImpl:async url=>url.includes('/produtos/1')?(fallback?new Response('',{status:404}):new Response('{"data":{"id":1,"preco":99999999.1234567891}}')):new Response(text)});
  const repo={claim:async()=>({acquired:true,lease_token:'synthetic',checkpoint:{},checkpoint_version:0}),release:async()=>{},apply:async(_r,_e,_o,_l,records)=>{applied=records;return{stored:true};}};
  await syncPage(repo,c,getResource(fallback?'products_deleted_zero':'products_zero'),'synthetic',{SYNC_START_DATE:'2026-01-01'},new Date('2026-10-16T12:00:00Z'));
  assert.match(JSON.stringify(applied[0].payload),/"preco":99999999\.1234567891/);assert.equal(applied[0].price_capture.source,fallback?'list_fallback':'detail');
 }
});

test('enabled captured batches use059-only RPC and schema absence never falls back to legacy apply',async()=>{
 const payload=await client('{"data":{"id":1,"preco":0.1234567891}}'),urls=[];
 const repo=new Repository({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{fetchImpl:async url=>{urls.push(url);return new Response('',{status:404});}});
 await assert.rejects(repo.apply('products_zero','products','actor',{lease_token:'fence',checkpoint_version:0},[{source_id:'1',payload,price_capture:priceCapture(payload)}],{}),/DATABASE_HTTP_404/);
 assert.equal(urls.length,1);assert.ok(urls[0].endsWith('/origin_sync_apply_price_batch'));
});
