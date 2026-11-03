// Controle de lotes no padrão do Origin (migração 258): aba "Lotes e validades" do extrato, "Detalhes de lotes", a grade de lotes do
// produto e o campo Lote do Novo Lançamento e das transferências. Quantidades são strings decimais exatas (BigInt, nunca float).
import {brDate} from './origin-list.ts';
import {quantityText} from './stock-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^-?(0|[1-9]\d{0,11})\.\d{6}$/,LOCAL_TIME=/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_LOT_RESPONSE');};
function need(value:unknown):asserts value {if(!value)fail();}
const units=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');const result=BigInt(whole+fraction.padEnd(6,'0').slice(0,6));return negative?-result:result;};
/** Calendar date between 1900 and 2100, as the lot columns keep it. */
export function lotIsoDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2100-12-31')return false;
  const time=Date.parse(`${value}T00:00:00Z`);return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;
}
const optionalDate=(value:unknown)=>value===null||lotIsoDate(value);
const lotCode=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=60&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);

export type LotStatus='todos'|'ativos'|'inativos';
/** Filtro "Situação" of the Lotes e validades tab (Origin: Todos, Ativo, Inativo). */
export const LOT_STATUS_LABELS:Record<LotStatus,string>={todos:'Todos',ativos:'Ativo',inativos:'Inativo'};
export type ExpiryState=null|'expired'|'expiring';
export interface LotSettings {require_expiry:boolean;require_manufacture:boolean;warning_days:number}
export interface LotRow {id:string;code:string;manufactured_on:string|null;expires_on:string|null;note:string|null;active:boolean;version:number;created_on:string;quantity:string;expiry_state:ExpiryState}
export interface LotsPage {product:{id:string;name:string;code:string|null;unit:string|null;lot_control:boolean;format:string|null;kind:string|null;active:boolean};warehouse_id:string|null;status:string;
 total:number;today:string;settings:LotSettings;items:LotRow[];stock:string;assigned:string;unassigned:string}
function settings(value:unknown):LotSettings {
  need(isObject(value)&&typeof value.require_expiry==='boolean'&&typeof value.require_manufacture==='boolean'&&Number.isInteger(value.warning_days)&&(value.warning_days as number)>=0&&(value.warning_days as number)<=9999);
  return {require_expiry:value.require_expiry as boolean,require_manufacture:value.require_manufacture as boolean,warning_days:value.warning_days as number};
}
function lotRow(value:unknown):LotRow {
  need(isObject(value)&&typeof value.id==='string'&&UUID.test(value.id)&&lotCode(value.code)&&optionalDate(value.manufactured_on)&&optionalDate(value.expires_on)
    &&(value.note===null||(typeof value.note==='string'&&value.note.length<=500))&&typeof value.active==='boolean'&&Number.isInteger(value.version)&&(value.version as number)>=1
    &&lotIsoDate(value.created_on)&&typeof value.quantity==='string'&&STORED.test(value.quantity)&&!value.quantity.startsWith('-')&&[null,'expired','expiring'].includes(value.expiry_state as string|null));
  return {id:value.id,code:value.code,manufactured_on:value.manufactured_on as string|null,expires_on:value.expires_on as string|null,note:value.note as string|null,active:value.active,
    version:value.version as number,created_on:value.created_on as string,quantity:value.quantity,expiry_state:value.expiry_state as ExpiryState};
}
/** GET /v1/estoque/lotes: it must answer this product, warehouse and Situação. */
export function parseLots(value:unknown,productId:string,warehouseId:string|null,status:LotStatus):LotsPage {
  const wanted={todos:'all',ativos:'active',inativos:'inactive'}[status];
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_lots'&&isObject(value.product)&&value.product.id===productId&&value.warehouse_id===warehouseId&&value.status===wanted
    &&typeof value.product.name==='string'&&typeof value.product.lot_control==='boolean'&&Number.isSafeInteger(value.total)&&lotIsoDate(value.today)&&Array.isArray(value.items)
    &&['stock','assigned','unassigned'].every(key=>typeof value[key]==='string'&&STORED.test(value[key] as string)));
  need(units(value.unassigned as string)===units(value.stock as string)-units(value.assigned as string));
  const items=(value.items as unknown[]).map(lotRow);
  need(status==='todos'||items.every(item=>item.active===(status==='ativos')));
  const p=value.product as Record<string,unknown>;
  return {product:{id:productId,name:p.name as string,code:(p.code as string|null)??null,unit:(p.unit as string|null)??null,lot_control:p.lot_control as boolean,format:(p.format as string|null)??null,
    kind:(p.kind as string|null)??null,active:p.active===true},warehouse_id:warehouseId,status:value.status as string,total:value.total as number,today:value.today as string,settings:settings(value.settings),items,
    stock:value.stock as string,assigned:value.assigned as string,unassigned:value.unassigned as string};
}
export interface LotOrigin {type:string;document_id:string|null;document_kind:string|null;document_number:string|null;via:string|null}
export interface LotMovement {movement_id:string;warehouse_id:string;quantity:string;balance_after:string;kind:string;occurred_on:string;recorded_at_local:string;reason:string;origin:LotOrigin}
export interface LotDetail {lot:LotRow;product:{id:string;name:string;code:string|null;unit:string|null;lot_control:boolean};settings:LotSettings;
 warehouses:{warehouse_id:string;name:string;active:boolean;ignored:boolean;quantity:string;version:number}[];movements:{total:number;items:LotMovement[]}}
