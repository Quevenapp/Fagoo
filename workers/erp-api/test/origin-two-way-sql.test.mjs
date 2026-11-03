// Two-way synchronization with the Origin (009-011): real SQL, triggers and native commands; all records are synthetic.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { originTwoWayFixture, TWO_WAY_MIGRATIONS } from './helpers/origin-two-way-fixture.mjs';

let f;
before(async()=>{f=await originTwoWayFixture();});
after(async()=>{if(f)await f.close();});
const count=async(sql,args=[])=>f.scalar(`select count(*)::integer v from ${sql}`,args);
const contactPayload=(id,extra={})=>({id:Number(id),nome:'Cliente '+id,codigo:'C'+id,situacao:'A',tipo:'J',numeroDocumento:'11222333000181',
 pais:{nome:'Brasil'},endereco:{geral:{endereco:'Rua A',numero:'10',municipio:'Piracicaba',uf:'SP',cep:'13400000'}},tiposContato:[{id:1,descricao:'Cliente'}],...extra});
const productPayload=(id,extra={})=>({id:Number(id),nome:'Produto '+id,codigo:'P'+id,preco:10,tipo:'P',situacao:'A',formato:'S',unidade:'UN',
 tributacao:{ncm:'84818099',origem:0},midia:{video:{url:'https://example.test/v'}},...extra});
const orderPayload=(id,contact,product,extra={})=>({id:Number(id),numero:5000+Number(id)%1000,data:'2026-10-20',dataSaida:'2026-10-20',dataPrevista:'2026-10-25',
 total:25,totalProdutos:25,situacao:{id:6,valor:0},contato:{id:Number(contact),nome:'Cliente '+contact},loja:{id:77},
 itens:[{codigo:'P'+product,unidade:'UN',quantidade:2,desconto:0,valor:12.5,valorTotal:25,descricao:'Produto '+product,produto:{id:Number(product)}}],
 parcelas:[{dataVencimento:'2026-11-20',valor:25,observacoes:'',formaPagamento:{id:31}}],...extra});
const pulled=async(entity,id)=>f.scalar('select erp_sync.local_id($1,$2) v',[entity,String(id)]);

test('the technical actor is an administrator member and the sync is on by default',async()=>{
 assert.equal(await f.scalar('select actor_id v from erp_sync.settings'),f.actorId);
 assert.equal(await f.scalar("select role v from erp_access.membership where user_id=$1 and active",[f.actorId]),'admin');
 const status=await f.rpc('erp_sync_status',{p_user_id:f.users.consulta});
 assert.equal(status.enabled,true);assert.equal(status.actor_configured,true);
});

test('a contact created in the Brufap goes to the Origin, and its echo comes back without a new send',async()=>{
 const record=await f.catalog('contacts',{name:'Cliente novo do Brufap',person_type:'F',document:'12345678909',city:'Piracicaba',state:'SP'});
 const [item]=(await f.claim()).filter(i=>i.record_id===record.id);
 assert.equal(item.op,'upsert');assert.equal(item.requests[0].method,'POST');assert.equal(item.requests[0].path,'/contatos');
 assert.equal(item.requests[0].body.nome,'Cliente novo do Brufap');assert.equal(item.requests[0].body.tipo,'F');assert.equal(item.requests[0].body.situacao,'A');
 assert.equal(item.requests[0].body.endereco.geral.municipio,'Piracicaba');assert.equal(item.fetch,'/contatos/{id}');
 assert.deepEqual(await f.ack([{id:item.id,token:item.token,ok:true,status:201,origin_id:'990001'}]),{done:1,retry:0,failed:0,pending:0});
 assert.equal(await f.scalar("select origin_id v from erp_sync.link where entity='contacts' and record_id=$1",[record.id]),'990001');
 await f.stageOrigin('contacts','990001',contactPayload('990001',{nome:'Cliente novo do Brufap',tipo:'F',numeroDocumento:'12345678909'}));
 assert.equal((await f.pull()).failed,0);
 assert.equal(await f.scalar("select source_id v from erp_catalog.origin where record_id=$1",[record.id]),'990001');
 assert.equal(await count("erp_sync.outbox where state='pending'"),0);
});

