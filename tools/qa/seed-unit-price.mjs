/** Synthetic exact-price documents for the loopback QA harness. No network. */
import {randomUUID} from 'node:crypto';
export async function seedUnitPrice(db,userId){
 const save=async(entity,data)=>(await db.query('select public.erp_catalog_save($1,$2,null,0,$3,$4::jsonb) value',[userId,entity,randomUUID(),JSON.stringify(data)])).rows[0].value.record;
 const contact=await save('contacts',{name:'Cliente fictício de precisão 057',roles:['customer']});
 const product=await save('products',{name:'Produto fictício de preço exato 057',code:'QA-PRECISAO-057',unit:'UN',kind:'P',format:'S',price:'12.1234567890'});
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders']){
  const body={date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:product.name,code:'QA-PRECISAO-057',unit:'UN',quantity:'1.2345',unit_price:'12.1234567890'}],notes:'QA057: dados exclusivamente fictícios; preço unitário exato.'};
  await db.query('select public.erp_document_save($1,$2,null,0,$3,$4::jsonb)',[userId,kind,randomUUID(),JSON.stringify(body)]);
 }
}
