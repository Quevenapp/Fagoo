import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {amendBody,entryPriceDecimals,launchBody,parseLaunchContext,parseReservations} from '../src/lib/stock-launch-model.ts';

// 277 (estoque, onda F): "Número de casas decimais no preço nas entradas" in the Novo Lançamento and in the edition of an entry, and the
// custom situation of a pedido reserved by its situation. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='71000000-0000-4000-8000-000000000011',A='72000000-0000-4000-8000-000000000011',M='73000000-0000-4000-8000-000000000011',S='74000000-0000-4000-8000-000000000011',D='75000000-0000-4000-8000-000000000011';
const product={id:P,entity:'products',name:'Produto decimais',code:'DEC-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'4'};
const balance={warehouse_id:A,warehouse_name:'Geral',warehouse_active:true,quantity:'8.000000',version:5,unit:'UN',warehouse_default:true,warehouse_ignored:false,reserved_quantity:'0.000000'};

test('277 entry decimals: Entrada and Balanço prices refuse more significant decimals; Saída and Transferência keep ten',()=>{
 const base={productId:P,warehouseId:A,expectedVersion:5,quantity:'2',unitCost:'1,5',note:'',entryDecimals:2};
 assert.equal(entryPriceDecimals('1.2300000',"Preço de Compra",2),'1.2300000');
 assert.throws(()=>entryPriceDecimals('1.234','Preço de Compra',2),/O Preço de Compra aceita até 2 casas decimais \(Preferências › Empresa › Geral\)\./);
 assert.throws(()=>entryPriceDecimals('1.5','Preço de Custo',0),/aceita até 0 casas decimais/);
 assert.throws(()=>entryPriceDecimals('1.55','Preço de Custo',1),/aceita até 1 casa decimal/);
 assert.equal(launchBody({...base,kind:'receipt',unitPrice:'1,23'}).unit_price,'1.23');
 assert.throws(()=>launchBody({...base,kind:'receipt',unitPrice:'1,234'}),/Preço de Compra aceita até 2/);
 assert.throws(()=>launchBody({...base,kind:'balance',unitPrice:'1',unitCost:'0,001'}),/Preço de Custo aceita até 2/);
 assert.equal(launchBody({...base,kind:'issue',unitPrice:'1,23456',unitCost:null}).unit_price,'1.23456');
 assert.equal(launchBody({...base,kind:'transfer',unitPrice:'1,23456',unitCost:'1,23456',destinationId:'72000000-0000-4000-8000-000000000012',destinationVersion:0}).unit_cost,'1.23456');
 assert.equal(launchBody({...base,kind:'receipt',unitPrice:'1,234',entryDecimals:undefined}).unit_price,'1.234','without the context the stored ten');
 // Edition of an entry: only a changed price or cost is checked (a stored price with more decimals may stay).
 const row={revision:1,balance:null,kind:'receipt',unit_price:'1.2345000000',unit_cost:'1.0000000000',items:[{product_id:P,quantity:'2.000000'}]};
 assert.equal(amendBody(row,P,'1,2345','1','Nova nota',2).unit_price,'1.2345');
 assert.throws(()=>amendBody(row,P,'1,2346','1','Nova nota',2),/Preço de Compra aceita até 2/);
 assert.throws(()=>amendBody(row,P,'1,2345','1,001','Nova nota',2),/Preço de Custo aceita até 2/);
 assert.equal(amendBody({...row,kind:'issue',items:[{product_id:P,quantity:'-2.000000'}]},P,'1,23456','','Saída',2).unit_price,'1.23456');
});

test('277 launch context: price_decimals from the API, ten from an older answer, anything else refused',()=>{
 const raw={scope:'stock_launch_context',data_mode:'erp_native',product_id:P,settings:{show_unit_price:true,price_type:'ultima_compra',consider_balances:false,average_cost_base:'preco_compra'},
  last_purchase:null,average_cost:null,sale_price:null,default_supplier:null};
 assert.deepEqual(parseLaunchContext({...raw,price_decimals:{entry:4}},P).price_decimals,{entry:4});
 assert.deepEqual(parseLaunchContext(raw,P).price_decimals,{entry:10});
 assert.throws(()=>parseLaunchContext({...raw,price_decimals:{entry:11}},P));
 assert.throws(()=>parseLaunchContext({...raw,price_decimals:{entry:1.5}},P));
});

test('277 Novo Lançamento shows the limit and refuses the extra decimals before any request',async()=>{
 const calls=[];const controller={async stock(path,options={}){calls.push({path,...options});throw new Error('no request expected');}};
 const view=await mountComponent('StockMovementPanel.tsx',{controller,product,warehouse:balance,readReady:true,suggestion:{sale:'4,00',purchase:'1,50',cost:'1,75'},entryDecimals:1,
  onClose(){},onSaved(){},onRefresh(){}},{componentName:'StockLaunchPanel',expandChildren:['StockSidePanel']});
 try{
  assert.match(view.text(),/Preço de Compra e Preço de Custo com até 1 casa decimal \(Preferências › Empresa › Geral\)\./);
  await view.change('stock-launch-quantity','3');await view.click('Incluir');
  assert.match(view.text(),/O Preço de Custo aceita até 1 casa decimal/,'1,75 has two decimals; 1,50 has one significant');assert.equal(calls.length,0);
  await view.change('stock-launch-cost','1,7');await view.change('stock-launch-price','1,55');await view.click('Incluir');
  assert.match(view.text(),/O Preço de Compra aceita até 1 casa decimal/);assert.equal(calls.length,0);
  await view.change('stock-launch-kind','issue');
  assert.doesNotMatch(view.text(),/com até 1 casa decimal/,'Saída (Preço de Venda) is not an entry');
 }finally{view.unmount();}
});

test('277 reservations: the custom situation of a pedido reserved by situation is read and kept with its name',()=>{
 const value={scope:'stock_product_reservations',data_mode:'erp_native',product_id:P,warehouse_id:null,total:1,quantity:'2.000000',
  reservation:{by_situation:true,by_warehouse:false,statuses:['verified'],situation_ids:[S]},
  items:[{reservation_id:null,source:'situation',document_id:D,document_number:'12',status:'open',contact_name:'Cliente sintético',warehouse_id:null,warehouse_ignored:false,
   quantity:'2.000000',unit:'UN',reserved_at:null,situation_id:S,situation_name:'Aguardando separação'}]};
 const parsed=parseReservations(value,P,null);
 assert.deepEqual([parsed.items[0].situation_id,parsed.items[0].situation_name,parsed.reservation.statuses],[S,'Aguardando separação',['verified']]);
 // An older answer without the fields still reads; an inconsistent name is refused.
 const older=structuredClone(value);delete older.items[0].situation_id;delete older.items[0].situation_name;
 assert.equal(parseReservations(older,P,null).items[0].situation_id,null);
 const broken=structuredClone(value);broken.items[0].situation_name=null;
 assert.throws(()=>parseReservations(broken,P,null));
});

test('277 Lançar estoque of a pedido does not ask the date: the day of Preferências › Suprimentos › Estoque goes in the conferência',async()=>{
 const D2='c7000000-0000-4000-8000-000000000277',W2='1e646bfd-45dc-4ec1-b5c0-568a201e3277',calls=[];
 const summary={id:D2,kind:'sales_orders',number:'32',version:4,status:'verified',date:'2026-10-14',warehouse_id:W2,eligible:true,active_posting_id:null};
 const preview=body=>({action:'post',document:summary,direction:'issue',occurred_on:body.occurred_on,reason:body.reason,warehouse:{id:W2,name:'Geral',version:1,active:true},
  positions:[{product_id:'d7000000-0000-4000-8000-000000000277',product_name:'Caneta',catalog_version:1,warehouse_id:W2,unit:'UN',quantity:'-1.000000',balance_before:'3.000000',balance_after:'2.000000',expected_version:2,sources:[]}],ignored:[],preview_hash:'c'.repeat(64)});
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'e7000000-0000-4000-8000-000000000277'}}),
  async stock(path){if(path==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W2,name:'Geral',active:true,is_default:true,ignore_balance:false}]};throw new Error(path);},
  async documentStock(path,request={}){calls.push({path,...request,body:request.body?structuredClone(request.body):undefined});
   if(path.endsWith('/preview'))return{preview:preview(request.body),data_mode:'erp_native'};
   return{document:summary,items:[],active_posting:null,postings:[],limit:25,has_more:false,next_cursor:null,data_mode:'erp_native'};}};
 const view=await mountComponent('DocumentStock.tsx',{controller,record:{id:D2,kind:'sales_orders',version:4},launchDay:'2026-10-14',blocked:false,onChanged(){},onActive(){},onBusy(){},onDraft(){}},{expandChildren:['StockDocumentWarehouse']});
 try{
  assert.equal(view.nodes().some(n=>n.type==='input'&&n.props.type==='date'),false,'no Data da movimentação to type');
  assert.match(view.text(),/Data da movimentação: 14\/10\/2026 \(“Ao lançar estoque utilizar data atual ou data entrada\/saída”/);
  await view.change(view.find(n=>n.type==='input'&&String(n.props.id).endsWith('-reason')).props.id,'Saída conferida');
  await view.click('Conferir lançamento de estoque');
  assert.equal(calls.find(call=>call.path.endsWith('/preview')).body.occurred_on,'2026-10-14');
 }finally{view.unmount();}
 // While the preference is unknown (no launchDay) the date is asked again instead of silently using today.
 const unknown=await mountComponent('DocumentStock.tsx',{controller,record:{id:D2,kind:'sales_orders',version:4},blocked:false,onChanged(){},onActive(){},onBusy(){},onDraft(){}},{expandChildren:['StockDocumentWarehouse']});
 try{assert.equal(unknown.nodes().some(n=>n.type==='input'&&n.props.type==='date'),true,'Data da movimentação is asked');assert.doesNotMatch(unknown.text(),/Ao lançar estoque utilizar data atual/);}
 finally{unknown.unmount();}
});
