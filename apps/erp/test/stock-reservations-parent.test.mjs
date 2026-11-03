import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {stockFixture,mutations,queries,ACTOR,ORDER,PRODUCT} from './helpers/stock-reservations-fixtures.mjs';
const child=(v,name)=>v.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function mount(s,actual=false){
 s.saved=[];s.closed=[];s.documentCalls=[];s.controller.catalog=async()=>({read:[],write:[]});s.controller.documents=async(path,o={})=>{s.documentCalls.push({path,...o});return{document:structuredClone(s.doc)};};s.controller.documentCopy=async()=>{throw new AccessError(503);};
 const v=await mountComponent('RealDocuments.tsx',{controller:s.controller,kind:'sales_orders',record:structuredClone(s.doc),writable:true,onSaved:r=>s.saved.push(r),onClose:()=>s.closed.push(true),onConverted(){},onCopyPrepared(){}},{componentName:'Editor',expandChildren:actual?['SalesOrderReservations']:false});
 child(v,'DocumentFinance')?.props.onActive(false);child(v,'DocumentStock')?.props.onActive(false);if(!actual)child(v,'SalesOrderReservations').props.onActive(false);await v.flush();return v;
}
async function prepare(v){await v.click('Reservar produtos');for(const[suffix,value]of [['-day','2026-10-16'],['-reason','Reserva sintética']])await v.change(v.find(n=>n.type==='input'&&n.props.id?.endsWith(suffix)).props.id,value);await v.click('Conferir reserva');const box=v.find(n=>n.type==='input'&&n.props.type==='checkbox');box.props.onChange({target:{checked:true}});await v.flush();}

