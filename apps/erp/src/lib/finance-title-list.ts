// Contas a receber e a pagar no padrão Origin: rótulos, chips, menu ⋮ da linha, origem e lotes executados título a título.
// Os lotes usam somente as ações individuais existentes (title_update, settle, title_cancel), cada uma com seu command_id e versão.
import { planBatch, type BatchItem, type BatchPlan } from './origin-batch.ts';
import { financeMoney, type FinanceCategory, type FinanceKind, type FinanceTitle, type FinanceTitleOrigin } from './real-finance-model.ts';
import { overdueDays } from './finance-title-drawer.ts';
import { PAYMENT_TYPES } from './payment-method-model.ts';
import { FINANCE_TITLE_OPTIONS, FINANCE_TITLE_STATUSES, routeCategories, routeStatuses, type FinanceDateField, type FinanceListRoute, type FinanceTitleOption, type FinanceTitleStatus } from './finance-list-route.ts';

/** Origin "Opção" (single choice at the top of Filtrar). */
export function titleOptionLabel(option: FinanceTitleOption, kind: FinanceKind): string {
  return { open: 'Em aberto', overdue: 'Atrasadas', issued: 'Emitidas', settled: kind === 'receivable' ? 'Recebidas' : 'Pagas' }[option];
}
export const titleOptions = (kind: FinanceKind) => FINANCE_TITLE_OPTIONS.map(value => ({ value, label: titleOptionLabel(value, kind) }));
/** Origin "Situação" of Emitidas (SQL 281: Devolvido is the conta a devolução cancelled and marked). */
export function titleStatusLabel(status: FinanceTitleStatus, kind: FinanceKind): string {
  return { cancelled: 'Cancelada', returned: 'Devolvido', open: 'Em aberto', partial: kind === 'receivable' ? 'Parcialmente Recebida' : 'Parcialmente Paga', paid: kind === 'receivable' ? 'Recebida' : 'Paga' }[status];
}
export const titleStatusOptions = (kind: FinanceKind) => FINANCE_TITLE_STATUSES.map(value => ({ value, label: titleStatusLabel(value, kind) }));
/** "Filtrar por" of Origin (only in Emitidas). */
export function dateFieldLabel(field: FinanceDateField, kind: FinanceKind): string {
  return field === 'issued' ? 'Data de Emissão' : field === 'settled' ? kind === 'receivable' ? 'Data de Recebimento' : 'Data de Pagamento' : field === 'competence' ? 'Data de Competência' : 'Data de Vencimento';
}
export const dateFieldShort = (field: FinanceDateField, kind: FinanceKind) => dateFieldLabel(field, kind).replace('Data de ', '');
/** Same order as Origin's "Filtrar por": Emissão, Vencimento, Recebimento/Pagamento, Competência. */
export const dateFieldOptions = (kind: FinanceKind) => (['issued', 'due', 'settled', 'competence'] as const).map(value => ({ value, label: dateFieldLabel(value, kind) }));
export function dateFieldFromLabel(label: string | undefined, kind: FinanceKind): FinanceDateField {
  return dateFieldOptions(kind).find(option => option.label === label)?.value ?? 'due';
}
export const titleSearchPlaceholder = (kind: FinanceKind) => kind === 'receivable' ? 'Pesquise por nome, e-mail, CPF/CNPJ, número ou histórico' : 'Pesquise por nome, e-mail, CPF/CNPJ ou histórico';
/** Origin's selector at the top of the list. */
export const ACCOUNT_ALL = 'Todas as contas financeiras', ACCOUNT_NONE = 'Sem conta financeira';
/** Filter-panel fields for the Opção being chosen (Origin changes them before applying). */
export function panelFields(option: FinanceTitleOption, kind: FinanceKind) {
  return { date: option === 'issued', status: option === 'issued', remittance: kind === 'receivable' && option === 'open', document: kind === 'payable', seller: kind === 'receivable' };
}
/** Panel actions for the Opção being chosen: Recebidas/Pagas cannot be cancelled. */
export function panelActions(option: FinanceTitleOption): TitleBatchAction[] {
  return option === 'settled' ? ['settle', 'category'] : ['settle', 'category', 'cancel'];
}

