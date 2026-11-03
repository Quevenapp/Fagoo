import test from 'node:test';
import assert from 'node:assert/strict';
import {actor,otherActor,doc,event,tick,deferred,setup,mountAccess,fill,status} from './helpers/access-session-fixtures.mjs';

const me=(user=actor,role='admin')=>Response.json({user_id:user,role,resources:['contacts','products'],data_mode:'staging_readonly'});
const refresh=(s,token='synthetic-renewed-token')=>s.emit(actor,token,'TOKEN_REFRESHED');

test('same-actor refresh preserves the mounted event draft and freezes new dispatch until its own /me completes',async()=>{
 const gate=deferred(),s=setup({meResponse:n=>n===2?gate.promise:undefined,writeStatuses:[200]}),v=await mountAccess(s);
 try{
  await fill(v);refresh(s);await v.flush();
  assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(v.input('service-event-declarant_name').props.value,'Pessoa sintética');
  await v.submit();assert.equal(s.writes.length,0);assert.equal(s.me,2);assert.equal(v.guard().busy,true);
  gate.resolve(me());await v.flush();assert.equal(s.writes.length,1);assert.equal(s.records.length,1);assert.match(v.text(),/Registro 1 confirmado/);
  assert.equal(s.requests.find(r=>r.method==='POST').headers.Authorization,'Bearer synthetic-renewed-token');
 }finally{gate.resolve(me());v.unmount();}
});

test('an old-credential POST already dispatched may finish after refresh and its readback waits for the new credential',async()=>{
 const posted=deferred(),checked=deferred();let signal;
 const s=setup({writeStatuses:[200],meResponse:n=>n===2?checked.promise:undefined,dataResponse(p,_,o){if(o.method==='POST'&&p.endsWith('/eventos')){signal=o.signal;return posted.promise;}}}),v=await mountAccess(s);
 try{
  await fill(v);await v.submit();assert.ok(signal);refresh(s);await v.flush();assert.equal(signal.aborted,false);
  const reads=s.reads.length;posted.resolve(undefined);await tick();assert.equal(s.writes.length,1);assert.equal(s.reads.length,reads);assert.equal(v.guard().busy,true);
  checked.resolve(me());await v.flush();assert.match(v.text(),/Registro 1 confirmado/);assert.equal(s.writes.length,1);assert.equal(s.records.length,1);
  const events=s.requests.filter(r=>r.url.includes('/eventos'));assert.equal(events.find(r=>r.method==='POST').headers.Authorization,'Bearer synthetic-token');assert.equal(events.at(-1).headers.Authorization,'Bearer synthetic-renewed-token');
 }finally{posted.resolve(undefined);checked.resolve(me());v.unmount();}
});

test('a lost event ACK survives refresh and an unavailable membership check; retry keeps the exact command and payload',async()=>{
 const s=setup({meResponse:n=>n===2||n===3?Response.json({}, {status:503}):undefined,writeStatuses:[503,200]}),v=await mountAccess(s);
 try{
  await fill(v);await v.submit();const original=structuredClone(s.writes[0]);refresh(s);await v.flush();assert.equal(v.guard().busy,true);assert.match(v.text(),/Não foi possível reconfirmar seu acesso/);
  await v.click('Repetir a mesma confirmação');assert.equal(s.writes.length,1);assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(v.input('service-event-declarant_name').props.value,'Pessoa sintética');
  await v.click('Verificar permissões');assert.equal(s.controller.getSnapshot().permissionMessage,null);
  await v.click('Repetir a mesma confirmação');assert.equal(s.writes.length,2);assert.deepEqual(s.writes[1],original);assert.equal(s.records.length,1);assert.match(v.text(),/Registro 1 confirmado/);
 }finally{v.unmount();}
});

test('two successive refreshes cannot authorize the latest token using a late /me from an older credential',async()=>{
 const first=deferred(),second=deferred();let dispatched=0;
 const s=setup({meResponse:n=>n===2?first.promise:n===3?second.promise:undefined,dataResponse(){dispatched++;return Response.json({ok:true});}}),stop=s.controller.start();await tick();
 try{
  refresh(s,'synthetic-token-2');const stale=s.requests.at(-1);refresh(s,'synthetic-token-3');assert.equal(stale.signal.aborted,true);
  const request=s.controller.documents('/v1/documentos/check');await tick();first.resolve(me());await tick();assert.equal(dispatched,0);assert.equal(s.me,3);assert.equal(s.controller.getSnapshot().phase,'ready');
  second.resolve(me());assert.deepEqual(await request,{ok:true});assert.equal(dispatched,1);assert.equal(s.requests.at(-1).headers.Authorization,'Bearer synthetic-token-3');
 }finally{first.resolve(me());second.resolve(me());stop();}
});

