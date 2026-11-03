import type {AuthorizationRequest,Model} from './index.mjs';
import type {RuleTimePolicy} from './sp-crt1-rule-manifest.mjs';
export {SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH} from './sp-crt1-rule-manifest.mjs';
export const MAX_RULE_REVIEW_BYTES:131072;
export type RuleInactiveFlags=Readonly<{taxRulesValidated:false;canEmit:false;canTransmit:false;sefazAuthorized:false;operationallyApproved:false}>;
export const RULE_PROFILE_FLAGS:RuleInactiveFlags;
export class SpCrt1RuleError extends Error {readonly code:string;constructor(code:string);}
declare const candidateBrand:unique symbol,reviewBrand:unique symbol,reportBrand:unique symbol;
export type SpCrt1Candidate=Readonly<{
 [candidateBrand]:true;profile:string;profileHash:string;candidateId:string;signedHash:string;factsHash:string;model:Model;itemCount:number;
}>;
export type SpCrt1ReviewEvidence=Readonly<{
 [reviewBrand]:true;id:string;version:number;reviewHash:string;candidateId:string;signedHash:string;profileHash:string;reviewedAt:string;validUntil:string;
}>;
export type SpCrt1ReviewQuery=Readonly<{
 candidateId:string;signedHash:string;factsHash:string;profile:string;profileHash:string;
 items:readonly Readonly<{position:number;itemHash:string}>[];
}>;
/** Private, authenticated backend port. It must bound response decoding, perform RBAC,
 * and return a persisted/versioned review. Hash and local brands are not authentication. */
export type SpCrt1ReadReview=(query:SpCrt1ReviewQuery,options:Readonly<{signal:AbortSignal;deadline:number;maxBytes:131072}>)=>Promise<Uint8Array|null>;
export type SpCrt1CreditReview=Readonly<{
 eligibility:'reviewed_lc123_art23';base:string;rate:string;amount:string;period:string;source_hash:string;statement:string;
}>;
/** Wire contract of the private read port; never accepted directly by evaluateSpCrt1Rules. */
export type SpCrt1ReviewRecord=Readonly<{
 id:string;version:number;candidate_id:string;signed_hash:string;facts_hash:string;profile:string;profile_hash:string;
 reviewed_by:string;reviewed_at:string;valid_until:string;review_hash:string;
 document:Readonly<{
  operation:'internal_normal_sale'|'outside_scope'|'unreviewed';
  recipient_regime:'regular_icms'|'simples'|'noncontributor'|'unreviewed';
  acquisition_purpose:'resale'|'industrialization'|'final_consumption'|'unreviewed';
  payment:'matches_signed_document'|'unreviewed';excluded_groups:'not_applicable'|'applies'|'unreviewed';
 }>;
 items:readonly Readonly<{
  position:number;item_hash:string;classification:'reviewed_physical_goods'|'outside_scope'|'unreviewed';
  benefit:'not_applicable'|'applies'|'unreviewed';pis_cofins:'normal_unified_simples'|'other'|'unreviewed';
  gtin:'reviewed_absent'|'reviewed_identifiers'|'unreviewed';
  st:'documented_prior_retention'|'not_applicable'|'unreviewed';fcp:'documented_prior_retention'|'not_applicable'|'unreviewed';
  credit:SpCrt1CreditReview|null;
 }>[];
}>;
export type SpCrt1RuleIssue=Readonly<{
 code:string;kind:'deterministic_rule'|'brufap_supported_scope'|'brufap_temporal_policy'|'classification_or_evidence_pending';position:number|null;sources:readonly string[];
}>;
export type SpCrt1RuleReport=RuleInactiveFlags&Readonly<{
 [reportBrand]:true;profile:string;profileHash:string;candidateId:string;signedHash:string;factsHash:string;evaluatedAt:string;
 review:Readonly<{id:string;version:number;hash:string}>|null;
 status:'invalid_combinations'|'unsupported_scope'|'pending_classification'|'reviewed_subset';
 invalidCombinations:readonly SpCrt1RuleIssue[];unsupportedScope:readonly SpCrt1RuleIssue[];pendingClassification:readonly SpCrt1RuleIssue[];
 temporalPolicy:RuleTimePolicy;coverage:'listed_rules_only_not_full_tax_validation';
}>;
export function inspectSpCrt1Candidate(input:{candidateId:string;request:AuthorizationRequest}):SpCrt1Candidate;
export type SpCrt1CandidateFacts=Readonly<{
 model:Model;environment:'2';crt:string;issuerUf:string;ide:Readonly<Record<string,string>>;
 recipient:Readonly<{indIEDest:string;ie:string|null;uf:string}>;
 items:readonly Readonly<{position:number;itemHash:string;code:string;ncm:string;cest:string|null;benefit:string|null;cfop:string;gtin:string;gtinTax:string;icms:Readonly<Record<string,string>>;pis:Readonly<Record<string,string>>|null;cofins:Readonly<Record<string,string>>|null;unsupported:readonly string[]}>[];
 payments:readonly Readonly<Record<string,string>>[];change:string|null;totals:Readonly<Record<string,string>>;transportMode:string;additionalInformation:string|null;unsupported:readonly string[];
}>;
export type SpCrt1ReviewProjection=Readonly<{facts:SpCrt1CandidateFacts;labels:Readonly<{items:readonly Readonly<{position:number;description:string;unit:string|null;quantity:string|null;unit_price:string|null;product_total:string|null}>[]}>}>;
/** Fresh closed frozen copy; rejects clones/proxies without invoking their accessors. */
export function projectSpCrt1CandidateReview(candidate:SpCrt1Candidate):SpCrt1ReviewProjection;
export function createSpCrt1ReviewReader(configuration:{readReview:SpCrt1ReadReview}):(input:{candidate:SpCrt1Candidate;now:Date;signal?:AbortSignal;deadline?:number})=>Promise<SpCrt1ReviewEvidence|null>;
export function evaluateSpCrt1Rules(input:{candidate:SpCrt1Candidate;reviewEvidence:SpCrt1ReviewEvidence|null;now:Date}):SpCrt1RuleReport;
export function assertSpCrt1RuleReport(value:unknown,candidate:SpCrt1Candidate):SpCrt1RuleReport;
