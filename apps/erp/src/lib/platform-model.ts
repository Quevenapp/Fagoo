// Leva H, lane plataforma (/v1/plataforma, migrations 202610210330-334): tarefas do servidor, exportação da empresa, tabelas
// oficiais (CNAE, municípios, países), consulta de CEP e o card "Novas NF-es". Closed shapes: anything else is refused.
import type { NativeRequestOptions } from './real-access';

export const PLATFORM_BASE = '/v1/plataforma';
export interface PlatformPort { platform: (path: string, options?: NativeRequestOptions) => Promise<unknown>; storageOrigin?: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new Error('platform_invalid_response'); }
const str = (value: unknown, max = 300) => typeof value === 'string' && value.length <= max;
const strOrNull = (value: unknown, max = 300) => value === null || str(value, max);

export type ReferenceTable = 'cnae' | 'municipios' | 'paises';
export interface ReferenceItem { code: string; label: string; detail: string | null }
export interface ReferenceDataset { source: string; version: string; fetched_on: string }
export function referencePath(table: ReferenceTable, query: string, uf?: string | null) {
  const params = new URLSearchParams(); const q = query.trim().slice(0, 80); if (q) params.set('q', q); if (uf && /^[A-Z]{2}$/.test(uf) && table === 'municipios') params.set('uf', uf);
  const search = params.toString(); return `${PLATFORM_BASE}/referencias/${table}${search ? `?${search}` : ''}`;
}
export function parseReference(raw: unknown, table: ReferenceTable): { items: ReferenceItem[]; dataset: ReferenceDataset } {
  if (!object(raw) || raw.scope !== 'reference_search' || raw.table !== table || !Array.isArray(raw.items) || raw.items.length > 50 || !object(raw.dataset)) fail();
  const r = raw as { items: unknown[]; dataset: Record<string, unknown> };
  if (!str(r.dataset.source) || !str(r.dataset.version, 120) || !str(r.dataset.fetched_on, 10)) fail();
  const items = r.items.map(item => {
    if (!object(item) || !str(item.code, 9)) fail();
    const i = item as Record<string, unknown>;
    if (table === 'cnae') { if (!str(i.description)) fail(); return { code: i.code as string, label: i.description as string, detail: `Seção ${String(i.section)}` }; }
    if (table === 'municipios') { if (!str(i.name, 120) || !str(i.uf, 2)) fail(); return { code: i.code as string, label: i.name as string, detail: i.uf as string }; }
    if (!str(i.name, 120)) fail(); return { code: i.code as string, label: i.name as string, detail: `cPais ${i.code as string}` };
  });
  return { items, dataset: { source: r.dataset.source as string, version: r.dataset.version as string, fetched_on: r.dataset.fetched_on as string } };
}
/** "4744-0/01 — COMÉRCIO VAREJISTA..." is the value of a datalist option; the CNAE field keeps only the code. */
export const cnaeCodeOf = (value: string) => /^\s*(\d{4}-?\d\/?\d{2})\b/.exec(value)?.[1] ?? value;

export interface CepAddress { cep: string; street: string | null; complement: string | null; district: string | null; city: string; state: string; ibge_code: string | null }
export const cepDigits = (value: string | null | undefined) => String(value ?? '').replace(/\D/g, '');
export const cepPath = (cep: string) => `${PLATFORM_BASE}/cep/${cepDigits(cep)}`;
export function parseCep(raw: unknown, cep: string): CepAddress {
  if (!object(raw) || raw.scope !== 'cep_lookup' || raw.cep !== cepDigits(cep) || !str(raw.city, 120) || !/^[A-Z]{2}$/.test(String(raw.state))
    || ![raw.street, raw.complement, raw.district].every(v => strOrNull(v, 120)) || !(raw.ibge_code === null || /^\d{7}$/.test(String(raw.ibge_code)))) fail();
  const r = raw as unknown as CepAddress;
  return { cep: r.cep, street: r.street, complement: r.complement, district: r.district, city: r.city, state: r.state, ibge_code: r.ibge_code };
}
export const CEP_MESSAGES: Record<number, string> = { 404: 'CEP não encontrado. Preencha o endereço manualmente.', 503: 'A consulta de CEP está indisponível agora. Preencha o endereço manualmente.' };

export type TaskPurpose = 'notifications_generate' | 'company_export' | 'export_cleanup';
export const PURPOSE_TEXT: Record<TaskPurpose, string> = { notifications_generate: 'Gerar notificações internas', company_export: 'Exportação dos dados da empresa', export_cleanup: 'Limpeza das exportações vencidas' };
export const TASK_STATUS_TEXT = { queued: 'Na fila', running: 'Em execução', done: 'Concluída', failed: 'Falhou' } as const;
export interface PlatformTask { id: string; purpose: TaskPurpose; operation_id: string; status: keyof typeof TASK_STATUS_TEXT; attempts: number; max_attempts: number; created_at: string;
  finished_at: string | null; next_attempt_at: string | null; error_code: string | null; requested_by_name: string | null; result: Record<string, string | number | boolean | null> | null;
  history: { attempt: number; started_at: string; finished_at: string | null; outcome: string | null; error_code: string | null }[] }
