import './helpers/synthetic-october-clock.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import * as access from '../src/lib/real-access.ts';
const {createAccessController}=access;
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {createReviewedAuthorizationQaFixture,REVIEWED_QA_ACTOR,REVIEWED_QA_API,REVIEWED_QA_ORIGIN} from '../src/qa/reviewed-authorization-fixture.ts';
const B='/v1/fiscal-authorization/reviewed';
const session={access_token:'synthetic-reviewed-qa-test',user:{id:REVIEWED_QA_ACTOR}},auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session:null},error:null}),signOut:async()=>({error:null})};
const tick=()=>new Promise(r=>setImmediate(r));
test('isolated QA uses real client/controller for55 lost ACK/GET and65 success, with zero fallback network',async()=>{
 const f=createReviewedAuthorizationQaFixture(),controller=createAccessController(auth,REVIEWED_QA_API,f.fetch,{a1ApiUrl:REVIEWED_QA_ORIGIN}),stop=controller.start();try{
 for(let i=0;i<100&&controller.getSnapshot().phase!=='ready';i++)await tick();assert.equal(controller.getSnapshot().phase,'ready');
 for(const model of ['55','65']){const c=f.candidate(model),page=await controller.fiscalReviewedAuthorization(`${B}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before:null}}),id=page.items[0].command_id;
  const request=controller.fiscalReviewedAuthorization(B+'/recover',{method:'POST',body:{command_id:id}});
  if(model==='55'){await assert.rejects(request,e=>e.status===503&&e.recovery_required);await assert.rejects(controller.fiscalReviewedAuthorization(`${B}/commands/${id}`),e=>e.status===503&&!e.recovery_required);}else assert.equal((await request).authorized_in_homologation,true);
  assert.equal((await controller.fiscalReviewedAuthorization(`${B}/commands/${id}`)).authorized_in_homologation,true);
 }
 assert.deepEqual(f.counts,{status:0,preflight:0,run:0,history:2,recover:2,command:3,close:0,closureCommand:0,closureLookup:0,revalidationContext:0,revalidationRun:0,revalidationCommand:0,forbidden:0});
 await assert.rejects(f.fetch('https://network.example/v1/me'));assert.equal(f.counts.forbidden,1);
 }finally{stop();}
});
test('actual QA panel keeps model locked until explicit same-command recovery and displays counters',async()=>{
 const v=await mountComponent('../qa/FiscalReviewedAuthorizationQA.tsx',{}, {expandChildren:true,ports:{access},modules:{'../lib/real-access':'export const {createAccessController,AccessError,decimalMoney}=r.access;'}});try{
 for(let i=0;i<10&&!v.text().includes('Autorização com revisão fiscal');i++)await v.flush();
 await v.click('Consultar histórico da autorização revisada');await v.click('Recuperar registro da tentativa 2');const select=v.find(n=>n.type==='select'&&n.props['aria-label']==='Modelo de teste');assert.equal(select.disabled,true);const old=select.props.onChange;old({target:{value:'65'}});await v.flush();assert.equal(v.find(n=>n.type==='select'&&n.props['aria-label']==='Modelo de teste').props.value,'55');
 await v.click('Consultar resultado da recuperação');assert.equal(v.find(n=>n.type==='select'&&n.props['aria-label']==='Modelo de teste').disabled,true);await v.click('Consultar resultado da recuperação');assert.equal(v.find(n=>n.type==='select'&&n.props['aria-label']==='Modelo de teste').disabled,false);assert.match(v.text(),/Recuperação: 1 · Consulta de comando: 2 · Ações proibidas: 0/);
 v.find(n=>n.type==='select'&&n.props['aria-label']==='Modelo de teste').props.onChange({target:{value:'65'}});await v.flush();await v.click('Consultar histórico da autorização revisada');await v.click('Recuperar registro da tentativa 2');assert.match(v.text(),/Recuperação: 2 · Consulta de comando: 3 · Ações proibidas: 0/);assert.equal(v.button('Enviar para autorização de homologação').disabled,true);
 }finally{v.unmount();}
});
test('synthetic072/073 scenario uses real UI/controller and selected CAS, default fixture never enables sending',async()=>{
 const v=await mountComponent('../qa/FiscalReviewedAuthorizationQA.tsx',{}, {expandChildren:true,ports:{access},modules:{'../lib/real-access':'export const {createAccessController,AccessError,decimalMoney}=r.access;'}});try{
  for(let i=0;i<10&&!v.text().includes('Autorização com revisão fiscal');i++)await v.flush();await v.click('Conferir antes do envio');assert.equal(v.button('Enviar para autorização de homologação').disabled,true);assert.match(v.text(),/envio está desativado neste ambiente/);
  v.find(n=>n.props['aria-label']==='Cenário de teste').props.onChange({target:{value:'ready'}});await v.flush();await v.click('Conferir antes do envio');const box=v.find(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(box.disabled,false);box.props.onChange({target:{checked:true}});await v.flush();await v.click('Enviar para autorização de homologação');assert.match(v.text(),/Envio fictício: 1/);assert.equal(v.find(n=>n.props['aria-label']==='Cenário de teste').disabled,true);await v.click('Consultar resultado do envio');await v.click('Consultar resultado do envio');assert.match(v.text(),/Última consulta/);assert.match(v.text(),/Envio fictício: 1/);assert.match(v.text(),/Ações proibidas: 0/);
 }finally{v.unmount();}
});
