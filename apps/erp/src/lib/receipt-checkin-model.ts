// Check-in de Recebimentos no padrão do Origin (migração 147): defensive reads of the worker answers, exact quantity strings
// (four decimals, as the notes) and the Origin labels of the screen. No floating point is used.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,Q4=/^(0|[1-9]\d{0,10})\.\d{4}$/,PRICE=/^(0|[1-9]\d{0,13})\.\d{10}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_CHECKIN_RESPONSE');};
function need(value:unknown):asserts value {if(!value)fail();}

export const CHECKIN_PATH='/checkin-recebimentos';
/** Who reads the check-in (147): the native entry notes (112) are read by administrador and fiscal, and the estoque reads them here to
 * check the receipt. As in the notas lane (113), the consulta profile does not see the Brufap notes. */
export const CHECKIN_READERS:readonly string[]=['admin','estoque','fiscal'];
export const checkinHref=(invoiceId:string)=>`${CHECKIN_PATH}?nota=${invoiceId}`;
export const checkinNoteParam=(search:string)=>{const value=new URLSearchParams(search).get('nota');return value&&UUID.test(value)?value.toLowerCase():null;};
export type IssueKind='missing'|'damaged'|'incorrect'|'refused';
export type ItemState='pending'|'in_progress'|'complete'|'issue';
export type NoteState='pending'|'in_progress'|'finished';
export interface CheckinNote {invoice_id:string;invoice_version:number;model:string;issue_type:string;status:number;series:number;number:number|null;access_key:string|null;
  supplier:{name:string|null;document:string|null;person_type:string|null};issue_date:string;created_at:string;items_count:number;checkin_state:NoteState;open:boolean}
export interface CheckinItem {position:number;product_id:string|null;product_code:string|null;product_gtin:string|null;description:string;supplier_code:string|null;gtin:string|null;unit:string|null;
  quantity:string;unit_price:string;received:string;issue:IssueKind|null;issue_quantity:string|null;issue_action:'none'|null;state:ItemState;requested:{quantity:string;prices:string[]}|null;
  // 181: código do produto no fornecedor da nota (aba Fornecedores do cadastro) and the DUN codes (box GTIN, units per box).
  catalog_supplier_code:string|null;product_duns:{code:string;quantity:string}[]}
export interface CheckinEvent {id:number;action:string;position:number|null;description:string|null;quantity:string|null;previous:string|null;at:string}
export interface CheckinView {note:CheckinNote;checkin:{id:string;state:'in_progress'|'finished';version:number;invoice_version:number;stale:boolean;started_at:string;updated_at:string;finished_at:string|null}|null;
  version:number;items:CheckinItem[];summary:{total:number;complete:number;issue:number;refused:number;pending:number};events:CheckinEvent[];can_manage?:boolean;
  /** 181: "Usuário responsável" (Sistema › Usuários); null before the first command or on an older API. */
  responsible:{started_by_name:string|null;finished_by_name:string|null}|null}

export const NOTE_STATE_LABELS:Record<NoteState,string>={pending:'Check-in pendente',in_progress:'Em andamento',finished:'Conferência finalizada'};
export const ITEM_STATE_LABELS:Record<ItemState,string>={pending:'Check-in pendente',in_progress:'Check-in em andamento',complete:'Check-in completo',issue:'Check-in realizado e com pendência registrada'};
export const ISSUE_LABELS:Record<IssueKind,string>={missing:'produto faltando',damaged:'produto danificado',incorrect:'produto incorreto',refused:'produto recusado'};
export const ISSUE_QUANTITY_LABELS:Record<Exclude<IssueKind,'refused'>,string>={missing:'Quantidade faltante',damaged:'Quantidade danificada',incorrect:'Quantidade incorreta'};
export const EVENT_LABELS:Record<string,string>={received:'quantidade recebida',batch:'conferido sem pendências',missing:'produto faltando',damaged:'produto danificado',incorrect:'produto incorreto',
  refused:'produto recusado',restart:'conferência reiniciada',finish:'check-in finalizado'};
