import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {productRegistryFixture,fails} from './helpers/product-registry-fixture.mjs';

// Migrations 202610200119 (taxonomia e detalhe do produto) e 202610200120 (listagem v2 e exportação), com dados sintéticos.
const PUBLIC=['erp_catalog_taxonomy_list','erp_catalog_taxonomy_save','erp_catalog_taxonomy_delete','erp_catalog_product_get','erp_catalog_product_save',
 'erp_catalog_product_set_deleted','erp_catalog_product_list','erp_catalog_product_page_v2','erp_catalog_product_export'];
const names=page=>page.items.map(item=>item.name);

test('119/120 product registry: ACL, taxonomy, detail save, deleted products and the v2 list',async t=>{
 const f=await productRegistryFixture();
 const v2=(args={},user=f.users.admin)=>f.rpc('erp_catalog_product_page_v2',{p_user_id:user,...args});
 try{
  await t.test('public RPCs are SECURITY DEFINER, service-only, fixed search_path; helpers and tables stay private',async()=>{
   const rs=await f.rows(`select p.proname,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE') service,
     has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('public',p.oid,'EXECUTE') everyone
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1)`,[PUBLIC]);
   assert.equal(rs.length,PUBLIC.length);
   for(const r of rs){assert.equal(r.prosecdef,true,r.proname);assert.deepEqual(r.proconfig,['search_path=pg_catalog'],r.proname);
    assert.equal(r.service,true,r.proname);assert.equal(r.anon,false,r.proname);assert.equal(r.auth,false,r.proname);assert.equal(r.everyone,false,r.proname);}
   const helpers=await f.rows(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_catalog'
     and p.proname in('taxonomy_spec','taxonomy_item','taxonomy_detach','product_detail_validate','product_detail_data','product_full','product_detail_write','product_filter_sql','product_list_item')
     and(has_function_privilege('service_role',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or not p.proconfig@>array['search_path=pg_catalog'])`);
   assert.deepEqual(helpers,[]);
   for(const table of['taxonomy','taxonomy_audit','product_detail','product_dun','product_supplier','product_tag','product_image']){
    assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_catalog.${table}','SELECT') or has_table_privilege('authenticated','erp_catalog.${table}','SELECT') v`),false,table);
    assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='erp_catalog.${table}'::regclass`),true,table);
   }
  });

  const ids={};
  await t.test('taxonomy: create, unique names per parent, fixed parent, permissions, idempotent commands and CAS',async()=>{
   const command=randomUUID();
   const root=await f.taxonomySave('categories',{name:'Ferragens'},{command});
   assert.equal(root.saved,true);ids.root=root.item.id;
   assert.deepEqual(await f.taxonomySave('categories',{name:'Ferragens'},{command}),{...root,replayed:true});
   await fails(assert,f.taxonomySave('categories',{name:'Outra'},{command}),'40001');
   const child=await f.taxonomySave('categories',{name:'Parafusos',parent_id:ids.root});ids.child=child.item.id;
   assert.equal(child.item.parent_id,ids.root);
   assert.deepEqual((await f.taxonomySave('categories',{name:'FERRÁGENS'})).reason,'duplicate_name','accent and case insensitive');
   assert.equal((await f.taxonomySave('categories',{name:'Ferragens',parent_id:ids.root})).saved,true,'same name under another parent');
   await fails(assert,f.taxonomySave('categories',{name:'x'.repeat(51)}),'22023');
   await fails(assert,f.taxonomySave('categories',{name:'  '}),'22023');
   await fails(assert,f.taxonomySave('categories',{name:'A',color:'x'}),'22023');
   await fails(assert,f.taxonomySave('categories',{name:'A',parent_id:randomUUID()}),'22023');
   await fails(assert,f.taxonomySave('nope',{name:'A'}),'22023');
   const group=await f.taxonomySave('tag_groups',{name:'Cores'});ids.tagGroup=group.item.id;
   await fails(assert,f.taxonomySave('tag_groups',{name:'Sub',parent_id:ids.tagGroup}),'22023');
   await fails(assert,f.taxonomySave('tags',{name:'Azul',parent_id:ids.root}),'22023','a tag group must be a tag group');
   ids.blue=(await f.taxonomySave('tags',{name:'Azul',parent_id:ids.tagGroup})).item.id;
   ids.loose=(await f.taxonomySave('tags',{name:'Promoção'})).item.id;
   ids.group=(await f.taxonomySave('product_groups',{name:'Fixadores'})).item.id;
   const renamed=await f.taxonomySave('categories',{name:'Ferragens e Fixação'},{id:ids.root,version:1});
   assert.equal(renamed.item.version,2);
   await fails(assert,f.taxonomySave('categories',{name:'Outro'},{id:ids.root,version:1}),'40001');
   await fails(assert,f.taxonomySave('categories',{name:'Outro',parent_id:ids.child},{id:ids.root,version:2}),'22023');
   for(const role of['consulta','vendas','fiscal'])await fails(assert,f.taxonomySave('categories',{name:'Nova'},{user:f.users[role]}),'42501');
   await fails(assert,f.taxonomySave('categories',{name:'Nova'},{user:f.users.inactive}),'42501');
   assert.equal((await f.taxonomySave('categories',{name:'Estoque'},{user:f.users.estoque})).saved,true);
   await fails(assert,f.taxonomy('categories',f.users.financeiro),'42501');
   const list=await f.taxonomy('categories',f.users.consulta);
   assert.deepEqual(list.items.map(i=>i.name),['Estoque','Ferragens','Ferragens e Fixação','Parafusos']);
   assert.equal(list.items.find(i=>i.id===ids.root).children,2);
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.taxonomy_audit where kind='categories'"),5);
  });

  await t.test('product save: detail, lists and active in one command, version and audit; strict validation',async()=>{
   ids.supplier=(await f.save('contacts',{name:'Fornecedor Sintético',roles:['supplier']})).id;
   ids.other=(await f.save('contacts',{name:'Outro Fornecedor',roles:[]})).id;
   const data={name:'Parafuso Inox',code:'PAR-1',price:'1.5',unit:'UN',kind:'P',format:'S',expiry_date:'2027-02-28',free_shipping:true,
    discreet_description:'Peça metálica',complementary_description:'Linha 1\nLinha 2',external_link:'https://exemplo.test/p',video_url:'http://exemplo.test/v',
    notes:'Obs\tcom tab',crossdocking_days:'3',category_id:ids.child,product_group_id:ids.group,fci_number:'b01f70af-10bf-4b1f-848c-65ff57f616fe',item_type:'00',
    tax_percent:'12.5',icms_st_retention_base:'10',icms_st_retention_value:'1.8',icms_own_substitute_value:'0.5',ipi_tipi_exception:'01',ipi_framework_class:'999',
    ipi_fixed_value:'0.1234',ipi_seal_code:'971-001',pis_fixed_value:'0.01',cofins_fixed_value:'0.05',anp_code:'210203001',anp_description:'GLP',
    glp_percent:'100',glgnn_percent:'0',glgni_percent:'0',starting_value:'99.9',
    dun_codes:[{code:'17891234567892',quantity:'12'}],tag_ids:[ids.loose,ids.blue],images:[{url:'https://exemplo.test/a.png'},{url:'https://exemplo.test/b.webp'}],
    suppliers:[{supplier_id:ids.supplier,description:'Parafuso no fornecedor',code:'F-1',purchase_price:'1.2',cost_price:'1.3456789012',warranty_months:'12',is_default:true},
     {supplier_id:ids.other,is_default:false}]};
   const command=randomUUID();
   const saved=await f.productSave(data,{command});
   const r=saved.record;ids.p1=r.id;
   assert.equal(r.version,1);assert.equal(r.active,true);assert.equal(r.price,'1.5000');
   assert.equal(r.expiry_date,'2027-02-28');assert.equal(r.free_shipping,true);assert.equal(r.fci_number,'B01F70AF-10BF-4B1F-848C-65FF57F616FE');
   assert.equal(r.tax_percent,'12.5000');assert.equal(r.icms_st_retention_base,'10.00');assert.equal(r.ipi_fixed_value,'0.1234');assert.equal(r.glp_percent,'100.0000');
   assert.equal(r.crossdocking_days,'3');assert.deepEqual(r.dun_codes,[{code:'17891234567892',quantity:'12.000000'}]);
   assert.deepEqual(r.tag_ids,[ids.loose,ids.blue].sort());assert.deepEqual(r.images.map(i=>i.url),['https://exemplo.test/a.png','https://exemplo.test/b.webp']);
   assert.equal(r.suppliers[0].cost_price,'1.3456789012');assert.equal(r.suppliers[0].purchase_price,'1.2000');assert.equal(r.suppliers[0].supplier_name,'Fornecedor Sintético');
   assert.equal(r.suppliers[1].purchase_price,null);assert.equal(r.cost_price,'1.3456789012');
   assert.deepEqual(await f.productSave(data,{command}),{...saved,replayed:true});
   assert.deepEqual((await f.productGet(ids.p1,f.users.consulta)).record,r);
   const dto=await f.rpc('erp_catalog_get',{p_user_id:f.users.admin,p_entity:'products',p_id:ids.p1});
   assert.equal(dto.record.suppliers,undefined,'the document snapshot (dto) does not grow');
   // Unchanged save keeps the version; a detail-only change bumps it; base-only keeps the detail.
   assert.equal((await f.productSave({notes:'Obs\tcom tab'},{id:ids.p1,version:1})).record.version,1);
   const second=await f.productSave({notes:null,tag_ids:[]},{id:ids.p1,version:1});
   assert.equal(second.record.version,2);assert.equal(second.record.notes,null);assert.deepEqual(second.record.tag_ids,[]);assert.equal(second.record.dun_codes.length,1);
   const third=await f.productSave({price:'2'},{id:ids.p1,version:2});
   assert.equal(third.record.price,'2.0000');assert.equal(third.record.expiry_date,'2027-02-28');assert.equal(third.record.suppliers.length,2);
   const inactive=await f.productSave({active:false,notes:'Inativo continua editável'},{id:ids.p1,version:3});
   assert.equal(inactive.record.active,false);assert.equal(inactive.record.version,4);
   assert.equal((await f.productSave({notes:'Editado inativo'},{id:ids.p1,version:4})).record.version,5);
   await fails(assert,f.productSave({notes:'x'},{id:ids.p1,version:4}),'40001');
   const actions=(await f.rows("select action from erp_catalog.audit where record_id=$1 order by id",[ids.p1])).map(a=>a.action);
   assert.deepEqual(actions,['create','update','update','update','update']);
   // Only the "Ativado" switch: the same audit actions as Ativar/Inativar (erp_catalog_set_active).
   assert.equal((await f.productSave({active:true},{id:ids.p1,version:5})).record.version,6);
   const archived=await f.productSave({active:false},{id:ids.p1,version:6});
   assert.deepEqual([archived.record.active,archived.record.version],[false,7]);
   assert.deepEqual((await f.rows("select action from erp_catalog.audit where record_id=$1 order by id desc limit 2",[ids.p1])).map(a=>a.action),['archive','restore']);
   const audit=await f.rows("select before_data,after_data from erp_catalog.audit where record_id=$1 and action='update' order by id limit 1",[ids.p1]);
   assert.equal(audit[0].before_data.notes,'Obs\tcom tab');assert.equal(audit[0].after_data.notes,null);
   for(const bad of[{expiry_date:'2027-02-30'},{expiry_date:'27-02-01'},{free_shipping:'sim'},{external_link:'ftp://x.test'},{video_url:'https://'+'v'.repeat(100)},
    {crossdocking_days:'10000'},{fci_number:'nao-e-fci'},{item_type:'11'},{tax_percent:'100.01'},{tax_percent:'1.23456'},{icms_st_retention_base:'1.234'},
    {ipi_framework_class:'99'},{anp_code:'12345678'},{dun_codes:[{code:'123',quantity:'1'}]},{dun_codes:[{code:'17891234567892',quantity:'0'}]},
    {dun_codes:[{code:'17891234567892',quantity:'1'},{code:'17891234567892',quantity:'2'}]},{tag_ids:[ids.blue,ids.blue]},{tag_ids:[ids.root]},
    {images:[{url:'http://inseguro.test/a.png'}]},{images:[{url:'https://a.test/x y.png'}]},{suppliers:[{supplier_id:ids.supplier,is_default:true},{supplier_id:ids.other,is_default:true}]},
    {suppliers:[{supplier_id:ids.supplier,is_default:false},{supplier_id:ids.supplier,is_default:false}]},{suppliers:[{supplier_id:ids.p1,is_default:false}]},
    {suppliers:[{supplier_id:ids.supplier}]},{suppliers:[{supplier_id:ids.supplier,is_default:false,cost_price:'1.12345678901'}]},
    {category_id:ids.group},{product_group_id:ids.child},{category_id:randomUUID()},{notes:'x'.repeat(2001)},{discreet_description:'a\u0001'},{unknown_field:'x'},{active:'true'}])
    await fails(assert,f.productSave({name:'Inválido',...bad}),'22023');
   await fails(assert,f.productSave({}),'22023');
   for(const role of['consulta','vendas','financeiro','fiscal'])await fails(assert,f.productSave({name:'Sem acesso'},{user:f.users[role]}),'42501');
   assert.equal((await f.productSave({name:'Pelo estoque'},{user:f.users.estoque})).record.name,'Pelo estoque');
  });

  await t.test('confirmed warnings and the legacy save keep their contracts',async()=>{
   await fails(assert,f.productSave({name:'Duplicado',code:'par-1'},{acknowledged:[]}),'40001');
   const confirmed=await f.productSave({name:'Duplicado',code:'par-1'},{acknowledged:['duplicate_code']});
   assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where record_id=$1 and action='warnings_acknowledged'",[confirmed.record.id]),1);
   await fails(assert,f.productSave({name:'X'},{acknowledged:['duplicate_document']}),'22023');
   // A command first sent through erp_catalog_save replays through the product save (same identity).
   const command=randomUUID();
   const legacy=await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:command,p_data:{name:'Legado'}});
   assert.deepEqual(await f.productSave({name:'Legado'},{command}),{...legacy,replayed:true});
  });

  await t.test('deleting a category or tag detaches products with a new version and audit; groups in use are refused',async()=>{
   const before=await f.productGet(ids.p1);
   await fails(assert,f.taxonomyDelete('categories',ids.root,1),'40001','the version of the category is checked');
   assert.equal((await f.taxonomyDelete('categories',ids.root,2)).reason,'has_children');
   assert.equal((await f.taxonomyDelete('product_groups',ids.group,1)).reason,'in_use');
   assert.equal((await f.taxonomyDelete('tag_groups',ids.tagGroup,1)).reason,'has_children');
   const tag=await f.productSave({tag_ids:[ids.blue]},{id:ids.p1,version:before.record.version});
   const command=randomUUID();
   const removed=await f.taxonomyDelete('categories',ids.child,1,{command});
   assert.deepEqual([removed.deleted,removed.products],[true,1]);
   assert.deepEqual(await f.taxonomyDelete('categories',ids.child,1,{command}),{...removed,replayed:true});
   const after=await f.productGet(ids.p1);
   assert.equal(after.record.category_id,null);assert.equal(after.record.version,tag.record.version+1);
   assert.equal((await f.taxonomyDelete('tags',ids.blue,1)).products,1);
   const last=await f.productGet(ids.p1);
   assert.deepEqual(last.record.tag_ids,[]);assert.equal(last.record.version,after.record.version+1);
   assert.deepEqual((await f.rows("select action from erp_catalog.audit where record_id=$1 and action like '%removed' order by id",[ids.p1])).map(r=>r.action),['category_removed','tag_removed']);
   assert.equal((await f.taxonomyDelete('tag_groups',ids.tagGroup,1)).deleted,true);
   await fails(assert,f.taxonomyDelete('tags',ids.blue,1),'P0002');
  });

  await t.test('deleted products: logical delete and restore, read-only, out of the legacy picker and of the default situations',async()=>{
   ids.p2=(await f.productSave({name:'Arruela',code:'ARR'})).record.id;
   const command=randomUUID();
   const deleted=await f.setDeleted(ids.p2,1,true,{command});
   assert.equal(deleted.record.active,false);assert.ok(deleted.record.deleted_at);assert.equal(deleted.record.version,2);
   assert.deepEqual(await f.setDeleted(ids.p2,1,true,{command}),{...deleted,replayed:true});
   await fails(assert,f.productSave({notes:'x'},{id:ids.p2,version:2}),'40001');
   // Every other write path refuses a deleted product too (trigger on the record): legacy save, Ativar, confirmed warnings.
   await fails(assert,f.rpc('erp_catalog_set_active',{p_user_id:f.users.admin,p_entity:'products',p_id:ids.p2,p_expected_version:2,p_command_id:randomUUID(),p_active:true}),'40001');
   await fails(assert,f.save('products',{price:'9'},{id:ids.p2,version:2}),'40001');
   await fails(assert,f.rpc('erp_catalog_save_checked',{p_user_id:f.users.admin,p_entity:'products',p_id:ids.p2,p_expected_version:2,p_command_id:randomUUID(),p_data:{code:'NOVO'},p_acknowledged:[]}),'40001');
   assert.equal(await f.scalar("select current_setting('erp_catalog.product_lifecycle',true) v"),'','the bypass never outlives the lifecycle call');
   const legacy=await f.rpc('erp_catalog_product_list',{p_user_id:f.users.admin,p_limit:100});
   assert.ok(!legacy.items.some(i=>i.id===ids.p2),'deleted products leave the document pickers');
   assert.ok(!names(await v2()).includes('Arruela'));assert.ok(!names(await v2({p_situation:'inactive'})).includes('Arruela'));
   assert.deepEqual(names(await v2({p_situation:'deleted'})),['Arruela']);
   const item=(await v2({p_situation:'deleted'})).items[0];assert.equal(item.deleted,true);
   const restored=await f.setDeleted(ids.p2,2,false);
   assert.equal(restored.record.active,true);assert.equal(restored.record.deleted_at,null);
   assert.deepEqual((await f.rows("select action from erp_catalog.audit where record_id=$1 order by id",[ids.p2])).map(r=>r.action),['create','delete','undelete']);
   await fails(assert,f.setDeleted(ids.p2,1,true),'40001');
   await fails(assert,f.setDeleted(ids.p2,3,true,{user:f.users.consulta}),'42501');
   const active=await f.rpc('erp_catalog_set_active',{p_user_id:f.users.admin,p_entity:'products',p_id:ids.p2,p_expected_version:3,p_command_id:randomUUID(),p_active:false});
   assert.equal(active.record.active,false);
  });

  await t.test('v2 list: Origin filters, lean items with the custom columns, period types and stock rules',async()=>{
   const cat=(await f.taxonomySave('categories',{name:'Elétrica'})).item.id;
   const tag=(await f.taxonomySave('tags',{name:'Destaque'})).item.id;
   const serv=(await f.productSave({name:'Montagem',kind:'S',item_type:'09',category_id:cat,tag_ids:[tag],expiry_date:'2026-12-31',
    suppliers:[{supplier_id:ids.supplier,code:'MONT-Ábc',is_default:true,cost_price:'5'}],stock_min:'1',stock_max:'10',location:'Corredor 4'})).record;
   const kit=(await f.productSave({name:'Kit',kind:'P',format:'E'})).record;
   const page=await v2({p_size:100});
   assert.ok(page.items.every(i=>typeof i.deleted==='boolean'));
   const row=page.items.find(i=>i.id===serv.id);
   assert.deepEqual([row.stock_min,row.stock_max,row.location,row.cost_price,row.category_id,row.expiry_date,row.thumbnail],['1.000000','10.000000','Corredor 4','5.0000',cat,'2026-12-31',null]);
   assert.equal(page.items.find(i=>i.id===ids.p1).thumbnail,'https://exemplo.test/a.png');
   assert.deepEqual(names(await v2({p_category:cat})),['Montagem']);
   assert.ok(!names(await v2({p_category:'none'})).includes('Montagem'));
   assert.deepEqual(names(await v2({p_tag:tag})),['Montagem']);
   assert.ok(!names(await v2({p_tag:'none'})).includes('Montagem'));
   assert.deepEqual(names(await v2({p_item_type:'09'})),['Montagem']);
   assert.deepEqual(names(await v2({p_product_type:'services'})),['Montagem']);
   assert.deepEqual(names(await v2({p_product_type:'composition'})),['Kit']);
   assert.ok(!names(await v2({p_product_type:'no_composition'})).includes('Kit'));
   assert.deepEqual(names(await v2({p_product_type:'variations'})),[]);
   assert.deepEqual(names(await v2({p_images:'yes'})),['Parafuso Inox']);
   assert.ok(!names(await v2({p_images:'no'})).includes('Parafuso Inox'));
   assert.deepEqual(names(await v2({p_supplier_id:ids.supplier})).sort(),['Montagem','Parafuso Inox']);
   assert.deepEqual(names(await v2({p_supplier_code:'mont-abc'})),['Montagem'],'supplier code folds accents and case');
   assert.deepEqual(names(await v2({p_period:'expiry',p_from:'2026-12-31',p_to:'2026-12-31'})),['Montagem']);
   assert.deepEqual(names(await v2({p_period:'expiry',p_to:'2027-02-28'})).sort(),['Montagem','Parafuso Inox']);
   await f.db.query("update erp_catalog.record set updated_at='2026-10-10T02:59:59Z' where id=$1",[kit.id]);
   assert.deepEqual(names(await v2({p_period:'updated',p_from:'2026-10-09',p_to:'2026-10-09'})),['Kit'],'São Paulo date of updated_at');
   assert.deepEqual(names(await v2({p_situation:'active',p_query:'kit'})),['Kit']);
   for(const args of[{p_situation:'all'},{p_situation:null},{p_product_type:'kits'},{p_images:'sim'},{p_tag:'x'},{p_category:'todas'},{p_item_type:'11'},
    {p_supplier_code:'x'.repeat(61)},{p_period:'expiry'},{p_period:'deleted',p_from:'2026-01-01'},{p_from:'2026-01-02',p_to:'2026-01-01',p_period:'expiry'},
    {p_ncm:'73',p_ncm_presence:'missing'},{p_size:101},{p_page:0},{p_sort:'price'}])await fails(assert,v2(args),'22023');
   await fails(assert,v2({},f.users.financeiro),'42501');
   const w=(await f.save('warehouses',{name:'Geral'})).id;
   const nut=(await f.productSave({name:'Porca',kind:'P',format:'S',unit:'UN'})).record;
   await f.stock(nut.id,w,'2');
   assert.deepEqual(names(await v2({p_stock:'positive'})),['Porca']);
   assert.deepEqual(names(await v2({p_stock:'positive',p_warehouse_id:w})),['Porca']);
   assert.equal((await v2({},f.users.vendas)).stock_visible,true,'product and stock readers are the same profiles today');
  });

  await t.test('export reads the same filters in batches of at most 250, with deleted products only on request',async()=>{
   const exp=(args={},user=f.users.admin)=>f.rpc('erp_catalog_product_export',{p_user_id:user,...args});
   const all=await exp();
   assert.equal(all.total,(await v2()).total);
   const row=all.items.find(i=>i.id===ids.p1);
   assert.equal(row.supplier.name,'Fornecedor Sintético');assert.deepEqual(row.images,['https://exemplo.test/a.png','https://exemplo.test/b.webp']);
   assert.equal(row.source,undefined);assert.equal(row.suppliers,undefined);
   await f.setDeleted(ids.p1,(await f.productGet(ids.p1)).record.version,true);
   assert.ok(!(await exp()).items.some(i=>i.id===ids.p1));
   assert.ok((await exp({p_include_deleted:true})).items.some(i=>i.id===ids.p1));
   assert.equal((await exp({p_limit:1,p_offset:1})).items.length,1);
   for(const args of[{p_limit:251},{p_limit:0},{p_offset:-1},{p_include_deleted:null}])await fails(assert,exp(args),'22023');
   await fails(assert,exp({},f.users.financeiro),'42501');
  });

  await t.test('Código do produto Sequencial: a new product without code gets the next number; Manual keeps it empty',async()=>{
   assert.equal((await f.productSave({name:'Manual sem código'})).record.code,null);
   await f.productSave({name:'Numérico',code:'0041'});
   const set=await f.rpc('erp_preferences_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_page:'cadastros-produtos',p_changes:[{key:'produtos.codigo',expected_version:0,value:'sequencial'}]});
   assert.ok(set);
   assert.equal((await f.productSave({name:'Sequencial 1'})).record.code,'42');
   assert.equal((await f.productSave({name:'Sequencial 2',code:''})).record.code,'43');
   assert.equal((await f.productSave({name:'Com código',code:'X-1'})).record.code,'X-1','an informed code is kept');
   assert.equal((await f.save('products',{name:'Pela rota antiga'})).code,null,'only the product form route numbers the code');
  });
 }finally{await f.close();}
});
