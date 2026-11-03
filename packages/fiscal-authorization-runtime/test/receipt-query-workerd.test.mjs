import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {env,secret,keyId,audience,actor} from './fixtures.mjs';
import {verifyRuntimeRequest,digest} from '../src/auth.mjs';
import {publicContext,publicHistory,publicResult,publicSelection,contextBinding,uuid} from '../../fiscal-authorization/test/receipt-query-public-fixture.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';
test('workerd089 keeps five routes browser-safe, signs exact bodies and gates only new consultation',{skip:!enabled,timeout:30000},async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare'),{build}=await import('esbuild');
 const built=await build({entryPoints:[fileURLToPath(new URL('./workerd-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent'});
 const allowed=['preflight-dto.mjs','emission-window.mjs','selected-run-dto.mjs','closure-dto.mjs','closure-lookup-dto.mjs','revalidation-public-dto.mjs','receipt-query-public-dto.mjs','rule-profile-registry.mjs'];
 assert.ok(Object.keys(built.metafile.inputs).every(path=>!path.includes('node_modules')&&!path.includes('/handler.mjs')&&(!path.includes('fiscal-authorization/src/')||allowed.includes(path.split('/').at(-1)))));
 const bundle=built.outputFiles[0].text;assert.doesNotMatch(bundle,/node:|readFileSync|createHash|withReceiptQueryCredential/);
 const body={...publicSelection(),command_id:uuid(11),confirmed:true},commandPath='/reviewed/receipt-query-commands/'+body.command_id;
 for(const flag of['false','true']){
  const calls={auth:0,runtime:[]},mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-16',cf:false,bindings:{...env(),FISCAL_RECEIPT_QUERY_ENABLED:flag,FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false'},
   outboundService:request=>{calls.auth++;assert.equal(request.url,env().SUPABASE_URL+'/auth/v1/user');return Response.json({id:actor});},
   serviceBindings:{A1_RUNTIME:async request=>{
    const path=new URL(request.url).pathname,claim=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId,audience,method:request.method,path});assert.equal(claim.actor,actor);
    const bytes=new Uint8Array(await request.arrayBuffer());assert.equal(claim.body_hash,await digest(bytes));calls.runtime.push(path);
    return Response.json(path.endsWith('receipt-query-context')?publicContext({canQuery:flag==='true'}):path.endsWith('receipt-query-history')?publicHistory().raw:publicResult({readOnly:request.method==='GET'}));
   }}}));
  const send=(path,input)=>mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-authorization'+path,{method:input===undefined?'GET':'POST',headers:{Origin:'https://app.synthetic.invalid',Authorization:'Bearer synthetic-user-session-1234567890',...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  try{
   for(const[path,input]of[['/reviewed/receipt-query-context',contextBinding(publicContext()).input],['/reviewed/receipt-query-history',publicHistory().binding.input],[commandPath,undefined],[commandPath+'/recover',{confirmed:true}],['/reviewed/receipt-queries',body]]){
    const r=await send(path,input);assert.equal(r.status,path.endsWith('/receipt-queries')&&flag==='false'?503:200,await r.clone().text());const v=await r.json();if(r.status===200){assert.equal(v.can_transmit,false);assert.equal(v.production_authorized,false);}else assert.equal(v.recovery_required,false);
   }
   assert.equal(calls.auth,5);assert.equal(calls.runtime.length,flag==='true'?5:4);
  }finally{await mf.dispose();}
 }
});