/** GET /v1/estoque/lotes/{lote} ("Detalhes de lotes"). */
export function parseLotDetail(value:unknown,lotId:string):LotDetail {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_lot'&&isObject(value.lot)&&value.lot.id===lotId&&isObject(value.product)&&typeof value.product.id==='string'
    &&Array.isArray(value.warehouses)&&isObject(value.movements)&&Array.isArray(value.movements.items)&&Number.isSafeInteger(value.movements.total));
  need(value.lot.product_id===value.product.id);
  const lot=lotRow(value.lot);
  const warehouses=(value.warehouses as unknown[]).map(w=>{need(isObject(w)&&typeof w.warehouse_id==='string'&&UUID.test(w.warehouse_id)&&typeof w.name==='string'&&typeof w.active==='boolean'&&typeof w.ignored==='boolean'
    &&typeof w.quantity==='string'&&STORED.test(w.quantity)&&Number.isInteger(w.version));
    return {warehouse_id:w.warehouse_id,name:w.name,active:w.active,ignored:w.ignored,quantity:w.quantity,version:w.version as number};});
  const movements=((value.movements as Record<string,unknown>).items as unknown[]).map(m=>{need(isObject(m)&&typeof m.movement_id==='string'&&UUID.test(m.movement_id)&&typeof m.warehouse_id==='string'
    &&typeof m.quantity==='string'&&STORED.test(m.quantity)&&typeof m.balance_after==='string'&&STORED.test(m.balance_after)&&typeof m.kind==='string'&&lotIsoDate(m.occurred_on)
    &&typeof m.recorded_at_local==='string'&&LOCAL_TIME.test(m.recorded_at_local)&&typeof m.reason==='string'&&isObject(m.origin)&&typeof m.origin.type==='string');
    const o=m.origin as Record<string,unknown>;
    return {movement_id:m.movement_id,warehouse_id:m.warehouse_id,quantity:m.quantity,balance_after:m.balance_after,kind:m.kind,occurred_on:m.occurred_on as string,recorded_at_local:m.recorded_at_local,
      reason:m.reason,origin:{type:o.type as string,document_id:(o.document_id as string|null)??null,document_kind:(o.document_kind as string|null)??null,document_number:(o.document_number as string|null)??null,via:(o.via as string|null)??null}};});
  const p=value.product as Record<string,unknown>;
  return {lot,product:{id:p.id as string,name:String(p.name),code:(p.code as string|null)??null,unit:(p.unit as string|null)??null,lot_control:p.lot_control===true},settings:settings(value.settings),warehouses,
    movements:{total:(value.movements as Record<string,unknown>).total as number,items:movements}};
}

