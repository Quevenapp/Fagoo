// Origin "Ocorrências" of pedidos, propostas, OS (202610200103) and pedidos de compra (202610200129): list, one new entry at a
// time and the logical "Remover ocorrência".
import { STATES, type DocumentKind } from './real-documents-model.ts';
import type { RowSituation } from './document-situations-model.ts';

export type OccurrenceKind = DocumentKind;
export interface Occurrence {
  id: string; sequence: number; occurred_on: string; occurred_time: string; text: string | null; status_before: string; status_after: string | null;
  next_contact: string | null; actor_id: string; actor_role: string; document_version: number; recorded_at: string;
  /** Name from Sistema › Usuários (202610200129); absent before it or when the user has no name. */
  actor_name?: string | null;
  /** Situação of the moment (202610200163): key, name and color; absent before it, null when not recorded. */
  situation_before?: OccurrenceSituation | null; situation_after?: OccurrenceSituation | null;
}
export interface OccurrenceSituation { key: string; name: string; color: string }
export interface OccurrencePage { kind: OccurrenceKind; document: { id: string; kind: OccurrenceKind; number: string; status: string; version: number; situation?: RowSituation | null }; items: Occurrence[]; has_more: boolean; can_write: boolean;
  /** Preferências › Empresa "Permite a edição da data e hora das ocorrências" (163); absent before it. */
  date_editable?: boolean }
export interface OccurrenceDraft { occurred_on: string; occurred_time: string; text: string; status: string; next_contact: string }

