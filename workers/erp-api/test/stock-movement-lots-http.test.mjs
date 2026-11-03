import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture} from './helpers/stock-lane-f-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// 278 through the Worker with the real SQL on PGlite (synthetic data only): the routes of "Informar lotes de produtos" and of
// "Informações de lote lançado", closed bodies, and projected answers that fail closed (502).
let f;
before(async()=>{f=await stockLaneFFixture({upto:2});});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.estoque}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const run=async(path,options)=>{const{raw,route,operation}=await stock(path,options);return stockResponse(raw,route,operation);};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};

test('278 routes: methods, strict params and closed bodies are refused before the database',async()=>{
 const id=randomUUID(),other=randomUUID();
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/lotes/movimentos/${id}`)),['GET','POST']);
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/lotes/origem')),['GET']);
 assert.equal(stockRoute('/v1/estoque/lotes/movimentos/nao-uuid'),null);
 const refuse=async(path,method='GET',body)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path,method,body),stockRoute(url.pathname),url.searchParams),error=>error.status===400,`${path} ${JSON.stringify(body)}`);};
 await refuse(`/v1/estoque/lotes/movimentos/${id}`);await refuse(`/v1/estoque/lotes/movimentos/${id}?product_id=${id}`);
 await refuse(`/v1/estoque/lotes/movimentos/${id}?product_id=${id}&warehouse_id=${id}&extra=1`);
 await refuse(`/v1/estoque/lotes/origem?product_id=${id}`);await refuse(`/v1/estoque/lotes/origem?documento=${id}&nota=${other}&product_id=${id}`);
 await refuse(`/v1/estoque/lotes/origem?documento=x&product_id=${id}`);
 const body={command_id:randomUUID(),product_id:id,warehouse_id:other,expected_lots:0,lots:[{lot_id:id,quantity:'1'}]};
 for(const bad of[{...body,lots:[]},{...body,lots:[{lot_id:id,quantity:'0'}]},{...body,lots:[{lot_id:id,quantity:'1,5'}]},{...body,lots:[{lot_id:id,code:'L',quantity:'1'}]},
  {...body,lots:[{lot_id:id,quantity:'1'},{lot_id:id,quantity:'2'}]},{...body,lots:[{code:'L',quantity:'1'},{code:'l',quantity:'1'}]},{...body,lots:[{code:' L',quantity:'1'}]},
  {...body,lots:[{code:'L',quantity:'1',expires_on:'2027-02-30'}]},{...body,lots:[{code:'L',quantity:'1',manufactured_on:'2027-02-02',expires_on:'2027-02-01'}]},
  {...body,expected_lots:-1},{...body,extra:true},{...body,command_id:'x'},{...body,lots:Array.from({length:51},()=>({code:randomUUID().slice(0,8),quantity:'1'}))}])
  await refuse(`/v1/estoque/lotes/movimentos/${id}`,'POST',bad);
});

test('278 through the Worker: read, assign with replay and the source of an item, cross-checked; tampering fails closed',async()=>{
 const target=await f.warehouse('Depósito lotes HTTP'),item=await f.lotProduct('Produto lotes HTTP');
 const lot=(await f.lotSave(item.id,{code:'H-1',expires_on:'2027-03-01'})).lot;
 const entry=await f.launch(item.id,target.id,'receipt','6');const movement=entry.movement.id;
 const path=`/v1/estoque/lotes/movimentos/${movement}?product_id=${item.id}&warehouse_id=${target.id}`;
 const read=await stock(path,{user:f.users.consulta});const view=stockResponse(read.raw,read.route,read.operation);
 assert.deepEqual({unassigned:view.line.unassigned,room:view.room,candidates:view.candidates.map(c=>c.code),write:view.can_write,origin:view.line.origin.type},
  {unassigned:'6.000000',room:'6.000000',candidates:['H-1'],write:false,origin:'none'});
 tamper(read,raw=>{raw.line.assigned='1.000000';});tamper(read,raw=>{raw.room='7.000000';});tamper(read,raw=>{raw.line.assignable=false;});
 tamper(read,raw=>{raw.line.lots=[{lot_id:lot.id,code:'H-1',manufactured_on:null,expires_on:null,quantity:'1.000000'}];});
 tamper(read,raw=>{raw.candidates[0].quantity='-1.000000';});tamper(read,raw=>{raw.line.movement_id=randomUUID();});
 const command=randomUUID(),body={command_id:command,product_id:item.id,warehouse_id:target.id,expected_lots:0,lots:[{lot_id:lot.id,quantity:'2'},{code:'H-2',expires_on:'2027-04-01',quantity:'1.5'}]};
 const saved=await stock(`/v1/estoque/lotes/movimentos/${movement}`,{method:'POST',body});
 const value=stockResponse(saved.raw,saved.route,saved.operation);
 assert.deepEqual({assigned:value.line.assigned,version:value.line.lots_version,entries:value.entries.map(e=>[e.code,e.quantity,e.created]),replayed:value.replayed},
  {assigned:'3.500000',version:2,entries:[['H-1','2.000000',false],['H-2','1.500000',true]],replayed:false});
 tamper(saved,raw=>{raw.entries[0].quantity='-2.000000';});tamper(saved,raw=>{raw.entries.pop();});tamper(saved,raw=>{raw.line.lots_version=1;raw.line.lots.pop();raw.line.assigned='2.000000';raw.line.unassigned='4.000000';});
 const replay=await run(`/v1/estoque/lotes/movimentos/${movement}`,{method:'POST',body});assert.equal(replay.replayed,true);
 // The source of an item: a pedido de venda whose stock was posted.
 const order=await f.order('sales_orders',[f.item(item,'1')],target.id,['verified']);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:order.id,p_expected_version:order.version,p_occurred_on:'2026-10-20',p_reason:'Baixa HTTP 278'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:order.id,p_expected_version:order.version,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Baixa HTTP 278',p_ignored_item_ids:[]});
 const sourced=await stock(`/v1/estoque/lotes/origem?documento=${order.id}&product_id=${item.id}`,{user:f.users.fiscal});
 const listed=stockResponse(sourced.raw,sourced.route,sourced.operation);
 assert.deepEqual({posted:listed.posted,lines:listed.lines.map(l=>[l.direction,l.quantity,l.origin.document_number]),write:listed.can_write},{posted:true,lines:[['issue','1.000000',order.number]],write:false});
 tamper(sourced,raw=>{raw.posted=false;});tamper(sourced,raw=>{raw.reference={document_id:order.id,kind:'sales_orders',number:'1',via:'document_stock'};});
 tamper(sourced,raw=>{raw.lines[0].product_id=randomUUID();});tamper(sourced,raw=>{raw.source='invoice';});
});
