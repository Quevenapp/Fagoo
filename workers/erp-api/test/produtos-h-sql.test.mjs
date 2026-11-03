import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{documentosHFixture}from'./helpers/documentos-h-fixture.mjs';

// Leva H, lane produtos: 410 (variações: pai agrupador e SKUs filhos). Synthetic data only.
const fails=(code,msg)=>e=>e.code===code&&(!msg||e.message===msg);
let f,parent,contact;
const catalog=async(entity,data,user)=>(await f.rpc('erp_catalog_save',{p_user_id:user??f.users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
const add=(data,command=randomUUID(),user=f.users.admin,p=parent.id)=>f.rpc('erp_catalog_product_variation_add',{p_user_id:user,p_command_id:command,p_parent:p,p_data:data});
const sale=(product)=>f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-10',contact_id:contact.id,items:[{product_id:product,description:'Camiseta',unit:'UN',quantity:'1',unit_price:'50'}]}});

before(async()=>{
 f=await documentosHFixture();
 parent=await catalog('products',{name:'Camiseta Básica',code:'CAM',unit:'UN',kind:'P',format:'V',price:'49.90',ncm:'61091000',brand:'Marca H'});
 contact=await catalog('contacts',{name:'Cliente Variações'});
});
after(()=>f?.close());

test('410: Adicionar variação creates a sellable SKU child with its own code and price; the combination is unique; replays',async()=>{
 const command=randomUUID();
 const first=await add({attributes:{Cor:'Azul',Tamanho:'M'},code:'CAM-AZ-M',price:'55.00'},command);
 assert.equal(first.replayed,false);assert.equal(first.children.length,1);
 const child=first.children[0];
 assert.deepEqual([child.code,child.price,child.name,child.attributes],['CAM-AZ-M','55.0000','Camiseta Básica Azul M',{Cor:'Azul',Tamanho:'M'}]);
 const record=await f.scalar('select format v from erp_catalog.product where record_id=$1',[child.id]);assert.equal(record,'S');
 assert.equal(await f.scalar('select brand v from erp_catalog.product where record_id=$1',[child.id]),'Marca H','the child inherits the cadastro of the pai');
 assert.equal((await add({attributes:{Cor:'Azul',Tamanho:'M'},code:'CAM-AZ-M',price:'55.00'},command)).replayed,true);
 await assert.rejects(()=>add({attributes:{cor:'azul',tamanho:'m'},code:'CAM-AZ-M2'}),fails('23505','erp_catalog_variation_duplicate'));
 const second=await add({attributes:{Cor:'Verde',Tamanho:'G'},code:'CAM-VD-G'});
 assert.equal(second.children[1].price,'49.9000','without a price the child takes the price of the pai');
 const list=await f.rpc('erp_catalog_product_variations',{p_user_id:f.users.consulta,p_parent:parent.id});
 assert.deepEqual(list.children.map(c=>c.code),['CAM-AZ-M','CAM-VD-G']);
 // Only a Formato V pai; nobody without Salvar variações.
 const simple=await catalog('products',{name:'Simples',code:'SIM',unit:'UN',kind:'P',format:'S'});
 await assert.rejects(()=>add({attributes:{Cor:'Azul'},code:'SIM-AZ'},randomUUID(),f.users.admin,simple.id),fails('22023','erp_catalog_variation_parent_invalid'));
 await assert.rejects(()=>add({attributes:{Cor:'Preta'},code:'CAM-PT'},randomUUID(),f.users.consulta),fails('42501'));
 await assert.rejects(()=>add({attributes:{},code:'CAM-X'}),fails('22023','erp_catalog_variation_invalid'));
});

test('410 VND-153: the pai with variations does not enter a document; the SKU child does; the pai keeps Formato V while it has children',async()=>{
 const children=(await f.rpc('erp_catalog_product_variations',{p_user_id:f.users.admin,p_parent:parent.id})).children;
 await assert.rejects(()=>sale(parent.id),fails('22023','erp_document_variation_parent'));
 assert.ok((await sale(children[0].id)).document);
 await assert.rejects(()=>f.db.query("update erp_catalog.product set format='S' where record_id=$1",[parent.id]),fails('40001','erp_catalog_variation_parent_locked'));
 // The line search of the documents does not offer the pai; Seleções › Variações lists the children.
 const search=await f.rpc('erp_document_product_search',{p_user_id:f.users.admin,p_kind:'sales_orders',p_query:'Camiseta',p_limit:25});
 assert.equal(search.items.some(i=>i.id===parent.id),false);assert.ok(search.items.some(i=>i.id===children[0].id));
 const page=await f.rpc('erp_catalog_product_page_v2',{p_user_id:f.users.admin,p_page:1,p_size:100,p_sort:'created_desc',p_query:null,p_situation:'latest',p_product_type:'variations'});
 assert.deepEqual(page.items.map(i=>i.id).sort(),children.map(c=>c.id).sort());
});
