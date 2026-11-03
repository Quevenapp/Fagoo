export type DocumentKind = 'sales_proposals' | 'sales_orders' | 'purchase_orders' | 'service_orders';
import type { RichText } from './rich-text.mjs';
export type { RichText };
/** 202610200270 "Outros itens ou serviços" of the proposta: texto rico and "Total outros itens". */
export interface OtherItems { content: RichText | null; total: string }
/** 202610200270 "Condições comerciais" of the proposta: Nenhum | Parcela | Texto. */
export interface CommercialConditions { mode: 'none' | 'installments' | 'text'; text: RichText | null }
export const COMMERCIAL_CONDITION_MODES: readonly CommercialConditions['mode'][];
export interface CommercialReference { system: 'origin'; source_id: string; label: string | null; }
export interface CommercialTransport { freight_mode: '0'|'1'|'2'|'3'|'4'|'9'|null; volume_count: string|null; gross_weight: string|null; delivery_days: string|null; carrier_reference: CommercialReference|null; service_reference: CommercialReference|null; tracking_code: string|null; }
export interface CommercialData { introduction: string|null; attention_to: string|null; seller_reference: CommercialReference|null; store_reference: CommercialReference|null; business_unit_reference: CommercialReference|null; transport: CommercialTransport|null; }
export interface DocumentItemInput { id?: string | null; product_id?: string | null; description: string; code?: string | null; unit: string; quantity: string; unit_price: string; discount_percent?: string; detailed_description?: string|null;
  /** 202610200196: Preço lista (reference unit price of the Lista de preço or of the product), read-only in the editor. */
  list_price?: string|null;
  /** 202610200196: Código no fornecedor (pedidos de compra only). */
  supplier_code?: string|null;
  /** 202610200268, OS only: Peças ('part') or Serviços executados ('service'); Orçar and OK of a serviço. */
  group?: ServiceItemGroup; quote?: boolean; done?: boolean;
  /** 202610200287 Informar lotes (pedidos de venda and peças of the OS): the lots of the product adding up to the quantity. */
  lots?: ItemLot[]|null;
  /** 202610200287, OS only: Garantia (dias) of the item. */
  warranty_days?: string|null;
  /** 202610200287, pedidos de compra only: IPI % of the item. */
  ipi_rate?: string|null; }
export interface ItemLot { lot_id: string; quantity: string }
export type ServiceItemGroup = 'part' | 'service';
/** "Detalhes da parcela" (202610200196): every key is sent, null when not informed. */
export interface InstallmentDetails { account_id: string|null; payment_type: string|null; card_brand: string|null; integration_type: '1'|'2'|null; acquirer_cnpj: string|null;
  authorization_code: string|null; received_amount: string|null; fee_amount: string|null; commission_fee_amount: string|null; }
export interface InstallmentInput { due_date: string; amount: string; method?: string | null; note?: string|null; payment_reference?: CommercialReference|null;
  /** 202610200196: Forma (Cadastros › Formas de pagamento) and the "Detalhes da parcela" (not in propostas). */
  payment_method_id?: string|null; details?: InstallmentDetails|null; }
export interface DocumentInput {
  date: string; contact_id: string; warehouse_id?: string | null; expected_date?: string | null; valid_until?: string | null; next_contact?: string | null;
  template?: boolean; items: DocumentItemInput[]; discount_mode?: 'amount' | 'percent'; discount_value?: string; freight?: string; other_expenses?: string;
  installments?: InstallmentInput[]; notes?: string | null; internal_notes?: string | null; payment_terms?: string | null; delivery_terms?: string | null;
  equipment?: string | null; serial_number?: string | null; technician?: string | null; defect?: string | null; solution?: string | null;
  commercial?: CommercialData|null;
  ship_date?: string|null; finish_date?: string|null; start_time?: string|null; end_time?: string|null; customer_po_number?: string|null;
  quote_requested?: boolean|null; quoted?: boolean|null; warranty_days?: string|null; warranty_months?: string|null; warranty_info?: string|null;
  reception_notes?: string|null; template_name?: string|null; delivery_address?: DeliveryAddress|null; order_reference?: string|null;
  /** Native vendedor (Cadastros › Vendedores, 202610200164): id of erp_catalog.seller; pedidos, propostas and OS only. */
  seller_id?: string|null;
  /** Categoria financeira (202610200168): receita in vendas and OS, despesa in compras; never in propostas. */
  category_id?: string|null;
  /** Transportador (202610200168): a contact of Clientes e fornecedores. */
  carrier_id?: string|null;
  /** Lista de preço (202610200196): pedidos de venda and propostas. */
  price_list_id?: string|null;
  /** Destino (202610200196): conta financeira of the contas; null = Contas a receber/pagar. Not in propostas. */
  payment_account_id?: string|null;
  /** Detalhes de pagamento of the pedido de venda (202610200196): tPag and indPag of the NF-e; null = padrão da empresa. */
  payment_means?: string|null; payment_indicator?: '0'|'1'|null;
  /** 202610200270, propostas only: Outros itens ou serviços and Condições comerciais. */
  other_items?: OtherItems|null; commercial_conditions?: CommercialConditions|null;
  /** Total do IPI and Total do ICMS ST added to the total (202610200196, pedidos de venda and propostas). */
  tax_ipi?: string; tax_icms_st?: string;
  /** 202610200287, OS only: Campos customizados {id of the field: canonical value}. */
  custom_fields?: Record<string,string>|null;
  /** Editar número (202610200129): requested number, sent only when it changes; never stored in the body. */
  number?: string;
  /** "Editar contato" (202610200168): the save takes the current data of the contact; sent only when true, never stored. */
  refresh_contact?: true;
}
export interface DeliveryAddress { name: string|null; postal_code: string|null; state: string|null; city: string|null; district: string|null; street: string|null; number: string|null; complement: string|null; country: string|null; }
export interface LineTotals { gross: string; discount: string; total: string; }
export interface DocumentTotals { items: LineTotals[]; gross: string; line_discount: string; subtotal: string; discount: string; freight: string; other_expenses: string; ipi?: string; icms_st?: string; other_items?: string; total: string; }
export interface NormalizedItem extends Required<Omit<DocumentItemInput,'detailed_description'|'list_price'|'supplier_code'|'group'|'quote'|'done'|'lots'|'warranty_days'|'ipi_rate'>>, LineTotals { position: number; detailed_description?: string|null; list_price?: string|null; supplier_code?: string|null;
  group?: ServiceItemGroup; quote?: boolean; done?: boolean; lots?: ItemLot[]; warranty_days?: string; ipi_rate?: string; }
