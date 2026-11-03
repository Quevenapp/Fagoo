import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneDFixture,migrationSql,fails} from './helpers/stock-lane-d-fixture.mjs';

// 222/223 on PGlite (every migration published up to 190, then the lane D files) with synthetic data only: the Estrutura of a
// composition, its stock as in Origin (Físico/Virtual, Lançar estoque), documents, reservations and the Preferências toggles.
let f;
before(async()=>{f=await stockLaneDFixture({upto:2});});
after(()=>f?.close());
const get=(id,user=f.users.estoque)=>f.rpc('erp_stock_composition_get',{p_user_id:user,p_product_id:id});
const kitLaunch=async(id,warehouse,kind,quantity,{user=f.users.estoque,command=randomUUID(),own=false,price=null,cost=null,note=null}={})=>f.rpc('erp_stock_composition_launch',{p_user_id:user,
 p_command_id:command,p_kind:kind,p_product_id:id,p_warehouse_id:warehouse,p_quantity:quantity,p_expected_version:own?await f.version(id,warehouse):null,p_note:note,p_unit_price:price,p_unit_cost:cost});
const docPreview=(d,user=f.users.estoque)=>f.rpc('erp_document_stock_preview',{p_user_id:user,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética'});
const docPost=async(d,{user=f.users.estoque,command=randomUUID()}={})=>{const p=(await docPreview(d,user)).preview;
 return f.rpc('erp_document_stock_post',{p_user_id:user,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_command_id:command,p_preview_hash:p.preview_hash,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética',p_ignored_item_ids:p.ignored.map(i=>i.id).sort()});};

test('222 entry points are SECURITY DEFINER for service_role only; tables have RLS and no grants; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_composition_get(uuid,uuid)','public.erp_stock_composition_components(uuid,text,uuid)',
  'public.erp_stock_product_compose(uuid,uuid,integer,uuid,jsonb,jsonb,jsonb)','public.erp_stock_composition_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text)','public.erp_stock_composition_launches(uuid,uuid,integer)',
  'public.erp_stock_composition_export(uuid,integer,integer,boolean)','public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const table of['erp_stock.composition','erp_stock.composition_item','erp_stock.composition_command']){
  assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='${table}'::regclass`),true,table);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','${table}','SELECT') v`),false,table);
 }
 for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','erp_stock.composition_current','SELECT') v`),false);
 for(const internal of['erp_stock.composition_lines(uuid,numeric)','erp_stock.virtual_quantity(uuid,uuid)','erp_stock.composition_apply_values(uuid,uuid,uuid,boolean)'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200222_stock_compositions.sql')),/stock_compositions_222_previous_definition_changed/);await f.db.exec('rollback');
 await assert.rejects(f.db.exec(await migrationSql('202610200223_stock_composition_views.sql')),/stock_composition_views_223_previous_definition_changed/);await f.db.exec('rollback');
});

test('222 Estrutura: product and structure in one command, versions, replay, conflicts, validation and immutable history',async()=>{
 const a=await f.product('Parafuso estrutura',{price:'1.5'}),b=await f.product('Porca estrutura',{price:'0.25'}),service=await f.product('Montagem',{kind:'S'});
 const command=randomUUID();
 const created=await f.compose(null,{stock_type:'physical',post_mode:'both',items:[{component_id:a.id,quantity:'4'},{component_id:b.id,quantity:'4.5'}]},
  {data:{name:'Kit fixação',unit:'KIT',kind:'P',format:'E',price:'9'},command});
 const id=created.record.id;
 assert.equal(created.replayed,false);assert.equal(created.record.format,'E');
 assert.deepEqual(created.composition,{stock_type:'physical',post_mode:'both',version:1,updated_at:created.composition.updated_at,
  items:[{position:1,component_id:a.id,quantity:'4.000000'},{position:2,component_id:b.id,quantity:'4.500000'}]});
 // Same UUID and body: the stored receipt; another body: conflict.
 const replay=await f.rpc('erp_stock_product_compose',{p_user_id:f.users.estoque,p_id:null,p_expected_version:0,p_command_id:command,p_data:{name:'Kit fixação',unit:'KIT',kind:'P',format:'E',price:'9'},p_acknowledged:null,
  p_composition:{expected_version:0,stock_type:'physical',post_mode:'both',items:[{component_id:a.id,quantity:'4'},{component_id:b.id,quantity:'4.5'}]}});
 assert.equal(replay.replayed,true);assert.equal(replay.record.id,id);
 await assert.rejects(f.rpc('erp_stock_product_compose',{p_user_id:f.users.estoque,p_id:null,p_expected_version:0,p_command_id:command,p_data:{name:'Outro kit',unit:'KIT',kind:'P',format:'E'},p_acknowledged:null,p_composition:null}),fails('40001'));
 // A new version replaces the structure; the previous version stays in the history.
 const second=await f.compose(id,{stock_type:'physical',post_mode:'components',items:[{component_id:b.id,quantity:'2'}]});
 assert.equal(second.composition.version,2);assert.deepEqual(second.composition.items.map(i=>i.component_id),[b.id]);
 assert.equal(await f.scalar('select count(*)::integer v from erp_stock.composition_item where product_id=$1',[id]),3);
 // Only the structure changed: the product keeps its version. Stale structure version (CAS) and a stale product version.
 assert.equal(await f.recordVersion(id),created.record.version);
 await assert.rejects(f.rpc('erp_stock_product_compose',{p_user_id:f.users.estoque,p_id:id,p_expected_version:await f.recordVersion(id),p_command_id:randomUUID(),p_data:{name:'Kit fixação'},p_acknowledged:null,
  p_composition:{expected_version:1,stock_type:'physical',post_mode:'components',items:[]}}),fails('40001'));
 await assert.rejects(f.rpc('erp_stock_product_compose',{p_user_id:f.users.estoque,p_id:id,p_expected_version:(await f.recordVersion(id))+5,p_command_id:randomUUID(),p_data:{name:'Kit fixação'},p_acknowledged:null,
  p_composition:{expected_version:2,stock_type:'physical',post_mode:'components',items:[]}}),fails('40001'));
 // Invalid structures: Virtual must post the components, components are simple products, no repetition, no self reference.
 const invalid=async structure=>assert.rejects(f.compose(id,structure),fails('22023'));
 await invalid({stock_type:'virtual',post_mode:'both',items:[]});
 await invalid({items:[{component_id:service.id,quantity:'1'}]});
 await invalid({items:[{component_id:a.id,quantity:'1'},{component_id:a.id,quantity:'2'}]});
 await invalid({items:[{component_id:id,quantity:'1'}]});
 await invalid({items:[{component_id:a.id,quantity:'0'}]});
 await invalid({items:[{component_id:a.id,quantity:'1.1234567'}]});
 const other=await f.kit('Kit dentro',[[a,'1']]);await invalid({items:[{component_id:other.id,quantity:'1'}]});
 const inactive=await f.product('Inativo estrutura');await f.setActive(inactive.id,false);await invalid({items:[{component_id:inactive.id,quantity:'1'}]});
 // A structure needs the format "Com composição".
 const simple=await f.product('Simples sem estrutura');await assert.rejects(f.compose(simple.id,{items:[]}),fails('22023'));
 // Only product writers save it; the history cannot be rewritten.
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal,f.users.financeiro])await assert.rejects(f.compose(id,{stock_type:'physical',post_mode:'components',items:[]},{user}),fails('42501'));
 await assert.rejects(f.db.query('update erp_stock.composition_item set quantity=9 where product_id=$1',[id]),/erp_stock_immutable_ledger/);
 await assert.rejects(f.db.query("update erp_stock.composition set post_mode='product' where product_id=$1",[id]),/erp_stock_composition_immutable/);
 await assert.rejects(f.db.query('delete from erp_stock.composition_command where product_id=$1',[id]),/erp_stock_immutable_ledger/);
});

test('222 Estrutura read: components with code, stock, prices and totals; saldo virtual per warehouse; readers only',async()=>{
 const one=await f.warehouse('Leitura 1'),two=await f.warehouse('Leitura 2'),ignored=await f.warehouse('Leitura ignorado',true);
 const a=await f.product('Leitura A',{price:'2',code:'LA-1'}),b=await f.product('Leitura B',{price:'3.333'});
 await f.productDetail(a.id,{suppliers:[{supplier_id:f.contact.id,cost_price:'1.1',is_default:true}]});
 await f.launch(a.id,one.id,'receipt','10');await f.launch(b.id,one.id,'receipt','4');await f.launch(a.id,two.id,'receipt','3');await f.launch(b.id,two.id,'receipt','30');
 await f.launch(a.id,ignored.id,'receipt','100');await f.launch(b.id,ignored.id,'receipt','100');
 const kit=await f.kit('Leitura kit virtual',[[a,'2'],[b,'1']]);
 const value=await get(kit.id);
 assert.equal(value.scope,'stock_composition');assert.equal(value.stock_visible,true);
 assert.deepEqual(value.composition&&[value.composition.stock_type,value.composition.post_mode,value.composition.version],['virtual','components',1]);
 assert.deepEqual(value.items.map(i=>[i.code,i.quantity,i.price,i.cost_price,i.stock,i.problem]),[['LA-1','2.000000','2.0000000000','1.1000000000','13.000000',null],[null,'1.000000','3.3330000000',null,'34.000000',null]]);
 assert.deepEqual([value.totals.sale,value.totals.cost,value.totals.uncosted],['7.3330000000','2.2000000000',1]);
 // One: min(10/2, 4/1)=4; two: min(3/2, 30)=1 (whole compositions); the ignored warehouse stays out of the total.
 assert.equal(value.virtual.quantity,'5.000000');
 const per=Object.fromEntries(value.virtual.warehouses.map(w=>[w.name,w.quantity]));
 assert.deepEqual([per['Leitura 1'],per['Leitura 2'],per['Leitura ignorado']],['4.000000','1.000000','50.000000']);
 assert.equal((await get(a.id)).used_in,1);
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal])assert.equal((await get(kit.id,user)).items.length,2);
 await assert.rejects(get(kit.id,f.users.financeiro),fails('42501'));await assert.rejects(get(randomUUID()),fails('P0002'));
 // Autocomplete of the Componente: simple active products only.
 const options=await f.rpc('erp_stock_composition_components',{p_user_id:f.users.estoque,p_query:'Leitura',p_exclude:kit.id});
 assert.deepEqual(options.items.map(i=>i.name).sort(),['Leitura A','Leitura B']);
});