test('a contact created in the Origin arrives, and a later edit in the Brufap keeps the Origin fields it does not model',async()=>{
 await f.stageOrigin('contacts','990002',contactPayload('990002'));
 assert.equal((await f.pull()).applied,1);
 const id=await pulled('contacts','990002');assert.ok(id);
 const before=await f.rpc('erp_catalog_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id}).catch(()=>null);
 const version=await f.scalar('select version v from erp_catalog.record where id=$1',[id]);
 await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:{name:'Cliente renomeado'}});
 const [item]=(await f.claim()).filter(i=>i.record_id===id);
 assert.equal(item.requests[0].method,'PUT');assert.equal(item.requests[0].path,'/contatos/990002');
 assert.equal(item.requests[0].body.nome,'Cliente renomeado');assert.deepEqual(item.requests[0].body.pais,{nome:'Brasil'});
 assert.deepEqual(item.requests[0].body.tiposContato,[{id:1,descricao:'Cliente'}]);assert.equal(item.requests[0].body.id,undefined);
 await f.ack([{id:item.id,token:item.token,ok:true,status:204}]);
 void before;
});

test('the most recent change wins in a conflict',async()=>{
 await f.stageOrigin('contacts','990003',contactPayload('990003'));await f.pull();
 const id=await pulled('contacts','990003');
 const version=await f.scalar('select version v from erp_catalog.record where id=$1',[id]);
 await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:{name:'Editado no Brufap'}});
 // The Origin change was observed before the local edit: the local edit is kept and will be sent.
 await f.stageOrigin('contacts','990003',contactPayload('990003',{nome:'Editado antes no Origin'}));
 await f.db.query("update origin_sync.raw_record set source_updated_at=now()-interval '1 hour' where entity='contacts' and source_id='990003'");
 assert.equal((await f.pull()).results.local_newer,1);
 assert.equal(await f.scalar('select name v from erp_catalog.record where id=$1',[id]),'Editado no Brufap');
 // A newer Origin change wins: applied and the pending send is discarded.
 await f.stageOrigin('contacts','990003',contactPayload('990003',{nome:'Editado depois no Origin'}));
 await f.db.query("update origin_sync.raw_record set source_updated_at=now()+interval '1 minute' where entity='contacts' and source_id='990003'");
 assert.equal((await f.pull()).results.updated,1);
 assert.equal(await f.scalar('select name v from erp_catalog.record where id=$1',[id]),'Editado depois no Origin');
 assert.equal(await count("erp_sync.outbox where record_id=$1 and state='pending'",[id]),0);
 assert.equal(await count("erp_sync.outbox where record_id=$1 and state='superseded'",[id]),1);
});

test('a sales order from the Origin becomes a native editable order, and its edit goes back with the status',async()=>{
 await f.stageOrigin('contacts','990010',contactPayload('990010'));await f.stageOrigin('products','990011',productPayload('990011'));
 await f.stageOrigin('sales_orders','990012',orderPayload('990012','990010','990011',{situacao:{id:9,valor:1}}));
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const id=await pulled('sales_orders','990012');
 const doc=(await f.db.query('select * from erp_documents.document where id=$1',[id])).rows[0];
 assert.equal(doc.origin,'origin');assert.equal(doc.authority,'brufap');assert.equal(doc.status,'fulfilled');assert.equal(Number(doc.total),25);
 assert.equal(await count('erp_documents.item where document_id=$1',[id]),1);
 const got=(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:id})).document;
 assert.equal(got.readonly,false);
 await f.transition({id,kind:'sales_orders',version:doc.version},'open');
 const [item]=(await f.claim()).filter(i=>i.record_id===id);
 assert.equal(item.requests[0].method,'PUT');assert.equal(item.requests[0].path,'/pedidos/vendas/990012');
 assert.equal(item.requests[0].body.contato.id,990010);assert.equal(item.requests[0].body.itens[0].produto.id,990011);
 assert.deepEqual(item.requests[0].body.loja,{id:77});
 assert.equal(item.requests[1].method,'PATCH');assert.equal(item.requests[1].path,'/pedidos/vendas/990012/situacoes/6');
 await f.ack([{id:item.id,token:item.token,ok:true,status:200}]);
});

