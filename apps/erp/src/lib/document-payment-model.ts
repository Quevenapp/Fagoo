// Pagamento dos documentos no padrão do Origin (202610200196): Destino, Detalhes de pagamento, Forma de cada parcela e
// "Detalhes da parcela". Formas e contas vêm de GET /v1/documentos/{tipo}/pagamento (somente leitura).
import { PAYMENT_TYPES as TYPE_CODES, CARD_BRANDS as BRAND_CODES, INSTALLMENT_DETAIL_FIELDS } from '../../../../packages/erp-domain/src/index.mjs';
import type { DocumentKind, InstallmentInput } from './real-documents-model.ts';
import { PAYMENT_TYPES, CARD_BRANDS, CARD_INTEGRATIONS } from './payment-method-model.ts';

export interface PaymentMethodOption { id: string; description: string; payment_type: string; condition: string | null; destination: 'contas' | 'ficha' | 'caixa'; account_id: string | null;
  card_brand: string | null; card_integration: '1' | '2' | null; card_cnpj: string | null; is_default: boolean; }
export interface PaymentAccountOption { id: string; name: string; kind: 'bank' | 'cash' | 'other'; }
export interface PaymentOptions { kind: DocumentKind; methods: PaymentMethodOption[]; accounts: PaymentAccountOption[]; }
export type InstallmentDetails = NonNullable<InstallmentInput['details']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (): never => { throw new Error('PAYMENT_OPTIONS_INVALID'); };
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && [...value].length <= max;

/** Origin: the Destino and the Detalhes de pagamento belong to pedidos de venda, OS and pedidos de compra (not propostas). */
export const destinationKind = (kind: DocumentKind) => kind !== 'sales_proposals';
/** "Detalhes da parcela" (Ver detalhes): pedidos de venda and OS; "Dados da parcela" in the pedido de compra. */
export const detailsTitle = (kind: DocumentKind) => kind === 'purchase_orders' ? 'Dados da parcela' : 'Detalhes da parcela';
export const NO_METHODS = 'Não será possível utilizar esta seção pois você não possui forma de pagamentos cadastradas nesta conta.';
export const PAYMENT_DETAILS_HELP = 'Se nenhum valor for selecionado, os campos padrão da empresa serão usados ao gerar a nota fiscal.';
export const PAYMENT_MEANS = PAYMENT_TYPES;
export const PAYMENT_INDICATORS = [['0', 'Pagamento à vista'], ['1', 'Pagamento a prazo']] as const;
export { CARD_BRANDS, CARD_INTEGRATIONS };

/** GET /v1/documentos/{tipo}/pagamento, checked field by field. */
export function readPaymentOptions(value: unknown, kind: DocumentKind): PaymentOptions {
  const page = (value ?? {}) as { kind?: unknown; methods?: unknown; accounts?: unknown };
  if (page.kind !== kind || !Array.isArray(page.methods) || page.methods.length > 200 || !Array.isArray(page.accounts) || page.accounts.length > 200) fail();
  const methods = (page.methods as Record<string, unknown>[]).map(m => {
    if (!m || !UUID.test(String(m.id)) || !text(m.description, 100) || !TYPE_CODES.includes(m.payment_type as string) || (m.condition !== null && !text(m.condition, 100))
      || !['contas', 'ficha', 'caixa'].includes(m.destination as string) || (m.account_id !== null && !UUID.test(String(m.account_id))) || (m.card_brand !== null && !BRAND_CODES.includes(m.card_brand as string))
      || (m.card_integration !== null && !['1', '2'].includes(m.card_integration as string)) || (m.card_cnpj !== null && !/^[A-Z0-9]{12}[0-9]{2}$/.test(String(m.card_cnpj))) || typeof m.is_default !== 'boolean') fail();
    return m as unknown as PaymentMethodOption;
  });
  const accounts = (page.accounts as Record<string, unknown>[]).map(a => {
    if (!a || !UUID.test(String(a.id)) || !text(a.name, 200) || !['bank', 'cash', 'other'].includes(a.kind as string)) fail();
    return a as unknown as PaymentAccountOption;
  });
  return { kind, methods, accounts };
}
export const emptyDetails = (): InstallmentDetails => Object.fromEntries(INSTALLMENT_DETAIL_FIELDS.map(key => [key, null])) as unknown as InstallmentDetails;
/** Choosing a Forma brings its tipo, cartão and conta (Caixa e bancos) into the parcela, as Origin does; amounts stay. */
export function detailsFromMethod(current: InstallmentDetails | null | undefined, method: PaymentMethodOption | null, kind: DocumentKind): InstallmentDetails | null {
  if (kind === 'sales_proposals') return null;
  const base = current ?? emptyDetails();
  if (!method) return current ?? null;
  return { ...base, payment_type: method.payment_type, card_brand: kind === 'purchase_orders' ? base.card_brand : method.card_brand, integration_type: kind === 'purchase_orders' ? base.integration_type : method.card_integration,
    acquirer_cnpj: kind === 'purchase_orders' ? base.acquirer_cnpj : method.card_cnpj, account_id: method.destination === 'caixa' && method.account_id ? method.account_id : base.account_id };
}
/** The Forma of a parcela: its id, and its name in the free "forma prevista" text kept by the older consumers. */
export function withMethod(row: InstallmentInput, method: PaymentMethodOption | null, kind: DocumentKind): InstallmentInput {
  return { ...row, payment_method_id: method?.id ?? null, method: method ? method.description.slice(0, 100) : null,
    ...(kind === 'sales_proposals' ? {} : { details: detailsFromMethod(row.details, method, kind) }) };
}
/** Origin "Forma de pagamento cadastrada" typed in the Condição: the condição padrão of that forma (à vista without one). */
export function methodCondition(textValue: string, methods: readonly PaymentMethodOption[]): { condition: string; method: PaymentMethodOption } | null {
  const wanted = textValue.trim().toLocaleLowerCase('pt-BR');
  if (!wanted) return null;
  const method = methods.find(m => m.description.trim().toLocaleLowerCase('pt-BR') === wanted);
  return method ? { condition: method.condition?.trim() || '0', method } : null;
}
/** Names shown for ids no longer offered (forma or conta inactivated after the choice). */
export function optionName(id: string | null | undefined, options: readonly { id: string }[] | undefined, names: Record<string, string> | undefined, label: (option: never) => string): string | null {
  if (!id) return null;
  const found = options?.find(option => option.id === id);
  return found ? label(found as never) : names?.[id] ?? null;
}
