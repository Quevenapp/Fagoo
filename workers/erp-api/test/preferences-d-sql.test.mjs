import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneDFixture,fails}from'./helpers/preferences-d-fixture.mjs';
import{REPORT_BASES,sameJson,parseReports,captureReportRun,parseReportRows,parseLabelRecords,captureLabelRecordsQuery,parseLabelInvoiceProducts,captureLabelInvoiceQuery}from'../../../packages/erp-domain/src/reports-labels.mjs';

// Wave D of Preferências, Sistema and Meu Negócio: migration 230 (situações, relatórios, etiquetas and Atividade da Carteira). Synthetic data only.
async function invoiceSetup(f){
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict(singleton) do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict(singleton) do nothing",[f.users.admin]);
 const nature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Venda sintética',direction:'1',crt:'1',presence:'1'}}})).nature;
 const product=await f.catalog('products',{name:'Peça sintética',code:'P-1',unit:'UN',kind:'P',format:'S',price:'50',ncm:'84713012',gtin:'7891234567895'});
 const contact=await f.catalog('contacts',{name:'Cliente Sintético',document:'11222333000181'});
 const item=(over={})=>({product_id:product.id,description:'Peça sintética',code:'P-1',unit:'UN',quantity:'2.5',unit_price:'40',ncm:'84713012',cfop:'5102',icms:{origin:'0',situation:'102'},...over});
 const invoice=(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{model:'55',direction:'1',issue_type:'N',series:'1',nature_id:nature.id,
  issue_date:'2026-10-20',crt:'1',purpose:'1',presence:'1',final_consumer:false,recipient:{contact_id:contact.id,name:'Cliente Sintético',person_type:'J',document:'11222333000181',state:'SP',city:'Campinas',street:'Rua Sintética',number:'10'},
  items:[item(),item({product_id:undefined,code:'AV-1',description:'Item avulso',quantity:'1',unit_price:'20'})]}}})).invoice;
 return{product,contact,invoice};
}

test('230 replaces only the 148, 149 and 150 versions; another one stops the migration',async()=>{const f=await laneDFixture({before:'202610200230'});try{
 await f.db.exec("create or replace function erp_preferences.situation_base_color(p_status text) returns text language sql immutable set search_path=pg_catalog as $$ select '#000000' $$");
 await assert.rejects(()=>f.migrate('202610200230_situations_reports_labels.sql'),e=>e.code==='55000'&&/preferences_230_previous_definition_changed erp_preferences.situation_base_color/.test(e.message));
}finally{await f.close();}});

test('230 PRF-233/VND-079 Venda Agenciada and Faturado parcialmente have the Origin names and colors; the bases still come from the documents rules',async()=>{const f=await laneDFixture();try{
 assert.equal(await f.scalar("select erp_preferences.situation_base_label('sales_orders','agency_sale') v"),'Venda Agenciada');
 assert.equal(await f.scalar("select erp_preferences.situation_base_label('sales_orders','partially_invoiced') v"),'Faturado parcialmente');
 assert.equal(await f.scalar("select erp_preferences.situation_base_color('agency_sale') v"),'#ff7835');assert.equal(await f.scalar("select erp_preferences.situation_base_color('partially_invoiced') v"),'#b83147');
 const bases=(await f.db.query("select status,label from erp_preferences.situation_bases('sales_orders') order by ordinal,status")).rows;
 assert.deepEqual(bases.map(b=>b.status).sort(),Object.keys(await f.scalar("select erp_documents.transitions()->'sales_orders' v")).sort(),'only the situations the documents module has');
 const page=await f.rpc('erp_preferences_situations',{p_user_id:f.users.admin,p_kind:'sales_orders'});assert.ok(page.situations.some(s=>s.key==='open'&&s.name==='Em aberto'));
}finally{await f.close();}});

