import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {contactsFixture,fails} from './helpers/contacts-fixture.mjs';

// Migrations 202610200124-128 (contatos lane) over every migration published up to 202610200118. Synthetic data only.
const PUBLIC=['erp_catalog_contact_get','erp_catalog_contact_check','erp_catalog_contact_save','erp_catalog_contact_set_situation','erp_catalog_contact_types',
 'erp_catalog_contact_type_create','erp_catalog_contact_type_delete','erp_catalog_contact_code','erp_catalog_contact_code_set','erp_catalog_contact_page',
 'erp_catalog_contact_export','erp_catalog_contact_comments','erp_catalog_contact_comment_add','erp_catalog_contact_sales','erp_catalog_contact_import',
 'erp_catalog_seller_page','erp_catalog_seller_get','erp_catalog_seller_options','erp_catalog_seller_save','erp_catalog_seller_from_contact','erp_catalog_contact_set_seller',
 'erp_catalog_payment_method_page','erp_catalog_payment_method_get','erp_catalog_payment_method_save','erp_catalog_payment_method_action',
 'erp_catalog_employee_page','erp_catalog_employee_get','erp_catalog_employee_save'];
const SETTINGS={user_id:null,allow_unregistered_products:false,view_stock:false,access_hours_enabled:false,access_windows:[],modules:{},commission_rule:'parcial',commission_mode:'fixa',
 commission_rate:null,commission_bands:[],discount_limit:'0',notes:null};
const METHOD={description:'Dinheiro',payment_type:'01',condition:null,destination:'caixa',account_id:null,business_days:false,applicable:'ambos',interest_rate:null,fine_rate:null,
 card_brand:null,card_integration:null,card_cnpj:null,auto_settle:false,pix_integration:null,pix_cnpj:null,fee_type:'aliquota',fee_rate:null,fee_fixed:null,settlement_days:null};
const EMPLOYEE={name:'Funcionária Sintética',cpf:'529.982.247-25',rg:null,job_title:'Vendedora',pis:null,ctps:null,code:'F-1',phone:null,mobile:'(19) 90000-0001',email:'func@sintetico.test',
 emergency_phone:null,postal_code:null,state:'SP',city:'Piracicaba',district:null,street:null,number:null,complement:null,birth_date:'1990-01-02',admission_date:'2026-01-05',salary:'3500.5',notes:null};
const names=page=>page.items.map(item=>item.name);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());