export const NO_NOTE='Nenhuma nota selecionada';
export const NO_NOTE_HELP='Selecione uma nota importada para começar o check-in de recebimentos';
export const WAITING_NOTE='Aguardando seleção de nota';
export const NOTES_INFO='Notas de entrada ainda não conferidas e sem estoque lançado. No FAGOO são as notas de entrada cadastradas (manual); a importação de XML e a busca na SEFAZ ainda não existem.';
export const BATCH_TEXT='Todos os produtos da linha selecionada serão marcados como verificados no check-in de recebimentos.';
export const RESTART_TEXT='Todas as quantidades recebidas e pendências registradas serão apagadas e a conferência começará de novo com os itens atuais da nota.';
export const FINISHED_TEXT='O check-in foi finalizado e registrado no sistema.';
export const LOAD_FAILURE='Não foi possível carregar a nota fiscal - Os dados estão temporariamente indisponíveis.';
export const notFound=(code:string)=>`O produto ${code} não foi localizado. Insira manualmente a quantidade recebida.`;

const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max;
const optional=(value:unknown,max:number)=>value===null||text(value,max);
function noteOf(value:unknown):CheckinNote {
  need(isObject(value)&&typeof value.invoice_id==='string'&&UUID.test(value.invoice_id)&&Number.isInteger(value.invoice_version)&&Number.isInteger(value.series)&&(value.number===null||Number.isInteger(value.number))
    &&isObject(value.supplier)&&optional(value.supplier.name,60)&&optional(value.supplier.document,14)&&typeof value.issue_date==='string'&&typeof value.created_at==='string'&&Number.isInteger(value.items_count)
    &&['pending','in_progress','finished'].includes(value.checkin_state as string)&&typeof value.open==='boolean'&&(value.access_key===null||(typeof value.access_key==='string'&&/^\d{44}$/.test(value.access_key))));
  const s=value.supplier as Record<string,unknown>;
  return {invoice_id:value.invoice_id,invoice_version:value.invoice_version as number,model:String(value.model),issue_type:String(value.issue_type),status:Number(value.status),series:value.series as number,
    number:value.number as number|null,access_key:value.access_key as string|null,supplier:{name:s.name as string|null,document:s.document as string|null,person_type:(s.person_type??null) as string|null},
    issue_date:value.issue_date as string,created_at:value.created_at as string,items_count:value.items_count as number,checkin_state:value.checkin_state as NoteState,open:value.open as boolean};
}
function itemOf(value:unknown):CheckinItem {
  need(isObject(value)&&Number.isInteger(value.position)&&(value.product_id===null||(typeof value.product_id==='string'&&UUID.test(value.product_id)))&&text(value.description,120)
    &&typeof value.quantity==='string'&&Q4.test(value.quantity)&&typeof value.received==='string'&&Q4.test(value.received)&&typeof value.unit_price==='string'&&PRICE.test(value.unit_price)
    &&(value.issue===null||['missing','damaged','incorrect','refused'].includes(value.issue as string))&&(value.issue_quantity===null||(typeof value.issue_quantity==='string'&&Q4.test(value.issue_quantity)))
    &&['pending','in_progress','complete','issue'].includes(value.state as string)&&optional(value.supplier_code,60)&&optional(value.gtin,20)&&optional(value.unit,6)&&optional(value.product_code,100)&&optional(value.product_gtin,20)
    &&(value.requested===null||(isObject(value.requested)&&typeof value.requested.quantity==='string'&&Q4.test(value.requested.quantity)&&Array.isArray(value.requested.prices)
      &&(value.requested.prices as unknown[]).every(price=>typeof price==='string'&&PRICE.test(price)))));
  const requested=value.requested as {quantity:string;prices:string[]}|null;
  const duns=value.product_duns===undefined?[]:value.product_duns;
  need(optional(value.catalog_supplier_code??null,60)&&Array.isArray(duns)&&(duns as unknown[]).every(dun=>isObject(dun)&&typeof dun.code==='string'&&/^\d{14}$/.test(dun.code)&&typeof dun.quantity==='string'&&/^(0|[1-9]\d{0,11})\.\d{6}$/.test(dun.quantity)));
  return {position:value.position as number,product_id:value.product_id as string|null,product_code:value.product_code as string|null,product_gtin:value.product_gtin as string|null,description:value.description as string,
    supplier_code:value.supplier_code as string|null,gtin:value.gtin as string|null,unit:value.unit as string|null,quantity:value.quantity as string,unit_price:value.unit_price as string,received:value.received as string,
    issue:value.issue as IssueKind|null,issue_quantity:value.issue_quantity as string|null,issue_action:(value.issue_action??null) as 'none'|null,state:value.state as ItemState,
    requested:requested?{quantity:requested.quantity,prices:[...requested.prices]}:null,
    catalog_supplier_code:(value.catalog_supplier_code??null) as string|null,product_duns:(duns as {code:string;quantity:string}[]).map(dun=>({code:dun.code,quantity:dun.quantity}))};
}
export function parseCheckinNotes(value:unknown,query:string|null,offset:number):{items:CheckinNote[];total:number;canManage:boolean} {
  need(isObject(value)&&value.scope==='stock_checkin_notes'&&value.data_mode==='erp_native'&&value.query===query&&value.offset===offset&&Number.isInteger(value.total)&&Array.isArray(value.items)&&typeof value.can_manage==='boolean');
  return {items:(value.items as unknown[]).map(noteOf),total:value.total as number,canManage:value.can_manage};
}
export function parseCheckin(value:unknown,invoiceId:string):CheckinView {
  need(isObject(value)&&value.scope==='stock_checkin'&&value.data_mode==='erp_native'&&Number.isInteger(value.version)&&Array.isArray(value.items)&&Array.isArray(value.events)&&isObject(value.summary));
  const note=noteOf(value.note);need(note.invoice_id===invoiceId);
  const c=value.checkin;
  need(c===null||(isObject(c)&&typeof c.id==='string'&&UUID.test(c.id)&&(c.state==='in_progress'||c.state==='finished')&&c.version===value.version&&typeof c.stale==='boolean'));
  const items=(value.items as unknown[]).map(itemOf);
  const events=(value.events as unknown[]).map(event=>{need(isObject(event)&&Number.isInteger(event.id)&&typeof event.action==='string'&&typeof event.at==='string');return {id:event.id as number,action:event.action,
    position:(event.position??null) as number|null,description:(event.description??null) as string|null,quantity:(event.quantity??null) as string|null,previous:(event.previous??null) as string|null,at:event.at};});
  const s=value.summary as Record<string,unknown>;
  need(['total','complete','issue','refused','pending'].every(key=>Number.isInteger(s[key]))&&s.total===items.length);
  const r=value.responsible;
  need(r===undefined||r===null||(isObject(r)&&optional(r.started_by_name,120)&&optional(r.finished_by_name,120)));
  return {note,checkin:c as CheckinView['checkin'],version:value.version as number,items,summary:{total:s.total as number,complete:s.complete as number,issue:s.issue as number,refused:s.refused as number,pending:s.pending as number},
    events,...(typeof value.can_manage==='boolean'?{can_manage:value.can_manage}:{}),
    responsible:isObject(r)?{started_by_name:r.started_by_name as string|null,finished_by_name:r.finished_by_name as string|null}:null};
}
export function parseCheckinCommand(value:unknown,invoiceId:string,body:Record<string,unknown>,action:string):CheckinView&{replayed:boolean} {
  need(isObject(value)&&typeof value.replayed==='boolean'&&isObject(value.receipt)&&value.receipt.command_id===body.command_id&&value.receipt.action===action&&value.receipt.invoice_id===invoiceId
    &&value.receipt.from_version===body.expected_version);
  return {...parseCheckin({...value,scope:'stock_checkin',data_mode:'erp_native'},invoiceId),replayed:value.replayed};
}

