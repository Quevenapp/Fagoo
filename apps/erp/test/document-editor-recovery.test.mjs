import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
const id='10000000-0000-4000-8000-000000000001',contact='20000000-0000-4000-8000-000000000001',actor='30000000-0000-4000-8000-000000000001';
function record(kind='sales_proposals'){
 const value=normalizeDocument(kind,{date:'2026-10-16',contact_id:contact,items:kind==='service_orders'?[]:[{description:'Item sintético',unit:'UN',quantity:'1',unit_price:'12.50'}]});
 return{...value,id,kind,number:'1',version:1,status:kind==='service_orders'?'open':'draft',contact_snapshot:{id:contact,name:'Contato sintético'},effect_flags:{finance_active:false,stock_active:false},created_at:'2026-10-16T07:00:00Z',updated_at:'2026-10-16T07:00:00Z',source_proposal_id:null};
}
const child=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
for(const refusal of [403,409])test(`lost document write response followed by ${refusal} retains frozen command until replay`,async()=>{
 const original=record(),saved={...original,version:2,notes:'Observação sintética'},calls=[],accepted=[];let writes=0,reads=0;
 const controller={getSnapshot:()=>({membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documents(path,options={}){
  calls.push({path,...options});if(options.method){writes++;if(writes===1)throw new AccessError(503);if(writes===2)throw new AccessError(refusal);return{document:saved};}
  reads++;if(reads===1)throw new AccessError(503);return{document:saved};
 }};
 const view=await mountComponent('RealDocuments.tsx',{controller,kind:original.kind,record:original,writable:true,onSaved:value=>accepted.push(value),onClose(){},onConverted(){}},{componentName:'Editor'});
 try{
  await view.change('doc-notes','Observação sintética');await view.submit();assert.equal(view.guard().busy,true);assert.equal(view.input('doc-notes').disabled,true);
  await view.click('Conferir resultado');assert.equal(view.guard().busy,true);assert.equal(view.input('doc-notes').disabled,true);assert.equal(accepted.length,0);
  await view.click('Conferir resultado');assert.match(view.text(),/documento foi registrado/);assert.equal(accepted.length,0);
  await view.click('Conferir resultado');assert.equal(writes,3);assert.equal(reads,2);assert.equal(accepted[0].version,2);
  const mutations=calls.filter(c=>c.method);assert.ok(mutations.every(c=>c.method==='PATCH'));assert.deepEqual(mutations[0].body,mutations[1].body);assert.deepEqual(mutations[0].body,mutations[2].body);
 }finally{view.unmount();}
});
test('service journal draft blocks document and siorigin effects without blocking its own recovery',async()=>{
 const original=record('service_orders'),controller={getSnapshot:()=>({membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]})};
 const view=await mountComponent('RealDocuments.tsx',{controller,kind:original.kind,record:original,writable:true,onSaved(){},onClose(){},onConverted(){}},{componentName:'Editor'});
 try{
  child(view,'DocumentFinance').props.onActive(false);child(view,'DocumentStock').props.onActive(false);await view.flush();
  assert.equal(child(view,'ServiceOrderJournal').props.blocked,false);await view.click('Ver / adicionar anexos');
  child(view,'ServiceOrderJournal').props.onDraft(true);await view.flush();
  assert.equal(view.input('doc-notes').disabled,true);assert.equal(view.input('doc-next-status').disabled,true);assert.equal(child(view,'DocumentFinance').props.blocked,true);assert.equal(child(view,'DocumentStock').props.blocked,true);assert.equal(child(view,'DocumentAttachments').props.blocked,true);assert.equal(child(view,'ServiceOrderJournal').props.blocked,false);
  child(view,'ServiceOrderJournal').props.onBusy(true);await view.flush();assert.equal(view.button('Cancelar').disabled,true);assert.equal(child(view,'ServiceOrderJournal').props.blocked,false);
  child(view,'ServiceOrderJournal').props.onBusy(false);child(view,'ServiceOrderJournal').props.onDraft(false);await view.flush();assert.equal(view.input('doc-notes').disabled,false);
 }finally{view.unmount();}
});
