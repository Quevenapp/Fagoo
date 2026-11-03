import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture} from './helpers/stock-lane-f-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// 280 through the Worker with the real SQL on PGlite (synthetic data only): "Componentes do item (kit)" routes, closed bodies and
// projected answers that fail closed (502).
let f;
before(async()=>{f=await stockLaneFFixture({upto:4});});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.vendas}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const tamper=(result,change)=>{const forged=structuredClone(result.raw);change(forged);assert.throws(()=>stockResponse(forged,result.route,result.operation),error=>error.status===502);};

test('280 routes: methods, strict params and closed bodies are refused before the database',async()=>{
 const id=randomUUID(),doc=randomUUID();
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/composicoes/itens/${id}`)),['GET','POST']);
 assert.equal(stockRoute('/v1/estoque/composicoes/itens/nao-uuid'),null);
 const refuse=async(path,method='GET',body)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path,method,body),stockRoute(url.pathname),url.searchParams),error=>error.status===400,`${path} ${JSON.stringify(body)}`);};
 await refuse(`/v1/estoque/composicoes/itens/${id}`);await refuse(`/v1/estoque/composicoes/itens/${id}?documento=x`);await refuse(`/v1/estoque/composicoes/itens/${id}?documento=${doc}&extra=1`);
 const body={command_id:randomUUID(),document_id:doc,expected_document_version:2,expected_version:0,components:[{component_id:id,quantity:'1'}]};
 for(const bad of[{...body,components:[]},{...body,components:[{component_id:id,quantity:'0'}]},{...body,components:[{component_id:id,quantity:'1,5'}]},{...body,components:[{component_id:id,quantity:'1'},{component_id:id,quantity:'2'}]},
  {...body,components:[{component_id:id,quantity:'1',extra:1}]},{...body,expected_document_version:0},{...body,expected_version:-1},{...body,extra:true},{...body,components:undefined}])
  await refuse(`/v1/estoque/composicoes/itens/${id}`,'POST',bad);
});

test('280 through the Worker: read and save the components of an item, cross-checked; tampering fails closed',async()=>{
 const target=await f.warehouse('Depósito kit HTTP 280'),a=await f.product('Comp A HTTP'),b=await f.product('Comp B HTTP');
 await f.launch(a.id,target.id,'receipt','10');
 const kit=await f.kit('Kit HTTP 280',[[a,'2']]);
 const order=await f.order('sales_orders',[f.item(kit,'1.5')],target.id);
 const item=await f.scalar('select id::text v from erp_documents.item where document_id=$1',[order.id]);
 const path=`/v1/estoque/composicoes/itens/${item}?documento=${order.id}`;
 const read=await stock(path);const view=stockResponse(read.raw,read.route,read.operation);
 assert.deepEqual({editable:view.editable,components:view.components.map(c=>[c.name,c.quantity,c.total,c.stock])},{editable:true,components:[['Comp A HTTP','2.000000','3.000000000000','10.000000']]});
 tamper(read,raw=>{raw.components[0].total='4.000000000000';});tamper(read,raw=>{raw.editable=false;});tamper(read,raw=>{raw.components[0].stock=null;});
 tamper(read,raw=>{raw.document.id=randomUUID();});tamper(read,raw=>{raw.components[0].quantity='3.000000';});
 const consulta=await stock(path,{user:f.users.consulta});assert.equal(stockResponse(consulta.raw,consulta.route,consulta.operation).reason_code,'role');
 const version=await f.scalar('select version v from erp_documents.document where id=$1',[order.id]);
 const command=randomUUID(),body={command_id:command,document_id:order.id,expected_document_version:version,expected_version:0,components:[{component_id:b.id,quantity:'1.25'},{component_id:a.id,quantity:'1'}]};
 const saved=await stock(`/v1/estoque/composicoes/itens/${item}`,{method:'POST',body});
 const value=stockResponse(saved.raw,saved.route,saved.operation);
 assert.deepEqual({edited:value.edited,version:value.version,document:value.document.version,components:value.components.map(c=>[c.name,c.quantity,c.total]),replayed:value.replayed},
  {edited:true,version:1,document:version+1,components:[['Comp B HTTP','1.250000','1.875000000000'],['Comp A HTTP','1.000000','1.500000000000']],replayed:false});
 tamper(saved,raw=>{raw.version=2;});tamper(saved,raw=>{raw.components.reverse();});tamper(saved,raw=>{raw.restored=true;});
 const replay=await stock(`/v1/estoque/composicoes/itens/${item}`,{method:'POST',body});assert.equal(stockResponse(replay.raw,replay.route,replay.operation).replayed,true);
 const restored=await stock(`/v1/estoque/composicoes/itens/${item}`,{method:'POST',body:{command_id:randomUUID(),document_id:order.id,expected_document_version:version+1,expected_version:1,components:null}});
 assert.deepEqual(((v)=>[v.edited,v.restored,v.components.map(c=>c.name)])(stockResponse(restored.raw,restored.route,restored.operation)),[false,true,['Comp A HTTP']]);
});
