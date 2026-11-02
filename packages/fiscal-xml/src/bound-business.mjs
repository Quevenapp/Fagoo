/** Pure local binding of attested content to an internal 048 receipt. No I/O or execution authorization. */
import { assertResolvedBusinessContent, resolveBusinessIdentity } from '../../fiscal-core/src/business-document.mjs';
import { validFiscalTimestamp } from '../../fiscal-core/src/identity.mjs';
import { sha256, need } from './common.mjs';
import { serializeBusinessDocument } from './business-serializer.mjs';

const boundDocuments = new WeakSet();
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const equal=(a,b)=>a===b||plain(a)&&plain(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
const freezeTree=value=>{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value;};
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  &&validFiscalTimestamp(v.replace(/\.\d{1,6}(?=Z|[+-]\d{2}:\d{2}$)/,''));
const receiptKeys=['job_id','reservation_id','version','draft_id','completion_version','completion_hash','basis_hash','builder_version','proofs','identity','access_key','created_at'];

/** receipt must originate from the authorized server RPC. Its hashes and local brand do not authenticate that origin. */
export function bindResolvedBusinessContent(input) {
  need(exact(input,['content','receipt']),'BUSINESS_BINDING_INPUT_INVALID');
  const {content,receipt}=input;assertResolvedBusinessContent(content);
  need(exact(receipt,receiptKeys)&&id(receipt.job_id)&&id(receipt.reservation_id)&&version(receipt.version)&&stamp(receipt.created_at),'BUSINESS_JOB_RECEIPT_INVALID');
  const b=content.binding,hashes=Object.fromEntries(['draft_record_hash','item_record_hash','tax_record_hash','completion_record_hash'].map(k=>[k,b[k]]));
  const expectedProofs={draft_id:b.draft_id,draft_version:b.draft_version,snapshot_hash:b.snapshot_hash,
    item_preparation_version:b.item_preparation_version,tax_preparation_version:b.tax_preparation_version,
    item_preparation_hash:b.item_record_hash,tax_preparation_hash:b.tax_record_hash,model:content.model,environment:'2',
    company_identity_version:b.company_identity_version,company_fiscal_version:b.company_fiscal_version,
    source_document_id:b.source_document_id,source_document_version:b.source_document_version,
    completion_version:b.completion_version,completion_hash:b.completion_record_hash,builder_version:content.builder,basis_hashes:hashes};
  need(receipt.draft_id===b.draft_id&&receipt.completion_version===b.completion_version&&receipt.completion_hash===b.completion_record_hash
    &&receipt.builder_version===content.builder&&receipt.basis_hash===sha256(content.basis_fingerprint_text)
    &&equal(receipt.proofs,expectedProofs),'BUSINESS_JOB_BASIS_CONFLICT');
  const identity=resolveBusinessIdentity(receipt.identity,{cnpj:content.issuer.cnpj,model:content.model});
  need(typeof receipt.access_key==='string'&&receipt.access_key===identity.access_key,'BUSINESS_JOB_KEY_CONFLICT');
  const result=freezeTree({...content,...identity,identity_assigned:true,numbering_bound:true,
    pending:content.pending.filter(code=>code!=='NUMBERING_NOT_RESERVED'),
    job:{id:receipt.job_id,reservation_id:receipt.reservation_id,version:receipt.version,basis_hash:receipt.basis_hash,created_at:receipt.created_at}});
  boundDocuments.add(result);return result;
}

/** Only a local binder result may reach this entry point. JSON/cloned values must be resolved and bound anew. */
export function buildBoundBusinessXml(bound) {
  need(boundDocuments.has(bound),'BUSINESS_BOUND_DOCUMENT_UNATTESTED');
  const result=serializeBusinessDocument(bound);
  return freezeTree({...result,builder:bound.builder,job:bound.job,identity_assigned:true,numbering_bound:true,arithmetic_verified:true,
    basis_fingerprint_profile:bound.basis_fingerprint_profile,basis_fingerprint_text:bound.basis_fingerprint_text});
}
