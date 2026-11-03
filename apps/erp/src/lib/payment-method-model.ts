import { CatalogValidationError } from './catalog-base.ts';
import { paymentConditionValid } from './contact-form-model.ts';

// Cadastros > Formas de pagamento no padrão do Origin (lane contatos, migração 127): tipos de pagamento com os códigos
// tPag da NF-e, seções que aparecem conforme o tipo (boleto, cartão, PIX) e as taxas. Somente cadastro.
export interface PaymentMethod {
  id: string; version: number; active: boolean; is_default: boolean; default_receipt: boolean; default_payment: boolean; default_return: boolean; created_at: string; updated_at: string; account_name: string | null;
  description: string; payment_type: string; condition: string | null; destination: 'contas' | 'ficha' | 'caixa'; account_id: string | null; business_days: boolean;
  applicable: 'pagamentos' | 'recebimentos' | 'ambos'; interest_rate: string | null; fine_rate: string | null; card_brand: string | null; card_integration: string | null; card_cnpj: string | null;
  auto_settle: boolean; pix_integration: string | null; pix_cnpj: string | null; fee_type: 'aliquota' | 'fixa' | 'aliquota_fixa'; fee_rate: string | null; fee_fixed: string | null; settlement_days: number | null;
}
export type Account = { id: string; name: string; active: boolean };
// 371 (leva H, CTT-130): a forma padrão de cada finalidade, respeitando "Aplicável à" e o estado ativo.
export type PaymentDefaultAction = 'default_recebimentos' | 'default_pagamentos' | 'default_devolucoes' | 'clear_devolucoes';
export const PAYMENT_DEFAULT_LABELS: Record<PaymentDefaultAction, string> = { default_recebimentos: 'Forma padrão de recebimentos', default_pagamentos: 'Forma padrão de pagamentos',
  default_devolucoes: 'Forma padrão de devoluções', clear_devolucoes: 'Remover padrão de devoluções' };
/** The ⋮ entries of the defaults: offered by the purpose of the forma, disabled with the reason when inactive or already the default. */
export function defaultMenu(item: Pick<PaymentMethod, 'active' | 'applicable' | 'default_receipt' | 'default_payment' | 'default_return'>) {
  const receives = item.applicable !== 'pagamentos', pays = item.applicable !== 'recebimentos', inactive = item.active ? undefined : 'Ative a forma antes.';
  const entry = (action: PaymentDefaultAction, already: boolean) => ({ action, label: PAYMENT_DEFAULT_LABELS[action], icon: action === 'default_devolucoes' ? 'hand-holding-dollar' : 'check',
    disabled: already || !item.active, title: inactive ?? (already ? 'Já é a forma padrão desta finalidade.' : undefined) });
  return [...(receives ? [entry('default_recebimentos', item.default_receipt)] : []), ...(pays ? [entry('default_pagamentos', item.default_payment)] : []),
    ...(receives ? [entry('default_devolucoes', item.default_return)] : []),
    ...(item.default_return ? [{ action: 'clear_devolucoes' as const, label: PAYMENT_DEFAULT_LABELS.clear_devolucoes, icon: 'xmark', disabled: false, title: undefined }] : [])];
}
export const PAYMENT_TYPES = [['01', 'Dinheiro'], ['02', 'Cheque'], ['03', 'Cartão de Crédito'], ['04', 'Cartão de Débito'], ['05', 'Cartão da Loja (Private Label)'], ['10', 'Vale Alimentação'],
  ['11', 'Vale Refeição'], ['12', 'Vale Presente'], ['13', 'Vale Combustível'], ['14', 'Duplicata Mercantil'], ['15', 'Boleto Bancário'], ['16', 'Depósito Bancário'], ['17', 'Pagamento Instantâneo (Pix) - Dinâmico'],
  ['18', 'Transferência Bancária, Carteira Digital'], ['19', 'Programa de Fidelidade, Cashback, Crédito Virtual'], ['20', 'Pagamento Instantâneo (Pix) - Estático'], ['21', 'Crédito em Loja'],
  ['22', 'Pagamento Eletrônico não Informado - falha de hardware do sistema emissor'], ['90', 'Sem pagamento'], ['91', 'Pagamento Posterior'], ['99', 'Outros']] as const;
