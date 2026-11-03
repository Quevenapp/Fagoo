import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneEFixture,migrationSql,fails}from'./helpers/preferences-e-fixture.mjs';
import{parseActivity,captureActivityQuery,parseActivityDetail,captureActivityDetailQuery,parseFiles,captureFilesQuery}from'../../../packages/erp-domain/src/activity.mjs';

// Synthetic data only. 263: Gerenciador de arquivos (every origin, deleted attachments left out) and the Registro de atividades
// with the wave D audits of the other lanes. Audit rows are written as each module writes them (same columns and actions).
const SHA='a'.repeat(64),today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
async function seed(f){
 const contact=await f.catalog('contacts',{name:'Cliente Sintético Arquivos'});
 const product=await f.catalog('products',{name:'Produto Sintético Imagem',code:'IMG-1',unit:'UN',kind:'P',format:'S',price:'1'});
 const order=await f.document('sales_orders',{contact:contact.id,items:[{product_id:product.id,description:'Produto Sintético Imagem',quantity:'1',unit_price:'10'}]});
 const doc=async(name,{deleted=false,size=100}={})=>{const id=(await f.db.query("insert into erp_attachments.attachment(document_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at) values($1,$2,$3,$4,$5,'application/pdf',$6,$7,'ready',$3,clock_timestamp()) returning id",
  [order.id,randomUUID(),f.users.admin,SHA,name,size,SHA])).rows[0].id;
  await f.db.query("insert into erp_attachments.audit(attachment_id,actor,action) values($1,$2,'finalize')",[id,f.users.admin]);
  if(deleted){await f.db.query('update erp_attachments.attachment set deleted_at=clock_timestamp(),deleted_by=$2,delete_command_id=$3 where id=$1',[id,f.users.admin,randomUUID()]);
   await f.db.query("insert into erp_attachments.audit(attachment_id,actor,action,command_id) values($1,$2,'delete',$3)",[id,f.users.admin,randomUUID()]);}
  return id;};
 const kept=await doc('anexo-contrato.pdf',{size:300}),gone=await doc('anexo-excluido.pdf',{deleted:true});
 const photo=(await f.db.query("insert into erp_attachments.contact_file(contact_id,purpose,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at) values($1,'photo',$2,$3,$4,'anexo-foto.png','image/png',50,$4,'ready',$3,clock_timestamp()) returning id",
  [contact.id,randomUUID(),f.users.admin,SHA])).rows[0].id;
 const title=(await f.rpc('erp_finance_title_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'title_create',p_data:{kind:'payable',contact_id:contact.id,description:'Conta com comprovante',issued_on:'2026-03-01',competence_on:'2026-03-01',total_cents:'5000',installments:[{amount_cents:'5000',due_on:'2026-03-10'}]}})).items[0];
 const finance=(await f.db.query("insert into erp_finance.file(owner_kind,owner_id,title_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at) values('title',$1,$1,$2,$3,$4,'anexo-boleto.pdf','application/pdf',70,$4,'ready',$3,clock_timestamp()) returning id",
  [title.id,randomUUID(),f.users.financeiro,SHA])).rows[0].id;
 await f.db.query("insert into erp_finance.file_audit(file_id,actor,action) values($1,$2,'finalize')",[finance,f.users.financeiro]);
 const image=(await f.db.query("insert into erp_catalog.product_stored_image(product_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at,position) values($1,$2,$3,$4,'anexo-imagem.jpg','image/jpeg',80,$4,'ready',$3,clock_timestamp(),1) returning id",
  [product.id,randomUUID(),f.users.admin,SHA])).rows[0].id;
 await f.db.query("insert into erp_catalog.product_image_audit(image_id,product_id,actor,action) values($1,$2,$3,'finalize')",[image,product.id,f.users.admin]);
 await f.db.query("insert into erp_catalog.product_image_audit(product_id,actor,action,command_id,after_data) values($1,$2,'order',$3,'{}')",[product.id,f.users.admin,randomUUID()]);
 const logo=(await f.db.query("insert into erp_company.logo(command_id,actor,request_hash,mime_type,size_bytes,sha256,status,finished_by,finished_at) values($1,$2,$3,'image/png',40,$3,'ready',$2,clock_timestamp()) returning id",[randomUUID(),f.users.admin,SHA])).rows[0].id;
 await f.db.query("insert into erp_company.logo_audit(logo_id,actor,action) values($1,$2,'finalize')",[logo,f.users.admin]);
 // Frente de caixa: a finished sale and the settings.
 const sale=(await f.db.query("insert into erp_pos.sale(document_id,operator_id,kind,state,customer_identified,total_cents,command_id,finished_at,finished_by) values($1,$2,'balcao','finished',false,1000,$3,clock_timestamp(),$2) returning id",[order.id,f.users.vendas,randomUUID()])).rows[0].id;
 await f.db.query("insert into erp_pos.audit(actor,command_id,sale_id,action,before_data,after_data) values($1,$2,$3,'sale_finish','{\"state\":\"open\"}','{\"state\":\"finished\"}')",[f.users.vendas,randomUUID(),sale]);
 await f.db.query("insert into erp_pos.audit(actor,command_id,sale_id,action,before_data,after_data) values($1,$2,$3,'sale_return',null,'{\"value_cents\":\"500\"}')",[f.users.vendas,randomUUID(),sale]);
 await f.db.query("insert into erp_pos.audit(actor,command_id,action,before_data,after_data) values($1,$2,'settings_save','{}','{\"controle_caixa\":true}')",[f.users.admin,randomUUID()]);
 await f.db.query("insert into erp_stock.composition_command(id,actor,action,product_id,request_hash,result) values($1,$2,'sync',$3,$4,'{}')",[randomUUID(),f.users.admin,product.id,SHA]);
 await f.db.query("insert into erp_documents.user_signature_audit(user_id,command_id,before_data,after_data) values($1,$2,null,'{\"greeting\":\"Atenciosamente\"}')",[f.users.vendas,randomUUID()]);
 for(const action of['reserve','finalize','remittance_exclude','return_commit','return_exclude','operational_settle','profile_save'])
  await f.db.query('insert into erp_cnab.audit(actor,command_id,action,record_id) values($1,$2,$3,$4)',[f.users.financeiro,randomUUID(),action,randomUUID()]);
 return{contact,product,order,kept,gone,photo,title,finance,image,logo,sale};
}
const list=async(f,args={})=>parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:today(),p_to:today(),p_module:null,p_operation:null,p_actor:null,p_query:null,p_limit:100,p_offset:0,...args}),
 captureActivityQuery({from:today(),to:today(),module:args.p_module??null,operation:args.p_operation??null,limit:100}));

