/** Pure item identification decisions. No persistence, tax selection, XML or IO. */
import {buildFiscalReview,FISCAL_REVIEW_SCHEMA} from './review.mjs';

export const ITEM_PREPARATION_PROFILE='item-identification-v1';
export const ITEM_PREPARATION_SCHEMA=FISCAL_REVIEW_SCHEMA;
export const ITEM_PREPARATION_FIELDS=Object.freeze(['ncm','origin','cest','gtin','gtin_tax']);
export const ITEM_PREPARATION_ORIGINS=Object.freeze(['0','1','2','3','4','5','6','7','8']);
export const ITEM_PREPARATION_FLAGS=Object.freeze({operational_effects:false,emission_enabled:false,
 can_emit:false,tax_rules_validated:false,xsd_validated:false,catalog_registry_verified:false});
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const GTIN=/^(?:[0-9]{8}|[0-9]{12,14})$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v);
const version=v=>Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));

export class ItemPreparationError extends Error {
 constructor(code,itemId=null,field=null){super(code);this.name='ItemPreparationError';this.code=code;
  this.item_id=id(itemId)?itemId:null;this.field=ITEM_PREPARATION_FIELDS.includes(field)?field:null;}
}
const reject=(code,itemId,field)=>{throw new ItemPreparationError(code,itemId,field);};

/** GS1 modulo10 arithmetic only: does not verify assignment or product identity. */
export function gtinCheckDigitMatches(value){
 if(typeof value!=='string'||!GTIN.test(value))return false;
 let sum=0n,weight=3n;
 for(let index=value.length-2;index>=0;index--){sum+=BigInt(value[index])*weight;weight=weight===3n?1n:3n;}
 return (10n-sum%10n)%10n===BigInt(value.at(-1));
}
function fieldValue(value,field,itemId){
 if(value===null)return null;
 if(typeof value!=='string')reject('ITEM_PREPARATION_INVALID_VALUE',itemId,field);
 if(field==='origin'){
  if(!ITEM_PREPARATION_ORIGINS.includes(value))reject('ITEM_PREPARATION_INVALID_ORIGIN',itemId,field);
 }else if(field==='ncm'){
  if(!/^(?:[0-9]{2}|[0-9]{8})$/.test(value))reject('ITEM_PREPARATION_INVALID_NCM',itemId,field);
 }else if(field==='cest'){
  if(!/^[0-9]{7}$/.test(value))reject('ITEM_PREPARATION_INVALID_CEST',itemId,field);
 }else if(value!=='SEM GTIN'){
  if(!GTIN.test(value))reject('ITEM_PREPARATION_INVALID_GTIN',itemId,field);
  if(!gtinCheckDigitMatches(value))reject('ITEM_PREPARATION_GTIN_CHECK_DIGIT',itemId,field);
 }
 return value;
}
const missing={ncm:'NCM_NOT_PREPARED',origin:'ORIGIN_NOT_PREPARED',cest:'CEST_NOT_PREPARED',gtin:'GTIN_NOT_PREPARED',gtin_tax:'TRIBUTARY_GTIN_NOT_PREPARED'};

/**
 * `basis` is the server-supplied029 review basis, not trusted client catalog data.
 * The caller explicitly chooses each field. Unchosen values stay unreviewed;
 * even a known historical/catalog value is never copied automatically.
 */
