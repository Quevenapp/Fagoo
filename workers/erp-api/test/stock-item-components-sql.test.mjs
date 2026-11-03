import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFFixture,migrationSql,fails} from './helpers/stock-lane-f-fixture.mjs';

// 280 on PGlite (every migration published up to 266, then the lane F files) with synthetic data only: "Componentes do item (kit)"
// of a pedido de venda, the stock it posts, the reservation by situation and the locks.
let f,target,a,b,c,kit;
after(()=>f?.close());
const view=(doc,item,user=f.users.vendas)=>f.rpc('erp_stock_item_components',{p_user_id:user,p_document_id:doc,p_item_id:item});
const version=async id=>f.scalar('select version v from erp_documents.document where id=$1',[id]);
const save=async(doc,item,components,{user=f.users.vendas,command=randomUUID(),expected,documentVersion}={})=>f.rpc('erp_stock_item_components_save',{p_user_id:user,p_command_id:command,
 p_document_id:doc,p_expected_document_version:documentVersion??await version(doc),p_item_id:item,p_expected_version:expected??(await view(doc,item,f.users.admin)).version,p_components:components});
const itemOf=async doc=>f.scalar('select id::text v from erp_documents.item where document_id=$1 order by position limit 1',[doc]);
const post=async doc=>{const v=await version(doc);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:doc,p_expected_version:v,p_occurred_on:'2026-10-20',p_reason:'Baixa kit 280'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:doc,p_expected_version:v,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Baixa kit 280',p_ignored_item_ids:[]});return p;};
before(async()=>{
 f=await stockLaneFFixture({upto:4});
 target=await f.warehouse('Depósito kit 280');a=await f.product('Componente A 280');b=await f.product('Componente B 280');c=await f.product('Componente C 280');
 for(const p of[a,b,c])await f.launch(p.id,target.id,'receipt','100');
 kit=await f.kit('Kit 280',[[a,'2'],[b,'1']]);
});

test('280 entry points are SECURITY DEFINER for service_role only; tables have RLS and no grants; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_item_components(uuid,uuid,uuid)','public.erp_stock_item_components_save(uuid,uuid,uuid,integer,uuid,integer,jsonb)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const table of['erp_stock.item_component','erp_stock.item_component_command']){
  assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='${table}'::regclass`),true,table);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','${table}','SELECT') v`),false,table);
 }
 for(const internal of['erp_stock.item_component_rows(uuid,uuid)','erp_stock.item_composition_lines(uuid,uuid,numeric)','erp_stock.item_components_dto(uuid,uuid,uuid)','erp_stock.command_taken(uuid)'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200280_stock_item_components.sql')),/stock_item_components_280_previous_definition_changed/);await f.db.exec('rollback');
});

