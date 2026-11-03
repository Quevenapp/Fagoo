import {evaluateNfceEmissionWindow} from '../../fiscal-authorization/src/emission-window.mjs';
import {revalidationBody,contextPath as revalidationContextPath,runPath as revalidationRunPath,commandPath as revalidationCommandPath,revalidationContext,revalidationResult} from './revalidation-fixtures.mjs';
import {closureBody,closureResult} from './closure-fixtures.mjs';
import {selectedRunBody} from './dispatch-fixtures.mjs';
import {dispatchResult,dispatchHistory,dispatchPreflight} from './dispatch-fixtures.mjs';
import {FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
import {DISPATCH_PROFILE} from '../src/dispatch-protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {env,secret,keyId,audience,actor,candidateId,commandId,previewBody,runBody,preview,result} from './fixtures.mjs';
import {context as reviewContext,result as reviewResult,saveBody} from './review-fixtures.mjs';
import {verifyRuntimeRequest} from '../src/auth.mjs';
const enabled=process.env.BRUFAP_RUN_WORKERD_TESTS==='1';let Miniflare,convertV4MiniflareOptions,bundle;
if(enabled){({Miniflare,convertV4MiniflareOptions}=await import('miniflare'));const {build}=await import('esbuild');const built=await build({entryPoints:[fileURLToPath(new URL('./workerd-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent'});assert.ok(Object.keys(built.metafile.inputs).every(path=>!path.includes('node_modules')&&!path.includes('/handler.mjs')&&(!path.includes('fiscal-authorization/src/')||['preflight-dto.mjs','emission-window.mjs','selected-run-dto.mjs','closure-dto.mjs','closure-lookup-dto.mjs','revalidation-public-dto.mjs','receipt-query-public-dto.mjs','rule-profile-registry.mjs'].includes(path.split('/').at(-1)))));bundle=built.outputFiles[0].text;assert.doesNotMatch(bundle,/node:|readFileSync|createHash/);}
function timedPreflight(model){const v=dispatchPreflight();if(model!=='65')return v;v.candidate.model='65';v.emission_window=evaluateNfceEmissionWindow({model:'65',environment:'2',emissionType:'1',issuedAt:new Date(Date.now()-301000).toISOString(),now:Date.now(),safetyMarginMs:30000});v.blockers.splice(v.blockers.indexOf('RUNTIME_DISABLED'),0,'AUTHORIZATION_NFCE_EMISSION_EXPIRED');return v;}
async function setup({anonymous=false,redirect=false,reviewedEnabled=false,preflightModel='55'}={}){
 const calls={auth:0,runtime:0};const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-16',cf:false,bindings:{...env(),...(reviewedEnabled?{FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'true'}:{})},outboundService:request=>{calls.auth++;assert.equal(request.url,env().SUPABASE_URL+'/auth/v1/user');return Response.json({id:actor,is_anonymous:anonymous});},serviceBindings:{A1_RUNTIME:async request=>{calls.runtime++;const path=new URL(request.url).pathname;const claim=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId,audience,method:request.method,path});assert.equal(claim.actor,actor);if(path.includes('/revalidation-context/'))return Response.json(revalidationContext());if(path.endsWith('/reviewed/revalidations'))return Response.json(revalidationResult(false));if(path.includes('/reviewed/revalidation-commands/'))return Response.json(revalidationResult());if(path.endsWith('/reviewed/close-expired'))return Response.json(closureResult());if(path.includes('/reviewed/commands/')&&path.endsWith('/closure'))return Response.json(closureResult(true));if(path.includes('/reviewed/closure-commands/'))return Response.json(closureResult(true));if(path.includes('/reviewed/'))return Response.json(path.endsWith('/preflight')?timedPreflight(preflightModel):path.endsWith('/status')?{...FLAGS,tax_rules_validated:false,dispatch_profile:DISPATCH_PROFILE,read_only:true,runtime_enabled:reviewedEnabled,policy_checked:false}:path.endsWith('/history')?dispatchHistory():dispatchResult({state:'authorized_homologation',reading:request.method==='GET'}));return redirect?new Response(null,{status:302,headers:{Location:'https://never.invalid','Content-Type':'application/json'}}):Response.json(path.endsWith('/review')?(request.method==='POST'?reviewResult():reviewContext()):path.includes('/review-commands/')?reviewResult('command'):path.endsWith('/preview')?preview():result());}}}));
 return{calls,request:(path,body)=>mf.dispatchFetch('https://gateway.synthetic.invalid/v1/fiscal-authorization'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://app.synthetic.invalid',Authorization:'Bearer synthetic-user-session-1234567890',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),close:()=>mf.dispose()};
}
test('workerd authenticates exact preview and command in the new domain without Node dependencies',{skip:!enabled,timeout:30000},async()=>{const f=await setup();try{for(const[path,body]of [['/preview',previewBody],['/commands/'+commandId,undefined]]){const r=await f.request(path,body);assert.equal(r.status,200);assert.equal((await r.json()).can_transmit,false);}assert.deepEqual(f.calls,{auth:2,runtime:2});}finally{await f.close();}});
test('workerd rejects run before private binding, anonymous sessions and redirects without retry',{skip:!enabled,timeout:30000},async()=>{for(const[options,path,body,status,runtime]of [[{},'/run',runBody,503,0],[{anonymous:true},'/preview',previewBody,401,0],[{redirect:true},'/preview',previewBody,502,1]]){const f=await setup(options);try{assert.equal((await f.request(path,body)).status,status);assert.deepEqual(f.calls,{auth:1,runtime});}finally{await f.close();}}});

test('workerd admits review context/save/command only after Origin/Auth with unchanged browser-safe projection',{skip:!enabled,timeout:30000},async()=>{const f=await setup();try{for(const[path,body,kind]of [[`/candidates/${candidateId}/review`,undefined,'context'],[`/candidates/${candidateId}/review`,saveBody(),'save'],[`/review-commands/${commandId}`,undefined,'command']]){const r=await f.request(path,body);assert.equal(r.status,200,await r.clone().text());const v=await r.json();assert.equal(v.kind,kind);assert.equal(v.can_emit,false);assert.equal(v.can_transmit,false);assert.equal(v.tax_rules_validated,false);}assert.deepEqual(f.calls,{auth:3,runtime:3});}finally{await f.close();}});


test('workerd reviewed routes stay versioned, default gate blocks run and readings retain the operational DTO',{skip:!enabled,timeout:30000},async()=>{
 const f=await setup();try{
  const disabled=await f.request('/reviewed/run',selectedRunBody);assert.equal(disabled.status,503);assert.equal((await disabled.json()).recovery_required,false);assert.equal(f.calls.runtime,0);
  for(const[path,body]of [['/reviewed/preflight',{candidate_id:candidateId,signed_hash:runBody.signed_hash}],['/reviewed/status',undefined],['/reviewed/commands/'+commandId,undefined],['/reviewed/candidates/'+candidateId+'/history',{limit:25,before:null}],['/reviewed/recover',{command_id:commandId}]]){const r=await f.request(path,body);assert.equal(r.status,200,await r.clone().text());const v=await r.json();assert.equal(v.tax_rules_validated,false);assert.equal(v.can_emit,false);}
  assert.equal(f.calls.runtime,5);
 }finally{await f.close();}
 const active=await setup({reviewedEnabled:true});try{const r=await active.request('/reviewed/run',selectedRunBody);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).authorized_in_homologation,true);assert.equal(active.calls.runtime,1);}finally{await active.close();}
});


test('workerd closes and reads expired attempts with reviewed gateoff and no private request hash',{skip:!enabled,timeout:30000},async()=>{
 const f=await setup();try{
  for(const[path,body,readOnly]of [['/reviewed/close-expired',closureBody,false],['/reviewed/closure-commands/'+closureBody.command_id,undefined,true]]){
   const response=await f.request(path,body);assert.equal(response.status,200,await response.clone().text());const value=await response.json();assert.deepEqual(value,closureResult(readOnly));assert.equal(Object.hasOwn(value.receipt,'request_hash'),false);
  }
  assert.deepEqual(f.calls,{auth:2,runtime:2});
 }finally{await f.close();}
});


test('workerd discovers closure receipt by exact original and attempt with gateoff and no write route',{skip:!enabled,timeout:30000},async()=>{
 const f=await setup();try{const path=`/reviewed/commands/${closureBody.authorization_command_id}/attempts/${closureBody.expected_attempt_id}/closure`,r=await f.request(path);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),closureResult(true));assert.deepEqual(f.calls,{auth:1,runtime:1});}finally{await f.close();}
});


test('workerd079 revalidates stored bytes with issuance gateoff and public DTO only',{skip:!enabled,timeout:30000},async()=>{
 const f=await setup();try{
  for(const[path,body,expected]of[[revalidationContextPath,undefined,revalidationContext()],[revalidationRunPath,revalidationBody,revalidationResult(false)],[revalidationCommandPath,undefined,revalidationResult()]]){
   const r=await f.request(path,body);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),expected);
  }
  assert.deepEqual(f.calls,{auth:3,runtime:3});
 }finally{await f.close();}
});

test('workerd080 validates the exact NFC-e calendar/deadline and closed expiry blocker without Node', {skip:!enabled,timeout:30000},async()=>{
 const f=await setup({preflightModel:'65'});try{const r=await f.request('/reviewed/preflight',{candidate_id:candidateId,signed_hash:runBody.signed_hash});assert.equal(r.status,200,await r.clone().text());const v=await r.json();assert.equal(v.candidate.model,'65');assert.equal(v.emission_window.status,'expired');assert.equal(v.emission_window.safety_margin_seconds,30);assert.equal(Date.parse(v.emission_window.expires_at)-Date.parse(v.emission_window.issued_at),300000);assert.ok(v.blockers.includes('AUTHORIZATION_NFCE_EMISSION_EXPIRED'));assert.equal(v.can_run,false);assert.deepEqual(f.calls,{auth:1,runtime:1});}finally{await f.close();}
});
