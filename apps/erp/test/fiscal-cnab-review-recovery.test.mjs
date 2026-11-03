import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {reviewBasis,reviewIds} from '../../../packages/fiscal-core/test/review-fixtures.mjs';

// These services are in-memory command ledgers. Handlers and DTO validation are
// the production components; no browser, bank, Supabase or fiscal service runs.
const clone=structuredClone;
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):value==null||typeof value==='boolean'?'':String(value);
const field=(view,label)=>view.input(view.find(n=>n.type==='label'&&text(n)===label).props.htmlFor);
async function change(view,label,value){await view.change(field(view,label).props.id,value);}
async function check(view){const node=view.find(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(node.disabled,false);node.props.onChange({target:{checked:true}});await view.flush();}
const invoke=async(view,node)=>{node.props.onClick?.({preventDefault(){}});await view.flush();};
const writes=service=>service.calls.filter(call=>call.method!=='GET'&&!call.path.endsWith('/preview'));

function fiscalService({before=()=>{},after=()=>{}}={}){
 const state={draft:reviewBasis().draft},commands=new Map(),calls=[],counts={writes:0,gets:0,readbacks:0};
 const service={state,commands,calls,counts};
 service.controller={
  async documents(){const r=state.draft.record,s=r.snapshot;return{data_mode:'erp_native',kind:'sales_orders',items:[{id:s.document_id,kind:'sales_orders',number:s.number,version:s.document_version,status:s.status,date:s.date,total:s.totals.total,contact_id:s.contact_id,contact_name:s.contact.name,created_at:r.created_at,updated_at:r.updated_at}],limit:25,has_more:false,next_cursor:null};},
  async fiscalDraft(path,options={}){
   const call={path,method:options.method||'GET',body:clone(options.body),signal:options.signal};calls.push(call);
   if(call.method==='GET'){counts.gets++;if(commands.size)counts.readbacks++;await before(call,service);return clone(state.draft);}
   counts.writes++;await before(call,service);
   let response=commands.get(call.body.command_id);
   if(!response){const value=clone(state.draft),create=path==='/v1/rascunhos-fiscais';
    value.record.version=create?1:value.record.version+1;value.current.version=value.record.version;
    if(call.body.preparation)value.record.preparation=clone(call.body.preparation);
    if(path.endsWith('/archive')){value.record.status=value.current.status='archived';value.record.archived_at='2026-10-16T13:00:00Z';value.record.archive_reason=call.body.reason;value.pending.push('DRAFT_ARCHIVED');}
    value.record.updated_at='2026-10-16T13:00:00Z';state.draft=value;response=clone(value);commands.set(call.body.command_id,response);
   }
   await after(call,service);return clone(response);
  }
 };return service;
}
async function fiscalEditor(operation,service){
 const closed=[],saved=[],create=operation==='create';
 const view=await mountComponent('RealFiscalDrafts.tsx',{controller:service.controller,id:reviewIds.draft,initialModel:'55',onClose:()=>closed.push(true),onSaved:id=>saved.push(id)},
  {componentName:create?'CreateDraft':'DraftEditor',expandChildren:['TaskMessage','PreparationFields','OrderPicker']});
 const stale=[view.button('Voltar à listagem')];
 if(create){await view.click('Selecionar 1');await change(view,'Natureza da operação','Conferência sintética');await check(view);}
 else if(operation==='edit'){await change(view,'Observações de preparação','Preparação sintética');stale.push(view.button('Recarregar versão atual'),view.button('Descartar alterações'));}
 else{stale.push(view.button('Recarregar versão atual'));await view.click(operation==='archive'?'Arquivar rascunho':'Conferir atualização da cópia');
  if(operation==='archive')await change(view,'Motivo do arquivamento *','Arquivamento sintético');await check(view);stale.push(view.button('Voltar sem confirmar'));
 }
 const start=()=>operation==='edit'?view.submit():view.click(operation==='create'?'Criar rascunho confirmado':operation==='archive'?'Confirmar arquivamento':'Atualizar cópia confirmada');
 return{view,closed,saved,stale,start};
}

for(const operation of['create','edit','refresh','archive'])for(const status of[403,409])test(`fiscal ${operation}: lost response then ${status} keeps the command and all reset paths frozen`,async()=>{
 const service=fiscalService({after(call,s){if(s.counts.writes===1)throw new AccessError(503);},before(call,s){if(call.method!=='GET'&&s.counts.writes===2)throw new AccessError(status);}});
 const{view,closed,saved,stale,start}=await fiscalEditor(operation,service);
 try{
  await start();await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);assert.equal(view.button('Voltar à listagem').disabled,true);
  assert.equal(field(view,'Natureza da operação').disabled,true);
  if(operation==='archive')assert.equal(field(view,'Motivo do arquivamento *').disabled,true);
  if(operation!=='create')assert.equal(view.button('Recarregar versão atual').disabled,true);
  if(operation==='edit')assert.equal(view.button('Descartar alterações').disabled,true);
  if(['archive','refresh'].includes(operation))assert.equal(view.button('Voltar sem confirmar').disabled,true);
  // Even callbacks captured before the write must not clear or reload it.
  const reads=service.counts.gets;for(const node of stale)await invoke(view,node);
  assert.equal(service.counts.gets,reads);assert.equal(closed.length,0);assert.equal(saved.length,0);
  if(operation==='edit')await view.submit();assert.equal(service.counts.writes,2);
  await view.click('Repetir a mesma confirmação');assert.equal(service.counts.writes,3);assert.equal(service.commands.size,1);
  const calls=writes(service);for(const call of calls){assert.equal(call.path,calls[0].path);assert.equal(call.method,calls[0].method);assert.deepEqual(call.body,calls[0].body);}
  assert.equal(service.counts.readbacks,1);assert.equal(view.guard().busy,false);
  if(operation==='create')assert.deepEqual(saved,[reviewIds.draft]);else assert.match(view.text(),/Rascunho salvo/);
 }finally{view.unmount();}
});