export function prepareFiscalItems(input){
 if(!exact(input,['basis','expected','decisions']))reject('ITEM_PREPARATION_INVALID_INPUT');
 const expected=input.expected;
 if(!exact(expected,['draft_id','draft_version','snapshot_hash'])||!id(expected.draft_id)||!version(expected.draft_version)
   ||typeof expected.snapshot_hash!=='string'||!HASH.test(expected.snapshot_hash))reject('ITEM_PREPARATION_INVALID_BINDING');
 let review;
 try{review=buildFiscalReview(input.basis);}catch{reject('ITEM_PREPARATION_INVALID_BASIS');}
 const {draft,catalog,observed_at}=review.basis,r=draft.record,s=r.snapshot;
 if(typeof s.number!=='string'||!/^[1-9][0-9]{0,9}$/.test(s.number))reject('ITEM_PREPARATION_INVALID_BASIS');
 if(r.id!==expected.draft_id||r.version!==expected.draft_version||r.snapshot_hash!==expected.snapshot_hash)reject('ITEM_PREPARATION_BINDING_CONFLICT');
 if(!Array.isArray(input.decisions)||input.decisions.length>250)reject('ITEM_PREPARATION_INVALID_DECISIONS');
 const byItem=new Map(s.items.map(item=>[item.id,item])),byProduct=new Map(catalog.map(entry=>[entry.product_id,entry.record])),decisions=new Map();
 for(const entry of Array.from(input.decisions)){
  if(!exact(entry,['item_id','fields'])||!id(entry.item_id)||!object(entry.fields))reject('ITEM_PREPARATION_INVALID_DECISION');
  if(!byItem.has(entry.item_id))reject('ITEM_PREPARATION_FOREIGN_ITEM',entry.item_id);
  if(decisions.has(entry.item_id))reject('ITEM_PREPARATION_DUPLICATE_ITEM',entry.item_id);
  const keys=Object.keys(entry.fields);
  if(!keys.length||keys.some(key=>!ITEM_PREPARATION_FIELDS.includes(key)))reject('ITEM_PREPARATION_INVALID_FIELDS',entry.item_id);
  decisions.set(entry.item_id,entry.fields);
 }
 const items=s.items.map(item=>{
  const chosen=decisions.get(item.id)||{},fields={},pending=[];
  for(const field of ITEM_PREPARATION_FIELDS){
   const choice=chosen[field];let value=null,provenance={source:'unreviewed'};
   if(Object.hasOwn(chosen,field)){
    if(!object(choice))reject('ITEM_PREPARATION_INVALID_CHOICE',item.id,field);
    if(choice.source==='manual'){
     if(!exact(choice,['source','value']))reject('ITEM_PREPARATION_INVALID_CHOICE',item.id,field);
     value=fieldValue(choice.value,field,item.id);provenance={source:'manual'};
    }else if(choice.source==='catalog'){
     if(!exact(choice,['source','expected_product_id','expected_version'])||!id(choice.expected_product_id)||!version(choice.expected_version))reject('ITEM_PREPARATION_INVALID_CHOICE',item.id,field);
     if(item.product_id===null||choice.expected_product_id!==item.product_id)reject('ITEM_PREPARATION_PRODUCT_MISMATCH',item.id,field);
     const product=byProduct.get(item.product_id);
     if(!product)reject('ITEM_PREPARATION_CATALOG_UNAVAILABLE',item.id,field);
     if(product.version!==choice.expected_version)reject('ITEM_PREPARATION_CATALOG_CONFLICT',item.id,field);
     value=fieldValue(product[field],field,item.id);
     provenance={source:'catalog',product_id:product.id,product_version:product.version,active:product.active};
    }else reject('ITEM_PREPARATION_INVALID_CHOICE',item.id,field);
   }
   fields[field]={value,provenance,check_digit_verified:['gtin','gtin_tax'].includes(field)&&value!==null&&value!=='SEM GTIN'};
   if(value===null)pending.push(missing[field]);
  }
  if(fields.ncm.value?.length===2)pending.push('NCM_EXCEPTION_REQUIRES_REVIEW');
  // Filled identifiers do not prove classification, CEST applicability or GTIN registration.
  pending.push('NCM_CLASSIFICATION_UNVERIFIED','ORIGIN_CLASSIFICATION_UNVERIFIED','CEST_APPLICABILITY_UNREVIEWED','GTIN_PRODUCT_MAPPING_UNVERIFIED',
   'CFOP_UNPREPARED','CST_CSOSN_UNPREPARED','TAX_GROUPS_UNPREPARED','TRIBUTARY_UNIT_QUANTITY_PRICE_UNPREPARED');
  if(item.product_id===null)pending.push('FREE_ITEM_REQUIRES_REVIEW');
  return{item_id:item.id,position:item.position,product_id:item.product_id,fields,pending};
 });
 const pending=['OPERATION_FISCAL_MAPPING_UNPREPARED','PAYMENT_FISCAL_MAPPING_UNPREPARED','TAX_RULES_UNREVIEWED','XML_NOT_BUILT'];
 if(draft.current.version!==r.version)pending.unshift('HISTORICAL_DRAFT_REVISION');
 if(draft.current.status==='archived')pending.unshift('DRAFT_ARCHIVED');
 if(draft.current.source_changed)pending.push('SOURCE_DOCUMENT_CHANGED');
 if(draft.current.company_changed)pending.push('COMPANY_CONFIGURATION_CHANGED');
 if(draft.current.source_status==='cancelled')pending.push('SOURCE_DOCUMENT_CANCELLED');
 return{data_mode:'fiscal_item_preparation',profile:ITEM_PREPARATION_PROFILE,schema_profile:ITEM_PREPARATION_SCHEMA,...ITEM_PREPARATION_FLAGS,
  binding:{draft_id:r.id,draft_version:r.version,snapshot_hash:r.snapshot_hash,model:r.model,environment:'2',source_document_id:r.source_document_id,source_document_version:r.source_document_version},
  observed_at,
  // Values are copied verbatim from the validated commercial snapshot, never recalculated here.
  commercial:{number:s.number,date:s.date,discount_mode:s.discount_mode,discount_value:s.discount_value,totals:structuredClone(s.totals),
   items:s.items.map(item=>pick(item,['id','position','product_id','description','code','unit','quantity','unit_price','discount_percent','gross','discount','total']))},
  items,pending,
  //029 findings still describe the original snapshot; preparation does not erase them.
  snapshot_findings:structuredClone(review.report.findings)};
}
