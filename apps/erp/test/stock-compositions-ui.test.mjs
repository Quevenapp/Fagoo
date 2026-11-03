import test from 'node:test';
import assert from 'node:assert/strict';
import {AccessError,mountComponent} from './helpers/component-recovery-harness.mjs';
import {lineTotal,parseComposition,structureKey,structurePayload,sumTotals,totalText,NEW_STRUCTURE} from '../src/lib/stock-composition-model.ts';
import {exportCsv} from '../src/lib/product-form-model.ts';

// Estoque lane, wave D (222/223): the Estrutura tab of the product form, the composition in the extrato (saldo virtual, Novo
// Lançamento and joint reversal) and the export of structures. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const KIT='a9000000-0000-4000-8000-0000000000e1',A='a9000000-0000-4000-8000-0000000000a1',B='a9000000-0000-4000-8000-0000000000b1';
const W='b9000000-0000-4000-8000-000000000001',M='f9000000-0000-4000-8000-000000000001';
const composition=(patch={})=>({scope:'stock_composition',data_mode:'erp_native',stock_visible:true,used_in:0,
 product:{id:KIT,name:'Kit presente',code:'KIT-1',kind:'P',format:'E',unit:'UN',active:true,version:3,price:'30.0000000000',net_weight:null,gross_weight:null,cost_price:null,default_supplier:false},
 composition:null,items:[],totals:{items:0,sale:'0.0000000000',unpriced:0,cost:'0.0000000000',uncosted:0,net_weight:'0.000000',gross_weight:'0.000000',weighted:0},virtual:null,
 settings:{update_cost:false,update_weight:false,update_price:false},...patch});
const option={id:A,name:'Caneca',code:'CAN-1',unit:'UN',price:'12.5000000000',cost_price:'4.2500000000',stock:'9.000000'};
const find=(view,label)=>view.find(n=>n.props?.['aria-label']===label);
const record={id:KIT,entity:'products',version:3,active:true,name:'Kit presente',code:'KIT-1',unit:'UN',kind:'P',format:'E'};

test('222 model: payload of the Estrutura, exact totals and the guard key',()=>{
 const draft={stock_type:'physical',post_mode:'both',rows:[{component_id:A,name:'Caneca',code:'CAN-1',unit:'UN',quantity:'2,5',price:'12.5000000000',cost_price:'4.2500000000',stock:null,problem:null}]};
 assert.deepEqual(structurePayload(draft,4),{expected_version:4,stock_type:'physical',post_mode:'both',items:[{component_id:A,quantity:'2.5'}]});
 assert.throws(()=>structurePayload({...draft,stock_type:'virtual'},4),/Virtual, o estoque é lançado nos componentes/);
 assert.throws(()=>structurePayload({...draft,rows:[{...draft.rows[0],quantity:'0'}]},4),/maior que zero/);
 assert.throws(()=>structurePayload({...draft,rows:[draft.rows[0],draft.rows[0]]},4),/já está na estrutura/);
 assert.throws(()=>structurePayload({...draft,rows:[{...draft.rows[0],component_id:''}]},4),/Selecione o componente/);
 assert.equal(totalText(lineTotal('12.5000000000','2,5')),'R$ 31,25');assert.equal(totalText(lineTotal('0.3333333333','3')),'R$ 1,00');
 assert.equal(totalText(sumTotals([lineTotal('1.0050000000','1'),null])),'R$ 1,01');assert.equal(totalText(null),'-');
 assert.equal(structureKey({...draft,rows:[{...draft.rows[0],stock:'5.000000'}]}),structureKey(draft),'display data is not an unsaved change');
 const view=parseComposition(composition({composition:{stock_type:'virtual',post_mode:'components',version:2,updated_at:'2026-10-20T12:00:00Z'},
  items:[{position:1,component_id:A,name:'Caneca',code:'CAN-1',unit:'UN',kind:'P',format:'S',active:true,problem:null,quantity:'2.000000',price:'12.5000000000',cost_price:null,stock:'9.000000'}],
  virtual:{quantity:'4.000000',warehouses:[{warehouse_id:W,name:'Geral',active:true,ignored:false,quantity:'4.000000'}]}}),KIT);
 assert.equal(view.virtual.quantity,'4.000000');assert.throws(()=>parseComposition(composition(),A));
});

