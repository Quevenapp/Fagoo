import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
const id='10000000-0000-4000-8000-000000000001',contact='20000000-0000-4000-8000-000000000001',actor='30000000-0000-4000-8000-000000000001',hash='a'.repeat(64),copy=structuredClone;
const flags={scope:'service_order_events',data_mode:'erp_native',signature_verified:false,consent_verified:false,changes_document_status:false,financial_mutation_performed:false,stock_mutation_performed:false};
const child=(v,name)=>v.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
function service({role='admin',status='quoted',before=()=>{},after=()=>{}}={}){
 const doc={...normalizeDocument('service_orders',{date:'2026-10-16',contact_id:contact,items:[{description:'Item sintético',unit:'UN',quantity:'1',unit_price:'25.70'}]}),id,kind:'service_orders',number:'1',version:3,status,contact_snapshot:{id:contact,name:'Cliente sintético'},effect_flags:{finance_active:false,stock_active:false},source_proposal_id:null,created_at:'2026-10-16T10:00:00Z',updated_at:'2026-10-16T10:00:00Z'};
 const s={doc,role,calls:[],events:[],commands:new Map(),accepted:[],closed:[],copied:[],counts:{},phase:'ready'};
 const ctx=()=>({...flags,document:{id,kind:'service_orders',number:'1',version:s.doc.version,status:s.doc.status,total:s.doc.totals.total,commercial_hash:hash},can_record:['admin','vendas'].includes(s.role)&&s.doc.status!=='cancelled',allowed_event_types:!['admin','vendas'].includes(s.role)||s.doc.status==='cancelled'?[]:['reception',...(['quoted','approved','rejected'].includes(s.doc.status)?['customer_decision']:[])]});
 const row=r=>({record:copy(r),current:{document_version:s.doc.version,document_status:s.doc.status,document_version_changed:r.document_version!==s.doc.version,commercial_content_changed:false,total_changed:false,corrected_by_event_id:null,approval_basis_matches_current:false}});
 s.controller={getSnapshot:()=>({phase:s.phase,membership:{role:s.role,user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documents(path,o={}){s.calls.push({channel:'document',path,...o});return{document:copy(s.doc)};},async documentCopy(path,o={}){s.calls.push({channel:'copy',path,...o});throw new AccessError(503);},async attachments(){return{data_mode:'erp_native',document_id:id,items:[]};},async serviceEvents(path,o={}){
  const op=o.method==='POST'?'append':path.includes('?')?'list':'get',c={channel:'event',op,path,...o};s.calls.push(c);s.counts[op]=(s.counts[op]??0)+1;await before(c,s);let result;
  if(op==='append'){let r=s.commands.get(o.body.command_id);const replayed=Boolean(r);if(!r){const d=o.body.data;r={id:crypto.randomUUID(),document_id:id,sequence:String(s.events.length+1),type:d.type,document_version:o.body.expected_document_version,document_status:s.doc.status,commercial_hash:hash,total:s.doc.totals.total,snapshot:{number:'1',contact:{id:contact,name:'Cliente sintético'},equipment:null,serial_number:null,technician:null},occurred_on:d.occurred_on,declarant_name:d.declarant_name,declarant_role:d.declarant_role,details:copy(d.details),notes:d.notes,attachment:null,corrects_event_id:null,correction_reason:null,actor_id:actor,recorded_at:'2026-10-16T12:00:00Z'};s.commands.set(o.body.command_id,r);s.events.push(r);}result={...ctx(),...row(r),replayed};}
  else if(op==='get'){const r=s.events.find(e=>e.id===path.split('/').at(-1));if(!r)throw new AccessError(404);result={...ctx(),...row(r),read_only:true};}
  else result={...ctx(),read_only:true,items:s.events.slice().reverse().map(row),limit:25,has_more:false,next_before:null};
  await after(c,s);return copy(result);
 }};return s;
}
const mount=async(s,actual=false)=>{const v=await mountComponent('RealDocuments.tsx',{controller:s.controller,kind:'service_orders',record:s.doc,writable:['admin','vendas'].includes(s.role),onSaved:r=>s.accepted.push(r),onClose:()=>s.closed.push(true),onConverted(){},onCopyPrepared:r=>s.copied.push(r)},{componentName:'Editor',expandChildren:actual?['ServiceOrderEvents']:false});child(v,'DocumentFinance')?.props.onActive(false);child(v,'DocumentStock')?.props.onActive(false);await v.flush();return v;};
const fill=async v=>{for(const [field,value]of Object.entries({type:'reception',occurred_on:'2026-01-15',declarant_name:'Pessoa sintética',declarant_role:'customer',apparent_condition:'Recebido para diagnóstico',attachment_choice:'none',confirmed:true}))await v.change('service-event-'+field,value);};

test('049 parent keeps event callbacks independent from commercial onSaved and only mounts for permitted saved OS',async()=>{
 for(const role of['admin','vendas','financeiro','consulta','estoque','fiscal']){const s=service({role}),v=await mount(s);try{const panel=child(v,'ServiceOrderEvents');assert.equal(Boolean(panel),['admin','vendas','financeiro','consulta'].includes(role));if(panel){assert.equal(panel.props.onChanged,undefined);assert.deepEqual(panel.props.document,{id,version:3});}}finally{v.unmount();}}
 const s=service(),v=await mount(s);try{await v.updateProps({record:null});assert.equal(child(v,'ServiceOrderEvents'),undefined);}finally{v.unmount();}
});
test('049 synchronous child refs block retained parent handlers before rerender and all siorigins after render',async()=>{
 const s=service(),v=await mount(s);try{
  await v.click('Ver / adicionar anexos');const event=child(v,'ServiceOrderEvents'),old={notes:v.input('doc-notes'),status:v.input('doc-next-status'),reason:v.input('doc-reason'),submit:v.find(n=>n.type==='form'),print:v.button('Visualizar impressão'),copy:v.button('Duplicar como novo'),refresh:v.button('Atualizar OS salva'),toggle:v.button('Recolher anexos'),close:v.button('Cancelar'),origin:child(v,'DocumentCopyOrigin'),picker:child(v,'CatalogPicker')};
  event.props.onDraft(true);event.props.onBusy(true); // Deliberately no flush yet.
  old.notes.props.onChange({target:{value:'Must not apply'}});old.status.props.onChange({target:{value:'approved'}});old.reason.props.onChange({target:{value:'Must not apply'}});old.submit.props.onSubmit({preventDefault(){}});for(const key of['print','copy','refresh','toggle','close'])old[key].props.onClick();old.origin.props.onOpen(contact);old.picker.props.onSelect({id:contact,name:'Wrong name'});await v.flush();
  assert.equal(v.input('doc-notes').props.value,'');assert.equal(v.input('doc-next-status').props.value,'');assert.equal(v.input('doc-reason').props.value,'');assert.equal(s.calls.length,0);assert.equal(s.closed.length,0);assert.equal(child(v,'DocumentPrintPreview'),undefined);assert.equal(v.location().pathname,'/qa');
  for(const name of['DocumentFinance','DocumentStock','DocumentAttachments','ServiceOrderJournal'])assert.equal(child(v,name).props.blocked,true,name);assert.equal(child(v,'ServiceOrderEvents').props.blocked,false);assert.equal(v.button('Cancelar').disabled,true);assert.throws(()=>child(v,'DocumentFinance').props.onChanged({...s.doc,version:4}),e=>e.status===409);await assert.rejects(()=>child(v,'DocumentStock').props.onChanged(4),e=>e.status===409);assert.equal(s.accepted.length,0);
  event.props.onBusy(false);event.props.onDraft(false);await v.flush();assert.equal(v.input('doc-notes').disabled,false);assert.equal(v.button('Atualizar OS salva').disabled,false);
 }finally{v.unmount();}
});
test('049 each siorigin draft or pending request blocks events, but never its own recovery',async()=>{
 const s=service(),v=await mount(s);try{
  await v.click('Ver / adicionar anexos');for(const name of['DocumentFinance','DocumentStock','DocumentAttachments','ServiceOrderJournal'])for(const key of['onDraft','onBusy']){child(v,name).props[key](true);await v.flush();assert.equal(child(v,'ServiceOrderEvents').props.blocked,true,`${name}:${key}`);assert.equal(child(v,name).props.blocked,false,`${name} own recovery`);child(v,name).props[key](false);await v.flush();assert.equal(child(v,'ServiceOrderEvents').props.blocked,false);}
  await v.change('doc-next-status','approved');assert.equal(child(v,'ServiceOrderEvents').props.blocked,true);await v.change('doc-next-status','');await v.change('doc-notes','Alteração comercial');assert.equal(child(v,'ServiceOrderEvents').props.blocked,true);
 }finally{v.unmount();}
});
for(const refusal of[403,409])test(`049 actual event recovery503→${refusal}→ACK→failed GET never remounts OS and only clears after current event/history`,async()=>{
 const s=service({before(c,s){if(c.op==='append'&&s.counts.append===2)throw new AccessError(refusal);if(c.op==='get'&&s.counts.get===1)throw new AccessError(503);},after(c,s){if(c.op==='append'&&s.counts.append===1)throw new AccessError(503);}}),v=await mount(s,true);try{
  await fill(v);await v.submit(1);assert.equal(v.button('Cancelar').disabled,true);assert.equal(child(v,'ServiceOrderJournal').props.blocked,true);assert.equal(v.button('Repetir a mesma confirmação').disabled,false);assert.equal(s.accepted.length,0);
  await v.click('Repetir a mesma confirmação');assert.equal(v.button('Cancelar').disabled,true);await v.click('Repetir a mesma confirmação');assert.match(v.text(),/registro foi confirmado/);assert.equal(v.button('Cancelar').disabled,true);await v.click('Consultar registro confirmado');
  assert.equal(s.counts.append,3);assert.equal(s.counts.get,2);assert.equal(s.commands.size,1);const posts=s.calls.filter(c=>c.op==='append');assert.deepEqual(posts[0].body,posts[1].body);assert.deepEqual(posts[0].body,posts[2].body);assert.equal(s.accepted.length,0);assert.equal(s.doc.version,3);assert.equal(s.calls.some(c=>c.channel==='document'),false);assert.equal(v.button('Cancelar').disabled,false);assert.equal(v.input('doc-notes').disabled,false);assert.match(v.text(),/Registro 1 confirmado/);
 }finally{v.unmount();}
});
test('049 explicit document refresh requires clean children and validates current version, without event-driven remount',async()=>{
 const s=service(),v=await mount(s);try{
  const event=child(v,'ServiceOrderEvents'),refresh=v.button('Atualizar OS salva');event.props.onDraft(true);refresh.props.onClick();await v.flush();assert.equal(s.calls.length,0);event.props.onDraft(false);await v.flush();s.doc={...s.doc,version:4};await v.click('Atualizar OS salva');assert.equal(s.accepted.length,1);assert.equal(s.accepted[0].version,4);assert.equal(s.calls.length,1);
 }finally{v.unmount();}
});
