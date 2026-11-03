import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneCFixture,migrationSql,fails} from './helpers/stock-lane-c-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';
import {productRoute,productOperation,productResponse} from '../src/product-registry.mjs';

// 183 on PGlite (every published migration up to 152, then 181-183) with synthetic data only: "Transferir estoque dos produtos
// selecionados" and the "Saldo inicial" of a new product.
let f;
before(async()=>{f=await stockLaneCFixture({upto:3});});
after(()=>f?.close());
const positions=(source,destination,ids,user=f.users.estoque)=>f.rpc('erp_stock_transfer_positions',{p_user_id:user,p_source_id:source,p_destination_id:destination,p_product_ids:ids});
const batch=(args,user=f.users.estoque)=>f.rpc('erp_stock_transfer_batch',{p_user_id:user,p_note:null,...args});
const lines=async(source,destination,rows)=>Promise.all(rows.map(async([product,quantity,extra={}])=>({product_id:product.id,quantity,source_version:await f.version(product.id,source),destination_version:await f.version(product.id,destination),...extra})));

test('183 entry points are SECURITY DEFINER for service_role only; the command table is immutable with RLS; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_transfer_positions(uuid,uuid,uuid,jsonb)','public.erp_stock_transfer_batch(uuid,uuid,uuid,uuid,text,jsonb)',
  'public.erp_stock_product_create(uuid,uuid,jsonb,jsonb,uuid,text,text,text,text)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 assert.equal(await f.scalar("select relrowsecurity v from pg_class where oid='erp_stock.supply_command'::regclass"),true);
 for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','erp_stock.supply_command','SELECT') v`),false);
 for(const internal of['erp_stock.entry_suggestions(uuid[])','erp_stock.supply_part(uuid,text)'])assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false);
 await assert.rejects(f.db.exec(await migrationSql('202610200183_stock_transfer_batch.sql')),/stock_transfer_183_previous_definition_changed/);await f.db.exec('rollback');
});