test('a document created in the Brufap waits for its contact and product to reach the Origin first',async()=>{
 const contact=await f.catalog('contacts',{name:'Cliente só do Brufap'});
 const product=await f.catalog('products',{name:'Produto só do Brufap',unit:'UN',kind:'P',format:'S',price:'5'});
 const doc=await f.document('sales_orders',{contact:contact.id,items:[{product_id:product.id,description:'Produto só do Brufap',quantity:'1',unit_price:'5'}]});
 const first=await f.claim();
 assert.ok(first.some(i=>i.record_id===contact.id&&i.requests[0].method==='POST'));
 assert.ok(first.some(i=>i.record_id===product.id&&i.requests[0].method==='POST'));
 assert.ok(!first.some(i=>i.record_id===doc.id));
 await f.ack(first.map(i=>({id:i.id,token:i.token,ok:true,status:201,origin_id:i.record_id===contact.id?'990031':i.record_id===product.id?'990032':i.origin_id??String(990100+i.id)})));
 await f.db.query("update erp_sync.outbox set next_attempt_at='-infinity' where record_id=$1",[doc.id]);
 const [item]=(await f.claim()).filter(i=>i.record_id===doc.id);
 assert.equal(item.requests[0].method,'POST');assert.equal(item.requests[0].path,'/pedidos/vendas');
 assert.equal(item.requests[0].body.contato.id,990031);assert.equal(item.requests[0].body.itens[0].produto.id,990032);
 assert.equal(item.requests[0].body.numero,Number(doc.number));
 await f.ack([{id:item.id,token:item.token,ok:true,status:201,origin_id:'990033'}]);
 // Deleting it in the Brufap deletes it in the Origin.
 await f.rpc('erp_document_trash',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'sales_orders',p_action:'delete',p_ids:[doc.id],p_reason:'Teste de exclusão'});
 const [del]=(await f.claim()).filter(i=>i.record_id===doc.id);
 assert.equal(del.op,'delete');assert.deepEqual(del.requests,[{method:'DELETE',path:'/pedidos/vendas/990033'}]);
 await f.ack([{id:del.id,token:del.token,ok:true,status:204}]);
});

test('an order deleted in the Origin is moved to the Brufap trash',async()=>{
 await f.stageOrigin('sales_orders','990040',orderPayload('990040','990010','990011'));
 await f.pull();const id=await pulled('sales_orders','990040');
 assert.deepEqual(await f.rpc('erp_sync_remote_deleted',{p_entity:'sales_orders',p_origin:'990040'}),{state:'ready',result:'staged'});
 await f.pull();
 assert.ok(await f.scalar('select deleted_at v from erp_documents.document where id=$1',[id]));
 assert.equal(await count("erp_sync.outbox where record_id=$1 and state='pending'",[id]),0);
});

