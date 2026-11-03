// Controle de estoque no padrão do Origin (migração 105): lançamento, edição, transferência, totalizador e reservas.
// Quantidades e preços são strings decimais exatas; nenhuma conta usa ponto flutuante.
import {quantityText,type StockBalance,type StockBalanceCount,type StockEntry,type StockLedgerMovement} from './stock-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^-?(0|[1-9]\d{0,11})\.\d{6}$/,TOTAL=/^-?(0|[1-9]\d{0,31})\.\d{6}$/,MONEY=/^-?(0|[1-9]\d{0,35})\.\d{2}$/,PRICE=/^(0|[1-9]\d{0,13})\.\d{10}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_STOCK_RESPONSE');};
function need(value:unknown):asserts value {if(!value)fail();}
export const units=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');const result=BigInt(whole+fraction.padEnd(6,'0').slice(0,6));return negative?-result:result;};
const fromUnits=(value:bigint)=>{const negative=value<0n,digits=(negative?-value:value).toString().padStart(7,'0');return `${negative?'-':''}${digits.slice(0,-6)}.${digits.slice(-6)}`;};

// Origin labels of the "Novo Lançamento" panel.
export type StockLaunchKind='receipt'|'issue'|'balance';
export const STOCK_LAUNCH_LABELS:Record<StockLaunchKind,string>={receipt:'Entrada',issue:'Saída',balance:'Balanço'};
export const COST_INFO='Preço de compra + impostos + frete + outras despesas';
export const TRANSFER_COST_INFO='Preço un + impostos + frete + outras despesas';
export const TRANSFER_MINIMUM='Para habilitar a transferência entre depósitos é necessário ter no mínimo 2 depósitos cadastrados.';
export const SELECT_PRODUCT_TOAST='Você deve selecionar um produto para incluir um lançamento de estoque.';
export const EDIT_NOTICE='Mudança na forma de lançamento de estoque';
export const IGNORED_TITLE='Saldo deste depósito não é considerado.';

/** Price typed like Origin ("1,50" or "1.50"): up to 14 integer digits and 10 decimals, no thousand separators. */
export function priceInput(text:string,label:string):string {
  const value=text.trim();
  if(!value)throw new Error(`Informe o ${label.toLowerCase()}.`);
  if(!/^(0|[1-9]\d{0,13})(?:[.,]\d{1,10})?$/.test(value))throw new Error(`Informe o ${label.toLowerCase()} sem separador de milhar e com até 10 casas decimais.`);
  return value.replace(',','.');
}
/** 277: Preferências › Empresa › Geral "Número de casas decimais no preço nas entradas" (0 a 10) for the Preço de Compra and the
 * Preço de Custo of an Entrada or a Balanço; trailing zeros do not count (the server applies the same rule). */