test('222 stock engine: a Físico composition has its own balance; Virtual and compositions without a structure stay refused',async()=>{
 const depot=await f.warehouse('Motor 222');
 const a=await f.product('Motor A');
 const raw=await f.product('Kit sem estrutura',{format:'E'});
 await assert.rejects(f.launch(raw.id,depot.id,'receipt','1'),fails('22023'));
 const physical=await f.kit('Kit físico produto',[[a,'1']],{stock_type:'physical',post_mode:'product'});
 await f.launch(physical.id,depot.id,'receipt','5');await f.launch(physical.id,depot.id,'balance','3');
 assert.equal(await f.balance(physical.id,depot.id),'3.000000');
 const virtual=await f.kit('Kit virtual motor',[[a,'1']]);
 await assert.rejects(f.launch(virtual.id,depot.id,'receipt','1'),fails('22023'));
 // A Físico composition with its own stock cannot become Virtual.
 await assert.rejects(f.compose(physical.id,{stock_type:'virtual',post_mode:'components',items:[{component_id:a.id,quantity:'1'}]}),fails('22023'));
});

test('222 Novo Lançamento of a composition: components (and the composition itself) in one movement, replay and exact quantities',async()=>{
 const depot=await f.warehouse('Lançamento 222');
 const a=await f.product('Lançado A'),b=await f.product('Lançado B');
 await f.launch(a.id,depot.id,'receipt','10');await f.launch(b.id,depot.id,'receipt','10');
 const virtual=await f.kit('Kit lançado',[[a,'2'],[b,'0.5']]);
 const command=randomUUID(),result=await kitLaunch(virtual.id,depot.id,'issue','3',{command,note:'Saída da composição'});
 assert.deepEqual(result.lines.map(l=>[l.product_id,l.quantity,l.role]),[[a.id,'-6.000000','component'],[b.id,'-1.500000','component']]);
 assert.equal(result.detail,null);
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id)],['4.000000','8.500000']);
 assert.equal(await f.scalar('select reference v from erp_stock.movement where id=$1',[result.movement.id]),'Composição Kit lançado');
 const again=await kitLaunch(virtual.id,depot.id,'issue','3',{command,note:'Saída da composição'});
 assert.equal(again.replayed,true);assert.equal(await f.balance(a.id,depot.id),'4.000000');
 await assert.rejects(kitLaunch(virtual.id,depot.id,'issue','4',{command,note:'Saída da composição'}),fails('40001'));
 // Prices only for the composition's own lançamento; quantities that would need more than 6 decimals are refused.
 await assert.rejects(kitLaunch(virtual.id,depot.id,'receipt','1',{price:'2'}),fails('22023'));
 const fine=await f.kit('Kit fracionado',[[a,'0.333333']]);await assert.rejects(kitLaunch(fine.id,depot.id,'receipt','0.5'),fails('22023'));
 // The negative policy (100) protects every component.
 await assert.rejects(kitLaunch(virtual.id,depot.id,'issue','3'),fails('22023'));
 // Físico + Produto e componente: the composition's own position (CAS) and the components.
 const both=await f.kit('Kit ambos',[[a,'1']],{stock_type:'physical',post_mode:'both'});
 const in2=await kitLaunch(both.id,depot.id,'receipt','2',{own:true,price:'7',cost:'6'});
 assert.deepEqual(in2.lines.map(l=>l.role),['composition','component']);assert.equal(in2.detail.unit_price,'7.0000000000');
 assert.deepEqual([await f.balance(both.id,depot.id),await f.balance(a.id,depot.id)],['2.000000','6.000000']);
 await assert.rejects(f.rpc('erp_stock_composition_launch',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'receipt',p_product_id:both.id,p_warehouse_id:depot.id,p_quantity:'1',p_expected_version:0,p_note:null,p_unit_price:null,p_unit_cost:null}),fails('40001'));
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal])await assert.rejects(kitLaunch(virtual.id,depot.id,'receipt','1',{user}),fails('42501'));
 // The movement is a normal 009 movement: the extrato reverses it as a whole.
 const reversed=await f.reverse(result.movement.id);
 assert.equal(reversed.movement.kind,'reversal');assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id)],['12.000000','10.000000']);
 // The lançamentos of the composition (newest first) with the current version of each position, for the joint reversal.
 const list=await f.rpc('erp_stock_composition_launches',{p_user_id:f.users.consulta,p_product_id:virtual.id,p_limit:10});
 assert.deepEqual(list.items.map(i=>[i.movement_id,i.kind,i.reversed_by,i.lines.length]),[[result.movement.id,'issue',reversed.movement.id,2]]);
 assert.equal(list.items[0].lines.find(l=>l.product_id===a.id).expected_version,await f.version(a.id,depot.id));
 await assert.rejects(f.rpc('erp_stock_composition_launches',{p_user_id:f.users.financeiro,p_product_id:virtual.id,p_limit:10}),fails('42501'));
 await assert.rejects(f.rpc('erp_stock_composition_launches',{p_user_id:f.users.consulta,p_product_id:virtual.id,p_limit:21}),fails('22023'));
});

