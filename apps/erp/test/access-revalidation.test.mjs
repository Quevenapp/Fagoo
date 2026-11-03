import test from 'node:test';
import assert from 'node:assert/strict';
import {actor,otherActor,doc,event,tick,deferred,setup,mountAccess,fill,status} from './helpers/access-session-fixtures.mjs';

test('real controller + RealAccess + event preserve the same command through503→403→background /me200 and replay',async()=>{
 const gate=deferred(),s=setup({meResponse:n=>n===2?gate.promise:undefined}),v=await mountAccess(s);
 try{await fill(v);await v.submit();assert.equal(v.guard().busy,true);await v.click('Repetir a mesma confirmação');assert.equal(s.me,2);assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(v.input('service-event-declarant_name').props.value,'Pessoa sintética');assert.equal(v.guard().busy,true);assert.match(v.text(),/Conferindo suas permissões/);assert.doesNotMatch(v.text(),/Verificando permissões…/);
  gate.resolve(Response.json({user_id:actor,role:'vendas',resources:['contacts','products'],data_mode:'staging_readonly'}));s.role='vendas';await v.flush();assert.equal(v.input('service-event-declarant_name').props.value,'Pessoa sintética');assert.equal(v.guard().busy,true);await v.click('Repetir a mesma confirmação');assert.equal(s.writes.length,3);assert.deepEqual(s.writes[0],s.writes[1]);assert.deepEqual(s.writes[0],s.writes[2]);assert.equal(s.records.length,1);assert.match(v.text(),/Registro 1 confirmado/);assert.equal(v.guard().busy,false);
 }finally{gate.resolve(Response.json({}));v.unmount();}
});
test('background membership failure preserves the event, shows no revocation claim and can be retried without remount',async()=>{
 const s=setup({meResponse:n=>n===2?Promise.reject(new Error('synthetic network')):undefined}),v=await mountAccess(s);try{
  await fill(v);await v.submit();await v.click('Repetir a mesma confirmação');assert.equal(s.controller.getSnapshot().phase,'ready');assert.match(v.text(),/Não foi possível reconfirmar seu acesso/);assert.equal(v.input('service-event-declarant_name').props.value,'Pessoa sintética');assert.equal(v.guard().busy,true);await v.click('Verificar permissões');assert.equal(s.me,3);assert.equal(s.controller.getSnapshot().permissionMessage,null);assert.equal(v.guard().busy,true);await v.click('Repetir a mesma confirmação');assert.equal(s.records.length,1);assert.deepEqual(s.writes[0],s.writes.at(-1));
 }finally{v.unmount();}
});
for(const code of[401,403])test(`confirmed /me${code} removes private module and cannot restore its attempt`,async()=>{
 const gate=deferred(),s=setup({meResponse:n=>n===2?gate.promise:undefined}),v=await mountAccess(s);try{await fill(v);await v.submit();await v.click('Repetir a mesma confirmação');gate.resolve(Response.json({}, {status:code}));await v.flush();assert.equal(s.controller.getSnapshot().phase,code===401?'signed_out':'pending');assert.equal(s.controller.getSnapshot().membership,null);assert.equal(v.nodes().some(n=>n.props.id==='service-event-declarant_name'),false);assert.equal(s.writes.length,2);}finally{gate.resolve(Response.json({}));v.unmount();}
});
test('a late /me for the prior actor cannot affect a replacement session or restore its draft',async()=>{
 const gate=deferred(),s=setup({meResponse:n=>n===2?gate.promise:undefined}),v=await mountAccess(s);try{await fill(v);await v.submit();await v.click('Repetir a mesma confirmação');const request=s.requests.filter(c=>c.url.endsWith('/me'))[1];s.emit(otherActor);await v.flush();assert.equal(request.signal.aborted,true);gate.resolve(Response.json({user_id:actor,role:'admin',resources:['products'],data_mode:'staging_readonly'}));await v.flush();assert.equal(s.controller.getSnapshot().membership.user_id,otherActor);assert.equal(v.input('service-event-declarant_name').props.value,'');assert.equal(v.guard().busy,false);assert.equal(s.writes.length,2);}finally{gate.resolve(Response.json({}));v.unmount();}
});
test('logout during background revalidation aborts it and ignores late success',async()=>{
 const gate=deferred(),s=setup({meResponse:n=>n===2?gate.promise:undefined}),v=await mountAccess(s);try{await fill(v);await v.submit();await v.click('Repetir a mesma confirmação');const request=s.requests.filter(c=>c.url.endsWith('/me'))[1];await s.controller.logout();await v.flush();assert.equal(request.signal.aborted,true);gate.resolve(Response.json({user_id:actor,role:'admin',resources:['products'],data_mode:'staging_readonly'}));await v.flush();assert.equal(s.controller.getSnapshot().phase,'signed_out');assert.equal(s.controller.getSnapshot().membership,null);assert.equal(v.nodes().some(n=>n.props.id==='service-event-declarant_name'),false);}finally{gate.resolve(Response.json({}));v.unmount();}
});
test('unexpected identity from /me fails closed instead of adopting a different authenticated actor',async()=>{
 const s=setup({meResponse:n=>n===2?Response.json({user_id:otherActor,role:'admin',resources:['products'],data_mode:'staging_readonly'}):undefined}),stop=s.controller.start();await tick();try{await assert.rejects(()=>s.controller.catalog('/v1/cadastros'),status(403));await tick();assert.equal(s.controller.getSnapshot().phase,'signed_out');assert.equal(s.controller.getSnapshot().membership,null);}finally{stop();}
});
test('native, A1, unsigned, attachments and downloads share only one in-flight permission recheck and do not abort an unrelated request',async()=>{
 const gate=deferred(),other=deferred();let otherSignal;const s=setup({meResponse:n=>n===2?gate.promise:undefined,dataResponse(p,_,o){if(p==='/v1/documentos/retido'){otherSignal=o.signal;return other.promise;}return Response.json({}, {status:403});}}),stop=s.controller.start();await tick();
 try{
  const read=s.controller.documents('/v1/documentos/retido');await tick();
  const operations=[()=>s.controller.catalog('/v1/cadastros'),()=>s.controller.a1('/v1/a1'),()=>s.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{draft_id:doc,completion_version:1}}),()=>s.controller.attachments(`/v1/documentos/service_orders/${doc}/anexos/${event}/upload`,{method:'PUT',body:new Blob(['synthetic']),contentType:'text/plain'}),()=>s.controller.history('/v1/history/backups')];
  await Promise.all(operations.map(op=>assert.rejects(op,status(403))));s.controller.retry();s.controller.retry();assert.equal(s.me,2);assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(s.controller.getSnapshot().membership.user_id,actor);assert.equal(otherSignal.aborted,false);other.resolve(Response.json({synthetic:true}));assert.deepEqual(await read,{synthetic:true});
  gate.resolve(Response.json({user_id:actor,role:'admin',resources:['products'],data_mode:'staging_readonly'}));await tick();assert.equal(s.controller.getSnapshot().permissionMessage,null);
 }finally{gate.resolve(Response.json({}));other.resolve(Response.json({}));stop();}
});
