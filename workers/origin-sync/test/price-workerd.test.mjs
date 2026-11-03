import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';
test('workerd collector profile serializes selected exact numbers and preserves non-price types', {skip:!enabled,timeout:30000},async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare'),{build}=await import('esbuild');
 const client=fileURLToPath(new URL('../src/client.mjs',import.meta.url)),capture=fileURLToPath(new URL('../src/price-json.mjs',import.meta.url));
 const bundle=await build({stdin:{contents:`import {OriginClient} from ${JSON.stringify(client)};import {priceCapture} from ${JSON.stringify(capture)};export default {async fetch(){const c=new OriginClient('synthetic-only',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:true,intervalMs:0});const p=await c.get('/produtos/1');return new Response(JSON.stringify({payload:p,capture:priceCapture(p)}));}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 let requests=0;const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-15',cf:false,outboundService:request=>{requests++;assert.equal(request.url,'https://api.provider.example/Api/v3/produtos/1');assert.equal(request.method,'GET');return new Response('{"data":{"id":1,"preco":99999999999999.9999999999,"active":true,"code":"001"}}');}}));
 try{const response=await mf.dispatchFetch('https://synthetic.invalid/');assert.equal(response.status,200);const text=await response.text();assert.match(text,/"preco":99999999999999\.9999999999/);assert.match(text,/"id":1/);assert.match(text,/"active":true/);assert.match(text,/"code":"001"/);assert.equal(JSON.parse(text).capture.tokens[0].lexeme,'99999999999999.9999999999');assert.equal(requests,1);}finally{await mf.dispose();}
});
