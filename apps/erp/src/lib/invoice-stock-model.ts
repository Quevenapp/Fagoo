// Estoque pela nota fiscal (migração 259): letra E da listagem (S pela nota, R pela referência), "Lançar estoque" e "Estornar estoque"
// do menu ⋮ e o Finalizar do Check-in com "Lançar estoque ao finalizar Check-in". Quantidades são strings decimais exatas.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^-?(0|[1-9]\d{0,11})\.\d{6}$/,HASH=/^[0-9a-f]{64}$/,DATE=/^\d{4}-\d{2}-\d{2}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_INVOICE_STOCK_RESPONSE');};
function need(value:unknown):asserts value {if(!value)fail();}
export const INVOICE_STOCK_BASE='/v1/estoque/notas-fiscais';

export interface InvoiceStockFlag {flag:'S'|'R'|null;warehouse:{id:string;name:string}|null;posting_id:string|null;posting_version:number|null;source:'invoice'|'checkin'|null;
 reference:{document_id:string;kind:string;number:string;via:string}|null}
function flag(value:unknown):InvoiceStockFlag {
  need(isObject(value)&&[null,'S','R'].includes(value.flag as string|null));
  const w=value.warehouse;need(value.flag===null?w===null:isObject(w)&&typeof w.id==='string'&&UUID.test(w.id)&&typeof w.name==='string');
  need(value.flag==='S'?typeof value.posting_id==='string'&&Number.isInteger(value.posting_version):value.posting_id===null&&value.posting_version===null);
  const r=value.reference;need(value.flag==='R'?isObject(r)&&typeof r.document_id==='string'&&typeof r.number==='string'&&typeof r.kind==='string':r===null);
  return {flag:value.flag as InvoiceStockFlag['flag'],warehouse:w?{id:(w as Record<string,string>).id!,name:(w as Record<string,string>).name!}:null,posting_id:value.posting_id as string|null,
    posting_version:value.posting_version as number|null,source:(value.source as InvoiceStockFlag['source'])??null,reference:r?{document_id:String((r as Record<string,unknown>).document_id),
      kind:String((r as Record<string,unknown>).kind),number:String((r as Record<string,unknown>).number),via:String((r as Record<string,unknown>).via)}:null};
}
/** GET /v1/estoque/notas-fiscais/situacao?ids=: only the asked notes, each once. */
export function parseInvoiceFlags(value:unknown,ids:readonly string[]):Map<string,InvoiceStockFlag> {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_invoice_flags'&&Array.isArray(value.items));
  const out=new Map<string,InvoiceStockFlag>();
  for(const item of value.items as unknown[]){need(isObject(item)&&typeof item.invoice_id==='string'&&ids.includes(item.invoice_id)&&!out.has(item.invoice_id));const {invoice_id,...rest}=item;out.set(invoice_id as string,flag(rest));}
  return out;
}
export const invoiceFlagsPath=(ids:readonly string[])=>`${INVOICE_STOCK_BASE}/situacao?${new URLSearchParams({ids:ids.join(',')})}`;
/** Origin letter E: blue "Estoque lançado - Depósito: <dep>" and dark blue "Estoque lançado pela referência - Depósito: <dep>". */
export function invoiceStockLetter(value:InvoiceStockFlag|undefined):{text:'E';color:'blue'|'darkblue';title:string}|null {
  if(!value?.flag||!value.warehouse)return null;
  return value.flag==='S'?{text:'E',color:'blue',title:`Estoque lançado - Depósito: ${value.warehouse.name}`}:{text:'E',color:'darkblue',title:`Estoque lançado pela referência - Depósito: ${value.warehouse.name}`};
}
export type InvoiceStockBlock=null|'deleted'|'cancelled'|'denied'|'posted'|'reference'|'reserved'|'no_products';
export interface InvoiceStockState {invoice:{id:string;label:string;version:number;direction:string;screen:string;status:number};flag:InvoiceStockFlag;block:InvoiceStockBlock;can_manage:boolean;
 occurred_on:string;date_mode:'data_atual'|'data_documento';default_warehouse:{id:string;name:string}|null;
 /** Preferências › Notas Fiscais › Configurações de NF-e: "Lançar estoque ao finalizar Check-in na NF de Entrada". */
 checkin_post:boolean}