test('280 Componentes do item (kit): read, save, replay, CAS, restore; Lançar estoque moves the components of the item',async()=>{
 const order=await f.order('sales_orders',[f.item(kit,'3')],target.id,['verified']);const item=await itemOf(order.id);
 const first=await view(order.id,item);
 assert.deepEqual({editable:first.editable,edited:first.edited,version:first.version,components:first.components.map(x=>[x.name,x.quantity,x.total,x.stock])},
  {editable:true,edited:false,version:0,components:[['Componente A 280','2.000000','6.000000000000','100.000000'],['Componente B 280','1.000000','3.000000000000','100.000000']]});
 const estoque=await view(order.id,item,f.users.estoque);assert.deepEqual([estoque.editable,estoque.reason_code],[false,'role'],'estoque reads, the pedido de venda is written by vendas');
 const command=randomUUID(),components=[{component_id:a.id,quantity:'3'},{component_id:c.id,quantity:'0.5'}];
 const before=await version(order.id);
 const saved=await save(order.id,item,components,{command});
 assert.deepEqual({edited:saved.edited,version:saved.version,replayed:saved.replayed,restored:saved.restored,components:saved.components.map(x=>[x.name,x.quantity,x.total])},
  {edited:true,version:1,replayed:false,restored:false,components:[['Componente A 280','3.000000','9.000000000000'],['Componente C 280','0.500000','1.500000000000']]});
 assert.equal(await version(order.id),before+1,'the pedido changes version');
 assert.equal((await save(order.id,item,components,{command,expected:0,documentVersion:before})).replayed,true);
 await assert.rejects(save(order.id,item,[{component_id:a.id,quantity:'1'}],{command,expected:0,documentVersion:before}),fails('40001'));
 await assert.rejects(save(order.id,item,components,{documentVersion:before}),fails('40001'),'stale pedido');
 await assert.rejects(save(order.id,item,[{component_id:a.id,quantity:'4'}],{expected:0}),fails('40001'),'stale components');
 await assert.rejects(save(order.id,item,components),error=>/unchanged/.test(error.message));
 // Invalid components: the kit itself, a composition, an inactive product, repeated, zero, too precise.
 const inactive=await f.product('Componente inativo 280');await f.setActive(inactive.id,false);
 for(const bad of[[{component_id:kit.id,quantity:'1'}],[{component_id:inactive.id,quantity:'1'}]])await assert.rejects(save(order.id,item,bad),fails('22023'));
 for(const bad of[[],[{component_id:a.id,quantity:'1'},{component_id:a.id,quantity:'2'}],[{component_id:a.id,quantity:'0'}],[{component_id:a.id,quantity:'1.1234567'}],[{component_id:a.id,quantity:1}]])
  await assert.rejects(save(order.id,item,bad),fails('22023'));
 for(const user of[f.users.estoque,f.users.consulta,f.users.fiscal])await assert.rejects(save(order.id,item,[{component_id:b.id,quantity:'1'}],{user}),fails('42501'));
 // Lançar estoque moves A×9 and C×1,5 (the components of the item), not B.
 const p=await post(order.id);
 assert.deepEqual(p.positions.map(x=>[x.product_id,x.quantity]).sort(),[[a.id,'-9.000000'],[c.id,'-1.500000']].sort());
 assert.deepEqual([await f.balance(a.id,target.id),await f.balance(b.id,target.id),await f.balance(c.id,target.id)],['91.000000','100.000000','98.500000']);
 // With the stock posted the components are locked (and read as they were posted).
 const locked=await view(order.id,item);assert.deepEqual([locked.editable,locked.reason_code],[false,'posted']);
 await assert.rejects(save(order.id,item,null),error=>error.code==='40001'&&/locked/.test(error.message));
 // Another pedido with the same kit keeps the structure; restoring a pedido returns to it.
 const other=await f.order('sales_orders',[f.item(kit,'1')],target.id,['verified']);const otherItem=await itemOf(other.id);
 await save(other.id,otherItem,[{component_id:c.id,quantity:'1'}]);
 const restored=await save(other.id,otherItem,null);
 assert.deepEqual({edited:restored.edited,version:restored.version,restored:restored.restored,names:restored.components.map(x=>x.name)},{edited:false,version:0,restored:true,names:['Componente A 280','Componente B 280']});
 await assert.rejects(save(other.id,otherItem,null),error=>/unchanged/.test(error.message));
});

