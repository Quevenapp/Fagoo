import test from 'node:test';
import assert from 'node:assert/strict';
import {compactDocumentDecimal,documentDecimalDisplay,documentDecimalInput,documentFormValues} from '../src/lib/document-decimals.ts';
import {documentInput} from '../src/lib/real-documents-model.ts';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {COPY_RESET_FIELDS} from '../src/lib/document-copy-model.ts';
const id='10000000-0000-4000-8000-000000000001',contact='20000000-0000-4000-8000-000000000001',line='30000000-0000-4000-8000-000000000001';
const input=()=>({date:'2026-10-16',contact_id:contact,items:[{id:line,description:'Item sintético',unit:'UN',quantity:'2.000000',unit_price:'1.2300',discount_percent:'10.0000'}],discount_mode:'amount',discount_value:'0.00',freight:'2.00',other_expenses:'0.00',installments:[]});
const record=(body=input())=>({...normalizeDocument('sales_proposals',body),id,kind:'sales_proposals',number:'7',version:2,status:'draft',contact_snapshot:{id:contact,name:'Contato sintético'},source_proposal_id:null,effect_flags:{finance_active:false,stock_active:false},created_at:'2026-10-16T07:00:00Z',updated_at:'2026-10-16T07:00:00Z'});
const control=(view,label)=>view.find(node=>node.type==='input'&&node.props['aria-label']===label);
async function edit(view,label,text){control(view,label).props.onChange({target:{value:text}});await view.flush();}
function controller(){const calls=[],saved=[];return{calls,saved,api:{getSnapshot:()=>({membership:{role:'vendas'}}),catalog:async()=>({read:[],write:[]}),async documents(path,options={}){calls.push({path,...options});if(options.method){saved.push(structuredClone(options.body.data));return{kind:'sales_proposals',document:record(options.body.data)};}return{kind:'sales_proposals',document:{...record(saved.at(-1)),version:3}};},async documentCopy(path,options){calls.push({path,...options});const doc={...record(options.body.data),id:'10000000-0000-4000-8000-000000000002',version:1};saved.push(structuredClone(options.body.data));return{document:doc,kind:'sales_proposals',copy_source:{id,kind:'sales_proposals',number:'7',version:2},replayed:false,data_mode:'erp_native',operational_effects:false};}}};}
const mount=(service,props={})=>mountComponent('RealDocuments.tsx',{controller:service.api,kind:'sales_proposals',record:record(),writable:true,onClose(){},onSaved(){},onConverted(){},...props},{componentName:'Editor'});