test('230 PRF-241 Relatórios customizados: NF-e de saída, NF-e de entrada and NFC-e of Brufap, for the readers of the notes',async()=>{const f=await laneDFixture();try{
 // The catalog of 230 (264 adds the finance and Venda Parcela bases).
 assert.ok(sameJson(await f.scalar('select erp_preferences.report_catalog() v'),JSON.parse(JSON.stringify(REPORT_BASES.slice(0,11)))));
 const{invoice}=await invoiceSetup(f);
 const list=async user=>parseReports(await f.rpc('erp_preferences_reports',{p_user_id:user}));
 assert.deepEqual((await list(f.users.fiscal)).bases.map(b=>b.base).filter(b=>/notas|nfce/.test(b)),['notas_saida','notas_entrada','nfce']);
 assert.deepEqual((await list(f.users.vendas)).bases.map(b=>b.base).filter(b=>/notas|nfce/.test(b)),[]);
 const q=captureReportRun({base:'notas_saida',columns:['numero','serie','emissao','contato','documento','uf','natureza','situacao','total','chave'],filters:[],view_limit:2000,offset:0,page:20});
 const run=user=>f.rpc('erp_preferences_report_run',{p_user_id:user,p_base:q.base,p_columns:q.columns,p_filters:q.filters,p_view_limit:q.view_limit,p_offset:q.offset,p_page:q.page});
 const rows=parseReportRows(await run(f.users.consulta),q);
 assert.deepEqual(rows.rows,[[null,'1','2026-10-20','Cliente Sintético','11222333000181','SP','Venda sintética','Pendente','120.00',null]]);assert.equal(rows.totals.total,'120.00');
 await fails(assert,()=>run(f.users.vendas),'42501');
 const filtered=parseReportRows(await f.rpc('erp_preferences_report_run',{p_user_id:f.users.admin,p_base:'notas_entrada',p_columns:['numero'],p_filters:[],p_view_limit:10,p_offset:0,p_page:20}),
  captureReportRun({base:'notas_entrada',columns:['numero'],filters:[],view_limit:10,offset:0,page:20}));assert.deepEqual(filtered.rows,[]);
 // A deleted note leaves the report.
 await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'delete',p_data:{id:invoice.id,expected_version:invoice.version,reason:'Exclusão sintética'}});
 assert.deepEqual(parseReportRows(await run(f.users.admin),q).rows,[]);
}finally{await f.close();}});

test('230 NFE-052 Etiquetas customizadas print the Nota Fiscal records and the products of a note with their quantities',async()=>{const f=await laneDFixture();try{
 const{invoice,product}=await invoiceSetup(f);
 const q=captureLabelRecordsQuery({tipo:'nota_fiscal',busca:'sintético'}),records=parseLabelRecords(await f.rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:'nota_fiscal',p_query:q.q}),q);
 assert.deepEqual(records.items.map(i=>[i.id,i.values.cliente,i.values.serie,i.values.endereco_cliente,i.values.cidade_uf]),[[invoice.id,'Cliente Sintético','1','Rua Sintética, 10','Campinas/SP']]);
 await fails(assert,()=>f.rpc('erp_preferences_label_records',{p_user_id:f.users.vendas,p_type:'nota_fiscal',p_query:null}),'42501');
 // Regression: 185 retired erp_preferences.tag_query and the search of every type failed; it searches again, with and without text.
 for(const[type,query]of[['produto','peça'],['produto',null],['contato','sintético'],['pedido_venda',null]])
  assert.ok(Array.isArray((await f.rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:type,p_query:query})).items),`${type} ${query}`);
 assert.equal((await f.rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:'produto',p_query:'peça'})).items[0].values.codigo,'P-1');
 await fails(assert,()=>f.rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:'produto',p_query:' x'}),'22023');
 for(const literal of['%','_'])assert.equal((await f.rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:'produto',p_query:literal})).items.length,0,'LIKE wildcards are literal');
 const iq=captureLabelInvoiceQuery({id:invoice.id}),labels=parseLabelInvoiceProducts(await f.rpc('erp_preferences_label_invoice_products',{p_user_id:f.users.admin,p_invoice_id:invoice.id}),iq);
 assert.deepEqual(labels.items.map(i=>[i.position,i.product_id,i.quantity,i.values.codigo,i.values.descricao,i.values.gtin]),[[1,product.id,'2.5','P-1','Peça sintética','7891234567895'],[2,null,'1','AV-1','Item avulso',null]]);
 assert.equal(Number(labels.items[0].values.preco),50,'the product price of the cadastro');assert.equal(Number(labels.items[1].values.preco),20,'without a product, the price of the note');
 await fails(assert,()=>f.rpc('erp_preferences_label_invoice_products',{p_user_id:f.users.estoque,p_invoice_id:invoice.id}),'42501');
 await fails(assert,()=>f.rpc('erp_preferences_label_invoice_products',{p_user_id:f.users.admin,p_invoice_id:randomUUID()}),'P0002');
 assert.equal(await f.scalar("select has_function_privilege('authenticated','public.erp_preferences_label_invoice_products(uuid,uuid)','execute') v"),false);
}finally{await f.close();}});

