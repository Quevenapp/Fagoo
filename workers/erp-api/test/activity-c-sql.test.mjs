import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneCFixture,fails}from'./helpers/preferences-c-fixture.mjs';
import{captureActivityQuery,parseActivity,captureActivityDetailQuery,parseActivityDetail}from'../../../packages/erp-domain/src/activity.mjs';

// 186 (not applied yet): every audit of waves A and B reaches the Registro de atividades with the Origin operation and module.
// Runs on every migration applied in production plus wave C. Synthetic data only.
const today=f=>f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
async function log(f,filters={}){
 const day=await today(f),q=captureActivityQuery({from:day,to:day,...filters});
 return parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:q.operation,p_actor:q.actor,p_query:q.q,p_limit:q.limit,p_offset:q.offset}),q).items;
}
const detail=async(f,e)=>{const q=captureActivityDetailQuery({source:e.source,id:e.id});return parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:q.source,p_entry_id:q.id}),q);};
const hash='a'.repeat(64);

test('186 product logical delete is Exclusão; categories and price lists are Produto; contacts, sellers and employees are Contato, payment methods Contas a Pagar/Receber',async()=>{const f=await laneCFixture();try{
 const product=await f.catalog('products',{name:'Produto do registro',unit:'UN',kind:'P',format:'S',price:'10'});
 await f.rpc('erp_catalog_product_set_deleted',{p_user_id:f.users.admin,p_id:product.id,p_expected_version:product.version,p_command_id:randomUUID(),p_deleted:true});
 const products=await log(f,{module:'produtos'});
 assert.ok(products.some(e=>e.source==='catalog'&&e.operation==='exclusao'&&e.description==='Produto do registro'),JSON.stringify(products));
 assert.ok(products.some(e=>e.source==='catalog'&&e.operation==='criacao'));
 // Consulta de exclusões realizadas: the operation "exclusão" of the period.
 assert.ok((await log(f,{operation:'exclusao'})).some(e=>e.module==='produtos'&&e.description==='Produto do registro'));
 const category=await f.rpc('erp_catalog_taxonomy_save',{p_user_id:f.users.admin,p_kind:'categories',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Ferramentas'}});
 const categoryId=category.item?.id??category.record?.id??category.id;assert.ok(categoryId,JSON.stringify(category));
 await f.rpc('erp_catalog_taxonomy_delete',{p_user_id:f.users.admin,p_kind:'categories',p_id:categoryId,p_expected_version:1,p_command_id:randomUUID()});
 await f.db.query("insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values($1,$2,$3,'clone','{}','{\"name\":\"Atacado\"}')",[f.users.admin,randomUUID(),randomUUID()]);
 const catalogRows=(await log(f,{module:'produtos'})).filter(e=>['taxonomy','pricing'].includes(e.source)).map(e=>[e.source,e.operation,e.description]).sort();
 assert.deepEqual(catalogRows,[['pricing','criacao','Lista de preços Atacado'],['taxonomy','criacao','Categoria de produtos Ferramentas'],['taxonomy','exclusao','Categoria de produtos Ferramentas']]);
 const type=await f.rpc('erp_catalog_contact_type_create',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:'Parceiro'});
 await f.rpc('erp_catalog_contact_type_delete',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_id:type.item.id});
 const aux=(subject,action,after,before=null)=>f.db.query('insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data) values($1,$2,$3,$4,$5,$6,$7)',[f.users.admin,randomUUID(),subject,randomUUID(),action,before,after]);
 await aux('payment_method','archive',{description:'Boleto 30 dias'},{description:'Boleto 30 dias'});await aux('seller','create',{});await aux('employee','transition',{situation:'I'},{situation:'A'});
 await f.db.query("insert into erp_catalog.auxiliary_audit(actor,subject,action,after_data) values($1,'contacts_export','xlsx','{\"total\":3}')",[f.users.admin]);
 await f.db.query("insert into erp_catalog.auxiliary_audit(actor,subject,action,after_data) values($1,'contact_comment','create','{\"contact_id\":\"não é um uuid\"}')",[f.users.admin]);
 const contacts=(await log(f,{module:'clientes_fornecedores'})).filter(e=>e.source==='auxiliary').map(e=>[e.operation,e.description]).sort();
 assert.deepEqual(contacts,[['atualizacao_situacao','Funcionário'],['criacao','Comentário no contato'],['criacao','Tipo de contato Parceiro'],['criacao','Vendedor'],['envio','Exportação de contatos (3)'],['exclusao','Tipo de contato Parceiro']]);
 assert.deepEqual((await log(f,{module:'financas'})).filter(e=>e.source==='auxiliary').map(e=>[e.operation,e.description]),[['exclusao','Forma de pagamento Boleto 30 dias']]);
 for(const e of(await log(f)).filter(x=>['taxonomy','pricing','auxiliary'].includes(x.source)))assert.equal((await detail(f,e)).available,true,e.source);
}finally{await f.close();}});