test('an old credential 401 cannot log out the renewed same-actor session or erase its pending command',async()=>{
 const reply=deferred();let calls=0;
 const s=setup({writeStatuses:[200],dataResponse(p,_,o){if(o.method==='POST'&&p.endsWith('/eventos')&&++calls===1)return reply.promise;}}),v=await mountAccess(s);
 try{
  await fill(v);await v.submit();refresh(s);await v.flush();reply.resolve(Response.json({}, {status:401}));await v.flush();
  assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(v.guard().busy,true);assert.equal(v.input('service-event-declarant_name').props.value,'Pessoa sintética');
  await v.click('Repetir a mesma confirmação');const bodies=s.requests.filter(r=>r.method==='POST').map(r=>JSON.parse(r.body));assert.deepEqual(bodies[0],bodies[1]);assert.equal(s.records.length,1);assert.match(v.text(),/Registro 1 confirmado/);
 }finally{reply.resolve(Response.json({}, {status:401}));v.unmount();}
});

for(const code of [401,403])test(`confirmed renewed-credential /me${code} clears the private module and frozen attempt`,async()=>{
 const gate=deferred(),s=setup({meResponse:n=>n===2?gate.promise:undefined}),v=await mountAccess(s);
 try{await fill(v);await v.submit();refresh(s);await v.flush();assert.equal(v.guard().busy,true);gate.resolve(Response.json({}, {status:code}));await v.flush();assert.equal(s.controller.getSnapshot().phase,code===401?'signed_out':'pending');assert.equal(s.controller.getSnapshot().membership,null);assert.equal(v.nodes().some(n=>n.props.id==='service-event-declarant_name'),false);assert.equal(s.writes.length,1);}
 finally{gate.resolve(me());v.unmount();}
});

for(const replacement of ['logout','other_actor'])test(`${replacement} during token verification aborts queued calls and cannot restore prior actor state`,async()=>{
 const gate=deferred();let dispatches=0;const s=setup({meResponse:n=>n===2?gate.promise:undefined,dataResponse(){dispatches++;return Response.json({private:true});}}),stop=s.controller.start();await tick();
 try{refresh(s);const check=s.requests.at(-1),request=s.controller.documents('/v1/documentos/check');const rejected=assert.rejects(request,e=>e.name==='AbortError');if(replacement==='logout')await s.controller.logout();else s.emit(otherActor,'synthetic-other-user');await tick();assert.equal(check.signal.aborted,true);gate.resolve(me());await rejected;await tick();assert.equal(dispatches,0);assert.equal(s.controller.getSnapshot().membership?.user_id??null,replacement==='logout'?null:otherActor);}
 finally{gate.resolve(me());stop();}
});

test('native, A1, unsigned, binary upload and download all wait on the same renewed-credential verification',async()=>{
 const gate=deferred();const s=setup({meResponse:n=>n===2?gate.promise:undefined,dataResponse(){return Response.json({ok:true});}}),stop=s.controller.start();await tick();
 try{
  refresh(s);const count=s.requests.length;
  const calls=[s.controller.catalog('/v1/cadastros'),s.controller.a1('/v1/a1'),s.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{draft_id:doc,completion_version:1}}),s.controller.attachments(`/v1/documentos/service_orders/${doc}/anexos/${event}/upload`,{method:'PUT',body:new Blob(['synthetic']),contentType:'text/plain'}),s.controller.history('/v1/history/backups')];
  await tick();assert.equal(s.requests.length,count);assert.equal(s.me,2);gate.resolve(me());assert.deepEqual(await Promise.all(calls),Array(5).fill({ok:true}));
  assert.ok(s.requests.slice(count).every(r=>r.headers.Authorization==='Bearer synthetic-renewed-token'));
 }finally{gate.resolve(me());stop();}
});

test('current credential401 and a mismatched /me actor remain fail-closed',async()=>{
 for(const mismatch of [false,true]){
  const s=setup({meResponse:n=>mismatch&&n===2?me(otherActor):undefined,dataResponse(){return Response.json({}, {status:401});}}),stop=s.controller.start();await tick();
  try{refresh(s);await tick();if(!mismatch)await assert.rejects(()=>s.controller.documents('/v1/documentos/check'),status(401));assert.equal(s.controller.getSnapshot().phase,'signed_out');assert.equal(s.controller.getSnapshot().membership,null);}finally{stop();}
 }
});

test('logout at verification completion prevents a queued request from being dispatched',async()=>{
 const gate=deferred();let dispatches=0;const s=setup({meResponse:n=>n===2?gate.promise:undefined,dataResponse(){dispatches++;return Response.json({ok:true});}}),stop=s.controller.start();await tick();let logout;
 const unsubscribe=s.controller.subscribe(()=>{if(s.me===2&&s.controller.getSnapshot().phase==='ready'&&s.controller.getSnapshot().permissionMessage===null&&!logout)logout=s.controller.logout();});
 try{refresh(s);const request=s.controller.documents('/v1/documentos/check');const rejected=assert.rejects(request,e=>e.name==='AbortError');gate.resolve(me());await rejected;await logout;assert.equal(dispatches,0);assert.equal(s.controller.getSnapshot().phase,'signed_out');}finally{gate.resolve(me());unsubscribe();stop();}
});
