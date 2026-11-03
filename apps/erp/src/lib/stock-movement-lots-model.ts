// "Informar lotes de produtos" de um lançamento gravado e "Informações de lote lançado" de um item (migração 278). Quantidades são
// strings decimais exatas (BigInt, nunca float); a tela confere a resposta e o servidor confere tudo de novo.
import {lotFields,lotIsoDate,type LotSettings} from './stock-lots-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^(0|[1-9]\d{0,11})\.\d{6}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_MOVEMENT_LOTS_RESPONSE');};
function need(value:unknown):asserts value {if(!value)fail();}
export const lotUnits=(value:string)=>{const [whole,fraction='']=value.split('.');return BigInt(whole+fraction.padEnd(6,'0').slice(0,6));};
export const fromLotUnits=(value:bigint)=>{const digits=value.toString().padStart(7,'0');return `${digits.slice(0,-6)}.${digits.slice(-6)}`;};
const stored=(value:unknown):value is string=>typeof value==='string'&&STORED.test(value);
const optionalDate=(value:unknown)=>value===null||lotIsoDate(value);
const code=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=60&&value.trim()===value;

export type LineReason=null|'kind'|'reversed'|'lot_control_off'|'assigned';
export const LINE_REASON_TEXT:Record<Exclude<LineReason,null>,string>={kind:'Transferências, balanços e estornos não recebem lotes por aqui.',
  reversed:'O lançamento foi estornado.',lot_control_off:'O produto não está com “Controle de lote” ligado (Cadastros › Produtos › Estoque).',assigned:'Toda a quantidade já tem lote.'};
export interface InformedLot {lot_id:string;code:string;manufactured_on:string|null;expires_on:string|null;quantity:string}
export interface LotLine {movement_id:string;product_id:string;warehouse_id:string;warehouse_name:string;kind:string;direction:'receipt'|'issue';occurred_on:string;reason:string;
  quantity:string;assigned:string;unassigned:string;lots_version:number;assignable:boolean;reason_code:LineReason;
  origin:{type:string;document_id:string|null;document_kind:string|null;document_number:string|null;via:string|null};lots:InformedLot[]}
