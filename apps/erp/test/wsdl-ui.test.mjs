import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {configured,company,envelope} from './helpers/a1-fixtures.mjs';
import {result} from '../../../packages/fiscal-wsdl-runtime/test/fixtures.mjs';
const copy=structuredClone;
function fixture({before=()=>{},after=()=>{},status='stored'}={}){
 const s={a1:copy(configured),company:copy(company),calls:[],counts:{},commands:new Map(),role:'admin',actor:'a0000000-0000-4000-8000-000000000099',status};
 const call=async(kind,path,o={})=>{const c={kind,path,body:copy(o.body),signal:o.signal};s.calls.push(c);s.counts[kind]=(s.counts[kind]??0)+1;await before(c,s);let value;
  if(kind==='a1')value=envelope(s.a1);else if(kind==='company')value=s.company;else if(kind==='run'){value=result(s.status,o.body);s.commands.set(o.body.command_id,copy(value));}else{const stored=s.commands.get(path.split('/').at(-1));if(!stored)throw new AccessError(404);value={...copy(stored),read_only:true,recovered:false};}
  await after(c,s);return copy(value);
 };
 s.controller={getSnapshot:()=>({phase:'ready',membership:{user_id:s.actor,role:s.role}}),a1:(p,o)=>call('a1',p,o),company:(p,o)=>call('company',p,o),wsdl:(p,o)=>call(p.endsWith('/run')?'run':'command',p,o)};return s;
}
const mount=s=>mountComponent('SefazConnection.tsx',{controller:s.controller});
const checkbox=v=>v.find(n=>n.type==='input'&&n.props.type==='checkbox');
const select=v=>v.find(n=>n.type==='select'&&n.props.id.endsWith('-model'));
const service=v=>v.find(n=>n.type==='select'&&n.props.id.endsWith('-operation'));
const confirm=async(v,model='55',operation='protocol')=>{select(v).props.onChange({target:{value:model}});service(v).props.onChange({target:{value:operation}});await v.flush();checkbox(v).props.onChange({target:{checked:true}});await v.flush();};
test('WSDL mount reads only metadata; each model/service needs explicit selection and confirmation before one POST and GET',async()=>{
 for(const model of ['55','65'])for(const operation of ['protocol','authorization','receipt']){const s=fixture(),v=await mount(s);try{
  assert.deepEqual(s.calls.map(c=>c.kind),['a1','company']);assert.equal(select(v).props.value,'');assert.equal(service(v).props.value,'');assert.equal(checkbox(v).props.checked,false);assert.equal(v.button('Verificar conexão').disabled,true);
  await confirm(v,model,operation);assert.equal(v.guard().changed,true);await v.click('Verificar conexão');assert.equal(s.counts.run,1);assert.equal(s.counts.command,1);assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);assert.match(v.text(),/não significa homologação concluída/);
  const body=s.calls.find(c=>c.kind==='run').body;assert.equal(body.operation,operation);assert.equal(body.model,model);assert.equal(body.expected_identity_version,2);assert.equal(body.expected_a1_version,1);assert.equal(Object.keys(body).length,6);
 }finally{v.unmount();}}
});
test('WSDL 503→403/409 preserves one command and old controls cannot discard or replace it',async()=>{
 for(const status of [403,409])for(const operation of ['protocol','authorization','receipt']){const s=fixture({after(c){if(c.kind==='run')throw new AccessError(503);},before(c,s){if(c.kind==='command'&&s.counts.command===1)throw new AccessError(status);}}),v=await mount(s);try{
  const reload=v.button('Atualizar empresa e certificado'),discard=v.button('Descartar confirmação'),oldCheck=checkbox(v),oldSelect=select(v),oldService=service(v);await confirm(v,'55',operation);await v.click('Verificar conexão');await v.click('Conferir resultado');const count=s.calls.length;
  reload.props.onClick();discard.props.onClick();oldCheck.props.onChange({target:{checked:false}});oldSelect.props.onChange({target:{value:'65'}});oldService.props.onChange({target:{value:operation==='protocol'?'receipt':'protocol'}});await v.flush();assert.equal(s.calls.length,count);assert.equal(v.guard().busy,true);assert.equal(select(v).props.value,'55');assert.equal(service(v).props.value,operation);assert.equal(service(v).disabled,true);
  await v.click('Conferir resultado');assert.equal(s.counts.run,1);assert.equal(s.commands.size,1);assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);
  assert.equal(s.calls.find(c=>c.kind==='run').body.operation,operation);assert.equal(new Set(s.calls.filter(c=>c.kind==='command').map(c=>c.path)).size,1);
 }finally{v.unmount();}}
});
test('WSDL ACK followed by failed read retries only GET; mismatched immutable receipt stays blocked',async()=>{
 const s=fixture({before(c,s){if(c.kind==='command'&&s.counts.command===1)throw new AccessError(503);}}),v=await mount(s);try{
  await confirm(v);await v.click('Verificar conexão');assert.equal(v.guard().busy,true);const receipt=[...s.commands.values()][0];receipt.receipt.model='65';await v.click('Conferir resultado');assert.equal(v.guard().busy,true);receipt.receipt.model='55';await v.click('Conferir resultado');assert.equal(s.counts.run,1);assert.equal(v.guard().busy,false);
 }finally{v.unmount();}
});
test('WSDL 404 after unknown outcome never exposes a resend and preserves the original lookup',async()=>{
 const s=fixture({before(c){if(c.kind==='run')throw new AccessError(503);}}),v=await mount(s);try{
  await confirm(v);await v.click('Verificar conexão');await v.click('Conferir resultado');assert.equal(v.guard().busy,true);assert.match(v.text(),/não foi localizada/);assert.equal(v.nodes().some(n=>n.type==='button'&&/Reenviar/.test(String(n.props.children))),false);
  await v.click('Conferir resultado');assert.equal(s.counts.run,1);const ids=s.calls.filter(c=>c.kind==='command').map(c=>c.path);assert.equal(new Set(ids).size,1);
 }finally{v.unmount();}
});
test('known dispatched or uncertain outcome can be consulted without automatically repeating external access',async()=>{
 for(const status of ['dispatched','uncertain']){const s=fixture({status}),v=await mount(s);try{await confirm(v);await v.click('Verificar conexão');assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);await v.click('Consultar esta tentativa');assert.equal(s.counts.run,1);assert.equal(s.counts.command,2);assert.equal(v.guard().busy,false);}finally{v.unmount();}}
});
test('new verification requires fresh metadata and new confirmation; changing model clears confirmation',async()=>{
 const s=fixture(),v=await mount(s);try{await confirm(v);select(v).props.onChange({target:{value:'65'}});await v.flush();assert.equal(checkbox(v).props.checked,false);await confirm(v,'65');await v.click('Verificar conexão');await v.click('Preparar nova verificação');assert.equal(s.counts.run,1);assert.equal(s.counts.a1,2);assert.equal(s.counts.company,2);assert.equal(checkbox(v).props.checked,false);assert.equal(v.button('Verificar conexão').disabled,true);}finally{v.unmount();}
});
test('changing the service clears confirmation synchronously and stale confirmation cannot authorize the new choice',async()=>{
 const s=fixture(),v=await mount(s);try{
  select(v).props.onChange({target:{value:'55'}});await v.flush();assert.equal(checkbox(v).disabled,true);assert.equal(v.button('Verificar conexão').disabled,true);
  await confirm(v,'55','authorization');assert.match(v.text(),/acesso a Autorização de notas de NF-e de produtos/);
  const oldCheck=checkbox(v),oldRun=v.button('Verificar conexão');service(v).props.onChange({target:{value:'receipt'}});oldCheck.props.onChange({target:{checked:true}});oldRun.props.onClick();await v.flush();
  assert.equal(checkbox(v).props.checked,false);assert.equal(s.counts.run,undefined);assert.equal(v.button('Verificar conexão').disabled,true);
  checkbox(v).props.onChange({target:{checked:true}});await v.flush();assert.match(v.text(),/acesso a Consulta de recibo de NF-e de produtos/);
  await v.click('Verificar conexão');assert.equal(s.calls.find(c=>c.kind==='run').body.operation,'receipt');
  assert.match(v.text(),/Consulta de recibo · NF-e de produtos · Homologação/);
 }finally{v.unmount();}
});
test('operation handlers reject hidden services and malformed choices without changing confirmation',async()=>{
 const s=fixture(),v=await mount(s);try{await confirm(v,'65','protocol');for(const value of ['status','constructor','send',['authorization']])service(v).props.onChange({target:{value}});await v.flush();assert.equal(service(v).props.value,'protocol');assert.equal(checkbox(v).props.checked,true);assert.equal(s.counts.run,undefined);}finally{v.unmount();}
});
test('A1/company mismatch, expired certificate and same-actor role loss never permit a new run',async()=>{
 for(const kind of ['mismatch','expired','missing']){const s=fixture();if(kind==='mismatch')s.company.record.version=3;if(kind==='expired')s.a1.time_valid_now=false;if(kind==='missing')s.company.record=null;const v=await mount(s);try{select(v).props.onChange({target:{value:'55'}});await v.flush();assert.equal(checkbox(v).disabled,true);assert.equal(v.button('Verificar conexão').disabled,true);}finally{v.unmount();}}
 const s=fixture({after(c){if(c.kind==='run')throw new AccessError(503);}}),v=await mount(s);try{await confirm(v);await v.click('Verificar conexão');s.role='consulta';await v.updateProps({});assert.match(v.text(),/perfil não permite/);assert.equal(v.guard().busy,true);s.role='fiscal';await v.updateProps({});await v.click('Conferir resultado');assert.equal(s.counts.run,1);}finally{v.unmount();}
});
test('unmount aborts run, ignores late ACK and does not fetch command or restore across actor',async()=>{
 let release;const waiting=new Promise(r=>release=r),s=fixture({after(c){if(c.kind==='run')return waiting;}}),v=await mount(s);await confirm(v);v.button('Verificar conexão').props.onClick();await v.flush();const sent=s.calls.find(c=>c.kind==='run');v.unmount();release();await new Promise(r=>setTimeout(r,5));assert.equal(sent.signal.aborted,true);assert.equal(s.counts.command,undefined);
 const s2=fixture(),v2=await mount(s2);try{await confirm(v2);s2.actor='a0000000-0000-4000-8000-000000000098';await v2.updateProps({});assert.match(v2.text(),/perfil não permite/);assert.equal(s2.counts.run,undefined);}finally{v2.unmount();}
});