export type TitleChipKey = 'q' | 'option' | 'status' | 'date' | 'account' | 'category' | 'remittance' | 'value' | 'doc' | 'payment_type' | 'payment_method' | 'seller';
/** Origin "Tipo de pagamento": the SEFAZ tPag list of the formas de pagamento (Cadastros > Formas de pagamento), in its order. */
export const TITLE_PAYMENT_TYPES: readonly { value: string; label: string }[] = PAYMENT_TYPES.map(([value, label]) => ({ value, label }));
export const paymentTypeLabel = (value: string) => TITLE_PAYMENT_TYPES.find(option => option.value === value)?.label ?? value;
/** Icon of the Forma de pagamento column (Origin shows the bank logo; the Brufap shows the kind of the tPag). */
export const paymentTypeIcon = (value: string | null | undefined) => ['03', '04', '05'].includes(value ?? '') ? 'credit-card' : value === '15' ? 'barcode' : ['17', '20'].includes(value ?? '') ? 'qrcode' : ['16', '18'].includes(value ?? '') ? 'building-columns' : 'receipt';
/** Applied filter chips; the period itself is shown and cleared by the period chip. */
export function titleChips(route: FinanceListRoute, kind: FinanceKind, names: { account?: string | null; categories?: ReadonlyMap<string, string>; paymentMethod?: string | null; seller?: string | null } = {}): { key: TitleChipKey; label: string }[] {
  const chips: { key: TitleChipKey; label: string }[] = [];
  if (route.q) chips.push({ key: 'q', label: `Pesquisa: ${route.q}` });
  if (route.option !== 'open') chips.push({ key: 'option', label: `Opção: ${titleOptionLabel(route.option, kind)}` });
  const statuses = routeStatuses(route);
  if (statuses.length) chips.push({ key: 'status', label: `Situação: ${statuses.map(value => titleStatusLabel(value, kind)).join(', ')}` });
  if (route.option === 'issued' && route.date !== 'due') chips.push({ key: 'date', label: `Filtrar por: ${dateFieldLabel(route.date, kind)}` });
  if (route.account) chips.push({ key: 'account', label: `Conta financeira: ${route.account === 'none' ? ACCOUNT_NONE : names.account || 'selecionada'}` });
  const categories = routeCategories(route);
  if (categories.length) chips.push({ key: 'category', label: `Categoria: ${categories.map(value => value === 'none' ? 'Sem categoria' : names.categories?.get(value) || 'selecionada').join(', ')}` });
  if (route.remittance) chips.push({ key: 'remittance', label: `Em remessa: ${route.remittance === 'yes' ? 'Incluídas em remessa' : 'Não incluídas em remessa'}` });
  if (route.value) chips.push({ key: 'value', label: `Valor: ${financeMoney(route.value)}` });
  if (route.doc) chips.push({ key: 'doc', label: `N° documento: ${route.doc}` });
  if (route.paymentType) chips.push({ key: 'payment_type', label: `Tipo de pagamento: ${paymentTypeLabel(route.paymentType)}` });
  if (route.paymentMethod) chips.push({ key: 'payment_method', label: `Forma de pagamento: ${names.paymentMethod || 'selecionada'}` });
  if (route.seller) chips.push({ key: 'seller', label: `Vendedor: ${names.seller || 'selecionado'}` });
  return chips;
}

