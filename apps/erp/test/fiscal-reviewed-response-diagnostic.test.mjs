import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedResponseDiagnostic as diagnose} from '../src/lib/fiscal-reviewed-response-diagnostic.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {setup,result,candidate} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {projectDispatchPublic} from '../../../packages/fiscal-authorization-runtime/src/dispatch-public-dto.mjs';

const codes=['SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID'];
function response(c,{validation=null,cstat='104',protocol='204',state='review_required'}={}){
 const row=result(c,{state:'authorized_homologation'});
 Object.assign(row,{status:state,authorized_in_homologation:false});
 Object.assign(row.current,{state,authorized_in_homologation:false});
 Object.assign(row.artifact,{processed_hash:null,processed_size:null,outcome:validation?'invalid_response':state,rejection_code:validation,cstat:validation?null:cstat,protocol_cstat:validation?null:protocol,protocol_number:null,received_at:validation?null:row.artifact.received_at,receipt_number:null});
 return projectDispatchPublic(row,{action:'command',commandId:row.command_id});
}
const mount=s=>mountComponent('FiscalReviewedAuthorization.tsx',{controller:s.controller,candidate:s.candidate});

test('closed validation reasons remain distinct from numeric SEFAZ codes and never invent authorization',()=>{
 for(const model of ['55','65'])for(const code of codes){
  const row=response(candidate(model),{validation:code}),d=diagnose(row.artifact);
  assert.equal(d.kind,'validation');assert.equal(d.code,code);assert.ok(d.message.length>20);
  assert.equal(row.authorized_in_homologation,false);assert.equal(row.can_transmit,false);
 }
 const row=response(candidate());assert.deepEqual(diagnose(row.artifact),{kind:'sefaz',code:'204',batchCode:'104'});
 const rejected=response(candidate('65'),{cstat:'225',protocol:null,state:'rejected'});
 assert.deepEqual(diagnose(rejected.artifact),{kind:'sefaz',code:'225',batchCode:null});
 assert.equal(diagnose(null),null);
});

test('unknown or malicious diagnostics are not echoed, even outside the already closed DTO boundary',()=>{
 const value=response(candidate(),{validation:'XSD_INVALID'}).artifact,marker='<script>SYNTHETIC_PRIVATE_REASON</script>';
 const invalid={...value,rejection_code:marker,xMotivo:marker};
 const d=diagnose(invalid);assert.equal(d.kind,'validation');assert.equal(d.code,null);assert.doesNotMatch(JSON.stringify(d),/SYNTHETIC_PRIVATE_REASON|script/);
 assert.equal(diagnose({...value,outcome:'review_required',rejection_code:null,cstat:marker,protocol_cstat:null}),null);
 const inherited=diagnose({...value,rejection_code:'toString'});assert.equal(inherited.code,null);
});

test('55/65 history renders every validated failure without a resend or raw response',async()=>{
 for(const model of ['55','65'])for(const code of codes){
  const s=setup({model});s.history.items=[response(s.candidate,{validation:code})];const v=await mount(s);
  try{
   await v.click('Consultar histórico da autorização revisada');const text=v.text();
   assert.match(text,/Falha na validação/);assert.match(text,new RegExp(code));assert.match(text,/não confirma autorização/);assert.match(text,/não repita o envio/);
   assert.doesNotMatch(text,/Código de resposta da SEFAZ|Autorização de homologação registrada/);
   assert.equal(v.button('Enviar para autorização de homologação').disabled,true);
   assert.deepEqual(s.calls.map(c=>c.kind),['history']);
  }finally{v.unmount();}
 }
});

test('batch and protocol codes are separately visible and ordinary rejection is not called a local validation failure',async()=>{
 for(const model of ['55','65']){
  const s=setup({model});s.history.items=[response(s.candidate,{protocol:'204'})];const v=await mount(s);
  try{
   await v.click('Consultar histórico da autorização revisada');assert.match(v.text(),/Código de resposta da SEFAZ: 204/);assert.match(v.text(),/Código do lote: 104/);assert.doesNotMatch(v.text(),/Falha na validação/);
   s.history.items=[response(s.candidate,{cstat:'225',protocol:null,state:'rejected'})];await v.click('Consultar histórico da autorização revisada');assert.match(v.text(),/Código de resposta da SEFAZ: 225/);assert.doesNotMatch(v.text(),/Código do lote|Falha na validação/);
   assert.equal(s.calls.every(c=>c.kind==='history'),true);
  }finally{v.unmount();}
 }
});

test('tampered public result never renders free response text and history errors do not suggest an unidentified command',async()=>{
 const s=setup(),row=structuredClone(response(s.candidate,{validation:'SOAP_FAULT'}));row.artifact.rejection_code='SYNTHETIC_PRIVATE_REASON';s.history.items=[row];const v=await mount(s);
 try{await v.click('Consultar histórico da autorização revisada');assert.doesNotMatch(v.text(),/SYNTHETIC_PRIVATE_REASON|Código de validação|Consulte o mesmo comando/);assert.match(v.text(),/consulta não foi concluída/);assert.deepEqual(s.calls.map(c=>c.kind),['history']);}finally{v.unmount();}
});

test('rejection 245 identifies the model-specific homologation registration without enaorigin resend',async()=>{
 for(const model of ['55','65']){
  const s=setup({model});s.history.items=[response(s.candidate,{protocol:'245',state:'rejected'})];const v=await mount(s);
  try{
   await v.click('Consultar histórico da autorização revisada');assert.match(v.text(),/CNPJ do emitente não cadastrado/);
   assert.ok(v.text().includes(`credenciamento de ${model==='65'?'NFC-e':'NF-e'} no ambiente de homologação`));
   assert.equal(v.button('Enviar para autorização de homologação').disabled,true);assert.deepEqual(s.calls.map(c=>c.kind),['history']);
  }finally{v.unmount();}
 }
});

test('visible diagnostic follows existing access and candidate guards, with no I/O on role restoration',async()=>{
 const s=setup();s.history.items=[response(s.candidate,{validation:'CONTEXT_MISMATCH'})];const v=await mount(s);
 try{
  await v.click('Consultar histórico da autorização revisada');const old=v.button('Consultar histórico da autorização revisada');
  s.role='vendas';s.notify();await v.flush();const section=v.find(n=>n.type==='section'&&n.props.hidden);assert.equal(section.props.inert,true);assert.equal(section.props['aria-hidden'],true);
  old.props.onClick();await v.flush();assert.equal(s.calls.length,1);
  s.role='fiscal';s.notify();await v.flush();assert.equal(s.calls.length,1);
  await v.updateProps({candidate:candidate('65')});assert.doesNotMatch(v.text(),/CONTEXT_MISMATCH/);assert.equal(s.calls.length,1);
 }finally{v.unmount();}
});