test('186 finance splits into Contas a Pagar/Receber, Pagamento/Recebimento and Caixa; notas, certificado, estoque, numbering and metas',async()=>{const f=await laneCFixture();try{
 const fin=action=>f.db.query("insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values($1,$2,$3,null,'{}')",[f.users.admin,randomUUID(),action]);
 for(const a of['settle','reverse','bordero_delete','entry_delete','entry_restore','transfer_create','balance_adjust','statement_import','line_unreconcile','title_delete','account_set_active','recurrence_generate'])await fin(a);
 const rows=(await log(f)).filter(e=>e.source==='finance').map(e=>`${e.module}:${e.operation}:${e.description}`).sort();
 assert.deepEqual(rows,['caixa:atualizacao:Lançamento de caixa restaurado','caixa:criacao:Extrato bancário importado','caixa:estorno:Conciliação bancária','caixa:exclusao:Lançamento de caixa excluído',
  'caixa:lancamento:Ajuste de saldo','caixa:transferencia:Transferência entre contas','financas:atualizacao_situacao:Situação da conta financeira','financas:criacao:Conta recorrente','financas:exclusao:Conta excluída',
  'pagamento_recebimento:estorno:Estorno de baixa','pagamento_recebimento:exclusao:Borderô','pagamento_recebimento:lancamento:Baixa de conta']);
 const invoice=randomUUID();
 await f.db.query(`insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
  values($1,'55','1','N','2',1,1,321,'Venda sintética','2026-10-19','1','1','1',false,'{}','[]','{}','{}','[]','{}',false,0,0,0,0,'{}',$2,$2)`,[invoice,f.users.admin]);
 const fiscal=async(scope,entity,action)=>{const c=randomUUID();await f.db.query('insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values($1,$2,$3,$4,$5)',[c,f.users.admin,scope,hash,'{}']);
  await f.db.query('insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action) values($1,$2,$3,$4,1,$5)',[f.users.admin,c,scope,entity,action]);};
 await fiscal('invoice',invoice,'import');await fiscal('event',randomUUID(),'cancel');
 assert.deepEqual((await log(f,{module:'notas_fiscais'})).map(e=>[e.operation,e.code,e.description]).sort(),[['atualizacao_situacao',null,'Cancelamento de nota fiscal'],['criacao','321','NF-e nº 321 série 1 · importada do XML']]);
 const a1=randomUUID();
 await f.db.query("insert into erp_a1.command(command_id,actor,action,request_hash,expected_version,reason,context,state,result,finished_at) values($1,$2,'configure',$3,0,'Instalação sintética','{}','committed','{}',clock_timestamp())",[a1,f.users.admin,hash]);
 await f.db.query("insert into erp_a1.audit(command_id,actor,action,reason,before_data,after_data) values($1,$2,'configure','Instalação sintética','{}','{}')",[a1,f.users.admin]);
 assert.deepEqual((await log(f,{module:'certificado_digital'})).map(e=>[e.operation,e.description]),[['criacao','Certificado A1 configurado']]);
 await f.db.query("insert into erp_documents.numbering_audit(kind,actor,command_id,before_last,after_last) values('sales_orders',$1,$2,10,99)",[f.users.admin,randomUUID()]);
 const numbering=(await log(f,{module:'pedidos_venda'})).find(e=>e.source==='numbering');assert.deepEqual([numbering.operation,numbering.code,numbering.description],['atualizacao','100','Próximo número: Pedido de venda nº 100']);
 const warehouse=await f.catalog('warehouses',{name:'Depósito do registro'});
 await f.db.query("insert into erp_stock.warehouse_command(id,actor,action,warehouse_id,request_hash,result) values($1,$2,'default',$3,$4,'{}')",[randomUUID(),f.users.admin,warehouse.id,hash]);
 const session=randomUUID();await f.db.query('insert into erp_stock.count_session(id,actor,warehouse_id) values($1,$2,$3)',[session,f.users.estoque,warehouse.id]);
 for(const action of['read','restart'])await f.db.query('insert into erp_stock.count_command(id,actor,action,session_id,request_hash,result) values($1,$2,$3,$4,$5,$6)',[randomUUID(),f.users.estoque,action,session,hash,'{}']);
 for(const action of['save','finish'])await f.db.query('insert into erp_stock.checkin_command(id,actor,action,invoice_id,request_hash,result,created_at) values($1,$2,$3,$4,$5,$6,clock_timestamp())',[randomUUID(),f.users.estoque,action,invoice,hash,'{}']);
 assert.deepEqual((await log(f,{module:'estoque'})).filter(e=>['stock_count','checkin'].includes(e.source)).map(e=>[e.source,e.operation,e.description]).sort(),
  [['checkin','atualizacao_situacao','Check-in de recebimento da nota nº 321 · finalizado'],['checkin','criacao','Check-in de recebimento da nota nº 321'],['stock_count','atualizacao','Conferência de estoque reiniciada · Depósito do registro']]);
 assert.deepEqual((await log(f,{module:'depositos'})).filter(e=>e.source==='warehouse_settings').map(e=>e.description),['Depósito padrão · Depósito do registro']);
 await f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_goal_id:null,p_expected_version:0,p_data:{name:'Vendas de outubro',start_on:'2026-10-01',end_on:'2036-09-30',segment:'geral',seller:null,target:'1000',active:true}});
 assert.deepEqual((await log(f,{module:'meu_negocio'})).map(e=>[e.source,e.operation,e.description]),[['goals','criacao','Meta Vendas de outubro']]);
 {const d=await detail(f,numbering);assert.deepEqual([d.available,d.before,d.after],[true,{proximo_numero:11},{proximo_numero:100}]);}
 assert.equal((await detail(f,(await log(f,{module:'meu_negocio'}))[0])).available,true);
 for(const e of(await log(f)).filter(x=>['fiscal_invoices','a1','stock_count','warehouse_settings','checkin'].includes(x.source)))assert.equal((await detail(f,e)).available,false,e.source);
 // Unknown modules and other roles are refused; only service_role executes.
 await fails(assert,()=>f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:'2026-10-01',p_to:'2026-10-02',p_module:'comissao',p_operation:null,p_actor:null,p_query:null,p_limit:10,p_offset:0}),'22023');
 await fails(assert,()=>f.rpc('erp_activity_list',{p_user_id:f.users.financeiro,p_from:'2026-10-01',p_to:'2026-10-02',p_module:'caixa',p_operation:null,p_actor:null,p_query:null,p_limit:10,p_offset:0}),'42501');
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer)','execute') v`),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_activity.finance_module(text)','execute') v"),false);
}finally{await f.close();}});

test('186 stops when a function it replaces is not the expected version',async()=>{const f=await laneCFixture({before:'202610200186'});try{
 await f.db.exec("create or replace function erp_activity.operation(p_action text) returns text language sql immutable set search_path=pg_catalog as $body$ select 'atualizacao' $body$;");
 await assert.rejects(()=>f.migrate('202610200186_activity_registry_waves.sql'),e=>e.code==='55000'&&/activity_186_previous_definition_changed/.test(e.message));
}finally{await f.close();}});