export function entryPriceDecimals(value:string|null,label:string,decimals:number):string|null {
  if(value===null||decimals>=10)return value;
  const significant=(value.split('.')[1]??'').replace(/0+$/,'').length;
  if(significant>decimals)throw new Error(`O ${label} aceita até ${decimals} ${decimals===1?'casa decimal':'casas decimais'} (Preferências › Empresa › Geral).`);
  return value;
}
const samePrice=(a:string|null,b:string|null)=>{const norm=(v:string|null)=>v===null?null:v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v;return norm(a)===norm(b);};
/** Display of a stored price (ten decimals): at least two decimals, trailing zeros removed, "-" when absent. */
export function priceText(value:string|null|undefined):string {
  if(typeof value!=='string'||!/^(0|[1-9]\d{0,13})(?:\.\d{1,10})?$/.test(value))return '-';
  const [whole,fraction='']=value.split('.'),trimmed=fraction.replace(/0+$/,'');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${trimmed.padEnd(2,'0')}`;
}
/** A stored or catalogue price prefilled in an input ("2.5000000000" → "2,50"). */
export const priceDraft=(value:unknown)=>typeof value==='string'&&/^(0|[1-9]\d{0,13})(?:\.\d{1,10})?$/.test(value)?priceText(value):'';
export function moneyText(value:string):string {
  if(!MONEY.test(value))return '—';
  const negative=value.startsWith('-'),[whole,fraction]=value.replace(/^-/,'').split('.');
  return `${negative?'−':''}R$ ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${fraction}`;
}
/** Quantity of a launch: Entrada/Saída only positive; Balanço is the new balance and accepts any value, zero included. */
export function launchQuantity(text:string,kind:StockLaunchKind|'transfer'):string {
  const value=text.trim();
  const pattern=kind==='balance'?/^-?(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/:/^(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/;
  if(!pattern.test(value))throw new Error('Quantidade inválida!');
  const result=value.replace(',','.');
  if(/^-0(?:\.0+)?$/.test(result)||(kind!=='balance'&&/^0(?:\.0+)?$/.test(result)))throw new Error('Quantidade inválida!');
  return result;
}
// Origin: Balanço appends " Saldo: <qtd> (Saldo anterior: <qtd>)" to the observação.
export const balanceSuffix=(balance:StockBalanceCount|null)=>balance?` Saldo: ${quantityText(balance.counted)} (Saldo anterior: ${quantityText(balance.previous)})`:'';
export const ledgerNote=(row:Pick<StockLedgerMovement,'note'|'reason'|'balance'>)=>`${row.note??row.reason}${balanceSuffix(row.balance)}`;
/** Origin price columns: Entrada shows Preço de Compra and Preço de Custo, Saída shows Preço de Venda; the rest is "-". */
export function linePrices(row:Pick<StockLedgerMovement,'unit_price'|'unit_cost'|'balance'>,line:Pick<StockEntry,'quantity'>):{sale:string;purchase:string;cost:string} {
  const out=!row.balance&&line.quantity.startsWith('-');
  return out?{sale:priceText(row.unit_price),purchase:'-',cost:'-'}:{sale:'-',purchase:priceText(row.unit_price),cost:priceText(row.unit_cost)};
}
/** Colored "Saldo atual" icon: red when negative, yellow below the minimum, green otherwise; tooltip of limits. */
export function stockLevel(balance:string,min:unknown,max:unknown):{tone:'normal'|'low'|'negative';title:string} {
  const valid=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value);
  const current=units(balance),minimum=valid(min)?units(min):null,maximum=valid(max)?units(max):null;
  const missing=minimum!==null&&minimum>current?fromUnits(minimum-current):'0.000000';
  const tone=current<0n?'negative':minimum!==null&&current<minimum?'low':'normal';
  return {tone,title:`Estoque mínimo: ${minimum===null?'-':quantityText(fromUnits(minimum))}\nEstoque máximo: ${maximum===null?'-':quantityText(fromUnits(maximum))}\nEstoque faltante: ${quantityText(missing)}`};
}
/** "Todos" row of Saldos por depósito: the sum of the warehouses whose balance is considered. */
export function consideredTotal(balances:readonly StockBalance[]):string {
  return fromUnits(balances.filter(item=>!item.warehouse_ignored).reduce((sum,item)=>sum+units(item.quantity),0n));
}

// ---- Requests and defensive reads of the worker's projected answers ----
export interface LaunchDraft {kind:StockLaunchKind|'transfer';productId:string;warehouseId:string;expectedVersion:number;quantity:string;unitPrice:string;unitCost:string|null;note:string;destinationId?:string;destinationVersion?:number;
  /** Preferências > Suprimentos > Estoque "Exibir campo preço unitário nos lançamentos de estoque manual" (145): hidden fields send no price. */
  showPrice?:boolean;
  /** 277: "Número de casas decimais no preço nas entradas" (launch context), for Entrada and Balanço. */
  entryDecimals?:number}
// The observação is stored as one line (the 009 reason refuses control characters in SQL and in the worker).
export const SINGLE_LINE_NOTE='A observação deve ficar em uma única linha: retire as quebras de linha.';
const singleLine=(note:string)=>{if(/[\u0000-\u001f\u007f]/.test(note))throw new Error(SINGLE_LINE_NOTE);};
export function launchBody(input:LaunchDraft):Record<string,unknown> {
  if(!UUID.test(input.productId)||!UUID.test(input.warehouseId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)throw new Error('Atualize os saldos antes de lançar.');
  if(input.note.length>500)throw new Error('A observação pode ter até 500 caracteres.');
  singleLine(input.note.trim());
  const priceLabel=input.kind==='issue'?'Preço de Venda':input.kind==='transfer'?'Preço un.':'Preço de Compra',costLabel=input.kind==='transfer'?'Custo Un.':'Preço de Custo';
  const shown=input.showPrice!==false;
  const body:Record<string,unknown>={kind:input.kind,product_id:input.productId,warehouse_id:input.warehouseId,quantity:launchQuantity(input.quantity,input.kind),expected_version:input.expectedVersion,
    unit_price:shown?priceInput(input.unitPrice,priceLabel):null,note:input.note.trim()||null};
  if(input.kind!=='issue')body.unit_cost=shown?priceInput(input.unitCost??'',costLabel):null;
  if(input.kind==='receipt'||input.kind==='balance'){
    const decimals=input.entryDecimals??10;
    entryPriceDecimals(body.unit_price as string|null,priceLabel,decimals);entryPriceDecimals(body.unit_cost as string|null,costLabel,decimals);
  }
  if(input.kind==='transfer'){
    if(!input.destinationId||!UUID.test(input.destinationId)||input.destinationId===input.warehouseId||!Number.isInteger(input.destinationVersion))throw new Error('Selecione outro depósito ativo para o destino.');
    body.destination_id=input.destinationId;body.destination_version=input.destinationVersion;
  }
  return body;
}
const priceOrNull=(value:unknown)=>value===null||(typeof value==='string'&&PRICE.test(value));
export interface LaunchResult {kind:string;occurred_on:string;movement:{id:string;items:StockEntry[]};detail:{revision:number;unit_price:string|null;unit_cost:string|null;note:string};balance:StockBalanceCount|null;replayed:boolean;
  lot?:{id:string;code:string;created:boolean}}
export function parseLaunchResult(value:unknown,body:Record<string,unknown>):LaunchResult {
  need(isObject(value)&&value.scope==='stock_launch'&&value.data_mode==='erp_native'&&value.kind===body.kind&&typeof value.replayed==='boolean'&&isObject(value.movement)&&isObject(value.detail));
  const movement=(value as {movement:Record<string,unknown>}).movement,detail=(value as {detail:Record<string,unknown>}).detail;
  need(typeof movement.id==='string'&&UUID.test(movement.id)&&Array.isArray(movement.items)&&movement.items.length>=1&&movement.items.length<=2
    &&(movement.items as unknown[]).every(line=>isObject(line)&&line.product_id===body.product_id&&typeof line.quantity==='string'&&STORED.test(line.quantity)&&typeof line.balance_after==='string'&&STORED.test(line.balance_after))
    &&detail.revision===1&&priceOrNull(detail.unit_price)&&priceOrNull(detail.unit_cost)&&typeof detail.note==='string');
  const balance=value.balance===null?null:isObject(value.balance)&&typeof value.balance.counted==='string'&&STORED.test(value.balance.counted)&&typeof value.balance.previous==='string'&&STORED.test(value.balance.previous)
    ?{counted:value.balance.counted,previous:value.balance.previous,warehouse_id:String(value.balance.warehouse_id),source:'launch' as const}:fail();
  need((body.kind==='balance')===(balance!==null));
  // 258: a lançamento with Lote returns the lot it moved (the one chosen, or the "Novo lote" it created).
  const sentLot=isObject(body.lot)?body.lot:null,lot=isObject(value.lot)?value.lot:null;
  need(sentLot?lot!==null&&typeof lot.id==='string'&&UUID.test(lot.id)&&typeof lot.code==='string'&&(typeof sentLot.lot_id==='string'?lot.id===sentLot.lot_id&&lot.created===false:lot.created===true&&lot.code===sentLot.code):value.lot===undefined);
  return {kind:String(value.kind),occurred_on:String(value.occurred_on),movement:{id:movement.id as string,items:movement.items as StockEntry[]},
    detail:{revision:1,unit_price:detail.unit_price as string|null,unit_cost:detail.unit_cost as string|null,note:detail.note as string},balance,replayed:value.replayed as boolean,
    ...(lot?{lot:{id:lot.id as string,code:lot.code as string,created:lot.created===true}}:{})};
}
export function amendBody(row:Pick<StockLedgerMovement,'revision'|'balance'>&{items:Pick<StockEntry,'quantity'|'product_id'>[];kind?:string;unit_price?:string|null;unit_cost?:string|null},productId:string,unitPrice:string,unitCost:string,note:string,entryDecimals=10):Record<string,unknown> {
  if(note.length>500)throw new Error('A observação pode ter até 500 caracteres.');
  singleLine(note);
  const out=!row.balance&&row.items.every(line=>line.quantity.startsWith('-'));
  const body={product_id:productId,expected_revision:row.revision,unit_price:priceInput(unitPrice,out?'Preço de Venda':'Preço de Compra'),
    unit_cost:out?null:priceInput(unitCost,'Preço de Custo'),note};
  // 277: a changed price or cost of an entry (Entrada or Balanço) keeps "Número de casas decimais no preço nas entradas".
  if(['receipt','adjustment'].includes(row.kind??'')&&row.items.some(line=>line.product_id===productId&&!line.quantity.startsWith('-'))){
    if(!samePrice(body.unit_price,row.unit_price??null))entryPriceDecimals(body.unit_price,'Preço de Compra',entryDecimals);
    if(!samePrice(body.unit_cost,row.unit_cost??null))entryPriceDecimals(body.unit_cost,'Preço de Custo',entryDecimals);
  }
  return body;
}
export function parseAmendResult(value:unknown,movementId:string,body:Record<string,unknown>) {
  need(isObject(value)&&value.scope==='stock_amend'&&value.movement_id===movementId&&value.product_id===body.product_id&&typeof value.replayed==='boolean'&&isObject(value.detail)
    &&(value.detail as Record<string,unknown>).revision===(body.expected_revision as number)+1);
  return value as {detail:{revision:number;unit_price:string|null;unit_cost:string|null;note:string};replayed:boolean};
}
export interface StockWarehouseOption {id:string;name:string;active:boolean;is_default:boolean;ignore_balance:boolean}
export type CostBasis='preco_compra'|'custo_lancamento';
export const COST_BASIS_LABELS:Record<CostBasis,string>={preco_compra:'preço de compra',custo_lancamento:'custo do lançamento'};
// 145: Valor de Custo do Estoque (quantity × custo médio). The custo médio comes from purchase prices: null for who does not read purchase orders.
export interface StockTotals {warehouse_id:string|null;quantity:string;sale_value:string;unpriced_products:number;ignored_warehouses:number;warehouses:StockWarehouseOption[];
  cost_visible:boolean;cost_value:string|null;uncosted_products:number|null;cost_basis:CostBasis}
export function parseStockTotals(value:unknown,warehouseId:string|null):StockTotals {
  need(isObject(value)&&value.scope==='stock_totals'&&value.data_mode==='erp_native'&&value.warehouse_id===warehouseId&&typeof value.quantity==='string'&&TOTAL.test(value.quantity)
    &&typeof value.sale_value==='string'&&MONEY.test(value.sale_value)&&Number.isInteger(value.unpriced_products)&&Number.isInteger(value.ignored_warehouses)&&Array.isArray(value.warehouses));
  const warehouses=(value.warehouses as unknown[]).map(item=>{need(isObject(item)&&typeof item.id==='string'&&UUID.test(item.id)&&typeof item.name==='string'&&item.name.length>0
    &&typeof item.active==='boolean'&&typeof item.is_default==='boolean'&&typeof item.ignore_balance==='boolean');const row=item as Record<string,unknown>;
    return {id:row.id as string,name:row.name as string,active:row.active as boolean,is_default:row.is_default as boolean,ignore_balance:row.ignore_balance as boolean};});
  need(warehouses.filter(item=>item.is_default).length<=1);
  // An answer without the 145 fields (older API) shows the cost as unavailable; present fields are checked strictly.
  const legacy=value.cost_visible===undefined&&value.cost_value===undefined&&value.uncosted_products===undefined&&value.cost_basis===undefined;
  need(legacy||(typeof value.cost_visible==='boolean'&&(value.cost_basis==='preco_compra'||value.cost_basis==='custo_lancamento')
    &&(value.cost_visible?typeof value.cost_value==='string'&&MONEY.test(value.cost_value)&&Number.isInteger(value.uncosted_products):value.cost_value===null&&value.uncosted_products===null)));
  return {warehouse_id:warehouseId,quantity:value.quantity as string,sale_value:value.sale_value as string,unpriced_products:value.unpriced_products as number,ignored_warehouses:value.ignored_warehouses as number,warehouses,
    cost_visible:legacy?false:value.cost_visible as boolean,cost_value:legacy?null:value.cost_value as string|null,uncosted_products:legacy?null:value.uncosted_products as number|null,cost_basis:legacy?'preco_compra':value.cost_basis as CostBasis};
}
/** "Visualizar vendas": explicit reservations (070) and, with the company option on (145), orders reserved by their situation. */
export interface StockReservation {reservation_id:string|null;source:'reservation'|'situation';document_id:string;document_number:string;status:string;contact_name:string|null;warehouse_id:string|null;warehouse_ignored:boolean;quantity:string;unit:string;
  /** 277: the custom situation (situação personalizada) of the pedido, when it has one. */
  situation_id?:string|null;situation_name?:string|null}
export interface ReservationPolicy {by_situation:boolean;by_warehouse:boolean;statuses:string[];situation_ids?:string[];unassigned_quantity?:string}
const policy=(value:unknown,withQuantity:boolean):ReservationPolicy=>{need(isObject(value)&&typeof value.by_situation==='boolean'&&typeof value.by_warehouse==='boolean'&&Array.isArray(value.statuses)
  &&(value.statuses as unknown[]).every(item=>typeof item==='string')&&(!withQuantity||typeof value.unassigned_quantity==='string'&&STORED.test(value.unassigned_quantity)));
  return {by_situation:value.by_situation as boolean,by_warehouse:value.by_warehouse as boolean,statuses:[...value.statuses as string[]],...(withQuantity?{unassigned_quantity:value.unassigned_quantity as string}:{})};};
/** Saldos answer: an older API has no reservation settings (null: only explicit reservations exist). */
export const parseReservationPolicy=(value:unknown)=>value===undefined?null:policy(value,true);
export function parseReservations(value:unknown,productId:string,warehouseId:string|null):{items:StockReservation[];total:number;quantity:string;reservation:ReservationPolicy} {
  need(isObject(value)&&value.scope==='stock_product_reservations'&&value.product_id===productId&&value.warehouse_id===warehouseId&&Array.isArray(value.items)
    &&Number.isInteger(value.total)&&typeof value.quantity==='string'&&TOTAL.test(value.quantity));
  const reservation=value.reservation===undefined?{by_situation:false,by_warehouse:true,statuses:[]}:policy(value.reservation,false);
  const items=(value.items as unknown[]).map(raw=>{need(isObject(raw));const item={source:'reservation',warehouse_ignored:false,situation_id:null,situation_name:null,...raw} as Record<string,unknown>;
    need((item.situation_id===null&&item.situation_name===null)||(item.source==='situation'&&typeof item.situation_id==='string'&&UUID.test(item.situation_id)&&typeof item.situation_name==='string'));
    need(typeof item.document_id==='string'&&UUID.test(item.document_id)&&typeof item.document_number==='string'
    &&typeof item.quantity==='string'&&STORED.test(item.quantity)&&(item.source==='reservation'?typeof item.reservation_id==='string'&&UUID.test(item.reservation_id)&&typeof item.warehouse_id==='string'
      :item.source==='situation'&&item.reservation_id===null&&(item.warehouse_id===null||typeof item.warehouse_id==='string'))
    &&(warehouseId===null||item.warehouse_id===warehouseId||(item.source==='situation'&&item.warehouse_id===null)));return item as unknown as StockReservation;});
  return {items,total:value.total as number,quantity:value.quantity as string,reservation};
}
/** Reservado of the extrato: the chosen warehouse, or the considered warehouses ("Todos"); a reservation by situation that is not per
 * warehouse (unassigned) counts for every considered warehouse. */
export function reservedDisplay(balances:readonly StockBalance[],warehouseId:string,reservation:ReservationPolicy|null):string {
  const rows=balances.filter(item=>warehouseId?item.warehouse_id===warehouseId:!item.warehouse_ignored);
  const total=rows.reduce((sum,item)=>sum+units(item.reserved_quantity??'0.000000'),0n)+units(reservation?.unassigned_quantity??'0.000000');
  return fromUnits(total);
}
// ---- 145: Novo Lançamento and Transferência follow Preferências > Suprimentos > Estoque ----
export type PriceType='ultima_compra'|'compra_fornecedor'|'custo_fornecedor';
// 181: the default supplier of the product (aba Fornecedores, 119) for "Preço de compra/custo (Fornecedor padrão)".
export interface DefaultSupplier {supplier_id:string;supplier_name:string;code:string|null;purchase_price:string|null;cost_price:string|null}
export interface LaunchContext {settings:{show_unit_price:boolean;price_type:PriceType;consider_balances:boolean;average_cost_base:CostBasis};
  last_purchase:{unit_price:string;unit_cost:string|null;occurred_on:string;movement_id:string;source:'manual'|'purchase_order'|'balance'}|null;average_cost:string|null;sale_price:string|null;
  default_supplier?:DefaultSupplier|null;
  /** 277: decimals allowed in the prices of an Entrada or a Balanço (10 from an older API). */
  price_decimals:{entry:number}}
export function parseLaunchContext(value:unknown,productId:string):LaunchContext {
  need(isObject(value)&&value.scope==='stock_launch_context'&&value.data_mode==='erp_native'&&value.product_id===productId&&isObject(value.settings)
    &&typeof value.settings.show_unit_price==='boolean'&&['ultima_compra','compra_fornecedor','custo_fornecedor'].includes(value.settings.price_type as string)
    &&typeof value.settings.consider_balances==='boolean'&&['preco_compra','custo_lancamento'].includes(value.settings.average_cost_base as string)
    &&priceOrNull(value.average_cost)&&priceOrNull(value.sale_price));
  const last=value.last_purchase;
  need(last===null||(isObject(last)&&typeof last.unit_price==='string'&&PRICE.test(last.unit_price)&&priceOrNull(last.unit_cost)&&typeof last.occurred_on==='string'
    &&typeof last.movement_id==='string'&&UUID.test(last.movement_id)&&['manual','purchase_order','balance'].includes(last.source as string)));
  const settings=value.settings as LaunchContext['settings'];
  const supplier=value.default_supplier;
  need(supplier===undefined||supplier===null||(isObject(supplier)&&typeof supplier.supplier_id==='string'&&UUID.test(supplier.supplier_id)&&typeof supplier.supplier_name==='string'
    &&(supplier.code===null||typeof supplier.code==='string')&&priceOrNull(supplier.purchase_price)&&priceOrNull(supplier.cost_price)));
  const decimals=value.price_decimals;
  need(decimals===undefined||(isObject(decimals)&&Number.isInteger(decimals.entry)&&(decimals.entry as number)>=0&&(decimals.entry as number)<=10));
  return {price_decimals:{entry:isObject(decimals)?decimals.entry as number:10},settings:{show_unit_price:settings.show_unit_price,price_type:settings.price_type,consider_balances:settings.consider_balances,average_cost_base:settings.average_cost_base},
    last_purchase:last===null?null:{...(last as NonNullable<LaunchContext['last_purchase']>)},average_cost:value.average_cost as string|null,sale_price:value.sale_price as string|null,
    default_supplier:isObject(supplier)?{supplier_id:supplier.supplier_id as string,supplier_name:supplier.supplier_name as string,code:supplier.code as string|null,purchase_price:supplier.purchase_price as string|null,cost_price:supplier.cost_price as string|null}:null};
}
export const PRICE_TYPE_HELP:Record<Exclude<PriceType,'ultima_compra'>,string>={
  compra_fornecedor:'O preço sugerido é o preço de compra do fornecedor padrão, que este produto não tem no cadastro (aba Fornecedores). Informe o preço.',
  custo_fornecedor:'O preço sugerido é o preço de custo do fornecedor padrão, que este produto não tem no cadastro (aba Fornecedores). Informe o preço.'};
/** Prices prefilled like Origin: Entrada, Balanço and Transferência use the preference (última compra or the price of the default supplier),
 * Saída the sale price; the cost is the custo médio of the product (or the cost of the price's origin while there is no average). */
export function contextSuggestion(context:LaunchContext,productPrice:unknown):{sale:string;purchase:string;cost:string;showPrice:boolean;help:string|null} {
  const last=context.last_purchase,type=context.settings.price_type,supplier=context.default_supplier??null;
  if(type!=='ultima_compra'){
    const price=type==='compra_fornecedor'?supplier?.purchase_price??null:supplier?.cost_price??null;
    return {sale:priceDraft(context.sale_price??productPrice),purchase:priceDraft(price),cost:priceDraft(context.average_cost??supplier?.cost_price??price),
      showPrice:context.settings.show_unit_price,help:price===null?PRICE_TYPE_HELP[type]:null};
  }
  return {sale:priceDraft(context.sale_price??productPrice),purchase:priceDraft(last?.unit_price),cost:priceDraft(context.average_cost??last?.unit_cost??last?.unit_price),
    showPrice:context.settings.show_unit_price,help:last?null:'Ainda não há compra com preço registrada para este produto no FAGOO.'};
}


