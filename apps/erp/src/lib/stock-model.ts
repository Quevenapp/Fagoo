import {brDate,parseIso} from './origin-list.ts';
export type StockKind = 'receipt' | 'issue' | 'adjustment' | 'transfer' | 'reversal';
export const STOCK_LABELS: Record<StockKind,string> = {receipt:'Entrada',issue:'Saída',adjustment:'Ajuste',transfer:'Transferência',reversal:'Estorno'};
/** 105 adds the depósito padrão, "Desconsiderar saldo deste depósito" and the reserved quantity (optional for older fixtures). */
export interface StockBalance {warehouse_id:string;warehouse_name:string;warehouse_active:boolean;quantity:string;version:number;unit:string|null;warehouse_default?:boolean;warehouse_ignored?:boolean;reserved_quantity?:string;situation_reserved_quantity?:string;virtual?:true}
export interface StockEntry {product_id:string;warehouse_id:string;quantity:string;unit:string;balance_after:string;balance_version:number}
export interface StockMovement {id:string;kind:StockKind;occurred_on:string;reason:string;reference:string|null;created_at:string;reverses_id:string|null;reversed_by:string|null;items:StockEntry[]}
export interface StockPage {items:StockMovement[];limit:number;has_more:boolean;next_cursor:string|null;data_mode:'erp_native'}
export function quantityInput(text:string, signed=false):string {
  const value=text.trim();
  if(!(signed?/^-?(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/:/^(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/).test(value))throw new Error('Informe uma quantidade sem separador de milhar e com até 6 casas decimais.');
  const result=value.replace(',','.');
  if(/^-?0(?:\.0+)?$/.test(result))throw new Error('A quantidade deve ser diferente de zero.');
  return result;
}
export function quantityText(value:string):string {
  if(!/^-?\d+(?:\.\d+)?$/.test(value))return '—';
  const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');
  const decimals=fraction.replace(/0+$/,'');
  return `${negative?'−':''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')}${decimals?`,${decimals}`:''}`;
}
export function stockDate():string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(type=>parts.find(part=>part.type===type)?.value).join('-');
}
export function stockItems(product:string,kind:Exclude<StockKind,'reversal'>,quantity:string,source:string,destination:string,balances:StockBalance[]) {
  const value=quantityInput(quantity,kind==='adjustment');
  const from=balances.find(item=>item.warehouse_id===source);
  if(!from?.warehouse_active)throw new Error('Selecione um depósito ativo.');
  const line=(balance:StockBalance,amount:string)=>({product_id:product,warehouse_id:balance.warehouse_id,quantity:amount,expected_version:balance.version});
  if(kind==='transfer'){
    const to=balances.find(item=>item.warehouse_id===destination);
    if(!to?.warehouse_active||to.warehouse_id===from.warehouse_id)throw new Error('Selecione outro depósito ativo para o destino.');
    return [line(from,`-${value}`),line(to,value)];
  }
  return [line(from,kind==='issue'?`-${value}`:value)];
}

// ---- Extrato "Lançamentos de estoque" no padrão do Origin (GET /v1/estoque/movimentos com offset; migração 098) ----
export type StockOriginType='sales'|'purchases'|'services'|'transfers'|'none'|'invoices'|'deleted';
export type StockDocumentKind='sales_orders'|'purchase_orders'|'service_orders';
// 259: the screen of the note of a lançamento by the note (origin "Notas Fiscais").
export type StockInvoiceKind='nfe_saida'|'nfe_entrada'|'nfce';
export interface StockOrigin {type:StockOriginType;document_id:string|null;document_kind:StockDocumentKind|StockInvoiceKind|null;document_number:string|null;via:'document_stock'|'purchase_receipt'|'invoice_stock'|null}
// Origin "Tipo" of the extrato (105): Entrada and Saída by the sign of the line, Balanço by the recorded count.
export type StockDirection='entry'|'exit'|'balance';
export const STOCK_DIRECTION_LABELS:Record<StockDirection,string>={entry:'Entrada',exit:'Saída',balance:'Balanço'};
export interface StockBalanceCount {counted:string;previous:string;warehouse_id:string;source:'launch'|'count'}
/** Ledger rows carry only the queried product's lines; other_items counts the lines of other products. Prices and the
 * observação come from the newest revision (105); without one, unit_price may be the document item price. */
export interface StockLedgerMovement extends StockMovement {recorded_at_local:string;other_items:number;origin:StockOrigin;
 revision:number;note:string|null;unit_price:string|null;unit_cost:string|null;price_source:'detail'|'document'|null;balance:StockBalanceCount|null}
export interface StockLedgerFilters {warehouse_id:string;kind:''|StockKind;origin:''|StockOriginType;from:string;to:string;direction:''|StockDirection}
export interface StockLedgerTotals {entries:string;exits:string;current_balance:string;unit:string|null}
export interface StockLedgerPage {product_id:string;items:StockLedgerMovement[];limit:number;offset:number;total:number;has_more:boolean;next_offset:number|null;totals:StockLedgerTotals;data_mode:'erp_native'}
export const STOCK_LEDGER_SIZE=100;
export const EMPTY_LEDGER_FILTERS:StockLedgerFilters={warehouse_id:'',kind:'',origin:'',from:'',to:'',direction:''};
// Origin "Tipo de Origem": the Brufap notes post stock since 259 (Notas Fiscais); 364: "Origem excluída" is a lançamento whose note
// (or document) was deleted afterwards, still in the balance and with its historical identification.
export const STOCK_ORIGIN_LABELS:Record<StockOriginType,string>={invoices:'Notas Fiscais',sales:'Vendas',purchases:'Compras',services:'Serviços',transfers:'Transferências',none:'Sem origem',deleted:'Origem excluída'};
const INVOICE_KINDS:readonly StockInvoiceKind[]=['nfe_saida','nfe_entrada','nfce'];
export const STOCK_DOCUMENT_LABELS:Record<StockDocumentKind,string>={sales_orders:'Pedido de venda',purchase_orders:'Pedido de compra',service_orders:'Ordem de serviço'};
const ORIGIN_DOCUMENTS:Record<StockOriginType,StockDocumentKind|null>={sales:'sales_orders',purchases:'purchase_orders',services:'service_orders',transfers:null,none:null,invoices:null,deleted:null};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEDGER_DECIMAL=/^-?(0|[1-9]\d{0,11})(?:\.\d{1,6})?$/,LEDGER_TOTAL=/^(0|[1-9]\d{0,31})\.\d{6}$/,LEDGER_SIGNED_TOTAL=/^-?(0|[1-9]\d{0,31})\.\d{6}$/;
const LOCAL_TIME=/^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const LEDGER_KINDS=Object.keys(STOCK_LABELS) as StockKind[],ORIGIN_TYPES=Object.keys(STOCK_ORIGIN_LABELS) as StockOriginType[],DIRECTIONS=Object.keys(STOCK_DIRECTION_LABELS) as StockDirection[];
const LEDGER_PRICE=/^(0|[1-9]\d{0,13})\.\d{10}$/,LEDGER_STORED=/^-?(0|[1-9]\d{0,11})\.\d{6}$/;

// Same date window as the API and erp_stock_ledger (1900-01-01..2100-12-31); a typed 01/01/1800 never reaches the API.
const ledgerDate=(value:string)=>Boolean(parseIso(value))&&value>='1900-01-01'&&value<='2100-12-31';
/** Filters must be valid before a request: kinds/origins from the allow-lists, ISO dates in the API window, from <= to. */
export function validLedgerFilters(filters:StockLedgerFilters):boolean {
  return (!filters.warehouse_id||UUID.test(filters.warehouse_id))&&(!filters.kind||LEDGER_KINDS.includes(filters.kind))&&(!filters.origin||ORIGIN_TYPES.includes(filters.origin))
    &&(!filters.direction||DIRECTIONS.includes(filters.direction))
    &&(!filters.from||ledgerDate(filters.from))&&(!filters.to||ledgerDate(filters.to))&&!(filters.from&&filters.to&&filters.from>filters.to);
}
/** Query of the ledger mode: always product_id, limit=100 and offset; empty filters are omitted (the API rejects empty values). */
export function ledgerQuery(productId:string,filters:StockLedgerFilters,page:number):string {
  if(!UUID.test(productId)||!Number.isSafeInteger(page)||page<1||!validLedgerFilters(filters))throw new Error('INVALID_LEDGER_QUERY');
  const params=new URLSearchParams({product_id:productId,limit:String(STOCK_LEDGER_SIZE),offset:String((page-1)*STOCK_LEDGER_SIZE)});
  for(const [key,value] of [['warehouse_id',filters.warehouse_id],['kind',filters.kind],['origin',filters.origin],['date_from',filters.from],['date_to',filters.to],['direction',filters.direction]] as const)if(value)params.set(key,value);
  return params.toString();
}
export const ledgerPageCount=(total:number)=>Math.max(1,Math.ceil(total/STOCK_LEDGER_SIZE));
function ledgerOrigin(value:unknown):StockOrigin {
  if(!isObject(value)||!ORIGIN_TYPES.includes(value.type as StockOriginType))throw new Error('INVALID_LEDGER');
  const type=value.type as StockOriginType,kind=ORIGIN_DOCUMENTS[type];
  if(type==='deleted'){
    const invoice=INVOICE_KINDS.includes(value.document_kind as StockInvoiceKind),documents=Object.keys(STOCK_DOCUMENT_LABELS) as StockDocumentKind[];
    if(typeof value.document_id!=='string'||!UUID.test(value.document_id)||!(invoice||documents.includes(value.document_kind as StockDocumentKind))
      ||(invoice?value.via!=='invoice_stock'||(value.document_number!==null&&(typeof value.document_number!=='string'||!/^[1-9]\d{0,8}$/.test(value.document_number)))
        :typeof value.document_number!=='string'||!/^[1-9]\d{0,9}$/.test(value.document_number)||!['document_stock','purchase_receipt'].includes(value.via as string)))throw new Error('INVALID_LEDGER');
    return {type,document_id:value.document_id,document_kind:value.document_kind as StockDocumentKind|StockInvoiceKind,document_number:value.document_number as string|null,via:value.via as StockOrigin['via']};
  }
  if(type==='invoices'){
    if(typeof value.document_id!=='string'||!UUID.test(value.document_id)||!INVOICE_KINDS.includes(value.document_kind as StockInvoiceKind)||value.via!=='invoice_stock'
      ||(value.document_number!==null&&(typeof value.document_number!=='string'||!/^[1-9]\d{0,8}$/.test(value.document_number))))throw new Error('INVALID_LEDGER');
    return {type,document_id:value.document_id,document_kind:value.document_kind as StockInvoiceKind,document_number:value.document_number as string|null,via:'invoice_stock'};
  }
  if(kind?(typeof value.document_id!=='string'||!UUID.test(value.document_id)||value.document_kind!==kind||typeof value.document_number!=='string'||!/^[1-9]\d{0,9}$/.test(value.document_number)||!['document_stock','purchase_receipt'].includes(value.via as string))
    :(value.document_id!==null||value.document_kind!==null||value.document_number!==null||value.via!==null))throw new Error('INVALID_LEDGER');
  return {type,document_id:value.document_id as string|null,document_kind:kind,document_number:value.document_number as string|null,via:value.via as StockOrigin['via']};
}
/** Defensive read of the worker's projected page; it must answer this exact product, filter set and page. */
export function stockLedgerPage(value:unknown,productId:string,filters:StockLedgerFilters,page:number):StockLedgerPage {
  const offset=(page-1)*STOCK_LEDGER_SIZE;
  if(!isObject(value)||value.data_mode!=='erp_native'||value.product_id!==productId||value.limit!==STOCK_LEDGER_SIZE||value.offset!==offset
    ||!Number.isSafeInteger(value.total)||(value.total as number)<0||typeof value.has_more!=='boolean'||!Array.isArray(value.items)||value.items.length>STOCK_LEDGER_SIZE
    ||!isObject(value.totals)||!['entries','exits'].every(key=>typeof (value.totals as Record<string,unknown>)[key]==='string'&&LEDGER_TOTAL.test((value.totals as Record<string,string>)[key]!))
    // Saldo atual is negative when the company allows negative stock (migration100); "-0" never is.
    ||typeof (value.totals as Record<string,unknown>).current_balance!=='string'||!LEDGER_SIGNED_TOTAL.test((value.totals as Record<string,string>).current_balance!)||/^-0\.0+$/.test((value.totals as Record<string,string>).current_balance!))throw new Error('INVALID_LEDGER');
  const totals=value.totals as Record<string,unknown>;
  if(totals.unit!==null&&typeof totals.unit!=='string')throw new Error('INVALID_LEDGER');
  const items=value.items.map((row:unknown)=>{
    if(!isObject(row)||typeof row.id!=='string'||!UUID.test(row.id)||!LEDGER_KINDS.includes(row.kind as StockKind)||typeof row.occurred_on!=='string'||!parseIso(row.occurred_on)
      ||typeof row.recorded_at_local!=='string'||!LOCAL_TIME.test(row.recorded_at_local)||typeof row.reason!=='string'||(row.reference!==null&&typeof row.reference!=='string')
      ||typeof row.created_at!=='string'||!Number.isInteger(row.other_items)||(row.other_items as number)<0||!Array.isArray(row.items)||!row.items.length
      ||row.items.some((line:unknown)=>!isObject(line)||line.product_id!==productId||typeof line.warehouse_id!=='string'||typeof line.quantity!=='string'||!LEDGER_DECIMAL.test(line.quantity)
        ||typeof line.balance_after!=='string'||!LEDGER_DECIMAL.test(line.balance_after)||typeof line.unit!=='string'||!Number.isInteger(line.balance_version))
      ||(filters.warehouse_id&&!row.items.some((line:Record<string,unknown>)=>line.warehouse_id===filters.warehouse_id))||(filters.kind&&row.kind!==filters.kind)
      ||(filters.from&&row.occurred_on<filters.from)||(filters.to&&row.occurred_on>filters.to))throw new Error('INVALID_LEDGER');
    const origin=ledgerOrigin(row.origin);
    if(filters.origin&&origin.type!==filters.origin)throw new Error('INVALID_LEDGER');
    return {...(row as unknown as StockLedgerMovement),origin,...ledgerDetail(row,origin,filters)};
  });
  return {product_id:productId,items,limit:STOCK_LEDGER_SIZE,offset,total:value.total as number,has_more:value.has_more,next_offset:(value.next_offset as number|null)??null,
    totals:{entries:totals.entries as string,exits:totals.exits as string,current_balance:totals.current_balance as string,unit:totals.unit as string|null},data_mode:'erp_native'};
}
// Exact comparison of six-decimal strings without floating point.
const microUnits=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');const result=BigInt(whole+fraction.padEnd(6,'0').slice(0,6));return negative?-result:result;};
function ledgerDetail(row:Record<string,unknown>,origin:StockOrigin,filters:StockLedgerFilters):Pick<StockLedgerMovement,'revision'|'note'|'unit_price'|'unit_cost'|'price_source'|'balance'> {
  const priced=(value:unknown)=>value===null||(typeof value==='string'&&LEDGER_PRICE.test(value));
  const revision=row.revision,source=row.price_source;
  if(!Number.isInteger(revision)||(revision as number)<0||!priced(row.unit_price)||!priced(row.unit_cost)||![null,'detail','document'].includes(source as string)
    ||((revision as number)>0?source!=='detail'||typeof row.note!=='string'||row.note.length>500:row.note!==null||row.unit_cost!==null||source==='detail'||(source==='document')!==(row.unit_price!==null))
    ||(source==='document'&&!origin.document_id))throw new Error('INVALID_LEDGER');
  let balance:StockBalanceCount|null=null;
  if(row.balance!==null){
    const b=row.balance,lines=row.items as StockEntry[];
    if(!isObject(b)||typeof b.counted!=='string'||!LEDGER_STORED.test(b.counted)||typeof b.previous!=='string'||!LEDGER_STORED.test(b.previous)||typeof b.warehouse_id!=='string'||!UUID.test(b.warehouse_id)
      ||!['launch','count'].includes(b.source as string)||row.kind!=='adjustment'||lines.length!==1||lines[0]!.warehouse_id!==b.warehouse_id
      ||microUnits(lines[0]!.quantity)!==microUnits(b.counted)-microUnits(b.previous))throw new Error('INVALID_LEDGER');
    balance={counted:b.counted,previous:b.previous,warehouse_id:b.warehouse_id,source:b.source as StockBalanceCount['source']};
  }
  if(filters.direction){
    const lines=(row.items as StockEntry[]).filter(line=>!filters.warehouse_id||line.warehouse_id===filters.warehouse_id);
    if(filters.direction==='balance'?!balance:balance||!lines.some(line=>filters.direction==='entry'?!line.quantity.startsWith('-'):line.quantity.startsWith('-')))throw new Error('INVALID_LEDGER');
  }
  return {revision:revision as number,note:row.note as string|null,unit_price:row.unit_price as string|null,unit_cost:row.unit_cost as string|null,price_source:source as StockLedgerMovement['price_source'],balance};
}
/** Origin shows "dd/mm/aaaa hh:mm:ss". The time is the registration time in São Paulo; a back-dated lançamento keeps its
 * informed date and shows when it was registered, because each line's saldo follows the registration order. */
export function ledgerMoment(row:{occurred_on:string;recorded_at_local:string}):{date:string;time:string;recorded:string;backdated:boolean} {
  const match=LOCAL_TIME.exec(row.recorded_at_local),date=brDate(row.occurred_on);
  if(!match||!date)return {date:date||'—',time:'',recorded:'',backdated:false};
  return {date,time:match[2]!,recorded:`${brDate(match[1]!)} ${match[2]}`,backdated:match[1]!==row.occurred_on};
}
// Read rule of erp_documents.allowed (migration 008) for the kinds that move stock. Every stock reader sees the origin
// label, but the link is offered only to roles the documents screen will open it for (vendas never reads purchase
// orders; estoque and fiscal never read service orders).
const DOCUMENT_READERS:Record<StockDocumentKind,readonly string[]>={sales_orders:['admin','consulta','financeiro','vendas','estoque','fiscal'],purchase_orders:['admin','consulta','financeiro','estoque','fiscal'],service_orders:['admin','consulta','financeiro','vendas']};
export function originReadable(origin:StockOrigin,role:string|undefined):boolean {
  // 364: a deleted origin is shown, never opened.
  if(origin.type==='deleted')return false;
  // The Brufap notes open for administrador and fiscal (113).
  if(origin.type==='invoices')return role==='admin'||role==='fiscal';
  return Boolean(origin.document_kind&&role&&DOCUMENT_READERS[origin.document_kind as StockDocumentKind].includes(role));
}
const INVOICE_LABELS:Record<StockInvoiceKind,string>={nfe_saida:'NF-e',nfe_entrada:'NF-e de entrada',nfce:'NFC-e'};
/** Deep link of the source document (same URL the document list opens, so Ctrl/middle click works in a new tab). */
export function originHref(origin:StockOrigin):string|null {
  if(origin.type==='invoices'&&origin.document_id)return origin.document_kind==='nfe_entrada'?`/notas-entrada?${new URLSearchParams({origem:'brufap',nota:origin.document_id})}`
    :`/historico-fiscal?${new URLSearchParams({modelo:origin.document_kind==='nfce'?'65':'55',origem:'brufap',nota:origin.document_id})}`;
  return origin.document_id&&origin.document_kind?`/documentos-empresa?${new URLSearchParams({tipo:origin.document_kind,documento:origin.document_id})}`:null;
}
export function originLabel(origin:StockOrigin):string {
  if(origin.type==='deleted'){
    const invoice=INVOICE_LABELS[origin.document_kind as StockInvoiceKind];
    const name=invoice?`${invoice} ${origin.document_number?origin.document_number.padStart(6,'0'):'sem número'}`:`${STOCK_DOCUMENT_LABELS[origin.document_kind as StockDocumentKind]??'Documento'} ${origin.document_number??''}`.trim();
    return `${name} (origem excluída)`;
  }
  if(origin.type==='invoices')return `${INVOICE_LABELS[origin.document_kind as StockInvoiceKind]??'Nota fiscal'} ${origin.document_number?origin.document_number.padStart(6,'0'):'sem número'}`;
  if(origin.document_kind&&origin.document_number)return `${STOCK_DOCUMENT_LABELS[origin.document_kind as StockDocumentKind]} ${origin.document_number}`;
  return origin.type==='transfers'?'Transferência entre depósitos':'Sem origem';
}
