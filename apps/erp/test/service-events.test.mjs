import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {emptyEventForm,eventFormData,serviceEventPage,serviceEventEnvelope,serviceEventAttachments,serviceEventsPath,sameServiceEvent,correctionForm} from '../src/lib/service-events-model.ts';

const documentId='10000000-0000-4000-8000-000000000001',otherId='10000000-0000-4000-8000-000000000002',actorId='20000000-0000-4000-8000-000000000001',contactId='30000000-0000-4000-8000-000000000001',attachmentId='40000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64),copy=v=>structuredClone(v);
const FLAGS={scope:'service_order_events',data_mode:'erp_native',signature_verified:false,consent_verified:false,changes_document_status:false,financial_mutation_performed:false,stock_mutation_performed:false};
const attachment={id:attachmentId,document_id:documentId,filename:'anexo-QA-evidence.pdf',mime_type:'application/pdf',size_bytes:200,sha256:'b'.repeat(64),status:'ready',created_at:'2026-10-16T12:00:00Z',finished_at:'2026-10-16T12:00:01Z'};
const base=(state={},id=documentId)=>{const status=state.status??'quoted',canRecord=(state.role??'admin')==='admin'||state.role==='vendas';return{...FLAGS,document:{id,kind:'service_orders',number:'10',version:state.version??3,status,total:state.total??'999999999999.99',commercial_hash:state.hash??hash},can_record:canRecord&&status!=='cancelled',allowed_event_types:!canRecord||status==='cancelled'?[]:['reception',...(['quoted','approved','rejected'].includes(status)?['customer_decision']:[]),...(['service_done','finalized','no_repair'].includes(status)?['delivery']:[])]};};
const defaultData=()=>({type:'reception',occurred_on:'2026-01-15',declarant_name:'Pessoa fictícia',declarant_role:'customer',details:{accessories:null,apparent_condition:'Condição relatada sintética'},notes:null,attachment_id:null,corrects_event_id:null,correction_reason:null,confirm_record:true});
const record=(n,{id=documentId,state={},data=defaultData()}={})=>({id:crypto.randomUUID(),document_id:id,sequence:String(n),type:data.type,document_version:state.version??3,document_status:state.status??'quoted',commercial_hash:state.hash??hash,total:state.total??'999999999999.99',snapshot:{number:'10',contact:{id:contactId,name:'Cliente fictício'},equipment:'Equipamento de teste',serial_number:null,technician:null},occurred_on:data.occurred_on,declarant_name:data.declarant_name,declarant_role:data.declarant_role,details:copy(data.details),notes:data.notes,attachment:data.attachment_id?(({id,filename,mime_type,size_bytes,sha256})=>({id,filename,mime_type,size_bytes,sha256}))(attachment):null,corrects_event_id:data.corrects_event_id,correction_reason:data.correction_reason,actor_id:actorId,recorded_at:'2026-10-16T13:00:00.123456+00:00'});
function row(r,state={}){const ctx=base(state,r.document_id),entries=state.entries??[r],latest=entries.filter(e=>e.document_id===r.document_id&&e.type==='customer_decision').at(-1),corrected=entries.find(e=>e.corrects_event_id===r.id)?.id??null;return{record:copy(r),current:{document_version:ctx.document.version,document_status:ctx.document.status,document_version_changed:r.document_version!==ctx.document.version,commercial_content_changed:r.commercial_hash!==ctx.document.commercial_hash,total_changed:r.total!==ctx.document.total,corrected_by_event_id:corrected,approval_basis_matches_current:r.type==='customer_decision'&&r.details.decision==='approved'&&latest?.id===r.id&&!corrected&&r.document_version===ctx.document.version&&r.commercial_hash===ctx.document.commercial_hash&&r.total===ctx.document.total&&ctx.document.status!=='cancelled'}};}
function server({count=0,before=()=>{},after=()=>{},role='admin',status='quoted'}={}){
 const calls=[],commands=new Map(),state={version:3,status,role,total:'999999999999.99',hash,phase:'ready',entries:Array.from({length:count},(_,i)=>record(i+1)),attachments:[copy(attachment)],counts:{append:0,get:0,list:0,attachments:0}};
 const controller={getSnapshot:()=>({phase:state.phase,membership:state.phase==='ready'?{user_id:actorId,role:state.role,resources:[],data_mode:'staging_readonly'}:null}),
 async serviceEvents(path,options={}){const url=new URL(path,'https://synthetic.invalid'),parts=url.pathname.split('/'),id=parts[3],eventId=parts[5],operation=options.method==='POST'?'append':eventId?'get':'list',call={path,operation,documentId:id,...options};calls.push(call);state.counts[operation]++;await before(call,state);let result;
  if(operation==='append'){
   const prior=commands.get(options.body.command_id);let saved;
   if(prior){assert.deepEqual(prior.body,options.body);saved=prior.record;}
   else{if(options.body.expected_document_version!==state.version)throw new AccessError(409);const data=options.body.data;if(data.corrects_event_id&&state.entries.some(e=>e.corrects_event_id===data.corrects_event_id))throw new AccessError(409);
    saved=record(state.entries.filter(e=>e.document_id===id).length+1,{id,state,data});state.entries.push(saved);commands.set(options.body.command_id,{body:copy(options.body),record:copy(saved)});}
   result={...base(state,id),...row(saved,state),replayed:Boolean(prior)};
  }else if(operation==='get'){const saved=state.entries.find(e=>e.id===eventId&&e.document_id===id);if(!saved)throw new AccessError(404);result={...base(state,id),read_only:true,...row(saved,state)};}
  else{const limit=Number(url.searchParams.get('limit')),cursor=url.searchParams.get('before'),all=state.entries.filter(e=>e.document_id===id&&(!cursor||BigInt(e.sequence)<BigInt(cursor))).sort((a,b)=>BigInt(a.sequence)>BigInt(b.sequence)?-1:1),items=all.slice(0,limit).map(r=>row(r,state));result={...base(state,id),read_only:true,items,limit,has_more:all.length>limit,next_before:all.length>limit?items.at(-1).record.sequence:null};}
  await after(call,state,result);return copy(result);
 },async attachments(path,options={}){const call={path,...options,operation:'attachments',documentId:path.split('/')[4]};calls.push(call);state.counts.attachments++;await before(call,state);const result={data_mode:'erp_native',document_id:call.documentId,items:state.attachments.filter(a=>a.document_id===call.documentId)};await after(call,state,result);return copy(result);}};
 return{controller,state,calls,commands};
}
const mount=(s,props={})=>mountComponent('ServiceOrderEvents.tsx',{controller:s.controller,document:{id:documentId,version:3},...props});
async function fill(view,{type='reception',attach='none'}={}){
 await view.change('service-event-type',type);await view.change('service-event-occurred_on','2026-01-15');await view.change('service-event-declarant_name','Pessoa fictícia');await view.change('service-event-declarant_role','customer');
 if(type==='reception')await view.change('service-event-apparent_condition','Condição relatada sintética');
 if(type==='customer_decision'){await view.change('service-event-decision','approved');await view.change('service-event-channel','message');}
 if(type==='delivery')await view.change('service-event-delivered_condition','Equipamento entregue conforme relato');
 await view.change('service-event-attachment_choice',attach);await view.change('service-event-confirmed',true);
}

