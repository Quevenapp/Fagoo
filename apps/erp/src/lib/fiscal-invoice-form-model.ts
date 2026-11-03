// Formulário "Nota fiscal" no padrão Origin: rascunho editável, conversão para a API, mensagens de validação e
// campos das abas do modal do item (rótulos da captura de 19/10/2026).
import { FiscalSpecError, ITEM_GROUPS, ITEM_SPEC, UFS } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import { DEFAULT_INVOICE_PREFERENCES, allocateCents, invoiceTotals, lineTotalCents, normalizeInvoiceInput, type InvoiceInput, type InvoicePreferences, type InvoiceRecord, type InvoiceTotals, type NatureRecord, type NatureSummary } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import * as T from '../../../../packages/fiscal-core/src/tax-tables.mjs';
import type { OrderSource } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import type { ScreenConfig } from './fiscal-invoice-list-model.ts';

export type Values = Record<string, string | boolean>;
export type ItemGroup = keyof typeof ITEM_GROUPS;
export interface ItemDraft { [key: string]: string | boolean | Values | undefined; }
export type ImportDraft = { [key: string]: string | boolean | Values[] | undefined; additions?: Values[] };
export type InstallmentDraft = { [key: string]: string | boolean | Values | null | undefined; card?: Values | null };
export interface InvoiceDraft {
  model: '55' | '65'; direction: '0' | '1'; issue_type: string; series: string; number: string; access_key: string; nature_id: string; nature_description: string; cfop: string;
  issue_date: string; exit_date: string; exit_time: string; crt: string; purpose: string; credit_debit_type: string; presence: string; final_consumer: boolean;
  recipient: Values; export: Values; import_declaration: ImportDraft; references: Values[]; items: ItemDraft[]; auto_tax: boolean;
  freight: string; insurance: string; other_expenses: string; discount: string;
  transport: { mode: 'none' | 'manual'; freight_by: string; tracking_code: string; carrier: Values; vehicle: Values; volumes: Values; delivery: Values | null };
  payment: { condition: string; installments: InstallmentDraft[]; indicator?: '0' | '1' }; authorized_xml: Values[]; intermediary: Values;
  additional_info: string; nature_additional_info: string; nature_fiscal_info: string; orders: string[];
  /** 202610200215: Vendedor (cadastro de vendedores) with its name, and Destino da Operação (idDest; '' follows the UFs). */
  seller_id: string; seller_name: string; operation_destination: string;
}
export interface FormContext { company: { crt: string | null; state: string | null }; series: { series: number; next_number: number; enabled: boolean }[]; defaults: Record<string, { id: string; description: string }>; preferences: InvoicePreferences;
  /** "Informar desconto individualmente nos itens" (202610200176); absent before that migration, when the note discount is spread. */
  item_discount?: boolean;
  /** 202610200215: "Preencher manualmente Destino da Operação" and "Permite a visualização das contas a receber / a pagar em aberto". */
  operation_destination_manual?: boolean; open_titles?: { receivable: boolean; payable: boolean } }
export const REGISTERED = ['T', 'S', 'X'];
// An imported NFC-e (wave F, 202610200274) shows its type; the select of the NFC-e is never editable and S is never chosen.
export const issueOptions = (direction: '0' | '1', model: '55' | '65') => model === '65' ? [['C', 'NFCe'], ['S', 'Importação de XML de saída']] as const
  : direction === '1' ? [['N', 'Emissão Própria'], ['D', 'NF-e com DANFE Simplificado Tipo 2'], ['E', 'Exportação'], ['T', 'Emitida por Terceiros'], ['S', 'Importação de XML de saída']] as const
    : [['N', 'Emissão Própria'], ['I', 'Importação'], ['T', 'Emitida por Terceiros'], ['X', 'Importação de XML de entrada']] as const;
// Default nature suggested by the Origin "Padrão ..." codes.
export function defaultNatureCode(direction: '0' | '1', model: '55' | '65', personType?: string) {
  if (model === '65') return ['C', 'S'];
  if (direction === '1') return personType === 'F' ? ['VF', 'S'] : personType === 'J' ? ['VJ', 'S'] : ['S'];
  return personType === 'F' ? ['CF', 'E'] : personType === 'J' ? ['CJ', 'E'] : ['E'];
}
/** Preferências › Notas Fiscais of the context, or Origin's page defaults when the context carries none. */
export const preferencesOf = (context: Pick<FormContext, 'preferences'> | null | undefined): InvoicePreferences => context?.preferences ?? DEFAULT_INVOICE_PREFERENCES;
/** Empty transport with the "Preenchimento" defaults: frete por conta, espécie and quantidade de volumes. */
const emptyTransport = (prefs: InvoicePreferences = DEFAULT_INVOICE_PREFERENCES): InvoiceDraft['transport'] => ({ mode: 'none', freight_by: prefs.freight_by, tracking_code: '', carrier: {}, vehicle: {},
  volumes: { species: prefs.species, ...(prefs.volume_quantity > 0 ? { quantity: String(prefs.volume_quantity) } : {}) }, delivery: null });
export function newDraft(config: Pick<ScreenConfig, 'model' | 'direction'>, context: FormContext | null, today: string): InvoiceDraft {
  const series = context?.series.find(s => s.enabled) ?? context?.series[0], prefs = preferencesOf(context);
  const code = defaultNatureCode(config.direction, config.model).find(c => context?.defaults[c]);
  const nature = code ? context!.defaults[code] : null;
  return { model: config.model, direction: config.direction, issue_type: config.model === '65' ? 'C' : 'N', series: series ? String(series.series) : '1', number: '', access_key: '',
    nature_id: nature?.id ?? '', nature_description: nature?.description ?? '', cfop: '', issue_date: today, exit_date: '', exit_time: '', crt: context?.company.crt ?? '1', purpose: '1',
    credit_debit_type: '', presence: config.direction === '0' ? '9' : '1', final_consumer: config.model === '65', recipient: {}, export: {}, import_declaration: { additions: [] }, references: [],
    items: [], auto_tax: true, freight: '', insurance: '', other_expenses: '', discount: '', transport: emptyTransport(prefs), payment: { condition: '', installments: [] },
    // "Pessoas autorizadas a acessar o XML" of the preferences are copied to every new note, like Origin.
    authorized_xml: prefs.autxml_people.map(p => ({ document: p.document, ...(p.name ? { name: p.name } : {}) })),
    intermediary: { present: false }, additional_info: '', nature_additional_info: '', nature_fiscal_info: '', orders: [], seller_id: '', seller_name: '', operation_destination: '' };
}
const scaledOf = (value: unknown, scale: number) => { const text = String(value ?? '').replace(',', '.').trim(); if (!/^\d{1,15}(\.\d+)?$/.test(text)) return null; const [whole, fraction = ''] = text.split('.'); return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale)); };
const fixed = (value: bigint, scale: number) => { const base = 10n ** BigInt(scale); return `${value / base}.${String(value % base).padStart(scale, '0')}`; };
/** "Somar peso dos produtos": Σ quantity × item weight (kg), rounded half up to three decimals. Null when no item has the weight. */
export function weightSum(items: readonly ItemDraft[], key: 'gross_weight' | 'net_weight'): string | null {
  let total = 0n, any = false;
  for (const item of items) { const quantity = scaledOf(item.quantity, 4), weight = scaledOf(item[key], 3); if (quantity === null || weight === null) continue; any = true; total += quantity * weight; }
  return any ? fixed((total + 5000n) / 10000n, 3) : null;
}
/** "Calcular volume dos produtos": Σ ceil(quantity × volumes of the item). Null when no item has volumes. */
export function volumeCount(items: readonly ItemDraft[]): string | null {
  let total = 0n, any = false;
  for (const item of items) { const quantity = scaledOf(item.quantity, 4), volumes = /^\d{1,6}$/.test(String(item.volumes ?? '')) ? BigInt(String(item.volumes)) : null; if (quantity === null || volumes === null) continue; any = true; total += (quantity * volumes + 9999n) / 10000n; }
  return any && total < 10n ** 15n ? String(total) : null;
}
/** The draft with the volume fields the preferences calculate from the items (the form shows them read-only). */
export function withPreferenceVolumes(draft: InvoiceDraft, prefs: InvoicePreferences): InvoiceDraft {
  if (!prefs.sum_weight && !prefs.compute_volume) return draft;
  const volumes = { ...draft.transport.volumes };
  const set = (key: string, value: string | null) => { if (value === null) delete volumes[key]; else volumes[key] = value; };
  if (prefs.sum_weight) { set('gross_weight', weightSum(draft.items, 'gross_weight')); set('net_weight', weightSum(draft.items, 'net_weight')); }
  if (prefs.compute_volume) set('quantity', volumeCount(draft.items));
  return { ...draft, transport: { ...draft.transport, volumes } };
}
// ---- "Informar desconto individualmente nos itens" (Preferências › Configurações de NF-e, 202610200176) ----
const hasItemDiscount = (item: ItemDraft) => typeof item.discount === 'string' && item.discount.trim() !== '';
/** Sum of the item discounts as the note discount (exact cents; an invalid value leaves the draft as typed for the validation). */
export function withItemDiscounts(draft: InvoiceDraft, itemMode: boolean): InvoiceDraft {
  if (!itemMode) return draft;
  let sum = 0n;
  for (const item of draft.items) { if (!hasItemDiscount(item)) continue; const cents = scaledOf(item.discount, 2); if (cents === null || !/^\d{1,13}([.,]\d{1,2})?$/.test(String(item.discount).trim())) return draft; sum += cents; }
  return { ...draft, discount: sum === 0n ? '' : fixed(sum, 2) };
}
/**
 * The draft in the discount mode of the preference: on, a note without item discounts gets the shares the note discount already
 * had (the totals do not change); off, the items lose their own discount and the note discount is spread again.
 */