test('222 Estrutura tab: a mirrored composition without structure, the Componente autocomplete and the save with the product',async()=>{
 const calls=[];let answer='ok';
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'e9000000-0000-4000-8000-000000000001'}}),
  async stock(path,request={}){calls.push({path,method:request.method});const url=new URL(path,'https://synthetic.invalid');
   if(url.pathname===`/v1/estoque/composicoes/${KIT}`)return composition();
   if(url.pathname==='/v1/estoque/composicoes/componentes')return{scope:'stock_composition_components',data_mode:'erp_native',query:url.searchParams.get('q'),stock_visible:true,total:1,items:[option]};
   throw new Error(path);},
  async catalog(path,request={}){calls.push({path,method:request.method,body:request.body&&structuredClone(request.body)});
   const taxonomy=/^\/v1\/cadastros\/taxonomias\/([a-z-]+)$/.exec(path);
   if(taxonomy)return{kind:{'categorias-produtos':'categories','grupos-produtos':'product_groups','grupos-tags':'tag_groups',tags:'tags'}[taxonomy[1]],items:[],data_mode:'erp_native'};
   if(path.endsWith('/check'))return{entity:'products',warnings:[],data_mode:'erp_native'};
   if(request.method){if(answer==='lost')throw new AccessError(503);return{entity:'products',record,composition:{},applied:{},synced:[],replayed:false,data_mode:'erp_native'};}
   return{entity:'products',record,data_mode:'erp_native'};}};
 const view=await mountComponent('ProductEditor.tsx',{controller,entity:'products',record,writable:true,onSaved(){},onClose(){}},{componentName:'ProductEditor',expandChildren:['ProductForm','ProductStructurePanel','ComponentSearch']});
 try{
  assert.match(view.text(),/Composição: os componentes, o tipo de estoque/);
  await view.click('Estrutura');
  assert.match(view.text(),/As composições espelhadas do Origin chegam sem a estrutura/);
  assert.match(view.text(),/Tipo de estoque.*Lançar estoque/);
  assert.match(view.text(),/salve-o como Físico e zere esse saldo com um Balanço antes de mudar para Virtual/,'the server refuses Virtual for a product with its own balance');
  assert.match(view.text(),/nºComponenteCódigo \(SKU\)QtdeEstoquePreço custoPreço custo totalPreço vendaPreço venda total/);
  assert.equal(view.input('composition-post-mode').disabled,true,'Virtual always posts the components');
  assert.equal(view.guard().changed,false,'loading the structure is not a change');
  await view.click('Adicionar outro item');
  find(view,'Componente da linha 1').props.onChange({target:{value:'Can'}});await view.flush();await new Promise(r=>setTimeout(r,300));await view.flush();
  view.find(n=>n.type==='button'&&n.props.role==='option').props.onClick();await view.flush();
  assert.match(view.text(),/CanecaCAN-1/);assert.match(view.text(),/Preço Total de VendaR\$ 12,50Preço Total de CustoR\$ 4,25/);
  find(view,'Quantidade do componente da linha 1').props.onChange({target:{value:'2'}});await view.flush();
  assert.equal(view.guard().changed,true);
  answer='lost';await view.submit();
  const first=calls.filter(call=>call.path===`/v1/cadastros/products/${KIT}/completo`).at(-1);
  assert.deepEqual(first.body.data.composition,{expected_version:0,stock_type:'virtual',post_mode:'components',items:[{component_id:A,quantity:'2'}]});
  assert.equal(Object.hasOwn(calls.find(call=>call.path==='/v1/cadastros/products/check')?.body?.data??{},'composition'),false,'the duplicate check never sees the structure');
  assert.match(view.text(),/Conferir resultado/);
  answer='ok';await view.click('Conferir resultado');
  const second=calls.filter(call=>call.path===`/v1/cadastros/products/${KIT}/completo`).at(-1);
  assert.equal(second.body.command_id,first.body.command_id,'the same command');assert.deepEqual(second.body,first.body);
 }finally{view.unmount();}
});

test('222 a component used by compositions with an update option on is saved with composition_sync',async()=>{
 const calls=[],simple={...record,id:A,name:'Caneca',format:'S'};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'admin',user_id:'e9000000-0000-4000-8000-000000000001'}}),
  async stock(path){if(path===`/v1/estoque/composicoes/${A}`)return composition({product:{...composition().product,id:A,format:'S'},used_in:2,settings:{update_cost:false,update_weight:false,update_price:true}});throw new Error(path);},
  async catalog(path,request={}){calls.push({path,method:request.method,body:request.body&&structuredClone(request.body)});
   if(/taxonomias/.test(path))return{kind:'categories',items:[],data_mode:'erp_native'};
   if(path.endsWith('/check'))return{entity:'products',warnings:[],data_mode:'erp_native'};
   return{entity:'products',record:simple,synced:[],applied:{},composition:null,replayed:false,data_mode:'erp_native'};}};
 const view=await mountComponent('ProductEditor.tsx',{controller,entity:'products',record:simple,writable:true,onSaved(){},onClose(){}},{componentName:'ProductEditor',expandChildren:['ProductForm']});
 try{
  assert.throws(()=>view.button('Estrutura'),'no Estrutura tab for a simple product');
  await view.change('catalog-price','13');await view.submit();
  const save=calls.find(call=>call.path===`/v1/cadastros/products/${A}/completo`&&call.method);
  assert.equal(save.body.data.composition_sync,true);assert.equal(Object.hasOwn(save.body.data,'composition'),false);
 }finally{view.unmount();}
});

