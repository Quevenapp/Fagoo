import type { InvoiceInput, NatureRecord, NatureRule, TaxSettingsValues } from '../../erp-domain/src/fiscal-invoice-contract.mjs';
/** sellerName (202610200215) fills NOME_VENDEDOR of the informações complementares. */
export interface TaxEngineOptions { companyState?: string | null; simplesCreditMessage?: boolean; trackingInInfo?: boolean; purchaseOrderInInfo?: boolean; sellerName?: string | null }
export function matchRule<T extends NatureRule & { position: number }>(rules: readonly T[] | undefined, tax: string, target: { state: string | null; productId: string | null; ncm: string | null; groupId?: string | null }): T | null;
export function calculateInvoiceTaxes(invoice: InvoiceInput, context?: { natures?: Record<string, NatureRecord>; settings?: Partial<TaxSettingsValues>; difalByState?: Record<string, string>; orders?: readonly { number: string }[]; options?: TaxEngineOptions; productGroups?: Record<string, string | null> }): { invoice: InvoiceInput; rules_applied: number };
export function infoVariables(invoice: InvoiceInput, orders?: readonly { number: string }[], extra?: { sellerName?: string | null }): Record<string, string>;
export function fillVariables(text: string | null, values: Record<string, string>): string | null;
export function SIMPLES_CREDIT_MESSAGE(value: string, rate: string): string;