export function applyDiscountMode(draft: InvoiceDraft, itemMode: boolean): InvoiceDraft {
  if (!itemMode) return draft.items.some(hasItemDiscount) ? { ...draft, items: draft.items.map(({ discount, ...item }) => item) } : draft;
  if (draft.items.some(hasItemDiscount) || !scaledOf(draft.discount || '0', 2)) return draft;
  const shares = previewTotals(draft)?.allocation.discount;
  if (!shares) return draft;
  return { ...draft, items: draft.items.map((item, index) => shares[index] && shares[index] !== '0.00' ? { ...item, discount: shares[index]! } : item) };
}
/** Origin refuses parcels that do not add up to the note total, unless "Campos com validação opcional: Parcelas" is set. */
export function installmentsMismatch(draft: InvoiceDraft, totalCents: bigint | null, prefs: InvoicePreferences): string | null {
  if (prefs.optional_installments || !draft.payment.installments.length || totalCents === null) return null;
  let sum = 0n;
  for (const i of draft.payment.installments) { const cents = scaledOf(i.amount, 2); if (cents === null) return null; sum += cents; }
  if (sum === totalCents) return null;
  const br = (c: bigint) => `${fixed(c, 2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  return `A soma das parcelas (R$ ${br(sum)}) é diferente do total da nota (R$ ${br(totalCents)}). Ajuste as parcelas ou marque Parcelas em "Campos com validação opcional" nas preferências de NF-e.`;
}
const str = (value: unknown) => value === null || value === undefined ? '' : String(value);
const money = (value: string) => value === '0.00' ? '' : value;
export function recordToDraft(record: InvoiceRecord): InvoiceDraft {
  return { model: record.model, direction: record.direction, issue_type: record.issue_type, series: String(record.series), number: str(record.number), access_key: str(record.access_key),
    nature_id: str(record.nature_id), nature_description: record.nature_description, cfop: str(record.cfop), issue_date: record.issue_date, exit_date: str(record.exit_date), exit_time: str(record.exit_time),
    crt: record.crt, purpose: record.purpose, credit_debit_type: str(record.credit_debit_type), presence: record.presence, final_consumer: record.final_consumer, recipient: { ...record.recipient },
    export: { ...(record.export ?? {}) }, import_declaration: record.import_declaration ? { ...record.import_declaration, additions: record.import_declaration.additions.map(a => ({ ...a })) } : { additions: [] },
    references: record.references.map(r => ({ ...r })), items: record.items.map(({ position, total, allocated, ...item }) => structuredClone(item) as ItemDraft), auto_tax: record.auto_tax,
    freight: money(record.freight), insurance: money(record.insurance), other_expenses: money(record.other_expenses), discount: money(record.discount),
    transport: { mode: record.transport.mode, freight_by: record.transport.freight_by, tracking_code: str(record.transport.tracking_code), carrier: { ...record.transport.carrier }, vehicle: { ...record.transport.vehicle },
      volumes: { ...record.transport.volumes }, delivery: record.transport.delivery ? { ...record.transport.delivery } : null },
    payment: { condition: str(record.payment.condition), installments: record.payment.installments.map(i => ({ ...i, card: i.card ? { ...i.card } : null }) as InstallmentDraft), ...(record.payment.indicator ? { indicator: record.payment.indicator } : {}) },
    authorized_xml: record.authorized_xml.map(a => ({ ...a })), intermediary: { present: false, ...record.intermediary }, additional_info: str(record.additional_info),
    nature_additional_info: str(record.nature_additional_info), nature_fiscal_info: str(record.nature_fiscal_info), orders: record.orders.map(o => o.id),
    seller_id: str(record.seller_id), seller_name: str(record.seller_name), operation_destination: str(record.operation_destination) };
}
/**
 * Wave F, "Editar NF-e" (Notas recebidas): the entry note read from the received XML (the Worker checked its signature and total) as a
 * draft "Emitida por Terceiros", keeping the number, the series and the key of the supplier, with the entry nature of the company when it
 * has one (Padrão compra by the type of the supplier). The user completes and saves it like any registered note.
 */
export function xmlDraft(input: InvoiceInput, context: FormContext | null): InvoiceDraft {
  const items = input.items.map((item, index) => ({ ...structuredClone(item), position: index + 1, total: '0.00', allocated: { freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00' } }));
  const draft = recordToDraft({ ...structuredClone(input), id: '', version: 1, status: 8, environment: null, series: Number(input.series), number: input.number === null ? null : Number(input.number),
    protocol: null, authorized_at: null, items, totals: {}, orders: [], created_at: '', updated_at: '', deleted_at: null, delete_reason: null } as unknown as InvoiceRecord);
  const code = defaultNatureCode('0', '55', String(input.recipient.person_type ?? '')).find(c => context?.defaults[c]);
  return { ...draft, direction: '0', issue_type: 'T', ...(code ? { nature_id: context!.defaults[code]!.id, nature_description: context!.defaults[code]!.description } : {}) };
}
/** "Clonar nota": same content, no number, key, protocol or effects. Inverting swaps exit/entry and drops the nature for the other direction. */
export function cloneDraft(record: InvoiceRecord, { invert = false, toNfe = false, context = null as FormContext | null } = {}): InvoiceDraft {
  const draft = recordToDraft(record);
  draft.number = ''; draft.access_key = ''; draft.orders = [];
  // A cloned imported NFC-e (S, wave F) becomes an NFC-e of the Brufap (C, the only own type of model 65).
  if (REGISTERED.includes(draft.issue_type)) draft.issue_type = draft.model === '65' ? 'C' : 'N';
  if (toNfe) {
    Object.assign(draft, { model: '55', issue_type: 'N', presence: '1' });
    if (record.access_key) draft.references = [{ type: 'nfe', key: record.access_key }];
  }
  if (invert) {
    const direction = draft.direction === '1' ? '0' : '1';
    const code = defaultNatureCode(direction, '55').find(c => context?.defaults[c]);
    Object.assign(draft, { direction, issue_type: 'N', presence: direction === '0' ? '9' : '1', nature_id: code ? context!.defaults[code].id : '', nature_description: code ? context!.defaults[code].description : '',
      cfop: '', export: {}, import_declaration: { additions: [] }, operation_destination: '' });
    draft.items = draft.items.map(item => { const next = { ...item }; delete next.cfop; delete next.ipi; return next; });
  }
  return draft;
}
/**
 * "Gerar devolução": a note in the other direction, finalidade 4 (Devolução de mercadoria), referencing the original key, with the
 * "Padrão devolução" nature when the company set one. Always an NF-e (an NFC-e is returned by an entry NF-e). Quantities are the
 * original ones for the user to reduce (partial return); lançar estoque e contas pela nota continua desligado.
 * The return is an own NF-e: it takes the NF-e series of the context (like a new note), never the series of an NFC-e or of the
 * supplier's note it returns.
 */
export function returnDraft(draft: InvoiceDraft, accessKey: string | null, context: FormContext | null): InvoiceDraft {
  const direction = draft.direction, code = direction === '0' ? 'DE' : 'DS', nature = context?.defaults[code];
  const series = context?.series.find(s => s.enabled) ?? context?.series[0];
  return { ...draft, model: '55', issue_type: 'N', series: series ? String(series.series) : '1', purpose: '4', final_consumer: false, presence: direction === '0' ? '9' : draft.presence === '9' ? '1' : draft.presence,
    references: accessKey ? [{ type: 'nfe', key: accessKey }] : [], ...(nature ? { nature_id: nature.id, nature_description: nature.description } : {}), payment: { condition: '', installments: [] } };
}
/** "NFe complementar": finalidade 2 referencing the original key, items to be adjusted by the user. */
export function complementaryDraft(record: InvoiceRecord): InvoiceDraft {
  const draft = cloneDraft(record);
  return { ...draft, purpose: '2', references: record.access_key ? [{ type: 'nfe', key: record.access_key }] : [] };
}
const decimalInput = (value: string) => value.replace(/\s/g, '').replace(',', '.');
const cleanValues = (values: Values | null | undefined, spec?: Record<string, string>) => {
  const out: Values = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === '' || value === undefined || value === null) continue;
    out[key] = typeof value === 'string' && spec?.[key]?.startsWith('d:') ? decimalInput(value) : value;
  }
  return out;
};
const optional = (value: string) => value.trim() === '' ? null : value.trim();
/** Converts the draft to the API body shape (empty fields become absent/null, decimal commas become points). */
export function draftToInput(draft: InvoiceDraft): Record<string, unknown> {
  const registered = REGISTERED.includes(draft.issue_type);
  const items = draft.items.map(item => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (Object.hasOwn(ITEM_GROUPS, key)) { const group = cleanValues(value as Values, ITEM_GROUPS[key as ItemGroup]); if (Object.keys(group).length) out[key] = group; }
      else if (value !== '' && value !== undefined && value !== null) out[key] = typeof value === 'string' && ITEM_SPEC[key]?.startsWith('d:') ? decimalInput(value) : value;
    }
    return out;
  });
  const { additions = [], ...declaration } = draft.import_declaration;
  return { model: draft.model, direction: draft.direction, issue_type: draft.issue_type, series: draft.series.trim(), number: registered ? optional(draft.number) : null,
    access_key: registered ? optional(draft.access_key) : null, nature_id: optional(draft.nature_id), nature_description: optional(draft.nature_description), cfop: optional(draft.cfop),
    issue_date: draft.issue_date, exit_date: optional(draft.exit_date), exit_time: optional(draft.exit_time), crt: draft.crt, purpose: draft.purpose,
    credit_debit_type: ['5', '6'].includes(draft.purpose) ? optional(draft.credit_debit_type) : null, presence: draft.presence, final_consumer: draft.final_consumer,
    recipient: cleanValues(draft.recipient), export: draft.issue_type === 'E' ? cleanValues(draft.export) : null,
    import_declaration: draft.issue_type === 'I' ? { ...cleanValues(declaration as Values), additions: additions.map(a => cleanValues(a)) } : null,
    references: draft.references.map(r => cleanValues(r)), items, auto_tax: draft.auto_tax, freight: decimalInput(draft.freight) || '0', insurance: decimalInput(draft.insurance) || '0',
    other_expenses: decimalInput(draft.other_expenses) || '0', discount: decimalInput(draft.discount) || '0',
    transport: { mode: draft.transport.mode, freight_by: draft.transport.freight_by, ...(draft.transport.tracking_code.trim() ? { tracking_code: draft.transport.tracking_code.trim() } : {}),
      carrier: draft.transport.mode === 'none' ? {} : cleanValues(draft.transport.carrier), vehicle: draft.transport.mode === 'none' ? {} : cleanValues(draft.transport.vehicle),
      volumes: cleanValues(draft.transport.volumes, { gross_weight: 'd:3:12', net_weight: 'd:3:12' }), delivery: draft.transport.delivery ? cleanValues(draft.transport.delivery) : null },
    payment: { condition: optional(draft.payment.condition), installments: draft.payment.installments.map(({ card, ...i }) => ({ ...cleanValues(i as Values, { amount: 'd:2:13' }), card: card ? cleanValues(card, { received: 'd:2:13', fee: 'd:2:13', commission_fee: 'd:2:13' }) : null })),
      ...(draft.payment.indicator ? { indicator: draft.payment.indicator } : {}) },
    authorized_xml: draft.authorized_xml.map(a => cleanValues(a)), intermediary: cleanValues(draft.intermediary), additional_info: optional(draft.additional_info),
    nature_additional_info: optional(draft.nature_additional_info), nature_fiscal_info: optional(draft.nature_fiscal_info),
    seller_id: optional(draft.seller_id), operation_destination: optional(draft.operation_destination) };
}
const MESSAGES: Record<string, string> = {
  FISCAL_RECIPIENT_REQUIRED: 'Informe o nome do contato e o tipo da pessoa do destinatário.', FISCAL_RECIPIENT_DOCUMENT_INVALID: 'O CNPJ/CPF não combina com o tipo da pessoa.',
  FISCAL_INVOICE_ITEMS_REQUIRED: 'Inclua pelo menos um item na nota.', FISCAL_ITEM_INVALID: 'Cada item precisa de descrição, quantidade maior que zero e preço.',
  FISCAL_ITEM_SITUATION_INVALID: 'A situação tributária do item não combina com o regime ou com o tipo da nota.', FISCAL_INVOICE_NATURE_REQUIRED: 'Escolha a natureza de operação.',
  FISCAL_INVOICE_SERIES_INVALID: 'Informe a série (padrão 1).', FISCAL_INVOICE_NUMBER_INVALID: 'Informe o número da nota emitida por terceiros.',
  FISCAL_INVOICE_ACCESS_KEY_INVALID: 'A chave de acesso não confere com o modelo, a série e o número.', FISCAL_INVOICE_NUMBER_RESERVED_ON_SEND: 'O número é definido quando a nota for enviada.',
  FISCAL_INVOICE_DISCOUNT_EXCEEDS: 'O desconto não pode ser maior que o total dos produtos.', FISCAL_INVOICE_AMOUNT_INVALID: 'O total da nota ficou inválido.',
  FISCAL_INVOICE_NFCE_INVALID: 'NFC-e exige consumidor final, finalidade normal e indicador de presença 1 ou 4.', FISCAL_INVOICE_ISSUE_DATE_REQUIRED: 'Informe a data de emissão.',
  FISCAL_INVOICE_INTERMEDIARY_INVALID: 'Com intermediador, informe o CNPJ e a identificação no intermediador.', FISCAL_INVOICE_AUTHORIZED_INVALID: 'Cada pessoa autorizada precisa de CPF/CNPJ, sem repetir.',
  FISCAL_REFERENCE_KEY_INVALID: 'A chave deve ter 44 dígitos válidos.', FISCAL_REFERENCE_DUPLICATE: 'Esta chave já foi adicionada', FISCAL_REFERENCE_INVALID: 'Confira os dados do documento referenciado.',
  FISCAL_INSTALLMENT_INVALID: 'Cada parcela precisa de data e valor.', FISCAL_TRANSPORT_INVALID: 'Sem transporte, não informe transportadora nem veículo.',
  FISCAL_INVOICE_ISSUE_TYPE_UNAVAILABLE: 'Notas de XML são registradas por "Importar XML NF-e" (Mais ações da lista).', FISCAL_INVOICE_HEADER_INVALID: 'Confira o cabeçalho da nota.',
  FISCAL_INVOICE_DESTINATION_INVALID: 'O Destino da Operação não combina com o destinatário: 3 - Operação com exterior só para estrangeiro, e a NFC-e é sempre interna.',
};
export function validationMessage(error: unknown): string {
  if (error instanceof FiscalSpecError) return MESSAGES[error.code] ?? (error.field ? `Confira o campo ${FIELD_LABELS[error.field.split('.').at(-1)!] ?? error.field}.` : 'Confira os campos da nota.');
  return 'Confira os campos da nota.';
}
/** Normalizes locally exactly like the API; returns the body or a message. */
export function checkDraft(draft: InvoiceDraft): { input: InvoiceInput; totals: InvoiceTotals } | { error: string } {
  try { const input = normalizeInvoiceInput(draftToInput(draft)); return { input, totals: invoiceTotals(input) }; } catch (error) { return { error: validationMessage(error) }; }
}
export function previewTotals(draft: InvoiceDraft): InvoiceTotals | null {
  try { return invoiceTotals(normalizeInvoiceInput(draftToInput(draft))); } catch { return null; }
}

// ---- Item dialog (Origin #form_edicao_item) ----
export type FieldKind = 'select' | 'decimal' | 'text' | 'textarea' | 'check';
export interface FieldDef { key: string; label: string; kind: FieldKind; options?: readonly (readonly [string, string])[]; placeholder?: string; readOnly?: boolean }
const f = (key: string, label: string, kind: FieldKind = 'decimal', options?: readonly (readonly [string, string])[], placeholder?: string): FieldDef => ({ key, label, kind, options, placeholder });
export const FIELD_LABELS: Record<string, string> = {};
export interface ItemTab { id: string; label: string; group: ItemGroup | null; sections: { title?: string; fields: FieldDef[] }[] }
const CST_OR_CSOSN = (crt: string) => crt === '3' ? T.ICMS_CST : T.ICMS_CSOSN;
export const UF_OPTIONS = UFS.map(uf => [uf, uf] as const);
export const UF_EX_OPTIONS = [...UF_OPTIONS, ['EX', 'EX'] as const];
/** Item tabs Origin shows only when Preferências › Configurações de NF-e enable them (or when the item already has data there). */
export type OptionalTabs = { fuel: boolean; weapon: boolean; vehicle: boolean; retentions: boolean };
export const ALL_TABS: OptionalTabs = Object.freeze({ fuel: true, weapon: true, vehicle: true, retentions: true });
export const optionalTabs = (prefs: InvoicePreferences, item?: ItemDraft | null): OptionalTabs => {
  const filled = (group: string) => Boolean(item && item[group] && typeof item[group] === 'object' && Object.keys(item[group] as Values).length);
  return { fuel: prefs.fuel_group || filled('fuel'), weapon: prefs.weapon_group || filled('weapon'), vehicle: prefs.vehicle_group || filled('vehicle'), retentions: prefs.retention_group || filled('retentions') };
};
export function itemTabs(crt: string, direction: '0' | '1', show: OptionalTabs = ALL_TABS): ItemTab[] {
  const ipiCst = T.IPI_CST.filter(([code]) => direction === '0' ? Number(code) < 50 : Number(code) >= 50);
  const tabs: ItemTab[] = [
    { id: 'dados', label: 'Dados do item', group: null, sections: [{ fields: [f('quantity', 'Quantidade'), f('unit', 'Unidade', 'text'), f('unit_price', 'Valor Unitário'), f('discount_type', 'Tipo desconto', 'select', T.DISCOUNT_TYPE),
      f('cfop', 'CFOP', 'text'), f('ncm', 'NCM', 'text'), f('cest', 'CEST', 'text'), f('gtin', 'GTIN/EAN', 'text', undefined, 'SEM GTIN'), f('gtin_tax', 'GTIN/EAN tributário', 'text', undefined, 'SEM GTIN'),
      f('barcode', 'Código de barras interno', 'text'), f('barcode_tax', 'Código de barras tributário', 'text'), f('gross_weight', 'Peso Bruto'), f('net_weight', 'Peso Líquido'), f('volumes', 'Volumes', 'text'),
      f('invoiced', 'Faturado', 'check'), f('info', 'Informações adicionais', 'textarea'), f('complementary_info', 'Informações complementares do item', 'textarea'),
      f('fiscal_info', 'Informações adicionais de interesse do fisco do item', 'textarea')] }] },
    { id: 'icms', label: 'ICMS', group: 'icms', sections: [
      { title: 'Geral', fields: [f('situation', crt === '3' ? 'Situação tributária do ICMS' : 'CSOSN', 'select', CST_OR_CSOSN(crt)), f('taxation', crt === '3' ? 'Tributação ICMS' : 'Tributação Simples', 'select', T.TAXATION),
        f('origin', 'Origem', 'select', T.ORIGIN), f('bc_mode', 'Modalidade BC ICMS', 'select', T.BC_MODE), f('pauta_value', 'Valor da pauta por un'), f('base_rate', '% Base ICMS'), f('base', 'Valor Base ICMS'),
        f('deferral_rate', '% Dif. ICMS'), f('presumed_rate', 'Presumido %'), f('presumed_value', 'Val. Presumido'), f('rate', '% ICMS'), f('value', 'Valor ICMS'), f('fcp_rate', '% FCP'), f('fcp_value', 'Valor FCP'),
        f('fcp_deferral_rate', '% Dif. FCP'), f('fcp_deferral_value', 'Valor Dif. FCP'), f('fcp_effective_value', 'Valor Efet Dif. FCP'), f('credit_rate', '% Aplic. Créd.'), f('credit_value', 'Val. Aplic. Créd.'),
        f('deson_value', 'ICMS desonerado'), f('deson_reason', 'Motivo desoneração', 'select', T.DESON_REASON), f('deson_deduct', 'Dedução do ICMS desonerado', 'check'),
        f('reduction_reason', 'Motivo redução', 'select', T.REDUCTION_REASON), f('benefit_code', 'Código do benefício fiscal na UF', 'text'), f('presumed_credit_code', 'Código crédito presumido', 'text'),
        f('rbc_benefit_code', 'Código benefício fiscal RBC', 'text'), f('mono_qty', 'Qtd. Trib. Retenção'), f('mono_rate', 'Aliq. ICMS Retenção'), f('mono_value', 'Valor ICMS Retenção'),
        f('mono_deferred_value', 'Valor ICMS Dif.'), f('mono_icms_value', 'Valor ICMS'), f('complementary_info', 'Informações complementares do ICMS', 'textarea'),
        f('fiscal_info', 'Informações adicionais de interesse do fisco do ICMS', 'textarea')] },
      { title: 'Substituição tributária', fields: [f('st_bc_mode', 'Modalidade BC ICMS ST', 'select', T.ST_BC_MODE), f('st_pauta_value', 'Valor da pauta por un'), f('st_mva', '% MVA ICMS ST'), f('st_base_rate', '% Base ICMS ST'),
        f('st_base', 'Valor Base ICMS ST'), f('st_rate', 'Alíq. ICMS ST'), f('st_value', 'Valor ICMS ST'), f('st_deson_value', 'ICMS ST desonerado'), f('st_deson_reason', 'Motivo desoneração ST', 'select', T.ST_DESON_REASON),
        f('pis_st_base', 'Base PIS ST'), f('pis_st_rate', 'Alíq. PIS ST'), f('pis_st_value', 'Valor PIS ST'), f('cofins_st_base', 'Base COFINS ST'), f('cofins_st_rate', 'Alíq. COFINS ST'), f('cofins_st_value', 'Valor COFINS ST')] },
      { title: 'Substituição tributária - Retenção', fields: [f('ret_unit_base', 'Valor unitário base'), f('ret_unit_icms', 'Valor unitário ICMS retido'), f('ret_unit_substitute', 'Valor unitário ICMS substituto'),
        f('ret_substitute_value', 'Valor ICMS substituto'), f('ret_base_rate', '% Base ICMS ST Retido'), f('ret_base', 'Valor Base ICMS ST Retido'), f('ret_rate', 'Alíq. ICMS ST Retido (%)'), f('ret_value', 'Valor ICMS ST Retido')] },
      { title: 'Partilha', fields: [f('difal_type', 'Tipo de tributação', 'select', T.DIFAL_TYPE), f('difal_base_rate', '% Base partilha'), f('difal_base', 'Base ICMS partilha'), f('difal_fcp_rate', '% FCP'),
        f('difal_fcp_value', 'Valor FCP'), f('difal_internal_rate', 'Alíquota Interna'), f('difal_interstate_rate', 'Alíq. interestadual', 'select', T.INTERSTATE_RATE), f('difal_share_rate', '% partilha'),
        f('difal_dest_value', 'Valor para UF destino'), f('difal_origin_value', 'Valor para UF remetente')] }] },
    { id: 'ipi', label: 'IPI', group: 'ipi', sections: [{ fields: [f('taxation', 'Tributação IPI', 'select', T.TAXATION), f('situation', 'Situação tributária do IPI', 'select', ipiCst), f('base_rate', '% Base IPI'),
      f('base', 'Valor Base IPI'), f('rate', 'Alíq. IPI'), f('value', 'Valor IPI'), f('unit_value', 'Valor IPI Fixo Unit.'), f('class_code', 'Classe Enquad. IPI', 'text'), f('seal_code', 'Código do selo', 'text'),
      f('framing_code', 'Cód Enquad. IPI', 'text'), f('tipi_exception', 'Código exceção da TIPI', 'text'), f('final_consumer', 'Consumidor Final', 'check'), f('devol_rate', '% devolução'), f('devol_value', 'Valor devolução'),
      f('complementary_info', 'Informações complementares do IPI', 'textarea'), f('fiscal_info', 'Informações adicionais de interesse do fisco do IPI', 'textarea')] }] },
    ...(['pis', 'cofins'] as const).map(tax => ({ id: tax, label: tax === 'pis' ? 'PIS' : 'COFINS', group: tax, sections: [{ title: tax === 'pis' ? 'PIS' : 'COFINS', fields: [
      f('situation', `Situação tributária do ${tax === 'pis' ? 'PIS' : 'COFINS'}`, 'select', T.PIS_CST), f('taxation', `Tributação ${tax === 'pis' ? 'PIS' : 'COFINS'}`, 'select', T.TAXATION), f('base_rate', '% Base'),
      f('base', 'Valor Base'), f('rate', 'Alíq.'), f('value', 'Valor'), f('unit_value', 'Valor fixo (por unidade)'), f('complementary_info', 'Informações complementares', 'textarea'),
      f('fiscal_info', 'Informações adicionais de interesse do fisco', 'textarea')] }] }) as ItemTab),
    { id: 'ii', label: 'Importação', group: 'ii', sections: [{ fields: [f('situation', 'Situação', 'select', T.II_SITUATION), f('base', 'Valor Base Importação'), f('rate', 'Alíq. Importação'), f('value', 'Valor Importação'),
      f('taxation', 'Tributação II', 'select', T.TAXATION), f('customs_expense', 'Valor despesa aduaneira'), f('add_icms', 'Somar ICMS', 'check'), f('add_other', 'Somar outras despesas', 'check'), f('addition', 'Adição', 'text')] }] },
    { id: 'export', label: 'Exportação', group: 'export', sections: [{ fields: [f('drawback', 'Número do ato concessório de Drawback', 'text'), f('registry', 'Número do Registro de Exportação', 'text'),
      f('key', 'Chave de Acesso da NF-e recebida para exportação', 'text')] }] },
    { id: 'fuel', label: 'Combustível', group: 'fuel', sections: [{ fields: [f('anp_code', 'Código ANP', 'text'), f('anp_description', 'Descrição conforme ANP (SIMP)', 'text'), f('codif', 'Código CODIF', 'text'),
      f('consumption_state', 'UF de consumo', 'select', UF_OPTIONS),
      f('ambient_qty', 'Quantidade ambiente'), f('glp_rate', '% GLP derivado do petróleo'), f('glgnn_rate', '% GLGNn'), f('glgni_rate', '% GLGNi'), f('start_value', 'Valor de partida'),
      f('cide_base', 'Base CIDE'), f('cide_rate', 'Alíq. CIDE'), f('cide_value', 'Valor CIDE'), f('biodiesel_rate', 'Índice de mistura do biodiesel (%)')] }] },
    { id: 'medicine', label: 'Medicamento', group: 'medicine', sections: [{ fields: [f('anvisa_code', 'Código produto ANVISA', 'text', undefined, 'ISENTO'), f('max_price', 'Preço máximo consumidor'),
      f('exemption_reason', 'Motivo da isenção ANVISA', 'text')] }] },
    { id: 'others', label: 'Outros', group: 'others', sections: [{ fields: [f('presumed_pis_cofins', 'Presumido no cálculo do PIS/COFINS', 'check'), f('funrural_rate', 'Alíq. Funrural'),
      f('sped_type', 'Tipo do item (SPED)', 'select', T.SPED_TYPE), f('commission_base', 'Base Comissão'), f('commission_rate', 'Alíquota Comissão'), f('commission_value', 'Valor Comissão'), f('fci', 'Número FCI', 'text'),
      f('purchase_order', 'Número do Pedido de Compra', 'text'), f('purchase_order_item', 'Nr. Item Pedido de Compra', 'text'), f('ibpt_rate', '% Aprox. Trib. IBPT'), f('approx_taxes', 'Valor Aprox. Trib.'),
      f('tax_unit', 'Unidade tributária', 'text'), f('tax_quantity', 'Quantidade tributária')] }] },
    { id: 'stock', label: 'Estoque', group: 'stock', sections: [{ fields: [f('supplier_code', 'Código no fornecedor', 'text'), f('scale', 'Indicador de escala relevante', 'select', T.SCALE), f('manufacturer_cnpj', 'CNPJ do fabricante', 'text')] }] },
    { id: 'retentions', label: 'Retenções', group: 'retentions', sections: [{ fields: [f('csrf', 'Reter CSRF', 'check'), f('pis_value', 'Valor PIS retido'), f('cofins_value', 'Valor COFINS retido'), f('csll_rate', 'Alíq. CSLL'),
      f('csll_value', 'Valor CSLL'), f('ir', 'Reter IR', 'check'), f('ir_csll_base', 'Base IR e CSLL'), f('ir_rate', 'Alíq. IR'), f('ir_value', 'Valor IR')] }] },
    { id: 'weapon', label: 'Armamento', group: 'weapon', sections: [{ fields: [f('type', 'Tipo de Arma', 'select', T.WEAPON_TYPE), f('description', 'Descrição', 'text'), f('serial', 'Nro de Série da Arma', 'text'),
      f('barrel', 'Nro de Série do Cano', 'text')] }] },
    { id: 'vehicle', label: 'Veículo', group: 'vehicle', sections: [{ fields: [f('operation', 'Tipo da operação', 'select', T.VEHICLE_OPERATION), f('chassis', 'Chassi (VIN)', 'text'), f('color_code', 'Cód. cor', 'text'),
      f('color', 'Cor', 'text'), f('power', 'Potência', 'text'), f('displacement', 'Cilindradas', 'text'), f('net_weight', 'Peso Líquido', 'text'), f('gross_weight', 'Peso Bruto', 'text'), f('serial', 'Serial', 'text'),
      f('fuel_type', 'Tipo de combustível', 'text'), f('engine_number', 'Número do motor', 'text'), f('cmt', 'CMT', 'text'), f('wheelbase', 'Distância entre eixos', 'text'), f('model_year', 'Ano modelo', 'text'),
      f('manufacture_year', 'Ano fabricação', 'text'), f('paint_type', 'Tipo de pintura', 'text'), f('vehicle_type', 'Tipo de veículo', 'text'), f('species', 'Espécie', 'select', T.VEHICLE_SPECIES),
      f('vin_condition', 'Condição do VIN', 'select', T.VIN_CONDITION), f('vehicle_condition', 'Condição do veículo', 'select', T.VEHICLE_CONDITION), f('brand_model_code', 'Código marca modelo', 'text'),
      f('denatran_color', 'Cor DENATRAN', 'text'), f('capacity', 'Lotação', 'text'), f('restriction', 'Restrição', 'select', T.VEHICLE_RESTRICTION)] }] },
  ];
  for (const tab of tabs) for (const section of tab.sections) for (const field of section.fields) FIELD_LABELS[field.key] ??= field.label;
  return tabs.filter(tab => !(tab.id in show) || show[tab.id as keyof OptionalTabs]);
}
/** Values computed by "Cálculo automático" are read-only while it is on. */
export const AUTO_FIELDS: Readonly<Record<string, readonly string[]>> = {
  icms: ['base', 'value', 'credit_value', 'fcp_value', 'st_base', 'st_value', 'deson_value', 'mono_value', 'pis_st_base', 'pis_st_value', 'cofins_st_base', 'cofins_st_value', 'ret_base', 'ret_value',
    'difal_base', 'difal_fcp_value', 'difal_dest_value', 'difal_origin_value'],
  ipi: ['base', 'value'], pis: ['base', 'value'], cofins: ['base', 'value'], ii: ['value'], others: ['approx_taxes'],
};
export const natureLabel = (nature: Pick<NatureRecord, 'description'>) => nature.description;
export const PRESENCE_OPTIONS = T.PRESENCE, CRT_OPTIONS = T.CRT, PURPOSE_OPTIONS = T.PURPOSE, PERSON_OPTIONS = T.PERSON_TYPE, IE_OPTIONS = T.IE_INDICATOR, REFERENCE_OPTIONS = T.REFERENCE_TYPE,
  TRANSPORT_OPTIONS = T.TRANSPORT_MODE, FREIGHT_OPTIONS = T.FREIGHT_BY, SPECIES_OPTIONS = T.SPECIES, PAYMENT_OPTIONS = T.PAYMENT_METHOD, ROUTE_OPTIONS = T.IMPORT_ROUTE, IMPORT_FORM_OPTIONS = T.IMPORT_FORM,
  CARD_BRAND_OPTIONS = T.CARD_BRAND, CARD_INTEGRATION_OPTIONS = T.CARD_INTEGRATION;
/**
 * "Gerar parcelas" with Origin's condition syntax: "30 60", "30, 60", "3x" (monthly), "15 +2x" (15 days then 2 more every 30 days). Exact cents; the last installment takes the remainder.
 * `firstCents` ("Cobrar IPI / ICMS ST na primeira parcela") is charged whole in the first installment; only the rest is split.
 */
export function installmentsFromCondition(condition: string, totalCents: bigint, baseDate: string, firstCents = 0n): { days: string; date: string; amount: string }[] | null {
  if (firstCents < 0n || firstCents > totalCents) return null;
  if (firstCents > 0n) {
    const plan = installmentsFromCondition(condition, totalCents - firstCents, baseDate);
    if (!plan && totalCents - firstCents > 0n) return null;
    const rest = plan ?? installmentsFromCondition(condition, 1n, baseDate)?.map(i => ({ ...i, amount: '0.00' }));
    if (!rest) return null;
    return rest.map((i, n) => n === 0 ? { ...i, amount: fixed(scaledOf(i.amount, 2)! + firstCents, 2) } : i);
  }
  const text = condition.trim().toLowerCase();
  let days: number[] = [];
  const times = /^(\d{1,2})x$/.exec(text), plus = /^(\d{1,4})\s*\+\s*(\d{1,2})x$/.exec(text);
  if (times) days = Array.from({ length: Number(times[1]) }, (_, i) => 30 * (i + 1));
  else if (plus) days = [Number(plus[1]), ...Array.from({ length: Number(plus[2]) }, (_, i) => Number(plus[1]) + 30 * (i + 1))];
  else if (/^\d{1,4}([\s,/]+\d{1,4})*$/.test(text)) days = text.split(/[\s,/]+/).map(Number);
  else return null;
  if (!days.length || days.length > 120 || days.some(d => d > 9999) || totalCents <= 0n || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return null;
  const count = BigInt(days.length), share = totalCents / count;
  return days.map((d, i) => {
    const date = new Date(`${baseDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + d);
    const cents = i === days.length - 1 ? totalCents - share * (count - 1n) : share;
    return { days: String(d), date: date.toISOString().slice(0, 10), amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` };
  });
}

// ---- "Gerar nota fiscal" / "Gerar NFC-e" from a pedido (migration 202610200176) ----
const plainText = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** The pedido keeps the payment method as free text; the note keeps the tPag code. Unknown texts stay out (the parcel keeps the text). */
export function paymentMethodOf(text: string | null | undefined): string {
  const t = plainText(text ?? '');
  if (!t.trim()) return '';
  if (/pix/.test(t)) return '17';
  if (/boleto/.test(t)) return '15';
  if (/cartao/.test(t) && /debito/.test(t)) return '04';
  if (/cartao/.test(t) && /credito/.test(t)) return '03';
  if (/dinheiro/.test(t)) return '01';
  if (/cheque/.test(t)) return '02';
  if (/deposito/.test(t)) return '16';
  if (/transferencia/.test(t)) return '18';
  return '';
}
const cut = (value: string | null | undefined, max: number) => { const text = (value ?? '').trim(); return text ? [...text].slice(0, max).join('') : ''; };
const onlyDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const trimZeros = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
/** Weight with up to ten decimals rounded half up to the three decimals of the note. */
const weightOf = (value: string | null | undefined) => {
  const text = (value ?? '').trim(); if (!/^\d{1,12}(\.\d{1,10})?$/.test(text)) return '';
  const [whole, fraction = ''] = text.split('.'), scaled = BigInt(whole!) * 10000n + BigInt((fraction + '0000').slice(0, 4)), rounded = (scaled + 5n) / 10n;
  return rounded > 0n ? `${rounded / 1000n}.${String(rounded % 1000n).padStart(3, '0')}` : '';
};
const stateOf = (value: string | null | undefined) => { const uf = (value ?? '').trim().toUpperCase(); return (UFS as readonly string[]).includes(uf) || uf === 'EX' ? uf : ''; };
const withValues = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')) as Values;
/** The contact of the pedido as the note recipient (current cadastro, Contribuinte and e-mail da NF-e of the contact profile). */
export function orderRecipient(c: OrderSource['contact']): Values {
  const document = onlyDigits(c.document), type = c.person_type ?? (document.length === 14 ? 'J' : document.length === 11 ? 'F' : '');
  const ie = onlyDigits(c.ie), phone = onlyDigits(c.phone || c.mobile), postal = onlyDigits(c.postal_code), email = cut(c.nfe_email, 60) || cut(c.email, 60);
  // A foreign contact (Tipo E) goes with its foreign id (idEstrangeiro) when the cadastro document fits it.
  const foreign = type === 'E' && /^[A-Za-z0-9.:/-]{1,20}$/.test((c.document ?? '').trim()) ? (c.document ?? '').trim() : '';
  return withValues({ contact_id: c.contact_id, name: cut(c.name, 60), person_type: type, document: type !== 'E' && (document.length === 11 || document.length === 14) ? document : '', foreign_id: foreign,
    ie: ie.length >= 2 && ie.length <= 14 ? ie : (c.ie ?? '').trim().toUpperCase() === 'ISENTO' ? 'ISENTO' : '', ie_indicator: c.taxpayer ?? '', email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : '',
    phone: phone.length >= 6 && phone.length <= 14 ? phone : '', postal_code: postal.length === 8 ? postal : '', street: cut(c.street, 60), number: cut(c.number, 60), complement: cut(c.complement, 60),
    district: cut(c.district, 60), city: cut(c.city, 60), state: stateOf(c.state), country: cut(c.country, 60) });
}
const centsText = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2)); };
const moneyDraft = (cents: bigint) => cents === 0n ? '' : `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addDays = (from: string, days: number) => { const date = new Date(`${from}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
/** A contact of the cadastro as the transporta group of the note (Dados da transportadora). */
export function carrierValues(c: { contact_id: string; name: string; document?: string | null; ie?: string | null; state?: string | null; city?: string | null; street?: string | null; number?: string | null; district?: string | null }): Values {
  const document = onlyDigits(c.document), ie = onlyDigits(c.ie), state = stateOf(c.state);
  const address = [cut(c.street, 60), cut(c.number, 20), cut(c.district, 60)].filter(Boolean).join(', ');
  return withValues({ contact_id: c.contact_id, name: cut(c.name, 60), document: document.length === 11 || document.length === 14 ? document : '',
    ie: ie.length >= 2 && ie.length <= 14 ? ie : (c.ie ?? '').trim().toUpperCase() === 'ISENTO' ? 'ISENTO' : '', state: state && state !== 'EX' ? state : '', city: cut(c.city, 60), address: [...address].slice(0, 60).join('') });
}
/**
 * Origin "Gerar nota fiscal": a new note filled from the pedido (destinatário, itens with the cadastro NCM/CEST/GTIN/origem/pesos,
 * descontos, frete, outras despesas, parcelas, Data saída → dhSaiEnt, Pedido de compra → xPed of each item, endereço de entrega,
 * frete por conta, volumes, transportadora e código de rastreio, observações → informações complementares). The natureza is the
 * contact's one when it fits the regime of the note, otherwise the default by person type; "Cálculo automático" computes the taxes.
 */
export function orderDraft(source: OrderSource, config: Pick<ScreenConfig, 'model' | 'direction'>, context: FormContext | null, today: string): InvoiceDraft {
  const draft = newDraft(config, context, today), recipient = orderRecipient(source.contact);
  const code = defaultNatureCode(config.direction, config.model, String(recipient.person_type ?? '')).find(c => context?.defaults[c]);
  const nature = source.nature && source.nature.crt === draft.crt ? source.nature : code ? context!.defaults[code]! : null;
  const po = (source.document.customer_po_number ?? '').trim(), xped = config.direction === '1' && po && [...po].length <= 15 ? po : '';
  // An ordem de serviço gives only its parts (products); with services left out, the OS-wide discount, freight, other expenses and
  // parcels do not fit the note and stay out (the form says so).
  const parts = source.items.filter(i => !isServiceItem(source, i)), partial = parts.length !== source.items.length;
  // The pedido discount is shared by what is left of each line after its own discount, so no item ever passes its value.
  const general = partial ? [] : allocateCents(centsText(source.totals.discount), parts.map(i => centsText(i.gross) - centsText(i.discount)));
  const itemShares = new Map(parts.map((i, index) => [i.position, centsText(i.discount) + (general[index] ?? 0n)]));
  const items: ItemDraft[] = parts.flatMap(i => {
    const item: ItemDraft = { description: cut(i.description, 120), quantity: trimZeros(i.quantity), unit_price: trimZeros(i.unit_price), unit: cut(i.unit, 6) };
    // "Informar desconto individualmente nos itens": the item keeps its own discount plus its share of the pedido discount.
    const own = itemShares.get(i.position) ?? 0n;
    if (context?.item_discount && own > 0n) item.discount = fixed(own, 2);
    if (i.product_id) item.product_id = i.product_id;
    if (cut(i.code, 60)) item.code = cut(i.code, 60);
    withProduct(item, i.product);
    if (xped) item.others = { purchase_order: xped };
    // 202610200254: "Desmembrar produtos ... em uma estrutura na nota fiscal" puts the components in place of the composition.
    const split = splitComposition(i, context?.item_discount ? own : 0n);
    return split.items ? split.items.map(component => xped ? { ...component, others: { purchase_order: xped } } : component) : [item];
  });
  let transport = draft.transport, authorized = draft.authorized_xml;
  const t = source.transport;
  if (config.model === '55' && (t || source.carrier)) {
    const mode = t?.freight_mode === null || !t ? source.carrier ? 'manual' : transport.mode : t.freight_mode === '9' ? 'none' : 'manual';
    const freightBy = mode === 'none' ? '9' : t?.freight_mode ?? (transport.freight_by === '9' ? '0' : transport.freight_by);
    const volumes = { ...transport.volumes }, count = t?.volume_count ?? '';
    if (/^\d{1,15}(\.0+)?$/.test(count) && BigInt(count.split('.')[0]!) > 0n) volumes.quantity = String(BigInt(count.split('.')[0]!));
    if (weightOf(t?.gross_weight)) volumes.gross_weight = weightOf(t?.gross_weight);
    // 202610200215: the Transportador of the cadastro fills the transporta group (CNPJ/CPF, IE, UF, município, endereço); without it the Origin label stays.
    const carrier = mode !== 'manual' ? {} : source.carrier ? carrierValues(source.carrier) : cut(t?.carrier_label, 60) ? { name: cut(t?.carrier_label, 60) } : {};
    transport = { ...transport, mode, freight_by: freightBy, tracking_code: t?.tracking_code && [...t.tracking_code.trim()].length <= 60 ? t.tracking_code.trim() : transport.tracking_code,
      carrier, vehicle: {}, volumes };
    // "Incluir transportadora como pessoa autorizada" (Preferências), like picking the carrier in the form.
    const document = typeof carrier.document === 'string' ? carrier.document : '';
    if (preferencesOf(context).autxml_carrier && document && authorized.length < 10 && !authorized.some(a => a.document === document))
      authorized = [...authorized, { ...(carrier.contact_id ? { contact_id: carrier.contact_id } : {}), name: String(carrier.name), document }];
  }
  if (config.model === '55' && source.delivery) {
    const d = source.delivery, postal = onlyDigits(d.postal_code);
    transport = { ...transport, delivery: withValues({ name: cut(d.name, 60), postal_code: postal.length === 8 ? postal : '', state: stateOf(d.state), city: cut(d.city, 60), street: cut(d.street, 60),
      number: cut(d.number, 60), district: cut(d.district, 60), complement: cut(d.complement, 60), country: cut(d.country, 60) }) };
  }
  const installments: InstallmentDraft[] = (partial ? [] : source.installments).map(i => {
    // "Considerar a data da venda / da ordem de serviço nas parcelas" (Preferências › Configurações de NF-e): on, the parcel keeps the
    // pedido due date; off (Origin default), it keeps the days after the pedido date, counted from the note date.
    const date = source.keep_order_dates || !source.document.date ? i.due_date : addDays(today, daysBetween(source.document.date, i.due_date));
    const days = daysBetween(today, date), method = parcelMethod(i, source.payment?.means ?? null);
    // The method text the note cannot map stays in the parcel observation.
    return { ...withValues({ days: days >= 0 && days <= 9999 ? String(days) : '', date, amount: i.amount, method, note: cut(i.note || (!method ? i.method : ''), 255) }),
      ...(i.payment_method?.id ? { payment_method_id: i.payment_method.id } : {}), card: parcelCard(i) } as InstallmentDraft;
  });
  const info = [cut(source.document.notes, 4000), po && !xped && config.direction === '1' ? `Pedido de compra: ${po}` : ''].filter(Boolean).join('\n');
  // 202610200254: a pedido of a foreign contact opens as Exportação (Tipo de saída), with the export data to fill in the form.
  const exporting = config.model === '55' && config.direction === '1' && (recipient.person_type === 'E' || recipient.state === 'EX');
  return { ...draft, ...(exporting ? { issue_type: 'E' } : {}), recipient, nature_id: nature?.id ?? '', nature_description: nature?.description ?? '', items, transport, authorized_xml: authorized,
    seller_id: source.seller?.id ?? '', seller_name: source.seller?.name ?? '',
    discount: moneyDraft(partial ? parts.reduce((sum, i) => sum + centsText(i.discount), 0n) : centsText(source.totals.line_discount) + centsText(source.totals.discount)),
    freight: partial ? '' : moneyDraft(centsText(source.totals.freight)), other_expenses: partial ? '' : moneyDraft(centsText(source.totals.other_expenses)),
    exit_date: source.document.ship_date ?? '', payment: { condition: '', installments, ...(source.payment?.indicator ? { indicator: source.payment.indicator } : {}) },
    additional_info: [...info].slice(0, 5000).join(''), orders: [source.document.id] };
}
/** NCM, CEST, GTIN, weights, volumes, kind and origem of the cadastro on a note item. */
function withProduct(item: ItemDraft, p: OrderSource['items'][number]['product'] | null) {
  if (!p) return item;
  if (/^\d{8}$/.test(p.ncm ?? '')) item.ncm = p.ncm!;
  if (/^\d{7}$/.test(p.cest ?? '')) item.cest = p.cest!;
  if (/^(SEM GTIN|\d{8}|\d{12,14})$/.test(p.gtin ?? '')) item.gtin = p.gtin!;
  if (/^(SEM GTIN|\d{8}|\d{12,14})$/.test(p.gtin_tax ?? '')) item.gtin_tax = p.gtin_tax!;
  if (weightOf(p.gross_weight)) item.gross_weight = weightOf(p.gross_weight);
  if (weightOf(p.net_weight)) item.net_weight = weightOf(p.net_weight);
  if (/^[1-9]\d{0,5}$/.test(p.volumes ?? '')) item.volumes = p.volumes!;
  if (p.kind === 'S') item.kind = 'S';
  if (/^[0-8]$/.test(p.origin ?? '')) item.icms = { origin: p.origin! };
  return item;
}
// ---- "Desmembrar produtos com tipo de estoque Físico / Virtual em uma estrutura na nota fiscal" (Preferências › Vendas, 202610200254) ----
export type CompositionProblem = 'structure_missing' | 'component_unavailable' | 'quantity_precision' | 'value_split';
export const COMPOSITION_PROBLEMS: Record<CompositionProblem, string> = {
  structure_missing: 'a estrutura do produto está vazia', component_unavailable: 'um componente está inativo, excluído ou não é um produto simples',
  quantity_precision: 'a quantidade de algum componente passaria de 4 casas decimais', value_split: 'o valor do item não se divide exatamente entre os componentes',
};
/**
 * The components of a composition item for the note: quantity = item quantity × quantity in the structure (four decimals, like qCom);
 * the value of the item (and its own discount) is shared by the sale price × quantity of each component (by quantity when no component
 * has a price; truncated cents, the last component takes the remainder), so the note keeps the pedido total. The unit price has ten
 * decimals and is checked against the shared value. Null items when the composition is not split (with the reason).
 */
export function splitComposition(item: OrderSource['items'][number], discountCents: bigint): { items: ItemDraft[] | null; problem: CompositionProblem | null } {
  const c = item.composition ?? null;
  if (!c) return { items: null, problem: null };
  if (c.problem || !c.components.length) return { items: null, problem: c.problem ?? 'structure_missing' };
  const kit = scaledOf(item.quantity, 6)!, gross = centsText(item.gross);
  const quantities = c.components.map(k => kit * scaledOf(k.quantity, 6)!); // scale 12
  if (quantities.some(q => q % 10n ** 8n !== 0n || q === 0n)) return { items: null, problem: 'quantity_precision' };
  const q4 = quantities.map(q => q / 10n ** 8n);
  const priced = c.components.map(k => (k.price === null ? 0n : scaledOf(k.price, 10)!) * scaledOf(k.quantity, 6)!);
  const weights = priced.some(w => w > 0n) ? priced : c.components.map(k => scaledOf(k.quantity, 6)!);
  const shares = allocateCents(gross, weights), discounts = allocateCents(discountCents, shares);
  const out: ItemDraft[] = [];
  for (const [index, k] of c.components.entries()) {
    const qty = fixed(q4[index]!, 4), share = shares[index]!;
    // unit price = share / quantity with ten decimals, nudged by one unit of the last decimal when the rounding of the note line misses.
    let price = (share * 10n ** 12n + q4[index]! / 2n) / q4[index]!;
    for (const step of [0n, 1n, -1n]) if (lineTotalCents(qty, fixed(price + step, 10)) === share) { price += step; break; }
    if (lineTotalCents(qty, fixed(price, 10)) !== share || price < 0n) return { items: null, problem: 'value_split' };
    const part: ItemDraft = { description: cut(k.description, 120), quantity: trimZeros(qty), unit_price: trimZeros(fixed(price, 10)), unit: cut(k.unit || item.unit, 6), product_id: k.product_id };
    if (cut(k.code, 60)) part.code = cut(k.code, 60);
    if (discounts[index]! > 0n) part.discount = fixed(discounts[index]!, 2);
    out.push(withProduct(part, k.product));
  }
  return { items: out, problem: null };
}
/** The compositions of the pedido that stay whole on the note, with the reason (shown by the form). */
export const compositionNotices = (source: OrderSource) => source.items.flatMap(i => { const r = i.composition ? splitComposition(i, 0n) : null;
  return r?.problem ? [`${i.description}: não foi desmembrada porque ${COMPOSITION_PROBLEMS[r.problem]}.`] : []; });
/**
 * tPag of a parcel of the pedido: the Tipo de pagamento of its details, else the forma of the cadastro (99 when the note table lacks
 * it), else the Método de pagamento of the pedido, else the text of the forma; empty when none applies.
 */
export function parcelMethod(i: OrderSource['installments'][number], means: string | null): string {
  const note = (code: string | null | undefined) => code ? NOTE_TPAG.has(code) ? code : '99' : '';
  return note(i.details?.payment_type) || note(i.payment_method?.payment_type) || (means && NOTE_TPAG.has(means) ? means : '') || paymentMethodOf(i.method);
}
/** The card group of the parcel: the Detalhes da parcela of the pedido, completed by the card data of its forma. */
export function parcelCard(i: OrderSource['installments'][number]): Values | null {
  const d = i.details ?? null, m = i.payment_method ?? null, card: Record<string, string> = {};
  const brand = d?.card_brand ?? m?.card_brand, integration = d?.integration_type ?? m?.card_integration, cnpj = d?.acquirer_cnpj ?? m?.card_cnpj;
  if (brand) card.brand = brand;
  if (integration) card.integration = integration;
  if (cnpj && /^\d{14}$/.test(cnpj)) card.cnpj = cnpj;
  if (d?.authorization_code) card.authorization = [...d.authorization_code].slice(0, 128).join('');
  if (d?.received_amount) card.received = d.received_amount;
  if (d?.fee_amount) card.fee = d.fee_amount;
  if (d?.commission_fee_amount) card.commission_fee = d.commission_fee_amount;
  return Object.keys(card).length ? card : null;
}
/**
 * Origin "Gerar nota fiscal agrupando" (ordens de serviço do mesmo cliente): one note with the parts of every OS, the header,
 * destinatário and transport of the first one, the discounts, freight and other expenses of all and every OS as origin (letter O).
 * The parcels are not copied (each OS has its own); "Gerar parcelas" builds them on the note total. Null when the OS do not group.
 */
export function groupedOrderDraft(sources: readonly OrderSource[], config: Pick<ScreenConfig, 'model' | 'direction'>, context: FormContext | null, today: string): { draft: InvoiceDraft; problem: string | null } {
  const first = sources[0]!;
  const drafts = sources.map(source => orderDraft(source, config, context, today));
  const problem = new Set(sources.map(s => s.contact.contact_id)).size > 1 ? 'As ordens de serviço agrupadas precisam ser do mesmo cliente.'
    : new Set(sources.map(s => s.document.kind)).size > 1 ? 'Agrupe documentos do mesmo tipo.'
      : drafts.reduce((sum, d) => sum + d.items.length, 0) > 990 ? 'A nota aceita até 990 itens.' : null;
  const sum = (key: 'discount' | 'freight' | 'other_expenses') => moneyDraft(drafts.reduce((total, d) => total + (d[key] ? centsText(d[key]) : 0n), 0n));
  const numbers = sources.map(s => s.document.number).join(', ');
  const notes = drafts.map(d => d.additional_info).filter(Boolean);
  const label = first.document.kind === 'service_orders' ? 'Ordens de serviço' : 'Pedidos';
  return { problem, draft: { ...drafts[0]!, items: drafts.flatMap(d => d.items), discount: sum('discount'), freight: sum('freight'), other_expenses: sum('other_expenses'),
    payment: { condition: '', installments: [] }, orders: sources.map(s => s.document.id),
    additional_info: [...[`${label}: ${numbers}`, ...notes].join('\n')].slice(0, 5000).join('') } };
}
// ---- "Devolução de produto" (202610200220) ----
export type ReturnSourceItem = { description: string; code?: string | null; product_id?: string | null; quantity: string };
export type ReturnLine = ReturnSourceItem & { returned: string; remaining: string };
const q4 = (value: string | null | undefined) => scaledOf(value, 4) ?? 0n;
/**
 * What is left to return of each item of the note: the quantities the Brufap returns already returned are taken from the items in order,
 * matched by product, else code, else description (four decimals, like qCom).
 */
export function returnLines(items: readonly ReturnSourceItem[], returned: readonly { product_id: string | null; code: string | null; description: string | null; quantity: string }[]): ReturnLine[] {
  const pool = returned.map(r => ({ ...r, left: q4(r.quantity) }));
  return items.map(item => {
    const total = q4(item.quantity); let taken = 0n;
    for (const r of pool) {
      if (taken >= total || r.left <= 0n) continue;
      const same = item.product_id && r.product_id ? item.product_id === r.product_id : (item.code ?? '') && r.code ? item.code === r.code : (r.description ?? '') === item.description;
      if (!same) continue;
      const share = r.left < total - taken ? r.left : total - taken; r.left -= share; taken += share;
    }
    return { ...item, returned: fixed(taken, 4), remaining: fixed(total - taken, 4) };
  });
}
/**
 * The return note with the chosen quantities: items with zero are dropped, the item discount follows its quantity and the note
 * freight, insurance, other expenses and spread discount follow the returned value (truncated cents; the user reviews the draft).
 */
export function withReturnQuantities(draft: InvoiceDraft, quantities: readonly (string | null)[]): InvoiceDraft {
  let before = 0n, after = 0n;
  const items = draft.items.flatMap((item, index) => {
    const original = q4(String(item.quantity ?? '')), next = q4(quantities[index] ?? '0'), price = scaledOf(item.unit_price, 10) ?? 0n;
    before += original * price; after += next * price;
    if (next <= 0n) return [];
    const scaled: ItemDraft = { ...item, quantity: fixed(next, 4) };
    const own = typeof item.discount === 'string' ? scaledOf(item.discount, 2) : null;
    if (own !== null && original > 0n) scaled.discount = fixed(own * next / original, 2);
    return [scaled];
  });
  const share = (value: string) => { const cents = scaledOf(value || '0', 2) ?? 0n; return before > 0n && cents > 0n ? moneyDraft(cents * after / before) : ''; };
  const itemDiscounts = items.some(i => typeof i.discount === 'string' && i.discount !== '');
  return { ...draft, items, freight: share(draft.freight), insurance: share(draft.insurance), other_expenses: share(draft.other_expenses), discount: itemDiscounts ? draft.discount : share(draft.discount) };
}
// ---- "Forma" of the parcels from Cadastros › Formas de pagamento (202610200219) ----
export type PaymentMethodOption = { id: string; description: string; payment_type: string; card_brand: string | null; card_integration: '1' | '2' | null; card_cnpj: string | null };
const NOTE_TPAG = new Set(T.PAYMENT_METHOD.map(([code]) => code));
/** Value of the Forma select: the forma of the cadastro when the parcel has one, otherwise its tPag code. */
export const formaValue = (installment: InstallmentDraft) => typeof installment.payment_method_id === 'string' && installment.payment_method_id ? `pm:${installment.payment_method_id}` : String(installment.method ?? '');
/** Options of the Forma select: the formas of the cadastro first (an inactive one still on the parcel stays listed), then the tPag table. */
export function formaOptions(methods: readonly PaymentMethodOption[], installment?: InstallmentDraft): (readonly [string, string])[] {
  const current = installment && typeof installment.payment_method_id === 'string' && installment.payment_method_id && !methods.some(m => m.id === installment.payment_method_id)
    ? [[`pm:${installment.payment_method_id}`, 'Forma do cadastro (inativa ou fora da lista)'] as const] : [];
  return [...methods.map(m => [`pm:${m.id}`, m.description] as const), ...current, ...T.PAYMENT_METHOD];
}
/**
 * Picks a Forma: a forma of the cadastro sets the parcel tPag (99 - Outros when the note table has no such code) and the card data it
 * carries (bandeira, tipo integração, CNPJ credenciadora); a tPag code clears the forma of the cadastro.
 */
export function withForma(installment: InstallmentDraft, value: string, methods: readonly PaymentMethodOption[]): InstallmentDraft {
  const { payment_method_id: _previous, ...rest } = installment;
  if (!value.startsWith('pm:')) return { ...rest, method: value };
  const method = methods.find(m => m.id === value.slice(3));
  if (!method) return installment;
  const card: Values = { ...(installment.card ?? {}) };
  if (method.card_brand) card.brand = method.card_brand;
  if (method.card_integration) card.integration = method.card_integration;
  if (method.card_cnpj && /^\d{14}$/.test(method.card_cnpj)) card.cnpj = method.card_cnpj;
  return { ...rest, payment_method_id: method.id, method: NOTE_TPAG.has(method.payment_type) ? method.payment_type : '99', card: Object.keys(card).length ? card : null };
}
/** Like picking the natureza by hand: its presence, consumidor final and série follow it (the NFC-e keeps presence 1 or 4). */
export function withNatureSummary(draft: InvoiceDraft, summary: Pick<NatureSummary, 'presence' | 'final_consumer' | 'series'> | null): InvoiceDraft {
  if (!summary) return draft;
  return { ...draft, presence: draft.model === '65' ? (summary.presence === '4' ? '4' : '1') : summary.presence, final_consumer: draft.model === '65' ? true : summary.final_consumer,
    ...(summary.series !== null ? { series: String(summary.series) } : {}) };
}
/** Services of an ordem de serviço belong to the NFS-e (out of scope): the NF-e takes its parts only. */
export const isServiceItem = (source: OrderSource, item: OrderSource['items'][number]) => source.document.kind === 'service_orders' && item.product?.kind === 'S';
/** "Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda" already holds for a note born from that pedido. */
export const orderLocks = (source: OrderSource, prefs: InvoicePreferences) => ({ items: source.document.kind === 'sales_orders' && source.document.stock_active && prefs.block_edit_stock,
  installments: source.document.kind === 'sales_orders' && source.document.finance_active && prefs.block_edit_finance });
/** Origin order of the note, for NUMERO_PEDIDO, before the first save. */
export const orderOrigin = (source: OrderSource) => [{ id: source.document.id, kind: source.document.kind, number: source.document.number, date: source.document.date, contact_name: source.contact.name }];
