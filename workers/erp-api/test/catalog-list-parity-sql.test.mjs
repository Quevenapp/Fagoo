import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogListParityFixture} from './helpers/catalog-list-parity-fixture.mjs';
import {cnpjCheckDigits,isValidCnpj} from '../../../packages/fiscal-core/src/identity.mjs';

const fails=(promise,code)=>assert.rejects(promise,error=>error.code===code);
const names=value=>value.items.map(item=>item.name);
// Independent CPF reference (two mod-11 check digits); the SQL implementation is checked against it.
function cpf(base){let value=base;for(const n of[9,10]){let sum=0;for(let p=0;p<n;p++)sum+=Number(value[p])*(n+1-p);const digit=(sum*10)%11;value+=String(digit===10?0:digit);}return value;}
const cpfValid=value=>/^\d{11}$/.test(value)&&!/^(\d)\1{10}$/.test(value)&&cpf(value.slice(0,9))===value;
function random(seed){let state=seed;return()=>(state=(state*1103515245+12345)%2147483648)/2147483648;}

test('096 catalog list parity: ACL, paging, ordering, search, filters, stock and confirmed warnings',async t=>{
 const f=await catalogListParityFixture();
 try{
  await t.test('new RPCs are service-only SECURITY DEFINER with fixed search_path; helpers stay private; legacy grants are kept',async()=>{
   const rs=await f.rows(`select p.proname,n.nspname,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE') service,
     has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('public',p.oid,'EXECUTE') everyone
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname in('erp_catalog_page','erp_catalog_product_page','erp_catalog_check','erp_catalog_save_checked','erp_catalog_list','erp_catalog_product_list'))
     or (n.nspname='erp_catalog' and p.proname in('fold','compact','digits','search_terms','matches','valid_cpf','valid_cnpj','document_issue','list_item','page_valid','page_order','page_sql','stock_summary','can_read_stock','warnings'))`);
   assert.equal(rs.length,21);
   for(const r of rs){
    assert.equal(r.anon,false,r.proname);assert.equal(r.authenticated,false,r.proname);assert.equal(r.everyone,false,r.proname);
    assert.deepEqual(r.proconfig,['search_path=pg_catalog'],r.proname);
    assert.equal(r.service,r.nspname==='public',r.proname);assert.equal(r.prosecdef,r.nspname==='public',r.proname);
   }
   const indexes=(await f.rows("select indexname from pg_indexes where schemaname='erp_catalog' and indexname like 'erp_catalog_%'")).map(r=>r.indexname);
   for(const name of['erp_catalog_record_entity_created','erp_catalog_record_entity_updated','erp_catalog_record_entity_name_fold','erp_catalog_record_entity_code_fold','erp_catalog_product_gtin','erp_catalog_contact_document_key'])assert.ok(indexes.includes(name),name);
  });

  const ids={};
  await t.test('setup synthetic contacts, products and depósitos',async()=>{
   const contact=async(key,data,at)=>{ids[key]=(await f.save('contacts',data)).id;await f.db.query('update erp_catalog.record set created_at=$2,updated_at=$2 where id=$1',[ids[key],at]);};
   await contact('ana',{name:'Ána Ábaco Comércio',trade_name:'Loja Ábaco',person_type:'J',document:'11.222.333/0001-81',email:'compras@abaco.example',phone:'(19) 3434-1000',city:'São Carlos',state:'SP',roles:['customer']},'2026-10-01T12:00:00Z');
   await contact('bruno',{name:'Bruno Fornecedor',person_type:'F',document:'52998224725',mobile:'19 99876-5432',city:'Piracicaba',state:'sp',roles:['supplier','carrier']},'2026-10-05T12:00:00Z');
   await contact('carla',{name:'carla sem tipo',person_type:'J',document:'12.ABC.345/01DE-35',email:'carla@example.test',roles:[]},'2026-10-10T02:59:59Z');
   await contact('davi',{name:'Davi Transportes',code:'T-9',roles:['carrier'],city:'Campinas',state:'MG'},'2026-10-10T03:00:00Z');
   const product=async(key,data,at)=>{ids[key]=(await f.save('products',data)).id;await f.db.query('update erp_catalog.record set created_at=$2,updated_at=$2 where id=$1',[ids[key],at]);};
   await product('parafuso',{name:'Parafuso Sextavado Inox',code:'PAR-10',gtin:'7891234567895',unit:'UN',kind:'P',format:'S',price:'1.5',ncm:'73181500',brand:'Açoforte'},'2026-10-01T12:00:00Z');
   await product('porca',{name:'Porca Sextavada',code:'par-10',unit:'UN',kind:'P',format:'S',price:'0.25',ncm:'73181600'},'2026-10-02T12:00:00Z');
   await product('arruela',{name:'Arruela Lisa',code:'ARR-2',unit:'UN',kind:'P',format:'S',price:'0.1'},'2026-10-03T12:00:00Z');
   await product('servico',{name:'Serviço de Montagem',kind:'S',unit:'H',price:'80'},'2026-10-04T12:00:00Z');
   await product('kit',{name:'Kit Fixação',code:'KIT-1',unit:'UN',kind:'P',format:'E',gtin:'SEM GTIN'},'2026-10-05T12:00:00Z');
   ids.w1=(await f.save('warehouses',{name:'Geral'})).id;ids.w2=(await f.save('warehouses',{name:'Loja'})).id;
   await f.stock(ids.parafuso,ids.w1,'5');await f.stock(ids.parafuso,ids.w2,'2.5');
   await f.stock(ids.porca,ids.w1,'3');await f.stock(ids.porca,ids.w1,'-3');
   await f.stock(ids.arruela,ids.w2,'1');
  });

  await t.test('default "Últimos incluídos" order, numbered pages with total and stable ordering options',async()=>{
   const first=await f.page('contacts',{p_size:2});
   assert.deepEqual(names(first),['Davi Transportes','carla sem tipo']);
   assert.equal(first.total,4);assert.equal(first.page,1);assert.equal(first.size,2);assert.equal(first.sort,'created_desc');
   assert.deepEqual(names(await f.page('contacts',{p_size:2,p_page:2})),['Bruno Fornecedor','Ána Ábaco Comércio']);
   assert.deepEqual(names(await f.page('contacts',{p_size:2,p_page:3})),[]);
   assert.equal((await f.page('contacts',{p_size:2,p_page:3})).total,4);
   assert.deepEqual(names(await f.page('contacts',{p_sort:'name_asc'})),['Ána Ábaco Comércio','Bruno Fornecedor','carla sem tipo','Davi Transportes'],'accent and case insensitive');
   assert.deepEqual(names(await f.page('contacts',{p_sort:'name_desc'})),['Davi Transportes','carla sem tipo','Bruno Fornecedor','Ána Ábaco Comércio']);
   const ascending=(await f.page('products',{p_sort:'code_asc'})).items.map(i=>i.code);
   assert.deepEqual([ascending[0],ascending[1],ascending.slice(2,4).map(code=>code.toLowerCase()),ascending[4]],['ARR-2','KIT-1',['par-10','par-10'],null]);
   assert.deepEqual((await f.page('products',{p_sort:'code_desc'})).items.map(i=>i.code&&i.code.toLowerCase()),['par-10','par-10','kit-1','arr-2',null],'missing codes always last');
   // Same instant: the UUID tie-breaker keeps both pages disjoint and complete.
   await f.db.query("update erp_catalog.record set created_at='2026-10-01T12:00:00Z' where entity='products'");
   const all=(await f.page('products',{p_size:100})).items.map(i=>i.id);
   const split=[...(await f.page('products',{p_size:2})).items,...(await f.page('products',{p_size:2,p_page:2})).items,...(await f.page('products',{p_size:2,p_page:3})).items].map(i=>i.id);
   assert.deepEqual(split,all);assert.deepEqual([...all].sort().reverse(),all);
   for(const args of[{p_page:0},{p_page:100001},{p_size:0},{p_size:101},{p_sort:'id'},{p_sort:null},{p_query:'x'.repeat(121)},{p_query:'a\u0001'},{p_period:'created'},{p_from:'2026-10-02',p_to:'2026-10-01',p_period:'created'},{p_period:'deleted',p_from:'2026-10-01'}])
    await fails(f.page('contacts',args),'22023');
   for(const args of[{p_role:'admin'},{p_person_type:'X'},{p_state:'sp'},{p_phone:'abc'},{p_city:'x'.repeat(101)}])await fails(f.page('contacts',args),'22023');
   await fails(f.page('warehouses',{p_role:'customer'}),'22023');
   await fails(f.rpc('erp_catalog_page',{p_user_id:f.users.admin,p_entity:'products'}),'22023');
   for(const args of[{p_stock:'some'},{p_ncm:'7318x'},{p_ncm:'73',p_ncm_presence:'missing'},{p_kind:'X'},{p_brand:'x'.repeat(101)}])await fails(f.page('products',args),'22023');
  });

  await t.test('search folds accents and case, matches words in any order and CPF/CNPJ/phone with or without mask',async()=>{
   const search=(entity,q)=>f.page(entity,{p_query:q}).then(names);
   assert.deepEqual(await search('contacts','abaco ana'),['Ána Ábaco Comércio']);
   assert.deepEqual(await search('contacts','LOJA abaco'),['Ána Ábaco Comércio'],'fantasia');
   assert.deepEqual(await search('contacts','compras@abaco'),['Ána Ábaco Comércio'],'e-mail');
   assert.deepEqual(await search('contacts','11222333000181'),['Ána Ábaco Comércio'],'unmasked query, masked document');
   assert.deepEqual(await search('contacts','529.982.247-25'),['Bruno Fornecedor'],'masked query, unmasked document');
   assert.deepEqual(await search('contacts','12abc34501de35'),['carla sem tipo'],'alphanumeric CNPJ');
   assert.deepEqual(await search('contacts','3434-1000'),['Ána Ábaco Comércio'],'phone with mask');
   assert.deepEqual(await search('contacts','19998765432'),['Bruno Fornecedor'],'mobile without mask');
   assert.deepEqual(await search('contacts','t-9'),['Davi Transportes'],'code');
   assert.deepEqual(await search('contacts','bruno ana'),[],'every word must match');
   assert.deepEqual(await search('contacts','%'),[],'no SQL wildcard');
   assert.deepEqual(await search('contacts',"' or 1=1 --"),[]);
   assert.deepEqual(await search('products','sextavad inox'),['Parafuso Sextavado Inox']);
   assert.deepEqual(await search('products','7891234567895'),['Parafuso Sextavado Inox'],'GTIN');
   assert.deepEqual((await search('products','PAR-10')).sort(),['Parafuso Sextavado Inox','Porca Sextavada'],'code, case-insensitive');
   assert.deepEqual(await search('products','servico montagem'),['Serviço de Montagem']);
   // With a search the filter runs once: the total and the pages come from the same filtered set.
   const searched=await Promise.all([1,2,3].map(n=>f.page('products',{p_query:'par-10',p_size:1,p_page:n})));
   assert.deepEqual(searched.map(p=>[p.total,p.items.length]),[[2,1],[2,1],[2,0]]);
   assert.notEqual(searched[0].items[0].id,searched[1].items[0].id);
   assert.deepEqual([(await f.page('contacts',{p_query:'abaco',p_role:'customer'})).total,(await f.page('contacts',{p_query:'abaco',p_role:'supplier'})).total],[1,0],'search and filters combine in the same total');
   // Legacy cursor RPCs keep their contract and gain the same tolerant search.
   const legacy=await f.rpc('erp_catalog_list',{p_user_id:f.users.admin,p_entity:'contacts',p_limit:1,p_query:'FORNECEDOR bruno'});
   assert.deepEqual(Object.keys(legacy).sort(),['data_mode','entity','has_more','items','limit','next_cursor']);
   assert.deepEqual(legacy.items.map(i=>i.name),['Bruno Fornecedor']);assert.equal(legacy.has_more,false);assert.equal(legacy.next_cursor,null);
   assert.ok(['ie','postal_code','street','complement','district'].every(key=>key in legacy.items[0]),'full DTO kept in cursor mode');
   const cursorProducts=await f.rpc('erp_catalog_product_list',{p_user_id:f.users.admin,p_limit:25,p_query:'sextavado parafuso'});
   assert.deepEqual(cursorProducts.items.map(i=>i.name),['Parafuso Sextavado Inox']);
   await fails(f.rpc('erp_catalog_list',{p_user_id:f.users.admin,p_entity:'contacts',p_limit:101}),'22023');
  });

  await t.test('contact filters: tipo de contato, tipo de pessoa, telefone, e-mail, UF, município and São Paulo period',async()=>{
   const list=args=>f.page('contacts',args).then(names);
   assert.deepEqual(await list({p_role:'customer'}),['Ána Ábaco Comércio']);
   assert.deepEqual(await list({p_role:'supplier'}),['Bruno Fornecedor']);
   assert.deepEqual(await list({p_role:'carrier'}),['Davi Transportes','Bruno Fornecedor']);
   assert.deepEqual(await list({p_role:'none'}),['carla sem tipo']);
   assert.deepEqual(await list({p_person_type:'F'}),['Bruno Fornecedor']);
   assert.deepEqual(await list({p_phone:'(19) 99876'}),['Bruno Fornecedor']);
   assert.deepEqual(await list({p_email:'EXAMPLE.TEST'}),['carla sem tipo']);
   assert.deepEqual(await list({p_state:'SP'}),['Bruno Fornecedor','Ána Ábaco Comércio'],'stored UF is compared in upper case');
   assert.deepEqual(await list({p_city:'sao carlos'}),['Ána Ábaco Comércio']);
   assert.deepEqual(await list({p_period:'created',p_to:'2026-10-09'}),['carla sem tipo','Bruno Fornecedor','Ána Ábaco Comércio'],'02:59:59Z is still 09/10 in São Paulo');
   assert.deepEqual(await list({p_period:'created',p_from:'2026-10-10',p_to:'2026-10-10'}),['Davi Transportes']);
   await f.db.query("update erp_catalog.record set updated_at='2026-10-18T15:00:00Z' where id=$1",[ids.ana]);
   assert.deepEqual(await list({p_period:'updated',p_from:'2026-10-18'}),['Ána Ábaco Comércio']);
   assert.deepEqual(names(await f.page('warehouses',{p_sort:'name_asc'})),['Geral','Loja']);
  });

  await t.test('product stock sums depósitos with the 025 rule and keeps "sem lançamentos" apart from zero',async()=>{
   const byName=async(args={})=>Object.fromEntries((await f.page('products',args)).items.map(i=>[i.name,i.stock]));
   const stock=await byName();
   assert.deepEqual(stock['Parafuso Sextavado Inox'],{state:'recorded',quantity:'7.500000',warehouse:null});
   assert.deepEqual(stock['Porca Sextavada'],{state:'recorded',quantity:'0.000000',warehouse:null});
   assert.deepEqual(stock['Serviço de Montagem'],{state:'no_movements',quantity:null,warehouse:null});
   assert.equal((await f.page('products')).stock_visible,true);
   const filtered=async(args)=>(await f.page('products',args)).items.map(i=>i.name).sort();
   assert.deepEqual(await filtered({p_stock:'zero'}),['Porca Sextavada']);
   assert.deepEqual(await filtered({p_stock:'positive'}),['Arruela Lisa','Parafuso Sextavado Inox']);
   assert.deepEqual(await filtered({p_stock:'negative'}),[],'balances never go negative in Brufap');
   assert.deepEqual(await filtered({p_stock:'no_movements'}),['Kit Fixação','Serviço de Montagem']);
   assert.deepEqual(await filtered({p_stock:'positive',p_warehouse_id:ids.w1}),['Parafuso Sextavado Inox']);
   assert.deepEqual(await filtered({p_stock:'no_movements',p_warehouse_id:ids.w1}),['Arruela Lisa','Kit Fixação','Serviço de Montagem']);
   const perWarehouse=await byName({p_warehouse_id:ids.w2});
   assert.deepEqual(perWarehouse['Parafuso Sextavado Inox'],{state:'recorded',quantity:'7.500000',warehouse:{id:ids.w2,state:'recorded',quantity:'2.500000'}});
   assert.deepEqual(perWarehouse['Porca Sextavada'].warehouse,{id:ids.w2,state:'no_movements',quantity:null});
   // A projection that disagrees with the ledger is shown for review and never counted as a quantity.
   await f.db.query('update erp_stock.balance set quantity=quantity+1 where product_id=$1 and warehouse_id=$2',[ids.arruela,ids.w2]);
   assert.deepEqual((await byName())['Arruela Lisa'],{state:'review_required',quantity:null,warehouse:null});
   assert.deepEqual(await filtered({p_stock:'positive'}),['Parafuso Sextavado Inox']);
   await f.db.query('update erp_stock.balance set quantity=quantity-1 where product_id=$1 and warehouse_id=$2',[ids.arruela,ids.w2]);
   await fails(f.page('products',{p_warehouse_id:randomUUID()}),'P0002');
   assert.equal(await f.scalar('select erp_catalog.can_read_stock($1) v',[f.users.financeiro]),false);
   assert.equal(await f.scalar('select erp_catalog.can_read_stock($1) v',[f.users.vendas]),true);
   const product=(await f.page('products',{p_query:'parafuso'})).items[0];
   assert.deepEqual(Object.keys(product).sort(),['active','brand','code','created_at','entity','format','gtin','id','kind','name','ncm','price','source','stock','unit','updated_at','version']);
   assert.equal(product.price,'1.5000');
   const filters=async args=>(await f.page('products',args)).items.map(i=>i.name).sort();
   assert.deepEqual(await filters({p_ncm:'731815'}),['Parafuso Sextavado Inox']);
   assert.deepEqual(await filters({p_ncm_presence:'missing'}),['Arruela Lisa','Kit Fixação','Serviço de Montagem']);
   assert.deepEqual(await filters({p_brand:'acoforte'}),['Parafuso Sextavado Inox']);
   assert.deepEqual(await filters({p_kind:'S'}),['Serviço de Montagem']);
   assert.deepEqual(await filters({p_format:'E'}),['Kit Fixação']);
  });

  await t.test('database role checks: read per entity, check needs write, inactive membership denied',async()=>{
   await fails(f.page('products',{},f.users.financeiro),'42501');
   await fails(f.page('warehouses',{},f.users.vendas),'42501');
   await fails(f.page('contacts',{},f.users.inactive),'42501');
   await fails(f.page('contacts',{},randomUUID()),'42501');
   assert.equal((await f.page('contacts',{},f.users.consulta)).total,4);
   assert.equal((await f.page('products',{},f.users.fiscal)).stock_visible,true);
   await fails(f.check('contacts',{document:'1'},{user:f.users.consulta}),'42501');
   await fails(f.check('products',{code:'X'},{user:f.users.vendas}),'42501');
   assert.deepEqual((await f.check('contacts',{name:'Novo',document:'52998224725'},{user:f.users.vendas})).warnings.map(w=>w.code),['duplicate_document']);
   await fails(f.saveChecked('products',{name:'X'},[],{user:f.users.consulta}),'42501');
   await fails(f.check('warehouses',{name:'X'}),'22023');
   await fails(f.check('contacts',{name:'X'},{id:randomUUID()}),'P0002');
   await fails(f.check('contacts',{unknown:'x'}),'22023');
   // Inactive or missing memberships and read-only profiles are refused by the database itself.
   await fails(f.check('contacts',{name:'X'},{user:f.users.inactive}),'42501');
   await fails(f.saveChecked('contacts',{name:'X'},[],{user:f.users.inactive}),'42501');
   await fails(f.saveChecked('contacts',{name:'X'},[],{user:f.users.estoque}),'42501');
   await fails(f.check('contacts',{name:'X'},{user:f.users.estoque}),'42501');
   await fails(f.page('products',{p_stock:'zero'},randomUUID()),'42501');
   await fails(f.page('warehouses',{},f.users.inactive),'42501');
   await fails(f.rpc('erp_catalog_list',{p_user_id:f.users.inactive,p_entity:'contacts'}),'42501');
   await fails(f.rpc('erp_catalog_product_list',{p_user_id:f.users.financeiro}),'42501');
  });

  await t.test('warnings: duplicate code/GTIN/document and CPF/CNPJ check digits only for new or changed values',async()=>{
   const codes=value=>value.warnings.map(w=>w.code);
   const dup=await f.check('products',{name:'Novo',code:'Par-10',gtin:'7891234567895'});
   assert.deepEqual(codes(dup),['duplicate_code','duplicate_gtin']);
   assert.equal(dup.warnings[0].total,2);assert.deepEqual(dup.warnings[0].matches.map(m=>m.name).sort(),['Parafuso Sextavado Inox','Porca Sextavada']);
   assert.deepEqual(Object.keys(dup.warnings[0].matches[0]).sort(),['active','code','id','name']);
   assert.deepEqual(codes(await f.check('products',{name:'Novo',gtin:'SEM GTIN'})),[]);
   // Legacy duplicate: editing anything else (or resubmitting the same code) is not blocked.
   assert.deepEqual(codes(await f.check('products',{name:'Parafuso renomeado',code:'PAR-10'},{id:ids.parafuso})),[]);
   assert.deepEqual(codes(await f.check('products',{code:'ARR-2'},{id:ids.parafuso})),['duplicate_code']);
   assert.deepEqual(codes(await f.check('products',{code:'ARR-2'},{id:ids.arruela})),[],'own record is not a duplicate');
   assert.deepEqual((await f.check('contacts',{document:'529.982.247-24',person_type:'F'})).warnings,[{code:'invalid_document',field:'document',expected:'cpf'}]);
   assert.deepEqual((await f.check('contacts',{document:'11.222.333/0001-82',person_type:'J'})).warnings,[{code:'invalid_document',field:'document',expected:'cnpj'}]);
   assert.deepEqual((await f.check('contacts',{document:'52998224725',person_type:'J'})).warnings.map(w=>[w.code,w.expected]),[['invalid_document','cnpj'],['duplicate_document',undefined]]);
   assert.deepEqual(codes(await f.check('contacts',{document:'AB-1234',person_type:'E'})),[],'estrangeiro has no CPF/CNPJ check');
   assert.deepEqual((await f.check('contacts',{document:'123'})).warnings,[{code:'invalid_document',field:'document',expected:'document'}]);
   assert.deepEqual(codes(await f.check('contacts',{document:'12ABC34501DE35'})),['duplicate_document'],'valid alphanumeric CNPJ, same key as the masked one');
   assert.deepEqual(codes(await f.check('contacts',{document:'11222333000181'},{id:ids.ana})),[],'remasking the own document is not a change');
   assert.deepEqual(codes(await f.check('contacts',{person_type:'F'},{id:ids.ana})),['invalid_document'],'changing the person type rechecks the stored document');
   assert.deepEqual(codes(await f.check('contacts',{name:'Sem documento'})),[]);
  });

  await t.test('CPF/CNPJ check digits agree with packages/fiscal-core and an independent CPF reference',async()=>{
   const next=random(96),alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',cnpjs=[],cpfs=[];
   for(let i=0;i<150;i++){
    const alpha=i%3===0,base=Array.from({length:12},(_,j)=>alpha&&j<8?alphabet[Math.floor(next()*36)]:String(Math.floor(next()*10))).join('');
    const valid=base+cnpjCheckDigits(base);cnpjs.push(valid,valid.slice(0,13)+String((Number(valid[13])+1)%10),base.slice(0,11)+'X'+valid.slice(12));
    const nine=Array.from({length:9},()=>String(Math.floor(next()*10))).join(''),good=cpf(nine);cpfs.push(good,good.slice(0,10)+String((Number(good[10])+3)%10));
   }
   cnpjs.push('00000000000000','11111111111111','1122233300018','A1222333000181');cpfs.push('00000000000','11111111111','5299822472','5299822472a');
   const sqlCnpj=await f.rows('select v,erp_catalog.valid_cnpj(v) ok from unnest($1::text[]) v',[cnpjs]);
   for(const row of sqlCnpj)assert.equal(row.ok,isValidCnpj(row.v),row.v);
   const sqlCpf=await f.rows('select v,erp_catalog.valid_cpf(v) ok from unnest($1::text[]) v',[cpfs]);
   for(const row of sqlCpf)assert.equal(row.ok,cpfValid(row.v),row.v);
   assert.ok(sqlCnpj.filter(r=>r.ok).length>=150&&sqlCpf.filter(r=>r.ok).length>=150);
  });

  await t.test('save with confirmed warnings: refuses a new warning, audits the confirmation and replays by command',async()=>{
   const before=await f.scalar('select count(*)::int v from erp_catalog.record');
   const command=randomUUID(),data={name:'Parafuso clonado',code:'PAR-10',unit:'UN'};
   await fails(f.saveChecked('products',data,[],{command}),'40001');
   await fails(f.saveChecked('products',data,['duplicate_gtin'],{command}),'40001');
   assert.equal(await f.scalar('select count(*)::int v from erp_catalog.record'),before);
   assert.equal(await f.scalar('select count(*)::int v from erp_catalog.command where command_id=$1',[command]),0,'refused command can be retried');
   const saved=await f.saveChecked('products',data,['duplicate_code'],{command});
   assert.equal(saved.replayed,false);assert.equal(saved.record.code,'PAR-10');
   const audit=await f.rows('select action,after_data from erp_catalog.audit where command_id=$1 order by id',[command]);
   assert.deepEqual(audit.map(a=>a.action),['create','warnings_acknowledged']);
   assert.deepEqual(audit[1].after_data,{warnings:['duplicate_code']});
   const replay=await f.saveChecked('products',data,[],{command});
   assert.equal(replay.replayed,true);assert.equal(replay.record.id,saved.record.id);
   await fails(f.saveChecked('products',{...data,name:'Outro'},['duplicate_code'],{command}),'40001');
   // No warning: confirmation list may be empty; the update keeps CAS.
   const updated=await f.saveChecked('products',{name:'Parafuso clonado 2',code:'PAR-10'},[],{id:saved.record.id,version:1});
   assert.equal(updated.record.version,2);
   await fails(f.saveChecked('products',{name:'Versão antiga'},[],{id:saved.record.id,version:1}),'40001');
   await fails(f.saveChecked('products',{name:'X'},[],{id:randomUUID(),version:1}),'P0002');
   for(const ack of[null,{},['duplicate_code','duplicate_code'],['other'],[1],['duplicate_code','duplicate_gtin','invalid_document','duplicate_document','x']])
    await fails(f.saveChecked('products',{name:'X'},ack),'22023');
   await fails(f.saveChecked('warehouses',{name:'X'},[]),'22023');
   const contact=await f.saveChecked('contacts',{name:'Documento inválido',document:'123',person_type:'F',roles:[]},['invalid_document']);
   assert.equal(contact.record.document,'123','the document is stored exactly as typed');
   assert.deepEqual((await f.rows("select after_data from erp_catalog.audit where action='warnings_acknowledged' and record_id=$1",[contact.record.id]))[0].after_data,{warnings:['invalid_document']});
  });

  await t.test('page and check run inside a read-only transaction and change nothing',async()=>{
   const before=await f.scalar("select jsonb_agg(to_jsonb(r) order by r.id)::text v from erp_catalog.record r");
   await f.db.exec('begin read only');
   try{
    assert.ok((await f.page('products',{p_stock:'positive',p_query:'parafuso'})).total>=1);
    assert.ok((await f.page('contacts',{p_role:'customer',p_sort:'code_desc'})).total>=1);
    assert.equal((await f.check('products',{code:'PAR-10'})).warnings[0].code,'duplicate_code');
   }finally{await f.db.exec('rollback');}
   assert.equal(await f.scalar("select jsonb_agg(to_jsonb(r) order by r.id)::text v from erp_catalog.record r"),before);
  });
 }finally{await f.close();}
});
