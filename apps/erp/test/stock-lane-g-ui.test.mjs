import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {conversionText,factorInput,parseInvoiceStockPreview,parseInvoiceUnits,parseInvoiceUnitSave,unitRuleText} from '../src/lib/invoice-stock-model.ts';
import {documentStockLotsText} from '../src/lib/document-stock-model.ts';

// Estoque lane, wave G: "Conversão de unidades" of the Lançar estoque of an entry note (295, NFE-203) and the lots of the items in the
// conferência of the stock of a document (296). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const N='f1000000-0000-4000-8000-000000000001',W='f2000000-0000-4000-8000-000000000001',P='f3000000-0000-4000-8000-000000000001',Q='f3000000-0000-4000-8000-000000000002',S='f4000000-0000-4000-8000-000000000001';
const invoice={id:N,model:'55',direction:'0',screen:'nfe_entrada',number:77,series:1,status:1,version:2,label:'NF-e 000077',issue_date:'2026-10-20',exit_date:null,deleted:false};
const none={flag:null,warehouse:null,posting_id:null,posting_version:null,source:null,reference:null};
const state={scope:'stock_invoice',data_mode:'erp_native',invoice,flag:none,block:null,can_manage:true,occurred_on:'2026-10-20',date_mode:'data_atual',default_warehouse:{id:W,name:'Geral'},checkin_post:false,postings:[]};
const item=(over={})=>({position:1,description:'Caixa de parafusos',unit:'CX',quantity:'2.000000',product:{id:P,name:'Parafuso',code:'PAR-1',unit:'UN'},tax:null,factor:null,rule:null,converted_quantity:null,problem:null,...over});
const unitsOf=(items=[item()],over={})=>({scope:'stock_invoice_units',data_mode:'erp_native',invoice,supplier:{id:S,name:'Fornecedor sintético'},can_manage:true,total:items.length,items,...over});
const previewOf=()=>({scope:'stock_invoice_preview',data_mode:'erp_native',preview:{action:'post',source:'invoice',invoice,direction:'receipt',occurred_on:'2026-10-20',reason:'Lançamento de estoque da NF-e 000077',
 warehouse:{id:W,name:'Geral',version:1,active:true},positions:[{product_id:P,product_name:'Parafuso',catalog_version:1,warehouse_id:W,unit:'UN',quantity:'24.000000',balance_before:'0.000000',balance_after:'24.000000',expected_version:0,
  sources:[{position:1,quantity:'24.000000',invoice_quantity:'2.000000',invoice_unit:'CX',conversion:'supplier',factor:'12.000000'}]}],ignored:[],preview_hash:'c'.repeat(64)}});