// ---- Requests ----
export interface LotDraft {code:string;manufactured_on:string;expires_on:string;note:string}
export const EMPTY_LOT:LotDraft={code:'',manufactured_on:'',expires_on:'',note:''};
/** Validates a lot like the server (code, dates and the required dates of Preferências › Cadastros › Controle de lotes). */
export function lotFields(draft:LotDraft,options:LotSettings):{code:string;manufactured_on:string|null;expires_on:string|null} {
  const code=draft.code.trim();
  if(!code)throw new Error('Informe o lote.');
  if(code.length>60)throw new Error('O lote pode ter até 60 caracteres.');
  if(/[\u0000-\u001f\u007f]/.test(code))throw new Error('O lote deve ficar em uma única linha.');
  const made=draft.manufactured_on.trim()||null,expires=draft.expires_on.trim()||null;
  if((made&&!lotIsoDate(made))||(expires&&!lotIsoDate(expires)))throw new Error('Informe datas válidas entre 1900 e 2100.');
  if(made&&expires&&made>expires)throw new Error('A data de fabricação deve ser anterior ou igual à data de validade.');
  if(options.require_expiry&&!expires)throw new Error('Informe a data de validade (obrigatória em Preferências › Cadastros › Controle de lotes).');
  if(options.require_manufacture&&!made)throw new Error('Informe a data de fabricação (obrigatória em Preferências › Cadastros › Controle de lotes).');
  return {code,manufactured_on:made,expires_on:expires};
}
export function lotNote(note:string):string|null {
  if(note.length>500)throw new Error('A observação pode ter até 500 caracteres.');
  if(/[\u0000-\u001f\u007f]/.test(note))throw new Error('A observação deve ficar em uma única linha: retire as quebras de linha.');
  return note.trim()||null;
}
/** Body of "+ Adicionar lote" (POST) or of the Salvar of the details (PATCH, the code does not change). */
export function lotBody(productId:string,draft:LotDraft,options:LotSettings,expectedVersion?:number):Record<string,unknown> {
  if(!UUID.test(productId))throw new Error('Salve o produto antes de cadastrar lotes.');
  return {product_id:productId,...lotFields(draft,options),note:lotNote(draft.note),...(expectedVersion===undefined?{}:{expected_version:expectedVersion})};
}
export const NEW_LOT='novo';
/** Lote of the Novo Lançamento: '' (Sem lote), a lot id, or "Novo lote" (Entrada and Balanço) with its fields. */
export function launchLot(choice:string,draft:LotDraft,options:LotSettings,kind:string):Record<string,unknown>|null {
  if(!choice)return null;
  if(choice===NEW_LOT){if(kind!=='receipt'&&kind!=='balance')throw new Error('Um lote novo só entra por Entrada ou Balanço.');return lotFields(draft,options);}
  if(!UUID.test(choice))throw new Error('Selecione o lote novamente.');
  return {lot_id:choice};
}
export function parseLotSave(value:unknown,body:Record<string,unknown>):LotRow&{created:boolean;replayed:boolean} {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_lot_save'&&typeof value.replayed==='boolean'&&typeof value.created==='boolean'&&isObject(value.lot)
    &&value.created===(body.expected_version===undefined));
  const {product_id:_,...lot}=value.lot as Record<string,unknown>;
  const row=lotRow(lot);need(value.replayed||row.code===body.code);
  return {...row,created:value.created as boolean,replayed:value.replayed as boolean};
}
export function parseLotStatus(value:unknown,lotId:string,active:boolean):LotRow&{replayed:boolean} {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_lot_status'&&typeof value.replayed==='boolean'&&isObject(value.lot)&&value.lot.id===lotId);
  const {product_id:_,...lot}=value.lot as Record<string,unknown>;
  const row=lotRow(lot);need(value.replayed||row.active===active);
  return {...row,replayed:value.replayed as boolean};
}

// ---- Display ----
export const lotDay=(value:string|null)=>value?brDate(value)||'-':'-';
/** "Vencido" or "Vence em N dias" (Número de dias antes da data de validade). */
export function expiryText(lot:Pick<LotRow,'expiry_state'|'expires_on'>,today:string):string|null {
  if(!lot.expiry_state||!lot.expires_on)return null;
  if(lot.expiry_state==='expired')return 'Vencido';
  const days=Math.round((Date.parse(`${lot.expires_on}T00:00:00Z`)-Date.parse(`${today}T00:00:00Z`))/86400000);
  return days<=0?'Vence hoje':days===1?'Vence amanhã':`Vence em ${days} dias`;
}
/** Option text of a lot in the Lote selectors: code, validity and the quantity in the warehouse. */
export const lotOption=(lot:Pick<LotRow,'code'|'expires_on'|'quantity'>,unit:string)=>`${lot.code}${lot.expires_on?` · validade ${lotDay(lot.expires_on)}`:''} · saldo ${quantityText(lot.quantity)}${unit?` ${unit}`:''}`;
