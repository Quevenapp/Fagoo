import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {fixture,clone,gate,result,payload} from './helpers/fiscal-reconciliation-fixtures.mjs';
import {RECONCILIATION_BASE as BASE} from '../src/lib/fiscal-reconciliation-model.ts';
const mount=(s,props={})=>mountComponent('FiscalReconciliation.tsx',{controller:s.controller,candidate:s.candidate,enabled:true,...props});
const check=v=>v.find(n=>n.type==='input'&&n.props.type==='checkbox');
const confirm=async v=>{assert.equal(check(v).disabled,false);check(v).props.onChange({target:{checked:true}});await v.flush();};
const runLabel='Consultar situação desta chave em homologação';
test('062 UI mounts only metadata/history; unchecked explicit confirmation creates one run and command GET for 55/65',async()=>{
 for(const model of ['55','65']){const s=fixture({model}),v=await mount(s);try{
  assert.deepEqual(s.calls.map(x=>x.kind),['history','a1','company']);assert.equal(check(v).props.checked,false);assert.equal(v.button(runLabel).disabled,true);
  await confirm(v);assert.equal(v.guard().changed,true);await v.click(runLabel);
  assert.equal(s.counts.run,1);assert.equal(s.counts.command,1);assert.equal(s.counts.recover,undefined);assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);
  const b=s.calls.find(c=>c.kind==='run').body;assert.deepEqual(Object.keys(b).sort(),['candidate_id','command_id','confirmed','expected_a1_version','expected_identity_version','signed_hash']);assert.equal(b.confirmed,true);assert.equal(b.expected_identity_version,2);assert.equal(b.expected_a1_version,1);assert.equal(b.signed_hash,s.candidate.artifact.sha256);
  assert.match(v.text(),/Código de situação observado: 217/);assert.match(v.text(),/não conclui a homologação/);
 }finally{v.unmount();}}
});
test('feature false defaults to unavailable but own dispatched history can GET and recover without any run',async()=>{
 const r=result('dispatched',payload(),true),s=fixture({historyRows:[r]});s.commands.set(r.command_id,clone(r));const v=await mount(s,{enabled:false});try{
  assert.match(v.text(),/Novas consultas estão indisponíveis/);assert.equal(check(v).disabled,true);await v.click('Consultar tentativa 1');assert.equal(s.counts.command,1);
  await v.click('Recuperar resposta já guardada');assert.equal(s.counts.recover,1);assert.equal(s.counts.command,2);assert.equal(s.counts.run,undefined);assert.equal(v.guard().busy,false);
  assert.deepEqual(s.calls.find(c=>c.kind==='recover').body,{command_id:r.command_id});
 }finally{v.unmount();}
});
test('lost run ACK and failed GET retain UUID/body; stale discard/refresh/run handlers cannot resend',async()=>{
 const s=fixture({after(c){if(c.kind==='run')throw new AccessError(503);},before(c,s){if(c.kind==='command'&&s.counts.command===1)throw new AccessError(403);}}),v=await mount(s);try{
  const oldRun=v.button(runLabel),oldRefresh=v.button('Atualizar leituras'),oldDiscard=v.button('Descartar confirmação'),oldCheck=check(v);await confirm(v);await v.click(runLabel);
  assert.equal(s.counts.command,undefined);assert.equal(v.guard().busy,true);await v.click('Conferir mesma tentativa');const n=s.calls.length;
  oldRun.props.onClick();oldRefresh.props.onClick();oldDiscard.props.onClick();oldCheck.props.onChange({target:{checked:false}});await v.flush();assert.equal(s.calls.length,n);assert.equal(v.guard().busy,true);
  await v.click('Conferir mesma tentativa');assert.equal(s.counts.run,1);assert.equal(v.guard().busy,false);const op=s.calls.find(c=>c.kind==='run').body;assert.equal(new Set(s.calls.filter(c=>c.kind==='command').map(c=>c.path)).size,1);assert.equal(s.calls.filter(c=>c.kind==='command')[0].path,BASE+'/commands/'+op.command_id);
 }finally{v.unmount();}
});
test('known ACK followed by GET404 or binding mismatch stays read-only until exact receipt is recovered',async()=>{
 const s=fixture({before(c,s){if(c.kind==='command'&&s.counts.command===1)throw new AccessError(404);}}),v=await mount(s);try{
  await confirm(v);await v.click(runLabel);assert.equal(v.guard().busy,true);assert.match(v.text(),/recibo conhecido/);
  const ack=[...s.commands.values()][0];ack.receipt.model='65';await v.click('Conferir mesma tentativa');assert.equal(v.guard().busy,true);
  ack.receipt.model='55';await v.click('Conferir mesma tentativa');assert.equal(v.guard().busy,false);assert.equal(s.counts.run,1);assert.equal(s.counts.command,3);
 }finally{v.unmount();}
});
test('unknown run with repeated command404 never creates a new UUID or automatically retries',async()=>{
 const s=fixture({before(c){if(c.kind==='run')throw new AccessError(503);}}),v=await mount(s);try{
  await confirm(v);await v.click(runLabel);await v.click('Conferir mesma tentativa');await v.click('Conferir mesma tentativa');assert.equal(s.counts.run,1);assert.equal(s.commands.size,0);assert.equal(v.guard().busy,true);
  assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Preparar nova consulta'),false);assert.equal(new Set(s.calls.filter(c=>c.kind==='command').map(c=>c.path)).size,1);
 }finally{v.unmount();}
});
test('recovery failure keeps original command and first allows only GET, never another recover/run',async()=>{
 const s=fixture({state:'dispatched',after(c){if(c.kind==='recover')throw new AccessError(503);},before(c,s){if(c.kind==='command'&&s.counts.command===2)throw new AccessError(409);}}),v=await mount(s);try{
  await confirm(v);await v.click(runLabel);const oldRecover=v.button('Recuperar resposta já guardada');await v.click('Recuperar resposta já guardada');assert.equal(v.guard().busy,true);
  await v.click('Conferir mesma tentativa');oldRecover.props.onClick();await v.flush();assert.equal(s.counts.recover,1);assert.equal(s.counts.run,1);
  await v.click('Conferir mesma tentativa');assert.equal(v.guard().busy,false);assert.equal(s.counts.recover,1);assert.match(v.text(),/Resposta guardada/);
 }finally{v.unmount();}
});
test('another actor history is readable but cannot recover; current A1 failure does not hide historical reads',async()=>{
 const r=result('uncertain',payload(),true);r.recoverable_by_actor=false;const s=fixture({historyRows:[r],before(c){if(c.kind==='a1')throw new AccessError(503);if(c.kind==='command')throw new AccessError(403);}});s.commands.set(r.command_id,clone(r));const v=await mount(s);try{
  assert.equal(check(v).disabled,true);await v.click('Consultar tentativa 1');assert.match(v.text(),/usuário que confirmou/);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Recuperar resposta já guardada'),false);assert.equal(s.counts.command,1);assert.equal(v.guard().busy,false);assert.equal(v.button('Atualizar leituras').disabled,false);assert.match(v.text(),/captura histórica permanece disponível/);await v.click('Atualizar leituras');assert.equal(s.counts.history,2);assert.equal(s.counts.run,undefined);assert.equal(s.counts.recover,undefined);
 }finally{v.unmount();}
});
test('logout/actor change clear results and abort late ACK; same actor role loss preserves uncertain command',async()=>{
 for(const logout of [false,true]){const wait=gate(),entered=gate(),s=fixture({after(c){if(c.kind==='run'){entered.resolve();return wait.promise;}}}),v=await mount(s);try{
  await confirm(v);v.button(runLabel).props.onClick();await entered.promise;s.actor='b0000000-0000-4000-8000-000000000001';if(logout)s.phase='signed_out';s.notify();await v.flush();wait.resolve();await v.flush();assert.equal(s.calls.find(c=>c.kind==='run').signal.aborted,true);assert.equal(s.counts.command,undefined);assert.equal(v.text().includes('Resposta guardada'),false);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}}
 const s=fixture({after(c){if(c.kind==='run')throw new AccessError(503);}}),v=await mount(s);try{await confirm(v);await v.click(runLabel);s.role='consulta';s.notify();await v.flush();assert.match(v.text(),/perfil não permite/);assert.equal(v.guard().busy,true);s.role='fiscal';s.notify();await v.flush();await v.click('Conferir mesma tentativa');assert.equal(s.counts.run,1);assert.equal(v.guard().busy,false);}finally{v.unmount();}
});
test('changing immutable candidate during request aborts, ignores late ACK and clears confirmation',async()=>{
 const wait=gate(),entered=gate(),s=fixture({after(c){if(c.kind==='run'){entered.resolve();return wait.promise;}}}),v=await mount(s);try{
  await confirm(v);v.button(runLabel).props.onClick();await entered.promise;const next=clone(s.candidate);next.model='65';await v.updateProps({candidate:next});wait.resolve();await v.flush();assert.equal(s.calls.find(c=>c.kind==='run').signal.aborted,true);assert.equal(s.counts.command,undefined);assert.equal(check(v).props.checked,false);assert.equal(v.text().includes('Resposta guardada'),false);
 }finally{v.unmount();}
});
test('historical commercial/A1 state does not block query with current A1; new query needs fresh bases and confirmation',async()=>{
 const s=fixture();s.candidate.current.basis_changed=true;s.candidate.current.unsigned_artifact_current=false;s.candidate.current.a1_changed=true;s.candidate.current.a1_version=2;s.candidate.current.artifact_current=false;s.a1.version=2;const v=await mount(s);try{
  await confirm(v);await v.click(runLabel);assert.equal(s.calls.find(c=>c.kind==='run').body.expected_a1_version,2);await v.click('Preparar nova consulta');assert.equal(s.counts.a1,2);assert.equal(s.counts.company,2);assert.equal(check(v).props.checked,false);assert.equal(v.button(runLabel).disabled,true);assert.equal(s.counts.run,1);
 }finally{v.unmount();}
});
test('prepared result may resume only same UUID/body after fresh explicit checkbox; disabled server blocks stale callbacks',async()=>{
 const s=fixture({state:'prepared'}),v=await mount(s);try{await confirm(v);await v.click(runLabel);assert.equal(check(v).props.checked,false);assert.equal(v.button('Confirmar envio da consulta preparada').disabled,true);await confirm(v);await v.click('Confirmar envio da consulta preparada');assert.equal(s.counts.run,2);assert.deepEqual(s.calls.filter(c=>c.kind==='run')[0].body,s.calls.filter(c=>c.kind==='run')[1].body);}finally{v.unmount();}
 const e=Object.assign(new AccessError(409),{code:'RECONCILIATION_DISABLED',recovery_required:false}),t=fixture({before(c){if(c.kind==='run')throw e;}}),w=await mount(t);try{const old=w.button(runLabel),oldCheck=check(w);await confirm(w);await w.click(runLabel);assert.match(w.text(),/Novas consultas estão indisponíveis/);await w.click('Atualizar leituras');oldCheck.props.onChange({target:{checked:true}});old.props.onClick();await w.flush();assert.equal(t.counts.run,1);}finally{w.unmount();}
});
test('unmount cancels in-flight request and no late readback is scheduled',async()=>{
 const wait=gate(),entered=gate(),s=fixture({after(c){if(c.kind==='run'){entered.resolve();return wait.promise;}}}),v=await mount(s);await confirm(v);v.button(runLabel).props.onClick();await entered.promise;v.unmount();wait.resolve();await new Promise(r=>setTimeout(r,2));assert.equal(s.calls.find(c=>c.kind==='run').signal.aborted,true);assert.equal(s.counts.command,undefined);
});
test('transient membership revalidation without actor does not erase an uncertain command',async()=>{
 const s=fixture({after(c){if(c.kind==='run')throw new AccessError(503);}}),original=s.controller.getSnapshot;
 const v=await mount(s);try{await confirm(v);await v.click(runLabel);s.controller.getSnapshot=()=>({phase:'checking',membership:null});s.notify();await v.flush();assert.equal(v.guard().busy,true);assert.match(v.text(),/perfil não permite/);
 s.controller.getSnapshot=original;s.notify();await v.flush();await v.click('Conferir mesma tentativa');assert.equal(s.counts.run,1);assert.equal(s.counts.command,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('busy/draft callbacks lock the parent; parent blocked changes do not suppress completion cleanup',async()=>{
 const busy=[],dirty=[],wait=gate(),entered=gate(),s=fixture({after(c){if(c.kind==='run'){entered.resolve();return wait.promise;}}}),v=await mount(s,{onBusy:x=>busy.push(x),onDraft:x=>dirty.push(x)});try{
 assert.equal(busy.includes(true),true);assert.equal(busy.at(-1),false);await confirm(v);assert.equal(dirty.at(-1),true);v.button(runLabel).props.onClick();await entered.promise;await v.updateProps({blocked:true});assert.equal(busy.at(-1),true);wait.resolve();await v.flush();assert.equal(s.counts.command,1);assert.equal(busy.at(-1),false);assert.equal(dirty.at(-1),false);assert.equal(v.button('Consultar esta tentativa').disabled,true);
 }finally{v.unmount();assert.equal(busy.at(-1),false);assert.equal(dirty.at(-1),false);}
});

test('callbacks from a previous actor or candidate cannot confirm or send on a fresh scope',async()=>{
 const s=fixture(),v=await mount(s);try{const oldCheck=check(v),oldRun=v.button(runLabel);s.actor='b0000000-0000-4000-8000-000000000001';s.notify();await v.flush();oldCheck.props.onChange({target:{checked:true}});oldRun.props.onClick();await v.flush();assert.equal(check(v).props.checked,false);assert.equal(s.counts.run,undefined);
 const old2=check(v);const c=clone(s.candidate);c.model='65';await v.updateProps({candidate:c});old2.props.onChange({target:{checked:true}});await v.flush();assert.equal(check(v).props.checked,false);
 }finally{v.unmount();}
});
