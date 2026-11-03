import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {createPurchaseReceiptsFixture} from '../src/qa/purchase-receipts-fixture.ts';
import {record as commercialRecord,input as commercialInput} from './helpers/document-commercial-fixtures.mjs';
import {effectTransitionAllowed} from '../src/lib/document-effects-model.ts';

// 279 (estoque, onda F): a pedido de compra with posted stock keeps the header editable, as in Origin; the items, the fornecedor and the
// depósito stay read-only; "Gerar parcelas" stays (Origin hides it only with contas). Synthetic data only.
const child=(v,name)=>v.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
function document(s,active){const c=s.current;return {...commercialRecord('purchase_orders',{...commercialInput(),warehouse_id:c.document.warehouse_id,
 items:c.items.map(i=>({id:i.item_id,product_id:i.product_id,description:i.description,quantity:i.ordered_quantity,unit:i.unit,unit_price:'1'})),installments:[]}),
 ...s.record,version:c.document.version,status:c.document.status,notes:null,internal_notes:null,effect_flags:{finance_active:false,stock_active:active}};}
async function mount(active,write=[]){
 const s=createPurchaseReceiptsFixture();s.saved=[];s.documentCalls=[];s.doc=document(s,active);s.controller.catalog=async()=>({read:['contacts','warehouses','products'],write});
 s.controller.documents=async(path,o={})=>{s.documentCalls.push({path,...o,body:o.body?structuredClone(o.body):undefined});if(o.method)return{document:{...s.doc,version:s.doc.version+1,notes:o.body?.data?.notes??o.body?.notes??null},replayed:false};return{document:structuredClone(s.doc)};};
 s.controller.documentCopy=async()=>{throw new AccessError(503);};
 const v=await mountComponent('RealDocuments.tsx',{controller:s.controller,kind:'purchase_orders',record:s.doc,writable:true,onSaved:r=>s.saved.push(r),onClose(){},onConverted(){},onCopyPrepared(){}},{componentName:'Editor'});
 child(v,'DocumentFinance')?.props.onActive(false);child(v,'PurchaseReceipts').props.onMode(active?'item_receipts':'available');child(v,'PurchaseReceipts').props.onActive(active);await v.flush();return{s,v};
}

test('279 pedido de compra with an active recebimento: header editable; items, fornecedor and depósito read-only; Gerar parcelas stays',async()=>{
 const{s,v}=await mount(true);
 try{
  assert.match(v.text(),/Estoque lançado: os itens, o fornecedor e o depósito ficam somente leitura; os demais campos podem ser alterados\./);
  assert.equal(v.input('doc-notes').disabled,false);assert.equal(v.input('doc-date').disabled,false);
  assert.equal(v.input('doc-item-qty-0').disabled,true);assert.equal(v.input('doc-item-description-0').disabled,true);
  assert.equal(v.nodes().some(n=>n.type==='button'&&n.props['aria-label']==='Remover item 1'),false,'no trash');
  // Origin hides "Gerar parcelas" only when the contas were posted; with the stock posted the condição still generates the parcelas.
  assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Gerar parcelas'),true,'Gerar parcelas stays with the stock posted');
  const pickers=v.nodes().filter(n=>typeof n.type==='function'&&n.type.name==='CatalogPicker');
  assert.equal(pickers.find(p=>p.props.entity==='contacts'&&/Fornecedor/.test(p.props.label)).props.disabled,true,'the fornecedor loses the lupa');
  assert.equal(pickers.find(p=>p.props.label==='Depósito previsto').props.disabled,true);
  // A retained item handler cannot change the items (the server would refuse it too).
  v.input('doc-item-qty-0').props.onChange({target:{value:'9'}});await v.flush();
  assert.notEqual(v.input('doc-item-qty-0').props.value,'9');
  await v.change('doc-condition','30');await v.click('Gerar parcelas');await v.flush();
  await v.change('doc-notes','Entregar pela manhã');
  await v.submit();
  const save=s.documentCalls.find(c=>c.method==='PATCH'||c.method==='POST');
  assert.ok(save,'the header is saved');
  const sent=save.body.data??save.body;
  assert.equal(sent.notes,'Entregar pela manhã');
  assert.equal(sent.installments.length,1,'the parcelas generated from the condição go with the header');
  assert.deepEqual(sent.items.map(i=>i.id),s.doc.items.map(i=>i.id),'the same items, with their ids, so the guards see an unchanged rewrite');
 }finally{v.unmount();}
 // Without stock the pedido is fully editable, as before.
 const free=await mount(false);
 try{assert.equal(free.v.input('doc-item-qty-0').disabled,false);assert.doesNotMatch(free.v.text(),/Estoque lançado: os itens/);}finally{free.v.unmount();}
});

test('279 Em aberto moves forward with active stock (Verificado, Em andamento, Atendido), never back',()=>{
 for(const to of['verified','in_progress','fulfilled'])assert.equal(effectTransitionAllowed('sales_orders','open',to,false),true,to);
 for(const to of['draft','cancelled','agency_sale'])assert.equal(effectTransitionAllowed('sales_orders','open',to,false),false,to);
 // Contas (or an unknown finance state) keep the guard of the financeiro: Em aberto does not move with them.
 for(const to of['verified','in_progress','fulfilled'])assert.equal(effectTransitionAllowed('sales_orders','open',to),false,to);
});

test('279 "Editar Contato" of a pedido de compra with posted stock changes the cadastro only: the fornecedor of the pedido stays',async()=>{
 const{s,v}=await mount(true,['contacts']);
 try{
  const link=v.nodes().find(n=>n.type==='a'&&n.props.title==='Editar Contato');assert.ok(link,'Origin keeps the lápis of the fornecedor');
  link.props.onClick({preventDefault(){}});await v.flush();
  child(v,'ContactEditor').props.onSaved({id:s.doc.contact_id,name:'Fornecedor renomeado',state:'SP'});await v.flush();
  const picker=v.nodes().find(n=>typeof n.type==='function'&&n.type.name==='CatalogPicker'&&n.props.entity==='contacts'&&/Fornecedor/.test(n.props.label));
  assert.match(picker.props.status,/Contato atualizado no cadastro./);assert.equal(picker.props.disabled,true,'the fornecedor stays read-only');
  await v.change('doc-notes','Conferir nota');await v.submit();
  const save=s.documentCalls.find(c=>c.method==='PATCH'||c.method==='POST');
  assert.ok(save);assert.equal((save.body.data??save.body).refresh_contact,undefined,'no refreshed retrato, which the stock guards refuse');
 }finally{v.unmount();}
});
