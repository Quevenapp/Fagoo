export type OrderReason = 'cancelled' | 'no_items' | 'no_products' | 'has_invoice' | 'international' | 'quantity_precision' | 'stock_negative';
export const ORDER_REASONS: Readonly<Record<OrderReason, string>>;
export interface OrderSourceItem {
  position: number; product_id: string | null; description: string; code: string | null; unit: string; quantity: string; unit_price: string; gross: string; discount: string; total: string;
  product: OrderSourceProduct | null;
  /** 202610200254: the composition of the item when "Desmembrar produtos ... em uma estrutura na nota fiscal" is on (null otherwise). */
  composition: OrderComposition | null;
}
export interface OrderSourceProduct { kind: string | null; ncm: string | null; gtin: string | null; gtin_tax: string | null; cest: string | null; origin: string | null; gross_weight: string | null; net_weight: string | null; volumes: string | null }
export interface OrderComposition {
  stock_type: 'physical' | 'virtual'; problem: 'structure_missing' | 'component_unavailable' | null;
  components: { position: number; product_id: string; description: string; code: string | null; unit: string | null; quantity: string; price: string | null; product: OrderSourceProduct }[];
}
export interface OrderParcelForma { id: string; description: string; payment_type: string; card_brand: string | null; card_integration: '1' | '2' | null; card_cnpj: string | null; active: boolean }
export interface OrderParcelDetails { payment_type: string | null; card_brand: string | null; integration_type: '1' | '2' | null; acquirer_cnpj: string | null; authorization_code: string | null;
  received_amount: string | null; fee_amount: string | null; commission_fee_amount: string | null }
export interface OrderSource {
  document: { id: string; kind: 'sales_orders' | 'purchase_orders' | 'service_orders'; number: string; version: number; status: string; date: string | null; ship_date: string | null; customer_po_number: string | null;
    notes: string | null; warehouse_id: string | null; stock_active: boolean; finance_active: boolean };
  direction: '0' | '1'; model: '55' | '65'; eligible: boolean; reasons: { code: OrderReason; items: number[] }[];
  contact: { contact_id: string; name: string; code: string | null; active: boolean; trade_name: string | null; person_type: 'J' | 'F' | 'E' | null; document: string | null; ie: string | null; email: string | null;
    phone: string | null; mobile: string | null; postal_code: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null;
    state: string | null; taxpayer: '1' | '2' | '9' | null; country: string | null; nfe_email: string | null };
  nature: { id: string; description: string; crt: string } | null;
  items: OrderSourceItem[];
  totals: { gross: string; line_discount: string; discount: string; freight: string; other_expenses: string; total: string };
  installments: { position: number; due_date: string; amount: string; method: string | null; note: string | null; payment_method: OrderParcelForma | null; details: OrderParcelDetails | null }[];
  delivery: Record<'name' | 'postal_code' | 'state' | 'city' | 'district' | 'street' | 'number' | 'complement' | 'country', string | null> | null;
  transport: { freight_mode: string | null; volume_count: string | null; gross_weight: string | null; tracking_code: string | null; carrier_label: string | null } | null;
  existing_invoice: { id: string; model: '55' | '65'; number: number | null; status: number } | null;
  /** 202610200215: vendedor and transportador of the pedido; keep_order_dates is "Considerar a data da venda / da OS nas parcelas". */
  seller: { id: string; name: string } | null;
  carrier: { contact_id: string; name: string; active: boolean; person_type: 'J' | 'F' | 'E' | null; document: string | null; ie: string | null; postal_code: string | null; street: string | null;
    number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null } | null;
  keep_order_dates: boolean;
  /** 202610200254: Detalhes de pagamento of the pedido de venda: Método de pagamento (tPag) and Forma de pagamento (indPag). */
  payment: { means: string | null; indicator: '0' | '1' | null };
  writable: boolean; emission_enabled: false; production_enabled: false; data_mode: 'erp_native';
}
export function orderSourceRecord(value: unknown): OrderSource;
export interface ContactSource { contact: OrderSource['contact']; nature: { id: string; description: string; crt: string } | null; seller: { id: string; name: string } | null; writable: boolean; data_mode: 'erp_native' }
export function contactSourceRecord(value: unknown, contactId?: string): ContactSource;
export interface ItemHistory { items: { origin: 'brufap' | 'origin'; id: string; number: number | null; series: number | null; issue_date: string | null; issue_type: string | null; quantity: string | null; unit_price: string | null; total: string | null }[];
  contact_id: string; product_id: string; direction: '0' | '1'; data_mode: 'erp_native' }
export function itemHistoryRecord(value: unknown, args: { contactId: string; productId: string; direction: '0' | '1' }): ItemHistory;
export interface PaymentMethodOption { id: string; description: string; payment_type: string; card_brand: string | null; card_integration: '1' | '2' | null; card_cnpj: string | null }
export function paymentMethodsRecord(value: unknown, direction: '0' | '1'): { direction: '0' | '1'; items: PaymentMethodOption[]; data_mode: 'erp_native' };
export interface KeyLookupItem { origin: 'brufap' | 'origin'; id: string; model: '55' | '65'; direction: '0' | '1' | null; number: number | null; series: number | null; issue_date: string | null; name: string | null; total: string | null }
export function keyLookupRecord(value: unknown, key: string): { key: string; items: KeyLookupItem[]; data_mode: 'erp_native' };
export interface Returned { key: string; returns: { id: string; model: '55' | '65'; direction: '0' | '1'; number: number | null; series: number; issue_date: string; status: number }[];
  items: { product_id: string | null; code: string | null; description: string | null; quantity: string }[]; data_mode: 'erp_native' }
export function returnedRecord(value: unknown, key: string): Returned;
export interface EstimateRequest { kind: 'sales_orders' | 'sales_proposals'; contact_id: string | null; items: { product_id: string | null; quantity: string; unit_price: string }[]; discount: string; freight: string; other_expenses: string; }
export interface EstimateResult {
  enabled: boolean; available: boolean; reason: 'no_items' | 'no_nature' | 'regime' | 'quantity_precision' | 'invalid' | null; nature: { id: string; description: string } | null;
  items: { product_id: string | null; ipi: string; st: string }[]; totals: { ipi: string; st: string; total: string | null }; data_mode: 'erp_native';
}
export function estimateRequest(body: unknown): EstimateRequest;
export const ESTIMATE_MAX_ITEMS: number;
export function estimateSearch(request: EstimateRequest): URLSearchParams;
export function estimateFromQuery(get: (key: string) => string | null): EstimateRequest;
export function estimateTaxes(context: unknown, request: EstimateRequest, today: string): EstimateResult;
export function estimateResult(value: unknown): EstimateResult;