test('local import failure before the first request clears only unsent intent and requires a page update',async()=>{
 const {importBeforeDispatch,isAppImportFailure,APP_UPDATE_MESSAGE}=await import('../src/lib/import-failure.ts');
 let localError;try{await importBeforeDispatch(async()=>{throw new Error('synthetic missing module');});}catch(e){localError=e;}
 const s=fixture({before(c){if(c.kind==='run')throw localError;}});
 const v=await mountComponent('SefazConnection.tsx',{controller:s.controller},{ports:{isAppImportFailure,APP_UPDATE_MESSAGE},modules:{'../lib/import-failure':'export const isAppImportFailure=r.isAppImportFailure,APP_UPDATE_MESSAGE=r.APP_UPDATE_MESSAGE;'}});
 try{await confirm(v);const oldRun=v.button('Verificar conexão');await v.click('Verificar conexão');
  assert.equal(s.commands.size,0);assert.equal(s.counts.command,undefined);assert.equal(v.guard().busy,false);assert.equal(v.guard().changed,false);
  assert.match(v.text(),/Nenhuma verificação foi enviada/);assert.equal(v.button('Atualizar página').disabled,false);assert.equal(v.button('Verificar conexão').disabled,true);
  oldRun.props.onClick();await v.flush();assert.equal(s.counts.run,1);
 }finally{v.unmount();}
});
test('import failure during recovery preserves uncertain or acknowledged command and cannot offer a reload or new POST',async()=>{
 const {importBeforeDispatch,isAppImportFailure,APP_UPDATE_MESSAGE}=await import('../src/lib/import-failure.ts');
 let localError;try{await importBeforeDispatch(async()=>{throw new Error('synthetic missing module');});}catch(e){localError=e;}
 for(const ack of [false,true]){
  const s=fixture({after(c){if(c.kind==='run'&&!ack)throw new AccessError(503);},before(c,s){if(c.kind==='command'&&s.counts.command===1)throw localError;}});
  const v=await mountComponent('SefazConnection.tsx',{controller:s.controller},{ports:{isAppImportFailure,APP_UPDATE_MESSAGE},modules:{'../lib/import-failure':'export const isAppImportFailure=r.isAppImportFailure,APP_UPDATE_MESSAGE=r.APP_UPDATE_MESSAGE;'}});
  try{await confirm(v);await v.click('Verificar conexão');if(!ack)await v.click('Conferir resultado');
   assert.equal(v.guard().busy,true);assert.equal(s.commands.size,1);assert.match(v.text(),/tentativa anterior continua preservada/);
   assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Atualizar página'),false);
   await v.click('Conferir resultado');assert.equal(s.counts.run,1);assert.equal(v.guard().busy,false);
   assert.equal(new Set(s.calls.filter(c=>c.kind==='command').map(c=>c.path)).size,1);
  }finally{v.unmount();}
 }
});
