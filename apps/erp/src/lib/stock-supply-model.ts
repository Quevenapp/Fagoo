// Estoque no padrão do Origin, onda C (migrações 181 e 183): lista leve de depósitos, fornecedores dos filtros, transferência em lote
// ("Transferir estoque dos produtos selecionados") e saldo inicial do produto. Quantidades e preços são texto decimal exato.
import {units} from './stock-launch-model.ts';
import type {StockWarehouseOption} from './stock-launch-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^-?(0|[1-9]\d{0,11})\.\d{6}$/,PRICE=/^(0|[1-9]\d{0,13})\.\d{10}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_STOCK_SUPPLY');};
function need(value:unknown):asserts value {if(!value)fail();}
const priceOrNull=(value:unknown)=>value===null||(typeof value==='string'&&PRICE.test(value));

/** GET /v1/estoque/depositos/opcoes: every "Depósito" selector of the stock screens (no totals are computed). */
export function parseWarehouseOptions(value:unknown):StockWarehouseOption[] {
  need(isObject(value)&&value.scope==='stock_warehouse_options'&&value.data_mode==='erp_native'&&Array.isArray(value.items));
  const items=(value.items as unknown[]).map(item=>{need(isObject(item)&&typeof item.id==='string'&&UUID.test(item.id)&&typeof item.name==='string'&&item.name.length>0
    &&typeof item.active==='boolean'&&typeof item.is_default==='boolean'&&typeof item.ignore_balance==='boolean');
    return {id:item.id as string,name:item.name as string,active:item.active as boolean,is_default:item.is_default as boolean,ignore_balance:item.ignore_balance as boolean};});
  need(items.filter(item=>item.is_default).length<=1);
  return items;
}
/** Origin selectors list the active warehouses; an inactive one stays only while it is the current choice. */
export const selectableWarehouses=(items:readonly StockWarehouseOption[],current:string)=>items.filter(item=>item.active||item.id===current);

export interface StockSupplier {id:string;name:string;code:string|null;active:boolean;products:number}
export function parseSuppliers(value:unknown,query:string|null):StockSupplier[] {
  need(isObject(value)&&value.scope==='stock_suppliers'&&value.data_mode==='erp_native'&&value.query===query&&Array.isArray(value.items));
  return (value.items as unknown[]).map(item=>{need(isObject(item)&&typeof item.id==='string'&&UUID.test(item.id)&&typeof item.name==='string'&&item.name.length>0
    &&(item.code===null||typeof item.code==='string')&&typeof item.active==='boolean'&&Number.isInteger(item.products));
    return {id:item.id as string,name:item.name as string,code:item.code as string|null,active:item.active as boolean,products:item.products as number};});
}

// ---- Transferir estoque dos produtos selecionados (183) ----
export type TransferEligibility='eligible'|'not_product'|'inactive'|'composition'|'no_unit'|'unit_mismatch';
export const TRANSFER_INELIGIBLE:Record<Exclude<TransferEligibility,'eligible'>,string>={not_product:'Serviço ou outro tipo: não movimenta estoque.',inactive:'Produto inativo.',
  composition:'Produto com composição ou variações: o estoque é das variações e componentes.',no_unit:'Produto sem unidade no cadastro.',unit_mismatch:'A unidade do cadastro difere da unidade do saldo.'};
export interface TransferPosition {product_id:string;name:string;code:string|null;unit:string|null;eligibility:TransferEligibility;
  source:{quantity:string;version:number;reserved:string};destination:{quantity:string;version:number}|null;suggested_price:string|null;suggested_cost:string|null;
  /** 258: Controle de lote of the product and its active lots with stock in the source warehouse (none from a database still on 183). */
  lot_control:boolean;lots:{id:string;code:string;expires_on:string|null;quantity:string}[]}
export interface TransferPositions {source:{id:string;name:string;active:boolean};destination:{id:string;name:string;active:boolean}|null;show_unit_price:boolean;items:TransferPosition[]}
export const transferPositionsPath=(source:string,destination:string,products:readonly string[])=>
  `/v1/estoque/transferencias/posicoes?${new URLSearchParams({origem:source,...(destination?{destino:destination}:{}),produtos:products.join(',')})}`;
