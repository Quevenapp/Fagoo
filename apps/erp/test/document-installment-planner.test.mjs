import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {actor,record,input} from './helpers/document-commercial-fixtures.mjs';
import {documentInput,explicitDocumentInput} from '../src/lib/real-documents-model.ts';
import {documentFormValues} from '../src/lib/document-decimals.ts';
const child=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
async function editor({kind='sales_proposals',data={...input(),payment_terms:'Combinado por escrito, sem interpretar 3x'},snapshot={phase:'ready',membership:{role:'admin',user_id:actor}},documents=async()=>{throw new Error('Unexpected write');},writable=true,original}={}){
 const saved=original||record(kind,data),calls=[],accepted=[],controller={getSnapshot:()=>snapshot,catalog:async()=>({read:[],write:[]}),documents:async(path,options={})=>{calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});return documents(path,options);}};
 const props={controller,kind,record:saved,writable,onSaved:value=>accepted.push(value),onClose(){},onConverted(){}};
 const view=await mountComponent('RealDocuments.tsx',props,{componentName:'Editor',expandChildren:['DocumentInstallmentPlanner']});
 for(const name of ['DocumentFinance','DocumentStock','SalesOrderReservations'])child(view,name)?.props.onActive(false);
 // This harness expands only the planner. Supply the initial090 GET observation
 // that the real purchase panel publishes before a purchase becomes editable.
 const receipts=child(view,'PurchaseReceipts');receipts?.props.onMode('available');receipts?.props.onActive(false);
 await view.flush();return{view,saved,calls,accepted,snapshot,props};
}
async function prepare(view){await view.click('Gerar parcelas mensais');await view.change('doc-plan-count','3');await view.change('doc-plan-first-due','2026-10-31');await view.click('Conferir parcelas');}

