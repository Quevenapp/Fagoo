import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneDFixture,fails} from './helpers/stock-lane-d-fixture.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';
import {catalogRoute,catalogOperation,catalogResponse} from '../src/catalog.mjs';
import {parseDocumentStockRoute,executeDocumentStockRoute} from '../src/document-stock.mjs';
import {parseStockReservationsRoute,executeStockReservationsRoute} from '../src/stock-reservations.mjs';

// 222/223 through the Worker with the real SQL on PGlite (synthetic data only): routes, closed bodies, projected responses that fail
// closed (502), and the composition saved with the product form route.
let f;
before(async()=>{f=await stockLaneDFixture({upto:2});});
after(()=>f?.close());
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
const stock=async(path,{method='GET',body,user=f.users.estoque}={})=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(request(path,method,body),route,url.searchParams);return{raw:await f.rpc(operation.rpc,{p_user_id:user,...operation.args}),route,operation};};
const run=async(path,options)=>{const{raw,route,operation}=await stock(path,options);return stockResponse(raw,route,operation);};
const catalog=async(path,method,body,user=f.users.estoque)=>{const url=new URL(`https://api.example.test${path}`),route=catalogRoute(url.pathname);
 const operation=await catalogOperation(request(path,method,body),route,url.searchParams);const raw=await f.rpc(operation.rpc,{p_user_id:user,...operation.args});return{raw,route,operation,out:catalogResponse(raw,route,operation)};};
const post=(path,body)=>new Request('https://erp.invalid'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('222 routes: methods, strict params and closed bodies are refused before the database',async()=>{
 const id=randomUUID();
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/composicoes/${id}`)),['GET']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/composicoes/${id}/lancamentos`)),['GET','POST']);
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/composicoes/componentes')),['GET']);
 assert.equal(stockRoute('/v1/estoque/composicoes/nao-uuid'),null);
 const refuse=async(path,method='GET',body)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(stockOperation(request(path,method,body),stockRoute(url.pathname),url.searchParams),error=>error.status===400,path);};
 await refuse(`/v1/estoque/composicoes/${id}?x=1`);
 await refuse('/v1/estoque/composicoes/componentes');await refuse('/v1/estoque/composicoes/componentes?q=a&q=b');
 await refuse(`/v1/estoque/composicoes/${id}/lancamentos?limit=21`);await refuse('/v1/estoque/composicoes/exportacao?limit=501');await refuse('/v1/estoque/composicoes/exportacao?incluir_excluidos=sim');
 const body={command_id:randomUUID(),kind:'issue',warehouse_id:randomUUID(),quantity:'1'};
 await refuse(`/v1/estoque/composicoes/${id}/lancamentos`,'POST',{...body,kind:'balance'});
 await refuse(`/v1/estoque/composicoes/${id}/lancamentos`,'POST',{...body,quantity:'1.1234567'});
 await refuse(`/v1/estoque/composicoes/${id}/lancamentos`,'POST',{...body,unit_cost:'1'});
 await refuse(`/v1/estoque/composicoes/${id}/lancamentos`,'POST',{...body,extra:true});
});