/** Columns of the Origin list. The padrão view is fixed; the customizada one adds the optional columns chosen by the user. */
export type TitleColumn = 'history' | 'payment_method' | 'account' | 'category' | 'identification' | 'document' | 'due' | 'competence' | 'issued' | 'settled_on' | 'fee' | 'net' | 'interest' | 'additions' | 'discounts' | 'installment' | 'balance';
export const TITLE_COLUMNS: readonly { id: TitleColumn; label: string; receivableOnly?: boolean; info?: string }[] = [
  { id: 'history', label: 'Histórico' }, { id: 'payment_method', label: 'Forma de pagamento' }, { id: 'account', label: 'Conta financeira' }, { id: 'category', label: 'Categoria' },
  { id: 'identification', label: 'Número de identificação' }, { id: 'document', label: 'Número do documento' }, { id: 'due', label: 'Vencimento' },
  { id: 'competence', label: 'Competência' }, { id: 'issued', label: 'Emissão' }, { id: 'settled_on', label: 'Liquidação' }, { id: 'fee', label: 'Valor taxa', receivableOnly: true },
  { id: 'net', label: 'Líquido', receivableOnly: true, info: 'Valor líquido da conta quando há taxas configuradas na forma de pagamento (ou descontadas as tarifas registradas nas baixas)' }, { id: 'interest', label: 'Juros' }, { id: 'additions', label: 'Acréscimos' }, { id: 'discounts', label: 'Descontos' },
  { id: 'installment', label: 'Parcela' }, { id: 'balance', label: 'Saldo' },
];
export const DEFAULT_CUSTOM_COLUMNS: readonly TitleColumn[] = ['history', 'due'];
export const titleColumnOptions = (kind: FinanceKind) => TITLE_COLUMNS.filter(column => kind === 'receivable' || !column.receivableOnly);
/** Padrão columns between the contato and the Valor: Recebidas add Liquidação and Valor taxa, Pagas add Liquidação. */
export function standardColumns(kind: FinanceKind, option: FinanceTitleOption): TitleColumn[] {
  const base: TitleColumn[] = kind === 'payable' ? ['history', 'identification', 'document', 'due'] : ['history', 'payment_method', 'due'];
  return option === 'settled' ? [...base, 'settled_on', ...(kind === 'receivable' ? ['fee' as const] : [])] : base;
}
/** The optional columns chosen, in the order chosen in Informações visíveis; unknown or other-kind columns are dropped. */
export function customColumns(kind: FinanceKind, chosen: readonly string[]): TitleColumn[] {
  const allowed = new Set<string>(titleColumnOptions(kind).map(column => column.id));
  return [...new Set(chosen)].filter((column): column is TitleColumn => allowed.has(column));
}
/** Nº de identificação: the nosso número of the Brufap boleto or the nº no banco informed in the conta. */
export const titleIdentification = (row: { remittance?: { our_number: string | null } | null; bank_number?: string | null }) => row.remittance?.our_number || row.bank_number || '';
/** Valor líquido: valor minus the tarifas of the effective baixas or, before any tarifa, the taxa of the forma de pagamento (SQL 175). */
export const titleNet = (row: { amount_cents: string; payments?: { fee_cents: string }; payment_fee_cents?: string | null }) => { const fee = BigInt(row.payments?.fee_cents ?? '0'); return (BigInt(row.amount_cents) - (fee > 0n ? fee : BigInt(row.payment_fee_cents ?? '0'))).toString(); };

const ORIGIN_TEXT = {
  sales_orders: { field: 'Pedido de origem', menu: 'Abrir pedido de origem', reference: 'Ref. ao pedido de venda nº' },
  service_orders: { field: 'Ordem de serviço de origem', menu: 'Abrir ordem de serviço de origem', reference: 'Ref. à ordem de serviço nº' },
  purchase_orders: { field: 'Pedido de compra de origem', menu: 'Abrir pedido de compra de origem', reference: 'Ref. ao pedido de compra nº' },
  // SQL 247: contas lançadas pela nota fiscal (Origin "Nota fiscal de origem: #nº").
  fiscal_invoices: { field: 'Nota fiscal de origem', menu: 'Abrir nota fiscal de origem', reference: 'Ref. à nota fiscal nº' },
} as const;
export const originText = (origin: FinanceTitleOrigin) => ORIGIN_TEXT[origin.kind];
/** "#000123" of the origin; an own note not sent yet has no number. */
export const originNumber = (origin: FinanceTitleOrigin) => origin.number === null ? '(sem número)' : `#${origin.number}`;

