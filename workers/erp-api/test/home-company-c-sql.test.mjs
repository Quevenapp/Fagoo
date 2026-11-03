import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneCFixture,fails}from'./helpers/preferences-c-fixture.mjs';
import{parseHomeCharts,parseHomeChartsResult,captureHomeChartsSave,captureTopProductsQuery,parseTopProducts,parseCompanyPartners,parseCompanyPartnersResult,captureCompanyPartnersSave}from'../../../packages/erp-domain/src/system-profile.mjs';
import{homeShortcutsResponse,homeShortcutBase}from'../src/home.mjs';

// 189 (not applied yet): home charts, named favorites, Dados do sócio(s) and the reason to correct the locked company data, on
// every migration applied in production plus wave C. Synthetic data only.
const charts=async(f,user,body)=>{const sent=captureHomeChartsSave(body);return parseHomeChartsResult(await f.rpc('erp_home_charts_save',{p_user_id:user,p_command_id:sent.command_id,p_expected_version:sent.expected_version,p_charts:sent.charts}),sent);};

test('189 home charts: Origin defaults, per user list with CAS and replay, Top 5 only for readers of sales orders and products, audited',async()=>{const f=await laneCFixture();try{
 const start=parseHomeCharts(await f.rpc('erp_home_charts_get',{p_user_id:f.users.vendas}));
 assert.deepEqual([start.version,start.customized,start.charts],[0,false,['resumo','ticket_medio','valor_faturado','quantidade_pedidos','top_skus']]);
 const finance=parseHomeCharts(await f.rpc('erp_home_charts_get',{p_user_id:f.users.financeiro}));assert.deepEqual(finance.available,['resumo','ticket_medio','valor_faturado','quantidade_pedidos']);
 const body={command_id:randomUUID(),expected_version:0,charts:['top_skus','resumo']};
 const saved=await charts(f,f.users.vendas,body);assert.deepEqual([saved.version,saved.charts,saved.replayed],[1,['top_skus','resumo'],false]);
 assert.equal((await charts(f,f.users.vendas,body)).replayed,true);
 await fails(assert,()=>charts(f,f.users.vendas,{command_id:randomUUID(),expected_version:0,charts:['resumo']}),'40001');
 await fails(assert,()=>charts(f,f.users.financeiro,{command_id:randomUUID(),expected_version:0,charts:['top_skus']}),'42501');
 await fails(assert,()=>f.rpc('erp_home_charts_save',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_expected_version:1,p_charts:['resumo','resumo']}),'22023');
 await fails(assert,()=>f.rpc('erp_home_charts_save',{p_user_id:f.users.inactive,p_command_id:randomUUID(),p_expected_version:0,p_charts:[]}),'42501');
 // Another user keeps the defaults; the audit is the one of the favorites (Registro de atividades: Página inicial).
 assert.equal(parseHomeCharts(await f.rpc('erp_home_charts_get',{p_user_id:f.users.admin})).version,0);
 assert.deepEqual((await f.db.query("select after_data->'charts' v from erp_home.shortcut_audit where after_data?'charts'")).rows.map(r=>r.v),[['top_skus','resumo']]);
 const{captureActivityQuery,parseActivity}=await import('../../../packages/erp-domain/src/activity.mjs');
 const day=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v"),q=captureActivityQuery({from:day,to:day,module:'pagina_inicial'});
 assert.deepEqual(parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:null,p_actor:null,p_query:null,p_limit:q.limit,p_offset:q.offset}),q).items.map(e=>e.description),['Gráficos da página inicial']);
}finally{await f.close();}});

test('189 Top 5 SKUs of the home period: by quantity, cancelled orders out, period rules of the overview',async()=>{const f=await laneCFixture();try{
 const a=await f.catalog('contacts',{name:'Cliente Top'});const day=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const products=[];for(const [name,code] of[['Caneta','CAN'],['Lápis','LAP'],['Borracha','BOR'],['Régua','REG'],['Cola','COL'],['Tesoura','TES']])products.push(await f.catalog('products',{name,code,unit:'UN',kind:'P',format:'S',price:'1'}));
 await f.document('sales_orders',{contact:a.id,date:day,items:products.map((p,i)=>({product_id:p.id,description:p.name,quantity:String(i+1),unit_price:'2'}))});
 await f.document('sales_orders',{contact:a.id,date:day,statuses:['cancelled'],items:[{product_id:products[0].id,description:'Caneta',quantity:'100',unit_price:'1'}]});
 const q=captureTopProductsQuery({periodo:'hoje'}),v=parseTopProducts(await f.rpc('erp_home_top_products',{p_user_id:f.users.vendas,p_period:q.key,p_from:q.from,p_to:q.to}),q);
 assert.deepEqual(v.items.map(p=>[p.code,p.units,p.total_cents]),[['TES','6.000000','1200'],['COL','5.000000','1000'],['REG','4.000000','800'],['BOR','3.000000','600'],['LAP','2.000000','400']]);
 assert.deepEqual([v.from,v.to],[day,day]);
 await fails(assert,()=>f.rpc('erp_home_top_products',{p_user_id:f.users.financeiro,p_period:'hoje',p_from:null,p_to:null}),'42501');
 assert.equal((await f.rpc('erp_home_top_products',{p_user_id:f.users.estoque,p_period:'hoje',p_from:null,p_to:null})).items.length,5,'estoque reads sales orders and products');
 for(const[p,from,to]of[['7D',null,null],['hoje','2026-10-01',null],['customizado','2026-10-02','2026-10-01'],['customizado','2025-01-01','2026-10-01']])
  await fails(assert,()=>f.rpc('erp_home_top_products',{p_user_id:f.users.admin,p_period:p,p_from:from,p_to:to}),'22023');
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_home_top_products(uuid,text,text,text)','execute') v`),false);
}finally{await f.close();}});