test('295 model: units, factor input, rule and conversion texts, converted sources of the prévia',()=>{
 const view=parseInvoiceUnits(unitsOf([item(),item({position:2,unit:'PCT',product:{id:Q,name:'Arruela',code:null,unit:'UN'},tax:{unit:'UN',quantity:'36.0000'},rule:'tax_unit',converted_quantity:'36.000000'})]),N);
 assert.deepEqual(view.items.map(i=>[i.position,i.rule,i.converted_quantity]),[[1,null,null],[2,'tax_unit','36.000000']]);
 assert.throws(()=>parseInvoiceUnits({...unitsOf(),invoice:{...invoice,id:W}},N));assert.throws(()=>parseInvoiceUnits({...unitsOf(),scope:'x'},N));
 assert.deepEqual(['12','12,5','0.000001','999999.999999'].map(factorInput),['12','12.5','0.000001','999999.999999']);
 for(const bad of['0','0,0','-1','1.1234567','1.000.000','1000000','abc',''])assert.throws(()=>factorInput(bad),/até 6 casas decimais/,bad);
 assert.equal(unitRuleText(item(),true),'Sem conversão: informe o fator de conversão.');
 assert.match(unitRuleText(item(),false),/não tem fornecedor do cadastro/);
 assert.equal(unitRuleText(item({rule:'supplier',factor:{factor:'12.500000',version:1},converted_quantity:'25.000000'}),true),'Fator de conversão do fornecedor: 1 CX = 12,5 UN.');
 assert.match(unitRuleText(item({rule:'supplier',factor:{factor:'0.333333',version:1},problem:'inexact'}),true),/mais de 6 casas decimais/);
 const p=parseInvoiceStockPreview(previewOf(),N,'stock_invoice_preview');
 assert.equal(conversionText(p.positions[0].sources[0],'UN'),'Item 1: 2 CX × 12 = 24 UN (fator do fornecedor)');
 assert.equal(conversionText({position:2,quantity:'36.000000',invoice_quantity:'3.000000',invoice_unit:'PCT',conversion:'tax_unit'},'UN'),'Item 2: 3 PCT = 36 UN (unidade tributária)');
 assert.equal(conversionText({position:3,quantity:'1.000000'},'UN'),null);
 const bad=previewOf();bad.preview.positions[0].sources[0].factor=undefined;assert.throws(()=>parseInvoiceStockPreview(bad,N,'stock_invoice_preview'));
 const saved=parseInvoiceUnitSave({scope:'stock_invoice_unit_save',data_mode:'erp_native',command_id:'k',position:1,after:{factor:'12.000000',version:1},replayed:false,units:unitsOf()},N,{command_id:'k',position:1});
 assert.deepEqual([saved.after,saved.replayed,saved.units.items.length],[{factor:'12.000000',version:1},false,1]);
 assert.throws(()=>parseInvoiceUnitSave({scope:'stock_invoice_unit_save',data_mode:'erp_native',command_id:'other',position:1,after:null,replayed:false,units:unitsOf()},N,{command_id:'k',position:1}));
});

