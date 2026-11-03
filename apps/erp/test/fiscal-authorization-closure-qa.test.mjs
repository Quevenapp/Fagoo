import test from 'node:test';import assert from 'node:assert/strict';
import * as access from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
test('local closure QA exercises55 lost ACK and GET,65 normal completion, gates model switches and never sends',async()=>{
 const v=await mountComponent('../qa/FiscalReviewedAuthorizationQA.tsx',{}, {expandChildren:true,ports:{access},modules:{'../lib/real-access':'export const {createAccessController,AccessError,decimalMoney}=r.access;'}});try{
  for(let i=0;i<10&&!v.text().includes('Autorização com revisão fiscal');i++)await v.flush();v.find(n=>n.props['aria-label']==='Cenário de teste').props.onChange({target:{value:'closure'}});await v.flush();
  for(const model of ['55','65']){
   const select=v.find(n=>n.props['aria-label']==='Modelo de teste');select.props.onChange({target:{value:model}});await v.flush();await v.click('Consultar histórico da autorização revisada');await v.click('Conferir encerramento da tentativa 2');assert.equal(v.button('Enviar para autorização de homologação').disabled,true);await v.click('Confirmar encerramento sem envio');
   if(model==='55'){assert.match(v.text(),/Comando de encerramento:/);assert.equal(v.find(n=>n.props['aria-label']==='Modelo de teste').disabled,true);select.props.onChange({target:{value:'65'}});await v.flush();assert.equal(v.find(n=>n.props['aria-label']==='Modelo de teste').props.value,'55');await v.click('Consultar resultado do encerramento');assert.match(v.text(),/Comando de encerramento:/);await v.click('Consultar resultado do encerramento');}
   assert.match(v.text(),/Encerramento confirmado/);await v.click('Fechar conferência do encerramento');await v.click('Consultar histórico da autorização revisada');assert.equal(v.nodes().some(n=>n.type==='button'&&String(n.props.children).startsWith('Conferir encerramento da tentativa')),false);
  }
  assert.match(v.text(),/Encerramento fictício: 2 · Consulta de encerramento: 3/);assert.match(v.text(),/Envio fictício: 0/);assert.match(v.text(),/Ações proibidas: 0/);
 }finally{v.unmount();}
});