export interface LotCandidate {id:string;code:string;manufactured_on:string|null;expires_on:string|null;quantity:string}
export interface LineProduct {id:string;name:string;code:string|null;unit:string|null;lot_control:boolean}
export interface MovementLots {line:LotLine;product:LineProduct;room:string;candidates:LotCandidate[];settings:LotSettings;can_write:boolean}
function settings(value:unknown):LotSettings {
  need(isObject(value)&&typeof value.require_expiry==='boolean'&&typeof value.require_manufacture==='boolean'&&Number.isInteger(value.warning_days));
  return {require_expiry:value.require_expiry as boolean,require_manufacture:value.require_manufacture as boolean,warning_days:value.warning_days as number};
}
function product(value:unknown,id:string):LineProduct {
  need(isObject(value)&&value.id===id&&typeof value.name==='string'&&typeof value.lot_control==='boolean'&&(value.code===null||typeof value.code==='string')&&(value.unit===null||typeof value.unit==='string'));
  return {id,name:value.name as string,code:value.code as string|null,unit:value.unit as string|null,lot_control:value.lot_control as boolean};
}
export function parseLotLine(value:unknown,productId:string):LotLine {
  need(isObject(value)&&typeof value.movement_id==='string'&&UUID.test(value.movement_id)&&value.product_id===productId&&typeof value.warehouse_id==='string'&&UUID.test(value.warehouse_id)
    &&typeof value.warehouse_name==='string'&&typeof value.kind==='string'&&['receipt','issue'].includes(value.direction as string)&&lotIsoDate(value.occurred_on)&&typeof value.reason==='string'
    &&stored(value.quantity)&&stored(value.assigned)&&stored(value.unassigned)&&Number.isInteger(value.lots_version)&&typeof value.assignable==='boolean'
    &&[null,'kind','reversed','lot_control_off','assigned'].includes(value.reason_code as string|null)&&value.assignable===(value.reason_code===null)&&isObject(value.origin)&&Array.isArray(value.lots));
  need(lotUnits(value.assigned as string)+lotUnits(value.unassigned as string)===lotUnits(value.quantity as string)&&(value.lots as unknown[]).length===value.lots_version);
  const lots=(value.lots as unknown[]).map(lot=>{need(isObject(lot)&&typeof lot.lot_id==='string'&&UUID.test(lot.lot_id)&&code(lot.code)&&optionalDate(lot.manufactured_on)&&optionalDate(lot.expires_on)&&stored(lot.quantity));
    return {lot_id:lot.lot_id,code:lot.code,manufactured_on:lot.manufactured_on as string|null,expires_on:lot.expires_on as string|null,quantity:lot.quantity};});
  need(lots.reduce((sum,lot)=>sum+lotUnits(lot.quantity),0n)===lotUnits(value.assigned as string));
  const o=value.origin as Record<string,unknown>;
  return {movement_id:value.movement_id,product_id:productId,warehouse_id:value.warehouse_id,warehouse_name:value.warehouse_name as string,kind:value.kind,direction:value.direction as 'receipt'|'issue',
    occurred_on:value.occurred_on as string,reason:value.reason,quantity:value.quantity as string,assigned:value.assigned as string,unassigned:value.unassigned as string,lots_version:value.lots_version as number,
    assignable:value.assignable,reason_code:value.reason_code as LineReason,origin:{type:String(o.type),document_id:(o.document_id as string|null)??null,document_kind:(o.document_kind as string|null)??null,
      document_number:(o.document_number as string|null)??null,via:(o.via as string|null)??null},lots};
}
/** GET /v1/estoque/lotes/movimentos/{lançamento}: the same line, product and warehouse that were asked. */
export function parseMovementLots(value:unknown,movementId:string,productId:string,warehouseId:string,scope='stock_movement_lots'):MovementLots {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope===scope&&stored(value.room)&&typeof value.can_write==='boolean'&&Array.isArray(value.candidates));
  const line=parseLotLine(value.line,productId);
  need(line.movement_id===movementId&&line.warehouse_id===warehouseId&&lotUnits(value.room as string)<=lotUnits(line.unassigned)&&(line.assignable||(value.candidates as unknown[]).length===0));
  const candidates=(value.candidates as unknown[]).map(item=>{need(isObject(item)&&typeof item.id==='string'&&UUID.test(item.id)&&code(item.code)&&optionalDate(item.manufactured_on)&&optionalDate(item.expires_on)&&stored(item.quantity));
    return {id:item.id,code:item.code,manufactured_on:item.manufactured_on as string|null,expires_on:item.expires_on as string|null,quantity:item.quantity};});
  return {line,product:product(value.product,productId),room:value.room as string,candidates,settings:settings(value.settings),can_write:value.can_write};
}
export interface SourceLots {source:'document'|'invoice';source_id:string;posted:boolean;reference:{document_id:string;kind:string;number:string;via:string}|null;product:LineProduct;lines:LotLine[];settings:LotSettings;can_write:boolean}
/** GET /v1/estoque/lotes/origem: the lines posted by the document or the note for the product of the item. */
export function parseSourceLots(value:unknown,source:'document'|'invoice',sourceId:string,productId:string):SourceLots {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope==='stock_source_lots'&&value.source===source&&value.source_id===sourceId&&typeof value.posted==='boolean'
    &&typeof value.can_write==='boolean'&&Array.isArray(value.lines)&&(value.posted||(value.lines as unknown[]).length===0));
  const r=value.reference;
  need(r===null||(source==='invoice'&&isObject(r)&&typeof r.document_id==='string'&&UUID.test(r.document_id)&&typeof r.kind==='string'&&typeof r.number==='string'&&typeof r.via==='string'));
  return {source,source_id:sourceId,posted:value.posted,reference:isObject(r)?{document_id:r.document_id as string,kind:r.kind as string,number:r.number as string,via:r.via as string}:null,
    product:product(value.product,productId),lines:(value.lines as unknown[]).map(line=>parseLotLine(line,productId)),settings:settings(value.settings),can_write:value.can_write};
}