test('070 synchronous reservation callbacks fence edits, status, close, print, copy and all siorigins',async()=>{
 const s=stockFixture({AccessError}),v=await mount(s);try{
  await v.click('Ver / adicionar anexos');const panel=child(v,'SalesOrderReservations'),old={notes:v.input('doc-notes'),status:v.input('doc-next-status'),reason:v.input('doc-reason'),submit:v.find(n=>n.type==='form'),print:v.button('Visualizar impressão'),copy:v.button('Duplicar como novo'),toggle:v.button('Recolher anexos'),close:v.button('Cancelar'),origin:child(v,'DocumentCopyOrigin'),picker:child(v,'CatalogPicker')};
  panel.props.onDraft(true);panel.props.onBusy(true);
  old.notes.props.onChange({target:{value:'Wrong'}});old.status.props.onChange({target:{value:'in_progress'}});old.reason.props.onChange({target:{value:'Wrong'}});old.submit.props.onSubmit({preventDefault(){}});for(const key of ['print','copy','toggle','close'])old[key].props.onClick();old.origin.props.onOpen(PRODUCT);old.picker.props.onSelect({id:PRODUCT,name:'Wrong'});await v.flush();
  assert.equal(v.input('doc-notes').props.value,'');assert.equal(v.input('doc-next-status').props.value,'');assert.equal(s.documentCalls.length,0);assert.equal(s.closed.length,0);assert.equal(child(v,'DocumentPrintPreview'),undefined);assert.equal(v.location().pathname,'/qa');
  for(const name of ['DocumentFinance','DocumentStock','DocumentAttachments'])assert.equal(child(v,name).props.blocked,true,name);assert.equal(child(v,'SalesOrderReservations').props.blocked,false);assert.equal(child(v,'SalesOrderReservations').props.canAct(),true);assert.equal(v.button('Cancelar').disabled,true);
  assert.throws(()=>child(v,'DocumentFinance').props.onChanged({...s.doc,version:2}),e=>e.status===409);await assert.rejects(()=>child(v,'DocumentStock').props.onChanged(),e=>e.status===409);
  panel.props.onBusy(false);panel.props.onDraft(false);await v.flush();assert.equal(v.input('doc-notes').disabled,false);
 }finally{v.unmount();}
});
test('070 active/unknown observation fences retained body/planner/status handlers before render',async()=>{
 const s=stockFixture({AccessError}),v=await mount(s);try{
  const panel=child(v,'SalesOrderReservations'),notes=v.input('doc-notes'),planner=child(v,'DocumentInstallmentPlanner');await v.change('doc-next-status','cancelled');await v.change('doc-reason','Cancelar sintético');const status=v.button('Alterar situação');
  panel.props.onActive(true);notes.props.onChange({target:{value:'Wrong'}});status.props.onClick();assert.equal(planner.props.canAct(),false);await v.flush();assert.equal(v.input('doc-notes').props.value,'');assert.equal(s.documentCalls.length,0);assert.equal(child(v,'DocumentStock').props.blocked,true);
  panel.props.onActive(null);status.props.onClick();await v.flush();assert.equal(s.documentCalls.length,0);assert.equal(v.input('doc-next-status').props.children[1].length,0);
 }finally{v.unmount();}
});
test('070 every siorigin blocks reservation synchronously, but its own recovery remains independent',async()=>{
 const s=stockFixture({AccessError}),v=await mount(s);try{
  await v.click('Ver / adicionar anexos');const panel=child(v,'SalesOrderReservations');for(const name of ['DocumentFinance','DocumentStock','DocumentAttachments'])for(const key of ['onBusy','onDraft']){child(v,name).props[key](true);assert.equal(panel.props.canAct(),false,`${name} ${key} synchronous`);await v.flush();assert.equal(child(v,'SalesOrderReservations').props.blocked,true);child(v,name).props[key](false);await v.flush();assert.equal(panel.props.canAct(),true);}
  v.input('doc-notes').props.onChange({target:{value:'Local edit'}});assert.equal(panel.props.canAct(),false);await v.flush();assert.equal(child(v,'SalesOrderReservations').props.blocked,true);
 }finally{v.unmount();}
});
test('070 reservation readback validates current document before remount and rejects siorigin conflict or role loss',async()=>{
 const s=stockFixture({AccessError}),v=await mount(s);try{const panel=child(v,'SalesOrderReservations');s.doc.version=2;await panel.props.onChanged(2);assert.equal(s.saved.length,1);assert.equal(s.documentCalls.length,1);assert.equal(s.documentCalls[0].method,undefined);
  s.doc.version=1;await assert.rejects(()=>panel.props.onChanged(2),e=>e.status===502);assert.equal(s.saved.length,1);
  child(v,'DocumentFinance').props.onBusy(true);await assert.rejects(()=>panel.props.onChanged(2),e=>e.status===409);child(v,'DocumentFinance').props.onBusy(false);
  const gate=deferred();s.controller.documents=async()=>gate.promise;const reading=panel.props.onChanged(2);s.role='financeiro';gate.resolve({document:{...s.doc,version:2}});await assert.rejects(()=>reading,e=>e.status===403);assert.equal(s.saved.length,1);
 }finally{v.unmount();}
});
test('070 actual parent preserves committed unknown intent, performs only GET recovery, then refreshes saved document',async()=>{
 let lookups=0;const s=stockFixture({AccessError,before(c){if(c.path.includes('/comandos/')&&++lookups===1)throw new AccessError(503);},after(c){if(c.method==='POST'&&!c.path.endsWith('preview'))throw new AccessError(503);}}),v=await mount(s,true);
 try{await prepare(v);await v.click('Confirmar reserva');assert.equal(mutations(s).length,1);assert.equal(v.button('Cancelar').disabled,true);assert.equal(child(v,'DocumentFinance').props.blocked,true);assert.equal(s.saved.length,0);await v.click('Consultar resultado');assert.equal(s.saved.length,0);await v.click('Consultar resultado');assert.equal(mutations(s).length,1);assert.equal(queries(s).length,2);assert.equal(s.saved.length,1);assert.equal(s.saved[0].version,2);assert.equal(s.documentCalls.length,1);assert.equal(v.button('Cancelar').disabled,false);assert.equal(child(v,'DocumentStock').props.blocked,true);
 }finally{v.unmount();}
});
