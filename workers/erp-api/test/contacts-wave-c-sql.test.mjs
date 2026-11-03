import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CONTACT_LANE,contactsFixture,fails} from './helpers/contacts-fixture.mjs';
import {LABEL_DEFAULTS,labelConfigValid} from '../../../packages/erp-domain/src/reports-labels.mjs';

// Migration 202610200158 (contatos lane, wave C) over the published migrations, the contact lane (124-128) and the
// label models of Preferências (148-149). Synthetic data only.
export const WAVE_C_LANE=[...CONTACT_LANE,'202610200148_system_frameworks.sql','202610200149_custom_reports_labels.sql','202610200158_contact_pickers_labels.sql'];
const PUBLIC=['erp_catalog_contact_options','erp_catalog_contact_summary','erp_catalog_contact_history','erp_catalog_contact_labels'];
const SETTINGS={user_id:null,allow_unregistered_products:false,view_stock:false,access_hours_enabled:false,access_windows:[],modules:{},commission_rule:'parcial',commission_mode:'fixa',
 commission_rate:null,commission_bands:[],discount_limit:'0',notes:null};
const names=result=>result.items.map(item=>item.name);

test('contatos lane SQL (158): pickers by role, summary, history, labels and seller access hours',async t=>{
 const f=await contactsFixture({lane:WAVE_C_LANE});
 const rpc=(name,args)=>f.rpc(name,args);
 const options=(args={},user=f.users.admin)=>rpc('erp_catalog_contact_options',{p_user_id:user,...args});
 try{
  await t.test('new RPCs are service-only SECURITY DEFINER with a fixed search_path; the helpers stay private',async()=>{
   const rs=await f.rows(`select p.proname,n.nspname,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE') service,
     has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('public',p.oid,'EXECUTE') everyone
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname='public' and p.proname=any($1)) or(n.nspname='erp_catalog' and p.proname in('contact_option_item','contact_label_values','seller_access_allowed'))`,[PUBLIC]);
   assert.equal(rs.length,PUBLIC.length+3);
   for(const r of rs){
    assert.deepEqual(r.proconfig,['search_path=pg_catalog'],r.proname);
    assert.equal(r.anon,false,r.proname);assert.equal(r.authenticated,false,r.proname);assert.equal(r.everyone,false,r.proname);
    assert.equal(r.service,r.nspname==='public',r.proname);assert.equal(r.prosecdef,r.nspname==='public',r.proname);
   }
   // The earlier public contact RPCs keep their grants after this migration's revoke of the private helpers.
   assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_catalog_contact_page(uuid,integer,integer,text,text,text,text,text,text,text,text,text,uuid,text,date,date,text[])','EXECUTE') v"),true);
  });

  const ids={};
  await t.test('picker: active contacts only, by role, the listing search and the city; bounded; seller scope applies',async()=>{
   ids.client=(await f.save({name:'Ana Cliente Sintética',types:['customer'],document:'52998224725',person_type:'F',city:'Piracicaba',phone:'(19) 3434-1000',notes:'Entregar só pela manhã.'})).record;
   ids.supplier=(await f.save({name:'Bia Fornecedora Sintética',types:['supplier'],trade_name:'Bia Peças',city:'São Carlos',email:'bia@sintetico.test'})).record;
   ids.both=(await f.save({name:'Caio Cliente e Fornecedor',types:['customer','supplier','carrier'],city:'Campinas'})).record;
   ids.inactive=(await f.save({name:'Dora Fornecedora Inativa',types:['supplier'],situation:'I'})).record;
   ids.idle=(await f.save({name:'Eva Fornecedora Sem Movimento',types:['supplier'],situation:'S'})).record;
   assert.deepEqual(names(await options({p_role:'supplier'})),['Bia Fornecedora Sintética','Caio Cliente e Fornecedor','Eva Fornecedora Sem Movimento'],'Inativo never; Sem movimento is active');
   assert.deepEqual(names(await options({p_role:'customer'})),['Ana Cliente Sintética','Caio Cliente e Fornecedor']);
   assert.deepEqual(names(await options({p_role:'carrier'})),['Caio Cliente e Fornecedor']);
   assert.deepEqual(names(await options({p_query:'bia peças'})),['Bia Fornecedora Sintética'],'Fantasia, accents folded');
   assert.deepEqual(names(await options({p_query:'529.982.247-25'})),['Ana Cliente Sintética'],'CPF with mask');
   assert.deepEqual(names(await options({p_query:'34341000'})),['Ana Cliente Sintética'],'phone digits');
   assert.deepEqual(names(await options({p_city:'sao carlos'})),['Bia Fornecedora Sintética'],'Cidade of the advanced search');
   const page=await options({p_role:'supplier',p_limit:2});
   assert.deepEqual([page.items.length,page.has_more,page.limit,page.role,page.scoped,page.scope],[2,true,2,'supplier',false,'contact_options']);
   const item=(await options({p_query:'Ana Cliente'})).items[0];
   assert.deepEqual(Object.keys(item).sort(),['active','city','code','complement','created_at','district','document','email','entity','has_notes','id','ie','mobile','name','number','person_type',
    'persons','phone','postal_code','roles','situation','source','state','street','trade_name','types','updated_at','version'].sort());
   assert.deepEqual([item.situation,item.has_notes,item.persons,item.roles,item.types],['A',true,0,['customer'],['customer']]);
   for(const args of[{p_limit:0},{p_limit:51},{p_role:'seller'},{p_query:'x'.repeat(121)},{p_query:'a\u0001'},{p_city:'c'.repeat(101)}])await fails(assert,options(args),'22023');
   await fails(assert,options({},f.users.inactive),'42501');
   // "Contato acessível somente ao vendedor vinculado": the picker only offers the seller's contacts to that seller's user.
   const seller=await rpc('erp_catalog_seller_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_contact_expected_version:0,p_command_id:randomUUID(),
    p_contact:{name:'Vendedora Sintética'},p_settings:{...SETTINGS,user_id:f.users.vendas}});
   ids.seller=seller.seller.id;
   const linked=await rpc('erp_catalog_contact_set_seller',{p_user_id:f.users.admin,p_id:ids.client.id,p_expected_version:ids.client.version,p_command_id:randomUUID(),p_seller_id:ids.seller});
   ids.client=linked.record;
   await f.preference('contatos.acesso_vendedor',true);
   try{
    const scoped=await options({},f.users.vendas);
    assert.deepEqual([names(scoped),scoped.scoped],[['Ana Cliente Sintética'],true]);
    assert.equal((await options({p_role:'supplier'},f.users.vendas)).items.length,0);
    assert.ok((await options({},f.users.admin)).items.length>2,'the administrator sees every contact');
   }finally{await f.preference('contatos.acesso_vendedor',false);}
  });

  await t.test('summary: observações, pessoas de contato with their phones, hidden outside the seller scope',async()=>{
   const company=(await f.save({name:'Empresa Sintética Ltda',types:['customer'],notes:'Cliente pede nota com pedido de compra.',contact_info:'Ramal 20',persons:[ids.client.id,ids.supplier.id]})).record;
   const summary=await rpc('erp_catalog_contact_summary',{p_user_id:f.users.consulta,p_id:company.id});
   assert.deepEqual([summary.scope,summary.name,summary.notes,summary.contact_info,summary.situation],['contact_summary','Empresa Sintética Ltda','Cliente pede nota com pedido de compra.','Ramal 20','A']);
   assert.deepEqual(summary.persons.map(p=>[p.name,p.visible,p.phone,p.email]),[['Ana Cliente Sintética',true,'(19) 3434-1000',null],['Bia Fornecedora Sintética',true,null,'bia@sintetico.test']]);
   const linked=await rpc('erp_catalog_contact_set_seller',{p_user_id:f.users.admin,p_id:company.id,p_expected_version:company.version,p_command_id:randomUUID(),p_seller_id:ids.seller});
   await f.preference('contatos.acesso_vendedor',true);
   try{
    const scoped=await rpc('erp_catalog_contact_summary',{p_user_id:f.users.vendas,p_id:linked.record.id});
    assert.deepEqual(scoped.persons.map(p=>[p.name,p.visible,p.phone,p.email,p.mobile]),[['Ana Cliente Sintética',true,'(19) 3434-1000',null,null],['Bia Fornecedora Sintética',false,null,null,null]]);
    await fails(assert,rpc('erp_catalog_contact_summary',{p_user_id:f.users.vendas,p_id:ids.supplier.id}),'42501');
   }finally{await f.preference('contatos.acesso_vendedor',false);}
   await fails(assert,rpc('erp_catalog_contact_summary',{p_user_id:f.users.admin,p_id:randomUUID()}),'P0002');
   await fails(assert,rpc('erp_catalog_contact_summary',{p_user_id:f.users.inactive,p_id:company.id}),'42501');
  });

  await t.test('history: pedidos de venda of the customer and pedidos de compra of the supplier, only for who reads them',async()=>{
   const product=(await rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto sintético',unit:'UN',kind:'P',format:'S',price:'1'}})).record;
   const save=(kind,contact,date)=>rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),
    p_body:{date,contact_id:contact,items:[{product_id:product.id,description:'Produto sintético',unit:'UN',quantity:'2',unit_price:'10.5'}]}});
   await save('purchase_orders',ids.supplier.id,'2026-10-01');await save('purchase_orders',ids.supplier.id,'2026-10-15');await save('sales_orders',ids.supplier.id,'2026-10-05');
   const history=await rpc('erp_catalog_contact_history',{p_user_id:f.users.estoque,p_contact_id:ids.supplier.id,p_kind:'purchase_orders'});
   assert.deepEqual([history.scope,history.kind,history.visible,history.items.map(i=>[i.date,i.total])],['contact_history','purchase_orders',true,[['2026-10-15','21.00'],['2026-10-01','21.00']]]);
   assert.equal((await rpc('erp_catalog_contact_history',{p_user_id:f.users.admin,p_contact_id:ids.supplier.id,p_kind:'sales_orders'})).items.length,1);
   const hidden=await rpc('erp_catalog_contact_history',{p_user_id:f.users.vendas,p_contact_id:ids.supplier.id,p_kind:'purchase_orders'});
   assert.deepEqual([hidden.visible,hidden.items],[false,[]],'vendas does not read pedidos de compra');
   await fails(assert,rpc('erp_catalog_contact_history',{p_user_id:f.users.admin,p_contact_id:ids.supplier.id,p_kind:'service_orders'}),'22023');
   await fails(assert,rpc('erp_catalog_contact_history',{p_user_id:f.users.admin,p_contact_id:randomUUID(),p_kind:'sales_orders'}),'P0002');
  });

  await t.test('labels: the Contato models (Padrão and Customizadas) and the values of the selected contacts, in order, audited',async()=>{
   const address=(await f.save({name:'Flávia Endereço Sintético',street:'Rua Sintética',number:'100',complement:'Sala 2',district:'Centro',city:'Piracicaba',state:'SP',postal_code:'13400-000',
    phone:'(19) 3000-0000',document:'11.222.333/0001-81',person_type:'J',trade_name:'Flávia Ltda'})).record;
   // A custom Contato model saved by the administrator in Preferências > Etiquetas customizadas.
   const custom=structuredClone(LABEL_DEFAULTS[0].config);custom.label.width='90';
   await rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{type:'contato',description:'Envelope sintético',config:custom}});
   await rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{type:'produto',description:'Gôndola sintética',config:LABEL_DEFAULTS[1].config}});
   const result=await rpc('erp_catalog_contact_labels',{p_user_id:f.users.vendas,p_ids:`{${address.id},${ids.supplier.id}}`});
   assert.equal(result.scope,'contact_labels');
   assert.deepEqual(result.templates.map(t=>[t.id.startsWith('padrao')?t.id:'uuid',t.description,t.default,t.version]),[['padrao-contato','Etiqueta de contato',true,0],['uuid','Envelope sintético',false,1]],'Contato models only');
   assert.ok(result.templates.every(t=>t.type==='contato'&&labelConfigValid(t.type,t.config)));
   assert.deepEqual(result.items.map(i=>i.id),[address.id,ids.supplier.id],'the order of the selection');
   assert.deepEqual(result.items[0].values,{nome:'Flávia Endereço Sintético',fantasia:'Flávia Ltda',documento:'11.222.333/0001-81',endereco:'Rua Sintética, 100 - Sala 2',bairro:'Centro',
    cidade_uf:'Piracicaba/SP',cep:'13400-000',telefone:'(19) 3000-0000'});
   // Same values as the Etiquetas customizadas print of Preferências (erp_preferences_label_records).
   const records=await rpc('erp_preferences_label_records',{p_user_id:f.users.admin,p_type:'contato',p_query:'Flávia'});
   assert.deepEqual(records.items[0].values,result.items[0].values);
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.auxiliary_audit where subject='contacts_export' and action='labels' and after_data->>'total'='2'"),1);
   for(const ids2 of['{}',`{${address.id},${address.id}}`,`{${Array.from({length:101},()=>randomUUID()).join(',')}}`])await fails(assert,rpc('erp_catalog_contact_labels',{p_user_id:f.users.admin,p_ids:ids2}),'22023');
   await fails(assert,rpc('erp_catalog_contact_labels',{p_user_id:f.users.admin,p_ids:`{${randomUUID()}}`}),'P0002');
   await fails(assert,rpc('erp_catalog_contact_labels',{p_user_id:f.users.inactive,p_ids:`{${address.id}}`}),'42501');
   await f.preference('contatos.acesso_vendedor',true);
   try{
    assert.equal((await rpc('erp_catalog_contact_labels',{p_user_id:f.users.vendas,p_ids:`{${ids.client.id}}`})).items.length,1,'a contact of the seller prints');
    await fails(assert,rpc('erp_catalog_contact_labels',{p_user_id:f.users.vendas,p_ids:`{${ids.client.id},${address.id}}`}),'42501');
   }finally{await f.preference('contatos.acesso_vendedor',false);}
  });

  await t.test('seller access hours: weekday and minute in São Paulo, inclusive; unrestricted without rows or without a seller',async()=>{
   const allowed=(user,at)=>f.scalar('select erp_catalog.seller_access_allowed($1::uuid,$2::timestamptz) v',[user,at]);
   assert.equal(await allowed(f.users.vendas,'2026-10-18T03:00:00Z'),true,'seller without "Visualizar horários de acesso"');
   const current=await rpc('erp_catalog_seller_get',{p_user_id:f.users.admin,p_id:ids.seller});
   await rpc('erp_catalog_seller_save',{p_user_id:f.users.admin,p_id:ids.seller,p_expected_version:current.seller.version,p_contact_expected_version:current.contact.version,p_command_id:randomUUID(),
    p_contact:{name:'Vendedora Sintética'},p_settings:{...SETTINGS,user_id:f.users.vendas,access_hours_enabled:true,access_windows:[{start:'08:00',end:'18:00',days:[1,2,3,4,5]},{start:'09:00',end:'12:00',days:[6]}]}});
   // 2026-10-19 is a Monday; São Paulo is UTC-3.
   assert.equal(await allowed(f.users.vendas,'2026-10-19T11:00:00Z'),true,'segunda 08:00');
   assert.equal(await allowed(f.users.vendas,'2026-10-19T21:00:59Z'),true,'segunda 18:00 (fim inclusive)');
   assert.equal(await allowed(f.users.vendas,'2026-10-19T21:01:00Z'),false,'segunda 18:01');
   assert.equal(await allowed(f.users.vendas,'2026-10-19T10:59:00Z'),false,'segunda 07:59');
   assert.equal(await allowed(f.users.vendas,'2026-10-20T02:00:00Z'),false,'segunda 23:00 local, terça em UTC');
   assert.equal(await allowed(f.users.vendas,'2026-10-24T13:30:00Z'),true,'sábado 10:30');
   assert.equal(await allowed(f.users.vendas,'2026-10-25T13:30:00Z'),false,'domingo');
   assert.equal(await allowed(f.users.admin,'2026-10-25T13:30:00Z'),true,'a user that is no seller');
  });
 }finally{await f.close();}
});