test('263 replaces only the applied definitions: another version of any of them stops the migration',async()=>{
 const f=await laneEFixture({before:'202610200263'});try{
  await f.db.exec("create or replace function public.erp_activity_detail(p_user_id uuid,p_source text,p_entry_id text) returns jsonb language sql stable security definer set search_path=pg_catalog as $$ select '{}'::jsonb $$;");
  await assert.rejects(()=>f.migrate('202610200263_files_activity_wave_d.sql'),e=>e.code==='55000'&&/activity_263_previous_definition_changed public.erp_activity_detail/.test(e.message));
 }finally{await f.close();}
});

test('263 Gerenciador de arquivos: every origin, deleted attachments left out (also in the 118 contract), filters, order and administrador only',async()=>{const f=await laneEFixture();try{
 const s=await seed(f);
 const v1=await f.rpc('erp_files_list',{p_user_id:f.users.admin,p_query:null,p_from:null,p_to:null,p_order:'data',p_limit:100,p_offset:0});
 assert.deepEqual(v1.items.map(i=>i.id),[s.kept],'the 118 contract no longer lists the attachment deleted since 170');
 const q=captureFilesQuery({}),all=parseFiles(await f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:null,p_from:null,p_to:null,p_order:'data',p_origin:null,p_limit:100,p_offset:0}),q);
 assert.deepEqual(all.items.map(i=>i.origin).sort(),['contatos','documentos','empresa','financeiro','produtos']);
 assert.ok(!all.items.some(i=>i.id===s.gone));
 const byId=Object.fromEntries(all.items.map(i=>[i.origin,i]));
 assert.deepEqual(byId.documentos.source,{kind:'sales_orders',id:s.order.id,code:String(s.order.number),label:'Cliente Sintético Arquivos'});
 assert.deepEqual([byId.contatos.source.kind,byId.contatos.source.id,byId.contatos.source.label],['contact_photo',s.contact.id,'Cliente Sintético Arquivos']);
 assert.deepEqual([byId.financeiro.source.kind,byId.financeiro.source.id,byId.financeiro.source.label],['title',s.title.id,'Conta com comprovante']);
 assert.deepEqual([byId.produtos.source.kind,byId.produtos.source.id,byId.produtos.source.code],['product',s.product.id,'IMG-1']);
 assert.deepEqual([byId.empresa.filename,byId.empresa.source.kind,byId.empresa.source.id],['logo.png','logo',s.logo]);
 assert.equal(all.total_bytes,String(300+50+70+80+40));
 const size=parseFiles(await f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:null,p_from:null,p_to:null,p_order:'tamanho',p_origin:null,p_limit:2,p_offset:0}),captureFilesQuery({order:'tamanho',limit:2}));
 assert.deepEqual([size.items.map(i=>i.size_bytes),size.total,size.has_more],[[300,80],5,true]);
 const fin=parseFiles(await f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:'boleto',p_from:today(),p_to:today(),p_order:'nome',p_origin:'financeiro',p_limit:10,p_offset:0}),captureFilesQuery({q:'boleto',from:today(),to:today(),order:'nome',origin:'financeiro',limit:10}));
 assert.deepEqual(fin.items.map(i=>i.id),[s.finance]);
 assert.equal((await f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:null,p_from:null,p_to:null,p_order:'data',p_origin:'documentos',p_limit:10,p_offset:0})).total,1);
 await fails(assert,()=>f.rpc('erp_files_list_v2',{p_user_id:f.users.financeiro,p_query:null,p_from:null,p_to:null,p_order:'data',p_origin:null,p_limit:10,p_offset:0}),'42501');
 await fails(assert,()=>f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:null,p_from:null,p_to:null,p_order:'data',p_origin:'outros',p_limit:10,p_offset:0}),'22023');
 await fails(assert,()=>f.rpc('erp_files_list_v2',{p_user_id:f.users.admin,p_query:null,p_from:today(),p_to:null,p_order:'data',p_origin:null,p_limit:10,p_offset:0}),'22023');
 for(const fn of['erp_files_list_v2(uuid,text,date,date,text,text,integer,integer)','erp_files_list(uuid,text,date,date,text,integer,integer)']){
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",['public.'+fn]),true);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,['public.'+fn]),false);
 }
}finally{await f.close();}});