test('189 favorites with Nome and Link: a menu screen with more filters, named; unknown screens, repeated keys and other roles refused',async()=>{const f=await laneCFixture();try{
 // The worker shortcut list follows the current menu, generated into 305 (wave G, after 286 and 266, which accepts the 190 version too):
 // apply them so the catalogs match (deploy order DB -> API).
 await f.migrate('202610200266_home_shortcut_catalog.sql');await f.migrate('202610200286_home_shortcut_catalog.sql');await f.migrate('202610200305_home_shortcut_catalog.sql');
 const link='/documentos-empresa?tipo=sales_orders&situacao=open';assert.equal(homeShortcutBase(link),'/documentos-empresa?tipo=sales_orders');
 assert.equal(await f.scalar('select erp_home.shortcut_base($1) v',[link]),'/documentos-empresa?tipo=sales_orders');
 for(const bad of['/documentos-empresa?tipo=sales_orders&tipo=purchase_orders','/documentos-empresa?tipo=sales_orders&x=<script>','/inexistente?x=1','/estoque-empresa?a=1&a=2'])
  {assert.equal(await f.scalar('select erp_home.shortcut_base($1) v',[bad]),null,bad);assert.equal(homeShortcutBase(bad),null,bad);}
 const operation={type:'save',args:{p_expected_version:0,p_shortcuts:['/estoque-empresa',link],p_labels:{[link]:'Vendas em aberto'}}};
 const saved=await f.rpc('erp_home_shortcuts_save',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_expected_version:0,p_shortcuts:['/estoque-empresa',link],p_labels:{[link]:'Vendas em aberto'}});
 assert.deepEqual(homeShortcutsResponse(saved,operation).labels,{[link]:'Vendas em aberto'});
 const read=homeShortcutsResponse(await f.rpc('erp_home_shortcuts_get',{p_user_id:f.users.vendas}),{type:'get'});
 assert.deepEqual([read.shortcuts,read.labels],[['/estoque-empresa',link],{[link]:'Vendas em aberto'}]);
 // Without names the command is the one of 097: the worker sends no p_labels.
 const plain=await f.rpc('erp_home_shortcuts_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:0,p_shortcuts:['/estoque-empresa']});assert.deepEqual(plain.labels,{});
 await fails(assert,()=>f.rpc('erp_home_shortcuts_save',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_expected_version:1,p_shortcuts:[link],p_labels:{'/estoque-empresa':'Fora da lista'}}),'22023');
 await fails(assert,()=>f.rpc('erp_home_shortcuts_save',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_expected_version:1,p_shortcuts:[link],p_labels:{[link]:' x'}}),'22023');
 await fails(assert,()=>f.rpc('erp_home_shortcuts_save',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_expected_version:0,p_shortcuts:['/estoque-empresa?produto=1']}),'42501');
 // A role that loses the screen no longer sees the favorite nor its name.
 await f.rpc('erp_home_shortcuts_save',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_expected_version:0,p_shortcuts:['/estoque-empresa?deposito=principal'],p_labels:{'/estoque-empresa?deposito=principal':'Depósito principal'}});
 await f.db.query("update erp_access.membership set role='financeiro' where user_id=$1",[f.users.estoque]);
 const hidden=await f.rpc('erp_home_shortcuts_get',{p_user_id:f.users.estoque});assert.deepEqual([hidden.shortcuts,hidden.labels],[[],{}]);
 assert.deepEqual((await f.db.query("select after_data->'labels' v from erp_home.shortcut_audit where after_data->'labels'<>'{}'::jsonb order by id")).rows.map(r=>r.v),[{[link]:'Vendas em aberto'},{'/estoque-empresa?deposito=principal':'Depósito principal'}]);
}finally{await f.close();}});

