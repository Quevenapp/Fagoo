import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneDFixture}from'./helpers/preferences-d-fixture.mjs';
import{parseImportBatchResult,parseJobs,parseJob,captureJobsQuery,captureJobQuery}from'../../../packages/erp-domain/src/spreadsheet-import.mjs';

// 228 Importações de Dados por planilha (PRF-023, PRF-024, PRF-025, PRF-280, PRD-122). Synthetic data only.
const code=c=>e=>e.code===c;
function importer(f){
 const batch=(kind,items,{dry=false,command=dry?null:randomUUID(),job=dry?null:randomUUID(),file='planilha.csv',total=items.length,user=f.users.admin}={})=>
  f.rpc('erp_preferences_import_batch',{p_user_id:user,p_command_id:command,p_job_id:job,p_kind:kind,p_file_name:file,p_total_rows:total,p_dry_run:dry,p_rows:items}).then(value=>{
   parseImportBatchResult(value,{kind,dry_run:dry,job_id:job,file_name:file,total_rows:total,items});return value;});
 const one=(row,data,lines=[row])=>({row,lines,data});
 return{batch,one};
}

test('228 RPCs are service-only, the tables are private, and only an active administrador imports',async()=>{const f=await laneDFixture();try{
 for(const sig of['erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb)','erp_preferences_import_jobs(uuid,text,integer,integer)','erp_preferences_import_job(uuid,uuid,boolean,integer,integer)']){
  assert.equal(await f.scalar(`select has_function_privilege('service_role','public.${sig}','execute') v`),true,sig);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.${sig}','execute') v`),false,`${role} ${sig}`);
 }
 for(const t of['import_job','import_row','import_command']){
  assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='erp_preferences.${t}'::regclass`),true);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','erp_preferences.${t}','select') v`),false);
 }
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_preferences.import_item(uuid,text,uuid,text,jsonb)','execute') v"),false);
 const{batch,one}=importer(f);
 for(const user of[f.users.vendas,f.users.estoque,f.users.inactive,randomUUID()])
  await assert.rejects(()=>batch('products',[one(2,{name:'X'})],{dry:true,user}),code('42501'));
 for(const bad of[{p_kind:'notas'},{p_total_rows:0},{p_file_name:' a'},{p_rows:[]},{p_rows:[{row:1,lines:[1],data:{}}]},{p_rows:[{row:2,lines:[3],data:{}}]},{p_rows:[{row:2,lines:[2],data:{},x:1}]},
  {p_rows:[{row:2,lines:[2],data:{}},{row:2,lines:[2],data:{}}]},{p_dry_run:false}])
  await assert.rejects(()=>f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:null,p_job_id:null,p_kind:'products',p_file_name:'a.csv',p_total_rows:1,p_dry_run:true,p_rows:[{row:2,lines:[2],data:{name:'X'}}],...bad}),code('22023'),JSON.stringify(bad));
}finally{await f.close();}});