export function parseInvoiceStockState(value:unknown,invoiceId:string):InvoiceStockState {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_invoice'&&isObject(value.invoice)&&value.invoice.id===invoiceId&&typeof value.can_manage==='boolean'
    &&[null,'deleted','cancelled','denied','posted','reference','reserved','no_products'].includes(value.block as string|null)&&typeof value.occurred_on==='string'&&DATE.test(value.occurred_on)
    &&['data_atual','data_documento'].includes(value.date_mode as string)&&typeof value.checkin_post==='boolean');
  const i=value.invoice as Record<string,unknown>,d=value.default_warehouse;
  need(typeof i.label==='string'&&Number.isInteger(i.version)&&typeof i.direction==='string'&&typeof i.screen==='string'&&Number.isInteger(i.status)&&(d===null||isObject(d)&&typeof d.id==='string'&&typeof d.name==='string'));
  return {invoice:{id:invoiceId,label:i.label as string,version:i.version as number,direction:i.direction as string,screen:i.screen as string,status:i.status as number},flag:flag(value.flag),
    block:value.block as InvoiceStockBlock,can_manage:value.can_manage,occurred_on:value.occurred_on,date_mode:value.date_mode as InvoiceStockState['date_mode'],
    default_warehouse:d?{id:(d as Record<string,string>).id!,name:(d as Record<string,string>).name!}:null,checkin_post:value.checkin_post as boolean};
}
/** 295: an entry note item in another unit enters by the factor of the supplier or by the unidade tributária of the note. */
export interface InvoiceStockSource {position:number;quantity:string;kit_product_id?:string;invoice_quantity?:string;invoice_unit?:string;conversion?:'supplier'|'tax_unit';factor?:string}
export interface InvoiceStockPosition {product_id:string;product_name:string;unit:string;quantity:string;balance_before:string;balance_after:string;balance_kept?:true;sources:InvoiceStockSource[]}
export interface InvoiceStockPreview {action:'post'|'reverse';direction:'receipt'|'issue'|'reversal';occurred_on:string;reason:string;warehouse:{id:string;name:string};positions:InvoiceStockPosition[];
 ignored:{position:number;description:string;quantity:string;unit:string|null;reason:'unlinked_item'|'service'}[];preview_hash:string;posting:{id:string;version:number}|null}