test('189 Dados do sócio(s): administrador only, CPF valid and once, up to 100% in total, CAS, replay and audit',async()=>{const f=await laneCFixture();try{
 const save=async(body,user=f.users.admin)=>{const sent=captureCompanyPartnersSave(body);return parseCompanyPartnersResult(await f.rpc('erp_company_partners_save',{p_user_id:user,p_command_id:sent.command_id,p_expected_version:sent.expected_version,p_partners:sent.partners}),sent);};
 assert.equal(parseCompanyPartners(await f.rpc('erp_company_partners_get',{p_user_id:f.users.admin})).record,null);
 await fails(assert,()=>f.rpc('erp_company_partners_get',{p_user_id:f.users.fiscal}),'42501');
 const body={command_id:randomUUID(),expected_version:0,partners:[{name:'Ana Sintética',cpf:'529.982.247-25',share:'60',role:'Sócia administradora',email:'ANA@SINTETICO.TEST',phone:'(11) 99999-0000'},{name:'Beto Sintético',cpf:'11144477735',share:'40.5',role:null,email:null,phone:null}]};
 assert.throws(()=>captureCompanyPartnersSave(body));// 100.5% in total: refused by the contract and by the SQL
 await fails(assert,()=>f.rpc('erp_company_partners_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:0,p_partners:body.partners}),'22023');
 body.partners[1].share='40';const saved=await save(body);
 assert.deepEqual(saved.record.partners.map(p=>[p.cpf,p.share,p.email]),[['52998224725','60.00','ana@sintetico.test'],['11144477735','40.00',null]]);
 assert.equal((await save(body)).replayed,true);
 await fails(assert,()=>save({command_id:randomUUID(),expected_version:0,partners:[]}),'40001');
 await fails(assert,()=>f.rpc('erp_company_partners_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:1,p_partners:[body.partners[0],{...body.partners[0],name:'Repetida',share:null}]}),'22023');
 await fails(assert,()=>f.rpc('erp_company_partners_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:1,p_partners:[{name:'X',cpf:'12345678900',share:null,role:null,email:null,phone:null}]}),'22023');
 await fails(assert,()=>save({command_id:randomUUID(),expected_version:1,partners:[]},f.users.vendas),'42501');
 const removed=await save({command_id:randomUUID(),expected_version:1,partners:[]});assert.deepEqual(removed.record.partners,[]);
 assert.deepEqual((await f.db.query("select action from erp_company.audit where action='save_partners' order by id")).rows.length,2);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_company_partners_save(uuid,uuid,integer,jsonb)','execute') v`),false);
}finally{await f.close();}});

test('189 correcting Nome, Nome Fantasia or CNPJ needs a reason, kept in the audit and the Registro de atividades; other fields do not',async()=>{const f=await laneCFixture();try{
 const data={legal_name:'Empresa Sintética Ltda',trade_name:'Sintética',cnpj:'11222333000181',ie:null,postal_code:'01001000',street:'Rua Sintética',number:'1',complement:null,district:'Centro',city:'São Paulo',municipality_code:'3550308',state:'SP',phone:null,email:null};
 const first=await f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:0,p_command_id:randomUUID(),p_data:data});assert.equal(first.record.version,1);
 const street=await f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:1,p_command_id:randomUUID(),p_data:{...data,number:'2'}});assert.equal(street.record.version,2);
 await fails(assert,()=>f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:2,p_command_id:randomUUID(),p_data:{...data,number:'2',legal_name:'Empresa Corrigida Ltda'}}),'22023');
 await fails(assert,()=>f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:2,p_command_id:randomUUID(),p_data:{...data,number:'2',legal_name:'Empresa Corrigida Ltda'},p_reason:'ab'}),'22023');
 const command=randomUUID(),args={p_user_id:f.users.admin,p_expected_version:2,p_command_id:command,p_data:{...data,number:'2',legal_name:'Empresa Corrigida Ltda'},p_reason:'Contrato social de 2026'};
 assert.equal((await f.rpc('erp_company_save_identity',args)).record.data.legal_name,'Empresa Corrigida Ltda');
 assert.equal((await f.rpc('erp_company_save_identity',args)).replayed,true);
 assert.equal(await f.scalar("select after_data->>'motivo' v from erp_company.audit where action='save_identity' order by id desc limit 1"),'Contrato social de 2026');
 const{captureActivityQuery,parseActivity}=await import('../../../packages/erp-domain/src/activity.mjs');
 const day=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v"),q=captureActivityQuery({from:day,to:day,module:'empresa'});
 assert.ok(parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:null,p_actor:null,p_query:null,p_limit:q.limit,p_offset:q.offset}),q).items
  .some(e=>e.description==='Dados da empresa · dados bloqueados corrigidos: Contrato social de 2026'));
}finally{await f.close();}});

test('189 stops when a function it replaces is not the expected version',async()=>{const f=await laneCFixture({before:'202610200189'});try{
 await f.db.exec("create or replace function erp_home.visible_shortcuts(p_role text,p_shortcuts text[]) returns jsonb language sql stable set search_path=pg_catalog as $body$ select '[]'::jsonb $body$;");
 await assert.rejects(()=>f.migrate('202610200189_home_charts_company.sql'),e=>e.code==='55000'&&/home_company_189_previous_definition_changed/.test(e.message));
}finally{await f.close();}});
