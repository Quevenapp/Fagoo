import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController} from '../src/lib/real-access.ts';
import {captureProposalImportRequest} from '../src/lib/proposal-import-request.ts';
const V1='/v1/importacao-orcamentos-origin',V2=V1+'-v2',actor='a0000000-0000-4000-8000-000000000001',command='b0000000-0000-4000-8000-000000000001';
const body=()=>({source_id:'9550000001',preview_hash:'a'.repeat(64),command_id:command,confirm_import:true,duplicate_reviewed:true});
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function setup(intercept=()=>undefined){
 const calls=[],membership={user_id:actor,role:'admin',resources:['contacts','products'],data_mode:'staging_readonly'};let emit,me=0;
 const session=token=>({access_token:token,user:{id:actor}}),auth={getSession:async()=>({data:{session:session('old-token')},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})};
 const controller=createAccessController(auth,'https://api.synthetic.invalid',async(url,options)=>{const path=new URL(url).pathname,call={path,...options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);if(path==='/v1/me')me++;return await intercept(call,me)??Response.json(path==='/v1/me'?membership:{synthetic:true});});
 const stop=controller.start();for(let i=0;i<50&&controller.getSnapshot().phase!=='ready';i++)await tick();assert.equal(controller.getSnapshot().phase,'ready');return{controller,calls,stop,membership,refresh:()=>emit('TOKEN_REFRESHED',session('new-token'))};
}
test('055 controller keeps selected v1/v2 policy exact across lists, writes and recovery reads',async()=>{
 const s=await setup();try{for(const base of [V1,V2]){await s.controller.proposalImport(base+'?limit=25&q=QA');await s.controller.proposalImport(base+'/preview',{method:'POST',body:{source_id:'9550000001'}});await s.controller.proposalImport(base+'/apply',{method:'POST',body:body()});await s.controller.proposalImport(base+'/commands/'+command);await s.controller.proposalImport(base+'/origins/9550000001');}
 assert.deepEqual(s.calls.slice(1).map(c=>c.path),[V1,V2].flatMap(base=>[base,base+'/preview',base+'/apply',base+'/commands/'+command,base+'/origins/9550000001']));
 await s.controller.proposalImport(V1+'/documents/'+command+'/origin');assert.equal(s.calls.at(-1).path,V1+'/documents/'+command+'/origin');
 const count=s.calls.length;for(const path of [V2+'-other',V2+'/documents/'+command+'/origin',V2+'/commands/'+command+'?v=1',V2+'?limit=26',V2+'?after=01',V2+'?q=x&q=y',V2+'?q=%00','https://evil.invalid'+V2])await assert.rejects(()=>s.controller.proposalImport(path),e=>e.status===400);assert.equal(s.calls.length,count);
 for(const call of s.calls.slice(1)){assert.equal(call.credentials,'omit');assert.equal(call.redirect,'error');assert.match(call.headers.Authorization,/Bearer /);}
 }finally{s.stop();}
});
test('055 captures body, policy and original signal before refreshed-token reauthorization awaits',async()=>{
 const gate=deferred(),s=await setup((call,me)=>call.path==='/v1/me'&&me===2?gate.promise:undefined);try{
 s.refresh();await tick();const original=new AbortController(),replacement=new AbortController(),input=body(),options={method:'POST',body:input,signal:original.signal};const expected=structuredClone(input),pending=s.controller.proposalImport(V2+'/apply',options);
 input.source_id='9550000099';input.preview_hash='b'.repeat(64);input.command_id=actor;options.body=body();options.signal=replacement.signal;
 gate.resolve(Response.json(s.membership));await pending;const sent=s.calls.find(c=>c.path===V2+'/apply');assert.deepEqual(sent.body,expected);assert.equal(sent.headers.Authorization,'Bearer new-token');assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,1);
 }finally{gate.resolve(Response.json(s.membership));s.stop();}
});
test('055 caller abort still uses original captured signal and no retry is dispatched',async()=>{
 const gate=deferred(),s=await setup((call,me)=>call.path==='/v1/me'&&me===2?gate.promise:undefined);try{s.refresh();await tick();const original=new AbortController(),options={method:'POST',body:body(),signal:original.signal},pending=s.controller.proposalImport(V2+'/apply',options);const rejected=assert.rejects(pending,e=>e.name==='AbortError');options.signal=new AbortController().signal;original.abort();gate.resolve(Response.json(s.membership));await rejected;assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,0);}finally{gate.resolve(Response.json(s.membership));s.stop();}
});
test('055 request boundary refuses accessors or unsupported bodies without invoking caller code',async()=>{
 const s=await setup();try{let invoked=0;const values=[{method:'POST',get body(){invoked++;return body();}},{method:'POST',body:Object.defineProperty(body(),'source_id',{get(){invoked++;return'9550000001';}})},{method:'POST',body:{...body(),p_user_id:actor}},{method:'POST',body:{...body(),confirm_import:false}},{method:'POST',body:{...body(),source_id:9550000001}},{method:'POST',body:Object.assign(Object.create({unexpected:true}),body())}];const count=s.calls.length;for(const options of values)await assert.rejects(()=>s.controller.proposalImport(V2+'/apply',options),e=>e.status===400);assert.equal(invoked,0);assert.equal(s.calls.length,count);
 const captured=captureProposalImportRequest(V1+'/apply',{method:'POST',body:body()});assert.ok(Object.isFrozen(captured.options.body));assert.equal(captured.base,V1);
 }finally{s.stop();}
});
test('055 403 starts membership revalidation but retains caller command and does not rewrite/retry it',async()=>{
 let failed=false;const s=await setup(call=>{if(call.path.endsWith('/apply')&&!failed){failed=true;return Response.json({}, {status:403});}});try{const input=body();await assert.rejects(()=>s.controller.proposalImport(V2+'/apply',{method:'POST',body:input}),e=>e.status===403);for(let i=0;i<10&&s.calls.filter(c=>c.path==='/v1/me').length<2;i++)await tick();assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(s.calls.filter(c=>c.path.endsWith('/apply')).length,1);await s.controller.proposalImport(V2+'/commands/'+command);assert.equal(s.calls.at(-1).path,V2+'/commands/'+command);assert.deepEqual(input,body());}finally{s.stop();}
});