test('222 sales order and OS: the composition posts its components (Lançar estoque), the preview says where each quantity came from',async()=>{
 const depot=await f.warehouse('Venda 222');
 const a=await f.product('Venda A'),b=await f.product('Venda B');
 await f.launch(a.id,depot.id,'receipt','20');await f.launch(b.id,depot.id,'receipt','20');
 const virtual=await f.kit('Kit venda virtual',[[a,'2'],[b,'1']]);
 const both=await f.kit('Kit venda ambos',[[b,'3']],{stock_type:'physical',post_mode:'both'});
 await f.launch(both.id,depot.id,'receipt','5');
 const sale=await f.transition(await f.order('sales_orders',[f.item(virtual,'2'),f.item(a,'1'),f.item(both,'1')],depot.id),'verified');
 const preview=(await docPreview(sale)).preview;
 const position=id=>preview.positions.find(p=>p.product_id===id);
 assert.equal(position(a.id).quantity,'-5.000000');
 assert.deepEqual(position(a.id).sources.map(s=>[s.position,s.quantity,s.kit_product_id??null,s.kit_quantity??null,s.component_quantity??null]),[[1,'4.000000',virtual.id,'2.000000','2.000000'],[2,'1.000000',null,null,null]]);
 assert.equal(position(b.id).quantity,'-5.000000');assert.equal(position(both.id).quantity,'-1.000000');
 assert.equal(position(virtual.id),undefined);
 const posted=await docPost(sale);
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id),await f.balance(both.id,depot.id)],['15.000000','15.000000','4.000000']);
 // Reversal of the document restores every position (component and composition).
 const current=await f.scalar('select version v from erp_documents.document where id=$1',[sale.id]);
 const rp=(await f.rpc('erp_document_stock_reverse_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:current,p_posting_id:posted.posting.id,p_posting_version:1,p_occurred_on:'2026-10-20',p_reason:'Estorno sintético'})).preview;
 await f.rpc('erp_document_stock_reverse',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:current,p_posting_id:posted.posting.id,p_posting_version:1,p_command_id:randomUUID(),p_preview_hash:rp.preview_hash,p_occurred_on:'2026-10-20',p_reason:'Estorno sintético'});
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id),await f.balance(both.id,depot.id)],['20.000000','20.000000','5.000000']);
 // Without stock, the sale is refused like any product; a composition without a structure is still refused.
 const big=await f.transition(await f.order('sales_orders',[f.item(virtual,'50')],depot.id),'verified');
 await assert.rejects(docPreview(big),fails('22023'));
 const raw=await f.product('Kit venda sem estrutura',{format:'E'});
 const unstructured=await f.transition(await f.order('sales_orders',[f.item(raw,'1')],depot.id),'verified');
 await assert.rejects(docPreview(unstructured),fails('22023'));
 // A purchase order with a composition keeps being refused (the receipts of 090 never receive compositions).
 const purchase=await f.order('purchase_orders',[f.item(virtual,'1')],depot.id);
 await assert.rejects(docPreview(purchase),fails('22023'));
});