test('lexical load compaction preserves exact magnitudes, signs/invalid input and every significant digit',()=>{
 const cases=[['2.000000','2'],['0.000000','0'],['0.123456','0.123456'],['1.2300','1.23'],['999999999999.999999','999999999999.999999'],['99999999999999.9900','99999999999999.99'],['123456789012345678901234567890.123400','123456789012345678901234567890.1234'],['001.200','001.2']];
 for(const [value,expected]of cases){assert.equal(compactDocumentDecimal(value),expected);assert.equal(documentDecimalInput(documentDecimalDisplay(value)),value);}
 for(const value of ['', '2.', '.5','-1.00','2,00','1e3','1.2.3',' 2.00 '])assert.equal(compactDocumentDecimal(value),value);
});
test('display and typing preserve partial edits without interpreting thousands or applying rounding',()=>{
 for(const [display,canonical]of [['',''],[',','.'],['2,','2.'],['2,00','2.00'],['0,123456','0.123456'],['1.23','1.23'],['1.234,56','1.234.56']]){assert.equal(documentDecimalInput(display),canonical);assert.equal(documentDecimalDisplay(canonical),display.replaceAll('.',','));}
 assert.equal(documentDecimalDisplay(undefined),'');
});
test('form normalization is immutable and leaves domain totals, IDs, dates and complete snapshots equivalent',()=>{
 const raw=input();raw.items.push({id:'30000000-0000-4000-8000-000000000002',description:'Volume sintético',unit:'KG',quantity:'999999999.999999',unit_price:'0.0000'});raw.installments=[{due_date:'2026-11-01',amount:'4.2100',method:'Método sintético'}];
 // Money inputs have two decimal places in the contract; use an exact native amount.
 raw.installments[0].amount='4.21';const original=structuredClone(raw),formatted=documentFormValues(raw);
 assert.deepEqual(raw,original);assert.notEqual(formatted.items,raw.items);assert.equal(formatted.items[0].quantity,'2');assert.equal(formatted.items[0].unit_price,'1.23');assert.equal(formatted.items[1].quantity,'999999999.999999');assert.equal(formatted.items[1].unit_price,'0');assert.deepEqual(normalizeDocument('sales_proposals',formatted),normalizeDocument('sales_proposals',raw));assert.deepEqual(documentFormValues(formatted),formatted);
});
test('opening and reopening saved inputs shows comma without marking a false draft, including equivalent trailing-zero edits',async()=>{
 const service=controller(),view=await mount(service);
 try{assert.equal(control(view,'Quantidade do item 1').props.value,'2');assert.equal(control(view,'Preço do item 1').props.value,'1,23');assert.equal(control(view,'Desconto do item 1').props.value,'10');assert.equal(view.input('doc-freight').props.value,'2');assert.equal(view.guard().changed,false);
  await edit(view,'Preço do item 1','1,2300');assert.equal(control(view,'Preço do item 1').props.value,'1,2300');assert.equal(view.guard().changed,false);
  await edit(view,'Quantidade do item 1','2,');assert.equal(control(view,'Quantidade do item 1').props.value,'2,');assert.equal(view.guard().changed,true);await view.submit();assert.equal(service.calls.length,0);
  await edit(view,'Quantidade do item 1','2,000000');assert.equal(view.guard().changed,false);assert.equal(control(view,'Quantidade do item 1').props.value,'2,000000');
 }finally{view.unmount();}
 const reopened=await mount(service);try{assert.equal(control(reopened,'Preço do item 1').props.value,'1,23');assert.equal(reopened.guard().changed,false);}finally{reopened.unmount();}
});
test('decimal comma input sends exact canonical strings and retains six quantity/four price digits',async()=>{
 const service=controller(),view=await mount(service);
 try{await edit(view,'Quantidade do item 1','0,123456');await edit(view,'Preço do item 1','9999999999,9999');await edit(view,'Desconto do item 1','0');await view.change('doc-freight','0');await view.submit();assert.equal(service.saved.length,1);assert.equal(service.saved[0].items[0].quantity,'0.123456');assert.equal(service.saved[0].items[0].unit_price,'9999999999.9999');assert.doesNotMatch(JSON.stringify(service.saved[0].items[0]),/e\+|99999999999999,9999/);assert.equal(service.calls.length,2);}finally{view.unmount();}
});
test('planned amounts and catalog price loading share friendly formatting without changing public notes',async()=>{
 const service=controller(),body=input();body.installments=[{due_date:'2026-11-01',amount:'4.21'}];body.notes='Texto com 2.000000 preservado';service.api.catalog=async()=>({read:['products'],write:[]});
 const view=await mount(service,{record:record(body)});
 try{const amount=view.nodes().find(node=>node.type==='input'&&node.props.value==='4,21');assert.ok(amount);assert.equal(view.input('doc-notes').props.value,body.notes);assert.equal(view.guard().changed,false);
  const picker=view.nodes().find(node=>typeof node.type==='function'&&node.type.name==='CatalogPicker'&&node.props.entity==='products');picker.props.onSelect({id:'30000000-0000-4000-8000-000000000099',name:'Produto sintético',unit:'UN',price:'2.5000'});await view.flush();assert.equal(control(view,'Preço do item 2').props.value,'2,5');
 }finally{view.unmount();}
});
test('copy preparation uses the same compact baseline but remains an unsaved creation; DTO precision is retained on save',async()=>{
 const service=controller(),data=documentInput(record());data.items=data.items.map(item=>({...item,id:null}));const source={id,kind:'sales_proposals',number:'7',version:2};const copyDraft={contact:{id:contact,name:'Contato sintético'},preview:{source,data,reset_fields:[...COPY_RESET_FIELDS],persisted:false,data_mode:'erp_native',operational_effects:false}};
 service.api.documents=async(path,options)=>{service.calls.push({path,...options});return{document:{...record(service.saved.at(-1)),id:'10000000-0000-4000-8000-000000000002',version:3}};};
 const view=await mount(service,{record:null,copyDraft});
 try{assert.equal(control(view,'Preço do item 1').props.value,'1,23');assert.equal(control(view,'Quantidade do item 1').props.value,'2');assert.equal(view.guard().changed,true);await edit(view,'Quantidade do item 1','0,123456');await view.submit();assert.equal(service.saved[0].items[0].quantity,'0.123456');assert.equal(service.saved[0].items[0].unit_price,'1.23');assert.equal(copyDraft.preview.data.items[0].unit_price,'1.2300');assert.equal(service.calls.length,2);}finally{view.unmount();}
});