/** Origin situation badge: Atrasada (with "Atrasada por N dias"), Vence hoje, Recebida/Paga, Parcialmente recebida/paga, Em aberto, Cancelada. */
export function titleSituation(title: Pick<FinanceTitle, 'kind' | 'status' | 'overdue' | 'due_on' | 'cancelled' | 'deleted_at' | 'returned'>, today: string): { label: string; hint?: string } {
  const receivable = title.kind === 'receivable';
  if (title.deleted_at) return { label: 'Excluída' };
  if (title.returned) return { label: 'Devolvido', hint: 'Conta cancelada pela devolução da venda' };
  if (title.cancelled || title.status === 'cancelled') return { label: 'Cancelada' };
  if (title.status === 'paid') return { label: receivable ? 'Recebida' : 'Paga' };
  if (title.overdue) { const days = overdueDays(title.due_on, today); return { label: 'Atrasada', hint: days > 0 ? `Atrasada por ${days} ${days === 1 ? 'dia' : 'dias'}` : 'Atrasada' }; }
  if (title.due_on === today) return { label: 'Vence hoje', hint: 'Vence hoje' };
  if (title.status === 'partial') return { label: receivable ? 'Parcialmente recebida' : 'Parcialmente paga' };
  return { label: 'Em aberto' };
}
/** Deep link of the documents screen (RealDocuments reads tipo + documento). */
export function originPath(origin: FinanceTitleOrigin): string {
  if (origin.kind === 'fiscal_invoices') {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(origin.invoice_id)) throw new Error('Confira a nota fiscal de origem.');
    // Notas de entrada, NF-e and NFC-e de saída (the lists of the notas lane, ?nota=<id> opens the note).
    return origin.direction === '0' ? `/notas-entrada?${new URLSearchParams({ nota: origin.invoice_id })}` : `/historico-fiscal?${new URLSearchParams({ modelo: origin.model, nota: origin.invoice_id })}`;
  }
  if (!ORIGIN_TEXT[origin.kind] || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(origin.document_id)) throw new Error('Confira o documento de origem.');
  return `/documentos-empresa?${new URLSearchParams({ tipo: origin.kind, documento: origin.document_id })}`;
}

