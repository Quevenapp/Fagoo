import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {expiryText,launchLot,lotBody,lotFields,parseLotDetail,parseLots,NEW_LOT} from '../src/lib/stock-lots-model.ts';

// Estoque lane, wave E (258): Controle de lotes in the extrato ("Lotes e validades", Detalhes de lotes, Excluir lote), the Lote of the
// Novo Lançamento and of the transfer, and the lot grid of the product form. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='a1000000-0000-4000-8000-000000000001',W='b1000000-0000-4000-8000-000000000001',L1='c1000000-0000-4000-8000-000000000001',L2='c1000000-0000-4000-8000-000000000002',M='d1000000-0000-4000-8000-000000000001';
const settings={require_expiry:false,require_manufacture:false,warning_days:15};
const lot=(id,code,quantity,patch={})=>({id,code,manufactured_on:null,expires_on:'2027-01-31',note:null,active:true,version:1,created_on:'2026-10-01',quantity,expiry_state:null,...patch});
const lotsPage=({warehouse=null,status='all',items=[lot(L1,'A-1','4.000000',{expiry_state:'expiring',expires_on:'2026-10-30'}),lot(L2,'B-2','0.000000')],stock='6.000000',assigned='4.000000',lotControl=true}={})=>({scope:'stock_lots',data_mode:'erp_native',
 product:{id:P,name:'Produto lote',code:'PL-1',unit:'UN',kind:'P',format:'S',active:true,lot_control:lotControl},warehouse_id:warehouse,status,offset:0,limit:100,total:items.length,today:'2026-10-20',settings,items,
 stock,assigned,unassigned:(BigInt(stock.replace('.',''))-BigInt(assigned.replace('.',''))).toString().replace(/(\d{6})$/,'.$1').replace(/^\./,'0.')});