function service({units=unitsOf(),fail=()=>null}={}){
 const calls=[];let current=structuredClone(units),writes=0;
 const stock=async(path,options={})=>{calls.push({path,method:options.method??'GET',body:options.body?structuredClone(options.body):undefined});
  if(path==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
  if(path===`/v1/estoque/notas-fiscais/${N}`)return state;
  if(path.endsWith('/unidades')&&(options.method??'GET')==='GET')return current;
  if(path.endsWith('/unidades')){writes++;const problem=fail(writes);if(problem)throw problem;const b=options.body;
   current=unitsOf([item(b.factor?{factor:{factor:Number(b.factor).toFixed(6),version:b.expected_version+1},rule:'supplier',converted_quantity:(2*Number(b.factor)).toFixed(6)}:{})]);
   return{scope:'stock_invoice_unit_save',data_mode:'erp_native',command_id:b.command_id,position:b.position,after:b.factor?current.items[0].factor:null,replayed:false,units:current};}
  if(path.endsWith('/previa'))return previewOf();
  throw new Error(path);};
 return{calls,saves:()=>calls.filter(c=>c.method==='POST'&&c.path.endsWith('/unidades')),controller:{stock}};
}
const mount=s=>mountComponent('InvoiceStock.tsx',{controller:s.controller,invoiceId:N,mode:'post',onClose(){},onDone(){}},{expandChildren:['StockSidePanel']});

test('295 Lançar estoque of an entry note: Conversão de unidades, Informar fator with Conferir resultado, then the converted conferência',async()=>{
 const s=service({fail:n=>n===1?new AccessError(503):null}),view=await mount(s);
 try{
  assert.match(view.text(),/Conversão de unidades/);assert.match(view.text(),/Fornecedor sintético/);
  assert.match(view.text(),/1 · Caixa de parafusosParafuso2 CX—Sem conversão: informe o fator de conversão\./);
  await view.click('Informar fator');
  assert.match(view.text(),/Fator de conversão: 1 CX =/);assert.equal(view.guard().changed,false,'nothing typed yet');
  await view.change('invoice-stock-factor','12,5');assert.equal(view.guard().changed,true,'a typed factor is an unsaved change');
  await view.change('invoice-stock-factor','0');await view.click('Salvar fator');
  assert.match(view.text(),/Informe um fator maior que zero/);assert.equal(s.saves().length,0,'refused before sending');
  await view.change('invoice-stock-factor','12,5');await view.click('Salvar fator');
  assert.match(view.text(),/Não foi possível confirmar o fator de conversão/);
  assert.equal(view.button('Conferir lançamento').disabled,true,'the lançamento waits for the factor result');
  await view.click('Conferir resultado');
  const [first,second]=s.saves();assert.deepEqual(first.body,second.body,'the same command');
  assert.deepEqual({...first.body,command_id:undefined},{command_id:undefined,position:1,expected_version:0,factor:'12.5'});
  assert.match(view.text(),/Fator de conversão gravado/);assert.match(view.text(),/Fator de conversão do fornecedor: 1 CX = 12,5 UN\./);assert.match(view.text(),/25 UN/);
  await view.click('Conferir lançamento');
  assert.match(view.text(),/Item 1: 2 CX × 12 = 24 UN \(fator do fornecedor\)/);
  // Remover fator sends null over the saved version.
  await view.click('Alterar fator');assert.equal(view.input('invoice-stock-factor').props.value,'12,5');
  await view.click('Remover fator');
  assert.deepEqual({...s.saves().at(-1).body,command_id:undefined},{command_id:undefined,position:1,expected_version:1,factor:null});
  assert.match(view.text(),/Fator de conversão removido/);
 }finally{view.unmount();}
});

test('295 Conversão de unidades: readers see no buttons, a note without supplier explains it, no item in another unit shows nothing, 409 reloads',async()=>{
 const reader=await mount(service({units:unitsOf([item()],{can_manage:false})}));
 try{assert.match(reader.text(),/Conversão de unidades/);assert.throws(()=>reader.button('Informar fator'),/Missing component control/);}finally{reader.unmount();}
 const anonymous=await mount(service({units:unitsOf([item()],{supplier:null})}));
 try{assert.match(anonymous.text(),/não tem um fornecedor do cadastro/);assert.throws(()=>anonymous.button('Informar fator'),/Missing component control/,'no enabled control that cannot save');}finally{anonymous.unmount();}
 const same=service({units:unitsOf([],{total:0})}),plain=await mount(same);
 try{assert.doesNotMatch(plain.text(),/Conversão de unidades/);}finally{plain.unmount();}
 const conflict=service({fail:()=>new AccessError(409)}),view=await mount(conflict);
 try{
  await view.click('Informar fator');await view.change('invoice-stock-factor','6');await view.click('Salvar fator');
  assert.match(view.text(),/mudou em outra operação/);
  assert.equal(conflict.calls.filter(c=>c.path.endsWith('/unidades')&&c.method==='GET').length,2,'the conversion is read again');
 }finally{view.unmount();}
});

test('296 the lots of the conferência of a document: Lotes, Sem lote and Lotes devolvidos, exact',async()=>{
 const lots=[{lot_id:'a',code:'A-1',expires_on:null,quantity:'-3.500000',balance_before:'5.000000',balance_after:'1.500000'},{lot_id:'b',code:'B-2',expires_on:null,quantity:'-1.000000',balance_before:'3.000000',balance_after:'2.000000'}];
 assert.equal(documentStockLotsText({quantity:'-5.500000',lots},'post'),'Lotes: A-1 (3,5), B-2 (1); sem lote: 1');
 assert.equal(documentStockLotsText({quantity:'-4.500000',lots},'post'),'Lotes: A-1 (3,5), B-2 (1)');
 assert.equal(documentStockLotsText({quantity:'4.500000',lots:lots.map(l=>({...l,quantity:l.quantity.slice(1)}))},'reverse'),'Lotes devolvidos: A-1 (3,5), B-2 (1)');
 assert.equal(documentStockLotsText({quantity:'1234.000001',lots:[{...lots[0],quantity:'1000.000001'}]},'post'),'Lotes: A-1 (1.000,000001); sem lote: 234');
 assert.equal(documentStockLotsText({quantity:'-1.000000'},'post'),null);
 const D='f5000000-0000-4000-8000-000000000001',summary={id:D,kind:'sales_orders',number:'12',version:3,status:'open',date:'2026-10-20',warehouse_id:W,eligible:true,active_posting_id:null};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'f6000000-0000-4000-8000-000000000001'}}),
  async stock(path){if(path==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};throw new Error(path);},
  async documentStock(path,request={}){if(path.endsWith('/preview'))return{data_mode:'erp_native',preview:{action:'post',document:summary,direction:'issue',occurred_on:request.body.occurred_on,reason:request.body.reason,
    warehouse:{id:W,name:'Geral',version:1,active:true},positions:[{product_id:P,product_name:'Parafuso',catalog_version:1,warehouse_id:W,unit:'UN',quantity:'-5.500000',balance_before:'10.000000',balance_after:'4.500000',expected_version:3,
     sources:[{id:'i1',position:1,quantity:'5.500000'}],lots:lots.map(l=>({...l,sources:[{id:'i1',position:1,quantity:l.quantity.slice(1)}]}))}],ignored:[],preview_hash:'d'.repeat(64)}};
   return{document:summary,items:[],active_posting:null,postings:[],limit:25,has_more:false,next_cursor:null,data_mode:'erp_native'};}};
 const view=await mountComponent('DocumentStock.tsx',{controller,record:{id:D,kind:'sales_orders',version:3},blocked:false,onChanged(){},onActive(){},onBusy(){},onDraft(){}});
 try{
  await view.change(view.find(n=>n.type==='input'&&String(n.props.id).endsWith('-reason')).props.id,'Saída com lotes');
  await view.click('Conferir lançamento de estoque');
  assert.match(view.text(),/ParafusoLotes: A-1 \(3,5\), B-2 \(1\); sem lote: 1/);
 }finally{view.unmount();}
});

