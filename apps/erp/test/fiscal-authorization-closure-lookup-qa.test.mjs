import test from 'node:test';import assert from 'node:assert/strict';
import * as access from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
test('075 QA starts with closure receipts already stored, supports55/65 and has zero new closure or send',async()=>{
 const v=await mountComponent('../qa/FiscalReviewedAuthorizationQA.tsx',{}, {expandChildren:true,ports:{access},modules:{'../lib/real-access':'export const {createAccessController,AccessError,decimalMoney}=r.access;'}});try{
  for(let i=0;i<10&&!v.text().includes('Autorização com revisão fiscal');i++)await v.flush();v.find(n=>n.props['aria-label']==='Cenário de teste').props.onChange({target:{value:'closure_lookup'}});await v.flush();
  for(const model of ['55','65']){v.find(n=>n.props['aria-label']==='Modelo de teste').props.onChange({target:{value:model}});await v.flush();await v.click('Consultar histórico da autorização revisada');await v.click('Consultar encerramento da tentativa 2');assert.match(v.text(),/Recibo de encerramento consultado/);assert.equal(v.button('Enviar para autorização de homologação').disabled,true);assert.equal(v.nodes().some(n=>n.type==='button'&&String(n.props.children).includes('Confirmar encerramento')),false);}
  assert.match(v.text(),/Consulta por tentativa original: 2 · Encerramentos novos: 0/);assert.match(v.text(),/Envio fictício: 0/);assert.match(v.text(),/Ações proibidas: 0/);
 }finally{v.unmount();}
});