export type ExtensionField = 'ship_date'|'finish_date'|'start_time'|'end_time'|'customer_po_number'|'quote_requested'|'quoted'|'warranty_days'|'warranty_months'|'warranty_info'|'reception_notes'|'template_name'|'delivery_address'|'order_reference'|'seller_id'|'category_id'|'carrier_id'|'price_list_id'|'payment_account_id'|'payment_means'|'payment_indicator'|'other_items'|'commercial_conditions';
export interface NormalizedDocument extends Omit<Required<DocumentInput>, 'items' | 'installments' | 'commercial' | 'number' | 'refresh_contact' | 'tax_ipi' | 'tax_icms_st' | 'custom_fields' | ExtensionField>, Pick<DocumentInput, ExtensionField | 'tax_ipi' | 'tax_icms_st' | 'custom_fields'> {
  items: NormalizedItem[]; installments: (Required<Omit<InstallmentInput,'note'|'payment_reference'|'payment_method_id'|'details'>> & Pick<InstallmentInput,'note'|'payment_reference'|'payment_method_id'|'details'> & {position:number})[]; totals: DocumentTotals; commercial?: CommercialData|null;
}
export class DocumentError extends Error { code: string; constructor(code:string); }
export const KINDS: readonly DocumentKind[];
export const STATES: Readonly<Record<DocumentKind, Readonly<Record<string,string>>>>;
export const INITIAL_STATE: Readonly<Record<DocumentKind,string>>;
export const TRANSITIONS: Readonly<Record<DocumentKind, Readonly<Record<string,readonly string[]>>>>;
export const LEGACY_TRANSITIONS: Readonly<Record<DocumentKind, Readonly<Record<string,readonly string[]>>>>;
export function transitionReasonRequired(kind:DocumentKind,from:string,to:string):boolean;
export function canEdit(kind:DocumentKind,state:string):boolean;
export function checkTransition(kind:DocumentKind,from:string,to:string,reason?:string|null):true;
export function decimal(value:string,precision:number,integerDigits:number):bigint;
export function format(value:bigint,precision:number):string;
export function calculateDocument(input:Pick<DocumentInput,'items'|'discount_mode'|'discount_value'|'freight'|'other_expenses'|'tax_ipi'|'tax_icms_st'>):DocumentTotals;
export function normalizeDocument(kind:DocumentKind,input:DocumentInput):NormalizedDocument;
export function documentNumber(value:unknown):value is string;
export function normalizeCommercial(value:unknown):CommercialData|null;
export function normalizeCommercialReference(value:unknown):CommercialReference|null;
export const EXTENSION_FIELDS: readonly ExtensionField[];
export const PAYMENT_TYPES: readonly string[];
export const CARD_BRANDS: readonly string[];
export const INSTALLMENT_DETAIL_FIELDS: readonly (keyof InstallmentDetails)[];
export function normalizeInstallmentDetails(kind:DocumentKind,value:unknown):InstallmentDetails|null;
export const DELIVERY_ADDRESS_FIELDS: readonly (keyof DeliveryAddress)[];
export function normalizeDeliveryAddress(value:unknown):DeliveryAddress|null;
export function itemIpiCents(totalCents:bigint,ipiRate:string):bigint;
export function itemIpi(total:string,ipiRate:string):string;
export const ITEM_LOTS_MAX: number;
export function normalizeItemLots(kind:DocumentKind,item:DocumentItemInput,quantity:bigint,group?:ServiceItemGroup):ItemLot[]|undefined;
export const CUSTOM_FIELDS_MAX: number;
export function normalizeCustomFields(kind:DocumentKind,value:unknown):Record<string,string>|undefined;
