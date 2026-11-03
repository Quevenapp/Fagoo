import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';
test('063 workerd uses fixed GET-only cash/stock paths and WebCrypto checkpoint without external traffic',{skip:!enabled,timeout:30000},async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare'),{build}=await import('esbuild');
 const client=fileURLToPath(new URL('../src/client.mjs',import.meta.url)),sync=fileURLToPath(new URL('../src/sync.mjs',import.meta.url)),resources=fileURLToPath(new URL('../src/resources.mjs',import.meta.url));
 const bundle=await build({stdin:{contents:`import {OriginClient} from ${JSON.stringify(client)};import {syncPage} from ${JSON.stringify(sync)};import {getResource} from ${JSON.stringify(resources)};
 export default{async fetch(request){const mode=new URL(request.url).pathname==='\/stock'?'stock_balances':'cash_entries_registered',commits=[];
 const repo={claim:async()=>({acquired:true,lease_token:'synthetic',checkpoint_version:0,checkpoint:{}}),renew:async()=>{},release:async()=>{},rpc:async(name)=>{if(name!=='origin_sync_stock_product_page')throw Error('UNEXPECTED_RPC');return{items:['1','2'],has_more:false,next_cursor:null,coverage_complete:false}},apply:async(...args)=>{commits.push(args);return{inserted:args[4].length}}};
 const c=new OriginClient('synthetic-only',{ apiOrigin: 'https://api.provider.example',intervalMs:0,maxRequests:20});const result=await syncPage(repo,c,getResource(mode),'synthetic-owner',{SYNC_START_DATE:'2024-01-01'},new Date('2026-10-16T20:00:00Z'));return Response.json({result,commits,requests:c.requestsMade});}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const seen=[];const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-15',cf:false,outboundService:request=>{
  const u=new URL(request.url);assert.equal(u.origin,'https://api.provider.example');assert.equal(request.method,'GET');seen.push(u);
  if(u.pathname==='/Api/v3/caixas'){assert.equal(u.searchParams.has('limite'),false);return Response.json({data:Array.from({length:11},(_,i)=>({id:i+1}))});}
  if(/^\/Api\/v3\/caixas\/\d+$/.test(u.pathname))return Response.json({id:Number(u.pathname.split('/').at(-1)),data:'2026-10-16',valor:12.5});
  if(u.pathname==='/Api/v3/estoques/saldos'){assert.deepEqual(u.searchParams.getAll('idsProdutos[]'),['1','2']);return Response.json({data:u.searchParams.get('filtroSaldoEstoque')==='0'?[{produto:{id:1},saldoFisicoTotal:0,depositos:[{id:'99',saldoFisico:0}]}]:[]});}
  throw Error('UNEXPECTED_UPSTREAM_PATH');
 }}));
 try{
  const cash=await(await mf.dispatchFetch('https://synthetic.invalid/cash')).json();assert.equal(cash.result.records,10);assert.equal(cash.requests,11);assert.equal(cash.commits[0][5].recent.offset,10);assert.match(cash.commits[0][5].recent.list_fingerprint,/^[a-f0-9]{64}$/);assert.equal(cash.commits[0][4][0].payload.data,'2026-10-16');
  const stock=await(await mf.dispatchFetch('https://synthetic.invalid/stock')).json();assert.equal(stock.result.records,1);assert.equal(stock.result.unavailable,1);assert.equal(stock.requests,3);assert.equal(stock.commits[0][4][0].payload.depositos[0].id,'99');assert.equal(stock.commits[0][5].last_observation.coverage_complete,false);assert.equal(seen.length,14);
 }finally{await mf.dispose();}
});