// Contract check (review): the real answers of migration 158 go through the Worker routes and response checks, so a
// field the SQL returns and the Worker refuses (a 502 for every picker) cannot pass unnoticed.
test('contatos lane SQL (158) answers are accepted by the Worker routes',async()=>{
 const {contactRoute,contactOperation,contactResponse}=await import('../src/contacts.mjs');
 const f=await contactsFixture({lane:WAVE_C_LANE});
 const call=async(path,user=f.users.admin)=>{
  const url=new URL(`https://api.test${path}`),route=contactRoute(url.pathname);
  const operation=await contactOperation(new Request(url,{method:'GET'}),route,url.searchParams);
  const args={...operation.args,p_user_id:user};
  if(Array.isArray(args.p_ids))args.p_ids=`{${args.p_ids.join(',')}}`;
  return contactResponse(await f.rpc(operation.rpc,args),route,operation);
 };
 try{
  const person=(await f.save({name:'Pessoa Sintética',types:['customer'],phone:'(19) 3000-1000',email:'pessoa@sintetico.test'})).record;
  const company=(await f.save({name:'Empresa Sintética Contrato',types:['supplier'],person_type:'J',trade_name:'Contrato Ltda',document:'11.222.333/0001-81',street:'Rua Sintética',number:'7',
   city:'Piracicaba',state:'SP',postal_code:'13400-000',notes:'Linha 1\nLinha 2',contact_info:'Ramal 9',persons:[person.id]})).record;
  const legacy=(await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato antigo sem tipo',city:'Campinas'}})).record;
  const options=await call('/v1/cadastros/contatos/opcoes?limit=50');
  assert.deepEqual(options.items.map(item=>item.name).sort(),['Contato antigo sem tipo','Empresa Sintética Contrato','Pessoa Sintética']);
  assert.deepEqual(options.items.find(item=>item.id===legacy.id).roles,[],'a contact without roles (as the Origin mirror stores them) is offered without papel');
  assert.deepEqual((await call('/v1/cadastros/contatos/opcoes?papel=fornecedor&q=contrato&cidade=piracicaba')).items.map(item=>[item.name,item.has_notes,item.persons]),[['Empresa Sintética Contrato',true,1]]);
  const summary=await call(`/v1/cadastros/contatos/${company.id}/resumo`);
  assert.deepEqual([summary.notes,summary.contact_info,summary.persons.map(p=>[p.name,p.phone,p.email])],['Linha 1\nLinha 2','Ramal 9',[['Pessoa Sintética','(19) 3000-1000','pessoa@sintetico.test']]]);
  const history=await call(`/v1/cadastros/contatos/${company.id}/historico?tipo=pedidos-compra`,f.users.estoque);
  assert.deepEqual([history.kind,history.visible,history.items],['purchase_orders',true,[]]);
  await f.rpc('erp_preferences_label_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:null,p_expected_version:0,p_data:{type:'contato',description:'Modelo contrato',config:LABEL_DEFAULTS[0].config}});
  const labels=await call(`/v1/cadastros/contatos/etiquetas?ids=${company.id},${legacy.id}`);
  assert.deepEqual([labels.templates.map(t=>t.description),labels.items.map(i=>i.values.nome)],[['Etiqueta de contato','Modelo contrato'],['Empresa Sintética Contrato','Contato antigo sem tipo']]);
 }finally{await f.close();}
});