test('228 Importar e atualizar produtos: Validar uses the real rules and writes nothing; Importar creates, updates by Código and fills the default origin',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f);
 await f.preference('cadastros-produtos','produtos.origem_padrao','2');
 const existing=await f.catalog('products',{name:'Parafuso sintético',code:'P-1',unit:'UN',kind:'P',format:'S',price:'2.5'});
 await f.db.query("insert into erp_catalog.taxonomy(id,kind,name,created_by,updated_by) values(gen_random_uuid(),'categories','Ferragens',$1,$1)",[f.users.admin]);
 const items=[one(2,{code:'P-1',name:'Parafuso renomeado',price:'3.75'}),one(3,{code:'P-2',name:'Porca sintética',unit:'UN',category:'ferragens'}),one(4,{code:'P-3'}),
  one(5,{code:'P-4',name:'Arruela',category:'Inexistente'}),one(6,{code:'P-1'}),one(7,{name:'Origem própria',origin:'0'})];
 const counts=async()=>[await f.scalar("select count(*)::int v from erp_catalog.record where entity='products'"),await f.scalar('select count(*)::int v from erp_preferences.import_job'),
  await f.scalar('select count(*)::int v from erp_preferences.import_command'),await f.scalar("select count(*)::int v from erp_catalog.audit where entity='products'")];
 const before=await counts(),dry=await batch('products',items,{dry:true});
 assert.deepEqual(dry.items.map(i=>[i.row,i.status,i.action,i.reason,i.field]),[[2,'valid','update',null,null],[3,'valid','create',null,null],[4,'invalid',null,'erp_catalog_name_required','name'],
  [5,'invalid',null,'erp_preferences_import_not_found:category','category'],[6,'valid','update',null,null],[7,'valid','create',null,null]]);
 assert.deepEqual(await counts(),before,'a validation writes nothing');assert.equal(dry.job,null);
 const job=randomUUID(),command=randomUUID(),done=await batch('products',items,{command,job});
 assert.deepEqual(done.items.map(i=>[i.row,i.status,i.reference]),[[2,'updated','P-1'],[3,'created','P-2'],[4,'invalid',null],[5,'invalid',null],[6,'unchanged','P-1'],[7,'created','Origem própria']]);
 assert.equal(done.items[0].record_id,existing.id);
 assert.deepEqual([done.job.status,done.job.rows_done,done.job.created,done.job.updated,done.job.unchanged,done.job.invalid],['concluida',6,2,1,1,2]);
 const rows=(await f.db.query("select r.code,r.name,p.price::text price,p.origin,d.category_id is not null categorized from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_catalog.product_detail d on d.record_id=r.id where r.entity='products' order by r.created_at")).rows;
 assert.deepEqual(rows.map(r=>[r.code,r.name,r.origin,r.categorized]),[['P-1','Parafuso renomeado',null,false],['P-2','Porca sintética','2',true],[null,'Origem própria','0',false]]);
 assert.equal(Number(rows[0].price),3.75);
 // The same command answers the same result and imports nothing again; another body under it is refused.
 const again=await batch('products',items,{command,job});assert.equal(again.replayed,true);assert.deepEqual(again.items,done.items);
 await assert.rejects(()=>batch('products',[one(2,{code:'P-9',name:'Outro'})],{command,job,total:6}),code('40001'));
 assert.equal(await f.scalar("select count(*)::int v from erp_catalog.record where entity='products'"),3);
 // A finished job takes no new batch; its lines are listed in Consultar gestão de ações.
 await assert.rejects(()=>batch('products',[one(9,{name:'Mais um'})],{job,total:6}),code('40001'));
 const jobs=await f.rpc('erp_preferences_import_jobs',{p_user_id:f.users.admin,p_status:null,p_limit:25,p_offset:0});parseJobs(jobs,captureJobsQuery());
 assert.deepEqual([jobs.total,jobs.all_users,jobs.items[0].id,jobs.items[0].kind],[1,true,job,'products']);
 const errors=await f.rpc('erp_preferences_import_job',{p_user_id:f.users.admin,p_job_id:job,p_errors:true,p_limit:100,p_offset:0});parseJob(errors,captureJobQuery(job,{erros:'1'}));
 assert.deepEqual(errors.items.map(i=>[i.row,i.reason]),[[4,'erp_catalog_name_required'],[5,'erp_preferences_import_not_found:category']]);
 // The history is immutable.
 await assert.rejects(()=>f.db.query('update erp_preferences.import_row set reason=null'),code('42501'));
 await assert.rejects(()=>f.db.query('delete from erp_preferences.import_command'),code('42501'));
 await assert.rejects(()=>f.db.query("update erp_preferences.import_job set status='em_andamento',finished_at=null"),code('42501'));
}finally{await f.close();}});

