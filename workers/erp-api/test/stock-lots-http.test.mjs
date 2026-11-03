import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneEFixture,fails} from './helpers/stock-lane-e-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// 258 through the Worker with the real SQL on PGlite (synthetic data only): routes, closed bodies, projected responses that fail
// closed (502), the Novo Lançamento with Lote and the transfer of the selected products with Lote.
let f;
before(async()=>{f=await stockLaneEFixture({upto:1});});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.estoque}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const run=async(path,options)=>{const{raw,route,operation}=await stock(path,options);return stockResponse(raw,route,operation);};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};

test('258 routes: methods, strict params and closed bodies are refused before the database',async()=>{
 const id=randomUUID();
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/lotes')),['GET','POST']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/lotes/${id}`)),['GET','PATCH']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/lotes/${id}/situacao`)),['POST']);
 assert.equal(stockRoute('/v1/estoque/lotes/nao-uuid'),null);
 const refuse=async(path,method='GET',body)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path,method,body),stockRoute(url.pathname),url.searchParams),error=>error.status===400,path);};
 await refuse('/v1/estoque/lotes');await refuse(`/v1/estoque/lotes?product_id=${id}&situacao=todas`);await refuse(`/v1/estoque/lotes?product_id=${id}&offset=-1`);
 await refuse(`/v1/estoque/lotes?product_id=${id}&product_id=${id}`);await refuse(`/v1/estoque/lotes/${id}?limit=101`);
 const lot={command_id:randomUUID(),product_id:id,code:'L1'};
 await refuse('/v1/estoque/lotes','POST',{...lot,code:' L1'});await refuse('/v1/estoque/lotes','POST',{...lot,code:''});
 await refuse('/v1/estoque/lotes','POST',{...lot,expires_on:'2027-02-30'});await refuse('/v1/estoque/lotes','POST',{...lot,manufactured_on:'2027-02-02',expires_on:'2027-02-01'});
 await refuse('/v1/estoque/lotes','POST',{...lot,expected_version:1});await refuse(`/v1/estoque/lotes/${id}`,'PATCH',lot);
 await refuse(`/v1/estoque/lotes/${id}/situacao`,'POST',{command_id:randomUUID(),expected_version:1,active:'false'});
 const launch={command_id:randomUUID(),kind:'issue',product_id:id,warehouse_id:randomUUID(),quantity:'1',expected_version:0};
 await refuse('/v1/estoque/lancamentos','POST',{...launch,lot:{code:'NOVO'}});
 await refuse('/v1/estoque/lancamentos','POST',{...launch,lot:{lot_id:id,code:'X'}});
 await refuse('/v1/estoque/lancamentos','POST',{...launch,lot:'L1'});
 await refuse('/v1/estoque/lancamentos','POST',{...launch,kind:'balance',quantity:'-1',lot:{lot_id:id}});
 await refuse('/v1/estoque/lancamentos','POST',{...launch,kind:'receipt',lot:{code:'L2',expires_on:'2027-13-01'}});
});

test('258 lots through the Worker: save, list, details and status, cross-checked; tampering fails closed',async()=>{
 const depot=await f.warehouse('HTTP lotes');
 const item=await f.lotProduct('HTTP produto lote');
 const created=await stock('/v1/estoque/lotes',{method:'POST',body:{command_id:randomUUID(),product_id:item.id,code:'H-1',expires_on:'2027-06-30',note:' Lote HTTP '}});
 const out=stockResponse(created.raw,created.route,created.operation);
 assert.deepEqual([out.created,out.lot.code,out.lot.note,out.lot.version],[true,'H-1','Lote HTTP',1]);
 tamper(created,v=>{v.lot.expires_on='2027-07-01';});tamper(created,v=>{v.lot.extra=1;});tamper(created,v=>{v.lot.product_id=randomUUID();});
 await f.lotLaunch(item.id,depot.id,'receipt','5',{lot_id:out.lot.id});await f.launch(item.id,depot.id,'receipt','2');
 const listed=await stock(`/v1/estoque/lotes?product_id=${item.id}&warehouse_id=${depot.id}&situacao=ativos`,{user:f.users.vendas});
 const page=stockResponse(listed.raw,listed.route,listed.operation);
 assert.deepEqual([page.items.map(l=>[l.code,l.quantity]),page.stock,page.assigned,page.unassigned],[[['H-1','5.000000']],'7.000000','5.000000','2.000000']);
 tamper(listed,v=>{v.unassigned='3.000000';});tamper(listed,v=>{v.items[0].active=false;});tamper(listed,v=>{v.product.id=randomUUID();});
 const detail=await stock(`/v1/estoque/lotes/${out.lot.id}?limit=10`,{user:f.users.consulta});
 const lot=stockResponse(detail.raw,detail.route,detail.operation);
 assert.deepEqual(lot.warehouses.map(w=>[w.warehouse_id,w.quantity]),[[depot.id,'5.000000']]);assert.equal(lot.movements.items[0].quantity,'5.000000');
 tamper(detail,v=>{v.warehouses[0].quantity='4.000000';});tamper(detail,v=>{v.movements.items[0].origin.type='sales';v.movements.items[0].origin.extra=1;});
 const edit=await run(`/v1/estoque/lotes/${out.lot.id}`,{method:'PATCH',body:{command_id:randomUUID(),product_id:item.id,expected_version:1,code:'H-1',expires_on:'2027-05-31',note:null}});
 assert.deepEqual([edit.created,edit.lot.version,edit.lot.expires_on,edit.lot.note],[false,2,'2027-05-31',null]);
 await assert.rejects(run(`/v1/estoque/lotes/${out.lot.id}/situacao`,{method:'POST',body:{command_id:randomUUID(),expected_version:2,active:false}}),fails('22023'));
 const empty=await run('/v1/estoque/lotes',{method:'POST',body:{command_id:randomUUID(),product_id:item.id,code:'H-2'}});
 const off=await stock(`/v1/estoque/lotes/${empty.lot.id}/situacao`,{method:'POST',body:{command_id:randomUUID(),expected_version:1,active:false}});
 assert.equal(stockResponse(off.raw,off.route,off.operation).lot.active,false);
 tamper(off,v=>{v.lot.active=true;});
});

