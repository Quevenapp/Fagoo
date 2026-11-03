import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture} from './helpers/stock-lane-f-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';
import {parsePurchaseReceiptsRoute,executePurchaseReceiptsRoute} from '../src/purchase-receipts.mjs';

// 277 through the Worker with the real SQL on PGlite (synthetic data only): the launch context with the decimals of the entries,
// the reservations of a custom situation and the recebimento preview without a date. Tampered answers fail closed (502).
let f;
before(async()=>{f=await stockLaneFFixture({upto:1});});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.estoque}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};
const forcePreference=async(key,value)=>{await f.db.exec("set session_replication_role=replica");try{
 await f.db.query('update erp_preferences.company_value set value=$2::jsonb where key=$1',[key,JSON.stringify(value)]);}finally{await f.db.exec("set session_replication_role=origin");}};

test('277 launch context carries "Número de casas decimais no preço nas entradas"; an older answer means ten',async()=>{
 const item=await f.product('Produto contexto F');
 await f.setPreferences('empresa-geral',{'empresa.decimais_preco_entrada':3});
 try{
  const result=await stock(`/v1/estoque/sugestao?product_id=${item.id}`);
  assert.deepEqual(stockResponse(result.raw,result.route,result.operation).price_decimals,{entry:3});
  const older=structuredClone(result.raw);delete older.price_decimals;
  assert.deepEqual(stockResponse(older,result.route,result.operation).price_decimals,{entry:10});
  tamper(result,raw=>{raw.price_decimals={entry:11};});tamper(result,raw=>{raw.price_decimals={entry:'2'};});tamper(result,raw=>{raw.price_decimals={entry:2,exit:2};});
 }finally{await f.setPreferences('empresa-geral',{'empresa.decimais_preco_entrada':10});}
});

test('277 reservations of a custom situation pass the Worker with its name; a status outside the choice still fails closed',async()=>{
 const target=await f.warehouse('Depósito reserva HTTP F'),item=await f.product('Produto reserva HTTP F');await f.launch(item.id,target.id,'receipt','5');
 const situation=(await f.rpc('erp_preferences_situation_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'sales_orders',p_situation:null,p_expected_version:0,
  p_data:{name:'Aguardando separação',base_status:'open',color:'#abcdef',active:true}})).receipt.target;
 const order=await f.order('sales_orders',[f.item(item,'2')],target.id);
 await f.db.query("insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id)values($1,'sales_orders',$2,'open',$3,$4)",[order.id,situation,f.users.admin,randomUUID()]);
 await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['verificado']});
 try{
  await forcePreference('estoque.reserva_situacoes',['verificado',situation]);
  const result=await stock(`/v1/estoque/reservas?product_id=${item.id}`,{user:f.users.consulta});
  const value=stockResponse(result.raw,result.route,result.operation);
  assert.deepEqual(value.reservation.situation_ids,[situation]);assert.deepEqual(value.reservation.statuses,['verified']);
  assert.deepEqual(value.items.map(i=>[i.document_id,i.status,i.situation_id,i.situation_name,i.quantity]),[[order.id,'open',situation,'Aguardando separação','2.000000']]);
  tamper(result,raw=>{raw.reservation.situation_ids=[];});
  tamper(result,raw=>{raw.items[0].situation_id=null;raw.items[0].situation_name=null;});
  tamper(result,raw=>{raw.items[0].situation_name='';});
  tamper(result,raw=>{raw.reservation.situation_ids=['nao-uuid'];});
  // The balances answer (227, policy without custom ids) still passes the Worker with the reserved quantity of the custom situation.
  const balances=await stock(`/v1/estoque/saldos?product_id=${item.id}`,{user:f.users.consulta});
  const position=stockResponse(balances.raw,balances.route,balances.operation).items.find(i=>i.warehouse_id===target.id);
  assert.equal(position.reserved_quantity,'2.000000');
 }finally{await forcePreference('estoque.reserva_situacoes',['verificado']);await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':false});}
});

test('277 recebimento preview without a date through the Worker: the day of the preference; the receive needs a date',async()=>{
 const target=await f.warehouse('Depósito recebimento HTTP F'),item=await f.product('Produto recebimento HTTP F');
 const order=await f.order('purchase_orders',[f.item(item,'3')],target.id,['in_progress'],{date:'2026-10-01'});
 const itemId=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[order.id]);
 const today=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const send=async(path,body)=>{const route=await parsePurchaseReceiptsRoute(new Request(`https://api.example.test/v1/recebimentos-compras/${order.id}/${path}`,
  {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));return executePurchaseReceiptsRoute(route,{userId:f.users.estoque,rpc:(name,args)=>f.rpc(name,args)});};
 const body={expected_document_version:order.version,occurred_on:null,reason:'Recebimento HTTP sintético',items:[{item_id:itemId,quantity:'1'}]};
 const preview=(await send('preview',body)).preview;
 assert.equal(preview.occurred_on,today);
 const received=await send('receive',{...body,occurred_on:preview.occurred_on,command_id:randomUUID(),preview_hash:preview.preview_hash,confirmed:true});
 assert.equal(received.receipt.receipt.occurred_on,today);
 await assert.rejects(send('receive',{...body,command_id:randomUUID(),preview_hash:preview.preview_hash,confirmed:true}),error=>error.status===400);
 await assert.rejects(send(`${received.receipt.receipt.id}/reverse-preview`,{expected_document_version:received.current.document.version,occurred_on:null,reason:'Estorno HTTP'}),error=>error.status===400);
 // Another date than the preference is refused by the database (400).
 await assert.rejects(send('preview',{...body,expected_document_version:received.current.document.version,occurred_on:'2026-10-02'}),error=>error.status===400);
});
