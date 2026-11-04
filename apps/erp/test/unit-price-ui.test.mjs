import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {catalogData,CATALOG_FIELDS} from '../src/lib/catalog-model.ts';
import {documentInput,documentValidation} from '../src/lib/real-documents-model.ts';
import {documentFormValues,documentDecimalInput,documentDecimalDisplay} from '../src/lib/document-decimals.ts';
import {documentPrintModel} from '../src/lib/document-print-model.ts';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
import {reviewBasis} from '../../../packages/fiscal-core/test/review-fixtures.mjs';
import {actor,contact,record,input} from './helpers/document-commercial-fixtures.mjs';

const priceField=view=>view.find(n=>n.type==='input'&&n.props['aria-label']==='Preço do item 1');
async function priceChange(view,value){priceField(view).props.onChange({target:{value}});await view.flush();}
function savedPrice(price='0.0000000001',quantity='100000000') {
  const body=input();body.items[0].unit_price=price;body.items[0].quantity=quantity;body.installments=[];
  return record('sales_proposals',body);
}
const editorProps=(controller,saved,extra={})=>({controller,kind:saved.kind,record:saved,writable:true,onSaved(){},onClose(){},onConverted(){},...extra});

test('057 catalog accepts comma and redundant zeros exactly, while blank stays null and measures stay6',()=>{
  for(const[entered,canonical]of[['99999999999999,1234567890','99999999999999.1234567890'],['1.234500000000','1.2345'],['0,0000000001','0.0000000001'],['0','0.0000']])assert.equal(catalogData('products',{name:'Produto fictício',price:entered},[]).price,canonical);
  assert.equal(catalogData('products',{name:'Produto fictício',price:''},[]).price,null);
  assert.equal(CATALOG_FIELDS.products.find(f=>f.key==='price').max,80);
  for(const price of ['1.00000000001','100000000000000','0.'+'0'.repeat(79),'1,2,3'])assert.throws(()=>catalogData('products',{name:'P',price},[]));
  assert.throws(()=>catalogData('products',{name:'P',net_weight:'0.0000001'},[]));
});

test('057 real catalog editor freezes exact10 body through lost ACK and failed current read',async()=>{
  const product={id:contact,entity:'products',version:1,active:true,name:'Produto fictício',price:'1.0000',unit:'UN',code:null,source:null},calls=[],accepted=[];
  let writes=0,reads=0,body;
  // The product form first reads the complete product, the taxonomies (migration 119) and the custom field definitions (156);
  // only the save and its re-read count here.
  // The editor reads the session (optional integration capability) like the real AccessController exposes it.
  const controller={getSnapshot:()=>({phase:'ready',membership:{user_id:contact,role:'admin',resources:['products'],data_mode:'staging_readonly',capabilities:{originIntegration:false}}}),async catalog(path,opts={}){if(path==='/v1/cadastros/campos-customizados')return{module:'products',items:[],data_mode:'erp_native'};if(path.includes('/taxonomias/'))return{kind:{'categorias-produtos':'categories','grupos-produtos':'product_groups','grupos-tags':'tag_groups',tags:'tags'}[path.split('/').at(-1)],items:[],data_mode:'erp_native'};
   if(!opts.method&&path.endsWith('/completo'))return{entity:'products',record:product,data_mode:'erp_native'};calls.push({path,body:structuredClone(opts.body)});if(opts.method){body=opts.body;writes++;if(writes===1)throw new AccessError(503);return{record:{...product,version:2,price:body.data.price}};}if(++reads===1)throw new AccessError(503);return{record:{...product,version:2,price:body.data.price}};}};
  const view=await mountComponent('ProductEditor.tsx',{controller,entity:'products',record:product,writable:true,onSaved:r=>accepted.push(r),onClose(){}},{componentName:'ProductEditor',expandChildren:['ProductForm']});
  try{
    assert.equal(view.input('catalog-price').props.maxLength,80);await view.change('catalog-price','99999999999999,1234567890');const stale=view.input('catalog-price');await view.submit();
    assert.equal(view.guard().busy,true);assert.equal(view.input('catalog-price').disabled,true);stale.props.onChange({target:{value:'0'}});await view.flush();
    await view.click('Conferir resultado');assert.equal(writes,2);assert.equal(reads,1);assert.equal(accepted.length,0);
    await view.click('Conferir resultado');assert.equal(writes,2);assert.equal(reads,2);assert.equal(accepted[0].price,'99999999999999.1234567890');
    assert.deepEqual(calls[0].body,calls[1].body);assert.equal(calls[0].body.data.price,'99999999999999.1234567890');
  }finally{view.unmount();}
});

