import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
const doc='10000000-0000-4000-8000-000000000001';
const file=new File(['ANEXO SINTETICO SEM DADOS REAIS'],'synthetic.txt',{type:'text/plain'});
const clone=value=>structuredClone(value);
function attachmentsServer({before=()=>{},after=()=>{}}={}){
 const rows=[],calls=[],commands=new Map(),counts={list:0,reserve:0,upload:0,abort:0};
 const controller={async attachments(path,options={}){
  const op=options.method==='PUT'?'upload':options.method==='POST'?path.endsWith('/abort')?'abort':'reserve':'list';
  const call={op,path,...options};calls.push(call);counts[op]++;await before(op,{rows,calls,counts,call});let value;
  if(op==='list')value={items:clone(rows),document_id:doc,data_mode:'erp_native'};
  else if(op==='reserve'){
   let row=commands.get(options.body.command_id);
   if(!row){row={id:crypto.randomUUID(),document_id:doc,...options.body,status:'reserved',created_at:'2026-10-16T12:00:00Z',finished_at:null};delete row.command_id;rows.push(row);commands.set(options.body.command_id,row);}
   value={attachment:clone(row),data_mode:'erp_native'};
  }else{
   const row=rows.find(row=>path.includes(row.id));assert.ok(row);
   row.status=op==='upload'?'ready':'aborted';row.finished_at='2026-10-16T12:01:00Z';value={attachment:clone(row),data_mode:'erp_native'};
  }
  await after(op,{rows,calls,counts,call});return value;
 }};return{controller,rows,calls,counts};
}
const mountAttachments=server=>mountComponent('DocumentAttachments.tsx',{controller:server.controller,kind:'sales_orders',documentId:doc,writable:true});
async function selectFile(view,selected=file){view.input(`attachment-file-${doc}`).props.onChange({target:{files:[selected]}});await view.flush();}
test('reservation committed with lost response freezes the file and retries the exact command once',async()=>{
 const server=attachmentsServer({after(op,{counts}){if(op==='reserve'&&counts.reserve===1)throw new AccessError(503);}}),view=await mountAttachments(server);
 try{await selectFile(view);await view.submit();assert.equal(view.input(`attachment-file-${doc}`).disabled,true);assert.equal(view.button('Limpar seleção').disabled,true);assert.equal(view.guard().busy,true);
  await selectFile(view,new File(['different'],'other.txt'));assert.match(view.text(),/synthetic.txt/);assert.doesNotMatch(view.text(),/other.txt/);
  await view.click('Confirmar a mesma operação');assert.equal(server.rows.length,1);assert.equal(server.rows[0].status,'ready');
  const reservations=server.calls.filter(c=>c.op==='reserve');assert.equal(reservations.length,2);assert.deepEqual(reservations[0].body,reservations[1].body);
  assert.equal(server.calls.find(c=>c.op==='upload').body,file);assert.equal(view.guard().busy,false);assert.match(view.text(),/estado atual foi consultado/);
 }finally{view.unmount();}
});
test('upload response loss retains the same attachment id and never reserves again',async()=>{
 const server=attachmentsServer({after(op,{counts}){if(op==='upload'&&counts.upload===1)throw new AccessError(503);}}),view=await mountAttachments(server);
 try{await selectFile(view);await view.submit();assert.equal(view.guard().busy,true);await view.click('Confirmar a mesma operação');
  assert.equal(server.counts.reserve,1);assert.equal(server.counts.upload,2);const uploads=server.calls.filter(c=>c.op==='upload');assert.equal(uploads[0].path,uploads[1].path);assert.equal(uploads[0].body,uploads[1].body);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('known upload followed by unavailable readback retries GET only',async()=>{
 const server=attachmentsServer({before(op,{counts}){if(op==='list'&&counts.list===2)throw new AccessError(503);}}),view=await mountAttachments(server);
 try{await selectFile(view);await view.submit();assert.equal(server.rows[0].status,'ready');assert.equal(view.guard().busy,true);
  await view.click('Consultar resultado atual');assert.equal(server.counts.reserve,1);assert.equal(server.counts.upload,1);assert.equal(server.counts.list,3);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('uncertain upload followed by a busy lease and reserved readback remains frozen',async()=>{
 const server=attachmentsServer({before(op,{counts}){if(op==='upload'&&counts.upload===1)throw new AccessError(503);if(op==='upload'&&counts.upload===2)throw new AccessError(409);}}),view=await mountAttachments(server);
 try{await selectFile(view);await view.submit();await view.click('Confirmar a mesma operação');
  assert.equal(server.rows[0].status,'reserved');assert.equal(view.button('Limpar seleção').disabled,true);assert.equal(view.guard().busy,true);assert.match(view.text(),/resultado ainda está pendente/);
  await view.click('Confirmar a mesma operação');assert.equal(server.counts.reserve,1);assert.equal(server.rows.length,1);assert.equal(server.rows[0].status,'ready');assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('confirmed reservation replay clears its uncertainty before a definitively rejected first upload',async()=>{
 const server=attachmentsServer({before(op){if(op==='upload')throw new AccessError(415);},after(op,{counts}){if(op==='reserve'&&counts.reserve===1)throw new AccessError(503);}}),view=await mountAttachments(server);
 try{await selectFile(view);await view.submit();await view.click('Confirmar a mesma operação');assert.equal(server.rows[0].status,'reserved');assert.equal(view.guard().busy,false);assert.equal(view.button('Limpar seleção').disabled,false);assert.equal(view.button('Cancelar reserva').disabled,false);
  await view.click('Cancelar reserva');assert.equal(server.rows[0].status,'aborted');assert.equal(server.rows.length,1);assert.equal(server.counts.reserve,2);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('cancellation reply loss retries the same reservation and reads terminal current state',async()=>{
 const server=attachmentsServer({after(op,{counts}){if(op==='abort'&&counts.abort===1)throw new AccessError(503);}});
 server.rows.push({id:crypto.randomUUID(),document_id:doc,filename:'reserved.txt',mime_type:'text/plain',size_bytes:1,sha256:'a'.repeat(64),status:'reserved',created_at:'2026-10-16T12:00:00Z',finished_at:null});
 const view=await mountAttachments(server);
 try{await view.click('Cancelar reserva');assert.equal(view.guard().busy,true);await view.click('Confirmar a mesma operação');assert.equal(server.counts.reserve,0);assert.equal(server.counts.upload,0);assert.equal(server.counts.abort,2);assert.equal(view.guard().busy,false);assert.match(view.text(),/Reserva cancelada/);
 }finally{view.unmount();}
});
test('unmount after an uncertain attachment result aborts pending work and releases parent flags',async()=>{
 let release,signal;const flags=[];
 const server=attachmentsServer({before(op,{call}){if(op==='reserve'){signal=call.signal;return new Promise(resolve=>{release=resolve;});}}});
 const view=await mountComponent('DocumentAttachments.tsx',{controller:server.controller,kind:'sales_orders',documentId:doc,writable:true,onBusy:busy=>flags.push(busy)});
 await selectFile(view);await view.submit();assert.equal(view.guard().busy,true);view.unmount();assert.equal(signal.aborted,true);assert.equal(flags.at(-1),false);release();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(server.counts.upload,0);
});
const companyData={legal_name:'EMPRESA FICTICIA',trade_name:null,cnpj:'12ABC34501DE35',ie:null,postal_code:'13400000',street:'RUA SINTETICA',number:'1',complement:null,district:'TESTE',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null};
function companyServer({before=()=>{},after=()=>{}}={}){
 const state={identity:{version:1,data:clone(companyData),created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z'},fiscal:{version:1,identity_version:1,crt:'3',confirmed:true,confirmed_at:'2026-10-16T12:00:00Z',reason:'CONFIRMACAO SINTETICA',updated_at:'2026-10-16T12:00:00Z'}},calls=[],commands=new Map();
 const controller={async company(path,options={}){
  const section=path.endsWith('/identidade')?'identity':path.endsWith('/fiscal')?'fiscal':'access';const call={section,path,...options};calls.push(call);await before(call,state);let value;
  if(section==='access')value={read_identity:true,write_identity:true,read_fiscal:true,write_fiscal:true,data_mode:'erp_native',emission_enabled:false};
  else if(options.method==='POST'){
   value=commands.get(options.body.command_id);
   if(!value){if(section==='identity'){state.identity={...state.identity,version:state.identity.version+1,data:clone(options.body.data)};state.fiscal={...state.fiscal,identity_version:state.identity.version};}
    else state.fiscal={...state.fiscal,...options.body,version:state.fiscal.version+1};
    value={section,record:clone(state[section]),data_mode:'erp_native',emission_enabled:false};commands.set(options.body.command_id,value);
   }else value={...value,replayed:true};
  }else value={section,record:clone(state[section]),data_mode:'erp_native',emission_enabled:false};
  await after(call,state);return clone(value);
 }};return{controller,state,calls,commands};
}
test('company lost response retries identical command but renders fresh state instead of historical replay',async()=>{
 let lost=true;const server=companyServer({after(call){if(call.method==='POST'&&lost){lost=false;throw new AccessError(503);}}}),view=await mountComponent('CompanySettings.tsx',{controller:server.controller});
 try{await view.click('Corrigir dados bloqueados');await view.change('company-legal_name','RASCUNHO SINTETICO');await view.change('company-locked-reason','Contrato social sintético');await view.submit();assert.equal(view.input('company-legal_name').disabled,true);assert.equal(view.button('Recarregar dados').disabled,true);assert.equal(view.guard().busy,true);
  server.state.identity={...server.state.identity,version:3,data:{...server.state.identity.data,legal_name:'DADO ATUAL SINTETICO'}};server.state.fiscal.identity_version=3;
  await view.click('Confirmar resultado da mesma operação');assert.equal(view.input('company-legal_name').props.value,'DADO ATUAL SINTETICO');assert.match(view.text(),/Versão 3/);
  const writes=server.calls.filter(c=>c.method==='POST');assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(server.commands.size,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('company committed identity and failed fiscal readback publish neither half of a mixed snapshot',async()=>{
 let failFiscal=false;const server=companyServer({before(call){if(call.section==='fiscal'&&!call.method&&failFiscal)throw new AccessError(503);},after(call){if(call.method==='POST')failFiscal=true;}}),view=await mountComponent('CompanySettings.tsx',{controller:server.controller});
 try{await view.click('Corrigir dados bloqueados');await view.change('company-legal_name','NOVO RASCUNHO');await view.change('company-locked-reason','Contrato social sintético');await view.submit();assert.match(view.text(),/Versão 1/);assert.doesNotMatch(view.text(),/Versão 2/);assert.match(view.text(),/Regime: consulta atual pendente/);assert.equal(view.input('company-crt').props.value,'');assert.equal(view.guard().busy,true);
  failFiscal=false;server.state.fiscal={...server.state.fiscal,version:2,crt:null,confirmed:false};await view.click('Consultar dados atuais');assert.match(view.text(),/Versão 2/);assert.equal(server.calls.filter(c=>c.method==='POST').length,1);assert.equal(view.input('company-legal_name').props.value,'NOVO RASCUNHO');assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('mismatching current identity and fiscal versions remain pending without resubmitting the write',async()=>{
 const server=companyServer({after(call,state){if(call.method==='POST')state.fiscal.identity_version=1;}}),view=await mountComponent('CompanySettings.tsx',{controller:server.controller});
 try{await view.click('Corrigir dados bloqueados');await view.change('company-legal_name','NOME SINTETICO');await view.change('company-locked-reason','Contrato social sintético');await view.submit();assert.equal(view.guard().busy,true);await view.click('Consultar dados atuais');assert.equal(view.guard().busy,true);assert.equal(server.calls.filter(c=>c.method==='POST').length,1);
  server.state.fiscal.identity_version=2;await view.click('Consultar dados atuais');assert.equal(view.guard().busy,false);assert.equal(view.input('company-street').disabled,false);
  // Nome, Nome Fantasia and CNPJ are locked again once the current data is read (Origin empresa.php).
  assert.equal(view.input('company-legal_name').disabled,true);
 }finally{view.unmount();}
});
test('a definitive rejected company write keeps the draft editable without pretending it committed',async()=>{
 const server=companyServer({before(call){if(call.method==='POST')throw new AccessError(409);}}),view=await mountComponent('CompanySettings.tsx',{controller:server.controller});
 try{await view.click('Corrigir dados bloqueados');await view.change('company-legal_name','RASCUNHO PRESERVADO');await view.change('company-locked-reason','Contrato social sintético');await view.submit();assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,true);assert.equal(view.input('company-legal_name').disabled,false);assert.equal(view.input('company-legal_name').props.value,'RASCUNHO PRESERVADO');assert.equal(server.commands.size,0);
 }finally{view.unmount();}
});
test('a rejected retry cannot erase an earlier uncertain company command',async()=>{
 let writes=0;const server=companyServer({before(call){if(call.method==='POST'&&++writes===2)throw new AccessError(403);},after(call){if(call.method==='POST'&&writes===1)throw new AccessError(503);}}),view=await mountComponent('CompanySettings.tsx',{controller:server.controller});
 try{await view.click('Corrigir dados bloqueados');await view.change('company-legal_name','ALTERACAO SINTETICA');await view.change('company-locked-reason','Contrato social sintético');await view.submit();await view.click('Confirmar resultado da mesma operação');assert.equal(view.guard().busy,true);assert.equal(view.input('company-legal_name').disabled,true);
  await view.click('Confirmar resultado da mesma operação');const calls=server.calls.filter(c=>c.method==='POST');assert.equal(calls.length,3);assert.deepEqual(calls[0].body,calls[1].body);assert.deepEqual(calls[0].body,calls[2].body);assert.equal(server.commands.size,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('leaving a pending company operation aborts its request and ignores a late response',async()=>{
 let release,signal;const server=companyServer({before(call){if(call.method==='POST'){signal=call.signal;return new Promise(resolve=>{release=resolve;});}}}),view=await mountComponent('CompanySettings.tsx',{controller:server.controller});
 await view.click('Corrigir dados bloqueados');await view.change('company-legal_name','RASCUNHO SINTETICO');await view.change('company-locked-reason','Contrato social sintético');await view.submit();assert.equal(view.guard().busy,true);const reads=server.calls.filter(c=>!c.method).length;
 view.unmount();assert.equal(signal.aborted,true);release();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(server.calls.filter(c=>!c.method).length,reads);
});
