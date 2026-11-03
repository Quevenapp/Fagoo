import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {history,result,deferred} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {original,closed,input,candidate} from './helpers/fiscal-closure-fixtures.mjs';
import {lookupFixture} from './helpers/fiscal-closure-lookup-fixtures.mjs';
import {closureLookupEligible,closureLookupInput,closureLookupPath,bindClosureLookupResult} from '../src/lib/fiscal-authorization-closure-lookup-model.ts';
const other='a7500000-0000-4000-8000-000000000099';
const mount=s=>mountComponent('FiscalReviewedAuthorization.tsx',{controller:s.controller,candidate:s.candidate},{expandChildren:['FiscalAuthorizationClosure','FiscalAuthorizationClosureReceipt']});
const show=async v=>{await v.click('Consultar histórico da autorização revisada');await v.click('Consultar encerramento da tentativa 2');};
const lookups=s=>s.calls.filter(c=>c.kind==='closureLookup');
for(const model of ['55','65'])test(`075 model${model} finds an existing closure after remount by original IDs, without a new command`,async()=>{
 const s=lookupFixture({model});let v=await mount(s);try{await show(v);assert.equal(lookups(s).length,1);assert.equal(lookups(s)[0].path,closureLookupPath(closureLookupInput(s.failed,s.candidate)));assert.equal(lookups(s)[0].body,undefined);assert.match(v.text(),/Recibo de encerramento consultado/);assert.match(v.text(),new RegExp(closed(s.original).command_id));assert.match(v.text(),/não autoriza novo envio/);v.unmount();v=await mount(s);await show(v);assert.equal(lookups(s).length,2);assert.equal(s.calls.some(c=>c.kind==='run'||c.kind==='recover'||c.path.endsWith('/close-expired')),false);}finally{v.unmount();}
});
for(const status of [404,403,503])test(`075 GET${status} is inconclusive without new UUID, POST or a false closure receipt`,async()=>{
 const s=lookupFixture({before(call){if(call.kind==='closureLookup')throw new AccessError(status);}}),v=await mount(s);try{await show(v);assert.doesNotMatch(v.text(),/Recibo de encerramento consultado/);assert.equal(v.nodes().some(n=>n.type==='button'&&String(n.props.children).includes('Confirmar encerramento')),false);assert.match(v.text(),status===404?/não autoriza encerrar novamente/:status===403?/usuário que registrou/:/nenhuma operação será repetida/);await v.click('Consultar encerramento da tentativa 2');assert.equal(lookups(s).length,2);assert.equal(s.calls.filter(c=>c.method==='POST').length,1);assert.ok(s.calls.filter(c=>c.method==='POST').every(c=>c.kind==='history'));}finally{v.unmount();}
});
test('075 receipt is historical and successor state is reported separately',async()=>{
 const s=lookupFixture({before(call,s){if(call.kind==='closureLookup'){const v=closed(s.original);v.current.successor_exists=true;v.current.intent_consumed=true;return v;}}}),v=await mount(s);try{await show(v);assert.match(v.text(),/Situação consultada agora/);assert.match(v.text(),/tentativa posterior/);assert.match(v.text(),/não confirma envio ou resposta/);assert.doesNotMatch(v.text(),/informa um envio registrado/);assert.equal(s.calls.filter(c=>c.kind==='closureLookup').length,1);}finally{v.unmount();}
});
for(const change of ['actor','logout','role','candidate'])test(`075 ${change} fences a late lookup and its retained handler`,async()=>{
 const wait=deferred(),s=lookupFixture({before(call){if(call.kind==='closureLookup')return wait.promise;}}),v=await mount(s);try{
  await v.click('Consultar histórico da autorização revisada');const old=v.button('Consultar encerramento da tentativa 2').props.onClick;await v.click('Consultar encerramento da tentativa 2');const signal=lookups(s)[0].signal;
  if(change==='actor')s.actor=other;else if(change==='logout'){s.actor=null;s.phase='signed_out';}else if(change==='role')s.role='consulta';else await v.updateProps({candidate:candidate('65')});s.notify();await v.flush();old();await v.flush();wait.resolve(closed(s.original));await v.flush();assert.equal(signal.aborted,true);assert.equal(lookups(s).length,1);assert.doesNotMatch(v.text(),/Recibo de encerramento consultado/);
  if(change==='role'){assert.ok(v.find(n=>n.type==='section'&&n.props.hidden).props.inert);s.role='fiscal';s.notify();await v.flush();assert.equal(lookups(s).length,1);await v.click('Consultar encerramento da tentativa 2');assert.equal(lookups(s).length,2);assert.match(v.text(),/Recibo de encerramento consultado/);}
 }finally{wait.resolve(closed(s.original));v.unmount();}
});
test('075 ignores a retained lookup while an original074 closure intent is pending',async()=>{
 const s=lookupFixture(),pending=original(s.candidate);pending.command_id=other;pending.receipt={...pending.receipt,command_id:other,attempt_id:other,ordinal:'3',batch_id:'3'};
 const originalPort=s.controller.fiscalReviewedAuthorization;s.controller.fiscalReviewedAuthorization=async(path,o={})=>{if(path.endsWith('/history'))return history(s.candidate,[pending,s.failed]);if(path.endsWith('/commands/'+other))return pending;if(path.endsWith('/close-expired'))throw new AccessError(503);return originalPort(path,o);};
 const v=await mount(s);try{await v.click('Consultar histórico da autorização revisada');const old=v.button('Consultar encerramento da tentativa 2').props.onClick;await v.click('Conferir encerramento da tentativa 3');await v.click('Confirmar encerramento sem envio');old();await v.flush();assert.equal(lookups(s).length,0);assert.match(v.text(),/Comando de encerramento:/);assert.equal(v.button('Consultar encerramento da tentativa 2').disabled,true);}finally{v.unmount();}
});
test('075 row eligibility never treats a generic terminal or active attempt as a closure',()=>{
 for(const state of ['prepared','request_ready','dispatched','submission_uncertain','receipt_pending','rejected','authorized_homologation'])assert.equal(closureLookupEligible(result(candidate(),{state})),false);
 const s=lookupFixture();assert.equal(closureLookupEligible(s.failed),true);for(const field of ['candidate_id','signed_hash','model','origin','policy_version','review_id','lease_expired_at','closed_at','attempt_id']){const raw=closed(s.original);raw.receipt[field]=({candidate_id:other,signed_hash:'f'.repeat(64),model:'65',origin:'synthetic',policy_version:99,review_id:other,lease_expired_at:'2020-01-01T00:00:00Z',closed_at:'2020-01-01T00:00:00Z',attempt_id:other})[field];assert.throws(()=>bindClosureLookupResult(raw,closureLookupInput(s.failed,s.candidate),s.candidate,s.failed));}
});
