import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{acessoHFixture,fails}from'./helpers/acesso-h-fixture.mjs';

// Leva H, lane acesso (311: PRF-215, PRF-216, PRF-217): module permissions enforced in the access helpers. Synthetic data only.
const restrict=(f,user,keys)=>f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,clock_timestamp(),$3) on conflict(user_id) do update set permissions=excluded.permissions",[user,keys,f.users.admin]);
const save=(f,user,kind,contact,product)=>f.rpc('erp_document_save',{p_user_id:user,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:contact,items:[{product_id:product,description:'Item sintético',quantity:'1',unit_price:'10.00',unit:'UN'}]}});

test('H 311: without saved permissions nothing changes; a saved set restricts documents by card and .ie',async()=>{const f=await acessoHFixture();try{
 const contact=(await f.catalog('contacts',{name:'Cliente Sintético'})).id,product=(await f.catalog('products',{name:'Produto Sintético',code:'SKU-311'})).id;
 const order=await save(f,f.users.vendas,'sales_orders',contact,product);
 const id=order.document.id,get=user=>f.rpc('erp_document_get',{p_user_id:user,p_kind:'sales_orders',p_id:id});
 assert.equal((await get(f.users.vendas)).document?.id??(await get(f.users.vendas)).id,id);
 await restrict(f,f.users.vendas,['vendas.propostas','vendas.propostas.ie']);
 await fails(assert,()=>get(f.users.vendas),'42501');
 await fails(assert,()=>save(f,f.users.vendas,'sales_orders',contact,product),'42501');
 assert.ok(await save(f,f.users.vendas,'sales_proposals',contact,product));
 await restrict(f,f.users.vendas,['vendas.pedidos_venda']);
 assert.ok(await get(f.users.vendas));
 await fails(assert,()=>save(f,f.users.vendas,'sales_orders',contact,product),'42501');
 await restrict(f,f.users.vendas,['vendas.pedidos_venda','vendas.pedidos_venda.ie']);
 assert.ok(await save(f,f.users.vendas,'sales_orders',contact,product));
 // Pedidos de compra by the estoque profile.
 await restrict(f,f.users.estoque,['suprimentos.controle_estoque']);
 await fails(assert,()=>save(f,f.users.estoque,'purchase_orders',contact,product),'42501');
 // The administrador is never restricted.
 assert.ok(await save(f,f.users.admin,'purchase_orders',contact,product));
}finally{await f.close();}});

test('H 311: stock reads need Controle de Estoque, catalog writes need the .ie of the card',async()=>{const f=await acessoHFixture();try{
 const product=(await f.catalog('products',{name:'Produto Sintético',code:'SKU-312'})).id;
 const balances=user=>f.rpc('erp_stock_balances',{p_user_id:user,p_product_id:product,p_warehouse_id:null});
 assert.ok(await balances(f.users.estoque));
 await restrict(f,f.users.estoque,['suprimentos.pedidos_compra']);
 await fails(assert,()=>balances(f.users.estoque),'42501');
 await restrict(f,f.users.estoque,['suprimentos.controle_estoque','cadastros.produtos']);
 assert.ok(await balances(f.users.estoque));
 await fails(assert,()=>f.catalog('products',{name:'Outro produto',code:'SKU-313'},f.users.estoque),'42501');
 await restrict(f,f.users.estoque,['suprimentos.controle_estoque','cadastros.produtos','cadastros.produtos.ie']);
 assert.ok(await f.catalog('products',{name:'Outro produto',code:'SKU-313'},f.users.estoque));
 await restrict(f,f.users.vendas,['cadastros.clientes_fornecedores']);
 await fails(assert,()=>f.catalog('contacts',{name:'Contato sem permissão'},f.users.vendas),'42501');
}finally{await f.close();}});

test('H 311 refuses to replace a helper that changed since it was written',async()=>{const g=await acessoHFixture({before:'202610210311'});try{
 await g.db.exec("create or replace function erp_stock.require_access(p_user_id uuid,p_write boolean) returns void language plpgsql stable set search_path=pg_catalog as $$ begin end $$");
 await assert.rejects(()=>g.migrate('202610210311_access_module_permissions.sql'),e=>e.code==='55000'&&/previous_definition_changed/.test(e.message));
}finally{await g.close();}});
