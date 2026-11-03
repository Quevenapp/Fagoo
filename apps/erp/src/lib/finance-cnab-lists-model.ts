// Remessas e Retornos (CNAB) no padrão Origin (SQL 213): rotas das telas, caminhos da API e leitura conferida das respostas.
import { validFinanceDate } from './real-finance-model.ts';

export type CnabListKind = 'remessas' | 'retornos';
export type CnabListRoute = { q: string; from: string; to: string; page: number; id: string | null; group: ReturnGroup };
export type ReturnGroup = 'entradas' | 'baixas' | 'outras';
export const CNAB_LIST_PAGE = 50;
export const RETURN_GROUP_PAGE = 100;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (): never => { throw new Error('Confira os filtros da listagem.'); };
const DETAIL_KEY: Record<CnabListKind, string> = { remessas: 'remessa', retornos: 'retorno' };

/** ?area=remessas|retornos[&q=][&de=&ate=][&page=][&remessa=|&retorno=<id>[&grupo=][&page=]] */
export function cnabListRoute(kind: CnabListKind, params: URLSearchParams): CnabListRoute {
  const detail = DETAIL_KEY[kind];
  for (const key of params.keys()) if (!['area', 'q', 'de', 'ate', 'page', detail, ...(kind === 'retornos' ? ['grupo'] : [])].includes(key) || params.getAll(key).length !== 1) fail();
  const q = (params.get('q') ?? '').trim(), from = params.get('de') ?? '', to = params.get('ate') ?? '', page = params.get('page') ?? '1', id = params.get(detail), group = (params.get('grupo') ?? 'baixas') as ReturnGroup;
  if (q.length > 120 || /[\x00-\x1f\x7f]/.test(q) || !/^[1-9]\d{0,5}$/.test(page) || (id !== null && !UUID.test(id)) || !['entradas', 'baixas', 'outras'].includes(group) || (params.has('grupo') && id === null)) fail();
  try { if (from) validFinanceDate(from); if (to) validFinanceDate(to); } catch { fail(); }
  if (from && to && from > to) fail();
  return { q, from, to, page: Number(page), id, group };
}
export function cnabListParams(kind: CnabListKind, route: CnabListRoute): URLSearchParams {
  const params = new URLSearchParams({ area: kind });
  if (route.q) params.set('q', route.q);
  if (route.from) params.set('de', route.from);
  if (route.to) params.set('ate', route.to);
  if (route.id) { params.set(DETAIL_KEY[kind], route.id); if (kind === 'retornos' && route.group !== 'baixas') params.set('grupo', route.group); }
  if (route.page > 1) params.set('page', String(route.page));
  cnabListRoute(kind, params); return params;
}
export function cnabListApiPath(kind: CnabListKind, route: CnabListRoute): string {
  if (route.id) {
    if (kind === 'remessas') return `/v1/financeiro/remessas/${route.id}`;
    const params = new URLSearchParams({ grupo: route.group }); if (route.page > 1) params.set('page', String(route.page));
    return `/v1/financeiro/retornos/${route.id}?${params}`;
  }
  const params = new URLSearchParams({ page: String(route.page), limit: String(CNAB_LIST_PAGE) });
  if (route.q) params.set('q', route.q); if (route.from) params.set('from', route.from); if (route.to) params.set('to', route.to);
  return `/v1/financeiro/${kind}?${params}`;
}
/** "Acessar remessa" of the contas a receber: the detail of the remessa of the conta. */
export const remittancePath = (id: string) => { if (!UUID.test(id)) fail(); return `/financeiro-empresa?${new URLSearchParams({ area: 'remessas', remessa: id })}`; };

export type RemittanceRow = { id: string; profile_id: string; purpose: 'homologation' | 'operational'; state: 'reserved' | 'ready'; sequence: string; generated_on: string; created_at: string; filename: string;
  bank: string | null; bank_name: string | null; file_hash: string | null; byte_size: number | null; encoding_profile: string | null; excludable: boolean; titles: number; total_cents: string };
