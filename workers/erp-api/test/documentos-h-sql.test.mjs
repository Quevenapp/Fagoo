import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{documentosHFixture}from'./helpers/documentos-h-fixture.mjs';

// Leva H, lane documentos: 390 (IPI and ICMS ST always in the totals) and 391 (several notes per pedido with the balance per item).
// Synthetic data only; nothing emits, transmits or posts effects.
const fails=(code,msg)=>e=>e.code===code&&(!msg||e.message===msg);
let f,product,other,contact,warehouse,saleNature;
const catalog=async(entity,data,user)=>(await f.rpc('erp_catalog_save',{p_user_id:user??f.users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
const saveDoc=(kind,body,user=f.users.admin)=>f.rpc('erp_document_save',{p_user_id:user,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-10',contact_id:contact.id,warehouse_id:warehouse.id,...body}});
const order=async(items)=>(await saveDoc('sales_orders',{items})).document;
const invoice=(items,over={})=>({model:'55',direction:'1',issue_type:'N',series:'1',nature_id:saleNature.id,issue_date:'2026-10-20',crt:'1',purpose:'1',presence:'1',final_consumer:false,
 recipient:{contact_id:contact.id,name:'Cliente sintético',person_type:'J',document:'12345678000190',state:'MG'},items,...over});
const execute=(action,data,command=randomUUID())=>f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:command,p_action:action,p_data:data});
const partial=(doc,data,command=randomUUID(),user=f.users.fiscal)=>f.rpc('erp_fiscal_invoice_partial_create',{p_user_id:user,p_command_id:command,p_document_id:doc,p_data:data});
const balance=(doc,user=f.users.admin)=>f.rpc('erp_document_invoice_balance',{p_user_id:user,p_document_id:doc});
const items=async doc=>(await f.db.query('select id,position,quantity from erp_documents.item where document_id=$1 order by position',[doc])).rows;

before(async()=>{
 f=await documentosHFixture();
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2) on conflict do nothing",[JSON.stringify({state:'SP',cnpj:'11.222.333/0001-81'}),f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 product=await catalog('products',{name:'Peça sintética H',code:'P-H1',unit:'UN',kind:'P',format:'S',price:'10',ncm:'84714900'});
 other=await catalog('products',{name:'Outra peça H',code:'P-H2',unit:'UN',kind:'P',format:'S',price:'5',ncm:'84714900'});
 contact=await catalog('contacts',{name:'Cliente sintético',person_type:'J',document:'12345678000190',ie:'123456789',state:'MG',city:'Belo Horizonte',postal_code:'30110000',street:'Rua Sintética',number:'10'});
 warehouse=await catalog('warehouses',{name:'Depósito H'});
 saleNature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Venda H',direction:'1',crt:'1'}}})).nature;
});
after(()=>f?.close());

test('390: IPI and ICMS ST are kept in the total even with "Exibir IPI e ST" off; the pedido de compra takes its Total ICMS ST',async()=>{
 const sale=(await saveDoc('sales_orders',{items:[{product_id:product.id,description:'Peça',unit:'UN',quantity:'2',unit_price:'10'}],tax_ipi:'1.50',tax_icms_st:'2.25'})).document;
 assert.deepEqual([sale.totals.ipi,sale.totals.icms_st,sale.totals.total],['1.50','2.25','23.75']);
 const purchase=(await saveDoc('purchase_orders',{items:[{product_id:product.id,description:'Peça',unit:'UN',quantity:'1',unit_price:'100',ipi_rate:'10'}],tax_icms_st:'7.00'},f.users.admin)).document;
 assert.deepEqual([purchase.totals.ipi,purchase.totals.icms_st,purchase.totals.total],['10.00','7.00','117.00']);
 // A pedido de compra IPI without item rates is still refused (it follows the IPI % of the items).
 await assert.rejects(()=>saveDoc('purchase_orders',{items:[{product_id:product.id,description:'Peça',unit:'UN',quantity:'1',unit_price:'100'}],tax_ipi:'5.00'}),fails('22023','erp_document_tax_invalid'));
});

test('391: several partial notes per pedido within the balance of each item; the full note stays single',async()=>{
 const sale=await order([{product_id:product.id,description:'Peça',unit:'UN',quantity:'100',unit_price:'10'},{product_id:other.id,description:'Outra',unit:'UN',quantity:'10',unit_price:'5'}]);
 const [a,b]=await items(sale.id);
 let bal=await balance(sale.id);
 assert.deepEqual(bal.items.map(i=>[i.ordered,i.invoiced,i.remaining]),[['100.0000','0.0000','100.0000'],['10.0000','0.0000','10.0000']]);
 const command=randomUUID();
 const first=await partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'40',unit_price:'10'}]),items:[{position:1,document_item_id:a.id,quantity:'40'}]},command);
 assert.deepEqual(first.invoice.orders.map(o=>o.id),[sale.id]);
 assert.equal(first.balance.items[0].remaining,'60.0000');
 // The same command answers the same note and writes nothing new.
 const again=await partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'40',unit_price:'10'}]),items:[{position:1,document_item_id:a.id,quantity:'40'}]},command);
 assert.equal(again.invoice.id,first.invoice.id);
 assert.equal(await f.scalar('select count(*)::int v from erp_fiscal_invoices.invoice_order_item where document_id=$1',[sale.id]),1);
 // Above the balance: refused. 60 more and the other item: accepted. A third note above the balance: refused.
 await assert.rejects(()=>partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'61',unit_price:'10'}]),items:[{position:1,document_item_id:a.id,quantity:'61'}]}),fails('40001','erp_fiscal_invoice_partial_exceeds'));
 const second=await partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'60',unit_price:'10'},{product_id:other.id,description:'Outra',quantity:'10',unit_price:'5'}]),
  items:[{position:1,document_item_id:a.id,quantity:'60'},{position:2,document_item_id:b.id,quantity:'10'}]});
 bal=await balance(sale.id);
 assert.deepEqual(bal.items.map(i=>i.remaining),['0.0000','0.0000']);assert.equal(bal.invoices.length,2);assert.ok(bal.invoices.every(i=>i.partial));
 await assert.rejects(()=>partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'1',unit_price:'10'}]),items:[{position:1,document_item_id:a.id,quantity:'1'}]}),fails('40001','erp_fiscal_invoice_partial_exceeds'));
 // The full "Gerar nota fiscal" is refused next to partial notes.
 await assert.rejects(()=>execute('create',{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'100',unit_price:'10'}]),orders:[sale.id]}),fails('40001','erp_fiscal_invoice_order_has_invoice'));
 // Deleting a partial note gives its quantities back.
 await execute('delete',{id:second.invoice.id,expected_version:1,reason:'Teste sintético'});
 bal=await balance(sale.id);assert.deepEqual(bal.items.map(i=>i.remaining),['60.0000','10.0000']);
 // A note item that does not match the link (product or quantity) is refused; editing a linked item later is refused too.
 await assert.rejects(()=>partial(sale.id,{invoice:invoice([{product_id:other.id,description:'Outra',quantity:'5',unit_price:'5'}]),items:[{position:1,document_item_id:a.id,quantity:'5'}]}),fails('22023','erp_fiscal_invoice_partial_mismatch'));
 await assert.rejects(()=>execute('update',{id:first.invoice.id,expected_version:1,invoice:invoice([{product_id:product.id,description:'Peça',quantity:'30',unit_price:'10'}]),orders:[sale.id]}),fails('40001','erp_fiscal_invoice_partial_locked'));
 // Items of another pedido are refused.
 const otherSale=await order([{product_id:product.id,description:'Peça',unit:'UN',quantity:'1',unit_price:'10'}]);
 const [c]=await items(otherSale.id);
 await assert.rejects(()=>partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'1',unit_price:'10'}]),items:[{position:1,document_item_id:c.id,quantity:'1'}]}),fails('22023','erp_fiscal_invoice_partial_item_invalid'));
});

