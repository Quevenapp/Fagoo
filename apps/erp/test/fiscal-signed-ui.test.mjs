import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {signedFixture,checkbox,confirm} from './helpers/fiscal-signed-ui-fixture.mjs';
const copy=structuredClone;
const mount=(s,props={})=>mountComponent('FiscalSignedCandidate.tsx',{controller:s.controller,job:copy(s.f.job),model:s.f.draft.record.model,...props});
test('050 mount only reads certificate and history; signing requires a separate unchecked confirmation and exact current GET',async()=>{
 for(const model of['55','65']){const s=signedFixture({model}),v=await mount(s);try{
  assert.equal(s.counts.run,undefined);assert.deepEqual(s.calls.map(c=>c.kind),['a1','history']);assert.equal(checkbox(v).props.checked,false);assert.equal(v.button('Assinar XML de homologação').disabled,true);
  await confirm(v);assert.equal(v.guard().changed,true);await v.click('Assinar XML de homologação');assert.equal(s.counts.run,1);assert.equal(s.counts.command,1);assert.equal(s.counts.candidate,1);assert.equal(v.guard().changed,false);assert.equal(v.guard().busy,false);assert.match(v.text(),/assinatura não é autorização fiscal/i);assert.match(v.text(),/Arquivo assinado guardado/);assert.equal(v.button('Assinar XML de homologação').disabled,true);
  const body=s.calls.find(c=>c.kind==='run').body;assert.deepEqual(Object.keys(body).sort(),['command_id','unsigned_job_id','unsigned_hash','basis_hash','expected_a1_version'].sort());assert.equal(body.unsigned_hash,s.f.job.artifact.sha256);assert.equal(body.expected_a1_version,1);
 }finally{v.unmount();}}
});
test('050 preserves uncertain command through403/409 and old controls cannot discard, reload or replace its body',async()=>{
 for(const status of[403,409]){const s=signedFixture({after(c,s){if(c.kind==='run'&&s.counts.run===1)throw new AccessError(503);},before(c,s){if(c.kind==='command'&&s.counts.command===1)throw new AccessError(status);}}),v=await mount(s);try{
  const reload=v.button('Atualizar certificado e assinaturas'),discard=v.button('Descartar confirmação de assinatura'),check=checkbox(v);await confirm(v);await v.click('Assinar XML de homologação');assert.doesNotMatch(v.text(),/Nenhuma assinatura registrada/);assert.match(v.text(),/Consulte o histórico para atualizar esta lista/);await v.click('Conferir resultado da assinatura');assert.equal(v.guard().busy,true);assert.doesNotMatch(v.text(),/Nenhuma assinatura registrada/);
  const count=s.calls.length;reload.props.onClick();discard.props.onClick();check.props.onChange({target:{checked:false}});await v.flush();assert.equal(s.calls.length,count);assert.equal(v.guard().busy,true);await v.updateProps({blocked:true});assert.equal(v.button('Conferir resultado da assinatura').disabled,true);await v.updateProps({blocked:false});
  await v.click('Conferir resultado da assinatura');assert.equal(s.counts.run,1);assert.equal(s.commands.size,1);assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);
 }finally{v.unmount();}}
});
test('050 unknown command must be consulted first;404 permits only explicit resend of identical command and body',async()=>{
 const s=signedFixture({before(c,s){if(c.kind==='run'&&s.counts.run===1)throw new AccessError(503);}}),v=await mount(s);try{
  await confirm(v);await v.click('Assinar XML de homologação');assert.equal(v.nodes().some(n=>n.type==='button'&&String(n.props.children)==='Reenviar a mesma assinatura'),false);
  await v.click('Conferir resultado da assinatura');assert.equal(s.counts.run,1);await v.click('Reenviar a mesma assinatura');assert.equal(s.counts.run,2);const posts=s.calls.filter(c=>c.kind==='run');assert.deepEqual(posts[0].body,posts[1].body);assert.equal(s.commands.size,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('050 confirmed ACK with failed or mismatched current GET never repeats signing',async()=>{
 const s=signedFixture({before(c,s){if(c.kind==='candidate'&&s.counts.candidate===1)throw new AccessError(503);}}),v=await mount(s);try{
  await confirm(v);await v.click('Assinar XML de homologação');assert.equal(v.guard().busy,true);s.candidate.completion_hash='c'.repeat(64);await v.click('Conferir resultado da assinatura');assert.equal(v.guard().busy,true);s.candidate.completion_hash=s.f.job.completion_hash;await v.click('Conferir resultado da assinatura');assert.equal(s.counts.run,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('050 known pending ACK is durable and does not trap navigation; explicit resume reuses original command',async()=>{
 const s=signedFixture(),v=await mount(s);try{
  s.candidate=s.make('pending');await confirm(v);await v.click('Assinar XML de homologação');assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);assert.equal(v.button('Solicitar retomada da assinatura pendente').disabled,true);assert.match(v.text(),/nenhuma retomada será feita automaticamente/i);
  await confirm(v);s.candidate=s.make('stored');await v.click('Solicitar retomada da assinatura pendente');assert.equal(s.counts.run,2);const posts=s.calls.filter(c=>c.kind==='run');assert.deepEqual(posts[0].body,posts[1].body);assert.equal(s.commands.size,1);
 }finally{v.unmount();}
});
test('050 reopened pending never resumes automatically and changed basis/certificate remains read only',async()=>{
 const s=signedFixture({state:'pending'});s.candidate.current.a1_changed=true;s.candidate.current.a1_version=2;s.a1.version=2;
 const v=await mount(s);try{assert.equal(s.counts.run,undefined);assert.equal(v.guard().busy,false);assert.equal(checkbox(v).disabled,true);assert.equal(v.button('Solicitar retomada da assinatura pendente').disabled,true);assert.match(v.text(),/certificado mudou/i);await v.click('Consultar andamento da assinatura');assert.equal(s.counts.run,undefined);}finally{v.unmount();}
});
test('050 role change cannot erase an uncertain attempt; regaining access only allows consultation',async()=>{
 const s=signedFixture({after(c){if(c.kind==='run')throw new AccessError(503);}}),v=await mount(s);try{
  await confirm(v);await v.click('Assinar XML de homologação');s.role='consulta';await v.updateProps({});assert.equal(v.button('Conferir resultado da assinatura').disabled,true);assert.equal(v.guard().busy,true);s.role='fiscal';await v.updateProps({});await v.click('Conferir resultado da assinatura');assert.equal(s.counts.run,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('050 ineligible A1/unsigned source cannot be signed; history remains separated and keyboard scrollable',async()=>{
 for(const change of['absent','expired','company','basis']){const s=signedFixture({state:'stored'});if(change==='absent')s.a1={version:0,state:'unconfigured',credential_id:null,company_identity_version:null,metadata:null,company_changed:false,time_valid_now:false};if(change==='expired')s.a1.time_valid_now=false;if(change==='company')s.a1.company_changed=true;if(change==='basis'){s.f.job.current.basis_changed=true;s.f.job.current.artifact_current=false;s.candidate.current.basis_changed=true;s.candidate.current.unsigned_artifact_current=false;s.candidate.current.artifact_current=false;}
  const v=await mount(s);try{assert.equal(v.button('Assinar XML de homologação').disabled,true);assert.equal(s.counts.run,undefined);assert.equal(v.find(n=>n.props.role==='region').props.tabIndex,0);}finally{v.unmount();}
 }
});
test('050 unmount aborts a pending request and late ACK cannot trigger readback or parent callbacks',async()=>{
 let release;const gate=new Promise(r=>release=r),events=[],s=signedFixture({after(c){if(c.kind==='run')return gate;}}),v=await mount(s,{onBusy:x=>events.push(x)});await confirm(v);v.button('Assinar XML de homologação').props.onClick();await v.flush();const sent=s.calls.find(c=>c.kind==='run');v.unmount();const count=events.length;release();await new Promise(r=>setTimeout(r,5));assert.equal(sent.signal.aborted,true);assert.equal(s.counts.command,undefined);assert.equal(events.length,count);
});