test('230 PRF-274 Atividade da Carteira finds the customers by the tags of Contatos (or part of the name)',async()=>{const f=await laneDFixture();try{
 const ana=await f.catalog('contacts',{name:'Ana Sintética'}),bia=await f.catalog('contacts',{name:'Bia Sintética'});
 const tag=randomUUID();await f.db.query("insert into erp_catalog.taxonomy(id,kind,name,tag_type,created_by,updated_by) values($1,'tags','Atacado','contacts',$2,$2)",[tag,f.users.admin]);
 await f.db.query("insert into erp_catalog.contact_tag(record_id,tag_id) values($1,$2)",[ana.id,tag]);
 const product=await f.catalog('products',{name:'Peça',code:'P-1',unit:'UN',kind:'P',format:'S',price:'10'});
 for(const c of[ana,bia])await f.document('sales_orders',{contact:c.id,items:[{product_id:product.id,description:'Peça',quantity:'1',unit_price:'10'}],date:'2026-10-10',statuses:['verified']});
 const run=keywords=>f.rpc('erp_home_business_portfolio',{p_user_id:f.users.admin,p_from:'2026-10-01',p_to:'2026-10-20',p_brand:null,p_min_days:null,p_keywords:keywords});
 assert.deepEqual((await run(['atacado'])).customers.map(c=>c.name),['Ana Sintética'],'the tag, accents and case ignored');
 assert.deepEqual((await run(['Bia'])).customers.map(c=>c.name),['Bia Sintética'],'part of the name still works');
 assert.equal((await run([])).customers.length,2);assert.equal((await run(['Varejo'])).customers.length,0);
}finally{await f.close();}});

import{parseLabels,captureLabelSave,parseFrameworkResult}from'../../../packages/erp-domain/src/reports-labels.mjs';
test('231 PRF-244 label models save UPC-E, C93 and QR CODE; DATA MATRIX, PDF417 and EBCT stay refused; another label_check stops the migration',async()=>{
 const f=await laneDFixture();try{
  const product=parseLabels(await f.rpc('erp_preferences_labels',{p_user_id:f.users.admin})).items.find(t=>t.id==='padrao-produto');
  for(const code of['upce','c93','qr']){const config=structuredClone(product.config);config.label.barcode=code;
   const body=captureLabelSave({command_id:randomUUID(),id:null,expected_version:0,data:{type:'produto',description:`Etiqueta ${code}`,config}});
   parseFrameworkResult(await f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:body.command_id,p_label:null,p_expected_version:0,p_data:body.data}),body,'label-save');}
  const saved=parseLabels(await f.rpc('erp_preferences_labels',{p_user_id:f.users.admin})).items.filter(t=>t.description.startsWith('Etiqueta ')&&!t.id.startsWith('padrao'));
  assert.deepEqual(saved.map(t=>t.config.label.barcode).sort(),['c93','qr','upce']);
  // 283 (wave F) adds DATA MATRIX to the contract; the wave D database still refuses it (the database comes before the API).
  for(const code of['datamatrix','DATA MATRIX','pdf417','ebct']){const config=structuredClone(product.config);config.label.barcode=code;
   if(code!=='datamatrix')assert.throws(()=>captureLabelSave({command_id:randomUUID(),id:null,expected_version:0,data:{type:'produto',description:'Recusada',config}}));
   await fails(assert,()=>f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{type:'produto',description:'Recusada',config}}),'22023');}
 }finally{await f.close();}
 const g=await laneDFixture({before:'202610200231'});try{
  const def=await g.scalar("select pg_get_functiondef('erp_preferences.label_check(text,jsonb)'::regprocedure) v");
  await g.db.exec(def.replace(/\$function\$\n/,'$function$\n-- changed elsewhere\n'));
  await fails(assert,()=>g.migrate('202610200231_label_barcodes.sql'),'55000');
 }finally{await g.close();}
});