export const TYPE_LABEL: Record<string, string> = Object.fromEntries(PAYMENT_TYPES);
export const DESTINATIONS = [['contas', 'Conta a receber/pagar'], ['ficha', 'Ficha financeira'], ['caixa', 'Caixa e bancos']] as const;
export const DESTINATION_LABEL: Record<string, string> = Object.fromEntries(DESTINATIONS);
export const APPLICABLE = [['pagamentos', 'Pagamentos (Nota de Entrada)'], ['recebimentos', 'Recebimentos (Pedidos de Venda, Notas Fiscais, Ordem de Serviço)'], ['ambos', 'Pagamentos e Recebimentos (Todos módulos)']] as const;
export const APPLICABLE_FILTER = [['', 'Todos'], ['pagamentos', 'Pagamento'], ['recebimentos', 'Recebimento'], ['ambos', 'Pagamento e recebimento']] as const;
export const CARD_BRANDS = [['01', 'Visa'], ['02', 'Mastercard'], ['03', 'American Express'], ['04', 'Sorocred'], ['05', 'Diners Club'], ['06', 'Elo'], ['07', 'Hipercard'], ['08', 'Aura'], ['09', 'Cabal'], ['99', 'Outros']] as const;
export const CARD_INTEGRATIONS = [['1', 'Pagamento Integrado'], ['2', 'Pagamento não Integrado']] as const;
export const FEE_TYPES = [['aliquota', 'Alíquota (%)'], ['fixa', 'Fixa (R$)'], ['aliquota_fixa', 'Alíquota + Fixa']] as const;
export const TYPE_HELP = 'Códigos da NF-e (tPag): ' + PAYMENT_TYPES.map(([code, label]) => `${code} ${label}`).join('; ') + '.';
// Seções da página única (Origin PF-09).
export const sectionsOf = (type: string) => ({ boleto: type === '15', card: type === '03' || type === '04', pix: type === '17' || type === '20' });
export type PaymentForm = Record<'description' | 'payment_type' | 'condition' | 'destination' | 'account_id' | 'applicable' | 'interest_rate' | 'fine_rate' | 'card_brand' | 'card_integration' | 'card_cnpj'
  | 'pix_cnpj' | 'fee_type' | 'fee_rate' | 'fee_fixed' | 'settlement_days', string> & { business_days: boolean; auto_settle: boolean };
const decimalText = (value: string | null) => value ? value.replace(/\.?0+$/, '').replace('.', ',') : '';
export function paymentForm(item: PaymentMethod | null): PaymentForm {
  return { description: item?.description ?? '', payment_type: item?.payment_type ?? '01', condition: item?.condition ?? '', destination: item?.destination ?? 'contas', account_id: item?.account_id ?? '',
    applicable: item?.applicable ?? 'ambos', interest_rate: decimalText(item?.interest_rate ?? null), fine_rate: decimalText(item?.fine_rate ?? null), card_brand: item?.card_brand ?? '', card_integration: item?.card_integration ?? '',
    card_cnpj: item?.card_cnpj ?? '', pix_cnpj: item?.pix_cnpj ?? '', fee_type: item?.fee_type ?? 'aliquota', fee_rate: decimalText(item?.fee_rate ?? null), fee_fixed: item?.fee_fixed ? item.fee_fixed.replace('.', ',') : '',
    settlement_days: item?.settlement_days === null || item?.settlement_days === undefined ? '' : String(item.settlement_days), business_days: item?.business_days ?? false, auto_settle: item?.auto_settle ?? false };
}
const fail = (field: string, message: string): never => { throw new CatalogValidationError(field, message); };
const rate = (field: string, label: string, value: string) => {
  const text = value.trim().replace(',', '.'); if (!text) return null;
  if (!/^(0|[1-9]\d?|100)(\.\d{1,4})?$/.test(text) || (text.startsWith('100') && /[1-9]/.test(text.slice(4)))) fail(field, `Informe ${label} entre 0 e 100, com até quatro casas decimais.`);
  return text;
};
/** Request body of the form: every key; the hidden sections go empty, as the server requires. */
export function paymentPayload(form: PaymentForm) {
  const description = form.description.trim(); if (!description) fail('description', 'Informe a descrição da forma de pagamento.');
  if (description.length > 100) fail('description', 'A descrição tem até 100 caracteres.');
  const sections = sectionsOf(form.payment_type), condition = form.condition.trim().replace(/\s+/g, ' ');
  if (condition && !paymentConditionValid(condition)) fail('condition', 'Informe a condição como no Origin: 30 60 90, 3x ou 15 + 2x.');
  const fixed = form.fee_fixed.trim().replace(',', '.');
  if (fixed && !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(fixed)) fail('fee_fixed', 'Informe o valor fixo sem separador de milhares e com até duas casas decimais.');
  const days = form.settlement_days.trim();
  if (days && (!/^\d{1,3}$/.test(days) || Number(days) > 365)) fail('settlement_days', 'Informe o prazo de recebimento em dias, de 0 a 365.');
  const cnpj = (value: string) => value.trim() || null;
  return {
    description, payment_type: form.payment_type, condition: condition || null, destination: form.destination, account_id: form.destination === 'ficha' ? null : form.account_id || null,
    business_days: form.business_days, applicable: form.applicable, interest_rate: sections.boleto ? rate('interest_rate', 'o juros mensal', form.interest_rate) : null,
    fine_rate: sections.boleto ? rate('fine_rate', 'a multa', form.fine_rate) : null, card_brand: sections.card ? form.card_brand || null : null, card_integration: sections.card ? form.card_integration || null : null,
    card_cnpj: sections.card ? cnpj(form.card_cnpj) : null, auto_settle: sections.card && form.auto_settle, pix_integration: sections.pix ? 'sem' : null, pix_cnpj: sections.pix ? cnpj(form.pix_cnpj) : null,
    fee_type: form.fee_type, fee_rate: form.fee_type === 'fixa' ? null : rate('fee_rate', 'o valor da alíquota', form.fee_rate), fee_fixed: form.fee_type === 'aliquota' ? null : fixed || null,
    settlement_days: days ? Number(days) : null,
  };
}