function source(s:Record<string,unknown>):InvoiceStockSource {
  const out:InvoiceStockSource={position:Number(s.position),quantity:String(s.quantity),...(typeof s.kit_product_id==='string'?{kit_product_id:s.kit_product_id}:{})};
  if(s.conversion!==undefined){need(['supplier','tax_unit'].includes(s.conversion as string)&&typeof s.invoice_quantity==='string'&&STORED.test(s.invoice_quantity)&&typeof s.invoice_unit==='string'
    &&(s.conversion==='tax_unit'||typeof s.factor==='string'&&STORED.test(s.factor)));
   Object.assign(out,{invoice_quantity:s.invoice_quantity,invoice_unit:s.invoice_unit,conversion:s.conversion,...(s.conversion==='supplier'?{factor:s.factor}:{})});}
  return out;
}
export function parseInvoiceStockPreview(value:unknown,invoiceId:string,scope:string):InvoiceStockPreview {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope===scope&&isObject(value.preview));
  const p=value.preview as Record<string,unknown>;
  need(['post','reverse'].includes(p.action as string)&&isObject(p.invoice)&&p.invoice.id===invoiceId&&['receipt','issue','reversal'].includes(p.direction as string)&&typeof p.occurred_on==='string'
    &&DATE.test(p.occurred_on)&&typeof p.reason==='string'&&isObject(p.warehouse)&&typeof p.warehouse.id==='string'&&typeof p.warehouse.name==='string'&&typeof p.preview_hash==='string'&&HASH.test(p.preview_hash)
    &&Array.isArray(p.positions)&&p.positions.length>=1&&Array.isArray(p.ignored));
  const positions=(p.positions as unknown[]).map(x=>{need(isObject(x)&&typeof x.product_id==='string'&&typeof x.product_name==='string'&&typeof x.unit==='string'&&typeof x.quantity==='string'&&STORED.test(x.quantity)
    &&typeof x.balance_before==='string'&&STORED.test(x.balance_before)&&typeof x.balance_after==='string'&&STORED.test(x.balance_after)&&Array.isArray(x.sources));
    return {product_id:x.product_id,product_name:x.product_name,unit:x.unit,quantity:x.quantity,balance_before:x.balance_before,balance_after:x.balance_after,...(x.balance_kept===true?{balance_kept:true as const}:{}),
      sources:(x.sources as Record<string,unknown>[]).map(source)};});
  const ignored=(p.ignored as unknown[]).map(x=>{need(isObject(x)&&Number.isInteger(x.position)&&typeof x.description==='string'&&typeof x.quantity==='string'&&['unlinked_item','service'].includes(x.reason as string));
    return {position:x.position as number,description:x.description,quantity:x.quantity,unit:(x.unit as string|null)??null,reason:x.reason as 'unlinked_item'|'service'};});
  const posting=isObject(p.posting)?{id:String(p.posting.id),version:Number(p.posting.version)}:null;
  return {action:p.action as 'post'|'reverse',direction:p.direction as InvoiceStockPreview['direction'],occurred_on:p.occurred_on,reason:p.reason,warehouse:{id:p.warehouse.id as string,name:p.warehouse.name as string},
    positions,ignored,preview_hash:p.preview_hash,posting};
}
export interface InvoiceStockResult {flag:InvoiceStockFlag;posting:{id:string;state:string;source:string};replayed:boolean;balanceKept:boolean;checkin?:unknown}
export function parseInvoiceStockResult(value:unknown,invoiceId:string,scope:string):InvoiceStockResult {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope===scope&&isObject(value.invoice)&&value.invoice.id===invoiceId&&isObject(value.posting)&&typeof value.posting.id==='string'
    &&typeof value.replayed==='boolean'&&isObject(value.movement));
  const result:InvoiceStockResult={flag:flag(value.flag),posting:{id:value.posting.id as string,state:String(value.posting.state),source:String(value.posting.source)},replayed:value.replayed,
    balanceKept:Array.isArray(value.balance_adjustments)&&value.balance_adjustments.length>0};
  if(scope==='stock_checkin_post'){need(isObject(value.checkin));result.checkin=value.checkin;}
  return result;
}
export const IGNORED_REASONS:Record<'unlinked_item'|'service',string>={unlinked_item:'Item sem produto do cadastro',service:'Serviço: não movimenta estoque'};
export const BLOCK_TEXT:Record<Exclude<InvoiceStockBlock,null>,string>={deleted:'A nota foi excluída e não lança estoque.',cancelled:'Nota cancelada não lança estoque.',denied:'Nota denegada não lança estoque.',
  posted:'O estoque desta nota já foi lançado.',reference:'O estoque já foi lançado pela referência (o pedido ligado à nota).',
  reserved:'O pedido ligado à nota tem estoque reservado: lance o estoque pela reserva no pedido (a nota passa a mostrar o E pela referência) ou libere a reserva antes de lançar pela nota.',
  no_products:'A nota não tem itens com produto do cadastro.'};

// 295: "Conversão de unidades" of an entry note (GET/POST /v1/estoque/notas-fiscais/{nota}/unidades). Exact decimal strings.
export interface InvoiceUnitItem {position:number;description:string;unit:string|null;quantity:string;product:{id:string;name:string;code:string|null;unit:string};
 tax:{unit:string;quantity:string|null}|null;factor:{factor:string;version:number}|null;rule:'supplier'|'tax_unit'|null;converted_quantity:string|null;problem:'inexact'|'excess'|null}