test('295 review: an item without unit offers no Informar fator, and the check-in conferência shows each conversion',async()=>{
 assert.match(unitRuleText(item({unit:null}),true),/^Sem conversão: o item da nota não tem unidade/);
 assert.match(unitRuleText(item({unit:'  '}),false),/não tem unidade/);
 const s=service({units:unitsOf([item({unit:null}),item({position:2,unit:'PCT'})])}),view=await mount(s);
 try{
  assert.match(view.text(),/1 · Caixa de parafusosParafuso2 —— ?Sem conversão: o item da nota não tem unidade/);
  assert.equal(view.nodes().filter(n=>n.type==='button'&&['Informar fator','Alterar fator'].includes(String(n.props.children))).length,1,'only the item with a unit can take a factor');
 }finally{view.unmount();}
 const calls=[];
 const stock=async(path,options={})=>{calls.push(path);
  if(path==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
  if(path===`/v1/estoque/notas-fiscais/${N}`)return state;
  if(path.endsWith('/checkin/previa'))return{scope:'stock_checkin_post_preview',data_mode:'erp_native',checkin_version:options.body.expected_version,preview:{...previewOf().preview,source:'checkin'}};
  throw new Error(path);};
 const modal=await mountComponent('InvoiceStock.tsx',{controller:{stock},invoiceId:N,version:5,summary:{complete:1,issue:0,refused:0,pending:0},plainBusy:false,plainUncertain:false,
  onFinish(){},onClose(){},onPosted(){}},{componentName:'CheckinFinishModal',expandChildren:['Modal']});
 try{
  modal.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await modal.flush();
  await modal.click('Conferir lançamento');
  assert.ok(calls.some(path=>path.endsWith('/checkin/previa')));
  assert.match(modal.text(),/ParafusoItem 1: 2 CX × 12 = 24 UN \(fator do fornecedor\)24 UN/);
 }finally{modal.unmount();}
});
