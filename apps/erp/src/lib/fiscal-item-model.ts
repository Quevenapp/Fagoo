import type {NativeRequestOptions} from './real-access';
import {fiscalDraftEnvelope,type FiscalDraftEnvelope} from './fiscal-drafts-model.ts';
import {gtinCheckDigitMatches,ITEM_PREPARATION_FIELDS,ITEM_PREPARATION_FLAGS} from '../../../../packages/fiscal-core/src/item-preparation.mjs';

export const ITEM_FIELDS=['ncm','origin','cest','gtin','gtin_tax'] as const;
export type ItemField=typeof ITEM_FIELDS[number];
export const ITEM_LABELS:Record<ItemField,string>={ncm:'NCM',origin:'Origem',cest:'CEST',gtin:'GTIN comercial',gtin_tax:'GTIN tributário'};
export interface FiscalItemController{
 fiscalItem(path:string,options?:NativeRequestOptions):Promise<unknown>;
 fiscalDraft(path:string,options?:NativeRequestOptions):Promise<unknown>;
}
export type ItemChoice={source:'manual';value:string|null}|{source:'catalog';expected_product_id:string;expected_version:number};
export interface ItemDecision{item_id:string;fields:Partial<Record<ItemField,ItemChoice>>;}
export type ItemChoices=Record<string,Partial<Record<ItemField,ItemChoice>>>;
// Compare decisions, including provenance, independently of edit/insertion order.
export function itemChoicesKey(choices:ItemChoices):string{
 return JSON.stringify(Object.keys(choices).sort().flatMap(itemId=>{
  const fields=ITEM_FIELDS.flatMap(field=>{const c=choices[itemId][field];return c?[[field,c.source,...(c.source==='manual'?[c.value]:[c.expected_product_id,c.expected_version])]]:[];});
  return fields.length?[[itemId,fields]]:[];
 }));
}
export type ItemProvenance={source:'unreviewed'|'manual'}|{source:'catalog';product_id:string;product_version:number;active:boolean};
export interface ResolvedItem{item_id:string;position:number;product_id:string|null;fields:Record<ItemField,{value:string|null;provenance:ItemProvenance;check_digit_verified:boolean}>;pending:string[];}
export interface FiscalItemSummary{draft_id:string;version:number;draft_version:number;snapshot_hash:string;model:'55'|'65';environment:'2';source_document_id:string;source_document_version:number;created_at:string|null;}
export interface FiscalItemReceipt extends FiscalItemSummary{items:ResolvedItem[];}
export interface FiscalItemEnvelope{record:FiscalItemReceipt|null;draft:FiscalDraftEnvelope;current:{preparation_version:number;draft_version:number;matches_current_draft:boolean};persisted?:false;expected_version?:number;replayed?:boolean;}
export interface FiscalItemHistory{draft_id:string;items:FiscalItemSummary[];limit:number;has_more:boolean;next_cursor:number|null;}
export interface ItemWrite{expected_draft_version:number;snapshot_hash:string;expected_version:number;decisions:ItemDecision[];command_id?:string;}
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const version=(v:unknown,min=1):v is number=>Number.isInteger(v)&&(v as number)>=min&&(v as number)<=2147483647;
const id=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v);
function bad():never{throw new Error('Não foi possível conferir a preparação dos itens. Consulte novamente a revisão.');}
export const ITEM_PENDING:Record<string,string>={NCM_NOT_PREPARED:'NCM não conferido.',ORIGIN_NOT_PREPARED:'Origem não conferida.',CEST_NOT_PREPARED:'CEST não informado; aplicabilidade a conferir.',GTIN_NOT_PREPARED:'GTIN comercial não conferido.',TRIBUTARY_GTIN_NOT_PREPARED:'GTIN tributário não conferido.',NCM_EXCEPTION_REQUIRES_REVIEW:'NCM de dois dígitos exige revisão da exceção.',NCM_CLASSIFICATION_UNVERIFIED:'Classificação NCM não verificada.',ORIGIN_CLASSIFICATION_UNVERIFIED:'Origem efetiva da mercadoria não verificada.',CEST_APPLICABILITY_UNREVIEWED:'Aplicabilidade do CEST não verificada.',GTIN_PRODUCT_MAPPING_UNVERIFIED:'Vínculo dos GTINs ao produto não verificado.',CFOP_UNPREPARED:'CFOP pendente.',CST_CSOSN_UNPREPARED:'CST/CSOSN pendentes.',TAX_GROUPS_UNPREPARED:'Grupos tributários e alíquotas pendentes.',TRIBUTARY_UNIT_QUANTITY_PRICE_UNPREPARED:'Unidade, quantidade e preço tributários pendentes.',FREE_ITEM_REQUIRES_REVIEW:'Item livre exige preparação fiscal própria.'};
const missing:Record<ItemField,string>={ncm:'NCM_NOT_PREPARED',origin:'ORIGIN_NOT_PREPARED',cest:'CEST_NOT_PREPARED',gtin:'GTIN_NOT_PREPARED',gtin_tax:'TRIBUTARY_GTIN_NOT_PREPARED'};
export function itemValueValid(value:unknown,field:ItemField):value is string|null{
 if(value===null)return true;if(typeof value!=='string')return false;
 if(field==='ncm')return /^(?:[0-9]{2}|[0-9]{8})$/.test(value);
 if(field==='origin')return /^[0-8]$/.test(value);
 if(field==='cest')return /^[0-9]{7}$/.test(value);
 return value==='SEM GTIN'||gtinCheckDigitMatches(value);
}
function flags(value:unknown):asserts value is Record<string,unknown>{
 if(!object(value)||value.data_mode!=='fiscal_item_preparation'||value.profile!=='item-identification-v1'||value.schema_profile!=='pl010f-v1.04'||Object.keys(ITEM_PREPARATION_FLAGS).some(k=>value[k]!==false))bad();
}
function summary(v:unknown,draftId:string,preview=false):FiscalItemSummary{
 if(!object(v)||v.draft_id!==draftId||!version(v.version)||!version(v.draft_version)||typeof v.snapshot_hash!=='string'||!HASH.test(v.snapshot_hash)||!['55','65'].includes(String(v.model))||v.environment!=='2'||!id(v.source_document_id)||!version(v.source_document_version)||(preview?v.created_at!==null:typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at))))bad();
 return Object.fromEntries(['draft_id','version','draft_version','snapshot_hash','model','environment','source_document_id','source_document_version','created_at'].map(k=>[k,v[k]])) as unknown as FiscalItemSummary;
}
export function fiscalItemEnvelope(value:unknown,draftId:string,options:{version?:number|null;request?:ItemWrite;preview?:boolean}={}):FiscalItemEnvelope{
 flags(value);const draft=fiscalDraftEnvelope(value.draft,draftId),c=value.current;let record:FiscalItemReceipt|null=null;
 if(value.record!==null){
  const meta=summary(value.record,draftId,options.preview),r=value.record as Record<string,unknown>;
  if(meta.draft_version!==draft.record.version||meta.snapshot_hash!==draft.record.snapshot_hash||meta.model!==draft.record.model||meta.source_document_id!==draft.record.source_document_id||meta.source_document_version!==draft.record.source_document_version||!Array.isArray(r.items)||r.items.length!==draft.record.snapshot.items.length)bad();
  const items=r.items.map((raw:unknown,index:number):ResolvedItem=>{
   const item=draft.record.snapshot.items[index];if(!object(raw)||raw.item_id!==item.id||raw.position!==item.position||raw.product_id!==item.product_id||!object(raw.fields))bad();
   const fields={} as ResolvedItem['fields'],pending:string[]=[];let catalogVersion:number|null=null,catalogActive:boolean|null=null;
   for(const f of ITEM_FIELDS){const v=raw.fields[f];if(!object(v)||!itemValueValid(v.value,f)||!object(v.provenance))bad();const p=v.provenance;let provenance:ItemProvenance;
    if(p.source==='unreviewed'||p.source==='manual'){if(p.source==='unreviewed'&&v.value!==null)bad();provenance={source:p.source};}
    else if(p.source==='catalog'){
     if(item.product_id===null||p.product_id!==item.product_id||!version(p.product_version)||p.product_version<item.product!.version||typeof p.active!=='boolean'||(catalogVersion!==null&&(catalogVersion!==p.product_version||catalogActive!==p.active)))bad();
     catalogVersion=p.product_version;catalogActive=p.active;provenance={source:'catalog',product_id:p.product_id as string,product_version:p.product_version,active:p.active};
    }else bad();
    const digit=(f==='gtin'||f==='gtin_tax')&&v.value!==null&&v.value!=='SEM GTIN';if(v.check_digit_verified!==digit)bad();fields[f]={value:v.value,provenance,check_digit_verified:digit};if(v.value===null)pending.push(missing[f]);
   }
   if(fields.ncm.value?.length===2)pending.push('NCM_EXCEPTION_REQUIRES_REVIEW');pending.push('NCM_CLASSIFICATION_UNVERIFIED','ORIGIN_CLASSIFICATION_UNVERIFIED','CEST_APPLICABILITY_UNREVIEWED','GTIN_PRODUCT_MAPPING_UNVERIFIED','CFOP_UNPREPARED','CST_CSOSN_UNPREPARED','TAX_GROUPS_UNPREPARED','TRIBUTARY_UNIT_QUANTITY_PRICE_UNPREPARED');if(item.product_id===null)pending.push('FREE_ITEM_REQUIRES_REVIEW');
   if(JSON.stringify(raw.pending)!==JSON.stringify(pending))bad();return{item_id:item.id,position:item.position,product_id:item.product_id,fields,pending};
  });record={...meta,items};
 }
 if(!object(c)||!version(c.preparation_version,0)||c.draft_version!==draft.current.version||c.matches_current_draft!==(record!==null&&record.draft_version===draft.current.version))bad();
 if(record===null){if(c.preparation_version!==0||options.request||options.version!=null||draft.record.version!==draft.current.version)bad();}
 else if(options.preview?record.version!==c.preparation_version+1:record.version>c.preparation_version)bad();
 if(!options.request&&record&&record.version!==(options.version??c.preparation_version))bad();
 if(options.request){const input=options.request;if(!record||draft.record.status!=='draft'||record.version!==input.expected_version+1||record.draft_version!==input.expected_draft_version||record.snapshot_hash!==input.snapshot_hash)bad();
  const chosen=new Map(input.decisions.map(d=>[d.item_id,d.fields]));if(input.decisions.some(d=>!record!.items.some(i=>i.item_id===d.item_id)))bad();
  for(const i of record.items)for(const f of ITEM_FIELDS){const choice=chosen.get(i.item_id)?.[f],actual=i.fields[f];if(!choice){if(actual.provenance.source!=='unreviewed')bad();}else if(choice.source!==actual.provenance.source)bad();else if(choice.source==='manual'){if(choice.value!==actual.value)bad();}else{const p=actual.provenance;if(p.source!=='catalog'||p.product_id!==choice.expected_product_id||p.product_version!==choice.expected_version)bad();}}
  if(options.preview){if(value.persisted!==false||value.expected_version!==input.expected_version||!c.matches_current_draft||draft.current.status!=='draft'||draft.current.source_status==='cancelled')bad();}
  else if(typeof value.replayed!=='boolean')bad();
 }
 return{record,draft,current:{preparation_version:c.preparation_version,draft_version:c.draft_version,matches_current_draft:c.matches_current_draft as boolean},...(options.preview?{persisted:false,expected_version:value.expected_version as number}:options.request?{replayed:value.replayed as boolean}:{})};
}
export function fiscalItemHistory(value:unknown,draftId:string,before:number|null):FiscalItemHistory{
 flags(value);if(value.draft_id!==draftId||value.limit!==25||!Array.isArray(value.items)||value.items.length>25||typeof value.has_more!=='boolean')bad();let previous=before??2147483648;
 const items=value.items.map(v=>{const m=summary(v,draftId);if(m.version>=previous)bad();previous=m.version;return m;});const next=value.has_more?items.at(-1)?.version:null;
 if((value.has_more&&items.length!==25)||value.next_cursor!==next)bad();return{draft_id:draftId,items,limit:25,has_more:value.has_more,next_cursor:next??null};
}
export function choicesFromReceipt(receipt:FiscalItemReceipt|null,draft:FiscalDraftEnvelope):ItemChoices{
 if(!receipt||receipt.draft_id!==draft.record.id||receipt.draft_version!==draft.record.version||receipt.snapshot_hash!==draft.record.snapshot_hash)return{};
 const result:ItemChoices={};for(const item of receipt.items){const fields:Partial<Record<ItemField,ItemChoice>>={};for(const f of ITEM_FIELDS){const v=item.fields[f],p=v.provenance;if(p.source==='manual')fields[f]={source:'manual',value:v.value};else if(p.source==='catalog')fields[f]={source:'catalog',expected_product_id:p.product_id,expected_version:p.product_version};}if(Object.keys(fields).length)result[item.item_id]=fields;}return result;
}
export function fiscalItemWrite(draft:FiscalDraftEnvelope,expectedVersion:number,choices:ItemChoices):ItemWrite{
 if(draft.record.version!==draft.current.version||draft.current.status!=='draft'||draft.current.source_status==='cancelled'||!version(expectedVersion,0)||expectedVersion===2147483647)throw new Error('Recarregue a revisão atual antes de preparar os itens.');
 const items=new Map(draft.record.snapshot.items.map(i=>[i.id,i]));if(Object.keys(choices).some(k=>!items.has(k)))bad();
 const decisions:ItemDecision[]=[];for(const item of draft.record.snapshot.items){const fields=choices[item.id];if(!fields||!Object.keys(fields).length)continue;
  if(Object.keys(fields).some(f=>!ITEM_PREPARATION_FIELDS.includes(f as ItemField)))bad();
  for(const f of ITEM_FIELDS){const c=fields[f];if(!c)continue;if(c.source==='manual'){if(!itemValueValid(c.value,f))throw new Error(`Item ${item.position}: confira o formato de ${ITEM_LABELS[f]}${f==='gtin'||f==='gtin_tax'?' e o dígito verificador':''}.`);}else if(c.source==='catalog'){if(!id(c.expected_product_id)||c.expected_product_id!==item.product_id||!version(c.expected_version))throw new Error(`Item ${item.position}: confira novamente a versão do catálogo.`);}else bad();}
  decisions.push({item_id:item.id,fields:structuredClone(fields)});
 }
 return{expected_draft_version:draft.record.version,snapshot_hash:draft.record.snapshot_hash,expected_version:expectedVersion,decisions};
}
