/** Memory-only examples for the fiscal preparation screens; no credentials or outbound network. */
import {randomUUID} from 'node:crypto';
export async function seedFiscalTax(db,{uid}){
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const identity=await scalar('select public.erp_company_save_identity($1,0,$2,$3::jsonb)value',[uid,randomUUID(),JSON.stringify({legal_name:'Empresa fictícia de QA fiscal',trade_name:'QA SEM VALOR FISCAL',cnpj:'11222333000181',ie:'123456789012',postal_code:'13400000',street:'Rua fictícia',number:'S/N',district:'Bairro fictício',city:'Piracicaba',municipality_code:'3538709',state:'SP'})]);
 const fiscal=await scalar("select public.erp_company_get($1,'fiscal')value",[uid]);
 await scalar('select public.erp_company_confirm_fiscal($1,$2,$3,$4,\'1\',true,$5)value',[uid,fiscal.record.version,identity.record.version,randomUUID(),'Confirmação inteiramente sintética para QA, sem emissão']);
 const orders=(await db.query("select id,version from erp_documents.document where kind='sales_orders' and body->>'notes'='Pedido inteiramente fictício para QA de rascunhos fiscais' order by number limit 2")).rows;
 for(let n=0;n<orders.length;n++){
  const order=orders[n];
  const draft=await scalar("select public.erp_fiscal_draft_execute($1,$2,'create',$3::jsonb)value",[uid,randomUUID(),JSON.stringify({source_document_id:order.id,expected_source_version:order.version,model:n===0?'55':'65',preparation:{operation_nature:'Venda fictícia interna para QA',notes:'Exemplo sintético; não transmitir'}})]);
  const decisions=draft.record.snapshot.items.map(item=>({item_id:item.id,fields:{ncm:{source:'manual',value:'82055900'},origin:{source:'manual',value:'0'},gtin:{source:'manual',value:'SEM GTIN'},gtin_tax:{source:'manual',value:'SEM GTIN'}}}));
  await scalar('select public.erp_fiscal_item_save($1,$2,$3,$4,0,$5::jsonb,$6)value',[uid,draft.record.id,draft.record.version,draft.record.snapshot_hash,JSON.stringify(decisions),randomUUID()]);
 }
}
