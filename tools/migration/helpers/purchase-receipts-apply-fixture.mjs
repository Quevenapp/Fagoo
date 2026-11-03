// A real018 posting assembled entirely from synthetic data before installing090.
import {randomUUID}from'node:crypto';
export async function seedPurchaseReceiptsLegacyApply({run,ok,rpc}){
 const actor=randomUUID();await ok(await run(`insert into auth.users values('${actor}');insert into erp_access.membership(user_id,role)values('${actor}','admin');`));
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const product=await catalog('products',{name:'Synthetic090 legacy product',unit:'UN',kind:'P',format:'S',price:'1'}),warehouse=await catalog('warehouses',{name:'Synthetic090 legacy warehouse'}),contact=await catalog('contacts',{name:'Synthetic090 legacy contact'});
 let document=(await rpc('erp_document_save',{p_user_id:actor,p_kind:'purchase_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Synthetic090 legacy item',unit:'UN',quantity:'2',unit_price:'1'}]}})).document;
 document=(await rpc('erp_document_transition',{p_user_id:actor,p_kind:'purchase_orders',p_id:document.id,p_expected_version:document.version,p_command_id:randomUUID(),p_status:'in_progress',p_reason:'Synthetic090 legacy order'})).document;
 const input={p_user_id:actor,p_kind:'purchase_orders',p_document_id:document.id,p_expected_version:document.version,p_occurred_on:'2026-10-15',p_reason:'Synthetic090 legacy posting'};
 const preview=(await rpc('erp_document_stock_preview',input)).preview,args={...input,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_ignored_item_ids:preview.ignored.map(x=>x.id)};
 const receipt=await rpc('erp_document_stock_post',args);return{actor,document,receipt,args};
}