test('222 reservation (070) of a sales order with a composition reserves and consumes the components',async()=>{
 const depot=await f.warehouse('Reserva 222');
 const a=await f.product('Reserva A');await f.launch(a.id,depot.id,'receipt','10');
 const virtual=await f.kit('Kit reserva',[[a,'3']]);
 const sale=await f.transition(await f.order('sales_orders',[f.item(virtual,'2')],depot.id),'verified');
 const args={p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-20',p_reason:'Reserva sintética'};
 const pre=(await f.rpc('erp_stock_reservation_preview',args)).preview;
 assert.deepEqual(pre.positions.map(p=>[p.product_id,p.quantity,p.sources[0].kit_product_id]),[[a.id,'6.000000',virtual.id]]);
 await f.rpc('erp_stock_reservation_apply',{...args,p_command_id:randomUUID(),p_preview_hash:pre.preview_hash,p_ignored_item_ids:[]});
 assert.equal(await f.scalar('select erp_stock.reserved_quantity($1,$2)::text v',[a.id,depot.id]),'6.000000');
 // The reservation protects the component balance against a manual issue.
 await assert.rejects(f.launch(a.id,depot.id,'issue','5'),fails('40001'));
});

test('222 Preferências: price, weight and cost of the composition follow the components (structure save and component save)',async()=>{
 await f.setPreferences('cadastros-produtos',{'produtos.composicao_preco':true,'produtos.composicao_peso':true,'produtos.composicao_custo':true});
 try{
  const a=await f.product('Toggle A',{price:'2.5',net_weight:'0.1',gross_weight:'0.2'}),b=await f.product('Toggle B',{price:'1',net_weight:'1',gross_weight:'1.5'});
  await f.productDetail(a.id,{suppliers:[{supplier_id:f.contact.id,cost_price:'1.25',is_default:true}]});
  const kit=await f.product('Kit toggles',{format:'E',price:'99'});
  await f.productDetail(kit.id,{suppliers:[{supplier_id:f.contact.id,cost_price:'50',is_default:true}]});
  const saved=await f.compose(kit.id,{stock_type:'physical',post_mode:'components',items:[{component_id:a.id,quantity:'2'},{component_id:b.id,quantity:'3'}]});
  assert.deepEqual([saved.record.price,saved.record.net_weight,saved.record.gross_weight],['8.0000','3.200000','4.900000']);
  assert.equal(saved.applied.cost_price,'2.5000000000');
  assert.equal(await f.scalar('select cost_price=2.5 v from erp_catalog.product_supplier where record_id=$1 and is_default',[kit.id]),true);
  // A component saved through the stock command updates every composition that uses it, with the kit's version and audit.
  const before=await f.recordVersion(kit.id),command=randomUUID();
  const synced=await f.rpc('erp_stock_product_compose',{p_user_id:f.users.estoque,p_id:b.id,p_expected_version:await f.recordVersion(b.id),p_command_id:command,p_data:{price:'2'},p_acknowledged:null,p_composition:null});
  assert.deepEqual(synced.synced.map(s=>[s.product_id,s.applied.price]),[[kit.id,'11.0000000000']]);
  assert.equal(await f.scalar('select price=11 v from erp_catalog.product where record_id=$1',[kit.id]),true);
  assert.ok(await f.recordVersion(kit.id)>before);
  assert.ok(await f.scalar("select count(*)::integer v from erp_catalog.audit where record_id=$1 and action='update'",[kit.id])>=1);
  const replay=await f.rpc('erp_stock_product_compose',{p_user_id:f.users.estoque,p_id:b.id,p_expected_version:(await f.recordVersion(b.id))-1,p_command_id:command,p_data:{price:'2'},p_acknowledged:null,p_composition:null});
  assert.equal(replay.replayed,true);
  // Without a default supplier the cost of the composition is not written.
  const lonely=await f.product('Kit sem fornecedor',{format:'E'});
  const out=await f.compose(lonely.id,{stock_type:'physical',post_mode:'components',items:[{component_id:a.id,quantity:'1'}]});
  assert.equal(out.applied.cost_skipped,'no_default_supplier');
 }finally{await f.setPreferences('cadastros-produtos',{'produtos.composicao_preco':false,'produtos.composicao_peso':false,'produtos.composicao_custo':false});}
});

test('223 Estoque de Produtos: Tipo de Estoque Virtual lists the Virtual compositions with the saldo virtual per warehouse',async()=>{
 const depot=await f.warehouse('Painel 223');
 const a=await f.product('Painel A',{price:'1'}),b=await f.product('Painel B',{price:'1'});
 await f.launch(a.id,depot.id,'receipt','9');await f.launch(b.id,depot.id,'receipt','2');
 const virtual=await f.kit('Painel kit virtual',[[a,'3'],[b,'1']],{},{price:'20'});
 const physical=await f.kit('Painel kit físico',[[a,'1']],{stock_type:'physical',post_mode:'product'});await f.launch(physical.id,depot.id,'receipt','4');
 const dash=type=>f.rpc('erp_stock_dashboard_stock',{p_user_id:f.users.admin,p_query:'Painel',p_search_by:'description',p_warehouse_id:depot.id,p_brand:null,p_page:1,p_size:100,p_supplier_id:null,p_stock_type:type});
 const v=await dash('virtual');
 assert.deepEqual(v.items.map(i=>[i.name,i.quantity,i.value]),[['Painel kit virtual','2.000000','40.00']]);
 assert.equal(v.totals.quantity,'2.000000');assert.deepEqual(v.warehouses.map(w=>w.quantity),['2.000000']);
 const p=await dash('physical');
 assert.deepEqual(p.items.map(i=>i.name).sort(),['Painel A','Painel B','Painel kit físico']);
 assert.equal((await dash(null)).items.length,4);
});

test('222 Exportação de estruturas: one row per component, batches of up to 500, deleted compositions only on request',async()=>{
 const a=await f.product('Exportado A',{code:'EXA'});
 const kit=await f.kit('Exportação kit',[[a,'1.5']]);
 const all=await f.rpc('erp_stock_composition_export',{p_user_id:f.users.consulta,p_offset:0,p_limit:500,p_include_deleted:false});
 const row=all.items.find(i=>i.product_id===kit.id);
 assert.deepEqual([row.component_code,row.quantity,row.stock_type,row.post_mode,row.product_deleted],['EXA','1.500000','virtual','components',false]);
 await assert.rejects(f.rpc('erp_stock_composition_export',{p_user_id:f.users.consulta,p_offset:0,p_limit:501,p_include_deleted:false}),fails('22023'));
 await assert.rejects(f.rpc('erp_stock_composition_export',{p_user_id:f.users.financeiro,p_offset:0,p_limit:10,p_include_deleted:false}),fails('42501'));
});

test('222 Estrutura save keeps the stock lock order: the stock mutex is held before the catalog rows are prelocked',async()=>{
 const a=await f.product('Trava A');
 const held=()=>f.scalar("select count(*)::integer v from pg_locks where locktype='advisory' and classid=174852909 and objid=0 and objsubid=2 and pid=pg_backend_pid() and granted");
 await f.db.exec('begin');
 try{
  assert.equal(await held(),0);
  await f.compose(null,{items:[{component_id:a.id,quantity:'1'}]},{data:{name:'Kit trava',unit:'UN',kind:'P',format:'E'}});
  assert.equal(await held(),1,'the structure save holds the stock mutex, as every stock writer does before locking catalog rows');
 }finally{await f.db.exec('rollback');}
});
