import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneDFixture,fails}from'./helpers/preferences-d-fixture.mjs';
import{captureActivityQuery,parseActivity,captureActivityDetailQuery,parseActivityDetail,ACTIVITY_MODULES}from'../../../packages/erp-domain/src/activity.mjs';

// 232 (not applied yet): the audits of wave C (comissões, controle de caixa, faturamento agrupado, anexos do contato, campos
// customizados, tags de contatos, recebimento de compras) and of wave D (importações, tipo, horários e permissões) reach the
// Registro de atividades with the Origin operation and module. Runs on every migration applied in production plus this lane.
const today=f=>f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
async function log(f,filters={}){
 const day=await today(f),q=captureActivityQuery({from:day,to:day,...filters});
 return parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:q.operation,p_actor:q.actor,p_query:q.q,p_limit:q.limit,p_offset:q.offset}),q).items;
}
const detail=async(f,e)=>{const q=captureActivityDetailQuery({source:e.source,id:e.id});return parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:q.source,p_entry_id:q.id}),q);};
const rows=(items,source)=>items.filter(e=>e.source===source).map(e=>[e.module,e.operation,e.description]).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1);

test('232 replaces only the 186 definitions it knows: another version of any of them stops the migration',async()=>{
 for(const fn of['erp_activity.finance_label(text)','erp_activity.entries(timestamptz,timestamptz)','public.erp_activity_detail(uuid,text,text)']){
  const f=await laneDFixture({before:'202610200232'});try{
   const def=await f.scalar('select pg_get_functiondef($1::regprocedure) v',[fn]);
   await f.db.exec(def.replace(/\$function\$\n/,'$function$\n-- changed elsewhere\n'));
   await fails(assert,()=>f.migrate('202610200232_activity_registry_wave_c.sql'),'55000');
  }finally{await f.close();}
 }
 const f=await laneDFixture();try{
  for(const name of['erp_activity_list','erp_activity_detail']){
   const r=(await f.db.query(`select p.prosecdef d,p.proconfig c,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('authenticated',p.oid,'execute') u,has_function_privilege('service_role',p.oid,'execute') s
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`,[name])).rows;
   assert.deepEqual([r.length,r[0].d,r[0].c,r[0].a,r[0].u,r[0].s],[1,true,['search_path=pg_catalog'],false,false,true],name);
  }
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_activity.entries(timestamptz,timestamptz)','execute') v"),false);
 }finally{await f.close();}
});

test('232 Comissão, Controle de caixa and Faturamento agrupado: each financial action in its Origin module and operation',async()=>{const f=await laneDFixture();try{
 const actions=['commission_payment','commission_entry','commission_manual','commission_delete','session_open','session_save','session_close','session_reopen','session_move','session_move_delete',
  'session_delete','grouped_billing_generate','grouped_billing_delete','title_edit','line_create_transfer'];
 for(const action of actions)await f.db.query("insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values($1,$2,$3,null,'{}')",[f.users.financeiro,randomUUID(),action]);
 const all=await log(f);
 assert.deepEqual(rows(all,'finance'),[
  ['caixa','atualizacao','Caixa alterado'],['caixa','atualizacao_situacao','Caixa fechado'],['caixa','atualizacao_situacao','Caixa reaberto'],['caixa','criacao','Caixa aberto'],
  ['caixa','exclusao','Caixa excluído'],['caixa','exclusao','Sangria ou suprimento de caixa excluído'],['caixa','lancamento','Sangria ou suprimento de caixa'],['caixa','transferencia','Conciliação bancária'],
  ['comissao','criacao','Comissão manual'],['comissao','exclusao','Comissão excluída'],['comissao','lancamento','Crédito ou débito no extrato de comissões'],['comissao','lancamento','Pagamento de comissões'],
  ['financas','atualizacao','Conta alterada'],['financas','criacao','Faturamento agrupado: contas geradas'],['financas','exclusao','Faturamento agrupado excluído']]);
 // The new Origin modules filter the period, and the financial audit keeps its before and after.
 assert.equal((await log(f,{module:'comissao'})).length,4);assert.equal((await log(f,{module:'caixa',operation:'criacao'})).length,1);
 assert.equal((await detail(f,all.find(e=>e.description==='Caixa aberto'))).available,true);
 assert.ok(ACTIVITY_MODULES.indexOf('campos_customizados')===0&&ACTIVITY_MODULES.indexOf('comissao')===ACTIVITY_MODULES.indexOf('caixa')+1);
 await fails(assert,()=>f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:'2026-10-01',p_to:'2026-10-02',p_module:'cotacoes_frenet',p_operation:null,p_actor:null,p_query:null,p_limit:10,p_offset:0}),'22023');
}finally{await f.close();}});