test('280 the reservation by situation and the manual reserva follow the components of the item; a composition by Produto is not editable',async()=>{
 const order=await f.order('sales_orders',[f.item(kit,'2')],target.id);const item=await itemOf(order.id);
 await save(order.id,item,[{component_id:c.id,quantity:'2'}]);
 await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['em_aberto']});
 try{
  const reserved=async product=>(await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.consulta,p_product_id:product,p_warehouse_id:null})).items.filter(i=>i.document_id===order.id).map(i=>i.quantity);
  assert.deepEqual(await reserved(c.id),['4.000000']);assert.deepEqual(await reserved(b.id),[]);
 }finally{await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':false});}
 // Manual reserva (070) through the same lançamento rules: it reserves C and then locks the components.
 const verified=await f.transition({...order,version:await version(order.id)},'verified');
 const args={p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:verified.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva kit 280'};
 const pre=(await f.rpc('erp_stock_reservation_preview',args)).preview;
 assert.deepEqual(pre.positions.map(x=>[x.product_id,x.quantity]),[[c.id,'4.000000']]);
 await f.rpc('erp_stock_reservation_apply',{...args,p_command_id:randomUUID(),p_preview_hash:pre.preview_hash,p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 assert.equal((await view(order.id,item)).reason_code,'reserved');
 // "Lançar estoque: Produto": the components do not move, nothing to edit.
 const own=await f.kit('Kit Produto 280',[[a,'1']],{stock_type:'physical',post_mode:'product'});
 const doc=await f.order('sales_orders',[f.item(own,'1')],target.id,['verified']);
 const v=await view(doc.id,await itemOf(doc.id));assert.deepEqual([v.editable,v.reason_code],[false,'product_only']);
 const simple=await f.order('sales_orders',[f.item(a,'1')],target.id);
 assert.equal((await view(simple.id,await itemOf(simple.id))).reason_code,'not_composition');
 await assert.rejects(view(simple.id,randomUUID()),fails('P0002'));
 const purchase=await f.order('purchase_orders',[f.item(a,'1')],target.id,['in_progress']);
 await assert.rejects(view(purchase.id,await itemOf(purchase.id)),fails('P0002'),'only pedidos de venda and OS');
});

test('280 the components belong to the product of the item: a new product (or a removed item) starts again from the structure',async()=>{
 const other=await f.kit('Kit outro 280',[[b,'1']]);
 const order=await f.order('sales_orders',[f.item(kit,'1')],target.id,['verified']);const item=await itemOf(order.id);
 await save(order.id,item,[{component_id:c.id,quantity:'1'}]);
 // The pedido keeps the item (same id) and changes its product to another composition, then back.
 const rewrite=async(product,description)=>{const d=(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:order.id})).document;
  await f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:order.id,p_expected_version:d.version,p_command_id:randomUUID(),
   p_body:{date:d.date,contact_id:d.contact_id,warehouse_id:d.warehouse_id,items:product?[{id:item,product_id:product,description,unit:'UN',quantity:'1',unit_price:'5'}]:[f.item(a,'1')]}});};
 const rows=async()=>f.scalar('select count(*)::integer v from erp_stock.item_component where item_id=$1',[item]);
 await rewrite(other.id,'Kit outro');
 assert.equal(await rows(),0,'the components of the previous product are gone');
 const fresh=await view(order.id,item);
 assert.deepEqual({edited:fresh.edited,version:fresh.version,editable:fresh.editable,names:fresh.components.map(x=>x.name)},{edited:false,version:0,editable:true,names:['Componente B 280']});
 await assert.rejects(save(order.id,item,null,{expected:0}),error=>/unchanged/.test(error.message),'nothing to restore for the new product');
 const saved=await save(order.id,item,[{component_id:a.id,quantity:'2'}],{expected:0});
 assert.deepEqual({edited:saved.edited,version:saved.version,names:saved.components.map(x=>[x.name,x.quantity])},{edited:true,version:1,names:[['Componente A 280','2.000000']]});
 // Back to the first kit: its structure, not the components edited long ago.
 await rewrite(kit.id,'Kit 280');
 const back=await view(order.id,item);
 assert.deepEqual({edited:back.edited,version:back.version,names:back.components.map(x=>x.name)},{edited:false,version:0,names:['Componente A 280','Componente B 280']});
 // The same product rewritten keeps the components; an item removed from the pedido takes them along.
 await save(order.id,item,[{component_id:c.id,quantity:'3'}],{expected:0});
 await rewrite(kit.id,'Kit 280');assert.equal(await rows(),1);
 await rewrite(null);assert.equal(await rows(),0);
 for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}','erp_stock.forget_item_components()','EXECUTE') v`),false);
});
