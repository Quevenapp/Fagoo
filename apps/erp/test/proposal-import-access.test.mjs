import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {BASE,actor,source,page,preview,ack,current,state} from './helpers/proposal-import-v2-fixtures.mjs';
const uuid='e0000000-0000-4000-8000-000000000001',tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function setup({role='admin',intercept=()=>{},after=()=>{}}={}){
 const calls=[],commands=new Map(),s={role,actor,me:0};let emit;
 const session=(id=actor,token='proposal-synthetic-token-052')=>({access_token:token,user:{id}});
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})};
 const controller=createAccessController(auth,'https://api.synthetic.invalid',async(url,options)=>{
  const path=new URL(url).pathname,call={url,path,...options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);if(path==='/v1/me')s.me++;const custom=await intercept(call,s);if(custom)return custom;
  let value;if(path==='/v1/me')value={...state().membership,user_id:s.actor,role:s.role};else if(path===BASE)value=page();else if(path.endsWith('/preview'))value=preview();else if(path.endsWith('/apply')){value=ack(call.body);commands.set(call.body.command_id,structuredClone(value));}else{const a=commands.get(path.split('/').at(-1));if(!a)return Response.json({}, {status:404});value=current(a);}
  return await after(call,s,value)??Response.json(value);
 });
 const stop=controller.start();for(let i=0;i<50&&controller.getSnapshot().phase!=='ready';i++)await tick();assert.equal(controller.getSnapshot().phase,'ready');return{controller,calls,commands,s,stop,emit:(id,token)=>{s.actor=id;emit('SIGNED_IN',session(id,token));}};
}
const review=async v=>{await v.click('Conferir prévia 9520000001');await v.change('proposal-import-duplicates',true);await v.change('proposal-import-confirm',true);};
const mount=s=>mountComponent('RealImportProposals.tsx',{controller:s.controller},{expandChildren:['NativeListLayout'],ports:{AccessError}});
test('versioned proposal import controller is admin-only with exact GET/POST paths and query limits',async()=>{
 const s=await setup();try{await s.controller.proposalImport(BASE+'?limit=25&q=QA%2F001');await s.controller.proposalImport(BASE+'/preview',{method:'POST',body:{source_id:source().source_id}});const before=s.calls.length;
  for(const [path,options]of [[BASE+'/preview',{}],[BASE+'/apply',{method:'GET'}],[BASE+'/apply?x=1',{method:'POST',body:{}}],[BASE+'/commands/'+uuid,{method:'POST',body:{}}],[BASE+'/commands/'+uuid+'?q=x',{}],[BASE+'/documents/'+uuid+'/origin',{}],[BASE+'/origins/01',{}],[BASE+'?limit=26',{}],[BASE+'?limit=1&limit=2',{}],[BASE+'?q=%00',{}],[BASE+'?after=%2F',{}],[BASE+'?status=draft',{}],['https://evil.invalid'+BASE,{}]])await assert.rejects(()=>s.controller.proposalImport(path,options),e=>e.status===400);
  assert.equal(s.calls.length,before);for(const call of s.calls.slice(1)){assert.equal(call.credentials,'omit');assert.match(call.headers.Authorization,/^Bearer proposal-synthetic/);}
 }finally{s.stop();}
 for(const role of ['consulta','financeiro','vendas','estoque','fiscal']){const denied=await setup({role});try{await assert.rejects(()=>denied.controller.proposalImport(BASE),e=>e.status===403);assert.equal(denied.calls.length,1);}finally{denied.stop();}}
});
test('versioned proposal import real controller lost commit plus failed GET never resends; second GET resolves current',async()=>{
 let lost=true,readFail=true;const s=await setup({after(call){if(call.path.endsWith('/apply')&&lost){lost=false;throw new TypeError('synthetic response lost');}if(call.path.includes('/commands/')&&readFail){readFail=false;return Response.json({}, {status:503});}}}),v=await mount(s);
 try{await review(v);await v.click('Criar rascunho revisado');await v.click('Consultar resultado');assert.equal(v.guard().busy,true);assert.equal(v.button('Voltar à lista').disabled,true);await v.click('Consultar resultado');assert.equal(v.guard().busy,false);assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,1);assert.equal(s.calls.filter(c=>c.path.includes('/commands/')).length,2);assert.equal(s.commands.size,1);}finally{v.unmount();s.stop();}
});
test('versioned proposal import 401 during recovery removes session authority and stale handlers cannot POST',async()=>{
 let lost=true;const s=await setup({after(call){if(call.path.endsWith('/apply')&&lost){lost=false;throw new TypeError('synthetic response lost');}if(call.path.includes('/commands/'))return Response.json({}, {status:401});}}),v=await mount(s);
 try{await review(v);const stale=v.button('Criar rascunho revisado');await v.click('Criar rascunho revisado');await v.click('Consultar resultado');assert.equal(s.controller.getSnapshot().phase,'signed_out');await v.updateProps({controller:s.controller});assert.match(v.text(),/Somente administradores/);stale.props.onClick();await v.flush();assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,1);}finally{v.unmount();s.stop();}
});
test('versioned proposal import 403 during recovery preserves pending command while role is revalidated',async()=>{
 const gate=deferred();let lost=true,forbid=true;const s=await setup({intercept(call,x){if(call.path==='/v1/me'&&x.me===2)return gate.promise;},after(call){if(call.path.endsWith('/apply')&&lost){lost=false;throw new TypeError('synthetic response lost');}if(call.path.includes('/commands/')&&forbid){forbid=false;return Response.json({}, {status:403});}}}),v=await mount(s);
 try{await review(v);await v.click('Criar rascunho revisado');const command=[...s.commands.keys()][0];await v.click('Consultar resultado');assert.equal(v.guard().busy,true);assert.equal(s.s.me,2);gate.resolve(Response.json(state().membership));await v.flush();await v.click('Consultar resultado');assert.equal(v.guard().busy,false);assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,1);assert.ok(s.calls.filter(c=>c.path.includes('/commands/')).every(c=>c.path.endsWith(command)));}finally{gate.resolve(Response.json({}));v.unmount();s.stop();}
});
test('versioned proposal import new actor cancels prior in-flight preview and no late result is adopted',async()=>{
 const gate=deferred();let sent;const s=await setup({after(call){if(call.path.endsWith('/preview')){sent=call;return gate.promise;}}}),v=await mount(s);
 try{await v.click('Conferir prévia 9520000001');s.emit(actor.replace(/1$/,'2'),'synthetic-new-actor-token');await tick();assert.equal(sent.signal.aborted,true);await v.updateProps({controller:s.controller});gate.resolve(Response.json(preview()));await v.flush();assert.match(v.text(),/Somente administradores/);assert.doesNotMatch(v.text(),/Produto sintético/);assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,0);}finally{gate.resolve(Response.json(preview()));v.unmount();s.stop();}
});
test('versioned proposal import rejects an oversized response and honors caller abort without retry',async()=>{
 const s=await setup({intercept(call){if(call.path===BASE)return new Response('x'.repeat(1024*1024+1));}});try{await assert.rejects(()=>s.controller.proposalImport(BASE),e=>e.status===502);const abort=new AbortController();abort.abort();await assert.rejects(()=>s.controller.proposalImport(BASE,{signal:abort.signal}),e=>e.name==='AbortError');assert.equal(s.calls.filter(c=>c.path===BASE).length,1);}finally{s.stop();}
});
