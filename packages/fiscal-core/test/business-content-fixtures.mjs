import {businessFixture} from './business-fixtures.mjs';
import {COMPLETION_FLAGS,resolveBusinessCompletion} from '../src/business-completion.mjs';

// Synthetic placeholders for server-provided PostgreSQL record::text digests.
// The SQL interop test obtains real hashes from the same transaction as its records.
export function businessContentFixture(options={}){
 const legacy=businessFixture(options),{identity,...completion}=legacy.completion;
 const item_basis=legacy.taxPreparation.record.items.map(v=>({item_id:v.item_id,position:v.position,cest:v.identifiers.cest,csosn:v.decisions.icms?.csosn??null}));
 const basisHashes={draft_record_hash:'b'.repeat(64),item_record_hash:'c'.repeat(64),tax_record_hash:'d'.repeat(64),completion_record_hash:'e'.repeat(64)};
 const d=legacy.draft.record,company=d.snapshot.company;
 const record={draft_id:d.id,version:1,draft_version:d.version,snapshot_hash:d.snapshot_hash,item_preparation_version:legacy.itemPreparation.record.version,tax_preparation_version:legacy.taxPreparation.record.version,
  item_preparation_hash:basisHashes.item_record_hash,tax_preparation_hash:basisHashes.tax_record_hash,model:d.model,environment:'2',company_identity_version:company.identity_version,company_fiscal_version:company.fiscal_version,
  source_document_id:d.source_document_id,source_document_version:d.source_document_version,created_at:'2026-10-16T12:00:00.123456Z',item_basis,...resolveBusinessCompletion(completion,{model:d.model,items:item_basis})};
 const current={completion_version:1,draft_version:d.version,draft_status:d.status,source_document_version:d.source_document_version,source_status:d.snapshot.status,source_changed:false,company_changed:false,
  identity_version:company.identity_version,fiscal_version:company.fiscal_version,item_preparation_version:legacy.itemPreparation.record.version,tax_preparation_version:legacy.taxPreparation.record.version,
  matches_current_draft:true,matches_current_item_preparation:true,matches_current_tax_preparation:true,matches_current_company:true};
 return{legacy,input:{draft:legacy.draft,itemPreparation:legacy.itemPreparation,taxPreparation:legacy.taxPreparation,completionPreparation:{...COMPLETION_FLAGS,record,current},basisHashes}};
}
export function refreshCompletionProof(input){
 const r=input.completionPreparation.record;r.pending=resolveBusinessCompletion(r.completion,{model:r.model,items:r.item_basis}).pending;
}