export function parseTransferPositions(value:unknown,source:string,destination:string,products:readonly string[]):TransferPositions {
  need(isObject(value)&&value.scope==='stock_transfer_positions'&&value.data_mode==='erp_native'&&typeof value.show_unit_price==='boolean'&&Array.isArray(value.items)
    &&isObject(value.source)&&value.source.id===source&&(destination?isObject(value.destination)&&value.destination.id===destination:value.destination===null));
  const items=(value.items as unknown[]).map(item=>{need(isObject(item)&&typeof item.product_id==='string'&&products.includes(item.product_id)&&typeof item.name==='string'
    &&(item.eligibility==='eligible'||Object.hasOwn(TRANSFER_INELIGIBLE,String(item.eligibility))));
    const row=item as Record<string,unknown>,s=row.source as Record<string,unknown>,d=row.destination as Record<string,unknown>|null;
    need(isObject(s)&&typeof s.quantity==='string'&&STORED.test(s.quantity)&&Number.isInteger(s.version)&&typeof s.reserved==='string'&&STORED.test(s.reserved)
      &&(destination?isObject(d)&&typeof d.quantity==='string'&&STORED.test(d.quantity)&&Number.isInteger(d.version):d===null)&&priceOrNull(row.suggested_price)&&priceOrNull(row.suggested_cost)
      &&(row.lot_control===undefined||(typeof row.lot_control==='boolean'&&Array.isArray(row.lots)&&(row.lots as unknown[]).every(lot=>isObject(lot)&&typeof lot.id==='string'&&UUID.test(lot.id)&&typeof lot.code==='string'
        &&(lot.expires_on===null||typeof lot.expires_on==='string')&&typeof lot.quantity==='string'&&STORED.test(lot.quantity)))));
    return {product_id:row.product_id as string,name:row.name as string,code:(row.code as string|null)??null,unit:(row.unit as string|null)??null,eligibility:row.eligibility as TransferEligibility,
      source:{quantity:s.quantity as string,version:s.version as number,reserved:s.reserved as string},destination:d?{quantity:d.quantity as string,version:d.version as number}:null,
      suggested_price:row.suggested_price as string|null,suggested_cost:row.suggested_cost as string|null,lot_control:row.lot_control===true,
      lots:Array.isArray(row.lots)?(row.lots as Record<string,unknown>[]).map(lot=>({id:lot.id as string,code:lot.code as string,expires_on:(lot.expires_on as string|null)??null,quantity:lot.quantity as string})):[]};});
  need(items.length===products.length);
  const ref=(r:Record<string,unknown>)=>({id:r.id as string,name:String(r.name),active:r.active===true});
  return {source:ref(value.source as Record<string,unknown>),destination:destination?ref(value.destination as Record<string,unknown>):null,show_unit_price:value.show_unit_price,items};
}
/** Quantity typed with comma or dot; exact text for the API. */
export function transferQuantity(text:string):string {
  const value=text.trim().replace(',','.');
  if(!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)||units(value)===0n)throw new Error('Informe uma quantidade maior que zero, com até 6 casas decimais.');
  return value;
}
export function transferPrice(text:string,required:boolean,label:string):string|null {
  const value=text.trim().replace(',','.');
  if(!value){if(required)throw new Error(`Informe o ${label}.`);return null;}
  if(!/^(0|[1-9]\d{0,13})(\.\d{1,10})?$/.test(value))throw new Error(`O ${label} aceita até 14 dígitos inteiros e 10 casas decimais.`);
  return value;
}
/** Available to transfer: the balance in the source less what is reserved there (070). */
export const transferAvailable=(item:TransferPosition)=>{const value=units(item.source.quantity)-units(item.source.reserved);return value;};
export interface TransferReceipt {command_id:string;source:{id:string;name:string};destination:{id:string;name:string};note:string;occurred_on:string;saved_at:string;
  items:{product_id:string;name:string;code:string|null;unit:string;quantity:string;movement_id:string;source_balance_after:string;destination_balance_after:string;unit_price:string|null;unit_cost:string|null;lot_id?:string;lot_code?:string}[]}
export function parseTransferReceipt(value:unknown,body:{command_id:string;items:readonly {product_id:string;lot_id?:string}[]}):{receipt:TransferReceipt;replayed:boolean} {
  need(isObject(value)&&value.scope==='stock_transfer_batch'&&typeof value.replayed==='boolean'&&isObject(value.receipt));
  const r=value.receipt;
  need(r.command_id===body.command_id&&Array.isArray(r.items)&&r.items.length===body.items.length&&(r.items as unknown[]).every(item=>isObject(item)&&body.items.some(row=>row.product_id===item.product_id&&(row.lot_id??null)===((item.lot_id as string|undefined)??null))
    &&typeof item.quantity==='string'&&STORED.test(item.quantity)&&typeof item.movement_id==='string'&&UUID.test(item.movement_id)));
  return {receipt:r as unknown as TransferReceipt,replayed:value.replayed};
}
/** A stored price (ten decimals) as an editable field: comma, at least two decimals, no thousand separator ("" when absent). */
export const priceField=(value:string|null|undefined)=>{if(typeof value!=='string'||!PRICE.test(value))return '';const [whole,fraction='']=value.split('.');return `${whole},${fraction.replace(/0+$/,'').padEnd(2,'0')}`;};

// ---- Saldo inicial of a new product (183) ----
/** "Saldo inicial" of Origin (aba Estoque, only when a product is included): Depósito, Quantidade, Preço de compra unitário, Custo de compra Un e
 * Observações do saldo inicial. The product and the entry are saved by one command. */
export interface InitialBalanceDraft { warehouse: string; quantity: string; price: string; cost: string; note: string }
export const EMPTY_INITIAL_BALANCE: InitialBalanceDraft = { warehouse: '', quantity: '', price: '', cost: '', note: '' };
/** Only a simple product (not a service, a parent of variations or a composition) receives stock, so only it has a saldo inicial. */
export const initialBalanceAllowed=(values:Readonly<Record<string,string|undefined>>)=>(values.kind||'P')==='P'&&!['V','E'].includes(values.format??'');
/** The `initial_balance` sent with the new product, or nothing when no quantity was typed. Throws the message to show. */
export function initialBalancePayload(draft: InitialBalanceDraft,unit?:string):Record<string,unknown> {
  if (!draft.quantity.trim()) return {};
  let quantity: string;
  try { quantity = transferQuantity(draft.quantity); } catch { throw new Error('Saldo inicial: informe uma quantidade maior que zero, com até 6 casas decimais.'); }
  if (!draft.warehouse) throw new Error('Saldo inicial: selecione o depósito.');
  // The stock entry needs the unit of the product (009).
  if (unit !== undefined && !unit.trim()) throw new Error('Saldo inicial: informe a unidade do produto.');
  if (/[\u0000-\u001f\u007f]/.test(draft.note)) throw new Error('Saldo inicial: as observações devem ficar em uma única linha.');
  return { initial_balance: { warehouse_id: draft.warehouse, quantity, unit_price: transferPrice(draft.price, false, 'Preço de compra unitário'), unit_cost: transferPrice(draft.cost, false, 'Custo de compra Un'),
    note: draft.note.trim() || null } };
}

