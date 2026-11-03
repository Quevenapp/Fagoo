import {readNativeReportCoverage,type NativeReportCoverage} from './document-reports-model.ts';
// Seletores de contatos das outras telas (contatos, onda C): busca por papel que respeita a carteira do vendedor,
// resumo do contato (pessoas de contato e Observações) e "Visualizar histórico" por tipo de documento.
export type PickerRole = 'customer' | 'supplier' | 'carrier' | 'technician';
export type HistoryKind = 'sales_orders' | 'purchase_orders';
const ROLE_PARAM: Record<PickerRole, string> = { customer: 'cliente', supplier: 'fornecedor', carrier: 'transportador', technician: 'tecnico' };
const HISTORY_PARAM: Record<HistoryKind, string> = { sales_orders: 'pedidos-venda', purchase_orders: 'pedidos-compra' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /v1/cadastros/contatos/opcoes: active contacts only, by papel, search and (busca avançada) cidade. */
export function contactOptionsPath({ q = '', role, city = '', limit = 25 }: { q?: string; role?: PickerRole | null; city?: string; limit?: number }) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q.trim()) params.set('q', q.trim().slice(0, 120));
  if (role) params.set('papel', ROLE_PARAM[role]);
  if (city.trim()) params.set('cidade', city.trim().slice(0, 100));
  return `/v1/cadastros/contatos/opcoes?${params}`;
}
/** The contact form in Clientes e fornecedores (a new tab keeps the screen that opened it). */
export const contactRecordPath = (id: string) => `/cadastros-reais?${new URLSearchParams({ cadastro: 'contacts', registro: id })}`;
export const contactHistoryPath = (id: string, kind: HistoryKind) => `/v1/cadastros/contatos/${id}/historico?tipo=${HISTORY_PARAM[kind]}`;

export interface PickerOption { id: string; name: string; code: string | null; document: string | null; trade_name: string | null; city: string | null; state: string | null; has_notes: boolean; persons: number; [key: string]: unknown }
const text = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' ? value : undefined;
/** Items of the picker answer; null when the answer is not the picker's. */
export function pickerOptions(value: unknown): { items: PickerOption[]; has_more: boolean } | null {
  const page = value as { scope?: unknown; items?: unknown; has_more?: unknown } | null;
  if (!page || page.scope !== 'contact_options' || !Array.isArray(page.items) || typeof page.has_more !== 'boolean') return null;
  const items = page.items as Record<string, unknown>[];
  if (items.some(item => typeof item?.id !== 'string' || !UUID.test(item.id) || typeof item.name !== 'string' || [item.code, item.document, item.trade_name, item.city, item.state].some(v => text(v) === undefined))) return null;
  return { items: items as unknown as PickerOption[], has_more: page.has_more };
}

export type SummaryPerson = { id: string; name: string; code: string | null; situation: string; visible: boolean; email: string | null; phone: string | null; mobile: string | null };
export type ContactSummary = { id: string; name: string; notes: string | null; contact_info: string | null; persons: SummaryPerson[] };
export function contactSummary(value: unknown, id: string): ContactSummary | null {
  const summary = value as { scope?: unknown; id?: unknown; name?: unknown; notes?: unknown; contact_info?: unknown; persons?: unknown } | null;
  if (!summary || summary.scope !== 'contact_summary' || summary.id !== id || typeof summary.name !== 'string' || text(summary.notes) === undefined || text(summary.contact_info) === undefined || !Array.isArray(summary.persons)) return null;
  const persons = summary.persons as SummaryPerson[];
  if (persons.some(person => typeof person?.id !== 'string' || typeof person.name !== 'string' || typeof person.visible !== 'boolean' || [person.email, person.phone, person.mobile].some(v => text(v) === undefined))) return null;
  return { id, name: summary.name, notes: (summary.notes as string | null) ?? null, contact_info: (summary.contact_info as string | null) ?? null, persons };
}

export type HistoryItem = { id: string; number: string; date: string | null; status: string; total: string };
export function contactHistory(value: unknown, id: string, kind: HistoryKind): NativeReportCoverage & { visible: boolean; items: HistoryItem[] } | null {
  const history = value as { scope?: unknown; contact_id?: unknown; kind?: unknown; visible?: unknown; items?: unknown } | null;
  if (!history || history.scope !== 'contact_history' || history.contact_id !== id || history.kind !== kind || typeof history.visible !== 'boolean' || !Array.isArray(history.items)) return null;
  const items = history.items as HistoryItem[];
  if (items.some(item => typeof item?.id !== 'string' || typeof item.number !== 'string' || typeof item.status !== 'string' || typeof item.total !== 'string')) return null;
  return { visible: history.visible, items, ...readNativeReportCoverage(history) };
}
/** Situação of a pedido de venda or de compra, with the Origin words. */
export const HISTORY_STATUS: Record<string, string> = { draft: 'Rascunho', open: 'Em aberto', verified: 'Verificado', in_progress: 'Em andamento', partially_fulfilled: 'Atendido parcialmente', fulfilled: 'Atendido', cancelled: 'Cancelado' };
/** Exact decimal string to pt-BR money (no float). */
export const historyMoney = (value: string) => { const [whole = '0', fraction = ''] = value.split('.'); return `R$ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction.padEnd(2, '0').slice(0, 2)}`; };