// ---- Exact quantities (four decimals) ----
export const units4=(value:string)=>{const [whole,fraction='']=value.split('.');return BigInt(whole+fraction.padEnd(4,'0').slice(0,4));};
export const fromUnits4=(value:bigint)=>{const digits=value.toString().padStart(5,'0');return `${digits.slice(0,-4)}.${digits.slice(-4)}`;};
/** Qtde Recebida typed like Origin ("1,5" or "1.5"): up to 11 integer digits and 4 decimals, never negative. */
export function receivedInput(text:string):string {
  const value=text.trim();
  if(!/^(0|[1-9]\d{0,10})(?:[.,]\d{1,4})?$/.test(value))throw new Error('Quantidade inválida!');
  return fromUnits4(units4(value.replace(',','.')));
}
export const stepReceived=(value:string,delta:1|-1)=>{const next=units4(value)+BigInt(delta)*10000n;return fromUnits4(next<0n?0n:next>999999999999999n?999999999999999n:next);};
export const itemState=(item:Pick<CheckinItem,'quantity'|'issue'>,received:string):ItemState=>item.issue!==null?'issue':units4(received)===0n?'pending':units4(received)<units4(item.quantity)?'in_progress':'complete';
/** "Preço diferente": the price of the note differs from a price of the linked purchase order. */
export const priceDiffers=(item:CheckinItem)=>Boolean(item.requested&&item.requested.prices.some(price=>price!==item.unit_price));
export const overNote=(item:CheckinItem,received:string)=>units4(received)>units4(item.quantity);
const fold=(value:string)=>value.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
/** Reader or typed search: an exact code (GTIN of the note or of the product, código no fornecedor of the note or of the cadastro, the
 * product SKU or a DUN of the product) finds one item; otherwise the text filters by the product name. A DUN reads the units of its box. */
