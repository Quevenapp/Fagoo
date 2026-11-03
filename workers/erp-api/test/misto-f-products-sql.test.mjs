import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoFixture,fails}from'./helpers/misto-f-fixture.mjs';
import{priceListRoute,priceListOperation,priceListResponse}from'../src/price-lists.mjs';
const parsePriceListRequest=async path=>{const url=new URL(`https://api.example.test${path}`),route=priceListRoute(url.pathname);
 return priceListOperation(new Request(url),route,url.searchParams,async()=>{throw new Error('no body');});};
const projectPriceListResult=(operation,value)=>priceListResponse(value,priceListRoute('/v1/cadastros/listas-precos/aplicaveis'),operation);

// Synthetic data only. 282: the Outros permissions of the tag screens (EST-152) and the price lists that apply to a document with its
// vendedor and formas de pagamento (PRD-149).
let f;
const taxonomy=(kind,data,user=f.users.admin)=>f.rpc('erp_catalog_taxonomy_save',{p_user_id:user,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data});
before(async()=>{f=await mistoFixture();});
after(async()=>f?.close());

test('282 Cadastro de tags and Cadastro de grupos de tags guard every write of the tag screens; marking tags and categories keep their own rules',async()=>{
 const base=['cadastros.produtos','cadastros.produtos.ie','cadastros.produtos.ex','cadastros.categorias_produtos','cadastros.categorias_produtos.ie','cadastros.categorias_produtos.ex'];
 await f.permissions(f.users.estoque,base);
 await fails(assert,()=>taxonomy('tags',{name:'Sem permissão',tag_type:'products'},f.users.estoque),'42501');
 await fails(assert,()=>taxonomy('tag_groups',{name:'Grupo sem permissão'},f.users.estoque),'42501');
 const category=await taxonomy('categories',{name:'Categoria sintética F'},f.users.estoque);
 assert.equal(category.record?.name??category.item?.name??category.name,'Categoria sintética F');
 await f.permissions(f.users.estoque,[...base,'outros.tags']);
 const tag=await taxonomy('tags',{name:'Com permissão',tag_type:'products'},f.users.estoque);
 const tagId=tag.record?.id??tag.item?.id??tag.id;assert.match(tagId,/^[0-9a-f-]{36}$/);
 await fails(assert,()=>taxonomy('tag_groups',{name:'Grupo ainda sem permissão'},f.users.estoque),'42501');
 await f.permissions(f.users.estoque,[...base,'outros.tags','outros.grupos_tags']);
 await taxonomy('tag_groups',{name:'Grupo com permissão'},f.users.estoque);
 // Deleting a tag is a write of the screen too.
 await f.permissions(f.users.estoque,base);
 await fails(assert,()=>f.rpc('erp_catalog_taxonomy_delete',{p_user_id:f.users.estoque,p_kind:'tags',p_id:tagId,p_expected_version:1,p_command_id:randomUUID()}),'42501');
 // Reading the tags (pickers, filters) does not need the screen permission.
 const listed=await f.rpc('erp_catalog_taxonomy_list',{p_user_id:f.users.estoque,p_kind:'tags'});
 assert.ok(JSON.stringify(listed).includes(tagId));
 // A user without a saved set and the administrador keep everything of the profile.
 await taxonomy('tags',{name:'Do administrador',tag_type:'contacts'});
 await taxonomy('tags',{name:'Do perfil vendas',tag_type:'contacts'},f.users.vendas);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_catalog.require_taxonomy_access(uuid,text,text,boolean)','execute') v"),false);
});

