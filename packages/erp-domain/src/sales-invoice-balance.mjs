/** Leva H, lane documentos (migration 202610210391): "Resumo de faturamento" of a pedido de venda and the body of "Gerar nota fiscal
 * parcial". Quantities are text with 4 decimals, like the note items. */
export class SalesInvoiceBalanceError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new SalesInvoiceBalanceError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QTY=/^(0|[1-9][0-9]{0,10})\.[0-9]{4}$/;
export const balanceUuid=v=>typeof v==='string'&&UUID.test(v);
const units=v=>{const[a,b]=v.split('.');return BigInt(a)*10000n+BigInt(b);};
/** The balance answered by erp_document_invoice_balance (the "balance" of a partial note has the same shape without scope). */
export function parseInvoiceBalance(raw,documentId,{scoped=true}={}){
 const v=structuredClone(raw);
 exact(v,scoped?['scope','data_mode','document_id','full_invoice_id','items','invoices']:['document_id','full_invoice_id','items','invoices']);
 need((!scoped||v.scope==='document_invoice_balance'&&v.data_mode==='erp_native')&&v.document_id===documentId&&(v.full_invoice_id===null||balanceUuid(v.full_invoice_id)));
 need(Array.isArray(v.items)&&v.items.length<=250&&Array.isArray(v.invoices)&&v.invoices.length<=500);
 const seen=new Set();
 for(const i of v.items){exact(i,['document_item_id','position','product_id','description','unit','ordered','invoiced','remaining']);
  need(balanceUuid(i.document_item_id)&&!seen.has(i.document_item_id)&&Number.isInteger(i.position)&&i.position>=1&&i.position<=250&&(i.product_id===null||balanceUuid(i.product_id))
   &&(i.description===null||typeof i.description==='string'&&i.description.length<=4000)&&(i.unit===null||typeof i.unit==='string'&&i.unit.length<=20)
   &&[i.ordered,i.invoiced,i.remaining].every(q=>typeof q==='string'&&QTY.test(q)));
  need(units(i.invoiced)+units(i.remaining)<=units(i.ordered)||v.full_invoice_id!==null);seen.add(i.document_item_id);}
 for(const n of v.invoices){exact(n,['id','number','series','model','status','partial','counts']);
  need(balanceUuid(n.id)&&(n.number===null||Number.isInteger(n.number))&&Number.isInteger(n.series)&&['55','65'].includes(n.model)&&Number.isInteger(n.status)&&typeof n.partial==='boolean'&&typeof n.counts==='boolean');}
 return v;
}
/** Body of POST /v1/notas-fiscais/parcial: quantities of 4 decimals, distinct note positions and pedido items. */
export function capturePartialItems(raw){
 need(Array.isArray(raw)&&raw.length>=1&&raw.length<=990,400,'ERP_INVALID_INPUT');
 const positions=new Set(),items=new Set();
 return raw.map(i=>{exact(i,['position','document_item_id','quantity'],400,'ERP_INVALID_INPUT');
  need(Number.isInteger(i.position)&&i.position>=1&&i.position<=990&&!positions.has(i.position)&&balanceUuid(i.document_item_id)&&!items.has(i.document_item_id)
   &&typeof i.quantity==='string'&&QTY.test(i.quantity)&&units(i.quantity)>0n,400,'ERP_INVALID_INPUT');
  positions.add(i.position);items.add(i.document_item_id);return{position:i.position,document_item_id:i.document_item_id,quantity:i.quantity};});
}
