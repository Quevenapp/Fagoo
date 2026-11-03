import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {signedFixture,confirm} from './helpers/fiscal-signed-ui-fixture.mjs';
import {envelope} from './helpers/a1-fixtures.mjs';
const tick=()=>new Promise(r=>setImmediate(r)),copy=structuredClone;
const actor='a0000000-0000-4000-8000-000000000099',token='synthetic-session-token-123456789',nextToken='synthetic-refreshed-token-123456789';
const session=(access_token=token,user=actor)=>({access_token,user:{id:user}}),member=(role='fiscal',user=actor)=>({user_id:user,role,resources:['nfe','nfce'],data_mode:'staging_readonly'});
const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate());};
function setup({before=()=>{},after=()=>{},configured=true}={}){
 const s=signedFixture(),calls=[],phases=[];let callback=()=>{},me=0;
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){callback=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{callback('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=createAccessController(auth,'https://erp.synthetic.invalid',async(url,options)=>{
  const c={url,options,body:options.body?JSON.parse(options.body):undefined};calls.push(c);const custom=await before(c,{s,me:()=>me});if(custom)return custom;
  let value;if(url.endsWith('/v1/me')){me++;value=member(s.role);}else if(url.endsWith('/v1/a1'))value=envelope(s.a1);else value=await s.controller.fiscalSigned(new URL(url).pathname,{method:options.method,body:c.body,signal:options.signal});
  const altered=await after(c,{s,me:()=>me,value});return altered??Response.json(value);
 },configured?{a1ApiUrl:'https://fiscal.synthetic.invalid'}:{});
 const stop=controller.start(),unsubscribe=controller.subscribe(()=>phases.push(controller.getSnapshot().phase));
 return{s,controller,calls,phases,emit:(event,value)=>callback(event,value),close(){unsubscribe();stop();}};
}
const mount=f=>mountComponent('FiscalSignedCandidate.tsx',{controller:f.controller,job:copy(f.s.f.job),model:'55'},{ports:{AccessError}});
test('050 real controller preserves the pending UI after a dispatched403 and background membership revalidation',async()=>{
 let denied=false;const f=setup({after(c){if(c.url.endsWith('/run')&&!denied){denied=true;return Response.json({error:'SIGNED_FORBIDDEN',recovery_required:true},{status:403});}}});
 try{await wait(()=>f.controller.getSnapshot().phase==='ready');f.phases.length=0;const v=await mount(f);try{
  await confirm(v);await v.click('Assinar XML de homologação');await wait(()=>f.calls.filter(c=>c.url.endsWith('/v1/me')).length===2);await v.flush();assert.equal(v.guard().busy,true);assert.ok(f.phases.every(p=>p==='ready'));assert.equal(f.controller.getSnapshot().membership.role,'admin');
  await v.click('Conferir resultado da assinatura');assert.equal(v.guard().busy,false);assert.equal(f.s.counts.run,1);assert.equal(f.s.commands.size,1);assert.equal(f.calls.filter(c=>c.url.endsWith('/run')).length,1);
 }finally{v.unmount();}}finally{f.close();}
});
test('050 same-actor token refresh waits for its own membership check without replaying a signing request in flight',async()=>{
 let releaseRun,releaseMe,held=false;const runGate=new Promise(r=>releaseRun=r),meGate=new Promise(r=>releaseMe=r);
 const f=setup({before(c){if(c.url.endsWith('/v1/me')&&c.options.headers.Authorization===`Bearer ${nextToken}`)return meGate;},after(c){if(c.url.endsWith('/run')&&!held){held=true;return runGate;}}});
 try{await wait(()=>f.controller.getSnapshot().phase==='ready');const v=await mount(f);try{
  await confirm(v);v.button('Assinar XML de homologação').props.onClick();await wait(()=>f.s.commands.size===1);f.emit('TOKEN_REFRESHED',session(nextToken));await tick();
  const sent=f.calls.find(c=>c.url.endsWith('/run')),command=sent.body.command_id;assert.equal(sent.options.signal.aborted,false);releaseRun(Response.json({...copy(f.s.candidate),command_id:command}));await v.flush();assert.equal(v.guard().busy,true);assert.equal(f.calls.some(c=>c.url.includes('/commands/')),false);
  releaseMe(Response.json(member('admin')));await v.flush();assert.equal(v.guard().busy,false);assert.equal(f.calls.filter(c=>c.url.endsWith('/run')).length,1);assert.equal(f.calls.find(c=>c.url.includes('/commands/')).options.headers.Authorization,`Bearer ${nextToken}`);assert.equal(f.controller.getSnapshot().phase,'ready');
 }finally{v.unmount();}}finally{releaseRun?.(Response.json({}));releaseMe?.(Response.json(member('admin')));f.close();}
});
test('050 confirmed membership revocation logs out and never reads back the former actor command',async()=>{
 let forbidden=false;const f=setup({before(c){if(c.url.endsWith('/v1/me')&&forbidden)return Response.json({error:'forbidden'},{status:403});},after(c){if(c.url.endsWith('/run')){forbidden=true;return Response.json({error:'SIGNED_FORBIDDEN',recovery_required:true},{status:403});}}});
 try{await wait(()=>f.controller.getSnapshot().phase==='ready');const v=await mount(f);try{await confirm(v);await v.click('Assinar XML de homologação');await wait(()=>f.controller.getSnapshot().phase!=='ready');await v.updateProps({});assert.equal(v.button('Conferir resultado da assinatura').disabled,true);assert.equal(f.calls.some(c=>c.url.includes('/commands/')),false);assert.equal(f.s.counts.run,1);}finally{v.unmount();}}finally{f.close();}
});
test('050 signed port rejects unauthorized roles, paths and absent origin before gateway requests',async()=>{
 for(const role of['consulta','vendas','financeiro']){const f=setup();f.s.role=role;try{await wait(()=>f.controller.getSnapshot().phase==='ready');await assert.rejects(f.controller.fiscalSigned('/v1/fiscal-signed/candidates/a0000000-0000-4000-8000-000000000700'),e=>e.status===403);assert.equal(f.calls.filter(c=>c.url.startsWith('https://fiscal.')).length,0);}finally{f.close();}}
 const f=setup({configured:false});try{await wait(()=>f.controller.getSnapshot().phase==='ready');await assert.rejects(f.controller.fiscalSigned('/v1/fiscal-signed/run',{method:'POST',body:{}}),e=>[400,503].includes(e.status));assert.equal(f.calls.length,1);}finally{f.close();}
});
test('050 controller captures body and signal before import and releases the original listener after caller mutation',async()=>{
 const f=setup();try{await wait(()=>f.controller.getSnapshot().phase==='ready');const original=new AbortController(),replacement=new AbortController(),counts={add:0,remove:0};
  const add=original.signal.addEventListener.bind(original.signal),remove=original.signal.removeEventListener.bind(original.signal);
  original.signal.addEventListener=(...args)=>{counts.add++;return add(...args);};original.signal.removeEventListener=(...args)=>{counts.remove++;return remove(...args);};
  const body={command_id:'a0000000-0000-4000-8000-000000000701',unsigned_job_id:f.s.f.job.job_id,unsigned_hash:f.s.f.job.artifact.sha256,basis_hash:f.s.f.job.basis_hash,expected_a1_version:1},expected=copy(body),options={method:'POST',body,signal:original.signal};
  const running=f.controller.fiscalSigned('/v1/fiscal-signed/run',options);body.expected_a1_version=77;body.unsigned_hash='f'.repeat(64);options.body={};options.signal=replacement.signal;
  const result=await running;assert.equal(result.a1_version,1);assert.deepEqual(f.calls.find(c=>c.url.endsWith('/run')).body,expected);assert.deepEqual(counts,{add:1,remove:1});
 }finally{f.close();}
});
test('050 controller rejects getters without evaluating them and aborts the captured signal before any gateway dispatch',async()=>{
 const f=setup();try{await wait(()=>f.controller.getSnapshot().phase==='ready');let touched=0;
  const bad=Object.defineProperty({method:'POST'},'body',{enumerable:true,get(){touched++;return{};}});await assert.rejects(f.controller.fiscalSigned('/v1/fiscal-signed/run',bad),e=>e.status===400);assert.equal(touched,0);
  const original=new AbortController(),options={method:'POST',body:{command_id:'a0000000-0000-4000-8000-000000000702',unsigned_job_id:f.s.f.job.job_id,unsigned_hash:f.s.f.job.artifact.sha256,basis_hash:f.s.f.job.basis_hash,expected_a1_version:1},signal:original.signal};
  const running=f.controller.fiscalSigned('/v1/fiscal-signed/run',options),rejected=assert.rejects(running,e=>e.name==='AbortError');options.signal=new AbortController().signal;original.abort();await rejected;
  assert.equal(f.calls.filter(c=>c.url.startsWith('https://fiscal.')).length,0);
 }finally{f.close();}
});
