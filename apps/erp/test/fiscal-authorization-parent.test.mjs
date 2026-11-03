import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {signedFixture,checkbox} from './helpers/fiscal-signed-ui-fixture.mjs';
import {authorizationQaPreview} from '../src/qa/authorization-fixture.ts';
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
const mount=s=>mountComponent('FiscalSignedCandidate.tsx',{controller:s.controller,job:structuredClone(s.f.job),model:'55'},{expandChildren:['FiscalAuthorization']});
test('A1 metadata failure does not hide the validated signed candidate or authorization read-only panel',async()=>{
 const s=signedFixture({state:'stored',before(c){if(c.kind==='a1')throw new AccessError(503);}});s.controller.subscribe=()=>()=>{};s.controller.fiscalAuthorization=async()=>{throw Error('NO_MOUNT_REQUEST');};const v=await mount(s);try{assert.match(v.text(),/Arquivo assinado guardado/);assert.match(v.text(),/Autorização de homologação/);assert.equal(v.button('Assinar XML de homologação').disabled,true);assert.equal(v.button('Conferir preparação para autorização').disabled,false);assert.equal(s.counts.run,undefined);}finally{v.unmount();}
});
test('064 busy ref immediately fences old050 handlers and parent state; completion releases own child without circular block',async()=>{
 const s=signedFixture({state:'stored'}),wait=gate(),entered=gate(),calls=[];s.controller.subscribe=()=>()=>{};s.controller.fiscalAuthorization=async(path,options)=>{calls.push({path,options});entered.resolve();await wait.promise;return authorizationQaPreview(s.candidate);};
 const v=await mount(s);try{const old=v.button('Atualizar certificado e assinaturas'),oldHistory=v.button('Atualizar histórico de assinaturas'),oldCheck=checkbox(v);v.button('Conferir preparação para autorização').props.onClick();await entered.promise;const count=s.calls.length;old.props.onClick();oldHistory.props.onClick();oldCheck.props.onChange({target:{checked:true}});await v.flush();assert.equal(s.calls.length,count);assert.equal(v.button('Atualizar certificado e assinaturas').disabled,true);assert.equal(v.button('Conferir preparação para autorização').disabled,true);wait.resolve();await v.flush();assert.match(v.text(),/Conferência local concluída/);assert.equal(v.button('Conferir preparação para autorização').disabled,false);assert.equal(calls.length,1);assert.equal(s.counts.run,undefined);}finally{v.unmount();}
});
test('initial historical read is discarded after actor switch and aborts on unmount',async()=>{
 for(const change of ['actor','unmount']){const wait=gate(),entered=gate(),s=signedFixture({state:'stored',after(c){if(c.kind==='history'){entered.resolve();return wait.promise;}}});s.controller.subscribe=()=>()=>{};s.controller.fiscalAuthorization=async()=>{throw Error('NO_MOUNT_REQUEST');};const v=await mount(s);await entered.promise;
 if(change==='unmount')v.unmount();else{s.actor='e0000000-0000-4000-8000-000000000099';const old=s.controller.getSnapshot;s.controller.getSnapshot=()=>({...old(),membership:{...old().membership,user_id:s.actor}});}
 wait.resolve();if(change==='unmount'){await new Promise(r=>setImmediate(r));assert.equal(s.calls.find(c=>c.kind==='history').signal.aborted,true);}else{await v.flush();assert.doesNotMatch(v.text(),/Arquivo assinado guardado/);v.unmount();}
 }
});
