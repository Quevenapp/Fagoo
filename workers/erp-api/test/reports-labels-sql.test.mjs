import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{systemFixture,fails}from'./helpers/system-fixture.mjs';
import{REPORT_BASES_149 as REPORT_BASES,LABEL_DEFAULTS,sameJson,parseReports,captureReportRun,parseReportRows,captureReportSave,captureFrameworkDelete,parseFrameworkResult,parseLabels,captureLabelSave,
 captureLabelRecordsQuery,parseLabelRecords}from'../../../packages/erp-domain/src/reports-labels.mjs';

// Migration 149 (not applied yet): Relatórios customizados and Etiquetas customizadas. Synthetic data only.
const reports=async(f,user=f.users.admin)=>parseReports(await f.rpc('erp_preferences_reports',{p_user_id:user}));
const run=async(f,def,user=f.users.admin)=>{const r=captureReportRun({filters:[],view_limit:2000,offset:0,page:20,...def});
 return parseReportRows(await f.rpc('erp_preferences_report_run',{p_user_id:user,p_base:r.base,p_columns:r.columns,p_filters:r.filters,p_view_limit:r.view_limit,p_offset:r.offset,p_page:r.page}),r);};
const save=async(f,body,user=f.users.admin)=>{const s=captureReportSave(body);return parseFrameworkResult(await f.rpc('erp_preferences_report_save',{p_user_id:user,p_command_id:s.command_id,p_report:s.id,p_expected_version:s.expected_version,p_data:s.data}),s,'report-save');};
const remove=async(f,target,body)=>{const s=captureFrameworkDelete(body);return parseFrameworkResult(await f.rpc('erp_preferences_framework_delete',{p_user_id:f.users.admin,p_command_id:s.command_id,p_target:target,p_items:s.items}),s,target==='reports'?'reports-delete':'labels-delete');};
const reportBody=(patch={})=>({command_id:randomUUID(),id:null,expected_version:0,data:{base:'vendas',title:'Vendas por cliente',columns:['numero','contato','total'],filters:[],view_limit:2000,with_totals:true,users:[],...patch}});
async function seed(f){
 const ana=await f.catalog('contacts',{name:'Ana Sintética',city:'Campinas',state:'SP'}),bia=await f.catalog('contacts',{name:'Bia Sintética',city:'Santos',state:'SP'});
 const p=await f.catalog('products',{name:'Caneta azul',code:'CAN-1',unit:'UN',kind:'P',format:'S',price:'2.5',gtin:'7891234567895'});
 await f.catalog('products',{name:'Borracha',code:'BOR-1',unit:'UN',kind:'P',format:'S',price:'1.25'});
 for(const [contact,qty] of[[ana,'2'],[bia,'4'],[ana,'1']])await f.document('sales_orders',{contact:contact.id,items:[{product_id:p.id,description:'Caneta azul',quantity:qty,unit_price:'2.5'}]});
 await f.db.query("insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents) values($1,1,2,'receivable',$2,'Parcela sintética','2026-10-01','2026-10-10',15000,5000),($3,1,1,'payable',$2,'Conta sintética','2026-10-01','2099-12-31',1000,0)",[randomUUID(),ana.id,randomUUID()]);
 return{ana,bia,p};
}