test('222 Estrutura through the product form route: product and structure in one command, receipt checked, tampering fails closed',async()=>{
 const a=await f.product('HTTP A',{price:'2'}),b=await f.product('HTTP B',{price:'3'});
 const body={command_id:randomUUID(),data:{name:'Kit HTTP',unit:'KIT',kind:'P',format:'E',price:'1',composition:{expected_version:0,stock_type:'virtual',post_mode:'components',
  items:[{component_id:a.id,quantity:'2'},{component_id:b.id,quantity:'1.5'}]}},acknowledged_warnings:[]};
 const {raw,route,operation,out}=await catalog('/v1/cadastros/products/completo','POST',body);
 assert.equal(operation.rpc,'erp_stock_product_compose');assert.equal(out.record.format,'E');
 assert.deepEqual(out.composition.items.map(i=>[i.component_id,i.quantity]),[[a.id,'2.000000'],[b.id,'1.500000']]);
 const forged=structuredClone(raw);forged.composition.items[0].quantity='3.000000';assert.throws(()=>catalogResponse(forged,route,operation),error=>error.status===502);
 const wrongType=structuredClone(raw);wrongType.composition.post_mode='both';assert.throws(()=>catalogResponse(wrongType,route,operation),error=>error.status===502);
 // Edit: a new version with the record and composition versions.
 const id=out.record.id;
 const edit=await catalog(`/v1/cadastros/products/${id}/completo`,'PATCH',{command_id:randomUUID(),expected_version:out.record.version,data:{name:'Kit HTTP',
  composition:{expected_version:1,stock_type:'physical',post_mode:'both',items:[{component_id:a.id,quantity:'1'}]}}});
 assert.deepEqual([edit.out.composition.version,edit.out.composition.post_mode],[2,'both']);
 // The component save that updates the compositions (composition_sync) and the refusals of the route.
 const sync=await catalog(`/v1/cadastros/products/${a.id}/completo`,'PATCH',{command_id:randomUUID(),expected_version:await f.recordVersion(a.id),data:{name:'HTTP A',composition_sync:true}});
 assert.deepEqual(sync.out.synced,[{product_id:id,applied:{}}]);
 // What each updated composition received is checked like the structure save's own values.
 for(const tamper of[x=>{x.synced[0].applied={price:'9'};},x=>{x.synced[0].applied={extra:true};},x=>{x.synced[0].extra=1;},x=>{x.synced.push(structuredClone(x.synced[0]));}]){
  const forgedSync=structuredClone(sync.raw);tamper(forgedSync);assert.throws(()=>catalogResponse(forgedSync,sync.route,sync.operation),error=>error.status===502);}
 const refuse=async(path,method,data)=>{const url=new URL(`https://api.example.test${path}`);await assert.rejects(catalogOperation(request(path,method,{command_id:randomUUID(),...(method==='PATCH'?{expected_version:1}:{}),data}),catalogRoute(url.pathname),url.searchParams),error=>error.status===400);};
 await refuse('/v1/cadastros/products/completo','POST',{name:'X',composition_sync:true});
 await refuse(`/v1/cadastros/products/${id}/completo`,'PATCH',{name:'X',composition_sync:false});
 await refuse(`/v1/cadastros/products/${id}/completo`,'PATCH',{name:'X',composition:{expected_version:1,stock_type:'virtual',post_mode:'both',items:[]}});
 await refuse(`/v1/cadastros/products/${id}/completo`,'PATCH',{name:'X',composition:{expected_version:1,stock_type:'physical',post_mode:'both',items:[{component_id:a.id,quantity:'1'},{component_id:a.id,quantity:'2'}]}});
 await refuse('/v1/cadastros/products/completo','POST',{name:'X',composition:{expected_version:0,stock_type:'physical',post_mode:'both',items:[]},initial_balance:{warehouse_id:randomUUID(),quantity:'1'}});
});

test('222 GET Estrutura, autocomplete and export: projected DTOs, saldo virtual cross-checked',async()=>{
 const depot=await f.warehouse('HTTP depósito');
 const a=await f.product('HTTP leitura A',{price:'2'});await f.launch(a.id,depot.id,'receipt','7');
 const kit=await f.kit('HTTP leitura kit',[[a,'2']]);
 const {raw,route,operation}=await stock(`/v1/estoque/composicoes/${kit.id}`);
 const out=stockResponse(raw,route,operation);
 assert.equal(out.virtual.quantity,'3.000000');assert.deepEqual(out.items.map(i=>i.stock),['7.000000']);assert.equal(out.totals.sale,'4.0000000000');
 const forged=structuredClone(raw);forged.virtual.quantity='4.000000';assert.throws(()=>stockResponse(forged,route,operation),error=>error.status===502);
 const extra=structuredClone(raw);extra.items[0].secret='x';assert.throws(()=>stockResponse(extra,route,operation),error=>error.status===502);
 const options=await run(`/v1/estoque/composicoes/componentes?q=${encodeURIComponent('HTTP leitura')}&excluir=${kit.id}`);
 assert.deepEqual(options.items.map(i=>i.name),['HTTP leitura A']);
 const exported=await run('/v1/estoque/composicoes/exportacao?offset=0&limit=500');
 assert.ok(exported.items.some(i=>i.product_id===kit.id&&i.quantity==='2.000000'));
});

test('222 Novo Lançamento of a composition through the Worker: lines cross-checked against the requested quantity',async()=>{
 const depot=await f.warehouse('HTTP lançamento');
 const a=await f.product('HTTP lançado A');await f.launch(a.id,depot.id,'receipt','10');
 const kit=await f.kit('HTTP kit lançado',[[a,'2.5']]);
 const body={command_id:randomUUID(),kind:'issue',warehouse_id:depot.id,quantity:'2',note:'Saída HTTP'};
 const {raw,route,operation}=await stock(`/v1/estoque/composicoes/${kit.id}/lancamentos`,{method:'POST',body});
 const out=stockResponse(raw,route,operation);
 assert.deepEqual(out.lines,[{product_id:a.id,role:'component',per_kit:'2.500000',quantity:'-5.000000'}]);
 const forged=structuredClone(raw);forged.lines[0].quantity='-4.000000';forged.movement.items[0].quantity='-4.000000';assert.throws(()=>stockResponse(forged,route,operation),error=>error.status===502);
 const replay=await run(`/v1/estoque/composicoes/${kit.id}/lancamentos`,{method:'POST',body});assert.equal(replay.replayed,true);
 const listed=await run(`/v1/estoque/composicoes/${kit.id}/lancamentos?limit=5`,{user:f.users.consulta});
 assert.deepEqual(listed.items.map(i=>[i.movement_id,i.lines[0].quantity]),[[out.movement.id,'-5.000000']]);
 const raw2=await stock(`/v1/estoque/composicoes/${kit.id}/lancamentos?limit=5`);const bad=structuredClone(raw2.raw);bad.items[0].lines[0].quantity='5.000000';
 assert.throws(()=>stockResponse(bad,raw2.route,raw2.operation),error=>error.status===502);
 await assert.rejects(run(`/v1/estoque/composicoes/${kit.id}/lancamentos`,{method:'POST',body:{...body,command_id:randomUUID()},user:f.users.vendas}),fails('42501'));
});