test('391: a pedido with a full note takes no partial note; only fiscal writers create them; the RPCs are service-only',async()=>{
 const sale=await order([{product_id:product.id,description:'Peça',unit:'UN',quantity:'3',unit_price:'10'}]);
 const [a]=await items(sale.id);
 await execute('create',{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'3',unit_price:'10'}]),orders:[sale.id]});
 assert.deepEqual((await balance(sale.id)).items.map(i=>i.remaining),['0.0000']);
 await assert.rejects(()=>partial(sale.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'1',unit_price:'10'}]),items:[{position:1,document_item_id:a.id,quantity:'1'}]}),fails('40001','erp_fiscal_invoice_order_has_invoice'));
 const fresh=await order([{product_id:product.id,description:'Peça',unit:'UN',quantity:'3',unit_price:'10'}]);const [x]=await items(fresh.id);
 await assert.rejects(()=>partial(fresh.id,{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'1',unit_price:'10'}]),items:[{position:1,document_item_id:x.id,quantity:'1'}]},randomUUID(),f.users.vendas),fails('42501'));
 for(const sig of['public.erp_fiscal_invoice_partial_create(uuid,uuid,uuid,jsonb)','public.erp_document_invoice_balance(uuid,uuid)']){
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'execute') v",[sig]),true);
  for(const r of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${r}',$1,'execute') v`,[sig]),false);}
});