test('049 form requires explicit type/date/person/decision/attachment choice and an unchecked confirmation; Unicode uses codepoints',()=>{
 const empty=emptyEventForm();assert.equal(empty.confirmed,false);const invalid=eventFormData(empty,null,[],'2026-10-16');assert.ok(invalid.errors.type);assert.ok(invalid.errors.attachment_choice);assert.ok(invalid.errors.confirmed);assert.equal(invalid.data,null);
 const form={...empty,type:'reception',occurred_on:'2026-10-16',declarant_name:'\u00a0Pessoa fictícia\u200b',declarant_role:'customer',apparent_condition:'😀'.repeat(1000),attachment_choice:'none',confirmed:true};
 const parsed=eventFormData(form,null,[],'2026-10-16');assert.equal(parsed.data.declarant_name,'Pessoa fictícia');assert.equal(parsed.data.details.accessories,null);assert.equal(parsed.data.attachment_id,null);
 for(const patch of [{occurred_on:'2026-02-30'},{occurred_on:'2026-10-17'},{declarant_name:'\u200b\ufeff'},{apparent_condition:'<script>'},{apparent_condition:'😀'.repeat(1001)},{attachment_choice:attachmentId},{confirmed:false}])assert.equal(eventFormData({...form,...patch},null,[],'2026-10-16').data,null);
 const decision={...form,type:'customer_decision',decision:'',channel:''};assert.ok(eventFormData(decision,null,[],'2026-10-16').errors.decision);assert.ok(eventFormData(decision,null,[],'2026-10-16').errors.channel);
 const correction=record(1);assert.equal(eventFormData({...form,correction_reason:' x '},correction,[],'2026-10-16').data,null);assert.equal(correctionForm(correction,[]).confirmed,false);
});
test('049 DTO binds current versus historical fields and rejects forged effects, wrong actor, wrong receipt, dates and cursor',()=>{
 const r=record(2),r1=record(1),page={...base(),read_only:true,items:[row(r),row(r1)],limit:2,has_more:true,next_before:'1'};
 assert.equal(serviceEventPage(page,documentId,null,2).items[0].record.total,'999999999999.99');
 for(const change of [v=>v.items.reverse(),v=>v.items[0].record.document_id=otherId,v=>v.items[0].record.total=999999999999.99,v=>v.items[0].current.total_changed=true,v=>v.items[0].record.recorded_at='2026-02-30T13:00:00Z',v=>v.items[0].current.approval_basis_matches_current=true,v=>v.consent_verified=true,v=>v.next_before='2',v=>v.allowed_event_types.push('delivery')]){const bad=copy(page);change(bad);assert.throws(()=>serviceEventPage(bad,documentId,null,2));}
 const command={command_id:crypto.randomUUID(),expected_document_version:3,data:defaultData()},envelope={...base(),...row(r),replayed:false};assert.equal(serviceEventEnvelope(envelope,documentId,{command,actorId}).record.id,r.id);
 assert.throws(()=>serviceEventEnvelope(envelope,documentId,{command,actorId:contactId}));assert.throws(()=>serviceEventEnvelope(envelope,documentId,{command:{...command,data:{...command.data,notes:'Diferente'}},actorId}));
 const historic={...base({version:4,status:'cancelled',total:'25.70'}),...row(r,{version:4,status:'cancelled',total:'25.70'}),replayed:true};assert.equal(serviceEventEnvelope(historic,documentId,{command,actorId}).record.total,r.total);assert.equal(serviceEventEnvelope(historic,documentId,{command,actorId}).can_record,false);
 assert.equal(sameServiceEvent(r,{...r,total:'25.70'}),false);assert.throws(()=>serviceEventsPath('../secret'));
 const projected=serviceEventPage({...page,private_path:'secret'},documentId,null,2);assert.equal('private_path'in projected,false);
});
test('049 attachment projection accepts only available same-OS files and exposes no Storage path',()=>{
 const response={data_mode:'erp_native',document_id:documentId,items:[{...attachment,object_key:'not-exposed'}, {...attachment,id:crypto.randomUUID(),status:'reserved'}]};
 const rows=serviceEventAttachments(response,documentId);assert.equal(rows.length,1);assert.equal('object_key'in rows[0],false);
 for(const patch of [{document_id:otherId},{filename:'../../secret.pdf'},{mime_type:'application/octet-stream'},{size_bytes:10485761},{sha256:'x'}])assert.throws(()=>serviceEventAttachments({...response,items:[{...attachment,...patch}]},documentId));
});
test('049 records each type without changing the OS or inferring operational effects; confirmation is always explicit',async()=>{
 for(const type of ['reception','customer_decision','delivery']){let changed=0;const s=server({status:type==='delivery'?'service_done':'quoted'}),view=await mount(s,{onChanged:()=>changed++});
  try{assert.equal(view.input('service-event-confirmed').props.checked,false);assert.equal(view.input('service-event-attachment_choice').props.value,'');await fill(view,{type,attach:type==='reception'?attachmentId:'none'});await view.submit();assert.equal(s.commands.size,1);assert.equal(s.state.version,3);assert.equal(s.state.total,'999999999999.99');assert.equal(changed,1);assert.equal(view.guard().changed,false);assert.equal(view.guard().busy,false);assert.match(view.text(),/Registro 1 confirmado/);assert.match(view.text(),/999\.999\.999\.999,99/);assert.equal(s.calls.filter(c=>c.operation==='append')[0].body.data.type,type);if(type==='reception')assert.match(view.text(),/Anexo registrado/);}
  finally{view.unmount();}
 }
});
test('049 in-flight confirmation shows progress, exposes recovery only after failure and preserves the same command',async()=>{
 const gate=Promise.withResolvers(),s=server({before:call=>call.operation==='append'?gate.promise:undefined,after(call,state){if(call.operation==='append'&&state.counts.append===1)throw new AccessError(503);}}),view=await mount(s);
 try{await fill(view);await view.submit();assert.match(view.text(),/Conferindo o registro\. Aguarde/);assert.doesNotMatch(view.text(),/A recuperação repetirá|Repetir a mesma confirmação/);assert.equal(view.guard().busy,true);assert.equal(view.input('service-event-declarant_name').disabled,true);assert.equal(s.state.counts.append,1);
  gate.resolve();await view.flush();assert.match(view.text(),/Repetir a mesma confirmação/);assert.equal(view.guard().busy,true);await view.click('Repetir a mesma confirmação');assert.equal(s.commands.size,1);assert.deepEqual(s.calls.filter(c=>c.operation==='append').map(c=>c.body)[0],s.calls.filter(c=>c.operation==='append').map(c=>c.body)[1]);assert.equal(view.guard().busy,false);
 }finally{gate.resolve();view.unmount();}
});
test('049 lost POST then403/409 freezes original command/body and stale handlers cannot clear or replace it',async()=>{
 const s=server({before(call,state){if(call.operation==='append'&&[2,3].includes(state.counts.append))throw new AccessError(state.counts.append===2?403:409);},after(call,state){if(call.operation==='append'&&state.counts.append===1)throw new AccessError(503);}}),flags=[],view=await mount(s,{onBusy:value=>flags.push(value)});
 try{await fill(view);const oldClear=view.button('Limpar formulário').props.onClick,oldChange=view.input('service-event-declarant_name').props.onChange,oldRefresh=view.button('Atualizar eventos').props.onClick,oldAttachments=view.button('Atualizar anexos disponíveis').props.onClick;
  await view.submit();assert.equal(view.guard().busy,true);assert.equal(view.input('service-event-declarant_name').disabled,true);oldClear();oldChange({target:{value:'Outra pessoa'}});oldRefresh();oldAttachments();await view.flush();assert.equal(view.input('service-event-declarant_name').props.value,'Pessoa fictícia');
  await view.click('Repetir a mesma confirmação');await view.click('Repetir a mesma confirmação');assert.equal(view.guard().busy,true);await view.click('Repetir a mesma confirmação');
  assert.equal(s.commands.size,1);assert.equal(s.state.entries.length,1);const writes=s.calls.filter(c=>c.operation==='append');assert.equal(writes.length,4);for(const call of writes)assert.deepEqual(call.body,writes[0].body);assert.equal(flags.at(-1),false);assert.equal(view.guard().changed,false);
 }finally{view.unmount();}
});
test('049 ACK followed by GET or list failure retries only reads, and a mismatched immutable receipt never releases the form',async()=>{
 const s=server({before(call,state){if(call.operation==='get'&&state.counts.get===1)throw new AccessError(503);},after(call,state,result){if(call.operation==='get'&&state.counts.get===2)result.record.notes='Conteúdo adulterado';if(call.operation==='list'&&state.counts.list===2)throw new AccessError(503);}}),view=await mount(s);
 try{await fill(view);await view.submit();assert.match(view.text(),/Consultar registro confirmado/);assert.equal(view.guard().busy,true);await view.click('Consultar registro confirmado');assert.equal(view.guard().busy,true);await view.click('Consultar registro confirmado');assert.equal(view.guard().busy,true);await view.click('Consultar registro confirmado');assert.equal(view.guard().busy,false);assert.equal(s.state.counts.append,1);assert.equal(s.state.counts.get,4);assert.equal(s.commands.size,1);}
 finally{view.unmount();}
});
test('049 correction is a new confirmed receipt with a reason, preserves the original and disables another branch',async()=>{
 const s=server({count:1}),view=await mount(s);
 try{const original=copy(s.state.entries[0]);await view.click('Preparar correção do registro 1');assert.equal(view.input('service-event-confirmed').props.checked,false);assert.equal(view.input('service-event-type').disabled,true);assert.equal(view.input('service-event-correction_reason').props.value,'');
  await view.submit();assert.equal(s.commands.size,0);assert.equal(view.input('service-event-correction_reason').props['aria-invalid'],true);await view.change('service-event-correction_reason','Complemento conferido');await view.change('service-event-apparent_condition','Condição corrigida');await view.change('service-event-confirmed',true);await view.submit();
  assert.equal(s.commands.size,1);assert.deepEqual(s.state.entries[0],original);assert.equal(s.state.entries[1].corrects_event_id,original.id);assert.equal(s.state.entries[1].correction_reason,'Complemento conferido');assert.match(view.text(),/correção posterior/);assert.equal(view.nodes().filter(n=>n.type==='button'&&n.props.children==='Preparar correção do registro 1').length,0);assert.equal(view.button('Preparar correção do registro 2').disabled,false);
 }finally{view.unmount();}
});
test('049 known CAS conflict retains draft but requires current OS and a fresh confirmation before a new command',async()=>{
 const s=server({before(call,state){if(call.operation==='append'&&state.counts.append===1)state.version++;}}),view=await mount(s);
 try{await fill(view);await view.submit();assert.equal(s.commands.size,0);assert.equal(view.guard().busy,false);assert.equal(view.guard().changed,true);assert.equal(view.input('service-event-confirmed').props.checked,false);assert.equal(view.button('Registrar declaração').disabled,true);assert.match(view.text(),/desatualizada/);
  await view.updateProps({document:{id:documentId,version:4}});assert.equal(view.input('service-event-declarant_name').props.value,'Pessoa fictícia');await view.change('service-event-confirmed',true);await view.submit();assert.equal(s.commands.size,1);assert.equal(s.calls.filter(c=>c.operation==='append').at(-1).body.expected_document_version,4);
 }finally{view.unmount();}
});
test('049 unavailable attachments do not block an explicit no-attachment declaration; no upload/download is invoked',async()=>{
 const s=server({before(call){if(call.operation==='attachments')throw new AccessError(503);}}),view=await mount(s);
 try{assert.match(view.text(),/Não foi possível consultar os anexos/);await fill(view);await view.submit();assert.equal(s.commands.size,1);assert.equal(s.state.entries[0].attachment,null);for(const call of s.calls.filter(c=>c.operation==='attachments')){assert.equal(call.method,undefined);assert.equal(call.path,`/v1/documentos/service_orders/${documentId}/anexos`);}}
 finally{view.unmount();}
});
test('049 paging retains local draft, while read-only/cancelled/stale permissions cannot append',async()=>{
 const s=server({count:30}),view=await mount(s);
 try{assert.match(view.text(),/registro 30/);await fill(view);await view.click('Mais antigos');assert.match(view.text(),/registro 5/);assert.equal(view.guard().changed,true);await view.click('Atualizar eventos');assert.match(view.text(),/registro 30/);assert.equal(view.input('service-event-declarant_name').props.value,'Pessoa fictícia');
  const oldSubmit=view.nodes().find(n=>n.type==='form').props.onSubmit;s.state.role='consulta';oldSubmit({preventDefault(){}});await view.updateProps({});assert.equal(s.commands.size,0);assert.equal(view.nodes().filter(n=>n.type==='form').length,0);
 }finally{view.unmount();}
 const cancelled=await mount(server({status:'cancelled'}));try{assert.equal(cancelled.button('Registrar declaração').disabled,true);assert.match(cancelled.text(),/OS cancelada/);}finally{cancelled.unmount();}
 const readOnly=await mount(server({role:'financeiro'}));try{assert.equal(readOnly.nodes().filter(n=>n.type==='form').length,0);}finally{readOnly.unmount();}
});
test('049 late responses after document switch or logout cannot render another OS or trigger readback; unmount aborts mutation',async()=>{
 let release,signal;const s=server({before(call,state){if(call.operation==='list'&&state.counts.list===1)return new Promise(resolve=>{release=resolve;signal=call.signal;});}}),view=await mount(s);
 await view.updateProps({document:{id:otherId,version:3}});assert.equal(signal.aborted,true);release();await view.flush();await fill(view);await view.submit();assert.equal(s.calls.find(c=>c.operation==='append').documentId,otherId);view.unmount();
 let finish,postSignal;const t=server({before(call){if(call.operation==='append')return new Promise(resolve=>{finish=resolve;postSignal=call.signal;});}}),flags=[],pending=await mount(t,{onBusy:v=>flags.push(v)});await fill(pending);await pending.submit();pending.unmount();assert.equal(postSignal.aborted,true);assert.equal(flags.at(-1),false);finish();await new Promise(r=>setTimeout(r,10));assert.equal(t.state.counts.get,0);
 let finishLogout;const u=server({before(call){if(call.operation==='append')return new Promise(resolve=>{finishLogout=resolve;});}}),logout=await mount(u);await fill(logout);await logout.submit();u.state.phase='signed_out';await logout.updateProps({});finishLogout();await logout.flush();assert.match(logout.text(),/acesso.*não está disponível/);assert.equal(u.state.counts.get,0);logout.unmount();
});
test('049 initial list failure and blocked parent prevent submission; field errors remain accessible',async()=>{
 const s=server({before(call,state){if(call.operation==='list'&&state.counts.list===1)throw new AccessError(503);}}),view=await mount(s);
 try{assert.equal(view.button('Registrar declaração').disabled,true);await view.click('Atualizar eventos');await view.change('service-event-type','reception');await view.submit();assert.equal(view.input('service-event-declarant_name').props['aria-invalid'],true);assert.equal(view.input('service-event-declarant_name').props['aria-describedby'],'service-event-declarant_name-error');await fill(view);const old=view.nodes().find(n=>n.type==='form').props.onSubmit;await view.updateProps({blocked:true});old({preventDefault(){}});await view.flush();assert.equal(s.commands.size,0);assert.equal(view.button('Registrar declaração').disabled,true);}
 finally{view.unmount();}
});
test('049 changing the document aborts and detaches the old request; authorized new context remains editable',async()=>{
 let release,signal;const s=server({before(call,state){if(call.operation==='append'&&state.counts.append===1)return new Promise(resolve=>{release=resolve;signal=call.signal;});}}),view=await mount(s);
 try{await fill(view);await view.submit();await view.updateProps({document:{id:otherId,version:3}});assert.equal(signal.aborted,true);assert.equal(view.guard().busy,false);release();await view.flush();assert.equal(s.state.counts.get,0);
  await fill(view);await view.submit();assert.equal(s.calls.filter(c=>c.operation==='append').at(-1).documentId,otherId);assert.match(view.text(),/Registro 1 confirmado/);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
test('049 same actor changing roles preserves a pending or uncertain command until exact recovery',async()=>{
 let release;const s=server({before(call,state){if(call.operation==='append'&&state.counts.append===1)return new Promise(resolve=>{release=resolve;});},after(call,state){if(call.operation==='append'&&state.counts.append===1)throw new AccessError(503);}}),view=await mount(s);
 try{await fill(view);await view.submit();const first=s.calls.find(c=>c.operation==='append'),oldSubmit=view.nodes().find(n=>n.type==='form').props.onSubmit;s.state.role='vendas';await view.updateProps({});assert.equal(first.signal.aborted,false);assert.equal(view.guard().busy,true);assert.equal(view.input('service-event-declarant_name').disabled,true);
  release();await view.flush();assert.equal(view.guard().busy,true);s.state.role='consulta';await view.updateProps({});assert.equal(view.button('Repetir a mesma confirmação').disabled,true);oldSubmit({preventDefault(){}});await view.flush();assert.equal(s.state.counts.append,1);
  s.state.role='vendas';await view.updateProps({});assert.equal(view.guard().busy,true);await view.click('Repetir a mesma confirmação');assert.equal(s.state.counts.append,2);assert.deepEqual(s.calls.filter(c=>c.operation==='append')[1].body,first.body);assert.equal(s.commands.size,1);assert.equal(view.guard().busy,false);
 }finally{view.unmount();}
});
