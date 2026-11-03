import { normalizeDocument } from '../../../../packages/erp-domain/src/index.mjs';
import type { DocumentEnvelope, DocumentInput, DocumentKind, DocumentRecord } from './real-documents-model';
import { itemGroup } from './service-order-items.ts';

export const COPY_RESET_FIELDS=['date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution'] as const;
export interface DocumentCopySource {id:string;kind:DocumentKind;number:string;version:number;}
export interface DocumentCopyPreview {source:DocumentCopySource;data:DocumentInput;reset_fields:string[];persisted:false;data_mode:'erp_native';operational_effects:false;}
export interface DocumentCopyEnvelope extends DocumentEnvelope {copy_source:DocumentCopySource;replayed:boolean;}
export interface DocumentCopyDraft {preview:DocumentCopyPreview;contact:{id:string;name:string};}
export interface DocumentCopyOrigin {document_id:string;kind:DocumentKind;copy_source:DocumentCopySource|null;data_mode:'erp_native';operational_effects:false;}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validVersion=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=2147483647;
function source(value:unknown,kind:DocumentKind):value is DocumentCopySource{return object(value)&&uuid(value.id)&&value.kind===kind&&typeof value.number==='string'&&/^[1-9][0-9]{0,9}$/.test(value.number)&&validVersion(value.version);}
export class CopyPreviewChanged extends Error {constructor(){super('O documento de origem mudou. Reabra-o para preparar a cópia da versão atual.');}}
function invalid():never{throw new Error('Não foi possível validar a cópia do documento.');}
export function readCopyPreview(value:unknown,record:DocumentRecord):DocumentCopyPreview {
 // 202610200132: a pedido de compra may keep the source date (Preferências "Data do pedido clonado"); 164 also keeps the data prevista.
 const reset=JSON.stringify((value as {reset_fields?:unknown}|null)?.reset_fields);
 const kept=record.kind!=='purchase_orders'?null:[['date'],['date','expected_date']].find(fields=>reset===JSON.stringify(COPY_RESET_FIELDS.filter(key=>!fields.includes(key))))??null;
 if(!object(value)||value.data_mode!=='erp_native'||value.operational_effects!==false||value.persisted!==false||!source(value.source,record.kind)||value.source.id!==record.id||value.source.number!==record.number||(!kept&&reset!==JSON.stringify(COPY_RESET_FIELDS)))invalid();
 const preview=value as unknown as DocumentCopyPreview;
 if(preview.source.version!==record.version)throw new CopyPreviewChanged();
 const data=(()=>{try{return normalizeDocument(record.kind,preview.data);}catch{return invalid();}})();
 if(data.template||data.installments.length||data.items.some(item=>item.id!==null)||COPY_RESET_FIELDS.filter(key=>!['date','installments','template',...(kept??[])].includes(key)).some(key=>data[key as keyof typeof data]!==null)||data.contact_id!==record.contact_id)invalid();
 const copy=structuredClone(preview);
 // 202610200268: an OS saved before the Peças / Serviços executados groups is copied with the group of each line taken from the type
 // of its product in the source (Serviço = S), as the source OS shows it; otherwise its serviços would be saved as peças.
 if(record.kind==='service_orders'){
  const kinds=new Map(record.items.filter(item=>item.product_id).map(item=>[item.product_id!,item.product_snapshot?.kind]));
  copy.data={...copy.data,items:copy.data.items.map(item=>Object.hasOwn(item,'group')?item:{...item,...(group=>({group,quote:false,done:false}))(itemGroup(item,item.product_id?kinds.get(item.product_id):undefined))})};
 }
 return copy;
}
export function readCopyResult(value:unknown,preview:DocumentCopyPreview):DocumentCopyEnvelope {
 if(!object(value)||value.data_mode!=='erp_native'||value.operational_effects!==false||typeof value.replayed!=='boolean'||value.kind!==preview.source.kind||!source(value.copy_source,preview.source.kind)||value.copy_source.id!==preview.source.id||value.copy_source.number!==preview.source.number||value.copy_source.version!==preview.source.version||!object(value.document))invalid();
 const doc=value.document;
 // 202610200129: a copied pedido is born Em aberto (Em digitação before it); propostas stay Rascunho.
 if(!uuid(doc.id)||doc.id===preview.source.id||doc.kind!==preview.source.kind||doc.version!==1||doc.source_proposal_id!==null||!(doc.kind==='sales_proposals'?doc.status==='draft':doc.status==='open'||(doc.kind==='sales_orders'&&doc.status==='draft')))invalid();
 return value as unknown as DocumentCopyEnvelope;
}
export function readCopyOrigin(value:unknown,record:Pick<DocumentRecord,'id'|'kind'>):DocumentCopyOrigin {
 if(!object(value)||value.data_mode!=='erp_native'||value.operational_effects!==false||value.document_id!==record.id||value.kind!==record.kind||!Object.hasOwn(value,'copy_source'))invalid();
 if(value.copy_source!==null&&(!source(value.copy_source,record.kind)||value.copy_source.id===record.id))invalid();
 return value as unknown as DocumentCopyOrigin;
}
