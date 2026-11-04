import type {DocumentKind} from './real-documents-model';

/** The sections of a commercial document in the order a seller fills them. Each id is an anchor in the editor. */
export type DocumentStep={id:string;label:string};

const SALES:readonly DocumentKind[]=['sales_orders','sales_proposals'];
export const isSalesFlow=(kind:DocumentKind)=>SALES.includes(kind);

export function documentSteps(kind:DocumentKind,hasRecord:boolean):DocumentStep[]{
 if(isSalesFlow(kind))return [
  {id:'document-identification',label:'Cliente'},
  {id:'document-line-items',label:'Itens'},
  {id:'document-payment',label:kind==='sales_proposals'?'Condições':'Pagamento'},
  {id:'document-delivery',label:'Entrega'},
  {id:'document-notes',label:'Observações'},
  ...(hasRecord?[{id:'document-operations',label:'Operações'}]:[]),
 ];
 return [
  {id:'document-identification',label:kind==='purchase_orders'?'Fornecedor':'Identificação'},
  {id:'document-line-items',label:'Itens e valores'},
  {id:'document-payment',label:'Pagamento'},
  {id:'document-operations',label:'Operações e histórico'},
 ];
}

type Key={key:string;code?:string;altKey?:boolean;ctrlKey?:boolean;metaKey?:boolean;shiftKey?:boolean};
/** Ctrl+S (Cmd+S): save the open document instead of the browser's "save page". */
export const isSaveShortcut=(event:Key)=>Boolean((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&(event.key.toLowerCase()==='s'||event.code==='KeyS'));
/** Alt+1…9: the step at that position (the physical key, so Option+1 on a Mac works too). */
export function stepIndexForKey(event:Key):number|null{
 if(!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return null;
 const match=/^Digit([1-9])$/.exec(event.code??'')??/^([1-9])$/.exec(event.key);
 return match?Number(match[1])-1:null;
}
