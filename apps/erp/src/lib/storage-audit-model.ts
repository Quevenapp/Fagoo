import type { AccessController } from './real-access.ts';

export type StorageAuditController = Pick<AccessController, 'getSnapshot' | 'subscribe' | 'historyDownload' | 'syncedXmlDownload'>;
export type StorageAuditDownload = Readonly<{ kind: 'backup_xml'; backup_sha256: string; xml_sha256: string } | { kind: 'synced_xml'; item_id: string }>;
export interface StorageAuditEntry { readonly reference_sha256: string; readonly sha256: string; readonly size_bytes: number; readonly download: StorageAuditDownload }
export interface StorageAuditPlan { readonly profile: 'origin-storage-audit-plan-v1'; readonly inventory_sha256: string; readonly inventory_payload_sha256: string; readonly entries: readonly StorageAuditEntry[] }
export interface PreparedStorageAuditPlan { readonly plan: StorageAuditPlan; readonly plan_sha256: string; readonly total_bytes: number }
export type StorageAuditStopReason = 'aborted' | 'session_changed' | 'unauthorized' | 'forbidden' | 'access_unavailable';
export type StorageAuditItemError = 'ABORTED' | 'SESSION_CHANGED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'ACCESS_UNAVAILABLE' | 'TIMEOUT' | 'DOWNLOAD_FAILED' | 'INVALID_BLOB' | 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'HASH_FAILED';
export interface StorageAuditResult {
  readonly reference_sha256: string; readonly status: 'verified' | 'failed' | 'not_attempted';
  readonly observed_sha256: string | null; readonly observed_bytes: number | null; readonly error: StorageAuditItemError | null;
  readonly started_at: string | null; readonly finished_at: string | null;
}
export interface StorageAuditProgress { readonly total: number; readonly completed: number; readonly verified: number; readonly failed: number; readonly bytes_verified: number; readonly started_at: string }
export interface StorageAuditReport {
  readonly profile: 'origin-storage-audit-report-v1'; readonly plan_sha256: string; readonly inventory_sha256: string; readonly inventory_payload_sha256: string;
  readonly started_at: string; readonly finished_at: string; readonly status: 'completed' | 'stopped'; readonly stop_reason: StorageAuditStopReason | null;
  readonly read_only: true; readonly results: readonly StorageAuditResult[];
}
export class StorageAuditError extends Error {
  readonly code: 'PLAN_INVALID' | 'PLAN_TOO_LARGE' | 'ABORTED';
  constructor(code: StorageAuditError['code']) { super(code); this.name = 'StorageAuditError'; this.code = code; }
}

const JSON_LIMIT = 16 * 1024 * 1024, XML_LIMIT = 8 * 1024 * 1024, TOTAL_LIMIT = 4 * 1024 ** 3, ENTRY_LIMIT = 10_000;
const ITEM_TIMEOUT_MS = 45_000;
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const preparedPlans = new WeakSet<PreparedStorageAuditPlan>();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
function invalid(): never { throw new StorageAuditError('PLAN_INVALID'); }
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) invalid();
  return record;
}
function sha(value: unknown): string { if (typeof value !== 'string' || !SHA.test(value)) invalid(); return value; }
function abortCheck(signal?: AbortSignal) { if (signal?.aborted) throw new StorageAuditError('ABORTED'); }
/** Races even a port that ignores cancellation; its late result can never become success. */
function withAbort<T>(start: () => PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new StorageAuditError('ABORTED')); return; }
    let finished = false;
    const settle = (ok: boolean, value: unknown) => {
      if (finished) return; finished = true; signal?.removeEventListener('abort', aborted);
      if (ok) resolve(value as T); else reject(value);
    };
    const aborted = () => settle(false, new StorageAuditError('ABORTED'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try { Promise.resolve(start()).then(value => settle(true, value), error => settle(false, error)); }
    catch (error) { settle(false, error); }
  });
}