test('222 extrato: the composition box, the Novo Lançamento of the composition and its joint reversal keep the command on uncertainty',async()=>{
 const calls=[];let lost=true;
 const controller={async stock(path,request={}){calls.push({path,method:request.method,body:request.body&&structuredClone(request.body)});
   if(lost){lost=false;throw new AccessError(503);}
   if(path===`/v1/estoque/composicoes/${KIT}/lancamentos`)return{scope:'stock_composition_launch',data_mode:'erp_native',kind:request.body.kind,occurred_on:'2026-10-20',movement:{id:M},
    composition:{product_id:KIT,stock_type:'virtual',post_mode:'components',version:1},lines:[{product_id:A,role:'component',per_kit:'2.000000',quantity:'-6.000000'}],detail:null,replayed:false};
   if(path===`/v1/estoque/movimentos/${M}/estorno`)return{movement:{id:'f9000000-0000-4000-8000-000000000002',kind:'reversal',reverses_id:M},replayed:false,data_mode:'erp_native'};
   throw new Error(path);}};
 const view=parseComposition(composition({composition:{stock_type:'virtual',post_mode:'components',version:1,updated_at:'2026-10-20T12:00:00Z'},
  items:[{position:1,component_id:A,name:'Caneca',code:'CAN-1',unit:'UN',kind:'P',format:'S',active:true,problem:null,quantity:'2.000000',price:null,cost_price:null,stock:'9.000000'}],
  virtual:{quantity:'4.000000',warehouses:[{warehouse_id:W,name:'Geral',active:true,ignored:false,quantity:'4.000000'}]}}),KIT);
 const saved=[];
 const panel=await mountComponent('StockComposition.tsx',{controller,product:record,view,warehouse:{warehouse_id:W,warehouse_name:'Geral',warehouse_active:true,quantity:'0.000000',version:0,unit:'UN'},readReady:true,onClose(){},onRefresh(){},onSaved:result=>saved.push(result)},{componentName:'CompositionLaunchPanel',expandChildren:['StockSidePanel']});
 try{
  assert.match(panel.text(),/Caneca: 2 por composição/);
  await panel.change('composition-launch-kind','issue');await panel.change('composition-launch-quantity','3');await panel.change('composition-launch-note','Venda balcão');
  await panel.click('Incluir');assert.match(panel.text(),/Conferir resultado/);
  await panel.click('Conferir resultado');
  const posts=calls.filter(call=>call.path===`/v1/estoque/composicoes/${KIT}/lancamentos`);
  assert.equal(posts.length,2);assert.deepEqual(posts[1].body,posts[0].body,'same command and body');
  const {command_id,...body}=posts[0].body;assert.deepEqual(body,{kind:'issue',warehouse_id:W,quantity:'3',note:'Venda balcão',expected_version:null});
  assert.equal(saved[0].lines[0].quantity,'-6.000000');
 }finally{panel.unmount();}
 const box=await mountComponent('StockComposition.tsx',{view,error:false,writable:true,onReverse(){},launches:[{movement_id:M,kind:'issue',occurred_on:'2026-10-20',note:'Venda balcão',reversed_by:null,lines:[{product_id:A,name:'Caneca',warehouse_id:W,quantity:'-6.000000',expected_version:3}]}]},{componentName:'StockCompositionBox'});
 try{assert.match(box.text(),/Tipo de estoque: Virtual · Lançar estoque: Componentes/);assert.match(box.text(),/Estoque virtual: 4/);assert.match(box.text(),/Estornar lançamento/);}finally{box.unmount();}
 lost=true;const reversals=[];
 const reverse=await mountComponent('StockComposition.tsx',{controller,launch:{movement_id:M,kind:'issue',occurred_on:'2026-10-20',note:'Venda',reversed_by:null,lines:[{product_id:A,name:'Caneca',warehouse_id:W,quantity:'-6.000000',expected_version:3}]},onClose(){},onSaved:()=>reversals.push(true)},{componentName:'CompositionReversalPanel',expandChildren:['StockSidePanel']});
 try{
  await reverse.change('composition-reversal-reason','Lançado errado');await reverse.click('Estornar');await reverse.click('Conferir resultado');
  const sent=calls.filter(call=>call.path===`/v1/estoque/movimentos/${M}/estorno`);
  assert.equal(sent.length,2);assert.deepEqual(sent[1].body,sent[0].body);assert.deepEqual(sent[0].body.versions,[{product_id:A,warehouse_id:W,expected_version:3}]);
  assert.equal(reversals.length,1);
 }finally{reverse.unmount();}
});