test('057 document form, exact total and public print preserve ten decimals without introducing dirty state',async()=>{
  const saved=savedPrice(),body=documentInput(saved),model=documentPrintModel(saved);
  assert.equal(saved.totals.total,'0.01');assert.equal(documentValidation(saved.kind,body),null);
  assert.equal(documentDecimalInput(documentDecimalDisplay(body.items[0].unit_price)),'0.0000000001');
  assert.deepEqual(documentFormValues(body),documentFormValues({...body,items:body.items.map(i=>({...i,quantity:'100000000.000000'}))}));
  assert.equal(model.items[0].price,'R$ 0,0000000001');
  const sheet=await mountComponent('DocumentPrintPreview.tsx',{model},{componentName:'DocumentPrintSheet',expandChildren:['PublicText']});
  try{assert.match(sheet.text(),/R\$ 0,0000000001/);assert.doesNotMatch(sheet.text(),/INTERNAL_PRIVATE_054/);}finally{sheet.unmount();}
  const controller={getSnapshot:()=>({membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]})};
  const view=await mountComponent('RealDocuments.tsx',editorProps(controller,saved),{componentName:'Editor'});
  try{assert.equal(view.guard().changed,false);assert.equal(priceField(view).props.value,'0,0000000001');assert.equal(priceField(view).props.maxLength,80);await priceChange(view,'0,0000000001000');assert.equal(view.guard().changed,false);assert.match(view.text(),/R\$ 0,01/);}finally{view.unmount();}
});

test('057 native document recovery keeps the precise body and reads current state before reopening',async()=>{
  const saved=savedPrice(),calls=[],accepted=[];let writes=0,reads=0,body;
  const controller={getSnapshot:()=>({membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documents(path,opts={}){
    if(opts.method){calls.push(structuredClone(opts.body));body=opts.body.data;if(++writes===1)throw new AccessError(503);return{document:record(saved.kind,body,2)};}
    if(++reads===1)throw new AccessError(503);return{document:record(saved.kind,body,2)};
  }};
  let view=await mountComponent('RealDocuments.tsx',editorProps(controller,saved,{onSaved:r=>accepted.push(r)}),{componentName:'Editor'});
  try{await priceChange(view,'0,0000000002');const stale=priceField(view);await view.submit();assert.equal(priceField(view).disabled,true);stale.props.onChange({target:{value:'9'}});await view.flush();await view.click('Conferir resultado');assert.equal(accepted.length,0);await view.click('Conferir resultado');assert.equal(writes,2);assert.equal(reads,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].data.items[0].unit_price,'0.0000000002');assert.equal(accepted[0].totals.total,'0.02');}finally{view.unmount();}
  view=await mountComponent('RealDocuments.tsx',editorProps(controller,accepted[0]),{componentName:'Editor'});
  try{assert.equal(view.guard().changed,false);assert.equal(priceField(view).props.value,'0,0000000002');}finally{view.unmount();}
});

test('057 product selection refuses catalog integer overflow and keeps null distinct from zero',async()=>{
  const saved=savedPrice('12.3456789012','1'),controller={getSnapshot:()=>({membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:['products'],write:[]})};
  const view=await mountComponent('RealDocuments.tsx',editorProps(controller,saved),{componentName:'Editor'});
  try{
    const picker=()=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name==='CatalogPicker'&&n.props.entity==='products');
    picker().props.onSelect({id:contact,name:'Preço fora do documento',unit:'UN',price:'10000000000.0000'});await view.flush();
    assert.match(view.text(),/Nenhum item foi incluído/);assert.equal(view.guard().changed,false);assert.equal(view.nodes().filter(n=>n.type==='input'&&/^Preço do item/.test(n.props['aria-label']||'')).length,1);
    picker().props.onSelect({id:contact,name:'Produto sem preço',unit:'UN',price:null});await view.flush();
    const missing=view.find(n=>n.type==='input'&&n.props['aria-label']==='Preço do item 2');assert.equal(missing.props.value,'');
    picker().props.onSelect({id:contact,name:'Preço exato',unit:'UN',price:'0.0000000001'});await view.flush();assert.equal(view.find(n=>n.type==='input'&&n.props['aria-label']==='Preço do item 3').props.value,'0,0000000001');
  }finally{view.unmount();}
  for(const price of ['10000000000.0000','0.00000000001','']){const body=documentInput(saved);body.items[0].unit_price=price;assert.match(documentValidation(saved.kind,body),/preço unitário/);}
});

test('057 copied draft keeps source price10 and uses the same normalization for all native kinds',async()=>{
  const saved=savedPrice('1.2345678901','2');for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders'])assert.equal(normalizeDocument(kind,documentInput(saved)).items[0].unit_price,'1.2345678901');
  let captured;const controller={getSnapshot:()=>({membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documentCopy(path,opts){captured=opts.body;throw new AccessError(409);}};
  const data=documentInput(saved),copyDraft={preview:{source:{id:saved.id,kind:saved.kind,number:saved.number,version:1},data,reset_fields:[],persisted:false,data_mode:'erp_native',operational_effects:false},contact:{id:contact,name:'Contato fictício'}};
  const view=await mountComponent('RealDocuments.tsx',editorProps(controller,saved,{record:null,copyDraft}),{componentName:'Editor'});
  try{await view.submit();assert.equal(captured.data.items[0].unit_price,'1.2345678901');assert.equal(captured.expected_source_version,1);assert.equal(data.items[0].unit_price,'1.2345678901');}finally{view.unmount();}
});

test('057 fiscal snapshot review displays all ten commercial price digits',async()=>{
  const value=reviewBasis().draft;value.record.snapshot.items[0].unit_price='10.1234567890';
  const view=await mountComponent('RealFiscalDrafts.tsx',{value},{componentName:'SnapshotReview'});
  try{assert.match(view.text(),/R\$ 10,1234567890/);assert.doesNotMatch(view.text(),/Indisponível/);assert.equal(value.record.snapshot.items[0].unit_price,'10.1234567890');}finally{view.unmount();}
});