test('fiscal confirmed replay plus failed GET retries only GET and displays the current revision',async()=>{
 const service=fiscalService({after(call,s){if(s.counts.writes===1)throw new AccessError(503);},before(call,s){if(call.method==='GET'&&s.counts.readbacks===1)throw new AccessError(503);}});
 const{view,start}=await fiscalEditor('edit',service);
 try{
  await start();await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);assert.equal(service.counts.writes,2);
  service.state.draft.record.version=service.state.draft.current.version=3;service.state.draft.record.preparation.notes='Revisão posterior de outro operador';
  await view.click('Consultar rascunho salvo');assert.equal(service.counts.writes,2);assert.equal(service.counts.readbacks,2);assert.equal(service.commands.size,1);
  assert.equal(field(view,'Observações de preparação').props.value,'Revisão posterior de outro operador');assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('fiscal stale readback cannot unlock a confirmed newer revision',async()=>{
 const service=fiscalService({before(call,s){if(call.method==='GET'&&s.counts.readbacks===1)s.state.draft.record.version=s.state.draft.current.version=1;}});
 const{view,start}=await fiscalEditor('edit',service);
 try{
  await start();assert.equal(view.guard().busy,true);assert.equal(view.button('Recarregar versão atual').disabled,true);
  service.state.draft.record.version=service.state.draft.current.version=2;await view.click('Consultar rascunho salvo');assert.equal(service.counts.writes,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('fiscal first-attempt409 can reload and create a fresh command only after a new review',async()=>{
 const service=fiscalService({before(call,s){if(call.method!=='GET'&&s.counts.writes===1)throw new AccessError(409);}}),{view,start}=await fiscalEditor('edit',service);
 try{
  await start();assert.equal(view.guard().busy,false);assert.equal(service.commands.size,0);
  await view.click('Recarregar versão atual');await change(view,'Observações de preparação','Nova conferência sintética');await view.submit();
  assert.equal(service.commands.size,1);assert.notEqual(writes(service)[0].body.command_id,writes(service)[1].body.command_id);assert.match(view.text(),/Rascunho salvo/);
 }finally{view.unmount();}
});

const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,eventId=uuid(1),fileId=uuid(2),hash='a'.repeat(64);
const safety={purpose:'homologation',productionReady:false,canSettle:false,financialMutationPerformed:false,originAuthenticated:false};
const humanFixture=()=>({...safety,event_id:eventId,context_hash:hash,review_version:0,review:null,bytes_verified:false,context:{version:1,
 event:{id:eventId,hash,bank:'341',wallet:'109',control:'000001',document_number:'NF001',our_number:'00000001',occurrence:'06',kind:'PAID',due_on:'2026-10-16',occurred_on:'2026-10-16',credited_on:'2026-10-16',amount_cents:'12345',paid_cents:'12345',adjustments:{fee:'0',iof:'0',abatement:'0',discount:'0',interest:'0',otherCredits:'0'},warnings:[]},
 occurrence:{file_id:fileId,file_hash:hash,line:2,line_hash:hash,duplicate:false,generated_on:'2026-10-16',declared_bank_origin:true,reference_id:'SYNTHETIC',warnings:[]},
 profile:{id:uuid(3),version:1,bank:'341',wallet:'109',account_id:uuid(4),account_name:'Conta fictícia',account_mask:'***123',account_version:1,account_active:true,contract_verified:true,policy_verified:true},
 billing:{id:uuid(5),remittance_id:uuid(6),remittance_state:'ready',control:'000001',document_number:'NF001',our_number:'00000001'},
 title:{id:uuid(7),version:1,kind:'receivable',description:'Título sintético',issued_on:'2026-10-15',due_on:'2026-10-16',amount_cents:'12345',settled_cents:'0',balance_cents:'12345',cancelled:false},
 proposal:{action:'PROPOSE_SETTLEMENT_REVIEW',reason:'EXACT_MATCH_REQUIRES_HUMAN_REVIEW'},comparison:{source_linked:true,reference_matches:true,bank_number_matches:true,amount_matches:true,due_matches:true,fully_open:true,paid_matches_balance:true,has_adjustments:false,reason:'EXACT_MATCH_HOMOLOGATION_ONLY'},
}});
function humanService({before=()=>{},after=()=>{}}={}){
 const state={detail:humanFixture()},commands=new Map(),calls=[],counts={writes:0,gets:0,readbacks:0,previews:0};
 const service={state,commands,calls,counts};
 service.controller={async cnabReview(path,options={}){
  const call={path,method:options.method||'GET',body:clone(options.body),signal:options.signal};calls.push(call);
  if(path.endsWith('/preview')){counts.previews++;await before(call,service);return{...clone(state.detail),bytes_verified:true};}
  if(call.method==='GET'){counts.gets++;if(commands.size)counts.readbacks++;await before(call,service);return clone(state.detail);}
  counts.writes++;await before(call,service);let result=commands.get(call.body.command_id);
  if(!result){const record={event_id:eventId,version:call.body.expected_review_version+1,status:call.body.status,reason:call.body.reason,context_hash:call.body.expected_context_hash,context:clone(state.detail.context),reviewed_at:'2026-10-16T13:00:00Z'};
   state.detail.review_version=record.version;state.detail.review={...clone(record),context_changed:false};result={...safety,event_id:eventId,record,replayed:false};commands.set(call.body.command_id,result);
  }await after(call,service);return clone(result);
 }};return service;
}
async function humanEditor(service){
 const closed=[],row={line:2,event_id:eventId,event_hash:hash,duplicate:false,kind:'PAID',control:'000001',document_number:'NF001',amount_cents:'12345',paid_cents:'12345',review_version:0,review_status:'pending',context_changed:false};
 const view=await mountComponent('RealCnabReview.tsx',{controller:service.controller,row,fileId,canWrite:true,onBack:()=>closed.push(true)},{componentName:'EventEditor'});
 const stale=[view.button('Voltar aos eventos'),view.button('Conferir arquivo original')];
 await view.click('Conferir arquivo original');await change(view,'Situação da conferência','confirmed');await change(view,'Motivo da conferência','Conferência sintética, sem baixa.');await check(view);
 stale.push(view.button('Registrar conferência'));return{view,closed,stale};
}
for(const status of[403,409])test(`human return review: lost response then ${status} preserves exact decision and disables exit/reverification`,async()=>{
 const service=humanService({after(call,s){if(s.counts.writes===1)throw new AccessError(503);},before(call,s){if(call.path.endsWith('/review')&&s.counts.writes===2)throw new AccessError(status);}});
 const{view,closed,stale}=await humanEditor(service);
 try{
  await view.click('Registrar conferência');await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);
  for(const name of['Voltar aos eventos','Conferir arquivo novamente','Registrar conferência','Consultar histórico de conferências'])assert.equal(view.button(name).disabled,true);
  assert.equal(field(view,'Motivo da conferência').disabled,true);assert.equal(field(view,'Situação da conferência').disabled,true);
  assert.equal(view.nodes().some(n=>n.type==='button'&&text(n)==='Atualizar contexto'),false);
  for(const node of stale)await invoke(view,node);assert.equal(service.counts.previews,1);assert.equal(service.counts.writes,2);assert.equal(closed.length,0);
  await view.click('Repetir a mesma confirmação');const calls=writes(service);assert.equal(calls.length,3);assert.equal(service.commands.size,1);
  for(const call of calls)assert.deepEqual(call.body,calls[0].body);assert.equal(view.guard().busy,false);assert.match(view.text(),/Conferência registrada/);
 }finally{view.unmount();}
});

test('human review confirmed replay plus failed GET repeats only GET and uses the current revision',async()=>{
 const service=humanService({after(call,s){if(s.counts.writes===1)throw new AccessError(503);},before(call,s){if(call.method==='GET'&&s.counts.readbacks===1)throw new AccessError(503);}}),{view}=await humanEditor(service);
 try{
  await view.click('Registrar conferência');await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);
  service.state.detail.review_version=service.state.detail.review.version=2;service.state.detail.review.reason='Revisão posterior de outro operador';
  await view.click('Consultar revisão registrada');assert.equal(service.counts.writes,2);assert.equal(service.counts.readbacks,2);assert.equal(service.commands.size,1);
  assert.match(view.text(),/Revisão posterior de outro operador/);assert.equal(view.guard().busy,false);assert.equal(service.state.detail.context.title.settled_cents,'0');
 }finally{view.unmount();}
});

test('human review stale GET stays guarded until the confirmed review is visible',async()=>{
 const service=humanService({before(call,s){if(call.method==='GET'&&s.counts.readbacks===1)s.state.detail=humanFixture();}}),{view}=await humanEditor(service);
 try{
  await view.click('Registrar conferência');assert.equal(view.guard().busy,true);
  service.state.detail.review_version=1;service.state.detail.review={...clone([...service.commands.values()][0].record),context_changed:false};
  await view.click('Consultar revisão registrada');assert.equal(service.counts.writes,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});

test('human review first-attempt409 permits reloading and a new explicit byte review',async()=>{
 const service=humanService({before(call,s){if(call.path.endsWith('/review')&&s.counts.writes===1)throw new AccessError(409);}}),{view}=await humanEditor(service);
 try{
  await view.click('Registrar conferência');assert.equal(view.guard().busy,false);assert.equal(service.commands.size,0);
  await view.click('Atualizar contexto');await view.click('Conferir arquivo original');await check(view);await view.click('Registrar conferência');
  assert.equal(service.commands.size,1);assert.notEqual(writes(service)[0].body.command_id,writes(service)[1].body.command_id);assert.match(view.text(),/Conferência registrada/);
 }finally{view.unmount();}
});

for(const kind of['fiscal','human'])test(`${kind} pending write aborts on unmount and ignores a late reply`,async()=>{
 let release,signal;const before=(call)=>{if(call.method!=='GET'&&!call.path.endsWith('/preview')){signal=call.signal;return new Promise(resolve=>{release=resolve;});}};
 const service=kind==='fiscal'?fiscalService({before}):humanService({before}),mounted=kind==='fiscal'?await fiscalEditor('create',service):await humanEditor(service),{view}=mounted;
 if(kind==='fiscal')await mounted.start();else await view.click('Registrar conferência');assert.equal(view.guard().busy,true);view.unmount();assert.equal(signal.aborted,true);
 release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(service.counts.readbacks,0);assert.deepEqual(mounted.saved||mounted.closed,[]);
});