test('263 Registro de atividades: Frente de caixa, composições, imagens, anexos das contas, logo, assinatura, remessas e retornos and deleted attachments',async()=>{const f=await laneEFixture();try{
 const s=await seed(f);
 const page=await list(f),by=source=>page.items.filter(i=>i.source===source);
 const pos=by('pos');
 assert.deepEqual(pos.map(i=>[i.module,i.operation]).sort(),[['frente_caixa','atualizacao_situacao'],['frente_caixa','estorno'],['preferencias','atualizacao']].sort());
 assert.ok(pos.some(i=>i.description===`Venda nº ${s.order.number} na frente de caixa · finalizada`&&i.code===String(s.order.number)));
 assert.ok(pos.some(i=>i.description==='Configurações da frente de caixa'));
 assert.deepEqual(by('compositions').map(i=>[i.module,i.operation,i.code,i.description]),[['produtos','atualizacao','IMG-1','Estrutura da composição Produto Sintético Imagem · valores atualizados pelos componentes']]);
 assert.deepEqual(by('product_images').map(i=>i.operation).sort(),['atualizacao','criacao']);
 assert.ok(by('product_images').some(i=>i.description==='Imagem do produto Produto Sintético Imagem · anexo-imagem.jpg'));
 assert.deepEqual(by('finance_files').map(i=>[i.module,i.operation,i.description]),[['financas','criacao','Anexo da conta Conta com comprovante · anexo-boleto.pdf']]);
 assert.deepEqual(by('company_logo').map(i=>[i.module,i.operation,i.description]),[['empresa','atualizacao','Logo da empresa enviado']]);
 assert.deepEqual(by('user_signatures').map(i=>[i.module,i.operation]),[['propostas','criacao']]);
 const cnab=Object.fromEntries(by('cnab').map(i=>[i.description,[i.module,i.operation]]));
 assert.deepEqual(cnab,{'Remessa de cobrança reservada':['cobranca','criacao'],'Arquivo de remessa gerado':['cobranca','envio'],'Remessa excluída':['cobranca','exclusao'],
  'Arquivo de retorno importado':['cobranca','lancamento'],'Retorno excluído':['cobranca','exclusao'],'Baixa pelo retorno de cobrança':['pagamento_recebimento','lancamento'],
  'Configuração da cobrança bancária':['cobranca','atualizacao']});
 assert.ok(by('attachments').some(i=>i.operation==='exclusao'&&i.description==='Anexo anexo-excluido.pdf · excluído'));
 // The filter by the new module and the detail of the sources that keep before and after.
 assert.equal((await list(f,{p_module:'frente_caixa'})).total,2);
 const sale=pos.find(i=>i.operation==='atualizacao_situacao'),d=parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'pos',p_entry_id:sale.id}),captureActivityDetailQuery({source:'pos',id:sale.id}));
 assert.deepEqual([d.available,d.before,d.after],[true,{state:'open'},{state:'finished'}]);
 const comp=by('compositions')[0],c=parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'compositions',p_entry_id:comp.id}),captureActivityDetailQuery({source:'compositions',id:comp.id}));
 assert.equal(c.available,false);
 await fails(assert,()=>f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:today(),p_to:today(),p_module:'pdv',p_operation:null,p_actor:null,p_query:null,p_limit:100,p_offset:0}),'22023');
 await fails(assert,()=>f.rpc('erp_activity_detail',{p_user_id:f.users.financeiro,p_source:'pos',p_entry_id:sale.id}),'42501');
}finally{await f.close();}});