test('228 a file imported in several batches: rows already recorded are never sent again, other users cannot use the job, and the job ends at the total',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f),job=randomUUID();
 const first=await batch('products',[one(2,{code:'A-1',name:'Primeiro'}),one(3,{code:'A-2',name:'Segundo'})],{job,total:4});
 assert.deepEqual([first.job.status,first.job.rows_done],['em_andamento',2]);
 // A new command (the screen was reloaded) with an already imported line: it answers the recorded result.
 const second=await batch('products',[one(3,{code:'A-2',name:'Segundo'}),one(4,{code:'A-3',name:'Terceiro'})],{job,total:4});
 assert.deepEqual(second.items.map(i=>[i.row,i.status]),[[3,'created'],[4,'created']]);assert.equal(second.items[0].record_id,first.items[1].record_id);
 assert.equal(await f.scalar("select count(*)::int v from erp_catalog.record where entity='products' and code='A-2'"),1);
 assert.deepEqual([second.job.rows_done,second.job.status],[3,'em_andamento']);
 await assert.rejects(()=>batch('products',[one(5,{name:'Quinto'})],{job,total:4,user:f.users.other}),code('42501'));
 await assert.rejects(()=>batch('contacts',[one(5,{name:'Quinto'})],{job,total:4}),code('22023'));
 await assert.rejects(()=>batch('products',[one(5,{name:'Quinto'})],{job,total:4,file:'outro.csv'}),code('22023'));
 const last=await batch('products',[one(5,{code:'A-4',name:'Quarto'})],{job,total:4});assert.deepEqual([last.job.status,last.job.rows_done,last.job.created],['concluida',4,4]);
 // Only the administrador sees every job; another user sees only theirs.
 const theirs=await f.rpc('erp_preferences_import_jobs',{p_user_id:f.users.vendas,p_status:null,p_limit:25,p_offset:0});assert.deepEqual([theirs.total,theirs.all_users],[0,false]);
 await assert.rejects(()=>f.rpc('erp_preferences_import_job',{p_user_id:f.users.vendas,p_job_id:job,p_errors:false,p_limit:10,p_offset:0}),code('P0002'));
 await assert.rejects(()=>f.rpc('erp_preferences_import_jobs',{p_user_id:f.users.inactive,p_status:null,p_limit:25,p_offset:0}),code('42501'));
 const page=await f.rpc('erp_preferences_import_job',{p_user_id:f.users.other,p_job_id:job,p_errors:false,p_limit:2,p_offset:2});parseJob(page,captureJobQuery(job,{limit:2,offset:2}));
 assert.deepEqual([page.total,page.has_more,page.items.map(i=>i.row)],[4,false,[4,5]]);
}finally{await f.close();}});

test('228 Importar e atualizar contatos: the CPF/CNPJ finds the contact to update; a new one is included with the form rules',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f),known=await f.catalog('contacts',{name:'Fornecedor Sintético',document:'11222333000181'});
 const done=await batch('contacts',[one(2,{name:'Cliente Novo',document:'52998224725'}),one(3,{document:'11.222.333/0001-81',city:'Campinas'}),one(4,{document:'52998224725'})]);
 // Line 4 repeats the CPF line 2 has just included: it finds that contact and has nothing to change.
 assert.deepEqual(done.items.map(i=>[i.row,i.status]),[[2,'created'],[3,'updated'],[4,'unchanged']]);
 assert.equal(done.items[1].record_id,known.id);assert.equal(done.items[2].record_id,done.items[0].record_id);
 const nameless=await batch('contacts',[one(2,{city:'Sem nome'})]);assert.deepEqual([nameless.items[0].status,nameless.items[0].reason,nameless.items[0].field],['invalid','erp_catalog_name_required','name']);
 assert.equal(await f.scalar('select city v from erp_catalog.contact where record_id=$1',[known.id]),'Campinas');
}finally{await f.close();}});

test('228 Importar pedidos de compra and Importar vendas: the lines of one number become one document, without stock or finance effects',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f);
 const product=await f.catalog('products',{name:'Parafuso sintético',code:'P-1',unit:'CX',kind:'P',format:'S',price:'2.5'});
 await f.catalog('contacts',{name:'Fornecedor Sintético',document:'11222333000181'});
 await f.catalog('contacts',{name:'Homônimo'});await f.catalog('contacts',{name:'homônimo '});
 const po=await batch('purchase_orders',[one(2,{number:'10',date:'2026-10-10',contact_document:'11222333000181',notes:'Pedido da planilha',items:[{code:'P-1',quantity:'2',unit_price:'2.4'},{description:'Item livre',quantity:'1',unit_price:'3.5'}]},[2,3])],{total:1});
 assert.equal(po.items[0].status,'created');assert.match(po.items[0].reference,/^nº \d+ \(planilha 10\)$/);
 const doc=await f.scalar('select erp_documents.dto($1) v',[po.items[0].record_id]);
 assert.deepEqual([doc.kind,doc.status,doc.totals.total,doc.notes,doc.items.length,doc.items[0].product_id,doc.items[0].unit,doc.items[0].code,doc.items[1].description],['purchase_orders','open','8.30','Pedido da planilha',2,product.id,'CX','P-1','Item livre']);
 const so=await batch('sales_orders',[one(2,{number:'A',date:'2026-10-10',contact_name:'fornecedor sintético',items:[{code:'P-1',quantity:'3'}]}),
  one(3,{number:'B',date:'2026-10-10',contact_name:'Homônimo',items:[{code:'P-1',quantity:'1'}]}),one(4,{number:'C',date:'2026-10-10',contact_name:'Fornecedor Sintético',items:[{code:'NAO',quantity:'1'}]})]);
 assert.deepEqual(so.items.map(i=>[i.status,i.reason]),[['created',null],['invalid','erp_preferences_import_ambiguous:contact_name'],['invalid','erp_preferences_import_not_found:item_code']]);
 assert.equal(await f.scalar("select total::text v from erp_documents.document where kind='sales_orders'"),'7.50','the product price fills an empty unit price');
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'),0);assert.equal(await f.scalar('select count(*)::int v from erp_finance.title'),0);
}finally{await f.close();}});

