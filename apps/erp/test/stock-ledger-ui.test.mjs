import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

// Estoque > Lançamentos de estoque like Origin (migrations 098 and 105): depósito padrão, product from the URL, Tipo
// Entrada/Saída/Balanço, prices, origin links, totalizer and numbered pages (synthetic data only).
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const product='61000000-0000-4000-8000-000000000001',actor='61000000-0000-4000-8000-000000000002',doc='61000000-0000-4000-8000-000000000003',sale='61000000-0000-4000-8000-000000000004';
const A='62000000-0000-4000-8000-000000000001',B='62000000-0000-4000-8000-000000000002',C='62000000-0000-4000-8000-000000000003';
const id=n=>`63000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const none={type:'none',document_id:null,document_kind:null,document_number:null,via:null};
const saleOrigin={type:'sales',document_id:doc,document_kind:'sales_orders',document_number:'12',via:'document_stock'};
const entry=(warehouse,quantity,balance)=>({product_id:product,warehouse_id:warehouse,quantity,unit:'UN',balance_after:balance,balance_version:1});
const plain={revision:0,note:null,unit_price:null,unit_cost:null,price_source:null,balance:null};
const row=(n,patch)=>({id:id(n),kind:'receipt',occurred_on:'2026-10-18',reason:`Lançamento sintético ${n}`,reference:null,created_at:'2026-10-18T12:00:00+00:00',recorded_at_local:'2026-10-18T09:00:00',reverses_id:null,reversed_by:null,other_items:0,origin:none,items:[entry(A,'1.000000','1.000000')],...plain,...patch});
const baseRows=()=>[
 row(1,{kind:'issue',occurred_on:'2026-10-19',recorded_at_local:'2026-10-19T13:04:05',reason:'Venda sintética',reference:'Documento sales_orders 12',origin:saleOrigin,items:[entry(A,'-2.000000','8.000000')],unit_price:'7.2500000000',price_source:'document'}),
 row(2,{kind:'transfer',occurred_on:'2026-10-19',recorded_at_local:'2026-10-19T12:00:00',reason:'Transferência',origin:{...none,type:'transfers'},items:[entry(A,'-3.000000','10.000000'),entry(B,'3.000000','3.000000')],revision:1,note:'Transferência',unit_price:'1.0000000000',unit_cost:'1.2000000000',price_source:'detail'}),
 row(3,{kind:'adjustment',reason:'Lançamento manual',items:[entry(A,'5.000000','13.000000')],revision:1,note:'Contagem anual',unit_price:'1.5000000000',unit_cost:'1.7500000000',price_source:'detail',balance:{counted:'13.000000',previous:'8.000000',warehouse_id:A,source:'launch'}}),
 row(4,{occurred_on:'2026-10-01',recorded_at_local:'2026-10-19T10:00:00',reason:'Entrada retroativa sintética',items:[entry(A,'1.000000','8.000000')]}),
 row(5,{occurred_on:'2026-09-30',reason:'Entrada com outro produto',other_items:1}),
];
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const options=(defaultId=A)=>[{id:A,name:'Depósito A',active:true,is_default:defaultId===A,ignore_balance:false},{id:B,name:'Depósito B',active:true,is_default:defaultId===B,ignore_balance:true},{id:C,name:'Depósito antigo',active:false,is_default:false,ignore_balance:false}];
function server({rows=baseRows(),hold=()=>null,role='admin',mutate=value=>value,defaultId=A,warehouses=options(defaultId),reservations=[]}={}){
 const calls=[];const balances=[{warehouse_id:A,warehouse_name:'Depósito A',warehouse_active:true,quantity:'8.000000',version:5,unit:'UN',warehouse_default:defaultId===A,warehouse_ignored:false,reserved_quantity:'1.500000'},
  {warehouse_id:B,warehouse_name:'Depósito B',warehouse_active:true,quantity:'3.000000',version:1,unit:'UN',warehouse_default:false,warehouse_ignored:true,reserved_quantity:'0.000000'}];
 const record={id:product,entity:'products',name:'Produto extrato',code:'EXT-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'9.9',stock_min:'10',stock_max:'20'};
 let session={phase:'ready',membership:{role,user_id:actor}};
 const controller={getSnapshot:()=>session,async catalog(path,options={}){calls.push({path,...options});if(path.startsWith('/v1/cadastros/products?'))return{items:[record,{...record,id:sale,name:'Outro produto',code:'OUT-2'}]};return{record:{...record,id:path.split('/').at(-1)}};},
  async stock(path,options={}){calls.push({path,...options});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
   if(url.pathname==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:q.get('warehouse_id'),quantity:q.get('warehouse_id')?'8.000000':'1234.500000',sale_value:'12222.55',unpriced_products:2,ignored_warehouses:1,warehouses:structuredClone(warehouses)};
   if(url.pathname==='/v1/estoque/saldos')return{product_id:q.get('product_id'),items:structuredClone(balances),data_mode:'erp_native'};
   if(url.pathname==='/v1/estoque/reservas')return{scope:'stock_product_reservations',data_mode:'erp_native',product_id:q.get('product_id'),warehouse_id:q.get('warehouse_id'),items:reservations,total:reservations.length,quantity:'1.500000'};
   const held=hold(path);if(held)await held;
   const offset=Number(q.get('offset')),limit=Number(q.get('limit')),direction=q.get('direction');
   const matched=rows.filter(item=>(!q.get('kind')||item.kind===q.get('kind'))&&(!q.get('origin')||item.origin.type===q.get('origin'))&&(!q.get('warehouse_id')||item.items.some(line=>line.warehouse_id===q.get('warehouse_id')))
    &&(!direction||(direction==='balance'?item.balance:!item.balance&&item.items.some(line=>(!q.get('warehouse_id')||line.warehouse_id===q.get('warehouse_id'))&&(direction==='entry')!==line.quantity.startsWith('-'))))
    &&(!q.get('date_from')||item.occurred_on>=q.get('date_from'))&&(!q.get('date_to')||item.occurred_on<=q.get('date_to')));
   return mutate({product_id:q.get('product_id'),items:structuredClone(matched.slice(offset,offset+limit)),limit,offset,total:matched.length,has_more:matched.length>offset+limit,next_offset:matched.length>offset+limit?offset+limit:null,
    filters:{warehouse_id:q.get('warehouse_id'),kind:q.get('kind'),origin:q.get('origin'),date_from:q.get('date_from'),date_to:q.get('date_to'),direction},totals:{entries:'1234.000001',exits:'5.500000',current_balance:'8.000000',unit:'UN'},data_mode:'erp_native'},path);
  }};
 return{calls,controller,setRole(next){session={...session,membership:{...session.membership,role:next}};},ledger:()=>calls.filter(call=>call.path.startsWith('/v1/estoque/movimentos'))};
}
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
async function open(s,{search=`?produto=${product}`,...options}={}){const view=await mountComponent('RealStock.tsx',{controller:s.controller},{location:`/estoque-empresa${search}`,...options});await view.flush();return view;}
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const rowText=(view,n)=>textOf(view.find(node=>node.type==='tr'&&node.key===id(n)));
const ledgerRows=view=>view.nodes().filter(node=>node.type==='tr'&&String(node.key).startsWith('63000000-'));
const headers=view=>view.nodes().filter(node=>node.type==='th'&&textOf(node)).map(textOf).filter(text=>!['Depósito','Saldo'].includes(text)||true);

test('opens in the depósito padrão: Origin columns with prices, Balanço in bold, origin link, totalizer and numbered pages of 100',async()=>{
 const rows=[...baseRows(),...Array.from({length:245},(_,index)=>row(100+index,{occurred_on:'2026-09-01'}))],s=server({rows}),view=await open(s);
 try{
  assert.equal(s.calls.find(call=>call.path.startsWith('/v1/estoque/')).path,'/v1/estoque/totais','the selector and the default warehouse come first');
  assert.equal(s.ledger()[0].path,`/v1/estoque/movimentos?product_id=${product}&limit=100&offset=0&warehouse_id=${A}`);assert.equal(s.ledger().length,1,'no ledger read before the default is known');
  assert.equal(component(view,'OriginSelector').props.value,'Depósito A');
  assert.deepEqual(component(view,'OriginSelector').props.options,['Todos os depósitos','Depósito A','Depósito B'],'only active warehouses');
  const table=view.find(node=>node.type==='table'&&node.props.className==='data-table real-table stock-launches-table');
  assert.deepEqual(textOf(table.props.children[0]).trim(),'DataEntradaSaídaPreço de VendaPreço de CompraPreço de Custo ObservaçãoOrigem');
  assert.match(rowText(view,1),/^19\/10\/2026 13:04:0527,25--Venda sintéticaPedido de venda 12$/,'Saída 2, Preço de Venda 7,25, no purchase price or cost');
  assert.doesNotMatch(rowText(view,1),/Documento sales_orders/,'the generated reference is replaced by the Origem link');
  assert.equal(view.find(node=>node.type==='tr'&&node.key===id(3)).props.className,'stock-row is-balance');
  assert.match(rowText(view,3),/13--1,501,75Contagem anual Saldo: 13 \(Saldo anterior: 8\)Balanço/);
  assert.match(rowText(view,2),/^19\/10\/2026 12:00:0031,00--TransferênciaTransferência entre depósitos$/,'the outgoing line of the transfer');
  assert.match(rowText(view,4),/^01\/10\/2026Registrado em 19\/10\/2026 10:00:00/);assert.match(view.text(),/Lançamentos com data retroativa/);
  const link=view.find(node=>node.type==='a'&&textOf(node)==='Pedido de venda 12');assert.equal(link.props.href,`/documentos-empresa?tipo=sales_orders&documento=${doc}`);
  assert.match(view.text(),/Entradas1\.234,000001 UNSaídas5,5 UNSaldo atual8 UNReservado.*Visualizar vendas1,5 UN/);
  await view.click('Esconder totalizador do estoque');assert.doesNotMatch(view.text(),/Saldo atual/);await view.click('Mostrar totalizador estoque');assert.match(view.text(),/Saldo atual/);
  let pages=component(view,'OriginPagination').props;assert.deepEqual([pages.page,pages.pages,pages.size,pages.total],[1,3,100,250]);
  pages.onPage(3);await view.flush();
  assert.equal(s.ledger().at(-1).path,`/v1/estoque/movimentos?product_id=${product}&limit=100&offset=200&warehouse_id=${A}`);
  pages=component(view,'OriginPagination').props;assert.deepEqual([pages.page,pages.total],[3,250]);assert.equal(ledgerRows(view).length,50);
 }finally{view.unmount();}
});

test('"Todos os depósitos" shows the Depósito column and hides Incluir lançamento; Saldos por depósito has Todos and the ignored mark',async()=>{
 const s=server(),view=await open(s);
 try{
  assert.ok(view.button('Incluir lançamento'));
  component(view,'OriginSelector').props.onChange('Todos os depósitos');await view.flush();
  assert.equal(s.ledger().at(-1).path,`/v1/estoque/movimentos?product_id=${product}&limit=100&offset=0`);
  assert.equal(view.nodes().some(node=>node.type==='button'&&textOf(node)==='Incluir lançamento'),false);
  assert.ok(view.nodes().some(node=>node.type==='th'&&textOf(node)==='Depósito'));assert.match(rowText(view,2),/Depósito ADepósito B/);
  const ignored=view.find(node=>node.type==='tr'&&node.props.className==='is-ignored');assert.equal(ignored.props.title,'Saldo deste depósito não é considerado.');
  assert.match(textOf(view.find(node=>node.type==='tr'&&node.props.className==='stock-balances-all')),/^Todos8 UN$/,'the ignored warehouse stays out of Todos');
  const level=view.find(node=>node.type==='span'&&String(node.props.className).startsWith('stock-level'));
  assert.equal(level.props.className,'stock-level is-low');assert.equal(level.props.title,'Estoque mínimo: 10\nEstoque máximo: 20\nEstoque faltante: 2');
  assert.equal(view.find(node=>node.type==='a'&&textOf(node)==='Gerenciar produtos').props.href,`/cadastros-reais?cadastro=products&registro=${product}`);
 }finally{view.unmount();}
});

test('Tipo (Entrada/Saída/Balanço) and Tipo de Origem apply on Filtrar; período and depósito apply at once; chips and Limpar',async()=>{
 const s=server(),view=await open(s);
 try{
  const last=()=>s.ledger().at(-1).path.replace(`/v1/estoque/movimentos?product_id=${product}&limit=100&`,'');
  view.find(node=>node.type==='button'&&node.props['aria-label']==='Abrir filtro').props.onClick();await view.flush();
  assert.deepEqual(view.input('stock-filter-direction').props.children[1].map(option=>textOf(option)),['Entrada','Saída','Balanço']);
  const reads=s.ledger().length;
  await view.change('stock-filter-direction','balance');await view.change('stock-filter-origin','none');assert.equal(s.ledger().length,reads,'selects only change the draft');
  component(view,'OriginFilterPanel').props.onApply();await view.flush();
  assert.equal(last(),`offset=0&warehouse_id=${A}&origin=none&direction=balance`);
  assert.deepEqual(component(view,'AppliedChips').props.chips.map(chip=>chip.label),['Tipo: Balanço','Tipo de Origem: Sem origem']);
  assert.deepEqual(ledgerRows(view).map(node=>node.key),[id(3)]);
  await view.change('stock-filter-direction','exit');await view.change('stock-filter-origin','transfers');component(view,'OriginFilterPanel').props.onApply();await view.flush();
  assert.equal(last(),`offset=0&warehouse_id=${A}&origin=transfers&direction=exit`);assert.deepEqual(ledgerRows(view).map(node=>node.key),[id(2)],'the transfer leaves Depósito A');
  await view.change('stock-filter-origin','none');component(view,'OriginFilterPanel').props.onApply();await view.flush();
  component(view,'PeriodPicker').props.onApply({from:'2026-10-01',to:'2026-10-31'});await view.flush();
  assert.equal(last(),`offset=0&warehouse_id=${A}&origin=none&date_from=2026-10-01&date_to=2026-10-31&direction=exit`);
  component(view,'OriginSelector').props.onChange('Depósito B');await view.flush();assert.match(last(),new RegExp(`warehouse_id=${B}`));
  component(view,'AppliedChips').props.chips.find(chip=>chip.label==='Tipo: Saída').onRemove();await view.flush();
  assert.equal(last(),`offset=0&warehouse_id=${B}&origin=none&date_from=2026-10-01&date_to=2026-10-31`);assert.equal(view.input('stock-filter-direction').props.value,'');
  component(view,'AppliedChips').props.onClear();await view.flush();
  assert.equal(last(),`offset=0&warehouse_id=${B}`,'Limpar keeps the depósito of the header, like Origin');assert.deepEqual(component(view,'AppliedChips').props.chips,[]);
  const before=s.ledger().length;component(view,'PeriodPicker').props.onApply({from:'1800-01-01',to:'2026-09-30'});await view.flush();
  assert.equal(s.ledger().length,before);assert.match(view.text(),/Informe datas válidas para o período\./);
 }finally{view.unmount();}
});

test('Origem link: plain click navigates after the leave guard; Ctrl, Cmd, Shift and middle click keep the browser new tab; vendas never opens purchases',async()=>{
 const s=server(),view=await open(s);
 try{
  const link=()=>view.find(node=>node.type==='a'&&textOf(node)==='Pedido de venda 12');
  for(const event of[{ctrlKey:true},{metaKey:true},{shiftKey:true},{button:1}]){let prevented=false;link().props.onClick({button:0,...event,stopPropagation(){},preventDefault(){prevented=true;}});await view.flush();
   assert.equal(prevented,false);assert.equal(view.location().pathname,'/estoque-empresa');}
  let prevented=false;link().props.onClick({button:0,stopPropagation(){},preventDefault(){prevented=true;}});await view.flush();
  assert.equal(prevented,true);assert.equal(`${view.location().pathname}${view.location().search}`,`/documentos-empresa?tipo=sales_orders&documento=${doc}`);
 }finally{view.unmount();}
 const purchase={type:'purchases',document_id:id(901),document_kind:'purchase_orders',document_number:'31',via:'purchase_receipt'};
 const rows=[...baseRows(),row(6,{occurred_on:'2026-09-29',reason:'Compra sintética',origin:purchase,unit_price:'2.0000000000',price_source:'document'})];
 const links=view=>view.nodes().filter(node=>node.type==='a'&&/^Pedido/.test(textOf(node))).map(node=>textOf(node));
 for(const [role,expected]of[['admin',['Pedido de venda 12','Pedido de compra 31']],['vendas',['Pedido de venda 12']],['estoque',['Pedido de venda 12','Pedido de compra 31']]]){
  const view=await open(server({rows,role}));try{assert.deepEqual(links(view),expected,role);assert.match(rowText(view,6),/Pedido de compra 31/);}finally{view.unmount();}
 }
});

test('product search and deep link: suggestions show "Cód:", choosing navigates to ?produto=, X clears; without product the totalizer shows the stock totals',async()=>{
 const s=server(),view=await open(s,{search:'',expandChildren:['StockProductSearch']});
 try{
  assert.match(view.text(),/Informe um produtoPara realizar a consulta de estoque você deve informar um produto\./);assert.equal(s.ledger().length,0);
  assert.match(view.text(),/Quantidade de Itens em Estoque8Valor de Custo do EstoqueIndisponívelValor de Venda do EstoqueR\$ 12\.222,55/);
  assert.equal(s.calls.filter(call=>call.path.startsWith('/v1/estoque/totais')).at(-1).path,`/v1/estoque/totais?warehouse_id=${A}`);
  await view.click('Incluir lançamento');assert.match(view.text(),/Você deve selecionar um produto para incluir um lançamento de estoque\./);
  await view.change('stock-product-search','EXT');await new Promise(resolve=>setTimeout(resolve,300));await view.flush();
  assert.ok(s.calls.some(call=>call.path==='/v1/cadastros/products?limit=10&kind=P&q=EXT'));
  const suggestion=view.find(node=>node.type==='button'&&textOf(node)==='Produto extratoCód: EXT-1');
  suggestion.props.onClick();await view.flush();
  assert.equal(`${view.location().pathname}${view.location().search}`,`/estoque-empresa?produto=${product}`);assert.equal(s.ledger().length,1);
  assert.match(view.text(),/EXT-1 - Produto extrato - Unidade: UN/);
  view.find(node=>node.type==='button'&&node.props['aria-label']==='Limpar produto').props.onClick();await view.flush();assert.equal(view.location().search,'');assert.match(view.text(),/Informe um produto/);
 }finally{view.unmount();}
});

test('Reservado "Visualizar vendas" lists the reserved orders; transfer with fewer than two active warehouses shows Atenção',async()=>{
 const reservation={reservation_id:id(800),document_id:id(801),document_number:'77',status:'verified',contact_name:'Cliente sintético',warehouse_id:A,quantity:'1.500000',unit:'UN',reserved_at:'2026-10-19T12:00:00Z'};
 const s=server({reservations:[reservation]}),view=await open(s);
 try{
  view.find(node=>node.type==='button'&&textOf(node)==='Visualizar vendas').props.onClick();await view.flush();
  assert.equal(s.calls.filter(call=>call.path.startsWith('/v1/estoque/reservas')).at(-1).path,`/v1/estoque/reservas?product_id=${product}&warehouse_id=${A}`);
  assert.match(textOf(view.find(node=>node.type==='table'&&textOf(node).startsWith('Número do pedido'))),/Número do pedidoClienteSituaçãoQtd\. reservada77Cliente sintéticoVerificado1,5/);
 }finally{view.unmount();}
 const single=server({warehouses:[{id:A,name:'Depósito A',active:true,is_default:true,ignore_balance:false}]}),one=await open(single);
 try{one.find(node=>node.type==='button'&&textOf(node)==='Transferência entre depósitos').props.onClick();await one.flush();
  const modal=component(one,'Modal');assert.equal(modal.props.title,'Atenção');assert.equal(textOf(modal.props.children),'Para habilitar a transferência entre depósitos é necessário ter no mínimo 2 depósitos cadastrados.');assert.equal(component(one,'StockTransferPanel'),undefined);
  assert.equal(textOf(modal.props.actions),'Ok');modal.props.actions.props.onClick();await one.flush();assert.equal(component(one,'Modal'),undefined);}finally{one.unmount();}
});

test('row click opens "Lançamento de estoque"; read-only roles get no Incluir and no Salvar; late and mismatched pages never publish',async()=>{
 const consult=server({role:'consulta'}),view=await open(consult);
 try{
  assert.equal(view.nodes().some(node=>node.type==='button'&&textOf(node)==='Incluir lançamento'),false);
  view.find(node=>node.type==='tr'&&node.key===id(3)).props.onClick();await view.flush();
  const edit=component(view,'StockEditPanel');assert.equal(edit.props.writable,false);assert.equal(edit.props.row.id,id(3));
  const controls=view.find(node=>node.type==='fieldset'&&node.props.className==='stock-ledger-controls');assert.equal(controls.props.disabled,true,'an open panel freezes the list');
  const reads=consult.ledger().length;component(view,'PeriodPicker').props.onApply({from:'2026-10-01',to:'2026-10-31'});component(view,'OriginSelector').props.onChange('Depósito B');await view.flush();
  assert.equal(consult.ledger().length,reads);edit.props.onClose();await view.flush();assert.equal(component(view,'StockEditPanel'),undefined);
 }finally{view.unmount();}
 const gate=deferred();let holding=true;const s=server({hold:path=>holding&&path.endsWith(`offset=0&warehouse_id=${A}`)?gate.promise:null});const late=await open(s);
 try{
  assert.equal(ledgerRows(late).length,0);const first=s.ledger()[0];
  holding=false;component(late,'PeriodPicker').props.onApply({from:'2026-10-19',to:'2026-10-19'});await late.flush();
  assert.equal(first.signal.aborted,true);gate.resolve();await late.flush();
  assert.deepEqual(ledgerRows(late).map(node=>node.key),[id(1),id(2)]);
 }finally{late.unmount();}
 const wrong=server({mutate:(value,path)=>path.includes('direction=exit')?{...value,offset:100}:value}),mismatch=await open(wrong);
 try{
  mismatch.find(node=>node.type==='button'&&node.props['aria-label']==='Abrir filtro').props.onClick();await mismatch.flush();
  await mismatch.change('stock-filter-direction','exit');component(mismatch,'OriginFilterPanel').props.onApply();await mismatch.flush();
  assert.match(mismatch.text(),/Não foi possível consultar os lançamentos/);assert.equal(ledgerRows(mismatch).length,0);assert.doesNotMatch(mismatch.text(),/Saldo atual/);
 }finally{mismatch.unmount();}
});

test('a role change hides a launch panel without dropping it; another actor never inherits it',async()=>{
 const s=server({role:'estoque'}),view=await open(s);
 try{
  await view.click('Incluir lançamento');assert.ok(component(view,'StockLaunchPanel'));
  s.setRole('consulta');await view.updateProps({});
  const holder=view.find(node=>node.type==='div'&&node.props.inert!==undefined);assert.equal(holder.props.hidden,true);assert.equal(holder.props.inert,true);
  assert.ok(component(view,'StockLaunchPanel'),'still mounted with its pending command');assert.match(view.text(),/O lançamento em andamento fica preservado/);
  s.setRole('estoque');await view.updateProps({});assert.equal(view.find(node=>node.type==='div'&&node.props.inert!==undefined).props.hidden,false);
 }finally{view.unmount();}
});