export function matchItems(items:readonly CheckinItem[],search:string):{exact:CheckinItem|null;filtered:CheckinItem[];box:string|null} {
  const value=search.trim();if(!value)return {exact:null,filtered:[...items],box:null};
  const code=value.toLowerCase(),codes=(item:CheckinItem)=>[item.gtin,item.product_gtin,item.supplier_code,item.catalog_supplier_code,item.product_code].filter((v):v is string=>Boolean(v)).map(v=>v.toLowerCase());
  const exact=items.filter(item=>codes(item).includes(code));
  if(exact.length)return {exact:exact.length===1?exact[0]!:null,filtered:exact,box:null};
  const boxes=items.filter(item=>(item.product_duns??[]).some(dun=>dun.code===value));
  if(boxes.length)return {exact:boxes.length===1?boxes[0]!:null,filtered:boxes,box:boxes.length===1?(boxes[0]!.product_duns??[]).find(dun=>dun.code===value)!.quantity:null};
  return {exact:null,filtered:items.filter(item=>fold(item.description).includes(fold(value))),box:null};
}
/** Adds the units of a DUN box (six decimals in the cadastro) to Qtde Recebida (four decimals); null when the box cannot be added exactly. */
export function addBox(value:string,box:string):string|null {
  const [whole,fraction='']=box.split('.');if(/[1-9]/.test(fraction.slice(4)))return null;
  const next=units4(value)+BigInt(whole+fraction.padEnd(6,'0').slice(0,4));
  return next>999999999999999n?null:fromUnits4(next);
}
/** "Cod. fornecedor": the code of the product at the supplier of the note (cadastro) or, without it, the item code of the note. */
export const supplierCodeOf=(item:CheckinItem)=>item.catalog_supplier_code??item.supplier_code??null;
export const verified=(items:readonly CheckinItem[],drafts:Readonly<Record<number,string>>)=>items.filter(item=>item.issue!==null||itemState(item,drafts[item.position]??item.received)==='complete').length;
export const documentText=(value:string|null)=>!value?'—':value.length===14&&/^\d+$/.test(value)?value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5'):value.length===11?value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/,'$1.$2.$3-$4'):value;
export const localDateTime=(value:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