test('228 Importar movimentações de estoque em massa: Entrada, Saída and Balanço through erp_stock_post, under the negative stock policy',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f);
 await f.catalog('products',{name:'Parafuso sintético',code:'P-1',unit:'UN',kind:'P',format:'S'});await f.catalog('warehouses',{name:'Depósito Central'});
 const done=await batch('stock_movements',[one(2,{code:'P-1',warehouse:'Depósito Central',movement:'receipt',quantity:'5',note:'Saldo inicial'}),
  one(3,{code:'P-1',warehouse:'depósito central',movement:'balance',quantity:'5'}),one(4,{code:'P-1',warehouse:'Depósito Central',movement:'issue',quantity:'9'}),
  one(5,{code:'P-1',movement:'issue',quantity:'1'}),one(6,{code:'P-1',warehouse:'Depósito Central',movement:'balance',quantity:'2',date:'2026-10-15'}),one(7,{code:'P-1',warehouse:'Depósito Central',movement:'receipt',quantity:'0'})],{file:'estoque.xlsx'});
 assert.deepEqual(done.items.map(i=>[i.row,i.status,i.reason]),[[2,'created',null],[3,'unchanged',null],[4,'invalid','erp_stock_insufficient_or_excess_quantity'],
  [5,'invalid','erp_preferences_import_required:warehouse'],[6,'created',null],[7,'invalid','erp_preferences_import_invalid:quantity']]);
 const moves=(await f.db.query('select kind,reason,reference,occurred_on::text occurred from erp_stock.movement order by created_at')).rows;
 assert.deepEqual(moves.map(m=>[m.kind,m.reason,m.reference]),[['receipt','Saldo inicial','Importação estoque.xlsx'],['adjustment','Importação de movimentações de estoque','Importação estoque.xlsx']]);
 assert.equal(moves[1].occurred,'2026-10-15');assert.equal(Number(await f.scalar('select quantity::text v from erp_stock.balance')),2);
}finally{await f.close();}});

test('228 Importar contas a receber/pagar: open titles through erp_finance_title_execute, with names resolved and no settlement',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f);await f.catalog('contacts',{name:'Cliente Sintético',document:'52998224725'});
 await f.db.query("insert into erp_finance.category(id,name,kind,active) values(gen_random_uuid(),'Vendas de mercadorias','receivable',true),(gen_random_uuid(),'Aluguel','payable',true)");
 const r=await batch('receivables',[one(2,{contact_document:'52998224725',description:'Venda importada',issued_on:'2026-10-01',due_on:'2026-10-30',amount:'150.75',source_reference:'NF 10',category:'vendas de mercadorias'}),
  one(3,{contact_name:'Cliente Sintético',description:'Com categoria de despesa',issued_on:'2026-10-01',due_on:'2026-10-30',amount:'1',category:'Aluguel'}),
  one(4,{contact_name:'Cliente Sintético',description:'Vencimento antes da emissão',issued_on:'2026-10-10',due_on:'2026-10-01',amount:'1'})]);
 assert.deepEqual(r.items.map(i=>[i.status,i.reason]),[['created',null],['invalid','erp_preferences_import_not_found:category'],['invalid','erp_finance_invalid_due_date']]);
 const title=(await f.db.query('select kind,amount_cents::text cents,settled_cents::text settled,competence_on::text competence,source_reference,category_id is not null categorized from erp_finance.title')).rows;
 assert.deepEqual(title,[{kind:'receivable',cents:'15075',settled:'0',competence:'2026-10-01',source_reference:'NF 10',categorized:true}]);
 const p=await batch('payables',[one(2,{contact_name:'Cliente Sintético',description:'Aluguel de outubro',issued_on:'2026-10-01',due_on:'2026-10-10',amount:'1000',category:'Aluguel',competence_on:'2026-09-30'})]);
 assert.equal(p.items[0].status,'created');assert.equal(await f.scalar("select competence_on::text v from erp_finance.title where kind='payable'"),'2026-09-30');
}finally{await f.close();}});