test('149 relatórios: the SQL catalog is the domain catalog, the bases follow the module rules and a page carries rows, totals and the limit',async()=>{const f=await systemFixture();try{
 assert.ok(sameJson(await f.scalar('select erp_preferences.report_catalog() v'),JSON.parse(JSON.stringify(REPORT_BASES))));
 await seed(f);
 const admin=await reports(f);assert.deepEqual(admin.bases.map(b=>b.base),REPORT_BASES.map(b=>b.base));assert.equal(admin.can_manage,true);assert.equal(admin.directory.length,7);
 const vendas=await reports(f,f.users.vendas);assert.ok(!vendas.bases.some(b=>['contas_receber','contas_pagar','pedidos_compra'].includes(b.base)));assert.equal(vendas.directory,null);
 assert.ok(!(await reports(f,f.users.estoque)).bases.some(b=>b.base.startsWith('contas_')));
 await fails(assert,()=>reports(f,f.users.inactive),'42501');
 const all=await run(f,{base:'vendas',columns:['contato','total','numero']});
 assert.deepEqual(all.rows,[['Ana Sintética','5.00','1'],['Bia Sintética','10.00','2'],['Ana Sintética','2.50','3']]);assert.deepEqual(all.totals,{total:'17.50'});assert.equal(all.total_rows,3);
 const ana=await run(f,{base:'vendas',columns:['numero','total'],filters:[{column:'contato',value:'ana'}]});assert.deepEqual(ana.rows,[['1','5.00'],['3','2.50']]);assert.deepEqual(ana.totals,{total:'7.50'});
 const exact=await run(f,{base:'vendas',columns:['numero'],filters:[{column:'total',value:'10'}]});assert.deepEqual(exact.rows,[['2']]);
 const limited=await run(f,{base:'vendas',columns:['numero','total'],view_limit:2,page:1,offset:1});assert.deepEqual([limited.rows,limited.total_rows,limited.truncated,limited.totals],[[['2','10.00']],2,true,{total:'15.00'}]);
 const products=await run(f,{base:'produtos',columns:['descricao','preco','gtin']});assert.deepEqual(products.rows.map(r=>r[0]),['Borracha','Caneta azul']);assert.equal(products.totals.preco,'3.7500');
 const titles=await run(f,{base:'contas_receber',columns:['contato','parcela','valor','saldo','situacao']},f.users.financeiro);assert.deepEqual(titles.rows,[['Ana Sintética','1/2','150.00','100.00','Parcial']]);
 assert.deepEqual((await run(f,{base:'contas_pagar',columns:['situacao']})).rows,[['Em aberto']]);
 assert.deepEqual((await run(f,{base:'contatos',columns:['nome','cidade','uf']})).rows,[['Ana Sintética','Campinas','SP'],['Bia Sintética','Santos','SP']]);
 await fails(assert,()=>run(f,{base:'contas_receber',columns:['valor']},f.users.vendas),'42501');
 for(const bad of[{p_columns:['inexistente']},{p_columns:[]},{p_columns:['numero','numero']},{p_filters:[{column:'total',value:'dez'}]},{p_filters:[{column:'contato',value:' x'}]},{p_view_limit:2001},{p_page:201},{p_offset:5,p_view_limit:5}])
  await fails(assert,()=>f.rpc('erp_preferences_report_run',{p_user_id:f.users.admin,p_base:'vendas',p_columns:['numero'],p_filters:[],p_view_limit:2000,p_offset:0,p_page:20,...bad}),'22023');
}finally{await f.close();}});

test('149 relatórios customizados: Salvar with title, columns, filters and users by command and version; who sees them; Excluir by version',async()=>{const f=await systemFixture();try{
 const body=reportBody({users:[f.users.vendas]}),created=await save(f,body);assert.equal((await save(f,body)).replayed,true);
 await fails(assert,()=>f.rpc('erp_preferences_report_save',{p_user_id:f.users.admin,p_command_id:body.command_id,p_report:null,p_expected_version:0,p_data:{...body.data,title:'Outro'}}),'40001');
 await fails(assert,()=>save(f,reportBody({title:'vendas POR cliente'})),'23505');
 await fails(assert,()=>save(f,reportBody({title:'Por vendas'}),f.users.vendas),'42501');
 await fails(assert,()=>save(f,reportBody({title:'Inativo',users:[f.users.inactive]})),'22023');
 const id=created.receipt.target;let list=await reports(f);const saved=list.reports.find(r=>r.id===id);
 assert.deepEqual([saved.title,saved.columns,saved.users,saved.version],['Vendas por cliente',['numero','contato','total'],[f.users.vendas],1]);
 assert.deepEqual((await reports(f,f.users.vendas)).reports.map(r=>r.id),[id]);assert.deepEqual((await reports(f,f.users.consulta)).reports,[]);
 const edit={command_id:randomUUID(),id,expected_version:1,data:{...body.data,title:'Vendas da Ana',filters:[{column:'contato',value:'Ana'}],users:[]}};await save(f,edit);
 await fails(assert,()=>save(f,{...edit,command_id:randomUUID()}),'40001');
 await fails(assert,()=>save(f,{command_id:randomUUID(),id,expected_version:2,data:{...edit.data,base:'propostas'}}),'22023');
 await fails(assert,()=>save(f,{command_id:randomUUID(),id,expected_version:2,data:edit.data}),'22023');
 assert.deepEqual((await reports(f,f.users.vendas)).reports,[]);
 await fails(assert,()=>remove(f,'reports',{command_id:randomUUID(),items:[{id,expected_version:1}]}),'40001');
 assert.equal((await remove(f,'reports',{command_id:randomUUID(),items:[{id,expected_version:2}]})).receipt.count,1);assert.deepEqual((await reports(f)).reports,[]);
 const audit=(await f.db.query("select action,before_data is null b,after_data is null a from erp_preferences.framework_audit where area='reports' order by id")).rows;
 assert.deepEqual(audit.map(r=>[r.action,r.b,r.a]),[['report_create',true,false],['report_update',false,false],['report_delete',false,true]]);
}finally{await f.close();}});