test('222 document stock and reservation previews with a composition pass the Worker projections (SQL -> HTTP -> DTO)',async()=>{
 const depot=await f.warehouse('HTTP venda');
 const a=await f.product('HTTP venda A'),b=await f.product('HTTP venda B');await f.launch(a.id,depot.id,'receipt','20');await f.launch(b.id,depot.id,'receipt','20');
 const both=await f.kit('HTTP kit venda',[[a,'2'],[b,'1']],{stock_type:'physical',post_mode:'both'});await f.launch(both.id,depot.id,'receipt','5');
 const sale=await f.transition(await f.order('sales_orders',[f.item(both,'2'),f.item(a,'1')],depot.id),'verified');
 const base=`/v1/documentos-estoque/sales_orders/${sale.id}`,day='2026-10-20',reason='Venda HTTP';
 const preview=(await executeDocumentStockRoute(await parseDocumentStockRoute(post(`${base}/preview`,{expected_document_version:sale.version,occurred_on:day,reason})),{userId:f.users.estoque,rpc:f.rpc})).preview;
 const position=id=>preview.positions.find(p=>p.product_id===id);
 assert.deepEqual(position(a.id).sources.map(s=>s.kit_product_id??null),[both.id,null]);assert.equal(position(a.id).quantity,'-5.000000');
 assert.deepEqual(position(both.id).sources.map(s=>Object.keys(s).sort()),[['id','position','quantity']]);
 const reservation=await executeStockReservationsRoute(await parseStockReservationsRoute(post(`/v1/reservas-estoque/pedidos/${sale.id}/preview`,{expected_document_version:sale.version,occurred_on:day,reason})),{userId:f.users.estoque,rpc:f.rpc});
 assert.equal(reservation.preview.positions.length,3);
 // Forged sources fail closed in both projections.
 const tamper=async(rpcName,change,run)=>{const rpc=async(name,args)=>{const value=await f.rpc(name,args);return name===rpcName?change(structuredClone(value)):value;};await assert.rejects(run(rpc),error=>error.status===502||error.status===503);};
 await tamper('erp_document_stock_preview',v=>{const s=v.preview.positions.find(p=>p.product_id===a.id).sources[0];s.component_quantity='3.000000';return v;},
  async rpc=>executeDocumentStockRoute(await parseDocumentStockRoute(post(`${base}/preview`,{expected_document_version:sale.version,occurred_on:day,reason})),{userId:f.users.estoque,rpc}));
 await tamper('erp_stock_reservation_preview',v=>{const s=v.preview.positions.find(p=>p.product_id===a.id).sources[0];s.kit_quantity='3.000000';return v;},
  async rpc=>executeStockReservationsRoute(await parseStockReservationsRoute(post(`/v1/reservas-estoque/pedidos/${sale.id}/preview`,{expected_document_version:sale.version,occurred_on:day,reason})),{userId:f.users.estoque,rpc}));
 const posted=await executeDocumentStockRoute(await parseDocumentStockRoute(post(`${base}/post`,{expected_document_version:sale.version,occurred_on:day,reason,command_id:randomUUID(),preview_hash:preview.preview_hash,ignored_item_ids:[]})),{userId:f.users.estoque,rpc:f.rpc});
 assert.equal(posted.movement.items.length,3);
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id),await f.balance(both.id,depot.id)],['15.000000','18.000000','3.000000']);
});

test('223 Estoque de Produtos with Tipo de Estoque Virtual passes the dashboard projection (totals = considered warehouses)',async()=>{
 const one=await f.warehouse('HTTP painel 1'),two=await f.warehouse('HTTP painel 2');
 const a=await f.product('HTTP painel A');await f.launch(a.id,one.id,'receipt','4');await f.launch(a.id,two.id,'receipt','9');
 await f.kit('HTTP painel kit',[[a,'3']]);
 const out=await run(`/v1/estoque/painel/estoque?q=${encodeURIComponent("HTTP painel")}&tipo_estoque=virtual`,{user:f.users.admin});
 assert.deepEqual(out.items.map(i=>[i.name,i.quantity]),[['HTTP painel kit','4.000000']]);
 assert.equal(out.totals.quantity,'4.000000');
});
