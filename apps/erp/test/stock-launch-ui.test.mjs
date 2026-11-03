import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';

// Novo Lançamento, Lançamento de estoque (edição), Estorno and Transferência panels of migration 105 (synthetic data only).
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='71000000-0000-4000-8000-000000000001',A='72000000-0000-4000-8000-000000000001',B='72000000-0000-4000-8000-000000000002',M='73000000-0000-4000-8000-000000000001';
const product={id:P,entity:'products',name:'Produto painel',code:'PNL-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'4'};
const balance=(id=A,quantity='8.000000',version=5)=>({warehouse_id:id,warehouse_name:id===A?'Geral':'Loja',warehouse_active:true,quantity,version,unit:'UN',warehouse_default:id===A,warehouse_ignored:false,reserved_quantity:'0.000000'});
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const launchResult=body=>{const q=body.quantity,kind=body.kind;
 const items=kind==='transfer'?[{product_id:P,warehouse_id:body.warehouse_id,quantity:`-${q}.000000`,unit:'UN',balance_after:'6.000000',balance_version:6},{product_id:P,warehouse_id:body.destination_id,quantity:`${q}.000000`,unit:'UN',balance_after:`${q}.000000`,balance_version:1}]
  :[{product_id:P,warehouse_id:body.warehouse_id,quantity:kind==='balance'?'-3.000000':kind==='issue'?`-${q}.000000`:`${q}.000000`,unit:'UN',balance_after:'5.000000',balance_version:6}];
 return{scope:'stock_launch',data_mode:'erp_native',kind,occurred_on:'2026-10-20',replayed:false,movement:{id:M,items},detail:{revision:1,unit_price:'1.0000000000',unit_cost:kind==='issue'?null:'1.0000000000',note:body.note??'Lançamento manual'},
  balance:kind==='balance'?{counted:'5.000000',previous:'8.000000',warehouse_id:A}:null};};
function service({fail=()=>null}={}){
 const calls=[];let writes=0;
 const stock=async(path,options={})=>{calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});
  if(options.method){writes++;const problem=fail({path,...options},writes);if(problem)throw problem;
   if(path==='/v1/estoque/lancamentos')return launchResult(options.body);
   if(path.endsWith('/estorno'))return{movement:{id:'73000000-0000-4000-8000-000000000009',kind:'reversal',reverses_id:M},replayed:false,data_mode:'erp_native'};
   return{scope:'stock_amend',movement_id:M,product_id:P,detail:{revision:options.body.expected_revision+1,unit_price:'2.0000000000',unit_cost:'2.0000000000',note:options.body.note},replayed:false,data_mode:'erp_native'};}
  throw new Error('unexpected read');};
 return{calls,writes:()=>calls.filter(call=>call.method),controller:{stock}};
}
const suggestion={sale:'4,00',purchase:'1,50',cost:'1,75'};
const mountLaunch=(s,props={})=>mountComponent('StockMovementPanel.tsx',{controller:s.controller,product,warehouse:balance(),readReady:true,suggestion,onClose(){},onSaved:props.onSaved??(()=>{}),onRefresh(){},...props},{componentName:'StockLaunchPanel',expandChildren:['StockSidePanel']});

