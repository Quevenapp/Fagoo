import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {processedFixtures} from './processed-fixtures.mjs';
import {createProcessedSource} from '../src/processed-source.mjs';
import {createProcessedRuntimeHandler} from '../src/processed-handler.mjs';
import {decodeProcessedXml} from '../src/processed-dto.mjs';
import {renderProcessedHtml} from '../../fiscal-danfe/src/processed-render.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';let Miniflare,convertV4MiniflareOptions,bundle,f;
const secret=new Uint8Array(32).fill(12),actor='10000000-0000-4000-8000-000000000001';
if(enabled){
 ({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));const{build}=await import('esbuild');
 const built=await build({entryPoints:[fileURLToPath(new URL('./processed-workerd-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent'});
 assert.ok(Object.keys(built.metafile.inputs).every(p=>!p.includes('node_modules')&&!p.includes('processed-handler')&&!p.includes('processed-source')&&!p.includes('fiscal-danfe/src')));bundle=built.outputFiles[0].text;assert.doesNotMatch(bundle,/node:|readFileSync|createHash/);
}
test.before(async()=>{if(enabled)f=await processedFixtures();});test.after(()=>f?.close());
async function setup(model,kind,options={}){
 const x=f.create(model,kind),calls={auth:0,runtime:0};const handler=createProcessedRuntimeHandler({readSource:createProcessedSource(x.ports),render:renderProcessedHtml,transportSecret:secret,transportKeyId:'synthetic',audience:'synthetic-danfe'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-16',cf:false,
  bindings:{ALLOWED_ORIGINS:'https://app.synthetic.invalid',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:Buffer.from(secret).toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic',A1_AUDIENCE:'synthetic'},
  outboundService:req=>{calls.auth++;assert.equal(req.url,'https://abcdefghijklmnopqrst.supabase.co/auth/v1/user');return Response.json({id:actor,is_anonymous:options.anonymous===true});},
  serviceBindings:{A1_RUNTIME:async req=>{calls.runtime++;assert.equal(req.method,'GET');assert.equal(req.headers.get('apikey'),null);if(options.redirect)return new Response(null,{status:302,headers:{Location:'https://never.invalid'}});const path=new URL(req.url).pathname;const r=await handler(new Request('http://runtime.internal'+path,{headers:req.headers,signal:req.signal}));if(options.badHash){const v=await r.json();v.source.processed_hash='0'.repeat(64);return Response.json(v);}return r;}}
 }));
 return{x,calls,request:(action='xml')=>mf.dispatchFetch(`https://gateway.synthetic.invalid/v1/fiscal-danfe/${kind==='authorization'?'authorizations':'revalidations'}/${x.input.commandId}/${action}`,{headers:{Origin:'https://app.synthetic.invalid',Authorization:'Bearer synthetic-user-session-1234567890'}}),close:async()=>{handler.dispose();await mf.dispose();}};
}
test('workerd browser bundle through real Node source/handler returns exact55/65 stored XML, both origins',{skip:!enabled,timeout:60000},async()=>{
 for(const model of ['55','65'])for(const kind of ['authorization','revalidation']){const a=await setup(model,kind);try{const r=await a.request();assert.equal(r.status,200);const v=await r.json();assert.deepEqual(Buffer.from(decodeProcessedXml(v.xml_base64)),Buffer.from(a.x.processed.processedXml));assert.equal(a.x.calls.command.length,3);assert.deepEqual(a.calls,{auth:1,runtime:1});}finally{await a.close();}}
});
test('workerd never forwards anonymous sessions or retries redirects and corrupted blobs',{skip:!enabled,timeout:60000},async()=>{
 for(const [options,status,count]of [[{anonymous:true},401,0],[{redirect:true},502,1],[{badHash:true},502,1]]){const a=await setup('55','authorization',options);try{const r=await a.request();assert.equal(r.status,status);const v=await r.json();assert.equal(v.xml_base64,undefined);assert.equal(v.recovery_required,false);assert.equal(a.calls.runtime,count);}finally{await a.close();}}
});
test('workerd print uses the real historical reader and renderer with a final ACL read',{skip:!enabled,timeout:60000},async()=>{
 for(const [model,kind]of [['55','authorization'],['65','revalidation']]){const a=await setup(model,kind);try{const r=await a.request('print');assert.equal(r.status,200);const v=await r.json();assert.equal(v.action,'print');assert.equal(v.source.model,model);assert.match(v.html,/HOMOLOGAÇÃO - SEM VALOR FISCAL/);assert.ok(v.html.includes(v.source.protocol.number));assert.equal(v.xml_base64,undefined);assert.equal(a.x.calls.command.length,3);assert.deepEqual(a.calls,{auth:1,runtime:1});}finally{await a.close();}}
});