test('392: the lixeira takes documents without effects only, keeps them unchanged and the list leaves them out',async()=>{
 const trash=(action,kind,ids,reason='Pedido duplicado',command=randomUUID(),user=f.users.admin)=>f.rpc('erp_document_trash',{p_user_id:user,p_command_id:command,p_kind:kind,p_action:action,p_ids:ids,p_reason:reason});
 const list=(statuses)=>f.rpc('erp_document_list',{p_user_id:f.users.admin,p_kind:'sales_orders',p_limit:100,p_statuses:statuses?`{${statuses.join(',')}}`:null});
 const free=await order([{product_id:product.id,description:'Peça',unit:'UN',quantity:'1',unit_price:'10'}]);
 const billed=await order([{product_id:product.id,description:'Peça',unit:'UN',quantity:'1',unit_price:'10'}]);
 await execute('create',{invoice:invoice([{product_id:product.id,description:'Peça',quantity:'1',unit_price:'10'}]),orders:[billed.id]});
 const command=randomUUID();
 const done=await trash('delete','sales_orders',[free.id,billed.id],'Pedido duplicado',command);
 const by=Object.fromEntries(done.results.map(r=>[r.id,r]));
 assert.deepEqual([by[free.id].ok,by[billed.id].ok,by[billed.id].reason],[true,false,'invoice_linked']);
 assert.equal((await trash('delete','sales_orders',[free.id,billed.id],'Pedido duplicado',command)).replayed,true);
 await assert.rejects(()=>trash('delete','sales_orders',[free.id],'Outro motivo',command),fails('40001'));
 await assert.rejects(()=>trash('delete','sales_orders',[free.id],''),fails('22023','erp_document_trash_reason'));
 // Out of the operational list, in "Excluídos"; nothing changes while it is there.
 assert.equal((await list(null)).items.some(i=>i.id===free.id),false);
 assert.deepEqual((await list(['deleted'])).items.map(i=>i.id),[free.id]);
 await assert.rejects(()=>f.rpc('erp_document_transition',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:free.id,p_expected_version:free.version+1,p_command_id:randomUUID(),p_status:'cancelled',p_reason:'Teste'}),e=>['40001','22023'].includes(e.code));
 await assert.rejects(()=>f.db.query('update erp_documents.item set quantity=2 where document_id=$1',[free.id]),fails('40001','erp_document_deleted'));
 // Restaurar brings it back as it was; the audit has both steps.
 assert.equal((await trash('restore','sales_orders',[free.id],null)).results[0].ok,true);
 assert.equal((await list(null)).items.some(i=>i.id===free.id),true);
 assert.deepEqual((await f.db.query("select action from erp_documents.audit where document_id=$1 and action in('trash','restore') order by id",[free.id])).rows.map(r=>r.action),['trash','restore']);
 // Without the Exclusão permission of the card, nothing is deleted; consulta writes nothing.
 await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,clock_timestamp(),$3)",[f.users.vendas,['vendas.pedidos_venda','vendas.pedidos_venda.ie'],f.users.admin]);
 await assert.rejects(()=>trash('delete','sales_orders',[free.id],'Teste sintético',randomUUID(),f.users.vendas),fails('42501'));
 await assert.rejects(()=>trash('delete','sales_orders',[free.id],'Teste sintético',randomUUID(),f.users.consulta),fails('42501'));
});

test('393: the contact picker reads the contacts of the type Técnico for the OS',async()=>{
 const tech=await catalog('contacts',{name:'Técnica Sintética',person_type:'F'});
 await f.db.query("insert into erp_catalog.contact_type_link(contact_id,type_id) select $1,id from erp_catalog.contact_type where slug='technician'",[tech.id]);
 const options=await f.rpc('erp_catalog_contact_options',{p_user_id:f.users.vendas,p_query:null,p_role:'technician',p_city:null,p_limit:50});
 assert.deepEqual(options.items.map(i=>i.id),[tech.id]);
 await assert.rejects(()=>f.rpc('erp_catalog_contact_options',{p_user_id:f.users.vendas,p_query:null,p_role:'tecnico',p_city:null,p_limit:50}),fails('22023'));
});