export type TitleRowAction = 'edit' | 'settle' | 'settle_partial' | 'reverse' | 'cancel' | 'clone' | 'delete';
/** Row ⋮: only the per-title operations that exist in the Brufap, with Origin's labels and order. */
/** Why the 108 SQL refuses to exclude a conta of the list (null when it may be excluded). */
export function deleteBlocked(title: FinanceTitle & { imported?: boolean; remittance?: unknown }): string | null {
  return title.deleted_at ? 'Conta já excluída.' : title.settled_cents !== '0' ? 'Possui baixa registrada. Estorne a baixa antes de excluir.'
    : title.document_linked ? 'Conta gerada por um documento. Desfaça o lançamento no documento de origem.'
    : title.grouped_billing_id ? 'Conta de um faturamento agrupado. Exclua o faturamento em Listar Faturamentos Gerados.'
    : title.imported ? 'Conta importada do Origin. Exclua a conta no Origin.' : title.remittance ? 'Conta incluída em remessa de cobrança.' : null;
}
/** allowed: Sistema > Usuários > Permissões (SQL 246) by Origin key suffix: ie (Editar, Clonar), baixar, cancelar and ex (Excluir). */
export function titleRowActions(title: FinanceTitle & { imported?: boolean; remittance?: unknown }, writable: boolean, allowed: (action: 'ie' | 'ex' | 'cancelar' | 'baixar') => boolean = () => true): { action: TitleRowAction; label: string; icon: string }[] {
  if (!writable || title.deleted_at) return [];
  const keep = (action: TitleRowAction) => allowed(action === 'edit' || action === 'clone' ? 'ie' : action === 'delete' ? 'ex' : action === 'cancel' ? 'cancelar' : 'baixar');
  const received = title.kind === 'receivable', actions: { action: TitleRowAction; label: string; icon: string }[] = [];
  if (!title.cancelled) {
    actions.push({ action: 'edit', label: 'Editar', icon: 'pen-to-square' });
    if (BigInt(title.balance_cents) > 0n) actions.push({ action: 'settle', label: received ? 'Baixa total do recebimento' : 'Baixa total do pagamento', icon: 'check' }, { action: 'settle_partial', label: received ? 'Baixa parcial do recebimento' : 'Baixa parcial do pagamento', icon: 'circle-half-stroke' });
    if (title.settled_cents !== '0') actions.push({ action: 'reverse', label: 'Estornar baixa', icon: 'rotate-left' });
    else actions.push({ action: 'cancel', label: received ? 'Cancelar conta a receber' : 'Cancelar', icon: 'ban' });
  }
  actions.push({ action: 'clone', label: 'Clonar', icon: 'clone' });
  // Exclusão lógica (108): only without an active baixa, document of origin, Origin import or boleto, as the server enforces.
  if (!deleteBlocked(title)) actions.push({ action: 'delete', label: 'Excluir', icon: 'trash-can' });
  return actions.filter(entry => keep(entry.action));
}
/** Permission suffix of each panel action (Baixar selecionados, Alterar categorias, Cancelar selecionadas, Excluir selecionados). */
export const BATCH_PERMISSION: Readonly<Record<TitleBatchAction, 'baixar' | 'ie' | 'cancelar' | 'ex'>> = { settle: 'baixar', category: 'ie', cancel: 'cancelar', delete: 'ex' };
/** Whether a freshly read title still allows the editor the user asked for. */
export function titleAllows(title: FinanceTitle, mode: string): boolean {
  if (title.cancelled) return false;
  if (mode === 'settle') return BigInt(title.balance_cents) > 0n;
  if (mode === 'title_cancel') return title.settled_cents === '0';
  return mode === 'title_update';
}

