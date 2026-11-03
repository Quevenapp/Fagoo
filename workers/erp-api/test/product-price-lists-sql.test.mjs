import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {productRegistryFixture,fails} from './helpers/product-registry-fixture.mjs';

// Migration 202610200121 (Listas de preços) with synthetic data.
const PUBLIC=['erp_pricing_lists','erp_pricing_list_get','erp_pricing_list_save','erp_pricing_list_items','erp_pricing_list_delete','erp_pricing_list_clone','erp_pricing_product_lists'];
const base={name:'Atacado',category:'other',list_type:'rates',factor:'10',factor_unit:'percent',direction:'discount',considers_datetime:false,starts_on:null,ends_on:null,start_time:null,end_time:null,contacts:[],regions:[]};

test('121 price lists: ACL, exact list prices, bindings, items, custom adjust, clone and delete',async t=>{
 const f=await productRegistryFixture();
 const save=(data,{id=null,version=0,command=randomUUID(),user=f.users.admin}={})=>f.rpc('erp_pricing_list_save',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:command,p_data:data});
 const items=(id,version,change,{command=randomUUID(),user=f.users.admin}={})=>f.rpc('erp_pricing_list_items',{p_user_id:user,p_id:id,p_expected_version:version,p_command_id:command,p_change:change});
 const get=(id,args={},user=f.users.admin)=>f.rpc('erp_pricing_list_get',{p_user_id:user,p_id:id,...args});
 try{
  await t.test('public RPCs are service-only SECURITY DEFINER with fixed search_path; tables private',async()=>{
   const rs=await f.rows(`select p.proname,p.prosecdef,p.proconfig,has_function_privilege('service_role',p.oid,'EXECUTE') s,has_function_privilege('authenticated',p.oid,'EXECUTE') a,has_function_privilege('anon',p.oid,'EXECUTE') n
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=any($1)`,[PUBLIC]);
   assert.equal(rs.length,PUBLIC.length);
   for(const r of rs){assert.equal(r.prosecdef,true);assert.deepEqual(r.proconfig,['search_path=pg_catalog']);assert.deepEqual([r.s,r.a,r.n],[true,false,false],r.proname);}
   for(const table of['price_list','price_list_item','price_list_contact','price_list_region','command','audit'])
    assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_pricing.${table}','SELECT') v`),false,table);
  });
  const ids={};
  await t.test('save: validation, unique folded names, CAS, idempotent commands and bindings',async()=>{
   ids.p1=(await f.productSave({name:'Parafuso',code:'P1',price:'10.1250'})).record.id;
   ids.p2=(await f.productSave({name:'Porca',code:'P2',price:'0.3333333333'})).record.id;
   ids.free=(await f.productSave({name:'Sem preço'})).record.id;
   ids.contact=(await f.save('contacts',{name:'Cliente sintético',roles:['customer']})).id;
   const command=randomUUID();
   const created=await save(base,{command});
   assert.equal(created.saved,true);ids.list=created.list.id;
   assert.deepEqual([created.list.rule,created.list.factor,created.list.products],['Desconto 10 %','10.0000',0]);
   assert.deepEqual(await save(base,{command}),{...created,replayed:true});
   await fails(assert,save({...base,name:'Outra'},{command}),'40001');
   assert.equal((await save({...base,name:'ATACADO'})).reason,'duplicate_name');
   for(const bad of[{factor:null},{factor:'0'},{factor:'101'},{factor:'1.23456'},{category:'store'},{category:'seller',contacts:[ids.contact]},{list_type:'x'},{list_type:'period'},{starts_on:'2026-02-30',list_type:'period'},
    {starts_on:'2026-10-02',ends_on:'2026-10-01'},{start_time:'10:00'},{contacts:[ids.contact]},{category:'contact',contacts:['x']},{category:'region',regions:['XX']},{name:''},{extra:1}])
    await fails(assert,save({...base,name:'Inválida',...bad}),'22023');
   const updated=await save({...base,category:'contact',contacts:[ids.contact],factor:'15',direction:'increase'},{id:ids.list,version:1});
   assert.deepEqual([updated.list.version,updated.list.rule,updated.list.contacts.map(c=>c.name)],[2,'Acréscimo 15 %',['Cliente sintético']]);
   assert.equal((await save({...base,category:'contact',contacts:[ids.contact],factor:'15',direction:'increase'},{id:ids.list,version:2})).list.version,2,'an unchanged save keeps the version');
   await fails(assert,save(base,{id:ids.list,version:1}),'40001');
   await fails(assert,save(base,{user:f.users.consulta}),'42501');
   await fails(assert,f.rpc('erp_pricing_lists',{p_user_id:f.users.financeiro}),'42501');
   const period=await save({...base,name:'Black Friday',list_type:'period',factor:'5',factor_unit:'amount',considers_datetime:true,starts_on:'2026-11-27',ends_on:'2026-11-27',start_time:'08:00',end_time:'22:00',category:'region',regions:['SP','MG']});
   assert.deepEqual([period.list.start_time,period.list.regions,period.list.rule],['08:00',['MG','SP'],'Desconto R$ 5,00']);
   ids.period=period.list.id;
  });
  await t.test('items: list price with exact decimals rounded to cents; custom prices and the mass adjust only on custom lists',async()=>{
   const added=await items(ids.list,2,{add:[ids.p1,ids.p2,ids.free]});
   assert.equal(added.list.products,3);assert.equal(added.list.version,3);
   const page=await get(ids.list);
   assert.deepEqual(page.items.map(i=>[i.name,i.product_price,i.list_price]),[['Parafuso','10.1250','11.64'],['Porca','0.3333333333','0.38'],['Sem preço',null,null]]);
   assert.deepEqual((await get(ids.list,{p_query:'porc'})).items.map(i=>i.name),['Porca']);
   assert.equal((await get(ids.list,{p_limit:1,p_offset:1})).items[0].name,'Porca');
   await fails(assert,items(ids.list,3,{prices:[{product_id:ids.p1,custom_price:'9'}]}),'22023','custom prices only on a custom list');
   await fails(assert,items(ids.list,2,{remove:[ids.p2]}),'40001');
   const custom=await save({...base,name:'Especial',list_type:'custom',factor:null});
   ids.custom=custom.list.id;
   let version=(await items(ids.custom,1,{add:[ids.p1,ids.p2]})).list.version;
   version=(await items(ids.custom,version,{prices:[{product_id:ids.p1,custom_price:'9.995'}]})).list.version;
   assert.deepEqual((await get(ids.custom)).items.map(i=>[i.custom_price,i.list_price]),[['9.9950','10.00'],[null,'0.33']]);
   version=(await items(ids.custom,version,{adjust:{action:'increase',unit:'percent',value:'10',products:[ids.p2]}})).list.version;
   assert.deepEqual((await get(ids.custom)).items.map(i=>i.custom_price),['9.9950','0.3700']);
   version=(await items(ids.custom,version,{adjust:{action:'fix',unit:'amount',value:'2'}})).list.version;
   assert.deepEqual((await get(ids.custom)).items.map(i=>i.list_price),['2.00','2.00']);
   for(const adjust of[{action:'fix',unit:'percent',value:'2'},{action:'discount',unit:'percent',value:'101'},{unit:'amount',value:'1'},{action:'increase',unit:'amount',value:'1,5'}])
    await fails(assert,items(ids.custom,version,{adjust}),'22023');
   await fails(assert,save({...base,name:'Especial',list_type:'rates',factor:'5'},{id:ids.custom,version}),'22023','the list type is fixed after the inclusion');
   ids.gone=(await f.productSave({name:'Produto excluído',price:'1'})).record.id;await f.setDeleted(ids.gone,1,true);
   await fails(assert,items(ids.custom,version,{add:[ids.gone]}),'22023','a deleted product is not added to a list');
   // A rates list never turns a missing sale price into R$ 0,00, even with a stored custom price.
   await f.db.query('update erp_pricing.price_list_item set custom_price=5 where list_id=$1 and product_id=$2',[ids.list,ids.free]);
   assert.equal((await get(ids.list,{p_query:'sem'})).items[0].list_price,null);
   const lists=await f.rpc('erp_pricing_product_lists',{p_user_id:f.users.vendas,p_product_id:ids.p1});
   assert.deepEqual(lists.items.map(l=>[l.name,l.rule,l.list_price]),[['Atacado','Acréscimo 15 %','11.64'],['Especial','Customizada','2.00']]);
   assert.deepEqual((await f.rpc('erp_pricing_lists',{p_user_id:f.users.consulta,p_list_type:'custom'})).items.map(l=>l.name),['Especial']);
   assert.deepEqual((await f.rpc('erp_pricing_lists',{p_user_id:f.users.consulta,p_product_id:ids.p2})).items.map(l=>l.name),['Atacado','Especial']);
  });
  await t.test('clone and delete: idempotent, audited, with the product limit and unique names',async()=>{
   const command=randomUUID();
   const clone=await f.rpc('erp_pricing_list_clone',{p_user_id:f.users.admin,p_id:ids.list,p_command_id:command,p_name:'Atacado (cópia)'});
   assert.deepEqual([clone.saved,clone.list.products,clone.list.contacts.length],[true,3,1]);
   assert.equal((await f.rpc('erp_pricing_list_clone',{p_user_id:f.users.admin,p_id:ids.list,p_command_id:command,p_name:'Atacado (cópia)'})).replayed,true);
   assert.equal((await f.rpc('erp_pricing_list_clone',{p_user_id:f.users.admin,p_id:ids.list,p_command_id:randomUUID(),p_name:'atacado (cópia)'})).reason,'duplicate_name');
   const removed=await f.rpc('erp_pricing_list_delete',{p_user_id:f.users.admin,p_id:clone.list.id,p_expected_version:1,p_command_id:randomUUID()});
   assert.equal(removed.deleted,true);
   await fails(assert,get(clone.list.id),'P0002');
   assert.deepEqual((await f.rows("select action from erp_pricing.audit where list_id=$1 order by id",[clone.list.id])).map(r=>r.action),['clone','delete']);
   assert.equal(await f.scalar("select count(*)::int v from erp_pricing.price_list_item where list_id=$1",[clone.list.id]),0);
  });
 }finally{await f.close();}
});
