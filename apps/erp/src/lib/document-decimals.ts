import type { DocumentInput } from './real-documents-model';

/** Compact only complete unsigned decimal strings; never parse into a Number. */
export function compactDocumentDecimal(value:string):string {
 if(!/^\d+(?:\.\d+)?$/.test(value))return value;
 const [whole,fraction]=value.split('.');
 if(fraction===undefined)return whole;
 const trimmed=fraction.replace(/0+$/,'');
 return trimmed?`${whole}.${trimmed}`:whole;
}
/** 202610200199 "Número de casas decimais no peso do produto": an exact decimal shown with at most `places` (half up), never via Number. */
export function roundedDecimal(value:string,places:number):string{
 if(!/^\d+(?:\.\d+)?$/.test(value))return value;
 const [whole,fraction='']=value.split('.');if(fraction.length<=places)return compactDocumentDecimal(value);
 const scaled=BigInt(whole+fraction.slice(0,places))+(Number(fraction[places])>=5?1n:0n),text=scaled.toString().padStart(places+1,'0');
 return compactDocumentDecimal(places?`${text.slice(0,-places)}.${text.slice(-places)}`:text);
}
/** Typing keeps at most `places` decimals (the extra digits are not taken). */
export function limitedDecimal(text:string,places:number):string{const [whole,fraction]=text.split(/[.,]/);return fraction===undefined?text:places?`${whole}${text.includes(',')?',':'.'}${fraction.slice(0,places)}`:whole;}
/** Presentation and typing preserve partial edits (including a trailing comma). */
export const documentDecimalDisplay=(value:string|undefined):string=>(value??'').replaceAll('.',',');
export const documentDecimalInput=(value:string):string=>value.replaceAll(',','.');

/** Also used for the dirty baseline; unrelated fields and item identity are preserved. */
export function documentFormValues(input:DocumentInput):DocumentInput {
 const result:DocumentInput={...input,items:input.items.map(item=>{
  const line={...item,quantity:compactDocumentDecimal(item.quantity),unit_price:compactDocumentDecimal(item.unit_price)};
  if(item.discount_percent!==undefined)line.discount_percent=compactDocumentDecimal(item.discount_percent);
  if(typeof item.list_price==='string')line.list_price=compactDocumentDecimal(item.list_price);
  // 202610200287: IPI % of the pedido de compra and the quantities of the informed lots.
  if(typeof item.ipi_rate==='string')line.ipi_rate=compactDocumentDecimal(item.ipi_rate);
  if(Array.isArray(item.lots))line.lots=item.lots.map(lot=>({...lot,quantity:compactDocumentDecimal(lot.quantity)}));
  return line;
 })};
 for(const field of ['discount_value','freight','other_expenses','tax_ipi','tax_icms_st'] as const)if(input[field]!==undefined)result[field]=compactDocumentDecimal(input[field]!);
 if(input.installments!==undefined)result.installments=input.installments.map(row=>({...row,amount:compactDocumentDecimal(row.amount)}));
 return result;
}