test('receivables: payments in the Origin settle the Brufap title, and a Brufap settlement goes to the Origin',async()=>{
 const account=(await f.rpc('erp_finance_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'account_save',p_data:{expected_version:0,name:'Caixa sintético',kind:'cash'}})).record;
 await f.db.query('update erp_sync.settings set default_account_id=$1',[account.id]);
 await f.stageOrigin('receivables','990050',{id:990050,situacao:3,vencimento:'2026-11-10',valor:100,saldo:40,dataEmissao:'2026-10-10',contato:{id:990010},historico:'Venda 1'});
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const id=await pulled('receivables','990050');
 const title=(await f.db.query('select * from erp_finance.title where id=$1',[id])).rows[0];
 assert.equal(Number(title.amount_cents),10000);assert.equal(Number(title.settled_cents),6000);
 assert.equal(await count("erp_sync.outbox where entity='receivables' and state='pending'"),0);
 // Settled in the Brufap: sent as a baixa of the remaining 40.
 const version=await f.scalar('select version v from erp_finance.title where id=$1',[id]);
 await f.rpc('erp_finance_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'settle',p_data:{id,expected_version:version,account_id:account.id,posted_on:'2026-10-22',principal_cents:'4000'}});
 await f.stageOrigin('ledger_accounts','1',{id:1,descricao:'Caixa sintético'}).catch(()=>null);
 await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('ledger_accounts','x','61','{\"id\":61,\"descricao\":\"Caixa sintético\"}','"+'c'.repeat(64)+"'),('financial_categories','x','62','{\"id\":62,\"descricao\":\"Vendas\"}','"+'d'.repeat(64)+"')on conflict do nothing").catch(async()=>{await f.db.query("insert into origin_sync.resource_state(resource)values('x')on conflict do nothing");await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('ledger_accounts','x','61','{\"id\":61,\"descricao\":\"Caixa sintético\"}','"+'c'.repeat(64)+"'),('financial_categories','x','62','{\"id\":62,\"descricao\":\"Vendas\"}','"+'d'.repeat(64)+"')on conflict do nothing");});
 const [item]=(await f.claim()).filter(i=>i.op==='settle');
 assert.equal(item.requests[0].path,'/contas/receber/990050/baixar');
 assert.equal(item.requests[0].body.valorRecebido,40);assert.deepEqual(item.requests[0].body.portador,{id:61});
 await f.ack([{id:item.id,token:item.token,ok:true,status:200}]);
});