/** number: Nº Retorno (sequence of the .RET file, SQL 246), null for the files read before it. */
export type ReturnRow = { id: string; profile_id: string; purpose: 'homologation' | 'operational'; generated_on: string; created_at: string; filename: string; bank: string | null; bank_name: string | null; number?: string | null; excludable: boolean; titles: number; total_cents: string };
/** Nº Retorno as Origin shows it (no leading zeros); — when the file was read before the number was kept. */
export const returnNumberLabel = (value: string | null | undefined) => value && /^\d{1,7}$/.test(value) ? String(Number(value)) : '—';
export type CnabListPage<T> = { total: number; page: number; items: T[] };
export type RemittanceDetail = { record: Omit<RemittanceRow, 'titles' | 'total_cents'>; account: { bank: string | null; bank_name: string | null; agency: string | null; account: string | null; account_digit: string | null; wallet: string | null; name: string | null };
  titles: { billing_title_id: string; title_id: string; contact_name: string; our_number: string | null; document_number: string; issued_on: string; due_on: string; description: string; amount_cents: string }[]; titles_total: number; total_cents: string };
export type ReturnEventRow = { line: number; event_id: string; duplicate: boolean; kind: string; occurrence: string | null; document_number: string | null; our_number: string | null; occurrence_date: string | null; credit_date: string | null; due_date: string | null;
  contact_name: string | null; fee_cents: string; interest_cents: string; amount_cents: string; paid_cents: string };
export type ReturnDetail = { record: Omit<ReturnRow, 'titles' | 'total_cents'>; summary: Record<string, string | number>; group: string; page: number; total: number; items: ReturnEventRow[] };
const bad = (): never => { throw new Error('Não foi possível conferir a resposta da cobrança.'); };
const isPage = (value: unknown, entity: string) => { const v = value as Record<string, unknown> | null; return Boolean(v && v.entity === entity && v.data_mode === 'erp_native' && Number.isSafeInteger(v.total) && Number.isSafeInteger(v.page) && Array.isArray(v.items)); };
export function remittancePage(value: unknown): CnabListPage<RemittanceRow> {
  if (!isPage(value, 'cnab_remittances')) bad();
  const v = value as { total: number; page: number; items: RemittanceRow[] };
  if (v.items.some(item => !UUID.test(item.id) || !['reserved', 'ready'].includes(item.state) || typeof item.total_cents !== 'string')) bad();
  return { total: v.total, page: v.page, items: v.items };
}
export function returnPage(value: unknown): CnabListPage<ReturnRow> {
  if (!isPage(value, 'cnab_returns')) bad();
  const v = value as { total: number; page: number; items: ReturnRow[] };
  if (v.items.some(item => !UUID.test(item.id) || typeof item.total_cents !== 'string' || (item.number != null && !/^\d{1,7}$/.test(item.number)))) bad();
  return { total: v.total, page: v.page, items: v.items };
}
export function remittanceDetail(value: unknown, id: string): RemittanceDetail {
  const v = value as { entity?: unknown; data_mode?: unknown; record?: { id?: unknown }; account?: unknown; titles?: unknown } | null;
  if (!v || v.entity !== 'cnab_remittance' || v.data_mode !== 'erp_native' || v.record?.id !== id || !v.account || !Array.isArray(v.titles)) bad();
  return value as RemittanceDetail;
}
export function returnDetail(value: unknown, id: string): ReturnDetail {
  const v = value as { entity?: unknown; data_mode?: unknown; record?: { id?: unknown }; summary?: unknown; items?: unknown } | null;
  if (!v || v.entity !== 'cnab_return' || v.data_mode !== 'erp_native' || v.record?.id !== id || !v.summary || !Array.isArray(v.items)) bad();
  return value as ReturnDetail;
}
/** Origin descriptions of the ocorrências: Entrada confirmada · Liquidação normal · Baixa simples, and the other Itaú ones. */
export const RETURN_OCCURRENCE_LABEL: Readonly<Record<string, string>> = { REGISTERED: 'Entrada confirmada', REJECTED: 'Entrada rejeitada', PAID: 'Liquidação normal', PARTIAL_PAYMENT: 'Liquidação parcial', NOTARY_PAYMENT: 'Liquidação em cartório',
  CANCELLED: 'Baixa simples', CLOSED_AFTER_PAYMENT: 'Baixa por ter sido liquidado', UNSUPPORTED_OCCURRENCE: 'Ocorrência para conferência' };
export const occurrenceLabel = (kind: string) => RETURN_OCCURRENCE_LABEL[kind] ?? 'Ocorrência para conferência';