test('228 Importar notas fiscais em Lote (PRF-026): one homologation draft NF-e per número, through erp_fiscal_invoice_execute',async()=>{const f=await laneDFixture();try{
 const{batch,one}=importer(f);
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict(singleton) do nothing",[f.users.admin]);
 const product=await f.catalog('products',{name:'Peça sintética',code:'P-1',unit:'UN',kind:'P',format:'S',price:'50',ncm:'84713012',origin:'0'});
 await f.catalog('contacts',{name:'Cliente Jurídico',document:'11222333000181',person_type:'J',state:'SP',city:'São Paulo'});
 // Without the company regime the line says so; nothing is created.
 const before=await batch('nfe',[one(2,{number:'1',contact_document:'11222333000181',items:[{code:'P-1',quantity:'2'}]})]);
 assert.equal(before.items[0].reason,'erp_preferences_import_company_regime');
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict(singleton) do update set crt='1',version=erp_company.fiscal.version+1",[f.users.admin]);
 const nature=async data=>(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:data}})).nature;
 const venda=await nature({description:'Venda sintética',direction:'1',crt:'1',presence:'1',rules:[{tax:'icms',data:{situation:'102',cfop:'5102'}}]});
 await nature({description:'Remessa sintética',direction:'1',crt:'1',presence:'1'});
 const missingDefault=await batch('nfe',[one(2,{number:'1',contact_document:'11222333000181',items:[{code:'P-1',quantity:'2'}]})]);assert.equal(missingDefault.items[0].reason,'erp_preferences_import_required:nature');
 await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'set_default',p_data:{id:venda.id,expected_version:1,code:'S'}});
 const done=await batch('nfe',[one(2,{number:'10',contact_document:'11222333000181',notes:'Pedido 10 da planilha',items:[{code:'P-1',quantity:'2'},{description:'Serviço avulso',quantity:'1',unit_price:'10'}]},[2,3]),
  one(4,{number:'11',date:'2026-10-19',nature:'remessa sintética',contact_name:'Cliente Jurídico',items:[{code:'P-1',quantity:'1',unit_price:'40'}]}),
  one(5,{number:'12',nature:'Inexistente',contact_name:'Cliente Jurídico',items:[{code:'P-1',quantity:'1'}]})]);
 assert.deepEqual(done.items.map(i=>[i.row,i.status,i.reason]),[[2,'created',null],[4,'created',null],[5,'invalid','erp_preferences_import_not_found:nature']]);
 const notes=(await f.db.query('select id,model,direction,status,environment,number,nature_description,issue_date::text issued,additional_info from erp_fiscal_invoices.invoice order by created_at')).rows;
 assert.deepEqual(notes.map(n=>[n.model,n.direction,n.status,n.environment,n.number,n.nature_description]),[['55','1',1,'2',null,'Venda sintética'],['55','1',1,'2',null,'Remessa sintética']]);
 assert.equal(notes[0].additional_info,'Pedido 10 da planilha');assert.equal(notes[1].issued,'2026-10-19');
 const items=(await f.db.query('select data from erp_fiscal_invoices.invoice_item where invoice_id=$1 order by position',[notes[0].id])).rows.map(r=>r.data);
 assert.equal(items.length,2);assert.equal(items[0].product_id,product.id);assert.equal(items[0].ncm,'84713012');assert.equal(items[1].description,'Serviço avulso');
}finally{await f.close();}});

test('228 a refusal whose suffix is not a field name keeps the reason without a field, so the rest of the batch is still recorded',async()=>{const f=await laneDFixture();try{
 const field=reason=>f.scalar('select erp_preferences.import_field($1) v',[reason]);
 assert.equal(await field('erp_catalog_contact_invalid:email'),'email');assert.equal(await field('erp_catalog_name_required'),'name');
 for(const reason of['erp_fiscal_invoice_invalid:item_2','erp_x:Campo','erp_x_refused'])assert.equal(await field(reason),null,reason);
 assert.equal(await f.scalar("select erp_preferences.import_reason('erp_fiscal_invoice_invalid:item_2','22023') v"),'erp_fiscal_invoice_invalid:item_2');
}finally{await f.close();}});