test('149 etiquetas: five fixed Padrões, Clonar into Customizadas, the model rules, Excluir by version and the records of what the role reads',async()=>{const f=await systemFixture();try{
 const {p}=await seed(f);
 assert.ok(sameJson(await f.scalar('select erp_preferences.label_defaults() v'),JSON.parse(JSON.stringify(LABEL_DEFAULTS))));
 const labels=parseLabels(await f.rpc('erp_preferences_labels',{p_user_id:f.users.admin}));
 assert.deepEqual(labels.items.map(t=>[t.id,t.type]),[['padrao-contato','contato'],['padrao-produto','produto'],['padrao-nota-fiscal','nota_fiscal'],['padrao-ordem-servico','ordem_servico'],['padrao-pedido-venda','pedido_venda']]);
 await fails(assert,()=>f.rpc('erp_preferences_labels',{p_user_id:f.users.vendas}),'42501');
 const product=labels.items[1],clone=captureLabelSave({command_id:randomUUID(),id:null,expected_version:0,data:{type:'produto',description:'Gôndola',config:product.config}});
 const created=parseFrameworkResult(await f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:clone.command_id,p_label:null,p_expected_version:0,p_data:clone.data}),clone,'label-save');
 await fails(assert,()=>f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{...clone.data,description:'etiqueta de produto'}}),'23505');
 const far=structuredClone(product.config);far.fields[0].x='60';
 assert.throws(()=>captureLabelSave({...clone,command_id:randomUUID(),data:{...clone.data,description:'Fora',config:far}}),/ERP_INVALID_INPUT/);
 await fails(assert,()=>f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{...clone.data,description:'Fora',config:far}}),'22023');
 const qr=structuredClone(product.config);qr.label.barcode='qrcode';
 await fails(assert,()=>f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{...clone.data,description:'QR',config:qr}}),'22023');
 const id=created.receipt.target,custom=parseLabels(await f.rpc('erp_preferences_labels',{p_user_id:f.users.admin})).items.find(t=>t.id===id);assert.deepEqual([custom.default,custom.version],[false,1]);
 const moved=structuredClone(custom.config);moved.fields[1].y='10.5';moved.page={...moved.page,size:'custom',width:'100',height:'150'};
 await f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:id,p_expected_version:1,p_data:{type:'produto',description:'Gôndola',config:moved}});
 await fails(assert,()=>f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:id,p_expected_version:2,p_data:{type:'contato',description:'Gôndola',config:moved}}),'22023');
 await fails(assert,()=>remove(f,'labels',{command_id:randomUUID(),items:[{id,expected_version:1}]}),'40001');await remove(f,'labels',{command_id:randomUUID(),items:[{id,expected_version:2}]});
 assert.equal(parseLabels(await f.rpc('erp_preferences_labels',{p_user_id:f.users.admin})).items.length,5);
 // Records to print, by search and by the module rule of the role.
 const q=captureLabelRecordsQuery({tipo:'produto',busca:'can'}),records=parseLabelRecords(await f.rpc('erp_preferences_label_records',{p_user_id:f.users.estoque,p_type:q.type,p_query:q.q}),q);
 assert.deepEqual(records.items.map(i=>[i.id,i.values.codigo,i.values.gtin]),[[p.id,'CAN-1','7891234567895']]);
 const orders=captureLabelRecordsQuery({tipo:'pedido_venda'}),sales=parseLabelRecords(await f.rpc('erp_preferences_label_records',{p_user_id:f.users.fiscal,p_type:'pedido_venda',p_query:null}),orders);
 assert.deepEqual(sales.items.map(i=>[i.values.numero,i.values.cliente,i.values.cidade_uf]),[['1','Ana Sintética','Campinas/SP'],['2','Bia Sintética','Santos/SP'],['3','Ana Sintética','Campinas/SP']]);
 await fails(assert,()=>f.rpc('erp_preferences_label_records',{p_user_id:f.users.estoque,p_type:'ordem_servico',p_query:null}),'42501');
 await fails(assert,()=>f.rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:'nota_fiscal',p_query:null}),'22023');
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_preferences_report_run(uuid,text,jsonb,jsonb,integer,integer,integer)','execute') v`),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_preferences.report_source(text)','execute') v"),false);
}finally{await f.close();}});

test('149 review: a report user who lost access never locks the report; adding someone without access is still refused',async()=>{const f=await systemFixture();try{
 const save=(id,version,data)=>f.rpc('erp_preferences_report_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_report:id,p_expected_version:version,p_data:data});
 const data={base:'vendas',title:'Relatório sintético',columns:['numero','total'],filters:[],view_limit:10,with_totals:false,users:[f.users.vendas,f.users.financeiro].sort()};
 const id=(await save(null,0,data)).receipt.target;
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.vendas]);
 assert.equal((await save(id,1,{...data,title:'Relatório sintético 2'})).replayed,false,'other fields still change');
 await fails(assert,()=>save(id,2,{...data,users:[...data.users,f.users.inactive].sort()}),'22023');
 await save(id,2,{...data,users:[f.users.financeiro]});
 const list=await f.rpc('erp_preferences_reports',{p_user_id:f.users.admin});assert.deepEqual(list.reports.find(r=>r.id===id).users,[f.users.financeiro]);
 // A new report refuses users without access, as before.
 await fails(assert,()=>save(null,0,{...data,title:'Outro',users:[f.users.vendas]}),'22023');
}finally{await f.close();}});