for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders'])test(`${kind}: explicit local review applies exact rows; normal save preserves all other commercial fields`,async()=>{
 let body;const f=await editor({kind,documents:async(path,options)=>{if(options.method){body=options.body.data;return{document:record(kind,body,2)};}return{document:record(kind,body,2)};}}),{view}=f;
 try{
  await view.click('Gerar parcelas mensais');assert.equal(view.input('doc-plan-count').props.value,'');assert.equal(view.input('doc-plan-first-due').props.value,'');assert.match(view.text(),/Total do documento atual:.*12,50/);
  await view.change('doc-plan-count','3');await view.change('doc-plan-first-due','2026-10-31');await view.click('Conferir parcelas');assert.equal(f.calls.length,0);assert.match(view.text(),/Forma declarada/);assert.match(view.text(),/Observação pública da parcela/);assert.match(view.text(),/Forma Origin declarada/);assert.equal(view.input('doc-installment-note-0').props.value,f.saved.installments[0].note);
  await view.click('Substituir parcelas');assert.equal(f.calls.length,0);assert.equal(view.input('doc-payment').props.value,'Combinado por escrito, sem interpretar 3x');assert.equal(view.guard().changed,true);assert.equal(view.input('doc-installment-note-0').props.value,'');
  await view.submit();assert.equal(f.calls.length,2);assert.equal(f.calls[0].method,'PATCH');assert.equal(f.calls[1].method,undefined);// 202610200196: every parcela carries the Forma (and, outside propostas, the details), null when unused.
  const extra=kind==='sales_proposals'?{payment_method_id:null}:{payment_method_id:null,details:null};
  assert.deepEqual(body.installments,[{due_date:'2026-10-31',amount:'4.17',method:null,note:null,payment_reference:null,...extra},{due_date:'2026-11-30',amount:'4.17',method:null,note:null,payment_reference:null,...extra},{due_date:'2026-12-31',amount:'4.16',method:null,note:null,payment_reference:null,...extra}]);
  const before=documentFormValues(explicitDocumentInput(documentInput(f.saved)));assert.deepEqual({...body,installments:before.installments},before);assert.deepEqual(f.accepted[0].installments,body.installments.map((row,index)=>({...row,position:index+1})));assert.equal(f.accepted[0].effect_flags.finance_active,false);assert.equal(f.accepted[0].effect_flags.stock_active,false);
 }finally{view.unmount();}
});
test('cancelling replacement preserves old rows and metadata; no calls or dirty document remain',async()=>{
 const{view,calls,saved}=await editor();try{await prepare(view);await view.click('Cancelar geração');assert.equal(view.guard().changed,false);assert.equal(view.input('doc-installment-note-0').props.value,saved.installments[0].note);assert.equal(calls.length,0);assert.equal(view.input('doc-payment').disabled,false);}finally{view.unmount();}
});
test('local review fences retained document handlers and all siorigin actions, while its own apply stays available',async()=>{
 const{view,calls}=await editor({kind:'service_orders'});try{
  await view.click('Ver / adicionar anexos');const stale=view.input('doc-notes'),staleStatus=view.input('doc-next-status'),staleSubmit=view.nodes().find(n=>n.type==='form').props.onSubmit;
  await prepare(view);assert.equal(view.guard().changed,true);assert.equal(view.input('doc-notes').disabled,true);assert.equal(view.input('doc-next-status').disabled,true);assert.equal(view.button('Visualizar impressão').disabled,true);
  for(const name of ['DocumentFinance','DocumentStock','DocumentAttachments','ServiceOrderJournal','ServiceOrderEvents'])assert.equal(child(view,name).props.blocked,true,name);
  stale.props.onChange({target:{value:'STALE'}});staleStatus.props.onChange({target:{value:'in_progress'}});staleSubmit({preventDefault(){}});await view.flush();assert.equal(calls.length,0);assert.equal(view.input('doc-notes').props.value,'');assert.equal(view.input('doc-next-status').props.value,'');
  await view.click('Substituir parcelas');assert.equal(view.input('doc-notes').disabled,false);assert.equal(view.input('doc-payment').disabled,false);
 }finally{view.unmount();}
});
test('changed choices invalidate preview and a current edited commercial total is used',async()=>{
 const{view,calls}=await editor({data:{...input(),installments:[]}});try{
  await view.change('doc-discount_value','2,00');await view.change('doc-freight','3,51');await prepare(view);assert.match(view.text(),/Novo plano.*14,01/);assert.match(view.text(),/4,67/);
  const stale=view.button('Usar estas parcelas');await view.change('doc-plan-count','2');stale.props.onClick();await view.flush();assert.equal(view.nodes().some(n=>n.props.id==='doc-installment-note-0'),false);assert.equal(calls.length,0);
  await view.click('Conferir parcelas');await view.click('Usar estas parcelas');assert.equal(view.nodes().filter(n=>/^doc-installment-note-/.test(n.props.id||'')).length,2);assert.equal(view.input('doc-discount_value').props.value,'2,00');assert.equal(view.input('doc-freight').props.value,'3,51');
 }finally{view.unmount();}
});
test('same-actor role loss, another actor, and siorigin work block retained apply handlers',async()=>{
 for(const change of [f=>f.snapshot.phase='checking',f=>f.snapshot.phase='error',f=>f.snapshot.membership.role='consulta',f=>f.snapshot.membership.user_id='e0000000-0000-4000-8000-000000000001',f=>child(f.view,'DocumentFinance').props.onBusy(true)]){
  const f=await editor({kind:'sales_orders'});try{await prepare(f.view);const stale=f.view.button('Substituir parcelas');change(f);stale.props.onClick();await f.view.flush();assert.equal(f.view.input('doc-installment-note-0').props.value,f.saved.installments[0].note);assert.equal(f.calls.length,0);}finally{f.view.unmount();}
 }
});
test('existing effects, read-only permission and ineligible status do not offer an enabled generator',async()=>{
 for(const options of [{writable:false},{original:{...record(),effect_flags:{finance_active:true,stock_active:false}}},{original:{...record(),status:'approved'}}]){
  const{view}=await editor(options);try{assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Gerar parcelas mensais'&&!n.disabled),false);}finally{view.unmount();}
 }
});
test('lost save ACK keeps generated rows and original UUID/body; after ACK only current GET is repeated',async()=>{
 let body,writes=0,reads=0;const f=await editor({documents:async(path,options)=>{if(options.method){writes++;body=options.body.data;if(writes===1)throw new AccessError(503);return{document:record('sales_proposals',body,2)};}reads++;if(reads===1)throw new AccessError(503);return{document:record('sales_proposals',body,2)};}});
 try{await prepare(f.view);await f.view.click('Substituir parcelas');const stale=f.view.button('Gerar parcelas mensais');await f.view.submit();stale.props.onClick();await f.view.flush();assert.equal(f.view.guard().busy,true);assert.equal(f.view.button('Gerar parcelas mensais').disabled,true);assert.equal(f.view.nodes().some(n=>n.props.id==='doc-plan-count'),false);await f.view.click('Conferir resultado');await f.view.click('Conferir resultado');assert.equal(writes,2);assert.equal(reads,2);assert.deepEqual(f.calls[0].body,f.calls[1].body);assert.equal(f.accepted[0].installments.length,3);assert.equal(f.accepted[0].payment_terms,'Combinado por escrito, sem interpretar 3x');}finally{f.view.unmount();}
});