/** Captures and freezes the entire plan before the first await. No input path or URL is accepted. */
export async function parseStorageAuditPlan(bytes: Uint8Array, signal?: AbortSignal): Promise<PreparedStorageAuditPlan> {
  abortCheck(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) invalid();
  if (bytes.byteLength > JSON_LIMIT) throw new StorageAuditError('PLAN_TOO_LARGE');
  const captured = new Uint8Array(bytes.byteLength); captured.set(bytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured)); } catch { return invalid(); }
  const input = exact(value, ['profile', 'inventory_sha256', 'inventory_payload_sha256', 'entries']);
  if (input.profile !== 'origin-storage-audit-plan-v1' || !Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > ENTRY_LIMIT) invalid();
  const references = new Set<string>(); let total = 0;
  const entries: StorageAuditEntry[] = input.entries.map(value => {
    const item = exact(value, ['reference_sha256', 'sha256', 'size_bytes', 'download']);
    const reference = sha(item.reference_sha256), expected = sha(item.sha256);
    if (references.has(reference)) invalid(); references.add(reference);
    if (typeof item.size_bytes !== 'number' || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 1 || item.size_bytes > XML_LIMIT) invalid();
    total += item.size_bytes; if (total > TOTAL_LIMIT) invalid();
    if (!item.download || typeof item.download !== 'object' || Array.isArray(item.download)) invalid();
    let download: StorageAuditDownload;
    if ((item.download as Record<string, unknown>).kind === 'backup_xml') {
      const d = exact(item.download, ['kind', 'backup_sha256', 'xml_sha256']);
      const xml = sha(d.xml_sha256); if (xml !== expected) invalid();
      download = Object.freeze({ kind: 'backup_xml', backup_sha256: sha(d.backup_sha256), xml_sha256: xml });
    } else {
      const d = exact(item.download, ['kind', 'item_id']);
      if (d.kind !== 'synced_xml' || typeof d.item_id !== 'string' || !UUID.test(d.item_id)) invalid();
      download = Object.freeze({ kind: 'synced_xml', item_id: d.item_id });
    }
    return Object.freeze({ reference_sha256: reference, sha256: expected, size_bytes: item.size_bytes, download });
  });
  const plan: StorageAuditPlan = Object.freeze({ profile: 'origin-storage-audit-plan-v1', inventory_sha256: sha(input.inventory_sha256), inventory_payload_sha256: sha(input.inventory_payload_sha256), entries: Object.freeze(entries) });
  const planHash = hex(await withAbort(() => crypto.subtle.digest('SHA-256', captured), signal)); abortCheck(signal);
  const prepared = Object.freeze({ plan, plan_sha256: planHash, total_bytes: total }); preparedPlans.add(prepared); return prepared;
}

/** Actor remains in memory and never enters the downloadable report. */
export function actorForStorageAudit(controller: StorageAuditController): string | null {
  try {
    const state = controller.getSnapshot();
    return state.phase === 'ready' && state.membership?.role === 'admin' && typeof state.membership.user_id === 'string' && state.membership.user_id.length > 0 ? state.membership.user_id : null;
  } catch { return null; }
}
function statusOf(error: unknown): number | null {
  try { const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined; return descriptor && 'value' in descriptor && typeof descriptor.value === 'number' ? descriptor.value : null; } catch { return null; }
}
function stopError(reason: StorageAuditStopReason): StorageAuditItemError {
  return ({ aborted: 'ABORTED', session_changed: 'SESSION_CHANGED', unauthorized: 'UNAUTHORIZED', forbidden: 'FORBIDDEN', access_unavailable: 'ACCESS_UNAVAILABLE' } as const)[reason];
}
class ItemFailure extends Error { readonly code: StorageAuditItemError; constructor(code: StorageAuditItemError) { super(code); this.code = code; } }