test('183 grid positions: Estoque and Estoque Reservado of the origin, both versions, eligibility and the suggested price; writers only',async()=>{
 const from=await f.warehouse('Origem 183'),to=await f.warehouse('Destino 183');
 const a=await f.product('Lote A'),b=await f.product('Lote B inativo'),c=await f.product('Lote C serviço',{kind:'S'});
 await f.launch(a.id,from.id,'receipt','10',{price:'2',cost:'2.2'});await f.launch(b.id,from.id,'receipt','1');await f.setActive(b.id,false);
 // An explicit reservation (070) of a verified sales order in the origin.
 const sale=await f.transition(await f.order('sales_orders',[f.item(a,'4','9')],from.id),'verified');
 const pre=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.admin,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-20',p_reason:'Reserva sintética'})).preview;
 await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.admin,p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:pre.preview_hash,p_occurred_on:'2026-10-20',p_reason:'Reserva sintética',p_ignored_item_ids:[]});
 await f.setPreferences('suprimentos-estoque',{'estoque.exibir_preco_unitario':true});
 const value=await positions(from.id,to.id,[a.id,b.id,c.id]);
 const row=id=>value.items.find(i=>i.product_id===id);
 assert.deepEqual(row(a.id).source,{quantity:'10.000000',version:1,reserved:'4.000000'});assert.deepEqual(row(a.id).destination,{quantity:'0.000000',version:0});
 assert.deepEqual([row(a.id).eligibility,row(a.id).suggested_price,row(a.id).suggested_cost],['eligible','2.0000000000','2.0000000000']);
 assert.deepEqual([row(b.id).eligibility,row(c.id).eligibility,value.show_unit_price],['inactive','not_product',true]);
 await f.setPreferences('suprimentos-estoque',{'estoque.exibir_preco_unitario':false});
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal])await assert.rejects(positions(from.id,to.id,[a.id],user),fails('42501'));
 await assert.rejects(positions(from.id,to.id,[randomUUID()]),fails('P0002'));await assert.rejects(positions(from.id,from.id,[a.id]),fails('22023'));
 // HTTP -> DTO.
 const url=new URL(`https://api.example.test/v1/estoque/transferencias/posicoes?origem=${from.id}&destino=${to.id}&produtos=${a.id},${c.id}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(new Request(url),route,url.searchParams);
 const out=stockResponse(await f.rpc(operation.rpc,{p_user_id:f.users.admin,...operation.args}),route,operation);
 assert.deepEqual(out.items.map(i=>i.eligibility).sort(),['eligible','not_product']);
});

test('183 batch transfer: one command, every product moved with price and cost, receipt kept for the same command, all or nothing',async()=>{
 const from=await f.warehouse('Origem lote'),to=await f.warehouse('Destino lote');
 const a=await f.product('Transferido A'),b=await f.product('Transferido B');
 await f.launch(a.id,from.id,'receipt','10');await f.launch(b.id,from.id,'receipt','3');
 const command=randomUUID(),items=await lines(from.id,to.id,[[a,'4',{unit_price:'1.5',unit_cost:'1.75'}],[b,'3']]);
 const result=await batch({p_command_id:command,p_source_id:from.id,p_destination_id:to.id,p_note:'Reposição da loja',p_items:items});
 assert.equal(result.replayed,false);
 const r=result.receipt;assert.deepEqual([r.note,r.source.id,r.destination.id,r.items.length],['Reposição da loja',from.id,to.id,2]);
 const ra=r.items.find(i=>i.product_id===a.id);
 assert.deepEqual([ra.quantity,ra.source_balance_after,ra.destination_balance_after,ra.unit_price,ra.unit_cost],['4.000000','6.000000','4.000000','1.5000000000','1.7500000000']);
 assert.deepEqual([await f.balance(a.id,from.id),await f.balance(a.id,to.id),await f.balance(b.id,from.id),await f.balance(b.id,to.id)],['6.000000','4.000000','0.000000','3.000000']);
 assert.deepEqual(await f.rows("select m.kind,d.note,d.unit_price::text price from erp_stock.movement m join erp_stock.movement_detail d on d.movement_id=m.id where m.id=$1",[ra.movement_id]),[{kind:'transfer',note:'Reposição da loja',price:'1.5'}],'the detail keeps the numeric typed (the receipt shows ten decimals)');
 const again=await batch({p_command_id:command,p_source_id:from.id,p_destination_id:to.id,p_note:'Reposição da loja',p_items:items});
 assert.deepEqual([again.replayed,again.receipt],[true,r]);
 await assert.rejects(batch({p_command_id:command,p_source_id:from.id,p_destination_id:to.id,p_note:'Outra',p_items:items}),fails('40001'),'same UUID, other body');
 await assert.rejects(batch({p_command_id:command,p_source_id:from.id,p_destination_id:to.id,p_note:'Reposição da loja',p_items:items},f.users.admin),fails('40001'),'same UUID, other actor');
 // A UUID already used by another stock family is refused.
 const used=randomUUID();await f.launch(a.id,from.id,'receipt','1',{command:used});
 await assert.rejects(batch({p_command_id:used,p_source_id:from.id,p_destination_id:to.id,p_items:await lines(from.id,to.id,[[a,'1']])}),fails('40001'));
 // All or nothing: the second product has not enough stock (policy off), so the first one is not moved either.
 const before=[await f.balance(a.id,from.id),await f.balance(a.id,to.id)];
 await assert.rejects(batch({p_command_id:randomUUID(),p_source_id:from.id,p_destination_id:to.id,p_items:await lines(from.id,to.id,[[a,'1'],[b,'1']])}),fails('22023'));
 assert.deepEqual([await f.balance(a.id,from.id),await f.balance(a.id,to.id)],before);
 // Versions are checked (CAS) and the products and warehouses must be available.
 await assert.rejects(batch({p_command_id:randomUUID(),p_source_id:from.id,p_destination_id:to.id,p_items:[{...(await lines(from.id,to.id,[[a,'1']]))[0],source_version:0}]}),fails('40001'));
 await f.setActive(b.id,false);await f.launch(a.id,from.id,'receipt','1');
 await assert.rejects(batch({p_command_id:randomUUID(),p_source_id:from.id,p_destination_id:to.id,p_items:await lines(from.id,to.id,[[b,'1']])}),fails('22023'));
 for(const input of[[],[{product_id:a.id,quantity:'0',source_version:1,destination_version:1}],[{product_id:a.id,quantity:'1',source_version:1,destination_version:1,lot:'L1'}]])
  await assert.rejects(batch({p_command_id:randomUUID(),p_source_id:from.id,p_destination_id:to.id,p_items:input}),fails('22023'));
 await assert.rejects(batch({p_command_id:randomUUID(),p_source_id:from.id,p_destination_id:to.id,p_items:await lines(from.id,to.id,[[a,'1']])},f.users.vendas),fails('42501'));
 // SQL -> HTTP -> DTO with the same command (replay).
 const body={command_id:command,source_id:from.id,destination_id:to.id,note:'Reposição da loja',items:items.map(({unit_price=null,unit_cost=null,...rest})=>({...rest,unit_price,unit_cost}))};
 const url=new URL('https://api.example.test/v1/estoque/transferencias'),route=stockRoute(url.pathname);
 const operation=await stockOperation(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),route,url.searchParams);
 await assert.rejects(f.rpc(operation.rpc,{p_user_id:f.users.estoque,...operation.args}),fails('40001'),'the HTTP body sends null prices explicitly: another body for the same UUID');
 const fresh={...body,command_id:randomUUID(),items:[{product_id:a.id,quantity:'1',source_version:await f.version(a.id,from.id),destination_version:await f.version(a.id,to.id),unit_price:'2',unit_cost:null}]};
 const operation2=await stockOperation(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fresh)}),route,url.searchParams);
 const out=stockResponse(await f.rpc(operation2.rpc,{p_user_id:f.users.estoque,...operation2.args}),route,operation2);
 assert.deepEqual([out.replayed,out.receipt.items[0].unit_price,out.receipt.items[0].unit_cost],[false,'2.0000000000',null]);
});

test('183 Saldo inicial: the product and its entry in one command; a refused entry creates no product; replay returns the same',async()=>{
 const w=await f.warehouse('Saldo inicial 183'),closed=await f.warehouse('Saldo inicial inativo');
 const command=randomUUID(),data={name:'Produto com saldo inicial',unit:'UN',kind:'P',format:'S',price:'12'};
 const create=(args,user=f.users.estoque)=>f.rpc('erp_stock_product_create',{p_user_id:user,p_command_id:command,p_data:data,p_acknowledged:null,p_warehouse_id:w.id,p_quantity:'8',p_unit_price:'5',p_unit_cost:'5.5',p_note:null,...args});
 const result=await create({});
 const id=result.record.id;
 assert.deepEqual([result.replayed,result.initial_balance.quantity,result.initial_balance.note,result.initial_balance.unit_cost,await f.balance(id,w.id)],[false,'8.000000','Saldo inicial','5.5000000000','8.000000']);
 assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where record_id=$1 and action='create'",[id]),1);
 const again=await create({});assert.deepEqual([again.replayed,again.record.id,again.initial_balance.movement_id],[true,id,result.initial_balance.movement_id]);
 await assert.rejects(create({p_quantity:'9'}),fails('40001'));
 // Inactive warehouse: the entry is refused and the product is not created.
 await f.setActive(closed.id,false);const count=await f.scalar("select count(*)::int v from erp_catalog.record where entity='products'");
 await assert.rejects(create({p_command_id:randomUUID(),p_warehouse_id:closed.id,p_data:{...data,name:'Não criado'}}),fails('22023'));
 assert.equal(await f.scalar("select count(*)::int v from erp_catalog.record where entity='products'"),count);
 for(const args of[{p_quantity:'0'},{p_quantity:'-1'},{p_note:'a\nb'}])await assert.rejects(create({p_command_id:randomUUID(),...args}),fails('22023'));
 await assert.rejects(create({p_command_id:randomUUID()},f.users.vendas),fails('42501'));
 // The product form route: initial_balance inside data goes to this command; the receipt is checked.
 const body={command_id:randomUUID(),data:{...data,name:'Produto pela rota',initial_balance:{warehouse_id:w.id,quantity:'2,5'.replace(',','.'),unit_price:'1',note:'Contagem de abertura'}}};
 const url=new URL('https://api.example.test/v1/cadastros/products/completo'),route=productRoute(url.pathname);
 const tools={body:async request=>JSON.parse(await request.text()),validateBase:()=>{}};
 const operation=await productOperation(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),route,url.searchParams,tools);
 assert.equal(operation.rpc,'erp_stock_product_create');assert.equal(Object.hasOwn(operation.args.p_data,'initial_balance'),false);
 const raw=await f.rpc(operation.rpc,{p_user_id:f.users.admin,...operation.args});
 const out=productResponse(raw,route,operation,value=>value);
 assert.deepEqual([out.initial_balance.quantity,out.initial_balance.note,out.initial_balance.warehouse_id],['2.500000','Contagem de abertura',w.id]);
 const forged=structuredClone(raw);forged.initial_balance.quantity='3.000000';assert.throws(()=>productResponse(forged,route,operation,value=>value),error=>error.status===502);
});