// ---- The rows of the panel ("Dividir os lotes", "Adicionar novo lote", "Remover lote") ----
export const NEW_LOT_CHOICE='novo';
export interface LotAllocation {key:string;choice:string;code:string;manufactured_on:string;expires_on:string;quantity:string}
let serial=0;
export const allocation=(choice='',quantity=''):LotAllocation=>({key:`lot-row-${++serial}`,choice,code:'',manufactured_on:'',expires_on:'',quantity});
/** Exact quantity typed like Origin ("1,5" or "1.5"), positive, up to 6 decimals. */
export function allocationQuantity(text:string):string {
  const value=text.trim();
  if(!/^(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/.test(value)||/^0(?:[.,]0+)?$/.test(value))throw new Error('Informe uma quantidade positiva em cada lote, com até 6 casas decimais.');
  return value.replace(',','.');
}
/** "Dividir os lotes": a new row with what is still free in the line (nothing when the rows already use all of it). */
export function freeQuantity(rows:readonly LotAllocation[],room:string):string {
  let used=0n;for(const row of rows){try{used+=lotUnits(allocationQuantity(row.quantity));}catch{/* An incomplete row counts as nothing. */}}
  const free=lotUnits(room)-used;return free>0n?fromLotUnits(free).replace(/\.?0+$/,'').replace('.',','):'';
}
/** The lots a row may choose: a lot already informed in this line is never offered again (one lot line per lot, 258/278). */
export const offeredLots=(view:MovementLots):LotCandidate[]=>view.candidates.filter(candidate=>!view.line.lots.some(lot=>lot.lot_id===candidate.id));
/** Body of the save: every row checked like the server (lot chosen once, Novo lote only in an Entrada, quantities within the room). */
export function lotsBody(view:MovementLots,rows:readonly LotAllocation[]):Record<string,unknown> {
  if(!view.can_write)throw new Error('Seu perfil não informa lotes (administrador e estoque).');
  if(!view.line.assignable)throw new Error(LINE_REASON_TEXT[view.line.reason_code as Exclude<LineReason,null>]);
  const filled=rows.filter(row=>row.choice||row.quantity.trim());
  if(!filled.length)throw new Error('Informe ao menos um lote.');
  if(filled.length>50)throw new Error('Informe até 50 lotes de cada vez.');
  const chosen=new Set<string>(),codes=new Set<string>();let total=0n;
  const lots=filled.map(row=>{
    const quantity=allocationQuantity(row.quantity);total+=lotUnits(quantity);
    if(row.choice===NEW_LOT_CHOICE){
      if(view.line.direction!=='receipt')throw new Error('Um lote novo só entra por uma Entrada.');
      const fields=lotFields({code:row.code,manufactured_on:row.manufactured_on,expires_on:row.expires_on,note:''},view.settings);
      if(codes.has(fields.code.toLowerCase())||view.candidates.some(c=>c.code.toLowerCase()===fields.code.toLowerCase()))throw new Error(`O lote ${fields.code} já existe neste produto ou está repetido.`);
      codes.add(fields.code.toLowerCase());
      return {code:fields.code,manufactured_on:fields.manufactured_on,expires_on:fields.expires_on,quantity};
    }
    const candidate=view.candidates.find(c=>c.id===row.choice);
    if(!candidate)throw new Error('Selecione o lote de cada linha.');
    if(view.line.lots.some(lot=>lot.lot_id===candidate.id))throw new Error(`O lote ${candidate.code} já foi informado neste lançamento.`);
    if(chosen.has(candidate.id))throw new Error(`O lote ${candidate.code} foi escolhido mais de uma vez.`);
    if(view.line.direction==='issue'&&lotUnits(quantity)>lotUnits(candidate.quantity))throw new Error(`O lote ${candidate.code} não tem saldo suficiente neste depósito.`);
    chosen.add(candidate.id);return {lot_id:candidate.id,quantity};
  });
  if(total>lotUnits(view.room))throw new Error(view.line.direction==='receipt'&&lotUnits(view.room)<lotUnits(view.line.unassigned)
    ?'A soma dos lotes passa do “Sem lote” do depósito (o saldo já saiu sem lote).':'A soma dos lotes passa da quantidade sem lote do lançamento.');
  return {product_id:view.product.id,warehouse_id:view.line.warehouse_id,expected_lots:view.line.lots_version,lots};
}
export interface LotsAssignResult extends MovementLots {replayed:boolean}
export function parseLotsAssign(value:unknown,movementId:string,body:Record<string,unknown>):LotsAssignResult {
  const view=parseMovementLots(value,movementId,body.product_id as string,body.warehouse_id as string,'stock_movement_lots_assign');
  need(isObject(value)&&typeof value.replayed==='boolean'&&Array.isArray(value.entries)&&(value.entries as unknown[]).length===(body.lots as unknown[]).length);
  need(value.replayed||view.line.lots_version===(body.expected_lots as number)+(body.lots as unknown[]).length);
  return {...view,replayed:value.replayed};
}
export const directionText=(direction:'receipt'|'issue')=>direction==='receipt'?'Entrada':'Saída';
