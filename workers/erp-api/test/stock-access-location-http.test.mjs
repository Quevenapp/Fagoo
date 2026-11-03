import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneEFixture,fails} from './helpers/stock-lane-e-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// 260 through the Worker with the real SQL on PGlite (synthetic data only): GET /v1/estoque/produtos/localizacoes with strict
// params and a projection that fails closed (502), and the direct lançamento of a composition refused by the database.
let f;
before(async()=>{f=await stockLaneEFixture({upto:3});});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.vendas}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};

test('260 locations route: GET only, ids required, 1 to 100 distinct uuids, nothing else',async()=>{
 const route=stockRoute('/v1/estoque/produtos/localizacoes');
 assert.deepEqual(stockMethods(route),['GET']);
 const refuse=async path=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path),stockRoute(url.pathname),url.searchParams),error=>error.status===400,path);};
 const id=randomUUID(),many=Array.from({length:101},()=>randomUUID());
 await refuse('/v1/estoque/produtos/localizacoes');await refuse('/v1/estoque/produtos/localizacoes?ids=');await refuse('/v1/estoque/produtos/localizacoes?ids=nao-uuid');
 await refuse(`/v1/estoque/produtos/localizacoes?ids=${id},${id.toUpperCase()}`);await refuse(`/v1/estoque/produtos/localizacoes?ids=${many.join(',')}`);
 await refuse(`/v1/estoque/produtos/localizacoes?ids=${id}&extra=1`);await refuse(`/v1/estoque/produtos/localizacoes?ids=${id}&ids=${randomUUID()}`);
 const url=new URL(`https://api.example.test/v1/estoque/produtos/localizacoes?ids=${id.toUpperCase()}`);
 assert.deepEqual((await stockOperation(request(url.pathname+url.search),route,url.searchParams)).args,{p_ids:[id]});
});

test('260 locations through the Worker: the catalog Localização, null when unset, unknown ids left out; tampering fails closed',async()=>{
 const a=await f.product('Localização HTTP A',{location:'Rua 2 - Nível 1'}),b=await f.product('Localização HTTP B'),missing=randomUUID();
 const read=await stock(`/v1/estoque/produtos/localizacoes?ids=${a.id},${b.id},${missing}`);
 const out=stockResponse(read.raw,read.route,read.operation);
 assert.deepEqual(out,{items:[{product_id:a.id,location:'Rua 2 - Nível 1'},{product_id:b.id,location:null}].sort((x,y)=>x.product_id.localeCompare(y.product_id)),scope:'stock_product_locations',data_mode:'erp_native'});
 tamper(read,v=>{v.items[0].extra=1;});tamper(read,v=>{v.items[0].product_id=randomUUID();});tamper(read,v=>{v.items[0].location=7;});
 tamper(read,v=>{v.items[0].location='x'.repeat(101);});tamper(read,v=>{v.items.push(structuredClone(v.items[0]));});tamper(read,v=>{v.scope='stock_positions';});
 await assert.rejects(stock(`/v1/estoque/produtos/localizacoes?ids=${a.id}`,{user:f.users.financeiro}),fails('42501'));
});

test('260 the direct Entrada of a Físico composition with Lançar estoque Componentes is refused by the database (400)',async()=>{
 const depot=await f.warehouse('Depósito HTTP 260'),c=await f.product('Componente HTTP 260');await f.launch(c.id,depot.id,'receipt','10');
 const kit=await f.kit('Kit HTTP 260',[[c,'1']],{stock_type:'physical',post_mode:'components'});
 const body={command_id:randomUUID(),kind:'receipt',product_id:kit.id,warehouse_id:depot.id,quantity:'1',expected_version:await f.version(kit.id,depot.id)};
 await assert.rejects(stock('/v1/estoque/lancamentos',{method:'POST',body,user:f.users.estoque}),error=>error.code==='22023'&&/erp_stock_composition_launch_required/.test(error.message));
 assert.equal(await f.balance(kit.id,depot.id)??'0.000000','0.000000');
});
