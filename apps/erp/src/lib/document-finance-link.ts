import type {PostingDetail} from './document-finance-model';
import type {DocumentKind} from './real-documents-model';
import {emptyFinanceRoute,financeListParams} from './finance-list-route.ts';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export function documentFinanceTitlePath(kind:DocumentKind,titleId:string):string{
 if(!['sales_orders','purchase_orders','service_orders'].includes(kind)||!uuid(titleId))throw new Error('Confira a parcela antes de abrir o financeiro.');
 return `/financeiro-empresa?${financeListParams({...emptyFinanceRoute(kind==='purchase_orders'?'payable':'receivable'),titleId})}`;
}
/** Only an exact title in the displayed posting can leave the document view. */
export function checkedDocumentFinanceTitle(record:{id:string;version:number;kind:DocumentKind},detail:PostingDetail,titleId:string):string{
 const direction=record.kind==='purchase_orders'?'payable':'receivable';
 if(!detail||detail.document_id!==record.id||detail.document_version!==record.version||detail.posting.document_id!==record.id
  ||detail.posting.kind!==record.kind||detail.posting.direction!==direction||!uuid(detail.posting.id)
  ||!Array.isArray(detail.titles)||detail.titles.filter(row=>row.id===titleId).length!==1)throw new Error('Atualize o documento e confira novamente a parcela.');
 documentFinanceTitlePath(record.kind,titleId);return titleId;
}
export function financeLinkActor(state:unknown):string|null{
 const s=state as {phase?:string;membership?:{user_id?:unknown;role?:unknown}}|null;
 return s?.phase==='ready'&&uuid(s.membership?.user_id)&&['admin','financeiro','consulta'].includes(String(s.membership?.role))?s.membership!.user_id as string:null;
}
