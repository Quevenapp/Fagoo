import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {createPurchaseReceiptsFixture} from '../src/qa/purchase-receipts-fixture.ts';
import {record as commercialRecord,input as commercialInput} from './helpers/document-commercial-fixtures.mjs';
const child=(v,name)=>v.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
async function mount(siorigin,{history=false}={}){
 const s=createPurchaseReceiptsFixture(),c=s.current,calls=[];
 const record={...commercialRecord('purchase_orders',{...commercialInput(),warehouse_id:c.document.warehouse_id,items:c.items.map(i=>({id:i.item_id,product_id:i.product_id,description:i.description,quantity:i.ordered_quantity,unit:i.unit,unit_price:'1'})),installments:[]}),...s.record,status:c.document.status,notes:null,internal_notes:null,effect_flags:{finance_active:false,stock_active:false}};
 const posting={id:'10000000-0000-4000-8000-000000000001',group_id:'20000000-0000-4000-8000-000000000001',source_document_version:record.version,total_cents:'100',installments:1,state:'reversed'};
 const attachment={id:'30000000-0000-4000-8000-000000000001',document_id:record.id,filename:'synthetic.txt',size_bytes:1,mime_type:'text/plain',status:'ready'};
 s.controller.catalog=async()=>({read:[],write:[]});s.controller.finance=async()=>({items:[],has_more:false,next_cursor:null});
 s.controller.documentFinance=async(path,options={})=>{calls.push({path,...options});if(path.endsWith('/'+posting.id))return new Promise(()=>{});return{document_id:record.id,document_version:record.version,active_posting:null,items:history?[posting]:[],has_more:false,next_cursor:null};};
 s.controller.documentStock=async(path,options={})=>{calls.push({path,...options});return{document:{...record,eligible:true,active_posting_id:null},active_posting:null,postings:[],has_more:false,next_cursor:null};};
 s.controller.attachments=async(path,options={})=>{calls.push({path,...options});if(path.endsWith('/download'))return new Promise(()=>{});return{data_mode:'erp_native',document_id:record.id,items:history?[attachment]:[]};};
 const v=await mountComponent('RealDocuments.tsx',{controller:s.controller,kind:'purchase_orders',record,writable:true,onSaved(){},onClose(){},onConverted(){}},{componentName:'Editor',expandChildren:[siorigin]});
 child(v,'DocumentFinance')?.props.onActive(false);child(v,'PurchaseReceipts').props.onMode(siorigin==='DocumentStock'?'legacy_full':'available');child(v,'PurchaseReceipts').props.onActive(false);await v.flush();
 if(siorigin==='DocumentAttachments')await v.click('Ver / adicionar anexos');
 return{v,calls};
}
function edit(v,siorigin){
 if(siorigin==='DocumentAttachments')return()=>v.find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[new File(['synthetic'],'draft.txt',{type:'text/plain'})]}});
 const control=siorigin==='DocumentFinance'?v.find(n=>n.type==='input'&&n.props.placeholder==='0,00'):v.find(n=>n.type==='input'&&n.props.maxLength===500);
 return()=>control.props.onChange({target:{value:siorigin==='DocumentFinance'?'1,00':'Conferência sintética'}});
}
for(const siorigin of ['DocumentAttachments','DocumentFinance','DocumentStock']){
 test(`090 real ${siorigin} draft fences receipts before rendering and releases after discard`,async()=>{
  const {v}=await mount(siorigin);try{
   const receipt=child(v,'PurchaseReceipts');assert.equal(receipt.props.canAct(),true);edit(v,siorigin)();assert.equal(receipt.props.canAct(),false,'siorigin must publish its draft in the event handler');await v.flush();
   const discard=siorigin==='DocumentAttachments'?'Limpar seleção':siorigin==='DocumentFinance'?'Descartar conferência e plano financeiro':'Descartar conferência';
   v.button(discard).props.onClick();assert.equal(receipt.props.canAct(),true,'discard must release the synchronous draft without waiting for a render');await v.flush();assert.equal(child(v,'PurchaseReceipts').props.canAct(),true);
  }finally{v.unmount();}
 });
 test(`090 pending receipt rejects retained ${siorigin} edit handlers before rendering`,async()=>{
  const {v}=await mount(siorigin);try{
   const change=edit(v,siorigin),receipt=child(v,'PurchaseReceipts');receipt.props.onBusy(true);change();receipt.props.onBusy(false);await v.flush();assert.equal(child(v,'PurchaseReceipts').props.canAct(),true,'rejected siorigin edits must not create another draft');
   assert.doesNotMatch(v.text(),/draft\.txt/);
   if(siorigin==='DocumentFinance')assert.equal(v.find(n=>n.type==='input'&&n.props.placeholder==='0,00').props.value,'');
   if(siorigin==='DocumentStock')assert.equal(v.find(n=>n.type==='input'&&n.props.maxLength===500).props.value,'');
  }finally{v.unmount();}
 });
}
for(const siorigin of ['DocumentAttachments','DocumentFinance'])test(`090 real ${siorigin} request fences receipts synchronously without a local draft`,async()=>{
 const {v,calls}=await mount(siorigin,{history:true});try{
  const receipt=child(v,'PurchaseReceipts'),before=calls.length;assert.equal(receipt.props.canAct(),true);
  v.button(siorigin==='DocumentAttachments'?'Baixar':'Ver parcelas 20000000').props.onClick();assert.equal(calls.length,before+1);assert.equal(receipt.props.canAct(),false,'pending siorigin request must own the parent immediately');
 }finally{v.unmount();}
});
for(const siorigin of ['DocumentFinance','DocumentStock'])test(`090 ${siorigin} list refresh owns the parent before render and respects a pending receipt`,async()=>{
 const {v,calls}=await mount(siorigin);try{
  const receipt=child(v,'PurchaseReceipts'),label=siorigin==='DocumentFinance'?'Atualizar lançamentos':'Atualizar lançamentos de estoque',refresh=v.button(label).props.onClick;
  refresh();assert.equal(receipt.props.canAct(),false);await v.flush();assert.equal(child(v,'PurchaseReceipts').props.canAct(),true,'completed list read releases its lock');
  const before=calls.length;child(v,'PurchaseReceipts').props.onBusy(true);refresh();child(v,'PurchaseReceipts').props.onBusy(false);await v.flush();assert.equal(calls.length,before,'retained refresh must not overlap a receipt');
 }finally{v.unmount();}
});
test('090 actual receipt waits for the initial finance read, preventing mutually blocked version refreshes after commit',async()=>{
 let completeFinance,saved=[],documentReads=0;const financeRead=new Promise(resolve=>{completeFinance=resolve;});
 const s=createPurchaseReceiptsFixture(),c=s.current;
 const record={...commercialRecord('purchase_orders',{...commercialInput(),warehouse_id:c.document.warehouse_id,items:c.items.map(i=>({id:i.item_id,product_id:i.product_id,description:i.description,quantity:i.ordered_quantity,unit:i.unit,unit_price:'1'})),installments:[]}),...s.record,status:c.document.status,notes:null,internal_notes:null,effect_flags:{finance_active:false,stock_active:false}};
 s.controller.catalog=async()=>({read:[],write:[]});s.controller.finance=async()=>({items:[],has_more:false,next_cursor:null});s.controller.documentFinance=()=>financeRead;s.controller.documents=async()=>{documentReads++;return{document:{...record,version:s.current.document.version,effect_flags:{finance_active:false,stock_active:true}}};};
 const v=await mountComponent('RealDocuments.tsx',{controller:s.controller,kind:'purchase_orders',record,writable:true,onSaved:value=>saved.push(value),onClose(){},onConverted(){}},{componentName:'Editor',expandChildren:['PurchaseReceipts','Held','View','ReceiptPanel','ReceiptLines','DocumentFinance']});
 try{
  const receive=v.button('Receber produtos');assert.equal(receive.disabled,true);receive.props.onClick();await v.flush();assert.ok(!v.nodes().some(n=>n.props['aria-label']==='Conferência do recebimento'));assert.equal(s.calls.filter(c=>c.path.endsWith('/receive')).length,0);
  completeFinance({document_version:record.version,active_posting:null,items:[],has_more:false,next_cursor:null});await v.flush();assert.equal(v.button('Receber produtos').disabled,false);await v.click('Receber produtos');
  for(const [end,value]of [['-reason','Recebimento sintético']])await v.change(v.find(n=>n.type==='input'&&n.props.id?.endsWith(end)).props.id,value);
  await v.change(v.find(n=>n.type==='input'&&n.props.id?.includes('-quantity-')).props.id,'1,000001');await v.click('Conferir quantidades');v.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await v.flush();await v.click('Confirmar recebimento');
  assert.equal(saved.length,1);assert.equal(saved[0].version,3);assert.equal(documentReads,1);assert.equal(s.calls.filter(c=>c.path.endsWith('/receive')).length,1);assert.doesNotMatch(v.text(),/ficha do pedido precisa ser atualizada/);
 }finally{v.unmount();}
});