const product={id:P,entity:'products',name:'Produto lote',code:'PL-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'4'};
const balance={warehouse_id:W,warehouse_name:'Geral',warehouse_active:true,quantity:'6.000000',version:3,unit:'UN',warehouse_default:true,warehouse_ignored:false,reserved_quantity:'0.000000'};
const STATUS={todos:'all',ativos:'active',inativos:'inactive'};

test('258 model: lots page, details, lot fields with the required dates, the Lote of a launch and the expiry text',()=>{
 const page=parseLots(lotsPage(),P,null,'todos');
 assert.deepEqual([page.unassigned,page.items.map(l=>l.code),page.product.lot_control],['2.000000',['A-1','B-2'],true]);
 assert.throws(()=>parseLots({...lotsPage(),unassigned:'9.000000'},P,null,'todos'));
 assert.throws(()=>parseLots(lotsPage(),P,W,'todos'),'another warehouse');
 assert.throws(()=>parseLots(lotsPage({status:'active',items:[lot(L1,'A-1','1.000000',{active:false})]}),P,null,'ativos'));
 assert.deepEqual(lotFields({code:' X-9 ',manufactured_on:'',expires_on:'2027-02-01',note:''},settings),{code:'X-9',manufactured_on:null,expires_on:'2027-02-01'});
 assert.throws(()=>lotFields({code:'X',manufactured_on:'',expires_on:'',note:''},{...settings,require_expiry:true}),/data de validade/);
 assert.throws(()=>lotFields({code:'X',manufactured_on:'',expires_on:'2027-01-01',note:''},{...settings,require_manufacture:true}),/data de fabricação/);
 assert.throws(()=>lotFields({code:'X',manufactured_on:'2027-02-01',expires_on:'2027-01-01',note:''},settings),/anterior ou igual/);
 assert.throws(()=>lotFields({code:'',manufactured_on:'',expires_on:'',note:''},settings),/Informe o lote/);
 assert.deepEqual(lotBody(P,{code:'X',manufactured_on:'',expires_on:'',note:' obs '},settings,2),{product_id:P,code:'X',manufactured_on:null,expires_on:null,note:'obs',expected_version:2});
 assert.equal(launchLot('',{code:'',manufactured_on:'',expires_on:'',note:''},settings,'receipt'),null,'Sem lote');
 assert.deepEqual(launchLot(L1,{code:'',manufactured_on:'',expires_on:'',note:''},settings,'issue'),{lot_id:L1});
 assert.throws(()=>launchLot(NEW_LOT,{code:'N',manufactured_on:'',expires_on:'',note:''},settings,'issue'),/Entrada ou Balanço/);
 assert.equal(expiryText({expiry_state:'expiring',expires_on:'2026-10-30'},'2026-10-20'),'Vence em 10 dias');
 assert.equal(expiryText({expiry_state:'expired',expires_on:'2026-10-01'},'2026-10-20'),'Vencido');
 assert.equal(expiryText({expiry_state:null,expires_on:'2026-10-01'},'2026-10-20'),null);
 const detail=parseLotDetail({scope:'stock_lot',data_mode:'erp_native',lot:{...lot(L1,'A-1','4.000000'),product_id:P},product:{id:P,name:'Produto lote',code:'PL-1',unit:'UN',lot_control:true},settings,
  warehouses:[{warehouse_id:W,name:'Geral',active:true,ignored:false,quantity:'4.000000',version:2}],movements:{total:1,limit:50,items:[{movement_id:M,warehouse_id:W,quantity:'4.000000',balance_after:'4.000000',kind:'receipt',
  occurred_on:'2026-10-01',created_at:'2026-10-01T12:00:00Z',recorded_at_local:'2026-10-01T09:00:00',reason:'Lançamento manual',origin:{type:'none',document_id:null,document_kind:null,document_number:null,via:null}}]}},L1);
 assert.equal(detail.movements.items[0].quantity,'4.000000');
});

function service({fail=()=>null,pages={}}={}){
 const calls=[];let writes=0;
 const stock=async(path,options={})=>{calls.push({path,method:options.method,body:options.body?structuredClone(options.body):undefined});
  const url=new URL(path,'https://synthetic.invalid');
  if(!options.method&&url.pathname==='/v1/estoque/lotes'){const status=url.searchParams.get('situacao');const warehouse=url.searchParams.get('warehouse_id');
   return pages[`${status}:${warehouse??''}`]??lotsPage({warehouse,status:STATUS[status],items:status==='inativos'?[lot(L2,'B-2','0.000000',{active:false})]:undefined});}
  if(!options.method&&url.pathname===`/v1/estoque/lotes/${L1}`)return{scope:'stock_lot',data_mode:'erp_native',lot:{...lot(L1,'A-1','4.000000'),product_id:P},product:{id:P,name:'Produto lote',code:'PL-1',unit:'UN',lot_control:true},
   settings,warehouses:[{warehouse_id:W,name:'Geral',active:true,ignored:false,quantity:'4.000000',version:2}],movements:{total:0,limit:50,items:[]}};
  if(options.method){writes++;const problem=fail({path,...options},writes);if(problem)throw problem;
   if(path.endsWith('/situacao'))return{scope:'stock_lot_status',data_mode:'erp_native',replayed:false,lot:{...lot(L2,'B-2','0.000000',{active:options.body.active,version:2}),product_id:P}};
   if(path.startsWith('/v1/estoque/lotes'))return{scope:'stock_lot_save',data_mode:'erp_native',replayed:false,created:options.method==='POST',settings,
    lot:{...lot(options.method==='POST'?'c1000000-0000-4000-8000-000000000009':L1,options.body.code,'0.000000',{manufactured_on:options.body.manufactured_on,expires_on:options.body.expires_on,note:options.body.note,version:(options.body.expected_version??0)+1}),product_id:P}};
   if(path==='/v1/estoque/lancamentos'){const q=options.body.quantity,kind=options.body.kind;
    return{scope:'stock_launch',data_mode:'erp_native',kind,occurred_on:'2026-10-20',replayed:false,movement:{id:M,items:[{product_id:P,warehouse_id:W,quantity:kind==='issue'?`-${q}.000000`:`${q}.000000`,unit:'UN',balance_after:'9.000000',balance_version:4}]},
     detail:{revision:1,unit_price:null,unit_cost:null,note:'Lançamento manual'},balance:null,lot:options.body.lot?.lot_id?{id:options.body.lot.lot_id,code:'A-1',created:false}:{id:'c1000000-0000-4000-8000-000000000008',code:options.body.lot.code,created:true}};}}
  throw new Error(`unexpected ${path}`);};
 return{calls,writes:()=>calls.filter(call=>call.method),controller:{stock}};
}

test('258 Lotes e validades tab: lots with the expiry mark and Sem lote, Situação filter, Excluir lote with Conferir resultado',async()=>{
 const s=service({fail:(call,writes)=>writes===1?new AccessError(503):null}),notices=[];
 const view=await mountComponent('StockLots.tsx',{controller:s.controller,productId:P,unit:'UN',warehouseId:'',warehouseLabel:'Todos os depósitos',writable:true,reload:0,frozen:false,onChanged:m=>notices.push(m)},
  {componentName:'StockLotsTab',expandChildren:['ExpiryBadge','LotRemoveDialog','Modal']});
 try{
  assert.match(view.text(),/DataData de fabricaçãoData de validadeLoteQuantidade/);
  assert.match(view.text(),/01\/10\/2026-30\/10\/2026Vence em 10 diasA-14 UN/);
  assert.match(view.text(),/Sem lote2 UN/);
  assert.match(view.text(),/Lotes com saldo que vencem em até 15 dias ficam marcados/);
  // Only the lot without stock offers Excluir lote; the confirmation explains that it becomes inactive.
  assert.equal(view.nodes().filter(n=>n.type==='button'&&n.props['aria-label']?.startsWith('Excluir lote')).length,1);
  view.find(n=>n.props['aria-label']==='Excluir lote B-2').props.onClick({stopPropagation(){}});await view.flush();
  assert.match(view.text(),/No FAGOO o lote fica inativo/);
  await view.click('Sim');assert.match(view.text(),/Não foi possível confirmar o resultado/);
  await view.click('Conferir resultado');
  const [first,second]=s.writes();assert.equal(first.path,`/v1/estoque/lotes/${L2}/situacao`);assert.deepEqual(first.body,second.body);assert.equal(first.body.active,false);
  assert.match(notices[0],/Lote B-2 excluído/);
  await view.change('stock-lots-status','inativos');
  assert.ok(s.calls.some(c=>c.path.includes('situacao=inativos')));assert.match(view.text(),/B-2/);assert.match(view.text(),/Inativo/);
 }finally{view.unmount();}
});

test('258 Detalhes de lotes: dates and Obs. saved with the expected version; the panel guards unsaved changes',async()=>{
 const s=service(),saved=[];
 const view=await mountComponent('StockLots.tsx',{controller:s.controller,lotId:L1,unit:'UN',writable:true,onClose(){},onSaved:m=>saved.push(m)},{componentName:'LotDetailsPanel',expandChildren:['LotDetailsForm','StockSidePanel']});
 try{
  assert.match(view.text(),/Código do LoteA-1/);assert.match(view.text(),/Nenhum lançamento com este lote/);
  assert.equal(view.guard().changed,false);
  await view.change('stock-lot-expires','2027-03-31');await view.change('stock-lot-note','Lote revisado');
  assert.equal(view.guard().changed,true);
  await view.click('Salvar');
  const write=s.writes()[0];assert.equal(write.path,`/v1/estoque/lotes/${L1}`);assert.equal(write.method,'PATCH');
  const {command_id,...body}=write.body;assert.deepEqual(body,{product_id:P,code:'A-1',manufactured_on:null,expires_on:'2027-03-31',note:'Lote revisado',expected_version:1});
  assert.match(saved[0],/Lote A-1 salvo/);
 }finally{view.unmount();}
});

test('258 Novo Lançamento with Lote: Novo lote in the Entrada, the lot balance checked in the Saída, Sem lote stays the 105 body',async()=>{
 const s=service(),saved=[];
 const view=await mountComponent('StockMovementPanel.tsx',{controller:s.controller,product,warehouse:balance,readReady:true,suggestion:{sale:'4,00',purchase:'1,50',cost:'1,75'},showPrice:false,lotControl:true,
  onClose(){},onSaved:v=>saved.push(v),onRefresh(){}},{componentName:'StockLaunchPanel',expandChildren:['StockSidePanel','LotPicker']});
 try{
  assert.ok(s.calls.some(c=>c.path.includes(`warehouse_id=${W}`)&&c.path.includes('situacao=ativos')),'the lots of the header warehouse');
  assert.match(view.text(),/Sem lote/);
  await view.change('stock-lot',NEW_LOT);await view.change('stock-lot-code','N-7');await view.change('stock-lot-expires','2027-05-31');
  await view.change('stock-launch-quantity','5');await view.click('Incluir');
  let {command_id,...body}=s.writes()[0].body;
  assert.deepEqual(body.lot,{code:'N-7',manufactured_on:null,expires_on:'2027-05-31'});assert.equal(saved[0].lot.created,true);
  // Saída: only lots with stock; more than the lot has is refused before sending.
  await view.change('stock-launch-kind','issue');
  assert.equal(view.input('stock-lot').props.value,'','a Novo lote does not stay in a Saída');
  assert.equal(view.nodes().some(n=>n.type==='option'&&n.props.value===L2),false,'a lot without stock is not offered in a Saída');
  await view.change('stock-lot',L1);await view.change('stock-launch-quantity','5');await view.click('Incluir');
  assert.match(view.text(),/não tem saldo suficiente/);assert.equal(s.writes().length,1);
  await view.change('stock-launch-quantity','3');await view.click('Incluir');
  ({command_id,...body}=s.writes()[1].body);assert.deepEqual(body.lot,{lot_id:L1});
  await view.change('stock-lot','');await view.change('stock-launch-quantity','1');await view.click('Incluir');
  assert.equal(Object.hasOwn(s.writes()[2].body,'lot'),false,'Sem lote keeps the 105 request');
 }finally{view.unmount();}
});

test('258 product form lot grid: Nenhum lote cadastrado, + Adicionar lote with the required dates and Conferir resultado',async()=>{
 const s=service({pages:{'todos:':lotsPage({items:[]})},fail:(call,writes)=>writes===1?new AccessError(503):null});
 const view=await mountComponent('StockLots.tsx',{controller:s.controller,productId:P,lotOn:true,savedLotOn:true,writable:true,unit:'UN'},{componentName:'ProductLots',expandChildren:['ProductLotForm']});
 try{
  assert.match(view.text(),/Nenhum lote cadastrado/);
  await view.click('Adicionar lote');
  await view.click('Salvar lote');assert.match(view.text(),/Informe o lote/);assert.equal(s.writes().length,0);
  await view.change('product-lot-code','P-1');await view.change('product-lot-made','2026-10-01');
  await view.click('Salvar lote');assert.match(view.text(),/Não foi possível confirmar o resultado/);
  await view.click('Conferir resultado');
  const [first,second]=s.writes();assert.deepEqual(first.body,second.body);assert.equal(first.path,'/v1/estoque/lotes');
  const {command_id,...body}=first.body;assert.deepEqual(body,{product_id:P,code:'P-1',manufactured_on:'2026-10-01',expires_on:null,note:null});
  assert.match(view.text(),/Lote P-1 cadastrado/);
 }finally{view.unmount();}
 const unsaved=await mountComponent('StockLots.tsx',{controller:s.controller,productId:P,lotOn:true,savedLotOn:false,writable:true,unit:'UN'},{componentName:'ProductLots'});
 try{assert.match(unsaved.text(),/Salve o produto para gravar o Controle de lote/);}finally{unsaved.unmount();}
 const fresh=await mountComponent('StockLots.tsx',{controller:s.controller,productId:null,lotOn:true,savedLotOn:false,writable:true,unit:'UN'},{componentName:'ProductLots'});
 try{assert.match(fresh.text(),/Salve o produto com o Controle de lote ativado/);}finally{fresh.unmount();}
});
