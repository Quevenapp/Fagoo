import test from 'node:test';import assert from 'node:assert/strict';
import * as access from '../src/lib/real-access.ts';
import {createFiscalReviewedAuthorizationClient} from '../src/lib/fiscal-reviewed-authorization-client.ts';
import {captureReviewedAuthorizationRequest} from '../src/lib/fiscal-reviewed-authorization-model.ts';
import {closureLookupInput,closureLookupPath} from '../src/lib/fiscal-authorization-closure-lookup-model.ts';
import {lookupFixture} from './helpers/fiscal-closure-lookup-fixtures.mjs';
import {original,closed} from './helpers/fiscal-closure-fixtures.mjs';
import {actor,deferred,history} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {signedFixture,checkbox} from './helpers/fiscal-signed-ui-fixture.mjs';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
const f=lookupFixture(),path=closureLookupPath(closureLookupInput(f.failed,f.candidate)),origin='https://closure-lookup.synthetic.invalid',token='synthetic-lookup-token',fresh='synthetic-lookup-fresh';
const member=(role='fiscal')=>({user_id:actor,role,resources:['nfe','nfce'],data_mode:'staging_readonly'}),state=()=>({phase:'ready',membership:member()});
const tick=()=>new Promise(resolve=>setImmediate(resolve));async function until(p){for(let i=0;i<200&&!p();i++)await tick();assert.ok(p(),'bounded fixture wait');}
test('075 client accepts only exact bodyless GET, binds discovered receipt and applies16KiB decoded bound',async()=>{
 const selected=captureReviewedAuthorizationRequest(path);assert.equal(selected.mutation,false);assert.equal(selected.route.responseLimit,16384);assert.equal(selected.binding.action,'closureLookup');
 for(const [p,o]of [[path+'?x=1',{}],[path+'/',{}],[path.replace('/attempts/','/attempt/'),{}],[path,{method:'POST',body:{}}],[path,{body:{}}]])assert.throws(()=>captureReviewedAuthorizationRequest(p,o));
 let calls=0;const ports={origin,getToken:()=>token,getSnapshot:state,fetchImpl:async(url,o)=>{calls++;assert.equal(url,origin+path);assert.equal(o.method,'GET');assert.equal(o.body,undefined);assert.equal(o.credentials,'omit');assert.equal(o.cache,'no-store');return Response.json(closed(f.original));}};
 const value=await createFiscalReviewedAuthorizationClient(ports)(path);assert.equal(value.command_id,closed(f.original).command_id);assert.equal(value.read_only,true);assert.equal(calls,1);
 const wrong=closed(f.original);wrong.receipt.authorization_command_id='a7500000-0000-4000-8000-000000000099';
 for(const response of [new Response(' '.repeat(16385),{headers:{'content-type':'application/json','content-encoding':'gzip'}}),Response.json({...closed(f.original),receipt:{...closed(f.original).receipt,request_hash:'e'.repeat(64)}}),Response.json(wrong),new Response(null,{status:302,headers:{location:'https://else.invalid'}})]){let n=0;const client=createFiscalReviewedAuthorizationClient({...ports,fetchImpl:async()=>{n++;return response;}});await assert.rejects(client(path),e=>e.status===502&&!e.recovery_required);assert.equal(n,1);}
});
test('075 lookup404 stays a read error and cannot invent a closure command from error metadata',async()=>{
 for(const withCommand of [false,true]){let calls=0;const client=createFiscalReviewedAuthorizationClient({origin,getToken:()=>token,getSnapshot:state,fetchImpl:async()=>{calls++;return Response.json({error:'AUTHORIZATION_NOT_FOUND',recovery_required:false,...(withCommand?{command_id:closed(f.original).command_id}:{})},{status:404});}});await assert.rejects(client(path),e=>e.status===(withCommand?502:404)&&!e.recovery_required);assert.equal(calls,1);}
});
test('075 real controller checks roles after credential refresh and captures the original signal',async()=>{
 for(const role of ['fiscal','consulta']){let emit,calls=0,me=0;const wait=deferred(),auth={getSession:async()=>({data:{session:{access_token:token,user:{id:actor}}},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};}};
  const controller=access.createAccessController(auth,'https://erp.lookup.invalid',async(url)=>{if(url.endsWith('/v1/me')){me++;if(me===2)return wait.promise;return Response.json(member());}calls++;return Response.json(closed(f.original));},{a1ApiUrl:origin}),stop=controller.start();
  try{await until(()=>controller.getSnapshot().phase==='ready');emit('TOKEN_REFRESHED',{access_token:fresh,user:{id:actor}});await until(()=>me===2);const a=new AbortController(),o={signal:a.signal},pending=controller.fiscalReviewedAuthorization(path,o).then(value=>({value}),error=>({error}));o.signal=new AbortController().signal;wait.resolve(Response.json(member(role)));const out=await pending;if(role==='fiscal'){assert.equal(out.value.read_only,true);assert.equal(calls,1);}else{assert.ok(out.error);assert.equal(calls,0);}}
  finally{wait.resolve(Response.json(member()));stop();}
 }
 const wait=deferred(),a=new AbortController();let calls=0;const client=createFiscalReviewedAuthorizationClient({origin,getToken:()=>wait.promise,getSnapshot:state,fetchImpl:async()=>{calls++;return Response.json(closed(f.original));}}),o={signal:a.signal},pending=client(path,o),failure=assert.rejects(pending,e=>e.name==='AbortError');o.signal=new AbortController().signal;a.abort();await failure;wait.resolve(token);assert.equal(calls,0);
});
test('075 in-flight lookup fences the signed-candidate parent; readback unlocks without an A1 read or mutation',async()=>{
 const s=signedFixture({state:'stored'}),wait=deferred(),calls=[],data=lookupFixture();data.original=original(s.candidate,'request_ready');data.failed={...structuredClone(data.original),status:'failed_before_dispatch',error_code:'PREPARATION_FAILED',recoverable_by_actor:false,current:{...data.original.current,state:'failed_before_dispatch',finished_at:closed(data.original).receipt.closed_at}};s.controller.subscribe=()=>()=>{};s.controller.fiscalAuthorization=async()=>{throw Error('LEGACY_MUST_NOT_DISPATCH');};s.controller.fiscalReviewedAuthorization=async(p,o={})=>{calls.push({path:p,...o});return p.endsWith('/history')?history(s.candidate,[data.failed]):wait.promise;};
 const v=await mountComponent('FiscalSignedCandidate.tsx',{controller:s.controller,job:s.f.job,model:'55'},{expandChildren:['FiscalReviewedAuthorization','FiscalAuthorization','FiscalAuthorizationClosureReceipt']});try{
  await v.click('Consultar histórico da autorização revisada');const old=v.button('Atualizar certificado e assinaturas'),oldCheck=checkbox(v),before=s.calls.length;await v.click('Consultar encerramento da tentativa 2');old.props.onClick();oldCheck.props.onChange({target:{checked:true}});await v.flush();assert.equal(s.calls.length,before);assert.equal(v.guard().busy,true);wait.resolve(closed(data.original));await v.flush();assert.match(v.text(),/Recibo de encerramento consultado/);assert.equal(v.guard().busy,false);assert.equal(s.calls.length,before);assert.ok(calls.every(c=>c.path.endsWith('/history')||c.path.endsWith('/closure')));
 }finally{wait.resolve(closed(data.original));v.unmount();}
});