export interface InvoiceUnits {supplier:{id:string;name:string}|null;can_manage:boolean;total:number;items:InvoiceUnitItem[]}
export const invoiceUnitsPath=(invoiceId:string)=>`${INVOICE_STOCK_BASE}/${invoiceId}/unidades`;
function units(value:unknown,invoiceId:string):InvoiceUnits {
  need(isObject(value)&&isObject(value.invoice)&&value.invoice.id===invoiceId&&typeof value.can_manage==='boolean'&&Number.isInteger(value.total)&&Array.isArray(value.items)
    &&(value.supplier===null||isObject(value.supplier)&&typeof value.supplier.id==='string'&&UUID.test(value.supplier.id)&&typeof value.supplier.name==='string'));
  const items=(value.items as unknown[]).map(x=>{need(isObject(x)&&Number.isInteger(x.position)&&typeof x.description==='string'&&(x.unit===null||typeof x.unit==='string')&&typeof x.quantity==='string'&&STORED.test(x.quantity)
    &&isObject(x.product)&&typeof x.product.id==='string'&&typeof x.product.name==='string'&&typeof x.product.unit==='string'&&[null,'supplier','tax_unit'].includes(x.rule as string|null)
    &&(x.converted_quantity===null||typeof x.converted_quantity==='string'&&STORED.test(x.converted_quantity))&&[null,'inexact','excess'].includes(x.problem as string|null)
    &&(x.factor===null||isObject(x.factor)&&typeof x.factor.factor==='string'&&STORED.test(x.factor.factor)&&Number.isInteger(x.factor.version))
    &&(x.tax===null||isObject(x.tax)&&typeof x.tax.unit==='string'));
    const product=x.product as Record<string,unknown>,factor=x.factor as Record<string,unknown>|null,tax=x.tax as Record<string,unknown>|null;
    return {position:x.position as number,description:x.description,unit:x.unit as string|null,quantity:x.quantity,product:{id:String(product.id),name:String(product.name),code:typeof product.code==='string'?product.code:null,unit:String(product.unit)},
      tax:tax?{unit:String(tax.unit),quantity:typeof tax.quantity==='string'?tax.quantity:null}:null,factor:factor?{factor:String(factor.factor),version:Number(factor.version)}:null,
      rule:x.rule as InvoiceUnitItem['rule'],converted_quantity:x.converted_quantity as string|null,problem:x.problem as InvoiceUnitItem['problem']};});
  const supplier=value.supplier as Record<string,string>|null;
  return {supplier:supplier?{id:supplier.id!,name:supplier.name!}:null,can_manage:value.can_manage,total:value.total as number,items};
}
export function parseInvoiceUnits(value:unknown,invoiceId:string):InvoiceUnits {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_invoice_units');return units(value,invoiceId);
}
export interface InvoiceUnitSaved {after:{factor:string;version:number}|null;units:InvoiceUnits;replayed:boolean}
export function parseInvoiceUnitSave(value:unknown,invoiceId:string,body:Record<string,unknown>):InvoiceUnitSaved {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_invoice_unit_save'&&value.command_id===body.command_id&&value.position===body.position&&typeof value.replayed==='boolean'
    &&(value.after===null||isObject(value.after)&&typeof value.after.factor==='string'&&Number.isInteger(value.after.version)));
  const after=value.after as Record<string,unknown>|null;
  return {after:after?{factor:String(after.factor),version:Number(after.version)}:null,units:units(value.units,invoiceId),replayed:value.replayed};
}
/** "Fator de conversão": 1 unidade da nota = fator unidades do produto, maior que zero, até 6 casas decimais (vírgula ou ponto). */
export function factorInput(text:string):string {
  const value=text.trim().replace(',','.');
  if(!/^(0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)||/^0(?:\.0+)?$/.test(value))throw new Error('Informe um fator maior que zero, sem separador de milhar e com até 6 casas decimais.');
  return value;
}
export const CONVERSION_LABELS:Record<'supplier'|'tax_unit',string>={supplier:'Fator de conversão do fornecedor',tax_unit:'Unidade tributária da nota'};
const qty=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');const decimals=fraction.replace(/0+$/,'');return `${negative?'−':''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,'.')}${decimals?`,${decimals}`:''}`;};
/** The rule of an item in the "Conversão de unidades" table. */
export function unitRuleText(item:InvoiceUnitItem,hasSupplier:boolean):string {
  if(item.rule===null)return !item.unit?.trim()?'Sem conversão: o item da nota não tem unidade e a unidade tributária não é a do produto.'
    :hasSupplier?'Sem conversão: informe o fator de conversão.':'Sem conversão: a nota não tem fornecedor do cadastro e a unidade tributária não é a do produto.';
  const label=item.rule==='supplier'&&item.factor?`${CONVERSION_LABELS.supplier}: 1 ${item.unit??''} = ${qty(item.factor.factor)} ${item.product.unit}`:CONVERSION_LABELS[item.rule];
  return item.problem==='inexact'?`${label}. A quantidade no estoque precisaria de mais de 6 casas decimais.`:item.problem==='excess'?`${label}. A quantidade passa do limite do estoque.`:`${label}.`;
}
/** A converted source of the conferência: "Item 1: 2 CX × 12 = 24 UN (fator do fornecedor)". */
export function conversionText(source:InvoiceStockSource,unit:string):string|null {
  if(!source.conversion||!source.invoice_quantity)return null;
  return source.conversion==='supplier'?`Item ${source.position}: ${qty(source.invoice_quantity)} ${source.invoice_unit} × ${qty(source.factor??'0')} = ${qty(source.quantity)} ${unit} (fator do fornecedor)`
    :`Item ${source.position}: ${qty(source.invoice_quantity)} ${source.invoice_unit} = ${qty(source.quantity)} ${unit} (unidade tributária)`;
}