test('282 the lists that apply now follow the cliente, the UF, the vendedor and the formas de pagamento of the parcelas',async()=>{
 const customer=await f.catalog('contacts',{name:'Cliente Lista F',roles:['customer'],state:'RS'});
 const sellerContact=await f.catalog('contacts',{name:'Vendedora Lista F',roles:['customer']}),otherContact=await f.catalog('contacts',{name:'Outro Vendedor F',roles:['customer']});
 const seller=(await f.rpc('erp_catalog_seller_from_contact',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:sellerContact.id})).seller.id;
 const other=(await f.rpc('erp_catalog_seller_from_contact',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:otherContact.id})).seller.id;
 const method=async description=>(await f.db.query(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,created_by,updated_by) values($1,'15','contas','recebimentos','aliquota',$2,$2) returning id`,[description,f.users.admin])).rows[0].id;
 const pix=await method('Pix sintético F'),boleto=await method('Boleto sintético F'),card=await method('Cartão sintético F');
 const save=async(name,category,links={})=>(await f.rpc('erp_pricing_list_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),
  p_data:{name,category,list_type:'rates',factor:'5',factor_unit:'percent',direction:'discount',considers_datetime:false,starts_on:null,ends_on:null,start_time:null,end_time:null,contacts:[],regions:[],...links}})).list.id;
 const all=await save('Todos F','other'),bySeller=await save('Vendedora F','seller',{sellers:[seller]}),byPix=await save('Pix F','payment_method',{payment_methods:[pix,card]});
 const south=await save('Sul F','region',{regions:['RS']}),expired=(await f.rpc('erp_pricing_list_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),
  p_data:{name:'Vencida F',category:'other',list_type:'period',factor:'5',factor_unit:'percent',direction:'discount',considers_datetime:false,starts_on:'2020-01-01',ends_on:'2020-01-31',start_time:null,end_time:null,contacts:[],regions:[]}})).list.id;
 const applicable=async(args,user=f.users.vendas)=>(await f.rpc('erp_pricing_applicable_lists_v2',{p_user_id:user,p_contact_id:null,p_seller_id:null,p_payment_method_ids:null,p_state:null,...args})).items.map(i=>i.id);
 const ours=ids=>ids.filter(id=>[all,bySeller,byPix,south,expired].includes(id)).sort();
 assert.deepEqual(ours(await applicable({})),[all].sort());
 assert.deepEqual(ours(await applicable({p_contact_id:customer.id})),[all,south].sort(),'the UF of the cliente');
 assert.deepEqual(ours(await applicable({p_seller_id:seller})),[all,bySeller].sort());
 assert.deepEqual(ours(await applicable({p_seller_id:other})),[all].sort());
 assert.deepEqual(ours(await applicable({p_payment_method_ids:`{${boleto},${card}}`})),[all,byPix].sort(),'one of the formas of the parcelas');
 assert.deepEqual(ours(await applicable({p_payment_method_ids:`{${boleto}}`})),[all].sort());
 const answer=await f.rpc('erp_pricing_applicable_lists_v2',{p_user_id:f.users.vendas,p_contact_id:null,p_seller_id:seller,p_payment_method_ids:`{${card},${boleto}}`,p_state:'SP'});
 assert.deepEqual(answer.payment_method_ids,[boleto,card].sort());assert.equal(answer.state,'SP');
 assert.ok(answer.items.every(i=>!('sellers' in i)&&!('payment_methods' in i)&&!('contacts' in i)&&!('regions' in i)));
 for(const bad of[{p_state:'XX'},{p_payment_method_ids:'{}'},{p_payment_method_ids:`{${pix},${pix}}`},{p_payment_method_ids:`{${Array.from({length:21},()=>randomUUID()).join(',')}}`}])
  await fails(assert,()=>applicable(bad),'22023');
 await fails(assert,()=>applicable({},f.users.financeiro),'42501');
 // The helper for the document save is private.
 for(const role of['anon','authenticated','service_role'])
  assert.equal(await f.scalar("select has_function_privilege($1,'erp_pricing.list_applies(erp_pricing.price_list,uuid,uuid,uuid[],text)','execute') v",[role]),false);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_pricing_applicable_lists_v2(uuid,uuid,uuid,uuid[],text)','execute') v",[role]),false);
 assert.equal(await f.scalar('select erp_pricing.list_applies(l,null,$2,null,null) v from erp_pricing.price_list l where id=$1',[bySeller,seller]),true);
 assert.equal(await f.scalar('select erp_pricing.list_applies(l,null,null,null,null) v from erp_pricing.price_list l where id=$1',[expired]),false);
 // The Worker: several formas go to v2 with a closed answer; one forma keeps the 192 call.
 const v2=await parsePriceListRequest(`/v1/cadastros/listas-precos/aplicaveis?vendedor=${seller}&forma_pagamento=${card},${boleto}`);
 assert.equal(v2.rpc,'erp_pricing_applicable_lists_v2');assert.deepEqual(v2.args.p_payment_method_ids,[card,boleto]);
 const projected=projectPriceListResult(v2,await f.rpc('erp_pricing_applicable_lists_v2',{p_user_id:f.users.vendas,...v2.args,p_payment_method_ids:`{${v2.args.p_payment_method_ids.join(',')}}`}));
 assert.ok(projected.items.some(i=>i.id===byPix)&&projected.items.some(i=>i.id===bySeller));
 assert.equal((await parsePriceListRequest(`/v1/cadastros/listas-precos/aplicaveis?forma_pagamento=${card}`)).rpc,'erp_pricing_applicable_lists');
 for(const bad of[`forma_pagamento=${card},${card}`,`forma_pagamento=${card},x`,`forma_pagamento=${Array.from({length:21},()=>randomUUID()).join(',')}`])
  await assert.rejects(()=>parsePriceListRequest(`/v1/cadastros/listas-precos/aplicaveis?${bad}`),e=>e.status===400,bad);
 assert.throws(()=>projectPriceListResult(v2,{...answer,payment_method_ids:[card]}),e=>e.status===502);
 // A cliente of the exterior mirrored from Origin ("EX") has no UF: v1 (192) and v2 answer without it and the Worker takes the answer.
 const abroad=await f.catalog('contacts',{name:'Cliente do exterior F',roles:['customer'],state:'EX'});
 const v1=await parsePriceListRequest(`/v1/cadastros/listas-precos/aplicaveis?contato=${abroad.id}`);
 const first=projectPriceListResult(v1,await f.rpc('erp_pricing_applicable_lists',{p_user_id:f.users.vendas,...v1.args}));
 assert.equal(first.state,null);assert.deepEqual(ours(first.items.map(i=>i.id)),[all]);
 const many=await parsePriceListRequest(`/v1/cadastros/listas-precos/aplicaveis?contato=${abroad.id}&forma_pagamento=${card},${boleto}`);
 const second=projectPriceListResult(many,await f.rpc('erp_pricing_applicable_lists_v2',{p_user_id:f.users.vendas,...many.args,p_payment_method_ids:`{${many.args.p_payment_method_ids.join(',')}}`}));
 assert.equal(second.state,null);assert.deepEqual(ours(second.items.map(i=>i.id)),[all,byPix].sort());
 assert.equal(await f.scalar('select erp_pricing.list_applies(l,$2,null,null,null) v from erp_pricing.price_list l where id=$1',[south,abroad.id]),false);
 // The cliente's UF still works with v1 after 282 (same answer as 192).
 const v1South=await parsePriceListRequest(`/v1/cadastros/listas-precos/aplicaveis?contato=${customer.id}`);
 const southern=projectPriceListResult(v1South,await f.rpc('erp_pricing_applicable_lists',{p_user_id:f.users.vendas,...v1South.args}));
 assert.equal(southern.state,'RS');assert.deepEqual(ours(southern.items.map(i=>i.id)),[all,south].sort());
 for(const role of['anon','authenticated','service_role'])
  assert.equal(await f.scalar("select has_function_privilege($1,'erp_pricing.contact_uf(uuid)','execute') v",[role]),false,role);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_pricing_applicable_lists(uuid,uuid,uuid,uuid,text)','execute') v",[role]),false,role);
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_pricing_applicable_lists(uuid,uuid,uuid,uuid,text)','execute') v"),true);
});

test('282 stops when the applied erp_pricing_applicable_lists (192) is not the expected version',async()=>{
 const before=await mistoFixture({before:'202610200282'});try{
  await before.db.exec("create or replace function public.erp_pricing_applicable_lists(p_user_id uuid,p_contact_id uuid default null,p_seller_id uuid default null,p_payment_method_id uuid default null,p_state text default null) returns jsonb language sql stable as $$ select '{}'::jsonb $$;");
  await assert.rejects(()=>before.migrate('202610200282_products_tags_price_lists_f.sql'),e=>e.code==='55000'&&/products_282_previous_definition_changed/.test(e.message));
 }finally{await before.close();}
});