test('Novo Lançamento: Tipo Entrada by default with suggested prices; changing Tipo clears Quantidade; Incluir sends the exact command',async()=>{
 const s=service(),saved=[],view=await mountLaunch(s,{onSaved:value=>saved.push(value)});
 try{
  assert.equal(view.input('stock-launch-kind').props.value,'receipt');assert.equal(view.input('stock-launch-price').props.value,'1,50');assert.equal(view.input('stock-launch-cost').props.value,'1,75');
  assert.match(view.text(),/DepósitoGeralSaldo atual: 8 UN/);
  await view.change('stock-launch-quantity','3');await view.change('stock-launch-kind','issue');
  assert.equal(view.input('stock-launch-quantity').props.value,'','Origin clears the quantity');assert.equal(view.input('stock-launch-price').props.value,'4,00','Saída suggests the sale price');
  assert.equal(view.nodes().some(node=>node.props?.id==='stock-launch-cost'),false,'no Preço de Custo in Saída');
  assert.ok(view.nodes().some(node=>node.type==='label'&&textOf(node)==='Preço de Venda *'));
  await view.change('stock-launch-quantity','0');await view.click('Incluir');assert.match(view.text(),/Quantidade inválida!/);assert.equal(s.writes().length,0);
  await view.change('stock-launch-kind','balance');await view.change('stock-launch-quantity','5');await view.change('stock-launch-note','Contagem');await view.click('Incluir');
  const write=s.writes()[0];assert.equal(write.path,'/v1/estoque/lancamentos');assert.equal(write.method,'POST');
  const {command_id,...body}=write.body;assert.match(command_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(body,{kind:'balance',product_id:P,warehouse_id:A,quantity:'5',expected_version:5,unit_price:'1.50',note:'Contagem',unit_cost:'1.75'});
  assert.equal(saved.length,1);assert.equal(saved[0].balance.previous,'8.000000');
 }finally{view.unmount();}
});

test('Novo Lançamento recovery: a lost reply keeps the same UUID and body; a later rejection never releases it; known errors do',async()=>{
 const s=service({fail:(call,writes)=>writes===1?new AccessError(503):writes===2?new AccessError(409):null}),saved=[],view=await mountLaunch(s,{onSaved:value=>saved.push(value)});
 try{
  await view.change('stock-launch-quantity','2');await view.click('Incluir');
  assert.match(view.text(),/Não foi possível confirmar o resultado/);assert.equal(view.guard().busy,true);
  assert.equal(view.input('stock-launch-quantity').disabled,true,'fields stay frozen while the result is unknown');
  assert.equal(view.button('Cancelar').disabled,true);view.button('Cancelar').props.onClick();await view.flush();assert.ok(view.button('Conferir resultado'));
  await view.click('Conferir resultado');assert.equal(s.writes().length,2);assert.equal(saved.length,0);assert.ok(view.button('Conferir resultado'),'a 409 after an unknown result keeps the command');
  await view.click('Conferir resultado');assert.equal(saved.length,1);
  const bodies=s.writes().map(call=>call.body);assert.deepEqual(bodies[0],bodies[1]);assert.deepEqual(bodies[0],bodies[2]);
 }finally{view.unmount();}
 const known=service({fail:()=>new AccessError(400)}),released=await mountLaunch(known);
 try{await released.change('stock-launch-quantity','2');await released.click('Incluir');assert.match(released.text(),/estoque negativo/);assert.equal(released.guard().busy,false);
  await released.change('stock-launch-quantity','1');await released.click('Incluir');const [first,second]=known.writes();assert.notEqual(first.body.command_id,second.body.command_id,'a known rejection releases the UUID');}
 finally{released.unmount();}
});

test('Novo Lançamento cannot commit while the balance read is unavailable; leaving aborts a pending write',async()=>{
 const s=service(),view=await mountLaunch(s);
 try{
  await view.change('stock-launch-quantity','2');await view.updateProps({readReady:false});assert.equal(view.button('Incluir').disabled,true);
  view.button('Incluir').props.onClick();await view.flush();assert.equal(s.writes().length,0,'the handler checks the read too');
  await view.updateProps({readReady:true});await view.click('Incluir');assert.equal(s.writes().length,1);
 }finally{view.unmount();}
 let release;const pending=service({fail:()=>null});pending.controller.stock=async(path,options={})=>{pending.calls.push({path,...options});return new Promise(resolve=>{release=resolve;});};
 const saved=[],leaving=await mountLaunch(pending,{onSaved:value=>saved.push(value)});
 await leaving.change('stock-launch-quantity','2');await leaving.click('Incluir');const call=pending.calls[0];leaving.unmount();assert.equal(call.signal.aborted,true);
 release(launchResult(call.body));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(saved.length,0);
});

test('Lançamento de estoque: Depósito, Data, Hora, Tipo and Quantidade read-only; Salvar sends only prices and observação',async()=>{
 const s=service(),saved=[];
 const row={id:M,kind:'receipt',occurred_on:'2026-10-19',reason:'Lançamento manual',reference:null,created_at:'2026-10-19T15:04:05Z',recorded_at_local:'2026-10-19T12:04:05',reverses_id:null,reversed_by:null,other_items:0,
  origin:{type:'none',document_id:null,document_kind:null,document_number:null,via:null},items:[{product_id:P,warehouse_id:A,quantity:'10.000000',unit:'UN',balance_after:'10.000000',balance_version:1}],
  revision:1,note:'Compra',unit_price:'1.5000000000',unit_cost:'1.7500000000',price_source:'detail',balance:null};
 const reverse=[];const view=await mountComponent('StockMovementPanel.tsx',{controller:s.controller,product,row,warehouseName:()=>'Geral',writable:true,reversalBlock:null,onClose(){},onSaved:()=>saved.push(true),onReverse:()=>reverse.push(true)},{componentName:'StockEditPanel',expandChildren:['StockSidePanel']});
 try{
  assert.match(view.text(),/Mudança na forma de lançamento de estoque/);
  assert.match(view.text(),/DepósitoGeralData \*19\/10\/2026Hora12:04:05Tipo \*EntradaQuantidade \*10 UN/);
  assert.equal(view.input('stock-edit-price').props.value,'1,50');assert.equal(view.input('stock-edit-cost').props.value,'1,75');assert.equal(view.input('stock-edit-note').props.value,'Compra');
  await view.change('stock-edit-price','2');await view.change('stock-edit-note','Compra revisada');await view.click('Salvar');
  const write=s.writes()[0];assert.equal(write.path,`/v1/estoque/movimentos/${M}`);assert.equal(write.method,'PATCH');
  const {command_id,...body}=write.body;assert.deepEqual(body,{product_id:P,expected_revision:1,unit_price:'2',unit_cost:'1.75',note:'Compra revisada'});assert.equal(saved.length,1);
  await view.click('Estornar lançamento');assert.equal(reverse.length,1);
 }finally{view.unmount();}
 const readOnly=await mountComponent('StockMovementPanel.tsx',{controller:s.controller,product,row,warehouseName:()=>'Geral',writable:false,reversalBlock:null,onClose(){},onSaved(){},onReverse(){}},{componentName:'StockEditPanel',expandChildren:['StockSidePanel']});
 try{assert.equal(readOnly.nodes().some(node=>node.type==='button'&&textOf(node)==='Salvar'),false);assert.ok(readOnly.button('Fechar'));assert.equal(readOnly.input('stock-edit-price').disabled,true);
  assert.equal(readOnly.nodes().some(node=>node.type==='button'&&textOf(node)==='Estornar lançamento'),false);}finally{readOnly.unmount();}
 const blocked=await mountComponent('StockMovementPanel.tsx',{controller:s.controller,product,row:{...row,origin:{type:'sales',document_id:M,document_kind:'sales_orders',document_number:'3',via:'document_stock'}},warehouseName:()=>'Geral',writable:true,reversalBlock:'Estorne pelo documento de origem.',onClose(){},onSaved(){},onReverse(){}},{componentName:'StockEditPanel',expandChildren:['StockSidePanel']});
 try{const button=blocked.button('Estornar lançamento');assert.equal(button.disabled,true);assert.equal(button.props.title,'Estorne pelo documento de origem.');}finally{blocked.unmount();}
});

test('Estorno reviews then posts the opposite movement with the current versions; a stale read blocks it',async()=>{
 const s=service(),saved=[];
 const reversal={id:M,kind:'receipt',occurred_on:'2026-10-01',reason:'Compra',reference:null,created_at:'2026-10-01T12:00:00Z',reverses_id:null,reversed_by:null,items:[{product_id:P,warehouse_id:A,quantity:'10.000000',unit:'UN',balance_after:'10.000000',balance_version:1}]};
 const view=await mountComponent('StockMovementPanel.tsx',{controller:s.controller,product,balances:[balance()],readReady:true,reversal,onClose(){},onSaved:()=>saved.push(true),onRefresh(){}},{componentName:'StockReversalForm',expandChildren:['StockSidePanel']});
 try{
  await view.change('stock-reversal-reason','Erro de digitação');await view.submit();await view.click('Confirmar estorno');
  const write=s.writes()[0];assert.equal(write.path,`/v1/estoque/movimentos/${M}/estorno`);
  const {command_id,...body}=write.body;assert.equal(body.reason,'Erro de digitação');assert.deepEqual(body.versions,[{product_id:P,warehouse_id:A,expected_version:5}]);assert.equal(saved.length,1);
 }finally{view.unmount();}
});

test('Transferência entre depósitos: Preço un., Custo Un., origin and destination with balances; comprovante after saving',async()=>{
 const s=service(),saved=[];
 const view=await mountComponent('StockTransferPanel.tsx',{controller:s.controller,product,balances:[balance(),balance(B,'0.000000',0)],readReady:true,initialSource:A,suggestion,onClose(){},onSaved:value=>saved.push(value),onRefresh(){}},{expandChildren:['StockSidePanel','StockPrintPreview']});
 try{
  assert.equal(view.input('stock-transfer-source').props.value,A);assert.equal(view.input('stock-transfer-destination').props.value,B,'the destination is recalculated from the origin');
  assert.equal(view.input('stock-transfer-note').props.value,'Transferência');assert.match(view.text(),/Saldo: 8 UN.*Saldo: sem lançamentos/);
  await view.change('stock-transfer-quantity','2');await view.click('Salvar');
  const {command_id,...body}=s.writes()[0].body;
  assert.deepEqual(body,{kind:'transfer',product_id:P,warehouse_id:A,quantity:'2',expected_version:5,unit_price:'1.50',note:'Transferência',unit_cost:'1.75',destination_id:B,destination_version:0});
  assert.equal(saved.length,1);assert.match(view.text(),/Transferência registrada\./);
  await view.click('IMPRIMIR COMPROVANTE TRANSFERÊNCIA');
  assert.match(view.text(),/Comprovante de transferência entre depósitos.*PNL-1 - Produto painel.*Quantidade2 UN.*Depósito de origemGeral.*Depósito de destinoLoja.*Responsável pela saída/);
 }finally{view.unmount();}
});

test('from the extrato: Incluir lançamento opens the panel in the header depósito and a saved launch reloads the balances',async()=>{
 const reads=[];const s=service();const base=s.controller.stock;
 s.controller.stock=async(path,options={})=>{if(options.method)return base(path,options);reads.push(path);const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
  if(url.pathname==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:q.get('warehouse_id'),quantity:'8.000000',sale_value:'32.00',unpriced_products:0,ignored_warehouses:0,warehouses:[{id:A,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:B,name:'Loja',active:true,is_default:false,ignore_balance:false}]};
  if(url.pathname==='/v1/estoque/saldos')return{product_id:P,items:[balance(),balance(B,'0.000000',0)],data_mode:'erp_native'};
  return{product_id:P,items:[],limit:100,offset:0,total:0,has_more:false,next_offset:null,filters:{},totals:{entries:'0.000000',exits:'0.000000',current_balance:'8.000000',unit:'UN'},data_mode:'erp_native'};};
 const controller={...s.controller,getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:'74000000-0000-4000-8000-000000000001'}}),async catalog(){return{record:product};}};
 const view=await mountComponent('RealStock.tsx',{controller},{location:`/estoque-empresa?produto=${P}`});
 try{
  await view.flush();await view.click('Incluir lançamento');
  const panel=view.nodes().find(node=>typeof node.type==='function'&&node.type.name==='StockLaunchPanel');
  assert.equal(panel.props.warehouse.warehouse_id,A);assert.equal(panel.props.suggestion.sale,'4,00');
  const before=reads.filter(path=>path.startsWith('/v1/estoque/saldos')).length;
  panel.props.onSaved({kind:'receipt',replayed:false});await view.flush();
  assert.match(view.text(),/Lançamento registrado\./);assert.equal(reads.filter(path=>path.startsWith('/v1/estoque/saldos')).length,before+1);
  assert.equal(view.nodes().some(node=>typeof node.type==='function'&&node.type.name==='StockLaunchPanel'),false);
  view.find(node=>node.type==='button'&&textOf(node)==='Transferência entre depósitos').props.onClick();await view.flush();
  assert.equal(view.nodes().find(node=>typeof node.type==='function'&&node.type.name==='StockTransferPanel').props.initialSource,A);
 }finally{view.unmount();}
});

