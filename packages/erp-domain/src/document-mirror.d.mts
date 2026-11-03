import type { DocumentKind } from './index.mjs';
export class DocumentMirrorError extends Error {}
export interface DocumentMirrorMeta {
  entity: DocumentKind; source_id: string; source_version: string; source_hash: string; mapper_version: number;
  source_number: string | null; source_status: string | null; source_status_label: string | null;
  observed_at: string; source_updated_at: string | null; source_deleted: boolean; state: 'synced' | 'pending'; partial: boolean; issues: string[];
  reconciliation: { source_total: string | null; source_products_total: string | null; calculated_total: string | null; difference: string | null; state: 'matches' | 'differs' | 'unknown' };
  effects: { stock: 'unobservable'; finance_count: number | null; invoice_source_id: string | null };
}
export interface DocumentMirrorBase {
  id: string; kind: DocumentKind; version: number; number: string | null; status: string; origin: 'origin'; authority: 'origin'; readonly: true;
  mirror: DocumentMirrorMeta; created_at: string; updated_at: string; date: string | null; total: string | null; contact_id: string | null;
}
export interface DocumentMirrorSummary extends DocumentMirrorBase {
  contact_name: string | null; expected_date?: string | null; next_contact?: string | null; ship_date?: string | null;
  warehouse_id?: string | null; seller_id?: string | null; source_proposal_id?: string | null;
  warehouse_name?: string | null; seller_name?: string | null; source_proposal_number?: string | null; internal_notes?: string | null;
  customer_po_number?: string | null; contact_email?: string | null; contact_phone?: string | null; contact_document?: string | null; address?: string | null;
  carrier_name?: string | null; template_name?: string | null; service_order_number?: string | null; version_label?: string | null;
  template?: false; finance_active?: false; stock_active?: false; receipt_active?: false; first_sale?: false; pendencies?: false; invoice_linked?: false;
  reservation_active?: false | null; fiscal_draft?: false | null; invoice?: null; situation?: null;
}
export interface DocumentMirrorItem {
  id: string; position: number; source_id: string | null; product_id: string | null; description: string | null; code: string | null; unit: string | null;
  quantity: string | null; unit_price: string | null; discount_percent: string | null; total: string | null; group?: 'part' | 'service' | null;
  hours?: string | null; source_path?: string | null;
}
export interface DocumentMirrorRecord extends DocumentMirrorBase {
  items: DocumentMirrorItem[]; contact_snapshot: Record<'name' | 'document' | 'email' | 'phone' | 'mobile' | 'street' | 'number' | 'complement' | 'district' | 'city' | 'state' | 'postal_code', string | null> | null;
  expected_date?: string | null; next_contact?: string | null; ship_date?: string | null; notes?: string | null; internal_notes?: string | null;
  equipment?: string | null; serial_number?: string | null; technician?: string | null; defect?: string | null; solution?: string | null;
  payment_terms?: string | null; delivery_terms?: string | null;
}
export type DocumentOriginTotals = Record<'brufap' | 'origin', { count: number; known_total_count: number; total: string | null }>;
export interface NativeDocumentCoverage { origin?: 'brufap'; mirror_excluded_count?: number; coverage?: { partial: boolean; reason: 'native_effects_only' } }
export function documentNativeCoverage(value: unknown): NativeDocumentCoverage;
export function documentMirrorMeta(value: unknown, kind: DocumentKind): DocumentMirrorMeta;
export function documentMirrorSummary(value: unknown, kind: DocumentKind): DocumentMirrorSummary;
export function documentMirrorRecord(value: unknown, kind: DocumentKind): DocumentMirrorRecord;
export function documentOriginTotals(value: unknown): DocumentOriginTotals;
