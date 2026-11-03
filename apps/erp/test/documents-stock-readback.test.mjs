import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';

const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const warehouse='20000000-0000-4000-8000-000000000001';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const listUrl='/documentos-empresa?tipo=sales_proposals';
const documentUrl=value=>`${listUrl}&documento=${value}`;
function documentServer(detail=async path=>({document:{id:path.split('/').at(-1),kind:'sales_proposals',version:1,number:'1'}})){
 const calls=[];
 return{calls,controller:{async documents(path,options={}){calls.push({path,...options});
  if(path==='/v1/documentos')return{read:['sales_proposals'],write:['sales_proposals'],data_mode:'erp_native'};
  if(path.includes('?'))return{items:[],has_more:false,next_cursor:null,data_mode:'erp_native'};
  // 202610200104 user list settings are not part of the document reads counted here.
  if(path.endsWith('/preferencias-listagem'))throw new AccessError(404);
  // 202610200163 situações of the kind are not document reads either.
  if(path.endsWith('/situacoes'))throw new AccessError(404);
  return detail(path,options);
 }}};
}
const mountDocuments=(server,location=listUrl)=>mountComponent('RealDocuments.tsx',{controller:server.controller},{location,expandChildren:['NativeListLayout','DocumentList','DocumentStatusBadge']});

test('same-module URL navigation back to the list clears the previous editor, while local Incluir survives rerenders',async()=>{
 const server=documentServer(),view=await mountDocuments(server,documentUrl(id));
 try{
  assert.equal(component(view,'Editor').props.record.id,id);
  await view.navigate(listUrl);assert.equal(component(view,'Editor'),undefined);assert.ok(view.button('Incluir proposta'));
  await view.click('Incluir proposta');assert.equal(component(view,'Editor').props.record,null);
  await view.updateProps({});assert.equal(component(view,'Editor').props.record,null);
  const saved={id,kind:'sales_proposals',version:1,number:'2'};
  component(view,'Editor').props.onSaved(saved);await view.flush();
  assert.equal(component(view,'Editor').props.record,saved,'list refresh after save must not discard the local editor');
 }finally{view.unmount();}
});