test('258 Novo Lançamento with Lote through POST /v1/estoque/lancamentos: Entrada, Saída, Balanço and Transferência',async()=>{
 const depot=await f.warehouse('HTTP lançamento lote'),other=await f.warehouse('HTTP lançamento lote 2');
 const item=await f.lotProduct('HTTP lançado lote');
 const body={command_id:randomUUID(),kind:'receipt',product_id:item.id,warehouse_id:depot.id,quantity:'9',expected_version:0,unit_price:'2.5',lot:{code:'N-1',expires_on:'2027-09-30'}};
 const entry=await stock('/v1/estoque/lancamentos',{method:'POST',body});
 assert.equal(entry.operation.rpc,'erp_stock_lot_launch');
 const posted=stockResponse(entry.raw,entry.route,entry.operation);
 assert.deepEqual([posted.lot.created,posted.lot.code,posted.lot.entries],[true,'N-1',[{warehouse_id:depot.id,quantity:'9.000000',balance_after:'9.000000'}]]);
 tamper(entry,v=>{v.lot.entries[0].quantity='8.000000';});tamper(entry,v=>{v.lot.code='N-2';});tamper(entry,v=>{delete v.lot;});
 const replay=await run('/v1/estoque/lancamentos',{method:'POST',body});assert.equal(replay.replayed,true);assert.equal(replay.lot.id,posted.lot.id);
 const lotId=posted.lot.id,expected=async target=>f.version(item.id,target);
 const issue=await run('/v1/estoque/lancamentos',{method:'POST',body:{command_id:randomUUID(),kind:'issue',product_id:item.id,warehouse_id:depot.id,quantity:'4',expected_version:await expected(depot.id),lot:{lot_id:lotId}}});
 assert.deepEqual(issue.lot.entries,[{warehouse_id:depot.id,quantity:'-4.000000',balance_after:'5.000000'}]);
 const counted=await stock('/v1/estoque/lancamentos',{method:'POST',body:{command_id:randomUUID(),kind:'balance',product_id:item.id,warehouse_id:depot.id,quantity:'3',expected_version:await expected(depot.id),lot:{lot_id:lotId}}});
 const balance=stockResponse(counted.raw,counted.route,counted.operation);
 assert.deepEqual([balance.lot.balance,balance.balance.counted,balance.balance.previous],[{counted:'3.000000',previous:'5.000000'},'3.000000','5.000000']);
 tamper(counted,v=>{v.lot.balance.counted='4.000000';});tamper(counted,v=>{v.balance.counted='4.000000';});
 const moved=await run('/v1/estoque/lancamentos',{method:'POST',body:{command_id:randomUUID(),kind:'transfer',product_id:item.id,warehouse_id:depot.id,quantity:'2',expected_version:await expected(depot.id),
  destination_id:other.id,destination_version:await expected(other.id),lot:{lot_id:lotId}}});
 assert.deepEqual(moved.lot.entries.map(e=>[e.warehouse_id,e.quantity]),[[depot.id,'-2.000000'],[other.id,'2.000000']]);
 // A launch without lot keeps the 105 contract (no lot key).
 const plain=await run('/v1/estoque/lancamentos',{method:'POST',body:{command_id:randomUUID(),kind:'receipt',product_id:item.id,warehouse_id:depot.id,quantity:'1',expected_version:await expected(depot.id)}});
 assert.equal(Object.hasOwn(plain,'lot'),false);
});

test('258 transfer of the selected products with Lote: positions with the lots of the row and the receipt with the lot',async()=>{
 const from=await f.warehouse('HTTP origem lote'),to=await f.warehouse('HTTP destino lote');
 const item=await f.lotProduct('HTTP transferido lote');
 const entry=await f.lotLaunch(item.id,from.id,'receipt','5',{code:'T-1'});
 const positions=await stock(`/v1/estoque/transferencias/posicoes?origem=${from.id}&destino=${to.id}&produtos=${item.id}`);
 const grid=stockResponse(positions.raw,positions.route,positions.operation);
 assert.deepEqual([grid.items[0].lot_control,grid.items[0].lots.map(l=>l.code)],[true,['T-1']]);
 tamper(positions,v=>{v.items[0].lots[0].quantity='0.000000';});tamper(positions,v=>{v.items[0].lot_control=false;});
 const batch=await stock('/v1/estoque/transferencias',{method:'POST',body:{command_id:randomUUID(),source_id:from.id,destination_id:to.id,note:'Lote HTTP',
  items:[{product_id:item.id,quantity:'3',source_version:await f.version(item.id,from.id),destination_version:await f.version(item.id,to.id),lot_id:entry.lot.id}]}});
 const receipt=stockResponse(batch.raw,batch.route,batch.operation).receipt;
 assert.deepEqual([receipt.items[0].lot_id,receipt.items[0].lot_code],[entry.lot.id,'T-1']);
 tamper(batch,v=>{v.receipt.items[0].lot_id=randomUUID();});tamper(batch,v=>{delete v.receipt.items[0].lot_code;});
 assert.deepEqual([await f.lotBalance(entry.lot.id,from.id),await f.lotBalance(entry.lot.id,to.id)],['2.000000','3.000000']);
});
