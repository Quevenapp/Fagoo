export type Group = Record<string, string | boolean>;
export type Tax = 'icms' | 'ipi' | 'pis' | 'cofins' | 'ii';
/** product_scope 'groups' with group_ids is "Grupo de Produtos" (202610200216). */
export interface NatureRule { tax: Tax; destinations: string[]; product_scope: 'any' | 'ncm' | 'products' | 'groups'; ncms: string[]; product_ids: string[]; group_ids?: string[]; data: Group; additional_info: string | null; fiscal_info: string | null; }
export interface NatureRuleRecord extends NatureRule { position: number; products: { id: string; name: string; code: string | null }[]; groups?: { id: string; name: string }[]; }
export interface NatureInput {
  description: string; series: string | null; direction: '0' | '1'; crt: '1' | '2' | '3' | '4'; presence: string; invoiced: boolean; final_consumer: boolean; return_operation: boolean;
  update_last_purchase_price: boolean; include_freight_ipi_base: boolean; others: Group; retentions: Group; additional_info: string | null; fiscal_info: string | null; rules: NatureRule[];
}
export interface NatureRecord extends Omit<NatureInput, 'series' | 'rules'> { id: string; series: number | null; active: boolean; version: number; created_at: string; updated_at: string; defaults: string[]; rules: NatureRuleRecord[]; }
export interface NatureSummary { id: string; description: string; series: number | null; direction: '0' | '1'; crt: string; presence: string; invoiced: boolean; final_consumer: boolean; return_operation: boolean; active: boolean; version: number; defaults: string[]; rule_count: number; }
export interface TaxSettingsValues { exclude_icms_pis_cofins: boolean; exclude_icms_st_pis_cofins: boolean; st_contributor_differentiated: boolean; st_retained_from_sale: boolean; difal_default: string; ipi_in_icms_import: boolean; }
export interface InvoiceItemInput { product_id?: string; description: string; quantity: string; unit_price: string; [key: string]: string | boolean | Group | undefined; }
export interface Transport { mode: 'none' | 'manual'; freight_by: string; tracking_code?: string; carrier: Group; vehicle: Group; volumes: Group; delivery: Group | null; }
export interface Installment { days?: string; date: string; amount: string; method?: string; note?: string; card: Group | null; }
export interface InvoiceInput {
  model: '55' | '65'; direction: '0' | '1'; issue_type: string; series: string; number: string | null; access_key: string | null; nature_id: string | null; nature_description: string | null;
  cfop: string | null; issue_date: string; exit_date: string | null; exit_time: string | null; crt: string; purpose: string; credit_debit_type: string | null; presence: string; final_consumer: boolean;
  recipient: Group; export: Group | null; import_declaration: (Group & { additions: Group[] }) | null; references: Group[]; items: InvoiceItemInput[]; auto_tax: boolean;
  freight: string; insurance: string; other_expenses: string; discount: string; transport: Transport; payment: { condition: string | null; indicator?: '0' | '1'; installments: Installment[] };
  authorized_xml: Group[]; intermediary: Group; additional_info: string | null; nature_additional_info: string | null; nature_fiscal_info: string | null;
  /** 202610200215: Vendedor of the note and Destino da Operação (idDest), optional for older databases and forms. */
  seller_id?: string | null; operation_destination?: '1' | '2' | '3' | null;
}
export interface InvoiceOrder { id: string; kind: 'sales_orders' | 'purchase_orders' | 'service_orders'; number: string; date: string | null; contact_name: string | null; }
export interface InvoiceRecordItem extends InvoiceItemInput { position: number; total: string; allocated: { freight: string; insurance: string; other_expenses: string; discount: string }; }
export interface InvoiceRecord extends Omit<InvoiceInput, 'series' | 'number' | 'items'> {
  id: string; version: number; status: number; environment: '2' | null; series: number; number: number | null; protocol: string | null; authorized_at: string | null; nature_description: string;
  items: InvoiceRecordItem[]; totals: Record<string, string>; orders: InvoiceOrder[]; created_at: string; updated_at: string; deleted_at: string | null; delete_reason: string | null;
  seller_name?: string | null;
}
export interface InvoiceTotals { lines: string[]; allocation: Record<'freight' | 'insurance' | 'other_expenses' | 'discount', string[]>; totals: Record<string, string>; }
export interface ListRow {
  /** Origin observation time, independently of document date. Native rows carry null. */
  observed_at?: string | null;
  origin: 'origin' | 'brufap'; id: string; version: number | null; number: number | null; series: number | null; issue_date: string | null; entry_date: string | null; name: string | null;
  document: string | null; state: string | null; nature: string | null; status: number | null; status_raw: string | null; total: string; total_known: boolean; environment: string | null;
  issue_type: string | null; access_key: string | null; xml_id: string | null; xml_hash: string | null; xml_size: number | null; protocol_present: boolean; event_count: number; orders: InvoiceOrder[];
  /** Espelho lane (202610210358): 7 Emitida DANFE is fiscal_status 6 with danfe_emitted (NFE-069). */
  fiscal_status: number | null; danfe_emitted: boolean;
  /** Origin and environment of the source (NFE-063/185), apart from the model and the emission environment. */
  source_origin: 'origin' | 'brufap_native' | 'third_party' | 'xml_import'; source_environment: '1' | '2' | null;
}
export interface FiscalMirrorCoverage {
  scope: 'model_direction'; source_count: number; visible_count: number; xml_count: number; missing_xml_count: number;
  homologation_count: number; duplicate_count: number; incomplete_count: number; oldest_observed_at: string | null; latest_observed_at: string | null; partial: boolean;
}
export interface ListPage { items: ListRow[]; origin: 'origin' | 'brufap'; model: '55' | '65'; direction: '0' | '1'; page: number; limit: number; order: string; has_more: boolean; total_count: number; total_amount: string; amount_unknown: number; brufap_visible: boolean; show_totals: boolean; data_mode: string; coverage?: FiscalMirrorCoverage | null; }
export interface OriginFile { id: string; hash: string; size: number; }
export interface OriginDetail {
  origin: 'origin'; entity: 'nfe' | 'nfce'; source_id: string; model: '55' | '65'; direction: '0' | '1' | null; number: number | null; series: number | null; issue_date: string | null; operation_date: string | null;
  status: number | null; status_raw: string | null; access_key: string | null; total: string; total_known: boolean; freight: string | null; contact: Record<string, string | null>;
  items: { code: string | null; description: string | null; unit: string | null; quantity: string | null; unit_price: string | null; total: string | null; cfop: string | null; ncm: string | null; gtin: string | null }[];
  installments: { date: string | null; amount: string | null; note: string | null }[]; transport: { freight_by: string | null; carrier: string | null }; additional_info: string | null;
  xml: (OriginFile & { environment: string | null; protocol: string | null }) | null; events: (OriginFile & { type: string | null; sequence: string | null })[]; observed_at: string; data_mode: string; writable: false;
}
export interface EventRecord { id: string; kind: 'cancel' | 'correction' | 'inutilization'; invoice_id: string | null; model: '55' | '65'; environment: '2'; series: number; number_from: number; number_to: number; sequence: number | null; text: string; state: 'pending'; protocol: null; requested_at: string; access_key: string | null; }
export const TOTAL_KEYS: readonly string[];
export interface InvoicePreferences {
  show_totals: boolean; sum_weight: boolean; compute_volume: boolean; ipi_first_installment: boolean; st_first_installment: boolean; tracking_in_info: boolean; purchase_order_in_info: boolean;
  simples_credit_message: boolean; optional_installments: boolean; fuel_group: boolean; weapon_group: boolean; vehicle_group: boolean; retention_group: boolean; autxml_carrier: boolean;
  block_edit_stock: boolean; block_edit_finance: boolean; freight_by: string; species: string; volume_quantity: number; markup: string; autxml_people: { document: string; name: string | null }[];
}
export const PREFERENCE_FLAGS: readonly string[];
export const DEFAULT_INVOICE_PREFERENCES: Readonly<InvoicePreferences>;
export function invoicePreferences(value: unknown): InvoicePreferences;
export function accessKeyValid(key: unknown): boolean;
export function normalizeRuleInput(rule: unknown, crt: string, direction: string): NatureRule;
export function normalizeNatureInput(value: unknown): NatureInput;
export function natureRecord(value: unknown): NatureRecord;
export function natureSummary(value: unknown): NatureSummary;
export function normalizeTaxSettings(settings: unknown, states: unknown): { settings: TaxSettingsValues; difal_by_state: Record<string, string> };
export function normalizeItemInput(item: unknown, crt: string, direction: string): InvoiceItemInput;
export function normalizeInvoiceInput(value: unknown): InvoiceInput;
/** The candidate of "Importar XML" (NF-e and, from wave F, NFC-e) checked like the importer of the database. */
export function normalizeImportedInput(value: unknown): InvoiceInput;
export function lineTotalCents(quantity: string, unitPrice: string): bigint;
export function allocateCents(amount: bigint, weights: bigint[]): bigint[];
export function discountShares(invoice: InvoiceInput, weights: bigint[]): bigint[];
export function invoiceTotals(invoice: InvoiceInput): InvoiceTotals;
export function invoiceRecord(value: unknown): InvoiceRecord;
export function listRow(value: unknown, origin: 'origin' | 'brufap'): ListRow;
export function listPage(value: unknown, args: { origin: string; model: string; direction: string; page: number; limit: number; order: string }): ListPage;
export function originDetail(value: unknown): OriginDetail;
export function eventRecord(value: unknown): EventRecord;