// Origin help text of the modal, per document.
export const OCCURRENCE_HELP: Record<OccurrenceKind, string> = {
  sales_orders: 'Atualize a situação do pedido de venda. Ex.: Cancelado.',
  sales_proposals: 'Atualize a situação da proposta comercial. Ex.: Aprovado.',
  service_orders: 'Atualize a situação da ordem de serviço. Ex.: Finalizada.',
  purchase_orders: 'Atualize a situação do pedido de compra. Ex.: Atendido.',
};
export const ROLE_LABELS: Record<string, string> = { admin: 'Administrador', consulta: 'Consulta', vendas: 'Vendas', financeiro: 'Financeiro', estoque: 'Estoque', fiscal: 'Fiscal', desconhecido: 'Usuário' };
export const actorLabel = (item: Pick<Occurrence, 'actor_id' | 'actor_role' | 'actor_name'>, me: string | null) => item.actor_name ? item.actor_name : item.actor_id === me ? 'Você' : `${ROLE_LABELS[item.actor_role] ?? 'Usuário'} (outro usuário)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(19|20)\d{2}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Today and the current minute in America/Sao_Paulo, the Origin defaults of a new occurrence. */
export function saoPauloNow(now = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/** POST body (without command_id); throws a user message when the entry is incomplete. */
/** `current.status` is the current situação key (163: the id of a custom situação, or the status). */
export function occurrenceBody(kind: OccurrenceKind, current: { status: string; version: number; situation?: RowSituation | null }, draft: OccurrenceDraft, reasonNeeded: boolean) {
  const text = draft.text.trim();
  if (!DATE.test(draft.occurred_on)) throw new Error('Informe a data da ocorrência.');
  if (!TIME.test(draft.occurred_time)) throw new Error('Informe a hora da ocorrência (hh:mm).');
  if (draft.text.length > 1000 || CONTROL.test(draft.text)) throw new Error('A ocorrência deve ter até 1.000 caracteres.');
  const key = current.situation?.key ?? current.status;
  const status = draft.status && draft.status !== key ? draft.status : null;
  if (status && !Object.hasOwn(STATES[kind], status) && !(kind !== 'sales_proposals' && UUID.test(status))) throw new Error('Escolha uma situação válida.');
  if (status && reasonNeeded && text.length < 3) throw new Error('Descreva a ocorrência com pelo menos três caracteres: ela é o motivo desta mudança de situação.');
  const next = kind === 'sales_proposals' && draft.next_contact ? draft.next_contact : null;
  if (next && !DATE.test(next)) throw new Error('Informe uma data de próximo contato válida.');
  if (!text && !status && !next) throw new Error('Descreva a ocorrência ou escolha outra situação.');
  return { expected_version: current.version, occurred_on: draft.occurred_on, occurred_time: draft.occurred_time, text: text || null, status, ...(kind === 'sales_proposals' ? { next_contact: next } : {}) };
}

function occurrence(value: unknown, kind: OccurrenceKind): Occurrence {
  const item = value as Occurrence;
  if (!item || typeof item !== 'object' || !UUID.test(item.id) || !Number.isInteger(item.sequence) || item.sequence < 1 || !DATE.test(item.occurred_on) || !TIME.test(item.occurred_time)
    || (item.text !== null && typeof item.text !== 'string') || !Object.hasOwn(STATES[kind], item.status_before) || (item.status_after !== null && !Object.hasOwn(STATES[kind], item.status_after))
    || (item.next_contact !== null && (kind !== 'sales_proposals' || !DATE.test(item.next_contact))) || !UUID.test(item.actor_id) || typeof item.actor_role !== 'string' || !Number.isInteger(item.document_version)
    || (item.actor_name !== undefined && item.actor_name !== null && (typeof item.actor_name !== 'string' || !item.actor_name || item.actor_name.length > 120))
    || [item.situation_before, item.situation_after].some(value => value !== undefined && value !== null && (typeof value !== 'object' || typeof value.key !== 'string' || typeof value.name !== 'string'))) throw new Error('OCCURRENCE_INVALID');
  return item;
}
export function readOccurrences(value: unknown, kind: OccurrenceKind, id: string): OccurrencePage {
  const page = value as OccurrencePage;
  if (!page || page.kind !== kind || !page.document || page.document.id !== id || page.document.kind !== kind || !Object.hasOwn(STATES[kind], page.document.status)
    || !Number.isInteger(page.document.version) || !Array.isArray(page.items) || typeof page.has_more !== 'boolean' || typeof page.can_write !== 'boolean') throw new Error('OCCURRENCE_INVALID');
  return { ...page, items: page.items.map(item => occurrence(item, kind)) };
}
export function readOccurrenceResult(value: unknown, kind: OccurrenceKind, id: string, body: { expected_version: number; status: string | null }) {
  const result = value as { kind?: unknown; document?: { id?: unknown; kind?: unknown; status?: unknown; version?: unknown; situation?: RowSituation | null }; occurrence?: unknown; replayed?: unknown };
  const document = result?.document;
  if (!result || result.kind !== kind || typeof result.replayed !== 'boolean' || !document || document.id !== id || document.kind !== kind || !Number.isInteger(document.version)
    || (body.status !== null && ((document.situation?.key ?? document.status) !== body.status || (document.version as number) < body.expected_version + 1)) || (body.status === null && (document.version as number) < body.expected_version)) throw new Error('OCCURRENCE_INVALID');
  return { document: document as { id: string; kind: OccurrenceKind; status: string; version: number; situation?: RowSituation | null }, occurrence: occurrence(result.occurrence, kind) };
}
export const brDate = (value: string | null) => value ? value.split('-').reverse().join('/') : '';
/** POST …/ocorrencias/{id}/exclusao result: the same document (version unchanged) and the removed occurrence. */
export function readOccurrenceRemoval(value: unknown, kind: OccurrenceKind, documentId: string, occurrenceId: string) {
  const result = value as { kind?: unknown; replayed?: unknown; removed_id?: unknown; document?: { id?: unknown; kind?: unknown; status?: unknown; version?: unknown } };
  if (!result || result.kind !== kind || typeof result.replayed !== 'boolean' || result.removed_id !== occurrenceId || !result.document || result.document.id !== documentId
    || result.document.kind !== kind || !Object.hasOwn(STATES[kind], result.document.status as string) || !Number.isInteger(result.document.version)) throw new Error('OCCURRENCE_INVALID');
  return { replayed: result.replayed, document: result.document as { id: string; kind: OccurrenceKind; status: string; version: number } };
}
/** One line of the Ocorrências table: an occurrence or (OS, 202610200240) an entry of the diário da OS, which keeps its own history. */
export type OccurrenceLine = { type: 'occurrence'; item: Occurrence } | { type: 'journal'; id: string; date: string; time: string; text: string; actor_id: string };
const SAO_PAULO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Date (yyyy-mm-dd) and time (hh:mm) of an instant in America/Sao_Paulo. */
export function saoPauloDateTime(instant: string): { date: string; time: string } {
  const parts = SAO_PAULO.formatToParts(new Date(instant)), part = (type: string) => parts.find(entry => entry.type === type)?.value ?? '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour') === '24' ? '00' : part('hour')}:${part('minute')}` };
}
/**
 * Origin "Visualizar ocorrências" of the OS also shows the entries of the diário: both lists merged newest first by date and time
 * (an occurrence keeps its informed date and time; an entry of the diário its recording time), ties keeping the occurrence first.
 */
export function occurrenceLines(items: readonly Occurrence[], journal: readonly { id: string; text: string; actor_id: string; recorded_at: string }[]): OccurrenceLine[] {
  const lines: { line: OccurrenceLine; at: string; order: number }[] = [];
  items.forEach((item, order) => lines.push({ line: { type: 'occurrence', item }, at: `${item.occurred_on}T${item.occurred_time}`, order }));
  journal.forEach((entry, order) => { const { date, time } = saoPauloDateTime(entry.recorded_at); lines.push({ line: { type: 'journal', id: entry.id, date, time, text: entry.text, actor_id: entry.actor_id }, at: `${date}T${time}`, order: items.length + order }); });
  return lines.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : a.order - b.order).map(entry => entry.line);
}
