/** Private068 contract. Persisted declarations are not fiscal approval or permission to send. */
import {createHash} from 'node:crypto';
import {ruleProfileByHash,matchesRuleProfile} from './rule-profile-registry.mjs';
export const MAX_SUBSET_RECORD_BYTES=131072;
export const SUBSET_REVIEW_FLAGS=Object.freeze({data_mode:'fiscal_subset_review',environment:'2',coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false,sefaz_authorized:false,can_emit:false,can_transmit:false,operational_binding_enabled:false,financial_mutation_performed:false,stock_mutation_performed:false});
export const SUBSET_SCHEMA=Object.freeze({schema_profile:'pl010f-v1.04',manifest_hash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',validator_version:'fiscal-schema-runner-v1',validator_hash:'7c546683d6ca94d124b60a32ca9f6bf8f731533455af634326a10ae078ea5cec'});
export class SubsetReviewError extends Error{constructor(code){super(code);this.name='SubsetReviewError';this.code=code;}}
export const need=(v,code='SUBSET_REVIEW_INVALID')=>{if(!v)throw new SubsetReviewError(code);};
export const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const int=(v,min=1,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export const hash=v=>createHash('sha256').update(v,'utf8').digest('hex');
export const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function fields(v,keys,optional=[]){try{
 need(v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
 const ds=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(ds);
 need(keys.every(k=>Object.hasOwn(ds,k))&&own.every(k=>typeof k==='string'&&[...keys,...optional].includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')));
 return Object.fromEntries(own.map(k=>[k,ds[k].value]));
}catch{throw new SubsetReviewError('SUBSET_REVIEW_INVALID');}}
export function canonical(value){let count=0;function visit(v,depth){
 need(depth<=16&&++count<=25000,'SUBSET_REVIEW_LIMIT');
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='string'){need(v.isWellFormed(),'SUBSET_REVIEW_INVALID');return v;}
 if(typeof v==='number'){need(int(v,0),'SUBSET_REVIEW_INVALID');return v;}
 if(Array.isArray(v)){
  const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(ds);need(ks.length===v.length+1&&Object.hasOwn(ds,'length'));
  return Array.from({length:v.length},(_,i)=>{const d=ds[String(i)];need(d?.enumerable&&Object.hasOwn(d,'value'));return visit(d.value,depth+1);});
 }
 need(v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
 const ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(ds);need(keys.every(k=>typeof k==='string'&&/^[a-z_]+$/.test(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')));
 return Object.fromEntries(keys.sort().map(k=>[k,visit(ds[k].value,depth+1)]));
}return JSON.stringify(visit(value,0));}
const choice=(v,values)=>need(typeof v==='string'&&values.includes(v));
const money=v=>typeof v==='string'&&/^(?:0|[1-9]\d{0,12})\.\d{2}$/.test(v);
export function declaration(value){
 const v=fields(value,['document','items']),d=fields(v.document,['operation','recipient_regime','acquisition_purpose','payment','excluded_groups']);
 choice(d.operation,['internal_normal_sale','outside_scope','unreviewed']);choice(d.recipient_regime,['regular_icms','simples','noncontributor','unreviewed']);choice(d.acquisition_purpose,['resale','industrialization','final_consumption','unreviewed']);choice(d.payment,['matches_signed_document','unreviewed']);choice(d.excluded_groups,['not_applicable','applies','unreviewed']);
 need(Array.isArray(v.items)&&int(v.items.length,1,250));
 // Inspect array descriptors before reading its elements.
 const safe=JSON.parse(canonical({document:d,items:v.items}));
 const items=safe.items.map((item,i)=>{
  const x=fields(item,['position','item_hash','classification','benefit','pis_cofins','gtin','st','fcp','credit']);need(x.position===i+1&&sha(x.item_hash));
  choice(x.classification,['reviewed_physical_goods','outside_scope','unreviewed']);choice(x.benefit,['not_applicable','applies','unreviewed']);choice(x.pis_cofins,['normal_unified_simples','other','unreviewed']);choice(x.gtin,['reviewed_absent','reviewed_identifiers','unreviewed']);choice(x.st,['documented_prior_retention','not_applicable','unreviewed']);choice(x.fcp,['documented_prior_retention','not_applicable','unreviewed']);
  if(x.credit!==null){const c=fields(x.credit,['eligibility','base','rate','amount','period','source_hash','statement']);need(c.eligibility==='reviewed_lc123_art23'&&money(c.base)&&money(c.amount)&&typeof c.rate==='string'&&/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(c.rate)&&typeof c.period==='string'&&/^\d{4}-(?:0[1-9]|1[0-2])$/.test(c.period)&&sha(c.source_hash)&&typeof c.statement==='string'&&c.statement.length>0&&c.statement.length<=1000&&!/[\u0000-\u001f\u007f-\u009f]/.test(c.statement));x.credit=c;}
  return x;
 });return freeze({document:d,items});
}
export function declarationText(value){need(typeof value==='string'&&value.isWellFormed()&&Buffer.byteLength(value,'utf8')<=MAX_SUBSET_RECORD_BYTES);let parsed;try{parsed=JSON.parse(value);}catch{throw new SubsetReviewError('SUBSET_REVIEW_INVALID');}const d=declaration(parsed);need(canonical(d)===value,'SUBSET_REVIEW_NOT_CANONICAL');return value;}
export function schema(value,signedHash){const v=fields(value,['xml_hash',...Object.keys(SUBSET_SCHEMA)]);need(v.xml_hash===signedHash&&Object.entries(SUBSET_SCHEMA).every(([k,x])=>v[k]===x));return freeze(v);}
export function stamp(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))return false;const t=Date.parse(v);return Number.isFinite(t)&&new Date(t).toISOString()===v;}
export function recordText(text){
 need(typeof text==='string'&&text.isWellFormed()&&Buffer.byteLength(text,'utf8')<=MAX_SUBSET_RECORD_BYTES,'SUBSET_REVIEW_LIMIT');let raw;try{raw=JSON.parse(text);}catch{throw new SubsetReviewError('SUBSET_REVIEW_INVALID');}
 const r=fields(raw,['id','version','candidate_id','signed_hash','facts_hash','profile','profile_hash','reviewed_by','reviewed_at','valid_until','review_hash','document','items']);
 need([r.id,r.candidate_id,r.reviewed_by].every(id)&&int(r.version)&&[r.signed_hash,r.facts_hash,r.profile_hash,r.review_hash].every(sha)&&matchesRuleProfile(r.profile,r.profile_hash)&&stamp(r.reviewed_at)&&stamp(r.valid_until)&&r.reviewed_at<r.valid_until);
 declaration({document:r.document,items:r.items});need(canonical(r)===text,'SUBSET_REVIEW_NOT_CANONICAL');
 const{review_hash,...body}=r;need(hash(canonical(body))===review_hash,'SUBSET_REVIEW_HASH_MISMATCH');return freeze(r);
}
export const RPC_NAMES=Object.freeze(['erp_fiscal_subset_review_save','erp_fiscal_subset_review_get','erp_fiscal_subset_review_command','erp_fiscal_subset_review_latest']);
export function captureArgs(name,args){
 need(RPC_NAMES.includes(name),'SUBSET_REVIEW_RPC_UNSUPPORTED');const kind=name.slice('erp_fiscal_subset_review_'.length);
 const keys=kind==='command'?['p_user_id','p_command_id']:['get','latest'].includes(kind)?['p_user_id','p_candidate_id','p_candidate_version','p_signed_hash','p_facts_hash','p_profile_hash']:['p_user_id','p_command_id','p_candidate_id','p_expected_candidate_version','p_signed_hash','p_expected_review_version','p_facts_hash','p_profile_hash','p_schema','p_valid_until','p_declaration_text'];
 const v=fields(args,keys);need(id(v.p_user_id)&&(!Object.hasOwn(v,'p_command_id')||id(v.p_command_id)));
 if(kind!=='command')need(id(v.p_candidate_id)&&int(v[kind==='save'?'p_expected_candidate_version':'p_candidate_version'])&&sha(v.p_signed_hash)&&sha(v.p_facts_hash)&&ruleProfileByHash(v.p_profile_hash)!==null);
 if(kind==='save'){need(int(v.p_expected_review_version,0,2147483646)&&stamp(v.p_valid_until));v.p_schema=schema(v.p_schema,v.p_signed_hash);v.p_declaration_text=declarationText(v.p_declaration_text);}
 return freeze(v);
}
const RECEIPT_KEYS=['review_id','command_id','review_version','reviewed_by','reviewed_at','valid_until','candidate_id','candidate_version','signed_hash','facts_hash','profile','profile_hash','schema','review_hash','coverage'];
export function projectSubsetReview(name,value,args){
 const latest=name==='erp_fiscal_subset_review_latest';
 const x=fields(value,[...(latest?['lookup_profile','matches_requested_profile']:[]),...Object.keys(SUBSET_REVIEW_FLAGS),'actor','candidate_id','candidate_version','signed_hash','facts_hash','profile_hash','read_only','replayed','receipt','current','record_text']);
 need(Object.entries(SUBSET_REVIEW_FLAGS).every(([k,v])=>x[k]===v)&&x.actor===args.p_user_id&&id(x.candidate_id)&&int(x.candidate_version)&&sha(x.signed_hash)&&sha(x.facts_hash)&&ruleProfileByHash(x.profile_hash)!==null&&typeof x.replayed==='boolean'&&x.read_only===(name!=='erp_fiscal_subset_review_save'));
 if(latest)need(x.lookup_profile==='subset-review-latest-v1'&&typeof x.matches_requested_profile==='boolean');
 if(name!=='erp_fiscal_subset_review_save')need(x.replayed===false);
 if(name!=='erp_fiscal_subset_review_command')need(x.candidate_id===args.p_candidate_id&&x.candidate_version===(args.p_candidate_version??args.p_expected_candidate_version)&&x.signed_hash===args.p_signed_hash&&x.facts_hash===args.p_facts_hash&&x.profile_hash===args.p_profile_hash);
 const c=fields(x.current,['latest_review_id','latest_review_version','is_latest','reviewer_active','within_validity']);need(int(c.latest_review_version,0)&&['is_latest','reviewer_active','within_validity'].every(k=>typeof c[k]==='boolean'));
 if(x.receipt===null){need((latest||name==='erp_fiscal_subset_review_get')&&(!latest||x.matches_requested_profile===false)&&x.record_text===null&&c.latest_review_id===null&&c.latest_review_version===0&&!c.is_latest&&!c.reviewer_active&&!c.within_validity);return freeze(x);}
 const r=fields(x.receipt,RECEIPT_KEYS),record=recordText(x.record_text);
 need(r.command_id===r.review_id&&id(r.review_id)&&id(r.reviewed_by)&&int(r.review_version)&&r.coverage===SUBSET_REVIEW_FLAGS.coverage&&matchesRuleProfile(r.profile,r.profile_hash));
 need(['candidate_id','candidate_version','signed_hash','facts_hash',...(latest?[]:['profile_hash'])].every(k=>r[k]===x[k]));if(latest)need(x.matches_requested_profile===(r.profile_hash===x.profile_hash));r.schema=schema(r.schema,r.signed_hash);
 const map={id:'review_id',version:'review_version',candidate_id:'candidate_id',signed_hash:'signed_hash',facts_hash:'facts_hash',profile:'profile',profile_hash:'profile_hash',reviewed_by:'reviewed_by',reviewed_at:'reviewed_at',valid_until:'valid_until',review_hash:'review_hash'};
 need(Object.entries(map).every(([k,v])=>record[k]===r[v]));need(id(c.latest_review_id)&&c.latest_review_version>=r.review_version&&c.is_latest===(c.latest_review_id===r.review_id)&&c.is_latest===(c.latest_review_version===r.review_version));
 if(latest||name==='erp_fiscal_subset_review_get')need(c.is_latest);
 else need(r.command_id===args.p_command_id&&r.reviewed_by===args.p_user_id);
 if(name==='erp_fiscal_subset_review_save')need(r.review_version===args.p_expected_review_version+1&&r.valid_until===args.p_valid_until&&canonical({document:record.document,items:record.items})===args.p_declaration_text&&canonical(r.schema)===canonical(args.p_schema));
 return freeze({...x,receipt:r,current:c});
}