test('232 Campos Customizados, tags and files of contacts, contact labels and the purchase receipt',async()=>{const f=await laneDFixture();try{
 const field=(await f.rpc('erp_catalog_custom_field_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{field_type:'integer',name:'Voltagem'}})).field;
 await f.rpc('erp_catalog_custom_field_delete',{p_user_id:f.users.admin,p_id:field.id,p_expected_version:field.version,p_command_id:randomUUID()});
 await f.rpc('erp_catalog_taxonomy_save',{p_user_id:f.users.admin,p_kind:'tags',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Atacado',tag_type:'contacts'}});
 await f.rpc('erp_catalog_taxonomy_save',{p_user_id:f.users.admin,p_kind:'tags',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Promoção',tag_type:'products'}});
 const contact=await f.catalog('contacts',{name:'Cliente Sintético 232'});
 const file=randomUUID(),photo=randomUUID();
 for(const[id,purpose,name,mime]of[[file,'attachment','contrato.pdf','application/pdf'],[photo,'photo','rosto.png','image/png']]){
  await f.db.query(`insert into erp_attachments.contact_file(id,contact_id,purpose,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,10,$6,'ready',$5,now())`,[id,contact.id,purpose,randomUUID(),f.users.vendas,'b'.repeat(64),name,mime]);
  for(const action of['reserve','finalize'])await f.db.query('insert into erp_attachments.contact_file_audit(file_id,actor,action,command_id) values($1,$2,$3,$4)',[id,f.users.vendas,action,randomUUID()]);
 }
 await f.db.query("insert into erp_attachments.contact_file_audit(file_id,actor,action,command_id) values($1,$2,'delete',$3)",[file,f.users.admin,randomUUID()]);
 await f.db.query("insert into erp_catalog.auxiliary_audit(actor,subject,action,after_data) values($1,'contacts_export','labels','{\"total\":3}')",[f.users.vendas]);
 const product=await f.catalog('products',{name:'Insumo 232',unit:'UN',kind:'P',format:'S',price:'2'});
 const order=await f.document('purchase_orders',{contact:contact.id,items:[{product_id:product.id,description:'Insumo 232',quantity:'1',unit_price:'2'}]});
 await f.db.query("insert into erp_documents.audit(actor,command_id,document_id,action,reason,after_data) values($1,$2,$3,'purchase_receive','Recebido','{}')",[f.users.estoque,randomUUID(),order.id]);
 const all=await log(f);
 assert.deepEqual(rows(all,'custom_fields'),[['campos_customizados','criacao','Campo customizado Voltagem'],['campos_customizados','exclusao','Campo customizado Voltagem']]);
 const created=all.find(e=>e.source==='custom_fields'&&e.operation==='criacao'),d=await detail(f,created);
 assert.deepEqual([d.available,d.before,typeof d.after],[true,null,'object']);
 assert.deepEqual(rows(all,'taxonomy'),[['clientes_fornecedores','criacao','Tag Atacado'],['produtos','criacao','Tag Promoção']]);
 assert.deepEqual(rows(all,'contact_files'),[['clientes_fornecedores','criacao','Anexo do contato Cliente Sintético 232 · contrato.pdf'],['clientes_fornecedores','criacao','Foto do contato Cliente Sintético 232 · rosto.png'],
  ['clientes_fornecedores','exclusao','Anexo do contato Cliente Sintético 232 · contrato.pdf']]);
 const fileEntry=all.find(e=>e.source==='contact_files');assert.equal(fileEntry.code,contact.code);
 assert.deepEqual([(await detail(f,fileEntry)).available],[false]);
 assert.ok(all.some(e=>e.source==='auxiliary'&&e.operation==='envio'&&e.description==='Etiquetas de contatos (3)'));
 const receipt=all.find(e=>e.source==='documents'&&e.description.endsWith('· Recebido'));assert.deepEqual([receipt.module,receipt.operation],['pedidos_compra','lancamento']);
}finally{await f.close();}});

test('232 spreadsheet imports and the user controls: one line per import in the imported module, and the controls with their own text',async()=>{const f=await laneDFixture();try{
 const job=randomUUID();
 const done=await f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_job_id:job,p_kind:'contacts',p_file_name:'clientes.csv',p_total_rows:2,p_dry_run:false,
  p_rows:[{row:2,lines:[2],data:{name:'Importado Um'}},{row:3,lines:[3],data:{name:'Importado Dois'}}]});
 assert.equal(done.job.status,'concluida');
 // A dry run (Validar) writes nothing and so is not in the log.
 await f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:null,p_job_id:null,p_kind:'products',p_file_name:'produtos.csv',p_total_rows:1,p_dry_run:true,p_rows:[{row:2,lines:[2],data:{name:'Prévia'}}]});
 await f.rpc('erp_access_user_controls_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_target:f.users.vendas,p_expected_version:0,
  p_data:{user_type:'contador',schedule:{enabled:true,windows:[{start:'08:00',end:'12:00',days:[1,2,3]}]},permissions:null}});
 const all=await log(f);
 assert.deepEqual(rows(all,'imports'),[['clientes_fornecedores','criacao','Importação de planilha de contatos · clientes.csv (2 linhas)']]);
 assert.equal(all.find(e=>e.source==='imports').id,job);
 assert.equal(all.filter(e=>e.source==='catalog'&&e.module==='clientes_fornecedores'&&e.operation==='criacao').length,2,'each imported contact is in the log too');
 assert.equal((await detail(f,all.find(e=>e.source==='imports'))).available,false);
 const controls=all.find(e=>e.source==='users');assert.equal(controls.operation,'atualizacao');assert.match(controls.description,/^Tipo, horários e permissões do usuário /);
 const d=await detail(f,controls);assert.deepEqual([d.before.user_type,d.after.user_type,d.after.schedule.enabled],['normal','contador',true]);
 assert.deepEqual((await log(f,{module:'clientes_fornecedores',q:'clientes.csv'})).map(e=>e.source),['imports']);
}finally{await f.close();}});