/** These GET proofs concern the bytes read in each interval, not an atomic Storage snapshot. */
export async function runStorageAudit(prepared: PreparedStorageAuditPlan, controller: StorageAuditController,
  options: { signal?: AbortSignal; onProgress?: (progress: StorageAuditProgress) => void } = {}): Promise<StorageAuditReport> {
  if (!preparedPlans.has(prepared)) invalid();
  const { signal, onProgress } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal) || onProgress !== undefined && typeof onProgress !== 'function') invalid();
  const plan = prepared.plan, actor = actorForStorageAudit(controller), started = new Date().toISOString();
  const results: StorageAuditResult[] = plan.entries.map(entry => Object.freeze({ reference_sha256: entry.reference_sha256, status: 'not_attempted', observed_sha256: null, observed_bytes: null, error: null, started_at: null, finished_at: null }));
  let next = 0, completed = 0, verified = 0, failed = 0, bytesVerified = 0;
  let stopReason: StorageAuditStopReason | null = null;
  const stopped = new AbortController();
  const stop = (reason: StorageAuditStopReason) => { if (!stopReason) { stopReason = reason; stopped.abort(); } };
  const checkSession = () => { if (actor === null) stop('access_unavailable'); else if (actorForStorageAudit(controller) !== actor) stop('session_changed'); };
  const outerAbort = () => stop('aborted');
  signal?.addEventListener('abort', outerAbort, { once: true });
  if (signal?.aborted) outerAbort(); checkSession();
  let unsubscribe: (() => void) | undefined;
  try { unsubscribe = controller.subscribe(checkSession); } catch { stop('access_unavailable'); }
  checkSession();
  const progress = () => { try { onProgress?.(Object.freeze({ total: plan.entries.length, completed, verified, failed, bytes_verified: bytesVerified, started_at: started })); } catch { /* A UI callback cannot alter evidence or leak an error body. */ } };
  const attempt = async (index: number) => {
    const entry = plan.entries[index], itemStarted = new Date().toISOString(), item = new AbortController();
    let timedOut = false, observedBytes: number | null = null, observedHash: string | null = null, stage: 'download' | 'bytes' | 'hash' = 'download';
    const cancel = () => item.abort(); stopped.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; item.abort(); }, ITEM_TIMEOUT_MS);
    const check = () => { checkSession(); if (stopped.signal.aborted || item.signal.aborted) throw new ItemFailure(stopReason ? stopError(stopReason) : timedOut ? 'TIMEOUT' : 'ABORTED'); };
    const step = async <T,>(fn: () => PromiseLike<T> | T) => { check(); const value = await withAbort(fn, item.signal); check(); return value; };
    let error: StorageAuditItemError | null = null;
    try {
      const d = entry.download;
      const blob = await step(() => d.kind === 'backup_xml'
        ? controller.historyDownload(`/v1/history/xml/${d.xml_sha256}/download?backup=${d.backup_sha256}`, item.signal)
        : controller.syncedXmlDownload(`/v1/xmls-sincronizados/${d.item_id}/download`, item.signal));
      if (!(blob instanceof Blob)) throw new ItemFailure('INVALID_BLOB');
      observedBytes = blob.size;
      if (observedBytes !== entry.size_bytes || observedBytes > XML_LIMIT) throw new ItemFailure('SIZE_MISMATCH');
      stage = 'bytes'; const body = await step(() => blob.arrayBuffer());
      if (!(body instanceof ArrayBuffer) || body.byteLength !== observedBytes) throw new ItemFailure('SIZE_MISMATCH');
      stage = 'hash'; observedHash = hex(await step(() => crypto.subtle.digest('SHA-256', body)));
      if (observedHash !== entry.sha256) throw new ItemFailure('HASH_MISMATCH');
      check();
    } catch (caught) {
      const status = statusOf(caught);
      if (status === 401) stop('unauthorized'); else if (status === 403) stop('forbidden');
      checkSession();
      error = stopReason ? stopError(stopReason) : timedOut ? 'TIMEOUT' : caught instanceof ItemFailure ? caught.code : stage === 'hash' ? 'HASH_FAILED' : 'DOWNLOAD_FAILED';
    } finally {
      clearTimeout(timer); stopped.signal.removeEventListener('abort', cancel);
    }
    // Recheck immediately before recording success. A global stop never accepts late bytes.
    checkSession(); if (stopReason) error = stopError(stopReason);
    results[index] = Object.freeze({ reference_sha256: entry.reference_sha256, status: error ? 'failed' : 'verified', observed_sha256: observedHash, observed_bytes: observedBytes, error, started_at: itemStarted, finished_at: new Date().toISOString() });
    completed++; if (error) failed++; else { verified++; bytesVerified += entry.size_bytes; } progress();
  };
  const worker = async () => { while (true) { checkSession(); if (stopped.signal.aborted || next >= plan.entries.length) return; const index = next++; await attempt(index); } };
  try { progress(); await Promise.all([worker(), worker()]); checkSession(); }
  finally { signal?.removeEventListener('abort', outerAbort); try { unsubscribe?.(); } catch { /* No subscriber error is exported. */ } }
  return Object.freeze({ profile: 'origin-storage-audit-report-v1', plan_sha256: prepared.plan_sha256, inventory_sha256: plan.inventory_sha256, inventory_payload_sha256: plan.inventory_payload_sha256,
    started_at: started, finished_at: new Date().toISOString(), status: stopReason ? 'stopped' : 'completed', stop_reason: stopReason, read_only: true, results: Object.freeze(results) });
}