// ---- Batch actions (Origin right panel): preview, then one existing single-title command per item ----
export type TitleBatchAction = 'settle' | 'category' | 'cancel' | 'delete';
export type TitleBatchItem = BatchItem & { title: FinanceTitle };
export const TITLE_BATCH_LABEL: Readonly<Record<TitleBatchAction, string>> = { settle: 'Baixar selecionados', category: 'Alterar categorias', cancel: 'Cancelar selecionadas', delete: 'Excluir selecionados' };
export const titleBatchItemLabel = (title: FinanceTitle) => `${title.contact_name} · ${title.description} · ${title.installment}/${title.installments} · ${financeMoney(title.balance_cents)}`;
export function planTitleBatch(action: TitleBatchAction, titles: readonly FinanceTitle[], params: { categoryId?: string; postedOn?: string }): BatchPlan<TitleBatchItem> {
  const items = titles.map(title => ({ id: title.id, label: titleBatchItemLabel(title), title }));
  return planBatch(items, ({ title }) => {
    if (action === 'delete') return deleteBlocked(title);
    if (title.cancelled) return 'Conta cancelada.';
    if (action === 'category') return title.category_id === params.categoryId ? 'Já está nesta categoria.' : null;
    if (action === 'settle') return BigInt(title.balance_cents) <= 0n ? 'Sem saldo em aberto.' : params.postedOn && title.issued_on > params.postedOn ? 'Emissão posterior à data da baixa.' : null;
    return title.settled_cents !== '0' ? 'Possui baixa registrada. Estorne a baixa antes de cancelar.' : null;
  });
}
/** Sum of the open balances that "Baixar selecionados" would settle, in exact cents. */
export const batchBalance = (plan: BatchPlan<TitleBatchItem>) => plan.eligible.reduce((sum, item) => sum + BigInt(item.title.balance_cents), 0n).toString();
/** Body of the existing single-title command; the title version is the one the user saw in the list. */
export function titleBatchCommand(action: TitleBatchAction, title: FinanceTitle, params: { categoryId?: string; accountId?: string; postedOn?: string; note?: string }): { action: 'title_update' | 'settle' | 'title_cancel' | 'title_delete'; data: Record<string, unknown> } {
  if (action === 'delete') return { action: 'title_delete', data: { id: title.id, expected_version: title.version } };
  if (action === 'category') { if (!params.categoryId) throw new Error('Selecione a categoria.'); return { action: 'title_update', data: { id: title.id, expected_version: title.version, category_id: params.categoryId } }; }
  if (action === 'settle') {
    if (!params.accountId || !params.postedOn) throw new Error('Selecione a conta financeira e a data da baixa.');
    return { action: 'settle', data: { id: title.id, expected_version: title.version, account_id: params.accountId, posted_on: params.postedOn, principal_cents: title.balance_cents, interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', note: params.note?.trim() || null } };
  }
  if (!params.note?.trim()) throw new Error('Informe o motivo do cancelamento.');
  return { action: 'title_cancel', data: { id: title.id, expected_version: title.version, note: params.note.trim() } };
}

/** "Salvar e dar baixa": the saved title the baixa opens for, read from the confirmed command result. */
export function savedTitleId(result: unknown, action: string, kind: FinanceKind, titleId?: string): string | null {
  const value = result as { record?: { id?: unknown; kind?: unknown }; items?: { id?: unknown; kind?: unknown; installments?: unknown }[] } | null;
  const uuid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
  if (action === 'title_create_group' || action === 'title_create') { const item = Array.isArray(value?.items) && value!.items.length === 1 ? value!.items[0] : null; return item && uuid(item.id) && item.kind === kind && item.installments === 1 ? item.id : null; }
  if (action === 'title_update' || action === 'title_edit') return value?.record && value.record.id === titleId && uuid(titleId) ? titleId : null;
  return null;
}

/** One page (limit 100) of the 010 category list, for the "Categoria" filter options. */
export function categoryOptionsPage(value: unknown, after: string | null): { items: FinanceCategory[]; has_more: boolean; next_cursor: string | null } {
  const uuid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
  const page = value as { entity?: unknown; data_mode?: unknown; limit?: unknown; items?: unknown; has_more?: unknown; next_cursor?: unknown } | null;
  if (!page || typeof page !== 'object' || page.entity !== 'categories' || page.data_mode !== 'erp_native' || page.limit !== 100 || !Array.isArray(page.items) || page.items.length > 100
    || typeof page.has_more !== 'boolean' || (page.has_more ? !uuid(page.next_cursor) || page.items.length !== 100 : page.next_cursor !== null)) throw new Error('Não foi possível carregar as categorias.');
  let previous = after ?? '';
  for (const item of page.items as Record<string, unknown>[]) {
    if (!item || !uuid(item.id) || item.id <= previous || typeof item.name !== 'string' || !['receivable', 'payable', 'both'].includes(String(item.kind)) || typeof item.active !== 'boolean') throw new Error('Não foi possível carregar as categorias.');
    previous = item.id;
  }
  return { items: page.items as FinanceCategory[], has_more: page.has_more, next_cursor: page.next_cursor as string | null };
}

/** "Enviar por whatsapp" (Origin, contas com boleto): wa.me link with the celular of the contato, without any API. */
export function whatsappUrl(phone: unknown, message: string): string | null {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, ''), full = /^\d{10,11}$/.test(digits) ? `55${digits}` : /^55\d{10,11}$/.test(digits) ? digits : null;
  return full ? `https://wa.me/${full}?${new URLSearchParams({ text: message })}` : null;
}
export function whatsappMessage(title: Pick<FinanceTitle, 'contact_name' | 'description' | 'balance_cents' | 'due_on'> & { remittance?: { our_number: string | null } | null }): string {
  // Leva H (FIN-044): the message names the existing cobrança (nosso número of the remessa) when there is one.
  const charge = title.remittance?.our_number ? ` Boleto nosso número ${title.remittance.our_number}.` : '';
  return `Olá, ${title.contact_name}! Lembrete da conta "${title.description}" no valor de ${financeMoney(title.balance_cents)}, com vencimento em ${title.due_on.split('-').reverse().join('/')}.${charge}`;
}
/** Leva H (FIN-044): a cobrança that may be shared by hand: a boleto whose remessa file was generated (not only reserved), on an open conta. */
export function shareableCharge(title: Pick<FinanceTitle, 'kind' | 'cancelled' | 'balance_cents' | 'deleted_at'> & { remittance?: { state: 'reserved' | 'ready'; our_number: string | null } | null }): boolean {
  return title.kind === 'receivable' && !title.cancelled && !title.deleted_at && BigInt(title.balance_cents) > 0n && title.remittance?.state === 'ready' && Boolean(title.remittance.our_number);
}
/** Leva H (FIN-176): the remessa shared by every selected conta (null when none or more than one). */
export function sameRemittance<T extends { remittance: { id: string; sequence: number; state: 'reserved' | 'ready' } | null }>(rows: readonly T[]) {
  const first = rows[0]?.remittance;
  return first && rows.every(row => row.remittance?.id === first.id) ? first : null;
}
/** Bank operations stay off (CNAB guards): the reason shown on the boleto actions that would send an instruction to the bank. */
export const BANK_OFF_REASON = 'Operação bancária desligada: o FAGOO não envia instruções ao banco. Faça pelo Origin ou pelo banco.';
/**
 * Leva H (FIN-052): the boleto entries of the ⋮ of a conta a receber by its real situation: without boleto, Incluir em remessa (open,
 * no baixa); with a reserved remessa, Retomar remessa; with the file, Prévia do boleto (NÃO PAGAR). Cancelar boleto and Retirar da
 * remessa are shown disabled with the reason while bank operations stay off.
 */
export function boletoMenu(title: Pick<FinanceTitle, 'id' | 'kind' | 'cancelled' | 'settled_cents' | 'balance_cents' | 'deleted_at'> & { imported?: boolean; remittance?: { id: string; state: 'reserved' | 'ready' } | null }, canRemit: boolean) {
  if (title.kind !== 'receivable' || title.deleted_at || title.cancelled) return [];
  const r = title.remittance;
  if (r?.state === 'reserved' && !canRemit) return [];
  if (!r) return canRemit && title.settled_cents === '0' && !title.imported && BigInt(title.balance_cents) > 0n
    ? [{ label: 'Incluir em remessa', icon: 'file-export', to: `/cobranca-operacional?${new URLSearchParams({ titulos: title.id })}` }] : [];
  return [r.state === 'reserved' ? { label: 'Retomar remessa', icon: 'file-export', to: `/cobranca-operacional?${new URLSearchParams({ remessa: r.id })}` }
    : { label: 'Prévia do boleto (NÃO PAGAR)', icon: 'barcode', to: `/cobranca-operacional?${new URLSearchParams({ remessa: r.id })}` },
    { label: 'Cancelar boleto', icon: 'ban', disabled: true, title: BANK_OFF_REASON }, { label: 'Retirar da remessa', icon: 'xmark', disabled: true, title: BANK_OFF_REASON }];
}