test('invalid and empty routed IDs remove the old editor without fetching an invented document',async()=>{
 const server=documentServer(),view=await mountDocuments(server,documentUrl(id));
 try{
  const before=server.calls.length;
  for(const invalid of ['not-a-uuid','']){await view.navigate(documentUrl(invalid));assert.equal(component(view,'Editor'),undefined);assert.match(view.text(),/identificador de documento inválido/);assert.ok(view.button('Voltar à listagem'));assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Incluir proposta'),false);}
  assert.equal(server.calls.length,before);
 }finally{view.unmount();}
});

test('pending document URL shows a detail loading view; leaving aborts and ignores a late successful GET',async()=>{
 const pending=deferred(),server=documentServer(()=>pending.promise),view=await mountDocuments(server,documentUrl(id));
 try{
  assert.match(view.text(),/Carregando documento/);assert.equal(component(view,'NativeListLayout'),undefined);assert.throws(()=>view.button('Incluir proposta'));
  const request=server.calls.find(call=>call.path.endsWith(id));await view.click('Voltar à listagem');assert.equal(request.signal.aborted,true);
  pending.resolve({document:{id,kind:'sales_proposals',number:'1',version:1}});await view.flush();
  assert.equal(component(view,'Editor'),undefined);assert.ok(view.button('Incluir proposta'));assert.equal(view.location().search,'?tipo=sales_proposals');
 }finally{view.unmount();}
});

test('detail error retries that GET and rejects a response for a different document',async()=>{
 let reads=0;const server=documentServer(async()=>{reads++;if(reads===1)throw new AccessError(503);return{document:{id:reads===2?other:id,kind:'sales_proposals',version:1,number:'1'}};}),view=await mountDocuments(server,documentUrl(id));
 try{
  assert.equal(reads,1);assert.equal(component(view,'Editor'),undefined);
  await view.click('Tentar consultar documento novamente');assert.equal(reads,2);assert.equal(component(view,'Editor'),undefined);
  await view.click('Tentar consultar documento novamente');assert.equal(reads,3);assert.equal(component(view,'Editor').props.record.id,id);
  assert.equal(server.calls.filter(call=>call.path.includes('?')).length,1,'retry must not merely reload the list');
 }finally{view.unmount();}
});

function listServer(items){
 const calls=[];
 return{calls,controller:{async documents(path,options={}){calls.push({path,...options});
  if(path==='/v1/documentos')return{read:['sales_proposals'],write:['sales_proposals'],data_mode:'erp_native'};
  if(path.includes('?'))return{kind:'sales_proposals',items,limit:100,page:Number(new URLSearchParams(path.split('?')[1]).get('page')),order:new URLSearchParams(path.split('?')[1]).get('order')??'date_desc',has_more:false,next_cursor:null,total_count:items.length,total_amount:'150.00',data_mode:'erp_native',operational_effects:false};
  return{document:{id:path.split('/').at(-1),kind:'sales_proposals',version:1,number:'12'}};
 }}};
}
const summary={id,kind:'sales_proposals',number:'12',version:1,status:'approved',date:'2026-10-16',total:'150.00',contact_id:other,contact_name:'Cliente sintético',created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z',expected_date:null,next_contact:null,template:false,warehouse_id:null,warehouse_name:null,source_proposal_id:null,source_proposal_number:null,finance_active:false,stock_active:false,receipt_active:false,reservation_active:false,fiscal_draft:null,internal_notes:null};

test('Origin list: row click opens the routed document, Ctrl/middle click opens the same deep link in a new tab without reading it here',async()=>{
 const opened=[],previous=globalThis.window;globalThis.window={open:(...args)=>opened.push(args)};
 const server=listServer([summary]),view=await mountDocuments(server);
 try{
  assert.equal(view.find(n=>n.type==='h1').props.children,'Propostas comerciais');
  assert.equal(view.input('documents-search').props.placeholder,'Pesquisa por nome ou número da proposta');
  assert.equal(view.find(n=>n.type==='span'&&n.props.children==='Aprovado').props.className,'status-badge status-neutral','propostas keep the neutral Origin badge');
  const row=()=>view.find(n=>n.type==='tr'&&n.key===id),reads=server.calls.length;
  row().props.onClick({ctrlKey:true});await view.flush();
  row().props.onAuxClick({button:1});await view.flush();
  assert.deepEqual(opened,[[`/documentos-empresa?tipo=sales_proposals&documento=${id}`,'_blank','noopener'],[`/documentos-empresa?tipo=sales_proposals&documento=${id}`,'_blank','noopener']]);
  assert.equal(view.location().search,'?tipo=sales_proposals');assert.equal(server.calls.length,reads,'a new-tab open must not read the document in this tab');
  row().props.onClick({});await view.flush();
  assert.equal(view.location().search,`?tipo=sales_proposals&documento=${id}`);assert.equal(component(view,'Editor').props.record.id,id);
  await view.navigate(listUrl);assert.equal(component(view,'Editor'),undefined);await view.click('12');
  assert.equal(view.location().search,`?tipo=sales_proposals&documento=${id}`,'the number button keeps opening the document');assert.equal(opened.length,2);
 }finally{view.unmount();globalThis.window=previous;}
});

test('Origin period chip and filter chips apply validated filters immediately; an invalid period is rejected without a list read',async()=>{
 const server=listServer([summary]),view=await mountDocuments(server);
 try{
  const lists=()=>server.calls.filter(call=>call.path.includes('?')).map(call=>call.path);
  component(view,'PeriodPicker').props.onApply({from:'2026-10-01',to:'2026-10-31'});await view.flush();
  assert.match(lists().at(-1),/date_from=2026-10-01&date_to=2026-10-31/);
  const before=lists().length;
  component(view,'PeriodPicker').props.onApply({from:'2026-02-30',to:'2026-03-01'});await view.flush();
  assert.equal(lists().length,before);assert.match(view.text(),/Informe datas válidas/);
  // 202610200129: the propostas use the Origin single list of situações.
  await view.change('documents-proposal-status','approved');await view.change('documents-search','Cliente');await view.submit();
  assert.match(lists().at(-1),/status=approved&q=Cliente&date_from=2026-10-01&date_to=2026-10-31/);
  const chips=component(view,'AppliedChips').props;assert.deepEqual(chips.chips.map(chip=>chip.label),['Situação: Aprovado','Pesquisa: Cliente']);
  chips.chips[0].onRemove();await view.flush();assert.match(lists().at(-1),/limit=100&page=1&q=Cliente&date_from=2026-10-01/);assert.equal(view.input('documents-proposal-status').props.value,'');
  component(view,'AppliedChips').props.onClear();await view.flush();
  assert.match(lists().at(-1),/^\/v1\/documentos\/sales_proposals\?limit=100&page=1&date_from=2026-10-01&date_to=2026-10-31$/);assert.deepEqual(component(view,'AppliedChips').props.chips,[],'the chip row stays with “Nenhum filtro aplicado”');
 }finally{view.unmount();}
});

const product={id,name:'Produto sintético',active:true,kind:'P',format:'S',unit:'UN',code:'SINTETICO'};
const balance=(quantity='10.000000')=>({warehouse_id:warehouse,warehouse_name:'Depósito sintético',warehouse_active:true,product_id:id,quantity,unit:'UN',version:1,warehouse_default:true,warehouse_ignored:false,reserved_quantity:'0.000000'});
const movement={id:other,kind:'receipt',occurred_on:'2026-10-16',reason:'Entrada sintética anterior',reference:null,created_at:'2026-10-16T12:00:00Z',recorded_at_local:'2026-10-16T09:00:00',reverses_id:null,reversed_by:null,other_items:0,origin:{type:'none',document_id:null,document_kind:null,document_number:null,via:null},items:[{product_id:id,warehouse_id:warehouse,quantity:'10.000000',unit:'UN',balance_after:'10.000000',balance_version:1}],
 revision:0,note:null,unit_price:null,unit_cost:null,price_source:null,balance:null};
// Ledger mode of GET /v1/estoque/movimentos (migrations 098 and 105): one row of the requested product, page 1 of 100.
const ledger=(productId,path)=>{const query=new URL(path,'https://synthetic.invalid').searchParams;return{product_id:productId,items:[{...movement,items:movement.items.map(line=>({...line,product_id:productId}))}],limit:Number(query.get('limit')),offset:Number(query.get('offset')),total:1,has_more:false,next_offset:null,totals:{entries:'10.000000',exits:'0.000000',current_balance:'10.000000',unit:'UN'},data_mode:'erp_native'};};
const launched=body=>({scope:'stock_launch',data_mode:'erp_native',kind:body.kind,occurred_on:'2026-10-20',replayed:false,movement:{id:crypto.randomUUID(),items:[{product_id:body.product_id,warehouse_id:body.warehouse_id,quantity:`${body.quantity}.000000`,unit:'UN',balance_after:'12.000000',balance_version:2}]},
 detail:{revision:1,unit_price:'1.0000000000',unit_cost:'1.0000000000',note:'Lançamento manual'},balance:null});
function stockServer({read=async()=>undefined}={}){
 const calls=[],controller={getSnapshot:()=>({membership:{role:'admin'}}),async catalog(path){return{record:{...product,id:path.split('/').at(-1)}};},async stock(path,options={}){
  calls.push({path,...options});if(options.method==='POST')return launched(options.body);
  if(path.startsWith('/v1/estoque/totais'))return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:new URL(path,'https://synthetic.invalid').searchParams.get('warehouse_id'),quantity:'10.000000',sale_value:'0.00',unpriced_products:1,ignored_warehouses:0,warehouses:[{id:warehouse,name:'Depósito sintético',active:true,is_default:true,ignore_balance:false}]};
  const result=await read(path,options);if(result!==undefined)return result;
  const productId=new URL(path,'https://synthetic.invalid').searchParams.get('product_id');
  return path.includes('/saldos?')?{product_id:productId,items:[balance()],data_mode:'erp_native'}:ledger(productId,path);
 }};return{calls,controller};
}
// The product comes from the URL (/estoque-empresa?produto=<uuid>, migration 105 screen).
const mountStock=(server,value=id,options={})=>mountComponent('RealStock.tsx',{controller:server.controller},{location:`/estoque-empresa?produto=${value}`,...options});

for(const failedHalf of ['saldos','movimentos'])test(`successful stock write followed by failed ${failedHalf} GET hides both old snapshots and blocks another movement`,async()=>{
 let fail=false;const server=stockServer({read(path){if(fail&&path.includes(`/${failedHalf}?`))throw new AccessError(503);}});
 const view=await mountStock(server,id,{expandChildren:['StockLaunchPanel','StockSidePanel']});
 try{
  await view.flush();assert.match(view.text(),/10 UN/);assert.match(view.text(),/Entrada sintética anterior/);assert.equal(view.button('Incluir lançamento').disabled,false);
  await view.click('Incluir lançamento');await view.change('stock-launch-quantity','2');await view.change('stock-launch-price','1');await view.change('stock-launch-cost','1');
  fail=true;await view.click('Incluir');
  assert.equal(server.calls.filter(call=>call.method==='POST').length,1);assert.match(view.text(),/Lançamento registrado/);
  assert.doesNotMatch(view.text(),/Entrada sintética anterior|10 UN/);assert.equal(view.button('Incluir lançamento').disabled,true);
  assert.doesNotMatch(view.text(),/Cadastre um depósito/);
  fail=false;await view.click('Atualizar saldos');assert.match(view.text(),/Entrada sintética anterior/);assert.equal(view.button('Incluir lançamento').disabled,false);
 }finally{view.unmount();}
});

test('late stock read after switching products cannot publish the old balances or history',async()=>{
 const late=deferred();let hold=true;
 const server=stockServer({read(path){if(hold&&path.includes(id))return late.promise;}}),view=await mountStock(server);
 try{
  await view.flush();assert.equal(view.button('Incluir lançamento').disabled,true);
  hold=false;await view.navigate(`/estoque-empresa?produto=${other}`);
  const oldCalls=server.calls.filter(call=>call.path.includes(id));assert.ok(oldCalls.length>0&&oldCalls.every(call=>call.signal.aborted));
  late.resolve({product_id:id,items:[balance('999.000000')],data_mode:'erp_native'});await view.flush();
  assert.doesNotMatch(view.text(),/999/);assert.equal(view.button('Incluir lançamento').disabled,false);
 }finally{view.unmount();}
});

test('an open launch panel cannot commit while its current balance read is unavailable',async()=>{
 const server=stockServer(),props={controller:server.controller,product,warehouse:balance(),readReady:true,suggestion:{sale:'1',purchase:'1',cost:'1'},onClose(){},onSaved(){},onRefresh(){}};
 const view=await mountComponent('StockMovementPanel.tsx',props,{componentName:'StockLaunchPanel',expandChildren:['StockSidePanel']});
 try{
  await view.change('stock-launch-quantity','2');
  await view.updateProps({readReady:false});assert.equal(view.button('Incluir').disabled,true);
  // Invoke the fresh handler directly, bypassing HTML disabled, to check the command boundary too.
  view.button('Incluir').props.onClick();await view.flush();assert.equal(server.calls.length,0);
  await view.updateProps({readReady:true});await view.click('Incluir');assert.equal(server.calls.filter(call=>call.method==='POST').length,1);
 }finally{view.unmount();}
});