export const TASKS_PATH = `${PLATFORM_BASE}/tarefas`;
export function parseTasks(raw: unknown): { all: boolean; items: PlatformTask[] } {
  if (!object(raw) || raw.scope !== 'platform_tasks' || typeof raw.all !== 'boolean' || !Array.isArray(raw.items) || raw.items.length > 50) fail();
  const items = (raw.items as unknown[]).map(t => {
    if (!object(t) || !str(t.id, 36) || !Object.hasOwn(PURPOSE_TEXT, String(t.purpose)) || !Object.hasOwn(TASK_STATUS_TEXT, String(t.status)) || !Number.isInteger(t.attempts)
      || !Number.isInteger(t.max_attempts) || !str(t.created_at, 64) || !Array.isArray(t.history)) fail();
    return t as unknown as PlatformTask;
  });
  return { all: raw.all as boolean, items };
}
/** One line about what a finished task did. */
export function taskResultText(task: PlatformTask) {
  const r = task.result;
  if (task.status === 'failed') return `Falhou após ${task.attempts} tentativa${task.attempts === 1 ? '' : 's'}${task.error_code ? ` (${task.error_code})` : ''}.`;
  if (task.status === 'queued' && task.attempts > 0) return `Nova tentativa programada${task.error_code ? ` depois de ${task.error_code}` : ''}.`;
  if (!r) return task.status === 'running' ? 'Executando…' : 'Aguardando a próxima execução.';
  if (task.purpose === 'notifications_generate') return `${Number(r.created ?? 0)} notificação(ões) nova(s) para ${Number(r.members ?? 0)} usuário(s).`;
  if (task.purpose === 'export_cleanup') return `${Number(r.removed ?? 0)} pacote(s) vencido(s) removido(s).`;
  return `${Number(r.rows ?? 0)} registro(s) e ${Number(r.files ?? 0)} arquivo(s)${Number(r.files_skipped ?? 0) ? `, ${Number(r.files_skipped)} arquivo(s) fora do pacote` : ''}.`;
}

export const EXPORT_STATUS_TEXT = { queued: 'Na fila', running: 'Gerando pacote', ready: 'Pronta para baixar', failed: 'Falhou', expired: 'Expirada' } as const;
export interface CompanyExport { id: string; status: keyof typeof EXPORT_STATUS_TEXT; created_at: string; ready_at: string | null; expires_at: string | null; size_bytes: number | null;
  sha256: string | null; error_code: string | null; links: number; requested_by_name: string | null; summary: { datasets?: number; rows?: number; files?: number; files_skipped?: number } | null }
export const EXPORTS_PATH = `${PLATFORM_BASE}/exportacoes`;
export const exportLinkPath = (id: string) => `${EXPORTS_PATH}/${id}/link`;
export function parseExports(raw: unknown): { items: CompanyExport[]; retention_days: number; link_seconds: number } {
  if (!object(raw) || raw.scope !== 'platform_exports' || raw.retention_days !== 7 || raw.link_seconds !== 120 || !Array.isArray(raw.items) || raw.items.length > 20) fail();
  const items = (raw.items as unknown[]).map(e => {
    if (!object(e) || !str(e.id, 36) || !Object.hasOwn(EXPORT_STATUS_TEXT, String(e.status)) || !str(e.created_at, 64) || !Number.isInteger(e.links)) fail();
    return e as unknown as CompanyExport;
  });
  return { items, retention_days: 7, link_seconds: 120 };
}
export function parseExportLink(raw: unknown, storageOrigin?: string): { url: string; filename: string } {
  if (!object(raw) || raw.scope !== 'platform_export_link' || raw.expires_in !== 120 || !str(raw.url, 6000)
    || !/^brufap-exportacao-[0-9-]{15}\.zip$/.test(String(raw.filename))) fail();
  let url: URL;
  try { url = new URL(String(raw.url)); } catch { return fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !url.pathname.startsWith('/storage/v1/object/sign/brufap-exports/')) fail();
  if (storageOrigin !== undefined) {
    let expected: URL;
    try { expected = new URL(storageOrigin); } catch { return fail(); }
    if (expected.protocol !== 'https:' || expected.origin !== storageOrigin || expected.username || expected.password || url.origin !== expected.origin) fail();
  } else if (!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.port) fail();
  return { url: raw.url as string, filename: raw.filename as string };
}
export const fmtBytes = (n: number | null) => n === null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1).replace('.', ',')} kB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;

export interface NewInvoices { since: string; seen_before: boolean; total: number; synced: number; received: number }
export const NEW_INVOICES_PATH = `${PLATFORM_BASE}/novas-nfes`;
export const NEW_INVOICES_SEEN_PATH = `${PLATFORM_BASE}/novas-nfes/vistas`;
export function parseNewInvoices(raw: unknown): NewInvoices {
  if (!object(raw) || raw.scope !== 'home_new_invoices' || !str(raw.since, 64) || typeof raw.seen_before !== 'boolean'
    || ![raw.total, raw.synced, raw.received].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) fail();
  return { since: raw.since as string, seen_before: raw.seen_before as boolean, total: raw.total as number, synced: raw.synced as number, received: raw.received as number };
}
export const moment = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
/** Fills only the empty address fields with the CEP lookup; what the user typed is never replaced. */
export function fillAddress<T extends { street?: unknown; district?: unknown; city?: unknown; state?: unknown; complement?: unknown }>(current: T, address: CepAddress): T {
  const empty = (value: unknown) => value === null || value === undefined || String(value).trim() === '';
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of [['street', address.street], ['district', address.district], ['city', address.city], ['state', address.state], ['complement', address.complement]] as const)
    if (value && empty(next[key])) next[key] = value;
  return next as T;
}
