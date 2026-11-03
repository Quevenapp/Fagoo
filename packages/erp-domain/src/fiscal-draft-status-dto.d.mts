export type FiscalDraftStatusVisibility = 'none' | 'available' | 'restricted' | 'inconsistent' | 'unsupported';
export type FiscalAuthorizationState = 'prepared' | 'request_ready' | 'dispatched' | 'submission_uncertain' | 'failed_before_dispatch' | 'receipt_pending' | 'rejected' | 'review_required' | 'authorization_observed' | 'authorized_homologation';
export interface FiscalDraftStatusQuery { model: '55' | '65' | null; status: 'draft' | 'archived' | null; sourceDocumentId: string | null; limit: number; after: string | null; }
export interface FiscalDraftStatusSummary {
  id: string; model: '55' | '65'; environment: '2'; status: 'draft' | 'archived'; version: number;
  source_document_id: string; source_document_version: number; created_at: string; updated_at: string;
  order_number: string; contact_name: string; total: string;
}
export interface FiscalDraftNumberingSummary { reservation_id: string; series: number; number: number; draft_version: number; reserved_at: string; }
export interface FiscalRecordedResult {
  response_hash: string; response_size: number; processed_hash: string | null; processed_size: number | null;
  cstat: string | null; protocol_cstat: string | null; protocol_number: string | null; received_at: string | null;
  rejection_code: 'SOAP_FAULT' | 'SOAP_INVALID' | 'XML_INVALID' | 'XSD_INVALID' | 'CONTEXT_MISMATCH' | 'DIGEST_MISMATCH' | 'PROCESSED_INVALID' | null;
  recorded_at: string;
}
export interface FiscalHistoricalRuleReview { review_id: string; review_version: number; profile: string; profile_hash: string; review_hash: string; }
export interface FiscalOriginalAuthorizationSummary {
  command_id: string; attempt_id: string; candidate_id: string; candidate_version: number; signed_hash: string;
  origin: 'operational' | 'synthetic'; authorization_profile: 'legacy_v1' | 'reviewed_subset_v1'; policy_version: number;
  state: FiscalAuthorizationState; created_at: string; used_at: string | null; finished_at: string | null;
  error_code: 'PREPARATION_FAILED' | 'REQUEST_INVALID' | 'TRANSPORT_UNCONFIRMED' | 'JOURNAL_UNAVAILABLE' | 'VALIDATOR_UNAVAILABLE' | null;
  rule_review: FiscalHistoricalRuleReview | null; result: FiscalRecordedResult | null;
}
export interface FiscalRevalidationSummary extends FiscalRecordedResult {
  command_id: string; parser_profile: 'authorization-stored-response-utf8-v1'; parser_manifest_hash: string; source_hash: string;
  state: 'authorized_homologation' | 'receipt_pending' | 'rejected' | 'review_required';
}
export type FiscalDraftBasisDifference = 'DRAFT_CHANGED' | 'ITEM_PREPARATION_CHANGED' | 'TAX_PREPARATION_CHANGED' | 'COMPLETION_CHANGED' | 'COMPANY_CHANGED' | 'SOURCE_CHANGED' | 'SOURCE_CANCELLED' | 'DRAFT_ARCHIVED' | 'NEWER_XML_JOB' | 'NEWER_SIGNED_CANDIDATE';
export interface FiscalDraftAuthorizationBasis {
  draft_version: number; source_document_version: number; item_preparation_version: number; tax_preparation_version: number;
  completion_version: number; company_identity_version: number; company_fiscal_version: number;
  is_latest_job: boolean; is_latest_candidate: boolean; matches_current_preparation: boolean; differences: FiscalDraftBasisDifference[];
}
export interface FiscalDraftStatusRow {
  draft: FiscalDraftStatusSummary;
  numbering: { visibility: Exclude<FiscalDraftStatusVisibility, 'unsupported'>; reservation: FiscalDraftNumberingSummary | null };
  authorization: {
    visibility: FiscalDraftStatusVisibility; selection: 'consumed' | 'active' | null;
    original: FiscalOriginalAuthorizationSummary | null;
    revalidation: { visibility: FiscalDraftStatusVisibility; result: FiscalRevalidationSummary | null };
    basis: FiscalDraftAuthorizationBasis | null;
  };
}
/** can_emit/transmit describe this read-only endpoint, never the candidate's global availability. */
export interface FiscalDraftStatusPage {
  profile: 'fiscal-draft-status-v1'; read_only: true; observed_at: string;
  can_emit: false; can_transmit: false; operational_effects: false;
  items: FiscalDraftStatusRow[]; limit: number; has_more: boolean; next_cursor: string | null;
}
export const FISCAL_DRAFT_STATUS_MAX_BYTES: 262144;
export class FiscalDraftStatusError extends Error { constructor(status: number, code: string); status: number; code: string; }
export function parseFiscalDraftStatusPage(raw: unknown, query?: Partial<FiscalDraftStatusQuery>): FiscalDraftStatusPage;