test('contatos lane SQL (124-128): ACL, contact form, situation, types, preferences, listing, export, comments, import, sellers, payment methods and employees',async t=>{
 const f=await contactsFixture();
 const rpc=(name,args)=>f.rpc(name,args);
 try{
  await t.test('new RPCs are service-only SECURITY DEFINER with a fixed search_path; helpers and tables stay private',async()=>{
   const rs=await f.rows(`select p.proname,n.nspname,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE') service,
     has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('public',p.oid,'EXECUTE') everyone
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname='public' and p.proname=any($1)) or(n.nspname='erp_catalog' and(p.proname like 'contact%' or p.proname like 'seller%'
     or p.proname like 'payment_method%' or p.proname like 'employee%' or p.proname in('payment_condition_valid','sale_statuses_valid','percent_valid','valid_pis','acknowledged_valid','comment_dto')))`,[PUBLIC]);
   assert.equal(rs.filter(r=>r.nspname==='public').length,PUBLIC.length);
   assert.ok(rs.filter(r=>r.nspname==='erp_catalog').length>=30);
   for(const r of rs){
    assert.deepEqual(r.proconfig,['search_path=pg_catalog'],r.proname);
    assert.equal(r.anon,false,r.proname);assert.equal(r.authenticated,false,r.proname);assert.equal(r.everyone,false,r.proname);
    assert.equal(r.service,r.nspname==='public',r.proname);assert.equal(r.prosecdef,r.nspname==='public',r.proname);
   }
   const tables=await f.rows(`select c.relname,c.relrowsecurity rls,has_table_privilege('service_role',c.oid,'SELECT') s,has_table_privilege('authenticated',c.oid,'SELECT') a
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_catalog' and c.relkind='r' and c.relname=any($1)`,
    [['contact_type','contact_type_link','seller','contact_profile','contact_person','contact_code_counter','auxiliary_audit','contact_comment','payment_method','employee']]);
   assert.equal(tables.length,10);for(const r of tables){assert.equal(r.rls,true,r.relname);assert.equal(r.s,false,r.relname);assert.equal(r.a,false,r.relname);}
  });

  const ids={};
  await t.test('contact form: Origin defaults, every field typed, roles kept as the compatible projection, replay and CAS',async()=>{
   const command=randomUUID();
   const data={name:'Ána Ábaco Comércio',trade_name:'Loja Ábaco',person_type:'J',document:'11.222.333/0001-81',crt:'1',ie_exempt:true,municipal_registration:'123',
    public_agency:'municipal',suframa:'12345678',email:'compras@abaco.test; financeiro@abaco.test',nfe_email:'nfe@abaco.test',website:'www.abaco.test',fax:'(19) 3434-2000',
    carrier_operator:'vivo',contact_info:'Falar com Ana\nramal 2',types:['customer','accountant','default'],payment_condition:'15 + 2x',credit_limit_mode:'value',credit_limit:'1500.5',
    billing_city:'Campinas',billing_state:'sp',next_visit:'2026-10-25',notes:'Observação sintética',state:'SP',city:'São Carlos',phone:'(19) 3434-1000'};
   const created=(await f.save(data,{command})).record;ids.ana=created.id;
   assert.equal(created.client_since,today(),'Cliente desde = hoje em São Paulo');
   assert.equal(created.taxpayer,'9');assert.equal(created.situation,'A');assert.equal(created.active,true);
   assert.deepEqual(created.roles,['customer']);assert.deepEqual(created.types,['customer','default','accountant']);
   assert.equal(created.credit_limit,'1500.50');assert.equal(created.billing_state,'SP');assert.equal(created.ie_exempt,true);
   assert.equal(created.contact_info,'Falar com Ana\nramal 2');assert.equal(created.updated_by_name,'admin@sintetico.test');
   assert.equal(await f.scalar("select roles::text v from erp_catalog.contact where record_id=$1",[created.id]),'{customer}');
   const replay=await f.save(data,{command});assert.equal(replay.replayed,true);assert.equal(replay.record.id,created.id);
   await fails(assert,f.save({...data,name:'Outro'},{command}),'40001');
   const updated=(await f.save({name:'Ána Ábaco',types:['supplier','accountant']},{id:created.id,version:1})).record;
   assert.equal(updated.version,2);assert.deepEqual(updated.roles,['supplier']);assert.deepEqual(updated.types,['supplier','accountant']);
   assert.equal(updated.trade_name,'Loja Ábaco','a patch keeps the other fields');
   await fails(assert,f.save({name:'Versão antiga'},{id:created.id,version:1}),'40001');
   const same=(await f.save({name:'Ána Ábaco'},{id:created.id,version:2})).record;assert.equal(same.version,2,'no change, no new version');
   // Old clients (contato rápido) send roles only: Cliente/Fornecedor/Transportador follow them, the other types stay.
   const legacy=(await f.save({roles:['customer','carrier']},{id:created.id,version:2})).record;
   assert.deepEqual(legacy.types,['customer','carrier','accountant']);assert.deepEqual(legacy.roles,['carrier','customer']);
   const audit=await f.rows("select action from erp_catalog.audit where record_id=$1 order by id",[created.id]);
   assert.deepEqual(audit.map(r=>r.action),['create','update','update']);
  });

  await t.test('field rules: person type sections, IE Isento, credit limit, e-mails, website, condition, dates, persons and unknown keys',async()=>{
   for(const data of[{name:'PJ com RG',person_type:'J',rg:'1'},{name:'PF com CRT',person_type:'F',crt:'1'},{name:'Sem tipo com país',country:'Argentina'},
    {name:'IE e isento',person_type:'J',ie_exempt:true,ie:'123'},{name:'Limite sem valor',credit_limit_mode:'value'},{name:'Valor sem limite',credit_limit:'10'},
    {name:'E-mail',email:'a@b.test; errado'},{name:'NF-e',nfe_email:'x'.repeat(55)+'@a.test'},{name:'Site',website:'sem ponto'},{name:'Condição',payment_condition:'30 20'},
    {name:'Data',next_visit:'2026-02-30'},{name:'Nascimento futuro',person_type:'F',birth_date:'2100-01-01'},{name:'Carga',person_type:'F',avg_tax_load:'100.5'},
    {name:'Suframa',person_type:'J',suframa:'12'},{name:'Tipo',types:['inexistente']},{name:'Pessoa',persons:[randomUUID()]},{name:'Chave',x:1},{name:''},
    {name:'UF',state:'XX'},{name:'Situação E',situation:'E'},{name:'Operadora',carrier_operator:'algar'}])await fails(assert,f.save(data),'22023');
   const pf=(await f.save({name:'Bruno Pessoa Física',person_type:'F',document:'52998224725',rg:'12.345.678-9',rg_issuer:'SSP',birth_date:'1990-12-30',marital_status:'casado',
    gender:'masculino',avg_tax_load:'12.5',father_name:'Pai Sintético',mother_name:'Mãe Sintética',mobile:'19 99876-5432',persons:[ids.ana],types:['supplier']})).record;
   ids.bruno=pf.id;assert.equal(pf.avg_tax_load,'12.50');assert.deepEqual(pf.persons.map(p=>p.id),[ids.ana]);
   await fails(assert,f.save({persons:[pf.id]},{id:pf.id,version:pf.version}),'22023');
   const foreign=(await f.save({name:'Cliente Estrangeiro',person_type:'E',country:'Argentina',foreign_state:'Córdoba',state:'EX'})).record;assert.equal(foreign.country,'Argentina');
   assert.equal((await f.save({name:'Condição válida',payment_condition:'30, 60; 90'})).record.payment_condition,'30, 60; 90');
   await fails(assert,f.save({name:'Somente consulta'},{user:f.users.consulta}),'42501');
   await fails(assert,f.save({name:'Inativo'},{user:f.users.inactive}),'42501');
   assert.equal((await f.save({name:'Pelo financeiro'},{user:f.users.financeiro})).record.name,'Pelo financeiro');
  });

  await t.test('situation: Ativo, Inativo, Sem movimento and Excluído keep active as the A/S projection; Excluído is read-only and audited as exclusão',async()=>{
   const contact=(await f.save({name:'Carla Situações'})).record;ids.carla=contact.id;
   const set=async(situation,version,user=f.users.admin)=>(await rpc('erp_catalog_contact_set_situation',{p_user_id:user,p_id:contact.id,p_expected_version:version,p_command_id:randomUUID(),p_situation:situation})).record;
   let current=await set('S',1);assert.deepEqual([current.situation,current.active,current.version],['S',true,2]);
   current=await set('E',2,f.users.vendas);assert.deepEqual([current.situation,current.active],['E',false]);
   await fails(assert,f.save({name:'Editar excluído'},{id:contact.id,version:current.version}),'22023');
   await fails(assert,set('A',current.version,f.users.consulta),'42501');
   await fails(assert,set('X',current.version),'22023');
   current=await set('A',current.version);assert.equal(current.situation,'A');
   const same=await rpc('erp_catalog_contact_set_situation',{p_user_id:f.users.admin,p_id:contact.id,p_expected_version:current.version,p_command_id:randomUUID(),p_situation:'A'});
   assert.equal(same.record.version,current.version,'unchanged situation keeps the version');
   assert.deepEqual((await f.rows("select action from erp_catalog.audit where record_id=$1 order by id",[contact.id])).map(r=>r.action),['create','transition','archive','transition']);
   // The legacy toggle (erp_catalog_set_active) still works and the detail follows it: S stays S while active.
   const legacy=(await rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato antigo',roles:['customer']}})).record;
   assert.equal((await f.get(legacy.id)).record.situation,'A');
   await rpc('erp_catalog_set_active',{p_user_id:f.users.admin,p_entity:'contacts',p_id:legacy.id,p_expected_version:1,p_command_id:randomUUID(),p_active:false});
   assert.equal((await f.get(legacy.id)).record.situation,'I');
   // A contact mirrored from Origin with situacao S (no Brufap profile yet) shows Sem movimento.
   const hash='a'.repeat(64);
   await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) values('contacts','origin-1',$1,1,'{\"situacao\":\"S\"}','[]')",[hash]);
   await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) values('contacts','origin-1',$1,$2,$2,'synced')",[legacy.id,hash]);
   await f.db.query('update erp_catalog.record set active=true where id=$1',[legacy.id]);
   assert.equal((await f.get(legacy.id)).record.situation,'S');
  });

  await t.test('tipos de contato: system types are protected; Contador and created types can be deleted by an administrator',async()=>{
   const types=await rpc('erp_catalog_contact_types',{p_user_id:f.users.vendas});
   assert.deepEqual(types.items.map(i=>i.label),['Cliente','Desenvolvedor','Fornecedor','Padrao','Técnico','Transportador','Vendedor','Contador','Fornecedor verificado']);
   assert.deepEqual([types.can_create,types.can_delete],[true,false]);
   assert.deepEqual(types.items.filter(i=>i.deletable).map(i=>i.slug),['accountant','verified_supplier']);
   const created=await rpc('erp_catalog_contact_type_create',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_label:'Parceiro'});
   await fails(assert,rpc('erp_catalog_contact_type_create',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_label:'parceiro'}),'23505');
   await fails(assert,rpc('erp_catalog_contact_type_create',{p_user_id:f.users.consulta,p_command_id:randomUUID(),p_label:'Outro'}),'42501');
   const tagged=(await f.save({name:'Parceiro sintético',types:[created.item.slug]})).record;
   const del=command=>rpc('erp_catalog_contact_type_delete',{p_user_id:f.users.admin,p_command_id:command,p_id:created.item.id});
   await fails(assert,rpc('erp_catalog_contact_type_delete',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_id:created.item.id}),'42501');
   const system=types.items.find(i=>i.slug==='customer');
   await fails(assert,rpc('erp_catalog_contact_type_delete',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_id:system.id}),'42501');
   const command=randomUUID(),removed=await del(command);assert.equal(removed.unlinked,1);assert.equal((await del(command)).replayed,true);
   assert.deepEqual((await f.get(tagged.id)).record.types,[]);
   assert.equal((await rpc('erp_catalog_contact_types',{p_user_id:f.users.admin})).items.some(i=>i.id===created.item.id),false);
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.auxiliary_audit where subject='contact_type'"),2);
  });

  await t.test('Preferências applied in the save: campos obrigatórios, CPF/CNPJ duplicado and código sequencial with Próximo número',async()=>{
   await f.preference('contatos.campos_obrigatorios',['cep','limite_credito','rg','uf_exterior']);
   await fails(assert,f.save({name:'Sem CEP'}),'erp_catalog_contact_required:postal_code');
   await fails(assert,f.save({name:'PF sem RG',person_type:'F',postal_code:'13400-000',credit_limit_mode:'zero'}),'erp_catalog_contact_required:rg');
   await fails(assert,f.save({name:'Ilimitado',person_type:'J',postal_code:'13400-000'}),'erp_catalog_contact_required:credit_limit_mode');
   assert.ok((await f.save({name:'PJ completa',person_type:'J',postal_code:'13400-000',credit_limit_mode:'zero'})).record.id,'RG and UF (Exterior) only apply to their person type');
   await f.preference('contatos.campos_obrigatorios',[]);
   const check=data=>rpc('erp_catalog_contact_check',{p_user_id:f.users.admin,p_id:null,p_data:data});
   const duplicated=(await check({person_type:'J',document:'11222333000181'})).warnings.find(w=>w.code==='duplicate_document');
   assert.equal(duplicated.blocked,undefined,'duplicates are allowed by default (current Brufap behavior)');
   await fails(assert,f.save({name:'Duplicado',person_type:'J',document:'11222333000181'},{acknowledged:[]}),'40001');
   assert.ok((await f.save({name:'Duplicado confirmado',person_type:'J',document:'11222333000181'},{acknowledged:['duplicate_document']})).record.id);
   await f.preference('contatos.permite_documento_duplicado',false);
   assert.equal((await check({person_type:'J',document:'11.222.333/0001-81'})).warnings.find(w=>w.code==='duplicate_document').blocked,true);
   await fails(assert,f.save({name:'Bloqueado',person_type:'J',document:'11.222.333/0001-81'},{acknowledged:['duplicate_document']}),'23505');
   const parents=await check({person_type:'F',father_cpf:'111.111.111-11',mother_cpf:'529.982.247-25'});
   assert.deepEqual(parents.warnings.map(w=>w.code),['invalid_father_cpf']);
   await f.preference('contatos.permite_documento_duplicado',true);
   await f.save({name:'Código 7',code:'7'});
   assert.equal((await rpc('erp_catalog_contact_code',{p_user_id:f.users.vendas})).next_number,'8');
   await f.preference('contatos.codigo','sequencial');
   assert.equal((await f.save({name:'Sequencial 1'})).record.code,'8');
   await f.save({name:'Código manual 9',code:'9'});
   assert.equal((await f.save({name:'Sequencial 2'})).record.code,'10','used codes are skipped');
   const code=await rpc('erp_catalog_contact_code',{p_user_id:f.users.admin});
   assert.deepEqual([code.mode,code.next_number,code.can_edit],['sequencial','11',true]);
   await fails(assert,rpc('erp_catalog_contact_code_set',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_expected_version:code.version,p_next_number:'50'}),'42501');
   await fails(assert,rpc('erp_catalog_contact_code_set',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:code.version,p_next_number:'10'}),'22023');
   await fails(assert,rpc('erp_catalog_contact_code_set',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:code.version+1,p_next_number:'50'}),'40001');
   const set=await rpc('erp_catalog_contact_code_set',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:code.version,p_next_number:'50'});
   assert.equal(set.next_number,'50');assert.equal((await f.save({name:'Sequencial 3'})).record.code,'50');
   await f.preference('contatos.codigo','manual');
   assert.equal((await f.save({name:'Manual sem código'})).record.code,null);
  });

  await t.test('listing: Origin situations, contact types, seller, Prox. Visita, Sem compras no período with sale statuses, and search with fax',async()=>{
   const page=args=>f.page({p_size:100,...args});
   const latest=await page({});
   assert.equal(latest.situation,'latest');assert.equal(latest.items.some(i=>i.situation==='E'),false);
   await rpc('erp_catalog_contact_set_situation',{p_user_id:f.users.admin,p_id:ids.carla,p_expected_version:(await f.get(ids.carla)).record.version,p_command_id:randomUUID(),p_situation:'E'});
   assert.deepEqual(names(await page({p_situation:'E'})),['Carla Situações']);
   assert.ok(names(await page({p_situation:'all'})).includes('Carla Situações'),'Todos includes the excluded ones');
   assert.equal(names(await page({})).includes('Carla Situações'),false);
   assert.ok((await page({p_situation:'S'})).items.every(i=>i.situation==='S'));
   assert.deepEqual(names(await page({p_type:'accountant'})),['Ána Ábaco']);
   assert.ok(names(await page({p_type:'supplier'})).includes('Bruno Pessoa Física'));
   assert.ok((await page({p_type:'none'})).items.every(i=>i.types.length===0));
   assert.deepEqual(names(await page({p_period:'next_visit',p_from:'2026-10-20',p_to:'2026-10-31'})),['Ána Ábaco']);
   assert.deepEqual(names(await page({p_query:'3434-2000'})),['Ána Ábaco'],'Fax is a phone of the contact');
   assert.deepEqual(names(await page({p_phone:'343420'})),['Ána Ábaco']);
   const product=(await rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto sintético',unit:'UN',kind:'P',format:'S',price:'1'}})).record;
   const order=(await rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),
    p_body:{date:'2026-10-10',contact_id:ids.ana,items:[{product_id:product.id,description:'Produto sintético',unit:'UN',quantity:'1',unit_price:'10'}]}})).document;
   const noPurchases=args=>page({p_period:'no_purchases',p_from:'2026-10-01',p_to:'2026-10-31',...args}).then(names);
   assert.equal((await noPurchases({})).includes('Ána Ábaco'),false);
   assert.ok((await noPurchases({p_sale_statuses:['fulfilled']})).includes('Ána Ábaco'),'only the chosen sale statuses count');
   assert.equal((await noPurchases({p_sale_statuses:[order.status]})).includes('Ána Ábaco'),false);
   assert.ok((await page({p_period:'no_purchases',p_from:'2026-11-01',p_to:'2026-11-30'})).items.some(i=>i.name==='Ána Ábaco'));
   const sales=await rpc('erp_catalog_contact_sales',{p_user_id:f.users.vendas,p_contact_id:ids.ana});
   assert.deepEqual([sales.visible,sales.items.length,sales.items[0].date,sales.items[0].total],[true,1,'2026-10-10','10.00']);
   assert.equal((await rpc('erp_catalog_contact_sales',{p_user_id:f.users.financeiro,p_contact_id:ids.ana})).items.length,1,'every profile that reads contacts reads pedidos de venda today');
   for(const args of[{p_situation:'X'},{p_type:'inexistente'},{p_period:'no_purchases'},{p_sale_statuses:['open']},{p_period:'no_purchases',p_from:'2026-10-01',p_sale_statuses:['aberto']},
    {p_period:'next_visit',p_from:'2026-10-02',p_to:'2026-10-01'},{p_state:'sp'},{p_phone:'abc'},{p_size:101},{p_sort:'id'}])await fails(assert,page(args),'22023');
   const item=latest.items.find(i=>i.id===ids.ana);
   assert.deepEqual(Object.keys(item).sort(),['active','city','code','created_at','crt','document','email','entity','id','is_seller','mobile','name','next_visit','person_type','phone','roles',
    'seller_id','seller_name','situation','source','state','trade_name','types','updated_at','version']);
  });

  await t.test('export, impressão and Aniversariantes: current filters, blocks of 100, the 10.000 limit and an audit entry',async()=>{
   const exported=await rpc('erp_catalog_contact_export',{p_user_id:f.users.consulta,p_kind:'contacts',p_offset:0,p_limit:2,p_situation:'all',p_sort:'name_asc'});
   assert.equal(exported.items.length,2);assert.ok(exported.total>2);assert.equal('persons' in exported.items[0],false);
   const rest=await rpc('erp_catalog_contact_export',{p_user_id:f.users.consulta,p_kind:'contacts',p_offset:2,p_limit:100,p_situation:'all',p_sort:'name_asc'});
   assert.equal(rest.items.length,exported.total-2);
   const birthdays=await rpc('erp_catalog_contact_export',{p_user_id:f.users.admin,p_kind:'birthdays',p_offset:0,p_limit:100,p_situation:'all',p_birth_from:'2026-12-15',p_birth_to:'2027-01-10'});
   assert.deepEqual(names(birthdays),['Bruno Pessoa Física'],'the period may cross the year');
   assert.deepEqual(names(await rpc('erp_catalog_contact_export',{p_user_id:f.users.admin,p_kind:'birthdays',p_offset:0,p_limit:100,p_situation:'all',p_birth_from:'2026-01-01',p_birth_to:'2026-12-31'})),['Bruno Pessoa Física']);
   await fails(assert,rpc('erp_catalog_contact_export',{p_user_id:f.users.admin,p_kind:'birthdays',p_offset:0,p_limit:100,p_situation:'all'}),'22023');
   await fails(assert,rpc('erp_catalog_contact_export',{p_user_id:f.users.admin,p_kind:'contacts',p_offset:0,p_limit:101,p_situation:'all'}),'22023');
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.auxiliary_audit where subject='contacts_export'"),3,'only the first block of each export is audited');
   await f.db.query(`with r as(insert into erp_catalog.record(entity,name) select 'contacts','Lote '||g from generate_series(1,10001) g returning id) insert into erp_catalog.contact(record_id) select id from r`);
   await fails(assert,rpc('erp_catalog_contact_export',{p_user_id:f.users.admin,p_kind:'contacts',p_offset:0,p_limit:1,p_situation:'all'}),'22023');
   assert.equal((await f.page({p_size:1})).total>10000,true,'the listing itself is not limited');
   await f.db.query("delete from erp_catalog.contact where record_id in(select id from erp_catalog.record where name like 'Lote %')");
   await f.db.query("delete from erp_catalog.record where name like 'Lote %'");
  });

  await t.test('comentários: readers list, writers add once per command, author and São Paulo timestamps come from the server',async()=>{
   const command=randomUUID(),add=user=>rpc('erp_catalog_contact_comment_add',{p_user_id:user,p_command_id:command,p_contact_id:ids.ana,p_body:'  Ligar na segunda.\nConfirmar pedido. '});
   const first=await add(f.users.vendas);assert.equal(first.item.body,'Ligar na segunda.\nConfirmar pedido.');assert.equal(first.item.author_name,'vendas@sintetico.test');
   assert.equal((await add(f.users.vendas)).replayed,true);
   await fails(assert,add(f.users.financeiro),'40001');
   await fails(assert,rpc('erp_catalog_contact_comment_add',{p_user_id:f.users.consulta,p_command_id:randomUUID(),p_contact_id:ids.ana,p_body:'x'}),'42501');
   await fails(assert,rpc('erp_catalog_contact_comment_add',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:ids.ana,p_body:'x'.repeat(2001)}),'22023');
   const list=await rpc('erp_catalog_contact_comments',{p_user_id:f.users.consulta,p_contact_id:ids.ana});
   assert.deepEqual([list.items.length,list.can_comment],[1,false]);
  });

  await t.test('importar contatos: validate per row, import all or nothing per batch with replay, sequential codes and duplicates in the batch',async()=>{
   const rows=[{row:2,data:{name:'Importado Um',email:'um@sintetico.test',types:['customer']}},{row:3,data:{name:'Importado Dois',email:'errado'}},{row:4,data:{name:'Importado Três',person_type:'J',rg:'1'}}];
   const dry=await rpc('erp_catalog_contact_import',{p_user_id:f.users.vendas,p_command_id:null,p_rows:rows,p_dry_run:true});
   assert.deepEqual(dry.items,[{row:2,status:'valid'},{row:3,status:'invalid',code:'invalid',field:'email'},{row:4,status:'invalid',code:'invalid',field:'rg'}]);
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.record where name like 'Importado%'"),0,'validation writes nothing');
   await fails(assert,rpc('erp_catalog_contact_import',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_rows:rows,p_dry_run:false}),'22023');
   const command=randomUUID(),apply=()=>rpc('erp_catalog_contact_import',{p_user_id:f.users.vendas,p_command_id:command,p_rows:[rows[0]],p_dry_run:false});
   const applied=await apply();assert.equal(applied.items[0].status,'created');assert.equal((await apply()).replayed,true);
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.record where name='Importado Um'"),1);
   assert.equal(await f.scalar("select action v from erp_catalog.audit where record_id=$1",[applied.items[0].record_id]),'import_create');
   await f.preference('contatos.permite_documento_duplicado',false);
   const twins=await rpc('erp_catalog_contact_import',{p_user_id:f.users.admin,p_command_id:null,p_dry_run:true,p_rows:[{row:2,data:{name:'Gêmeo A',document:'390.533.447-05'}},{row:3,data:{name:'Gêmeo B',document:'39053344705'}}]});
   assert.deepEqual(twins.items.map(i=>i.status),['valid','invalid']);assert.equal(twins.items[1].code,'duplicate_document');
   await f.preference('contatos.permite_documento_duplicado',true);
   await fails(assert,rpc('erp_catalog_contact_import',{p_user_id:f.users.consulta,p_command_id:null,p_rows:[rows[0]],p_dry_run:true}),'42501');
   await fails(assert,rpc('erp_catalog_contact_import',{p_user_id:f.users.admin,p_command_id:null,p_rows:Array.from({length:51},(_,i)=>({row:i+2,data:{name:'x'}})),p_dry_run:true}),'22023');
  });

  await t.test('vendedores: contact and settings in one command, Tornar vendedor, Vincular a vendedor and "Contato acessível somente ao vendedor vinculado"',async()=>{
   const save=(args,user=f.users.admin)=>rpc('erp_catalog_seller_save',{p_user_id:user,p_command_id:randomUUID(),p_acknowledged:null,...args});
   await fails(assert,save({p_id:null,p_expected_version:0,p_contact_expected_version:0,p_contact:{name:'Vendedora'},p_settings:SETTINGS},f.users.vendas),'42501');
   for(const settings of[{...SETTINGS,access_windows:[{start:'18:00',end:'08:00',days:[1]}]},{...SETTINGS,modules:{multilojas:true}},{...SETTINGS,commission_rate:'101'},
    {...SETTINGS,commission_bands:[{discount_up_to:'10',rate:'2'},{discount_up_to:'5',rate:'3'}]},{...SETTINGS,discount_limit:null},{...SETTINGS,extra:true}])
    await fails(assert,save({p_id:null,p_expected_version:0,p_contact_expected_version:0,p_contact:{name:'Vendedora'},p_settings:settings}),'22023');
   const created=await save({p_id:null,p_expected_version:0,p_contact_expected_version:0,p_contact:{name:'Vendedora Sintética',city:'Piracicaba',state:'SP'},
    p_settings:{...SETTINGS,access_hours_enabled:true,access_windows:[{start:'08:00',end:'18:00',days:[1,2,3,4,5]}],modules:{clientes:true,propostas:false},commission_mode:'descontos',
     commission_bands:[{discount_up_to:'5',rate:'3'},{discount_up_to:'10',rate:'1.5'}],discount_limit:'10'}});
   ids.seller=created.seller.id;
   assert.deepEqual(created.contact.types,['seller']);assert.equal(created.contact.seller_record_id,created.seller.id);
   assert.deepEqual(created.seller.modules,{clientes:true});assert.equal(created.seller.discount_limit,'10.0000');
   assert.deepEqual(created.seller.commission_bands,[{discount_up_to:'5.0000',rate:'3.0000'},{discount_up_to:'10.0000',rate:'1.5000'}]);
   const read=await rpc('erp_catalog_seller_get',{p_user_id:f.users.consulta,p_id:ids.seller});assert.deepEqual([read.can_write,read.users],[false,[]]);
   await fails(assert,rpc('erp_catalog_seller_get',{p_user_id:f.users.estoque,p_id:ids.seller}),'42501');
   assert.deepEqual((await rpc('erp_catalog_seller_options',{p_user_id:f.users.estoque,p_query:'vend sint'})).items.map(i=>i.name),['Vendedora Sintética']);
   const page=await rpc('erp_catalog_seller_page',{p_user_id:f.users.vendas});assert.deepEqual(names(page),['Vendedora Sintética']);assert.equal(page.items[0].seller_id,ids.seller);
   await fails(assert,save({p_id:ids.seller,p_expected_version:2,p_contact_expected_version:1,p_contact:{name:'x'},p_settings:SETTINGS}),'40001');
   const same=await save({p_id:ids.seller,p_expected_version:1,p_contact_expected_version:1,p_contact:{name:'Vendedora Sintética',types:[]},p_settings:{
    user_id:null,allow_unregistered_products:false,view_stock:false,access_hours_enabled:true,access_windows:[{start:'08:00',end:'18:00',days:[1,2,3,4,5]}],modules:{clientes:true},commission_rule:'parcial',
    commission_mode:'descontos',commission_rate:null,commission_bands:[{discount_up_to:'5',rate:'3'},{discount_up_to:'10',rate:'1.5'}],discount_limit:'10',notes:null}});
   assert.equal(same.seller.version,1,'unchanged settings keep the version');assert.deepEqual(same.contact.types,['seller'],'the Vendedor type stays');
   const other=(await f.save({name:'Contato que vira vendedor',types:['customer']})).record;
   const from=await rpc('erp_catalog_seller_from_contact',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:other.id});
   assert.deepEqual(from.contact.types,['customer','seller']);
   await fails(assert,rpc('erp_catalog_seller_from_contact',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:other.id}),'23505');
   const client=(await f.save({name:'Cliente da carteira'})).record;
   const linked=await rpc('erp_catalog_contact_set_seller',{p_user_id:f.users.vendas,p_id:client.id,p_expected_version:client.version,p_command_id:randomUUID(),p_seller_id:ids.seller});
   assert.equal(linked.record.seller_name,'Vendedora Sintética');
   assert.deepEqual(names(await f.page({p_seller_id:ids.seller})),['Cliente da carteira']);
   // Link the vendas user to the seller and turn the preference on: that user only reaches the contacts of the seller.
   const linkedUser=await save({p_id:ids.seller,p_expected_version:1,p_contact_expected_version:same.contact.version,p_contact:{name:'Vendedora Sintética'},p_settings:{...SETTINGS,user_id:f.users.vendas}});
   assert.equal(linkedUser.seller.user_name,'vendas@sintetico.test');
   await fails(assert,save({p_id:from.seller.id,p_expected_version:1,p_contact_expected_version:from.contact.version,p_contact:{name:'Contato que vira vendedor'},p_settings:{...SETTINGS,user_id:f.users.vendas}}),'23505');
   await f.preference('contatos.acesso_vendedor',true);
   assert.deepEqual(names(await f.page({},f.users.vendas)),['Cliente da carteira']);assert.equal((await f.page({},f.users.vendas)).scoped,true);
   assert.ok((await f.page({},f.users.admin)).total>1,'administrador vê todos');
   await fails(assert,f.get(ids.ana,f.users.vendas),'42501');
   const mine=(await f.save({name:'Cliente novo da vendedora'},{user:f.users.vendas})).record;assert.equal(mine.seller_id,ids.seller);
   await fails(assert,f.save({name:'Outro vendedor',seller_id:from.seller.id},{user:f.users.vendas}),'42501');
   await fails(assert,rpc('erp_catalog_contact_comments',{p_user_id:f.users.vendas,p_contact_id:ids.ana}),'42501');
   assert.equal((await rpc('erp_catalog_contact_export',{p_user_id:f.users.vendas,p_kind:'contacts',p_offset:0,p_limit:100,p_situation:'all'})).total,2);
   await f.preference('contatos.acesso_vendedor',false);
   assert.ok((await f.page({},f.users.vendas)).total>2);
  });

  await t.test('formas de pagamento: sections by payment type, Forma padrão swapped atomically, Inativar, Excluir and roles',async()=>{
   const account=await f.scalar("insert into erp_finance.account(name,kind) values('Banco sintético','bank') returning id::text v");
   const save=(data,{id=null,version=0,user=f.users.financeiro}={})=>rpc('erp_catalog_payment_method_save',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:data});
   const card=(await save({...METHOD,description:'Cartão de Crédito',payment_type:'03',destination:'contas',account_id:account,applicable:'recebimentos',card_brand:'01',card_integration:'2',
    card_cnpj:'11.222.333/0001-81',fee_rate:'2.5',settlement_days:30,condition:'30 60'})).item;
   assert.deepEqual([card.card_cnpj,card.fee_rate,card.account_name,card.is_default],['11222333000181','2.5000','Banco sintético',false]);
   for(const data of[{...METHOD,card_brand:'01'},{...METHOD,interest_rate:'1'},{...METHOD,pix_integration:'sem'},{...METHOD,destination:'ficha',account_id:account},
    {...METHOD,payment_type:'03',card_cnpj:'11.222.333/0001-82'},{...METHOD,fee_type:'aliquota',fee_fixed:'1'},{...METHOD,condition:'3 2 1'},{...METHOD,description:' '},{...METHOD,extra:1}])
    await fails(assert,save(data),'22023');
   await fails(assert,save(METHOD,{user:f.users.vendas}),'42501');
   const boleto=(await save({...METHOD,description:'Boleto Bancário',payment_type:'15',destination:'contas',interest_rate:'1',fine_rate:'2'})).item;
   const action=(item,act,user=f.users.admin)=>rpc('erp_catalog_payment_method_action',{p_user_id:user,p_id:item.id,p_expected_version:item.version,p_command_id:randomUUID(),p_action:act});
   const first=await action(card,'default');assert.equal(first.item.is_default,true);
   const second=await action(boleto,'default');assert.equal(second.item.is_default,true);assert.equal(second.previous_default,card.id);
   assert.equal(await f.scalar('select count(*)::int v from erp_catalog.payment_method where is_default'),1);
   const off=await action(second.item,'inactivate');assert.deepEqual([off.item.active,off.item.is_default],[false,false]);
   const listed=await rpc('erp_catalog_payment_method_page',{p_user_id:f.users.vendas,p_applicable:'pagamentos'});
   assert.deepEqual(listed.items.map(i=>i.description),[],'Boleto is inactive and the card only receives');
   assert.deepEqual((await rpc('erp_catalog_payment_method_page',{p_user_id:f.users.vendas,p_applicable:'recebimentos',p_active:null})).items.map(i=>i.description),['Boleto Bancário','Cartão de Crédito']);
   assert.equal((await rpc('erp_catalog_payment_method_page',{p_user_id:f.users.consulta,p_account_id:account})).items.length,1);
   const removed=await action((await rpc('erp_catalog_payment_method_get',{p_user_id:f.users.admin,p_id:card.id})).item,'delete');assert.equal(removed.item,null);
   await fails(assert,rpc('erp_catalog_payment_method_get',{p_user_id:f.users.admin,p_id:card.id}),'P0002');
   await fails(assert,rpc('erp_catalog_payment_method_page',{p_user_id:f.users.estoque}),'42501');
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.auxiliary_audit where subject='payment_method'"),6);
  });

  await t.test('funcionários: administrador only, valid and unique CPF, PIS digits, Desligar keeps the record and no personal data in the command',async()=>{
   const save=(data,{id=null,version=0,situation=null,user=f.users.admin,command=randomUUID()}={})=>rpc('erp_catalog_employee_save',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:command,p_data:data,p_situation:situation});
   await fails(assert,save(EMPLOYEE,{user:f.users.financeiro}),'42501');
   for(const data of[{...EMPLOYEE,cpf:'111.111.111-11'},{...EMPLOYEE,pis:'12345678901'},{...EMPLOYEE,salary:'1,5'},{...EMPLOYEE,state:'XX'},{...EMPLOYEE,name:null},{...EMPLOYEE,extra:1}])
    await fails(assert,save(data),'22023');
   const command=randomUUID(),created=await save({...EMPLOYEE,pis:'120.50218.74-7'},{command});
   assert.deepEqual(Object.keys(created.item).sort(),['id','version']);
   assert.equal(JSON.stringify(await f.scalar('select result v from erp_catalog.command where command_id=$1',[command])).includes('529'),false,'no CPF in the stored command');
   const item=(await rpc('erp_catalog_employee_get',{p_user_id:f.users.admin,p_id:created.item.id})).item;
   assert.deepEqual([item.cpf,item.pis,item.salary,item.situation],['52998224725','12050218747','3500.50','ativo']);
   await fails(assert,save({...EMPLOYEE,name:'Outra'}),'23505');
   const off=await save(null,{id:item.id,version:1,situation:'desligado'});assert.equal(off.item.version,2);
   assert.deepEqual((await rpc('erp_catalog_employee_page',{p_user_id:f.users.admin,p_situation:'ativos'})).items,[]);
   assert.equal((await rpc('erp_catalog_employee_page',{p_user_id:f.users.admin,p_situation:'todas',p_query:'vendedora'})).total,1);
   await fails(assert,rpc('erp_catalog_employee_get',{p_user_id:f.users.consulta,p_id:item.id}),'42501');
  });

  await t.test('seller visibility: Vendedor empty links a seller user\'s new contact to that seller, and Vendedores shows no other seller\'s contact',async()=>{
   const save=(args,user=f.users.admin)=>rpc('erp_catalog_seller_save',{p_user_id:user,p_command_id:randomUUID(),p_acknowledged:null,...args});
   const own=await save({p_id:null,p_expected_version:0,p_contact_expected_version:0,p_contact:{name:'Vendedor da carteira B'},p_settings:{...SETTINGS,user_id:f.users.other}});
   const stranger=await save({p_id:null,p_expected_version:0,p_contact_expected_version:0,p_contact:{name:'Vendedor alheio',person_type:'F',birth_date:'1980-01-01'},p_settings:SETTINGS});
   await f.preference('contatos.acesso_vendedor',true);
   try{
    // The contact form and the quick drawer always send seller_id; empty means "my seller" for a seller user.
    const mine=(await f.save({name:'Cliente com Vendedor vazio',seller_id:null},{user:f.users.other})).record;
    assert.equal(mine.seller_id,own.seller.id);
    assert.deepEqual((await rpc('erp_catalog_contact_check',{p_user_id:f.users.other,p_id:null,p_data:{name:'Conferência',seller_id:null}})).warnings,[]);
    await fails(assert,f.save({name:'Outro vendedor',seller_id:stranger.seller.id},{user:f.users.other}),'42501');
    const page=await rpc('erp_catalog_seller_page',{p_user_id:f.users.other,p_situation:'all'});
    assert.equal(page.items.some(item=>item.seller_id===stranger.seller.id),false,'no other seller in the scoped list');
    await fails(assert,rpc('erp_catalog_seller_get',{p_user_id:f.users.other,p_id:stranger.seller.id}),'42501');
    assert.ok((await rpc('erp_catalog_seller_page',{p_user_id:f.users.admin,p_situation:'all'})).items.some(item=>item.seller_id===stranger.seller.id),'the administrator sees every seller');
    // Inactivating the seller never widens what its user sees.
    await rpc('erp_catalog_contact_set_situation',{p_user_id:f.users.admin,p_id:own.contact.id,p_expected_version:own.contact.version,p_command_id:randomUUID(),p_situation:'I'});
    const after=await f.page({p_situation:'all'},f.users.other);
    assert.equal(after.scoped,true);assert.deepEqual(names(after),['Cliente com Vendedor vazio']);
    await fails(assert,f.get(stranger.contact.id,f.users.other),'42501');
    await fails(assert,f.save({name:'Cliente de vendedor inativo'},{user:f.users.other}),'erp_catalog_contact_invalid:seller_id');
   }finally{await f.preference('contatos.acesso_vendedor',false);}
   assert.equal((await rpc('erp_catalog_seller_get',{p_user_id:f.users.other,p_id:stranger.seller.id})).seller.id,stranger.seller.id,'preference off: every seller is readable again');
  });

  await t.test('Campos obrigatórios: batch actions never ask for them; Vendedores asks only for the fields its form shows',async()=>{
   const save=args=>rpc('erp_catalog_seller_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_acknowledged:null,p_id:null,p_expected_version:0,p_contact_expected_version:0,p_settings:SETTINGS,...args});
   assert.deepEqual(await f.scalar('select erp_catalog.seller_contact_fields() v'),['name','code','trade_name','person_type','document','taxpayer','ie','rg','birth_date','country','postal_code','state',
    'city','district','street','number','complement','phone','mobile','email']);
   const seller=await save({p_contact:{name:'Vendedor para o lote'}});
   const legacy=(await f.save({name:'Legado sem CEP'})).record;
   await f.preference('contatos.campos_obrigatorios',['cep','email_nfe']);
   try{
    const linked=await rpc('erp_catalog_contact_set_seller',{p_user_id:f.users.admin,p_id:legacy.id,p_expected_version:legacy.version,p_command_id:randomUUID(),p_seller_id:seller.seller.id});
    assert.equal(linked.record.seller_id,seller.seller.id,'Vincular a vendedor works on a contact without the required CEP');
    const made=await rpc('erp_catalog_seller_from_contact',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:legacy.id});
    assert.ok(made.contact.types.includes('seller'),'Tornar vendedor too');
    await fails(assert,f.save({name:'Formulário sem CEP'}),'erp_catalog_contact_required:postal_code');
    await fails(assert,save({p_contact:{name:'Vendedor sem CEP'}}),'erp_catalog_contact_required:postal_code');
    const shown=await save({p_contact:{name:'Vendedor com CEP',postal_code:'13400-000'}});
    assert.equal(shown.contact.postal_code,'13400-000','E-Mail para envio da NFe is not in the Vendedor form, so it is not demanded there');
   }finally{await f.preference('contatos.campos_obrigatorios',[]);}
  });
 }finally{await f.close();}
});