test('stock: a Brufap movement goes to the Origin, and a Origin balance change becomes a native adjustment',async()=>{
 const warehouse=await f.warehouse('5001','Depósito geral');
 await f.stageOrigin('products','990060',productPayload('990060'));await f.pull();
 const product=await pulled('products','990060');
 await f.rpc('erp_stock_post',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-22',p_reason:'Entrada de teste',p_items:[{product_id:product,warehouse_id:warehouse.id,quantity:'5',expected_version:0}],p_reference:null});
 const [item]=(await f.claim()).filter(i=>i.entity==='stock');
 assert.equal(item.requests[0].path,'/estoques');
 assert.deepEqual({...item.requests[0].body,observacoes:undefined},{produto:{id:990060},deposito:{id:5001},operacao:'E',quantidade:5,observacoes:undefined});
 assert.equal(item.fetch_stock,'990060');
 await f.ack([{id:item.id,token:item.token,ok:true,status:201}]);
 // The Origin sold 2 more (balance 5+... = 3 after the push): the Brufap receives an adjustment of -2 and does not send it back.
 await f.stageOrigin('stock_balances','990060',{produto:{id:990060},depositos:[{id:5001,saldoFisico:3,saldoVirtual:3}]});
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 assert.equal(Number(await f.scalar('select quantity v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[product,warehouse.id])),3);
 assert.equal(await count("erp_sync.outbox where entity='stock' and state='pending'"),0);
});

test('the Sincronizar button opens one run at a time and the read-only profile cannot request it',async()=>{
 const status=await f.rpc('erp_sync_request',{p_user_id:f.users.vendas});
 assert.ok(status.requested_run);assert.equal(status.run.state,'queued');
 assert.equal((await f.rpc('erp_sync_request',{p_user_id:f.users.admin})).requested_run,status.requested_run);
 await assert.rejects(()=>f.rpc('erp_sync_request',{p_user_id:f.users.consulta}),e=>e.code==='42501');
 const run=await f.rpc('erp_sync_run_get',{});assert.equal(run.id,status.requested_run);
 await f.rpc('erp_sync_run_update',{p_run:run.id,p_state:'done',p_phase:'done',p_cursor:null,p_stats:{pushed:1},p_error:null});
 assert.equal(await f.rpc('erp_sync_run_get',{}),null);
});

test('reports and lists still compile after the authority rewrite',async()=>{
 for(const kind of['sales_orders','sales_proposals','purchase_orders','service_orders'])
  assert.ok(Array.isArray((await f.rpc('erp_document_list',{p_user_id:f.users.admin,p_kind:kind,p_origin:'all'})).items));
 await f.rpc('erp_home_summary',{p_user_id:f.users.admin});
 await f.rpc('erp_document_export',{p_user_id:f.users.admin,p_kind:'sales_orders',p_date_from:'2026-01-01',p_date_to:'2026-12-31',p_page:1});
 const contact=await f.scalar("select contact_id v from erp_documents.document where kind='sales_orders' and contact_id is not null limit 1");
 const history=await f.rpc('erp_document_history',{p_user_id:f.users.admin,p_kind:'sales_orders',p_contact_id:contact,p_product_id:null,p_query:null,p_limit:10});
 assert.ok(history.items.some(i=>i.origin==='brufap'));
});

test('a read-only mirror projected before the two-way migration is converted in place to the native model',async()=>{
 const g=await originTwoWayFixture({migrate:false});try{
  for(const[entity,id,payload]of[['contacts','1',contactPayload('1')],['products','2',productPayload('2')]]){await g.stage(entity,id,payload);}
  for(const entity of['contacts','products']){
   const id=entity==='contacts'?'1':'2';
   const record=entity==='contacts'?await g.catalog('contacts',{name:'Cliente 1'}):await g.catalog('products',{name:'Produto 2',unit:'UN',kind:'P',format:'S',price:'10'});
   await g.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity=$1 and source_id=$2",[entity,id]);
   await g.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$3,version_hash,version_hash,'synced' from origin_sync.raw_record where entity=$1 and source_id=$2",[entity,id,record.id]);
  }
  await g.db.query('update erp_catalog.record set human_edited=false');
  await g.stage('sales_proposals','3',{id:3,numero:77,data:'2026-10-21',total:10,situacao:'Aprovado',contato:{id:1},itens:[{produto:{id:2},quantidade:1,valor:10,valorTotal:10}]});
  assert.equal((await g.documentProject()).applied,1);
  const mirror=await g.scalar("select document_id v from erp_documents.origin_mirror where source_id='3'");
  assert.equal(await g.scalar('select authority v from erp_documents.document where id=$1',[mirror]),'origin');
  for(const name of TWO_WAY_MIGRATIONS)await g.migrate(name);
  const result=await g.pull();assert.equal(result.failed,0,JSON.stringify(result));
  const doc=(await g.db.query('select * from erp_documents.document where id=$1',[mirror])).rows[0];
  assert.equal(doc.authority,'brufap');assert.equal(doc.origin,'origin');assert.equal(doc.status,'approved');assert.equal(Number(doc.number),77);
  assert.equal(await g.scalar('select count(*)::integer v from erp_sync.outbox'),0);
  // Once converted, the document is edited like a native one and the edit is queued for the Origin.
  await g.transition({id:mirror,kind:'sales_proposals',version:doc.version},'open');
  assert.equal(await g.scalar("select count(*)::integer v from erp_sync.outbox where record_id=$1 and state='pending'",[mirror]),1);
 }finally{await g.close();}
});

test('deleting a contact in the Brufap deletes it in the Origin, and a contact deleted in the Origin arrives as deleted',async()=>{
 await f.stageOrigin('contacts','990070',contactPayload('990070'));await f.pull();
 const id=await pulled('contacts','990070');
 const version=await f.scalar('select version v from erp_catalog.record where id=$1',[id]);
 await f.rpc('erp_catalog_contact_set_situation',{p_user_id:f.users.admin,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_situation:'E'});
 const [item]=(await f.claim()).filter(i=>i.record_id===id);
 assert.deepEqual(item.requests,[{method:'PATCH',path:'/contatos/990070/situacoes',body:{situacao:'E'}}]);
 await f.ack([{id:item.id,token:item.token,ok:true,status:204}]);
 await f.stageOrigin('contacts','990071',contactPayload('990071'));await f.pull();
 const other=await pulled('contacts','990071');
 await f.stageOrigin('contacts','990071',contactPayload('990071',{situacao:'E'}));await f.pull();
 assert.equal(await f.scalar('select situation v from erp_catalog.contact_profile where record_id=$1',[other]),'E');
 assert.equal(await f.scalar('select active v from erp_catalog.record where id=$1',[other]),false);
});

test('reversing (deleting) a stock movement in the Brufap sends the opposite movement to the Origin',async()=>{
 const warehouse=await f.warehouse('5002','Depósito 2');
 await f.stageOrigin('products','990080',productPayload('990080'));await f.pull();
 const product=await pulled('products','990080');
 await f.rpc('erp_stock_post',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-22',p_reason:'Entrada a estornar',p_items:[{product_id:product,warehouse_id:warehouse.id,quantity:'4',expected_version:0}],p_reference:null});
 await f.pushAll();
 const movement=await f.scalar("select id v from erp_stock.movement where reason='Entrada a estornar'");
 const version=await f.scalar('select version v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[product,warehouse.id]);
 await f.rpc('erp_stock_reverse',{p_user_id:f.users.admin,p_movement_id:movement,p_command_id:randomUUID(),p_occurred_on:'2026-10-22',p_reason:'Lançamento apagado',
  p_versions:[{product_id:product,warehouse_id:warehouse.id,expected_version:version}]});
 const items=(await f.claim()).filter(i=>i.entity==='stock');
 assert.ok(items.some(i=>i.requests[0].body.operacao==='S'&&i.requests[0].body.quantidade===4&&i.requests[0].body.deposito.id===5002),JSON.stringify(items.map(i=>i.requests)));
 await f.ack(items.map(i=>({id:i.id,token:i.token,ok:true,status:201})));
});

test('012: a sales order pulled as the service_role commits; the deferred commission and cost triggers run as their owner',async()=>{
 await f.stageOrigin('contacts','990090',contactPayload('990090'));await f.stageOrigin('products','990091',productPayload('990091'));
 await f.stageOrigin('sales_orders','990092',orderPayload('990092','990090','990091'));
 await f.db.exec('begin; set local role service_role; select public.erp_sync_pull(100,null); commit;');
 assert.ok(await pulled('sales_orders','990092'));
 assert.equal(await count("pg_proc where oid in('erp_finance.commission_operation_capture'::regproc,'erp_documents.cost_apply_capture'::regproc,'erp_fiscal_invoices.check_sales_item_links'::regproc) and prosecdef"),3);
});

test('012: control characters in Origin texts are cleaned, and an oversized short description stays in the Origin',async()=>{
 await f.stageOrigin('contacts','990095',contactPayload('990095',{email:'nfe@cliente.test\u0002',emailNotaFiscal:'\u001fnfe@cliente.test',
  endereco:{geral:{endereco:'R GERALDO, 285 GALPAO 1\r\n',numero:'10',municipio:'Piracicaba',uf:'SP',cep:'13400000'}}}));
 const html='<p>'+'Descrição longa colada do site\u0007\n'.repeat(400)+'</p>';
 await f.stageOrigin('products','990096',productPayload('990096',{descricaoCurta:html}));
 await f.stageOrigin('products','990097',productPayload('990097',{descricaoCurta:'Linha 1\nLinha 2\u0001'}));
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const contact=await pulled('contacts','990095');
 assert.deepEqual((await f.db.query('select email,street from erp_catalog.contact where record_id=$1',[contact])).rows[0],{email:'nfe@cliente.test',street:'R GERALDO, 285 GALPAO 1'});
 assert.equal(await f.scalar('select description v from erp_catalog.product where record_id=$1',[await pulled('products','990096')]),null);
 assert.equal(await f.scalar('select description v from erp_catalog.product where record_id=$1',[await pulled('products','990097')]),'Linha 1\nLinha 2');
 // The next send keeps the Origin description: null fields are not sent.
 const id=await pulled('products','990096'),version=await f.scalar('select version v from erp_catalog.record where id=$1',[id]);
 await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:{name:'Produto renomeado'}});
 const item=(await f.claim()).find(i=>i.entity==='products'&&i.record_id===id);
 assert.equal(item.requests[0].body.descricaoCurta.length,html.length);
 await f.ack([{id:item.id,token:item.token,ok:true,status:200}]);
});

test('013: an order whose Origin total ignores the item percentages enters with only the order discount, at the Origin total',async()=>{
 await f.stageOrigin('contacts','990100',contactPayload('990100'));await f.stageOrigin('products','990101',productPayload('990101'));
 const base=orderPayload('990102','990100','990101');
 await f.stageOrigin('sales_orders','990102',{...base,totalProdutos:106.1,total:6.7,desconto:{unidade:'REAL',valor:99.4},
  itens:[{...base.itens[0],quantidade:2,valor:53.05,desconto:34.7,valorTotal:106.1}],parcelas:[{...base.parcelas[0],valor:6.7}]});
 // 017: the item valor of the Origin is already net; its desconto is informational, so no item keeps a discount.
 await f.stageOrigin('sales_orders','990103',{...orderPayload('990103','990100','990101'),totalProdutos:22.5,total:22.5,
  itens:[{...base.itens[0],desconto:10,valorTotal:22.5}],parcelas:[{...base.parcelas[0],valor:22.5}]});
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const items=async id=>(await f.db.query('select discount_percent from erp_documents.item where document_id=$1 order by position',[await pulled('sales_orders',id)])).rows;
 assert.deepEqual((await items('990102')).map(i=>Number(i.discount_percent)),[0]);
 assert.deepEqual((await items('990103')).map(i=>Number(i.discount_percent)),[0]);
});

test('014: a Origin account with an empty bank number enters with no bank number',async()=>{
 await f.stageOrigin('contacts','990110',contactPayload('990110'));
 await f.stageOrigin('receivables','990111',{id:990111,situacao:1,vencimento:'2026-11-10',valor:50,saldo:50,dataEmissao:'2026-10-10',contato:{id:990110},historico:'Venda 2',numeroBanco:''});
 await f.stageOrigin('payables','990112',{id:990112,situacao:1,vencimento:'2026-11-10',valor:30,saldo:30,dataEmissao:'2026-10-10',contato:{id:990110},historico:'Compra 2',numeroBanco:' 123 '});
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 assert.equal(await f.scalar('select bank_number v from erp_finance.title where id=$1',[await pulled('receivables','990111')]),null);
 assert.equal(await f.scalar('select bank_number v from erp_finance.title where id=$1',[await pulled('payables','990112')]),'123');
});

test('015: a converted item keeps the product snapshot even when the mirrored item had a JSON null one',async()=>{
 await f.stageOrigin('contacts','990120',contactPayload('990120'));await f.stageOrigin('products','990121',productPayload('990121'));
 await f.stageOrigin('sales_orders','990122',orderPayload('990122','990120','990121'));
 let result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const id=await pulled('sales_orders','990122'),product=await pulled('products','990121');
 // As left by the mirror (006): same item, same product, snapshot stored as JSON null.
 await f.db.exec("select erp_sync.set_applying(true)");
 await f.db.query("update erp_documents.item set product_snapshot='null'::jsonb where document_id=$1",[id]);
 await f.db.exec("select erp_sync.set_applying(false)");
 await f.stageOrigin('sales_orders','990122',orderPayload('990122','990120','990121',{observacoes:'Alterado no Origin'}));
 result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const snap=await f.scalar('select product_snapshot v from erp_documents.item where document_id=$1 and position=1',[id]);
 assert.equal(snap.id,product);assert.ok(Number.isInteger(snap.version)&&snap.version>=1);
});

test('016: an order with a Origin invoice or Origin contas is locked like the native effects; notes, status and the applier still pass',async()=>{
 await f.stageOrigin('contacts','990130',contactPayload('990130'));await f.stageOrigin('products','990131',productPayload('990131'));
 await f.stageOrigin('sales_orders','990132',orderPayload('990132','990130','990131',{notaFiscal:{id:880132}}));
 await f.stageOrigin('sales_orders','990133',orderPayload('990133','990130','990131'));
 await f.stageOrigin('receivables','990134',{id:990134,situacao:1,vencimento:'2026-11-20',valor:25,saldo:25,dataEmissao:'2026-10-20',contato:{id:990130},historico:'Pedido 990133',origem:{id:990133,tipoOrigem:'venda'}});
 await f.stageOrigin('sales_orders','990135',orderPayload('990135','990130','990131'));
 let result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const flags=async id=>(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:await pulled('sales_orders',id)})).document.effect_flags;
 assert.deepEqual(await flags('990132'),{finance_active:false,stock_active:false,origin_finance:false,origin_invoice:true});
 assert.deepEqual(await flags('990133'),{finance_active:false,stock_active:false,origin_finance:true,origin_invoice:false});
 assert.deepEqual(await flags('990135'),{finance_active:false,stock_active:false,origin_finance:false,origin_invoice:false});
 const edit=async(id,body)=>{const doc=(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:id})).document;
  return f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:id,p_expected_version:doc.version,p_command_id:randomUUID(),
   p_body:{date:doc.date,contact_id:doc.contact_id,items:doc.items.map(i=>({product_id:i.product_id,description:i.description,unit:i.unit,quantity:'5',unit_price:i.unit_price})),...body}});};
 for(const origin of ['990132','990133'])await assert.rejects(edit(await pulled('sales_orders',origin),{}),/erp_document_origin_effects/);
 await edit(await pulled('sales_orders','990135'),{});
 const locked=await pulled('sales_orders','990132');
 const version=await f.scalar('select version v from erp_documents.document where id=$1',[locked]);
 await f.rpc('erp_document_notes_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:locked,p_expected_version:version,p_command_id:randomUUID(),p_notes:'Obs nova',p_internal_notes:'Interna'});
 assert.equal(await f.scalar("select body->>'notes' v from erp_documents.document where id=$1",[locked]),'Obs nova');
 await f.transition({id:locked,kind:'sales_orders',version:version+1},'fulfilled');
 await assert.rejects(f.db.query('delete from erp_documents.item where document_id=$1',[locked]),/erp_document_origin_effects/);
 // The Origin itself still changes the order.
 await f.stageOrigin('sales_orders','990132',orderPayload('990132','990130','990131',{notaFiscal:{id:880132},observacoes:'Alterado no Origin'}));
 result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
});