test('from the extrato: a lançamento of a document the profile cannot read opens without price editing (105)',async()=>{
 const s=service();
 const row={id:M,kind:'issue',occurred_on:'2026-10-19',reason:'OS sintética',reference:null,created_at:'2026-10-19T15:04:05Z',recorded_at_local:'2026-10-19T12:04:05',reverses_id:null,reversed_by:null,other_items:0,
  origin:{type:'services',document_id:'75000000-0000-4000-8000-000000000001',document_kind:'service_orders',document_number:'7',via:'document_stock'},items:[{product_id:P,warehouse_id:A,quantity:'-1.000000',unit:'UN',balance_after:'7.000000',balance_version:6}],
  revision:0,note:null,unit_price:null,unit_cost:null,price_source:null,balance:null};
 s.controller.stock=async(path)=>{const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
  if(url.pathname==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:q.get('warehouse_id'),quantity:'7.000000',sale_value:'28.00',unpriced_products:0,ignored_warehouses:0,warehouses:[{id:A,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
  if(url.pathname==='/v1/estoque/saldos')return{product_id:P,items:[balance(A,'7.000000',6)],data_mode:'erp_native'};
  return{product_id:P,items:[row],limit:100,offset:0,total:1,has_more:false,next_offset:null,filters:{},totals:{entries:'0.000000',exits:'1.000000',current_balance:'7.000000',unit:'UN'},data_mode:'erp_native'};};
 for(const [role,writable] of[['estoque',false],['admin',true]]){
  const controller={...s.controller,getSnapshot:()=>({phase:'ready',membership:{role,user_id:'74000000-0000-4000-8000-000000000001'}}),async catalog(){return{record:product};}};
  const view=await mountComponent('RealStock.tsx',{controller},{location:`/estoque-empresa?produto=${P}`});
  try{
   await view.flush();view.find(node=>node.type==='tr'&&node.props?.['aria-label']?.startsWith('Abrir lançamento')).props.onClick();await view.flush();
   const panel=view.nodes().find(node=>typeof node.type==='function'&&node.type.name==='StockEditPanel');
   assert.equal(panel.props.writable,writable,role);
   assert.equal(panel.props.readOnlyReason,writable?null:'Os preços deste lançamento pertencem ao documento de origem, que seu perfil não pode consultar.',role);
  }finally{view.unmount();}
 }
});
