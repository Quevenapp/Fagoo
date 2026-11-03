import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {closureFixture,closed,input,original,candidate,B} from './helpers/fiscal-closure-fixtures.mjs';
import {deferred,history,result} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {expiredClosureEligible,closureIntent,bindClosureResult} from '../src/lib/fiscal-authorization-closure-model.ts';
import {captureReviewedAuthorizationRequest as capture,reviewedAuthorizationResponse as project} from '../src/lib/fiscal-reviewed-authorization-model.ts';
const inspect='Conferir encerramento da tentativa 2',confirm='Confirmar encerramento sem envio',get='Consultar resultado do encerramento',cancel='Cancelar encerramento';
const mount=(s,props={})=>mountComponent('FiscalReviewedAuthorization.tsx',{controller:s.controller,candidate:s.candidate,...props},{expandChildren:['FiscalAuthorizationClosure']});
const open=async v=>{await v.click('Consultar histórico da autorização revisada');await v.click(inspect);};
test('closure model captures the five-field body and binds historical receipt/candidate without request hash',()=>{
 for(const model of ['55','65'])for(const state of ['prepared','request_ready']){
  const c=candidate(model),r=original(c,state),b=input(r),body=closureIntent(r,c,b.command_id,true);assert.deepEqual(body,b);assert.ok(Object.isFrozen(body));assert.equal(expiredClosureEligible(r),true);
  const request=capture(B+'/close-expired',{method:'POST',body}),ack=closed(r,body,false),v=project(ack,request);bindClosureResult(v,body,c);assert.equal(request.mutation,true);assert.ok(!('request_hash'in body)&&!('request_hash'in v.receipt));
  for(const patch of [{confirmed:false},{request_hash:'a'.repeat(64)},{original_command_id:b.authorization_command_id},{attempt_id:b.expected_attempt_id},{expected_state:'dispatched'}])assert.throws(()=>capture(B+'/close-expired',{method:'POST',body:{...body,...patch}}));
  for(const mutate of [x=>x.receipt.authorization_command_id=c.candidate_id,x=>x.receipt.attempt_id=c.candidate_id,x=>x.receipt.candidate_id=b.command_id,x=>x.receipt.signed_hash='f'.repeat(64),x=>x.receipt.model=model==='55'?'65':'55',x=>x.receipt.previous_state=state==='prepared'?'request_ready':'prepared']){const x=structuredClone(ack);mutate(x);assert.throws(()=>bindClosureResult(project(x,request),body,c));}
  for(const mutate of [x=>x.receipt.origin='synthetic',x=>x.receipt.policy_version++,x=>x.receipt.review_id=c.candidate_id,x=>x.receipt.lease_expired_at='2026-10-16T01:00:00.000Z']){const x=structuredClone(ack);mutate(x);assert.throws(()=>bindClosureResult(x,body,c,null,r));}
  const read=project(closed(r,body),capture(B+'/closure-commands/'+body.command_id));const changed=structuredClone(read);changed.receipt.review_id=b.command_id;assert.throws(()=>bindClosureResult(changed,body,c,read));
 }
 for(const state of ['dispatched','submission_uncertain','receipt_pending','failed_before_dispatch','authorized_homologation'])assert.equal(expiredClosureEligible(result(candidate(),{state})),false);
 const r=original();r.current.lease_expired=false;assert.throws(()=>closureIntent(r,candidate(),input(r).command_id,true));assert.throws(()=>closureIntent(original(),candidate(),input(original()).command_id,false));
});
test('55/65 history never proves ownership: explicit original GET precedes confirmation, then one POST and closure GET',async()=>{
 for(const model of ['55','65']){const s=closureFixture({model,state:'request_ready'}),guard=[],v=await mount(s,{onBusy:x=>guard.push(x)});try{
  assert.equal(s.calls.length,0);await v.click('Consultar histórico da autorização revisada');assert.equal(s.calls.length,1);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children===confirm),false);
  await v.click(inspect);assert.deepEqual(s.calls.map(c=>c.kind),['history','command']);assert.equal(s.calls[1].path,B+'/commands/'+s.original.command_id);assert.equal(guard.at(-1),true);
  const old=v.button(confirm);old.props.onClick();old.props.onClick();await v.flush();assert.deepEqual(s.calls.map(c=>c.kind),['history','command','close','closureCommand']);const body=s.calls[2].body;assert.deepEqual(Object.keys(body).sort(),['authorization_command_id','command_id','confirmed','expected_attempt_id','expected_state']);assert.notEqual(body.command_id,s.original.command_id);assert.equal(s.calls[3].path,B+'/closure-commands/'+body.command_id);assert.match(v.text(),/Encerramento confirmado/);assert.doesNotMatch(v.text(),/Tentativa 2 · Intenção registrada/);
  await v.click('Fechar conferência do encerramento');assert.equal(guard.at(-1),false);assert.equal(v.button('Enviar para autorização de homologação').disabled,true);assert.equal(s.calls.some(c=>['run','recover'].includes(c.kind)),false);
 }finally{v.unmount();}}
});
test('foreign ownership, terminal change or no expiry can never offer a closure POST',async()=>{
 for(const mode of ['forbidden','consumed','unexpired']){const s=closureFixture({before(c,s){if(c.kind==='command'){if(mode==='forbidden')throw new AccessError(403);if(mode==='consumed')return result(s.candidate,{state:'dispatched'});const r=structuredClone(s.original);r.current.lease_expired=false;return r;}}}),v=await mount(s);try{await open(v);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children===confirm),false);assert.equal(s.calls.some(c=>c.kind==='close'),false);if(mode==='forbidden')assert.match(v.text(),/acesso precisa ser reconfirmado/);else assert.match(v.text(),/situação da tentativa mudou/);}finally{v.unmount();}}
});
test('confirmation can be cancelled before POST; old confirm and history handlers cannot cross the synchronous guard',async()=>{
 const s=closureFixture(),v=await mount(s);try{await v.click('Consultar histórico da autorização revisada');const oldHistory=v.button('Consultar histórico da autorização revisada');await v.click(inspect);oldHistory.props.onClick();await v.flush();assert.equal(s.calls.filter(c=>c.kind==='history').length,1);const oldConfirm=v.button(confirm);v.button(cancel).props.onClick();oldConfirm.props.onClick();await v.flush();assert.equal(s.calls.filter(c=>c.kind==='close').length,0);assert.equal(v.button('Conferir antes do envio').disabled,false);}finally{v.unmount();}
});
test('lost closure response and unavailable/404/403/409 lookup preserve the closure UUID and never repeat POST',async()=>{
 for(const code of [503,404,403,409]){let reads=0;const s=closureFixture({before(c){if(c.kind==='close')throw new AccessError(503);if(c.kind==='closureCommand'&&reads++===0)throw new AccessError(code);}}),guard=[],v=await mount(s,{onBusy:x=>guard.push(x)});try{await open(v);await v.click(confirm);const body=s.calls.find(c=>c.kind==='close').body;assert.match(v.text(),new RegExp(body.command_id));await v.click(get);assert.match(v.text(),/resultado permanece|mesmo comando|ainda não foi confirmado/);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children===cancel),false);assert.equal(guard.at(-1),true);await v.click(get);assert.equal(s.calls.filter(c=>c.kind==='close').length,1);assert.ok(s.calls.filter(c=>c.kind==='closureCommand').every(c=>c.path.endsWith(body.command_id)));assert.match(v.text(),/Encerramento confirmado/);assert.equal(s.calls.some(c=>['run','recover'].includes(c.kind)),false);}finally{v.unmount();}}
});
test('closure ACK followed by changed immutable receipt stays pending; definitive rejection never claims success',async()=>{
 const s=closureFixture({before(c,s){if(c.kind==='closureCommand'){const r=closed(s.original,s.calls.find(c=>c.kind==='close').body);r.receipt.review_id=r.receipt.candidate_id;return r;}}}),v=await mount(s);try{await open(v);await v.click(confirm);await v.click(get);assert.equal(s.calls.filter(c=>c.kind==='close').length,1);assert.doesNotMatch(v.text(),/Encerramento confirmado/);}finally{v.unmount();}
 const denied=closureFixture({before(c){if(c.kind==='close')throw Object.assign(new AccessError(409),{recovery_required:false});}}),d=await mount(denied);try{await open(d);const stale=d.button(confirm);await d.click(confirm);stale.props.onClick();await d.flush();assert.equal(denied.calls.filter(c=>c.kind==='close').length,1);assert.match(d.text(),/encerramento não foi registrado/);assert.equal(denied.calls.filter(c=>c.kind==='closureCommand').length,0);assert.equal(d.nodes().some(n=>n.type==='button'&&n.props.children===confirm),false);await d.click('Fechar conferência do encerramento');assert.equal(d.button('Conferir antes do envio').disabled,false);}finally{d.unmount();}
});
test('same actor role loss retains closure command hidden/inert, then only GET; actor/logout/candidate changes discard late result',async()=>{
 for(const change of ['role','logout','actor','candidate']){const wait=deferred(),s=closureFixture({before(c){if(c.kind==='close')return wait.promise;}}),v=await mount(s);try{await open(v);v.button(confirm).props.onClick();await v.flush();const body=s.calls.find(c=>c.kind==='close').body,old=v.button(get);
  if(change==='candidate')await v.updateProps({candidate:candidate('65')});else{if(change==='role')s.role='vendas';if(change==='logout'){s.phase='signed_out';s.actor=null;}if(change==='actor')s.actor='a7400000-0000-4000-8000-000000000099';s.notify();await v.flush();}
  old.props.onClick();wait.resolve(closed(s.original,body,false));await v.flush();assert.equal(s.calls.filter(c=>c.kind==='closureCommand').length,0);
  if(change==='role'){assert.equal(v.find(n=>n.type==='section'&&n.props.hidden).props.inert,true);s.role='fiscal';s.notify();await v.flush();await v.click(get);assert.equal(s.calls.filter(c=>c.kind==='closureCommand').length,1);assert.match(v.text(),/Encerramento confirmado/);}else assert.doesNotMatch(v.text(),/Comando de encerramento:/);
  assert.equal(s.calls.filter(c=>c.kind==='close').length,1);
 }finally{wait.resolve({});v.unmount();}}
});
test('review068 invalidation preserves the closure command',async()=>{
 const wait=deferred(),s=closureFixture({before(c){if(c.kind==='close')return wait.promise;}}),v=await mount(s);try{await open(v);v.button(confirm).props.onClick();await v.flush();const body=s.calls.find(c=>c.kind==='close').body;await v.updateProps({reviewRevision:1});assert.match(v.text(),new RegExp(body.command_id));wait.resolve(closed(s.original,body,false));await v.flush();assert.match(v.text(),/Encerramento confirmado/);assert.equal(s.calls.filter(c=>c.kind==='close').length,1);}finally{wait.resolve({});v.unmount();}
});

test('an uncertain original recovery fences a previously captured closure handler and permits only its own command GET',async()=>{
 const s=closureFixture({before(c,s){if(c.kind==='history')return history(s.candidate,[result(s.candidate,{ordinal:'3'}),s.original]);if(c.kind==='recover')throw new AccessError(503);}}),v=await mount(s);try{await v.click('Consultar histórico da autorização revisada');const stale=v.button(inspect);await v.click('Recuperar registro da tentativa 3');const reads=s.calls.filter(c=>c.kind==='command').length;stale.props.onClick();await v.flush();assert.equal(s.calls.filter(c=>c.kind==='command').length,reads);assert.equal(s.calls.some(c=>c.kind==='close'),false);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children===confirm),false);assert.match(v.text(),/Consultar resultado da recuperação/);}finally{v.unmount();}
});
