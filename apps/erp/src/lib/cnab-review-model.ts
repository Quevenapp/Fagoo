import type { NativeRequestOptions } from './real-access';

export interface CnabReviewController { cnab(path: string, options?: NativeRequestOptions): Promise<unknown>; cnabReview(path: string, options?: NativeRequestOptions): Promise<unknown> }
export type HumanReviewStatus = 'confirmed' | 'pending_issue';
export interface ReviewSafety { purpose: 'homologation'; productionReady: false; canSettle: false; financialMutationPerformed: false; originAuthenticated: false }
export interface ReturnContext {
  version: 1;
  event: { id: string; hash: string; bank: '341' | '077'; wallet: string; control: string; document_number: string; our_number: string | null; occurrence: string; kind: string; due_on: string | null; occurred_on: string; credited_on: string | null; amount_cents: string; paid_cents: string; adjustments: null | Record<'fee' | 'iof' | 'abatement' | 'discount' | 'interest' | 'otherCredits', string>; warnings: string[] };
  occurrence: { file_id: string; file_hash: string; line: number; line_hash: string; duplicate: boolean; generated_on: string; declared_bank_origin: boolean; reference_id: string | null; warnings: string[] };
  profile: { id: string; version: number; bank: string; wallet: string; account_id: string; account_name: string; account_mask: string; account_version: number; account_active: boolean; contract_verified: boolean; policy_verified: boolean };
  billing: null | { id: string; remittance_id: string; remittance_state: 'reserved' | 'ready'; control: string; document_number: string; our_number: string | null };
  title: null | { id: string; version: number; kind: 'receivable' | 'payable'; description: string; issued_on: string; due_on: string; amount_cents: string; settled_cents: string; balance_cents: string; cancelled: boolean };
  proposal: { action: string; reason: string };
  comparison: { source_linked: boolean; reference_matches: boolean | null; bank_number_matches: boolean | null; amount_matches: boolean | null; due_matches: boolean | null; fully_open: boolean | null; paid_matches_balance: boolean | null; has_adjustments: boolean; reason: string };
}
export interface HumanRevision { event_id: string; version: number; status: HumanReviewStatus; reason: string; context_hash: string; context: ReturnContext; reviewed_at: string; context_changed?: boolean }
export interface HumanDetail extends ReviewSafety { event_id: string; context_hash: string; review_version: number; context: ReturnContext; review: HumanRevision | null; bytes_verified: boolean }
export interface HumanEventRow { line: number; event_id: string; event_hash: string; duplicate: boolean; kind: string; control: string; document_number: string; amount_cents: string; paid_cents: string; review_version: number; review_status: 'pending' | HumanReviewStatus; context_changed: boolean }
export interface HumanPage extends ReviewSafety { file_id: string; items: HumanEventRow[]; limit: number; has_more: boolean; next_cursor: number | null }
export interface HumanHistory extends ReviewSafety { event_id: string; items: HumanRevision[]; limit: number; has_more: boolean; next_cursor: number | null }
export interface HumanSaveInput { command_id: string; file_id: string; line: number; expected_review_version: number; expected_context_hash: string; status: HumanReviewStatus; reason: string }
export const HUMAN_REVIEW_LABELS = { pending: 'Pendente', confirmed: 'Conferido para homologação', pending_issue: 'Pendência mantida' };
export const RETURN_KIND_LABELS: Record<string, string> = { REGISTERED: 'Entrada confirmada', REJECTED: 'Entrada rejeitada', PAID: 'Liquidação informada', PARTIAL_PAYMENT: 'Pagamento parcial informado', PARTIAL: 'Pagamento parcial informado', NOTARY_PAYMENT: 'Pagamento em cartório informado', CANCELLED: 'Baixa/cancelamento informado', CLOSED_AFTER_PAYMENT: 'Baixa após pagamento informada', UNKNOWN: 'Ocorrência para conferência' };
export const RETURN_REASON_LABELS: Record<string, string> = {
  DUPLICATE_FILE: 'Arquivo já analisado.', DUPLICATE_EVENT: 'Evento já recebido anteriormente.', BANK_ORIGIN_EVIDENCE_REQUIRED: 'A procedência bancária precisa ser conferida.',
  TITLE_REFERENCE_INCOMPLETE: 'A referência do título está incompleta.', AMBIGUOUS_TITLE_MATCH: 'Mais de um vínculo possível exige conferência.', TITLE_NOT_FOUND: 'Não foi encontrado título com vínculo exato.',
  BANK_NUMBER_MISMATCH: 'O nosso número difere do vínculo salvo.', TITLE_AMOUNT_OR_DUE_DATE_MISMATCH: 'Valor nominal ou vencimento diferente do título.',
  REGISTRATION_MATCH_REQUIRES_REVIEW: 'A entrada informada precisa de conferência.', UNBOUND_BANK_NUMBER: 'O nosso número ainda não possui vínculo confirmado.',
  TITLE_NOT_FULLY_OPEN: 'O título já tem baixa ou cancelamento.', PAYMENT_DATES_MISSING: 'As datas de pagamento/crédito precisam de conferência.',
  PAYMENT_AMOUNTS_REQUIRE_REVIEW: 'Os valores ou ajustes do pagamento precisam de conferência.', TRAILER_AGGREGATE_REQUIRES_REVIEW: 'Os totais do arquivo precisam de conferência.',
  EXACT_MATCH_REQUIRES_HUMAN_REVIEW: 'As referências coincidem; a conferência humana continua necessária.', FINANCIAL_STATE_CHANGED: 'O título financeiro mudou desde a análise.',
  EXACT_LINK_NOT_CONFIRMED: 'O vínculo exato com o título não foi confirmado.', NO_EXACT_LINK: 'Não há vínculo exato com o título.', EXACT_MATCH: 'As referências conferidas coincidem.',
  UNLINKED_EVENT: 'Este evento não possui vínculo exato com um título.', REFERENCE_CHANGED: 'Documento ou controle diferem do vínculo salvo.', BANK_NUMBER_UNBOUND: 'O nosso número ainda não está vinculado; esta conferência não cria o vínculo.',
  BANK_NUMBER_CHANGED: 'O nosso número difere do vínculo salvo.', TITLE_AMOUNT_OR_DUE_DATE_CHANGED: 'O principal ou vencimento do título diferem do arquivo.', NON_PAYMENT_EVENT: 'Esta ocorrência não representa liquidação integral.',
  BANK_ORIGIN_DECLARATION_MISSING: 'A procedência bancária não foi declarada.', REMITTANCE_NOT_READY: 'A remessa vinculada ainda não possui arquivo finalizado.', ACCOUNT_INACTIVE: 'A conta financeira está inativa.',
  EXACT_MATCH_HOMOLOGATION_ONLY: 'As referências coincidem. A revisão permanece restrita à homologação, sem baixa financeira.',
  CREDIT_DATE_MISSING: 'A data de crédito não está informada.', OCCURRENCE_REQUIRES_SEPARATE_REVIEW: 'Esta ocorrência exige conferência específica.',
  BANK_ASSIGNED_NUMBER_NO_DOCUMENTED_LOCAL_DIGIT_ALGORITHM: 'Nosso número atribuído pelo banco; a verificação local não atesta seu dígito.',
  INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION: 'O total de recebimentos do arquivo Inter precisa de confirmação com o banco.',
  INTER_REMITTANCE_COUNT_PRESERVED_NOT_USED_AS_RETURN_COUNT: 'A contagem de remessa informada foi preservada e não foi usada como total de eventos do retorno.',
  INTER_TRAILER_EDITORIAL_INCONSISTENCIES: 'Há inconsistências documentais no rodapé do leiaute Inter que exigem conferência.',
  ITAU_PORTFOLIO_TOTALS_ARE_NOT_FILE_TOTALS: 'Os totais de carteira Itaú não representam necessariamente os totais deste arquivo.',
};
export function returnReason(code: string) { return RETURN_REASON_LABELS[code] || (code.startsWith('BANK_EVENT_') ? `Ocorrência bancária: ${RETURN_KIND_LABELS[code.slice(11)] || code.slice(11)}. Confira o evento original.` : `Conferência necessária (${code}).`); }
export function reviewMoney(value: string) { if (typeof value !== 'string' || !/^(0|[1-9]\d{0,14})$/.test(value)) throw new Error('Valor monetário inválido.'); const n = BigInt(value); return `R$ ${(n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${(n % 100n).toString().padStart(2, '0')}`; }
export const reviewDate = (value: string | null) => value ? value.split('-').reverse().join('/') : 'Não informado';
export const reviewMoment = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const num = (v: unknown, min = 1, max = 2147483647): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const bool = (v: unknown) => typeof v === 'boolean';
const cents = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,14})$/.test(v);
const day = (v: unknown): v is string => typeof v === 'string' && /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const nullable = (v: unknown, check: (v: unknown) => boolean) => v === null || check(v);
const code = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9_]{1,100}$/.test(v);
const warnings = (v: unknown) => Array.isArray(v) && v.length <= 30 && v.every(code);
function need(v: unknown): asserts v { if (!v) throw new Error('Não foi possível conferir a resposta do retorno. Atualize a consulta.'); }
function safety(v: unknown): asserts v is Record<string, unknown> { need(object(v) && v.purpose === 'homologation' && v.productionReady === false && v.canSettle === false && v.financialMutationPerformed === false && v.originAuthenticated === false); }
function context(v: unknown, eventId: string): asserts v is ReturnContext {
  need(object(v) && v.version === 1 && object(v.event) && object(v.occurrence) && object(v.profile) && object(v.proposal) && object(v.comparison));
  const e = v.event, o = v.occurrence, p = v.profile, c = v.comparison;
  need(e.id === eventId && hash(e.hash) && (e.bank === '341' || e.bank === '077') && (e.bank === '341' ? e.wallet === '109' : e.wallet === '110' || e.wallet === '112')
    && text(e.control, 25) && text(e.document_number, 10) && nullable(e.our_number, x => text(x, 20)) && typeof e.occurrence === 'string' && /^\d{2}$/.test(e.occurrence) && code(e.kind)
    && nullable(e.due_on, day) && day(e.occurred_on) && nullable(e.credited_on, day) && cents(e.amount_cents) && cents(e.paid_cents) && warnings(e.warnings));
  const adjustmentKeys = ['fee', 'iof', 'abatement', 'discount', 'interest', 'otherCredits'];
  need(e.adjustments === null || object(e.adjustments) && Object.keys(e.adjustments).length === 6 && adjustmentKeys.every(key => cents((e.adjustments as Record<string, unknown>)[key])));
  need((e.bank === '341') === (e.adjustments !== null) && id(o.file_id) && hash(o.file_hash) && num(o.line, 2, 9999) && hash(o.line_hash) && bool(o.duplicate) && day(o.generated_on)
    && bool(o.declared_bank_origin) && (o.declared_bank_origin ? typeof o.reference_id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(o.reference_id) : o.reference_id === null) && warnings(o.warnings));
  need(id(p.id) && num(p.version) && p.bank === e.bank && p.wallet === e.wallet && id(p.account_id) && text(p.account_name, 200) && /^\*{3}\d{3}$/.test(String(p.account_mask))
    && num(p.account_version) && bool(p.account_active) && bool(p.contract_verified) && bool(p.policy_verified));
  if (v.billing !== null) { need(object(v.billing)); const b = v.billing; need(id(b.id) && id(b.remittance_id) && ['reserved', 'ready'].includes(String(b.remittance_state)) && text(b.control, 25) && text(b.document_number, 10) && nullable(b.our_number, x => text(x, 20))); }
  if (v.title !== null) { need(object(v.title)); const t = v.title; need(id(t.id) && num(t.version) && ['receivable', 'payable'].includes(String(t.kind)) && text(t.description, 240) && day(t.issued_on) && day(t.due_on) && t.due_on >= t.issued_on
    && cents(t.amount_cents) && BigInt(t.amount_cents) > 0n && cents(t.settled_cents) && cents(t.balance_cents) && BigInt(t.amount_cents) === BigInt(t.settled_cents) + BigInt(t.balance_cents) && bool(t.cancelled)); }
  need((v.billing === null) === (v.title === null) && bool(c.source_linked) && c.source_linked === (v.billing !== null) && bool(c.has_adjustments) && code(c.reason)
    && ['REVIEW', 'SKIP', 'PROPOSE_BANK_NUMBER_BINDING_REVIEW', 'PROPOSE_SETTLEMENT_REVIEW'].includes(String(v.proposal.action)) && code(v.proposal.reason));
  need(['reference_matches', 'bank_number_matches', 'amount_matches', 'due_matches', 'fully_open', 'paid_matches_balance'].every(key => c.source_linked ? bool(c[key]) : c[key] === null));
  need(c.has_adjustments === (e.adjustments !== null && Object.values(e.adjustments as Record<string, unknown>).some(x => x !== '0')));
  if (object(v.billing) && object(v.title)) { const b = v.billing, t = v.title; need(c.reference_matches === (b.control === e.control && b.document_number === e.document_number)
    && c.bank_number_matches === (b.our_number !== null && b.our_number === e.our_number) && c.amount_matches === (t.amount_cents === e.amount_cents)
    && c.due_matches === (t.due_on === e.due_on) && c.fully_open === (!t.cancelled && t.settled_cents === '0') && c.paid_matches_balance === (t.balance_cents === e.paid_cents)); }
}
function revision(v: unknown, eventId: string): asserts v is HumanRevision {
  need(object(v) && v.event_id === eventId && num(v.version) && ['confirmed', 'pending_issue'].includes(String(v.status)) && text(v.reason, 1000) && v.reason.trim().length >= 3 && hash(v.context_hash) && text(v.reviewed_at, 100) && Number.isFinite(Date.parse(v.reviewed_at)));
  context(v.context, eventId);
}
export function humanDetail(v: unknown, eventId: string, fileId: string, line: number, verified = false): HumanDetail {
  safety(v); need(id(eventId) && id(fileId) && v.event_id === eventId && hash(v.context_hash) && num(v.review_version, 0) && v.bytes_verified === verified);
  context(v.context, eventId); need(v.context.occurrence.file_id === fileId && v.context.occurrence.line === line);
  if (v.review !== null) { revision(v.review, eventId); need(v.review.version === v.review_version && v.review.context_changed === (v.review.context_hash !== v.context_hash)); } else need(v.review_version === 0);
  return v as unknown as HumanDetail;
}
export function humanPage(v: unknown, fileId: string, after = 1): HumanPage {
  safety(v); need(v.file_id === fileId && id(fileId) && v.limit === 25 && Array.isArray(v.items) && v.items.length <= 25 && bool(v.has_more));
  let previous = after;
  for (const row of v.items) { need(object(row) && num(row.line, 2, 9999) && row.line > previous && id(row.event_id) && hash(row.event_hash) && bool(row.duplicate) && code(row.kind) && text(row.control, 25) && text(row.document_number, 10)
    && cents(row.amount_cents) && cents(row.paid_cents) && num(row.review_version, 0) && (row.review_version === 0 ? row.review_status === 'pending' : ['confirmed', 'pending_issue'].includes(String(row.review_status))) && bool(row.context_changed) && (row.review_version !== 0 || row.context_changed === false)); previous = row.line; }
  need(v.has_more ? v.items.length === 25 && v.next_cursor === previous : v.next_cursor === null); return v as unknown as HumanPage;
}
export function humanHistory(v: unknown, eventId: string, before: number | null = null): HumanHistory {
  safety(v); need(v.event_id === eventId && id(eventId) && v.limit === 25 && Array.isArray(v.items) && v.items.length <= 25 && bool(v.has_more));
  let previous = before ?? 2147483648;
  for (const row of v.items) { revision(row, eventId); need(row.version < previous && row.context_changed === undefined); previous = row.version; }
  need(v.has_more ? v.items.length === 25 && v.next_cursor === previous : v.next_cursor === null); return v as unknown as HumanHistory;
}
export function humanReviewInput(preview: HumanDetail | null, status: string, reason: string, confirmed: boolean, commandId: string): HumanSaveInput {
  if (!preview || !preview.bytes_verified) throw new Error('Confira o arquivo original antes de registrar a revisão.');
  humanDetail(preview, preview.event_id, preview.context.occurrence.file_id, preview.context.occurrence.line, true);
  if (!confirmed) throw new Error('Confirme a leitura do contexto e a ausência de baixa financeira.');
  if (!['confirmed', 'pending_issue'].includes(status)) throw new Error('Selecione a decisão de conferência.');
  const clean = reason.trim(); if (!text(clean, 1000) || clean.length < 3) throw new Error('Informe um motivo de 3 a 1.000 caracteres, sem quebras de linha.');
  if (!id(commandId) || preview.review_version >= 2147483647) throw new Error('Não foi possível preparar esta revisão. Recarregue a consulta.');
  return { command_id: commandId, file_id: preview.context.occurrence.file_id, line: preview.context.occurrence.line, expected_review_version: preview.review_version, expected_context_hash: preview.context_hash, status: status as HumanReviewStatus, reason: clean };
}
export function humanSaveResult(v: unknown, eventId: string, input: HumanSaveInput) {
  safety(v); need(v.event_id === eventId && bool(v.replayed)); revision(v.record, eventId);
  need(v.record.version === input.expected_review_version + 1 && v.record.status === input.status && v.record.reason === input.reason && v.record.context_hash === input.expected_context_hash
    && v.record.context.occurrence.file_id === input.file_id && v.record.context.occurrence.line === input.line);
  return v as unknown as ReviewSafety & { event_id: string; record: HumanRevision; replayed: boolean };
}