test('222 Físico composition: the Balanço of its own stock goes through the common lançamento, the components do not move',async()=>{
 const calls=[];
 const controller={async stock(path,request={}){calls.push({path,body:structuredClone(request.body)});
  return{scope:'stock_launch',data_mode:'erp_native',kind:'balance',occurred_on:'2026-10-20',movement:{id:M,kind:'adjustment',occurred_on:'2026-10-20',reason:'Lançamento manual',reference:null,created_at:'2026-10-20T12:00:00Z',reverses_id:null,reversed_by:null,
   items:[{product_id:KIT,warehouse_id:W,quantity:'2.000000',unit:'UN',balance_after:'5.000000',balance_version:4}]},detail:{revision:1,unit_price:null,unit_cost:null,note:'Lançamento manual'},
   balance:{counted:'5.000000',previous:'3.000000',warehouse_id:W,source:'launch'},replayed:false};}};
 const view=parseComposition(composition({composition:{stock_type:'physical',post_mode:'components',version:1,updated_at:'2026-10-20T12:00:00Z'},
  items:[{position:1,component_id:A,name:'Caneca',code:'CAN-1',unit:'UN',kind:'P',format:'S',active:true,problem:null,quantity:'2.000000',price:null,cost_price:null,stock:'9.000000'}]}),KIT);
 const saved=[];
 const panel=await mountComponent('StockComposition.tsx',{controller,product:record,view,warehouse:{warehouse_id:W,warehouse_name:'Geral',warehouse_active:true,quantity:'3.000000',version:3,unit:'UN'},readReady:true,onClose(){},onRefresh(){},onSaved:result=>saved.push(result)},{componentName:'CompositionLaunchPanel',expandChildren:['StockSidePanel']});
 try{
  await panel.change('composition-launch-kind','balance');await panel.change('composition-launch-quantity','5');await panel.click('Incluir');
  assert.equal(calls[0].path,'/v1/estoque/lancamentos');
  const {command_id,...body}=calls[0].body;assert.deepEqual([body.kind,body.product_id,body.warehouse_id,body.quantity,body.expected_version],['balance',KIT,W,'5',3]);
  assert.deepEqual(saved,[{kind:'balance',replayed:false}]);
 }finally{panel.unmount();}
});

test('222 Exportação de estruturas: same screen with tipo=estrutura, files of 500 and the Estrutura columns',async()=>{
 const calls=[];
 const controller={async stock(path){calls.push(path);const q=new URL(path,'https://synthetic.invalid').searchParams;const offset=Number(q.get('offset')),limit=Number(q.get('limit'));
   return{scope:'stock_composition_export',data_mode:'erp_native',offset,limit,include_deleted:q.get('incluir_excluidos')==='true',total:501,items:[]};},async catalog(){throw new Error('catalog');}};
 const view=await mountComponent('ProductExport.tsx',{controller},{location:'/exportacao-produtos?tipo=estrutura',expandChildren:['StructureExport']});
 try{
  assert.match(view.text(),/Exportação de estruturas/);assert.match(view.text(),/501 componentes nas estruturas/);assert.match(view.text(),/1 a 500Download501 a 501Download/);
  assert.equal(calls[0],'/v1/estoque/composicoes/exportacao?offset=0&limit=1&incluir_excluidos=false');
 }finally{view.unmount();}
 const {STRUCTURE_COLUMNS}=await import('../src/components/StructureExport.tsx').catch(()=>({STRUCTURE_COLUMNS:null}));
 if(STRUCTURE_COLUMNS){const csv=exportCsv([{product_code:'KIT-1',product_name:'Kit',stock_type:'virtual',post_mode:'components',position:1,component_code:'CAN-1',component_name:'Caneca',component_unit:'UN',quantity:'2.500000',product_deleted:false}],STRUCTURE_COLUMNS);
  assert.match(csv,/KIT-1;Kit;Virtual;Componentes;1;CAN-1;Caneca;UN;2,5;/);}
 assert.deepEqual(NEW_STRUCTURE,{stock_type:'virtual',post_mode:'components',rows:[]});
});