test('017: the Origin item valor is the net price; a Brufap item discount goes to the Origin as a net valor',async()=>{
 await f.stageOrigin('contacts','990140',contactPayload('990140'));await f.stageOrigin('products','990141',productPayload('990141'));
 const base=orderPayload('990142','990140','990141');
 await f.stageOrigin('sales_orders','990142',{...base,totalProdutos:120,total:120,itens:[{...base.itens[0],quantidade:1,valor:120,desconto:24.95}],parcelas:[{...base.parcelas[0],valor:120}]});
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const id=await pulled('sales_orders','990142');
 assert.equal(Number(await f.scalar('select total v from erp_documents.document where id=$1',[id])),120);
 const doc=(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:id})).document;
 await f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:id,p_expected_version:doc.version,p_command_id:randomUUID(),
  p_body:{date:doc.date,contact_id:doc.contact_id,items:doc.items.map(i=>({product_id:i.product_id,description:i.description,unit:i.unit,quantity:'2',unit_price:'100',discount_percent:'10'}))}});
 const [item]=(await f.claim()).filter(i=>i.record_id===id);
 assert.equal(item.requests[0].body.itens[0].valor,90);assert.equal(item.requests[0].body.itens[0].desconto,10);
 await f.ack([{id:item.id,token:item.token,ok:true,status:200}]);
});

test('018: the list row of a converted document carries the N and C of the Origin',async()=>{
 await f.stageOrigin('contacts','990150',contactPayload('990150'));await f.stageOrigin('products','990151',productPayload('990151'));
 await f.stageOrigin('sales_orders','990152',orderPayload('990152','990150','990151',{notaFiscal:{id:880152}}));
 const result=await f.pull();assert.equal(result.failed,0,JSON.stringify(result));
 const row=await f.scalar('select erp_documents.list_row($1,true,true) v',[await pulled('sales_orders','990152')]);
 assert.equal(row.origin_invoice,true);assert.equal(row.origin_finance,false);
});
