/** Four synthetic commercial documents for the loopback QA harness. No network. */
import {randomUUID} from 'node:crypto';

export async function seedDocumentCommercial(db, userId, contactId) {
 const reference=(source_id,label)=>({system:'origin',source_id,label});
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders']){
  const body={date:'2026-10-16',contact_id:contactId,
   items:[{description:'Conjunto de fixação fictício',unit:'UN',quantity:'2',unit_price:'12.50',
    detailed_description:'Acabamento e medidas conforme orçamento.\nDescrição pública fictícia preservada.'}],
   installments:[{due_date:'2026-11-16',amount:'25.00',method:'Prazo fictício',
    note:'Condição pública fictícia da parcela.',payment_reference:reference('546','Forma declarada de teste')}],
   commercial:{introduction:'Obrigado pelo contato. Segue nossa proposta de fornecimento fictícia.',attention_to:'Equipe de compras fictícia',
    seller_reference:reference('541','Vendedor fictício'),store_reference:null,business_unit_reference:null,
    transport:{freight_mode:'0',volume_count:'2.000000',gross_weight:'0.125001',delivery_days:'3',
     carrier_reference:reference('544','Transportador fictício'),service_reference:null,tracking_code:null}},
   notes:'QA comercial 054 — somente dados fictícios.',internal_notes:'QA_PRIVATE_INTERNAL_NOTE_MUST_NOT_PRINT'};
  await db.query('select public.erp_document_save($1,$2,null,0,$3,$4::jsonb)',[userId,kind,randomUUID(),JSON.stringify(body)]);
 }
}
