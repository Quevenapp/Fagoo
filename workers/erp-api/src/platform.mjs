/** Leva H, lane plataforma (migrations 202610210330-334), under /v1/plataforma:
 * - GET tarefas: Consultar gestão de ações, the server tasks (PRF-280);
 * - GET/POST exportacoes, POST exportacoes/:id/link: Backup e Exportação › Backup (PRF-029), a ZIP of the company data in the
 *   private bucket brufap-exports and a signed link of 2 minutes for the active administrador;
 * - GET referencias/(cnae|municipios|paises)?q=&uf=: the official tables embedded with source and version (PRF-296, CTT-045, VND-042);
 * - GET cep/:cep: the CEP lookup, a convenience over ViaCEP with a cache; manual entry stays (NFE-103);
 * - GET novas-nfes, POST novas-nfes/vistas: the "Novas NF-es" card of the home page (PRF-252).
 * The scheduled handler (cron) runs runPlatformTasks: the hourly notifications (PRF-283), the daily cleanup and the exports.
 * Every task is reserved with a lease and finished once; a repeated delivery finds the task done and repeats nothing. */
export const PLATFORM_BASE = '/v1/plataforma';
export const PLATFORM_BODY_BYTES = 2048;
export const EXPORT_BUCKET = 'brufap-exports';
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const EXPORT_FILES_BUDGET = 40 * 1024 * 1024;
export class PlatformError extends Error { constructor(status, code, field) { super(code); this.status = status; this.code = code; if (field) this.field = field; } }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const need = (ok, status, code) => { if (!ok) throw new PlatformError(status, code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = () => { throw new PlatformError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const TABLES = ['cnae', 'municipios', 'paises'];

export const platformRoute = path => path === PLATFORM_BASE || path.startsWith(`${PLATFORM_BASE}/`);
function routeOf(path) {
  const rest = path.slice(PLATFORM_BASE.length + 1);
  if (rest === 'tarefas') return { action: 'tasks', methods: ['GET'] };
  if (rest === 'exportacoes') return { action: 'exports', methods: ['GET', 'POST'] };
  const link = /^exportacoes\/([a-f0-9-]{36})\/link$/.exec(rest);
  if (link && UUID.test(link[1])) return { action: 'export-link', id: link[1], methods: ['POST'] };
  const table = /^referencias\/([a-z]+)$/.exec(rest);
  if (table && TABLES.includes(table[1])) return { action: 'reference', table: table[1], methods: ['GET'] };
  const cep = /^cep\/([0-9]{8})$/.exec(rest);
  if (cep) return { action: 'cep', cep: cep[1], methods: ['GET'] };
  if (rest === 'novas-nfes') return { action: 'new-invoices', methods: ['GET'] };
  if (rest === 'novas-nfes/vistas') return { action: 'new-invoices-seen', methods: ['POST'] };
  return null;
}
export const platformMethods = path => routeOf(path)?.methods ?? ['GET'];

async function body(request) {
  need(/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || ''), 415, 'ERP_UNSUPPORTED_MEDIA_TYPE');
  const text = await request.text(); need(new TextEncoder().encode(text).byteLength <= PLATFORM_BODY_BYTES, 413, 'ERP_PAYLOAD_TOO_LARGE');
  let value; try { value = JSON.parse(text); } catch { throw new PlatformError(400, 'ERP_INVALID_INPUT'); }
  need(object(value), 400, 'ERP_INVALID_INPUT'); return value;
}
const commandBody = value => { need(Object.keys(value).length === 1 && typeof value.command_id === 'string' && UUID.test(value.command_id), 400, 'ERP_INVALID_INPUT'); return value.command_id; };

export async function parsePlatformRoute(request) {
  const url = new URL(request.url), route = routeOf(url.pathname);
  need(route, 404, 'ERP_NOT_FOUND');
  if (route.action === 'reference') {
    for (const key of url.searchParams.keys()) need(['q', 'uf'].includes(key) && url.searchParams.getAll(key).length === 1, 400, 'ERP_INVALID_QUERY');
    const q = url.searchParams.get('q'), uf = url.searchParams.get('uf');
    need(q === null || (q.length <= 80 && !/[\x00-\x1f\x7f]/.test(q)), 400, 'ERP_INVALID_QUERY');
    need(uf === null || (route.table === 'municipios' && /^[A-Z]{2}$/.test(uf)), 400, 'ERP_INVALID_QUERY');
    return { ...route, q: q?.trim() || null, uf };
  }
  need(!url.search, 400, 'ERP_INVALID_QUERY');
  if (request.method === 'GET') { need(request.body === null, 400, 'ERP_INVALID_INPUT'); return route; }
  const sent = await body(request);
  if (route.action === 'export-link') { need(Object.keys(sent).length === 0, 400, 'ERP_INVALID_INPUT'); return route; }
  return { ...route, action: route.action === 'exports' ? 'export-request' : route.action, command_id: commandBody(sent) };
}

// ---- Closed response shapes ----
const stamp = value => value === null || (typeof value === 'string' && value.length <= 64);
const text = (value, max) => value === null || (typeof value === 'string' && value.length <= max);
const PURPOSES = ['notifications_generate', 'company_export', 'export_cleanup'];
function taskDto(t) {
  if (!object(t) || !UUID.test(t.id || '') || !PURPOSES.includes(t.purpose) || !text(t.operation_id, 96) || !['queued', 'running', 'done', 'failed'].includes(t.status)
    || !Number.isInteger(t.attempts) || !Number.isInteger(t.max_attempts) || ![t.created_at, t.started_at, t.finished_at, t.next_attempt_at].every(stamp)
    || !text(t.error_code, 80) || !text(t.requested_by_name, 120) || (t.result !== null && !object(t.result)) || !Array.isArray(t.history) || t.history.length > 10) bad();
  return { id: t.id, purpose: t.purpose, operation_id: t.operation_id, status: t.status, attempts: t.attempts, max_attempts: t.max_attempts, created_at: t.created_at,
    started_at: t.started_at, finished_at: t.finished_at, next_attempt_at: t.next_attempt_at, error_code: t.error_code, requested_by_name: t.requested_by_name,
    result: t.result === null ? null : Object.fromEntries(Object.entries(t.result).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 12)),
    history: t.history.map(h => { if (!object(h) || !Number.isInteger(h.attempt) || !stamp(h.started_at) || !stamp(h.finished_at) || !text(h.outcome, 16) || !text(h.error_code, 80)) bad();
      return { attempt: h.attempt, started_at: h.started_at, finished_at: h.finished_at, outcome: h.outcome, error_code: h.error_code }; }) };
}
function exportDto(e) {
  if (!object(e) || !UUID.test(e.id || '') || !['queued', 'running', 'ready', 'failed', 'expired'].includes(e.status) || ![e.created_at, e.ready_at, e.expires_at].every(stamp)
    || (e.size_bytes !== null && (!Number.isSafeInteger(e.size_bytes) || e.size_bytes < 22)) || (e.sha256 !== null && !/^[a-f0-9]{64}$/.test(e.sha256)) || !text(e.error_code, 80)
    || (e.attempts !== null && !Number.isInteger(e.attempts)) || !Number.isInteger(e.links) || !text(e.requested_by_name, 120) || (e.summary !== null && e.summary !== undefined && !object(e.summary))) bad();
  const summary = object(e.summary) ? Object.fromEntries(['datasets', 'rows', 'files', 'files_skipped', 'bytes'].filter(k => Number.isSafeInteger(e.summary[k])).map(k => [k, e.summary[k]])) : null;
  return { id: e.id, status: e.status, created_at: e.created_at, ready_at: e.ready_at, expires_at: e.expires_at, size_bytes: e.size_bytes, sha256: e.sha256,
    error_code: e.error_code, attempts: e.attempts, links: e.links, requested_by_name: e.requested_by_name, summary };
}
function exportsView(v) {
  if (!object(v) || v.scope !== 'platform_exports' || v.data_mode !== 'erp_native' || v.retention_days !== 7 || v.link_seconds !== 120 || !Array.isArray(v.items) || v.items.length > 20) bad();
  return { scope: 'platform_exports', retention_days: 7, link_seconds: 120, items: v.items.map(exportDto), data_mode: 'erp_native' };
}
function newInvoices(v) {
  if (!object(v) || v.scope !== 'home_new_invoices' || v.data_mode !== 'erp_native' || !stamp(v.since) || !stamp(v.as_of) || typeof v.seen_before !== 'boolean'
    || ![v.total, v.synced, v.received].every(n => Number.isSafeInteger(n) && n >= 0) || v.synced + v.received < v.total) bad();
  return { scope: 'home_new_invoices', since: v.since, seen_before: v.seen_before, total: v.total, synced: v.synced, received: v.received, as_of: v.as_of, data_mode: 'erp_native' };
}
function reference(v, table) {
  if (!object(v) || v.scope !== 'reference_search' || v.table !== table || !object(v.dataset) || !Array.isArray(v.items) || v.items.length > 50) bad();
  const d = v.dataset;
  if (!text(d.source, 300) || !text(d.source_url, 300) || !text(d.version, 120) || !/^\d{4}-\d{2}-\d{2}$/.test(d.fetched_on || '') || !Number.isInteger(d.rows)) bad();
  const items = v.items.map(i => {
    if (table === 'cnae') { if (!object(i) || !/^\d{4}-\d\/\d{2}$/.test(i.code || '') || !text(i.description, 300) || !/^[A-U]$/.test(i.section || '')) bad(); return { code: i.code, description: i.description, section: i.section }; }
    if (table === 'municipios') { if (!object(i) || !/^\d{7}$/.test(i.code || '') || !text(i.name, 120) || !/^[A-Z]{2}$/.test(i.uf || '')) bad(); return { code: i.code, name: i.name, uf: i.uf }; }
    if (!object(i) || !/^\d{4}$/.test(i.code || '') || !text(i.name, 120)) bad(); return { code: i.code, name: i.name };
  });
  return { scope: 'reference_search', table, dataset: { source: d.source, source_url: d.source_url, version: d.version, fetched_on: d.fetched_on, rows: d.rows }, items, data_mode: 'erp_native' };
}

// ---- CEP (ViaCEP, https://viacep.com.br: free public lookup, no key; cached for 30 days at the edge) ----
export async function lookupCep(cep, { fetchImpl = fetch, cache = globalThis.caches?.default ?? null, timeoutMs = 4000 } = {}) {
  need(/^[0-9]{8}$/.test(cep), 400, 'ERP_INVALID_QUERY');
  const url = `https://viacep.com.br/ws/${cep}/json/`;
  let response = cache ? await cache.match(url).catch(() => null) : null;
  if (!response) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } }); }
    catch { throw new PlatformError(503, 'ERP_CEP_UNAVAILABLE'); } finally { clearTimeout(timer); }
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); throw new PlatformError(response.status === 400 ? 404 : 503, response.status === 400 ? 'ERP_CEP_NOT_FOUND' : 'ERP_CEP_UNAVAILABLE'); }
    const raw = await response.text().catch(() => '');
    if (raw.length > 4096) throw new PlatformError(503, 'ERP_CEP_UNAVAILABLE');
    response = new Response(raw, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2592000' } });
    if (cache) await cache.put(url, response.clone()).catch(() => {});
  }
  let value; try { value = JSON.parse(await response.text()); } catch { throw new PlatformError(503, 'ERP_CEP_UNAVAILABLE'); }
  if (object(value) && (value.erro === true || value.erro === 'true')) throw new PlatformError(404, 'ERP_CEP_NOT_FOUND');
  const field = (key, max) => typeof value?.[key] === 'string' && value[key].length <= max ? value[key].trim() || null : null;
  if (!object(value) || field('cep', 9)?.replace('-', '') !== cep || !/^[A-Z]{2}$/.test(field('uf', 2) || '') || !field('localidade', 120)) throw new PlatformError(503, 'ERP_CEP_UNAVAILABLE');
  const ibge = field('ibge', 7);
  return { scope: 'cep_lookup', cep, street: field('logradouro', 120), complement: field('complemento', 120), district: field('bairro', 120), city: field('localidade', 120),
    state: field('uf', 2), ibge_code: ibge && /^\d{7}$/.test(ibge) ? ibge : null, source: 'ViaCEP', data_mode: 'external_lookup' };
}

/** The caller authenticated the JWT and passes only the verified UUID; SQL rechecks the member, the administrador or the reader. */
export async function executePlatformRoute(route, { userId, rpc, sign, cep = lookupCep, kick }) {
  const call = (name, extra = {}) => rpc(name, { p_user_id: userId, ...extra });
  if (route.action === 'tasks') {
    const v = await call('erp_platform_tasks', { p_limit: 50 });
    if (!object(v) || v.scope !== 'platform_tasks' || typeof v.all !== 'boolean' || !Array.isArray(v.items) || v.items.length > 50) bad();
    return { scope: 'platform_tasks', all: v.all, items: v.items.map(taskDto), data_mode: 'erp_native' };
  }
  if (route.action === 'exports') return exportsView(await call('erp_platform_exports'));
  if (route.action === 'export-request') {
    const v = await call('erp_platform_export_request', { p_command_id: route.command_id });
    if (!object(v) || typeof v.replayed !== 'boolean') bad();
    const answer = { export: exportDto(v.export), replayed: v.replayed, view: exportsView(v.view), data_mode: 'erp_native' };
    if (['queued', 'running'].includes(answer.export.status)) kick?.(); // Start now instead of waiting for the next cron.
    return answer;
  }
  if (route.action === 'export-link') {
    const v = await call('erp_platform_export_link', { p_export_id: route.id });
    if (!object(v) || v.export_id !== route.id || v.bucket !== EXPORT_BUCKET || !/^exports\/[a-f0-9-]{36}\/[a-f0-9]{64}\.zip$/.test(v.object_key || '') || !v.object_key.startsWith(`exports/${route.id}/`)
      || v.expires_in !== 120 || !/^brufap-exportacao-[0-9-]{15}\.zip$/.test(v.filename || '') || !Number.isSafeInteger(v.size_bytes) || !/^[a-f0-9]{64}$/.test(v.sha256 || '')) bad();
    const url = await sign(v.object_key, 120, v.filename);
    return { scope: 'platform_export_link', url, expires_in: 120, filename: v.filename, size_bytes: v.size_bytes, sha256: v.sha256, data_mode: 'erp_native' };
  }
  if (route.action === 'reference') return reference(await call('erp_reference_search', { p_table: route.table, p_query: route.q, p_uf: route.uf, p_limit: 20 }), route.table);
  if (route.action === 'cep') { await call('erp_reference_search', { p_table: 'cnae', p_query: '0', p_uf: null, p_limit: 1 }); return cep(route.cep); } // Member check first.
  if (route.action === 'new-invoices') return newInvoices(await call('erp_platform_new_invoices'));
  const v = await call('erp_platform_new_invoices_seen', { p_command_id: route.command_id });
  if (!object(v) || v.scope !== 'home_new_invoices_seen' || !stamp(v.seen_at) || typeof v.replayed !== 'boolean') bad();
  return { scope: 'home_new_invoices_seen', seen_at: v.seen_at, replayed: v.replayed, view: newInvoices(v.view), data_mode: 'erp_native' };
}

// ---- Server-only adapters ----
/** RPC with the service key, for the scheduled handler (no user request around it). */
export function createServiceRpc({ baseUrl, key, fetchImpl = fetch, timeoutMs = 20000 }) {
  return async (name, args) => {
    need(/^[a-z_]{3,80}$/.test(name), 400, 'ERP_INVALID_INPUT');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(args) });
      const raw = await response.text();
      if (raw.length > 4 * 1024 * 1024) bad();
      const value = raw ? JSON.parse(raw) : null;
      if (!response.ok) throw new PlatformError(response.status >= 500 ? 503 : 409, object(value) && typeof value.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code) ? `PG_${value.code}` : 'ERP_UPSTREAM_UNAVAILABLE');
      return value;
    } catch (error) { if (error instanceof PlatformError) throw error; throw new PlatformError(503, 'ERP_UPSTREAM_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  };
}
/** The private export bucket: upload once (immutable key with the SHA-256), delete after the retention, sign a short link. */
export function createExportStorage({ baseUrl, key, fetchImpl = fetch, timeoutMs = 60000 }) {
  const KEY = /^exports\/[a-f0-9-]{36}\/[a-f0-9]{64}\.zip$/;
  const headers = extra => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra });
  const request = async (path, init) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(`${baseUrl}/storage/v1/object/${path}`, { redirect: 'manual', signal: controller.signal, ...init }); }
    catch { throw new PlatformError(503, 'ERP_EXPORT_STORAGE_UNAVAILABLE'); } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    async put(objectKey, bytes) {
      need(KEY.test(objectKey) && bytes instanceof Uint8Array && bytes.length >= 22 && bytes.length <= EXPORT_MAX_BYTES, 400, 'ERP_INVALID_INPUT');
      const response = await request(`${EXPORT_BUCKET}/${objectKey}`, { method: 'POST', body: bytes, headers: headers({ 'Content-Type': 'application/zip', 'x-upsert': 'false', 'Cache-Control': 'no-store' }) });
      void response.body?.cancel().catch(() => {});
      // The key carries the SHA-256: an object already there (a lost answer of an earlier attempt) has the same bytes.
      if (!response.ok && response.status !== 409 && response.status !== 400) throw new PlatformError(503, 'ERP_EXPORT_STORAGE_UNAVAILABLE');
    },
    async remove(objectKey) {
      need(KEY.test(objectKey), 400, 'ERP_INVALID_INPUT');
      const response = await request(`${EXPORT_BUCKET}/${objectKey}`, { method: 'DELETE', headers: headers({ Accept: 'application/json' }) });
      void response.body?.cancel().catch(() => {});
      if (!response.ok && response.status !== 404 && response.status !== 400) throw new PlatformError(503, 'ERP_EXPORT_STORAGE_UNAVAILABLE');
    },
    async sign(objectKey, seconds, filename) {
      need(KEY.test(objectKey) && seconds === 120 && /^[a-z0-9.-]{1,60}$/.test(filename), 400, 'ERP_INVALID_INPUT');
      const response = await request(`sign/${EXPORT_BUCKET}/${objectKey}`, { method: 'POST', body: JSON.stringify({ expiresIn: seconds }), headers: headers({ 'Content-Type': 'application/json', Accept: 'application/json' }) });
      let value = null; try { value = await response.json(); } catch { /* below */ }
      const signed = value?.signedURL ?? value?.signedUrl;
      if (!response.ok || typeof signed !== 'string' || !signed.startsWith(`/object/sign/${EXPORT_BUCKET}/${objectKey}?token=`) || signed.length > 4096 || /[\s"<>]/.test(signed)) throw new PlatformError(503, 'ERP_EXPORT_STORAGE_UNAVAILABLE');
      return `${baseUrl}/storage/v1${signed}&download=${encodeURIComponent(filename)}`;
    },
  });
}

// ---- ZIP (stored entries compressed with deflate-raw, UTF-8 names, no external library) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function deflate(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }
export function createZip(date = new Date()) {
  const entries = [], parts = []; let offset = 0;
  const dosTime = ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)) & 0xffff;
  const dosDate = (((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;
  return {
    get size() { return offset; },
    async add(name, bytes) {
      const nameBytes = new TextEncoder().encode(name), data = await deflate(bytes), crc = crc32(bytes);
      const header = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 8, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4], [18, data.length, 4], [22, bytes.length, 4], [26, nameBytes.length, 2], [28, 0, 2]]
        .forEach(([at, value, size]) => size === 4 ? header.setUint32(at, value, true) : header.setUint16(at, value, true));
      entries.push({ nameBytes, crc, compressed: data.length, size: bytes.length, offset });
      parts.push(new Uint8Array(header.buffer), nameBytes, data); offset += 30 + nameBytes.length + data.length;
      return data.length;
    },
    finish() {
      const central = []; let size = 0;
      for (const e of entries) {
        const h = new DataView(new ArrayBuffer(46));
        [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 8, 2], [12, dosTime, 2], [14, dosDate, 2], [16, e.crc, 4], [20, e.compressed, 4], [24, e.size, 4], [28, e.nameBytes.length, 2], [42, e.offset, 4]]
          .forEach(([at, value, s]) => s === 4 ? h.setUint32(at, value, true) : h.setUint16(at, value, true));
        central.push(new Uint8Array(h.buffer), e.nameBytes); size += 46 + e.nameBytes.length;
      }
      const end = new DataView(new ArrayBuffer(22));
      [[0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, size, 4], [16, offset, 4]].forEach(([at, value, s]) => s === 4 ? end.setUint32(at, value, true) : end.setUint16(at, value, true));
      const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((n, p) => n + p.length, 0)); let at = 0;
      for (const p of all) { out.set(p, at); at += p.length; }
      return out;
    },
  };
}
const sha256Hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---- Task handlers ----
async function runExport(task, lease, { rpc, exportStorage, attachments }) {
  const held = { p_task: task.id, p_lease: lease };
  const plan = await rpc('erp_platform_export_plan', held);
  if (!object(plan) || !UUID.test(plan.export_id || '') || plan.export_id !== task.payload?.export_id || !Array.isArray(plan.datasets) || !Array.isArray(plan.files)) bad();
  const zip = createZip(new Date(plan.as_of)), datasets = [], encoder = new TextEncoder();
  let rows = 0;
  for (const name of plan.datasets) {
    if (typeof name !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(name)) bad();
    const chunks = []; let offset = 0, count = 0;
    while (offset !== null) {
      const page = await rpc('erp_platform_export_chunk', { ...held, p_dataset: name, p_offset: offset, p_limit: 500 });
      if (!object(page) || page.dataset !== name || page.offset !== offset || !Array.isArray(page.rows) || (page.next_offset !== null && page.next_offset <= offset)) bad();
      for (const row of page.rows) chunks.push(JSON.stringify(row));
      count += page.rows.length; offset = page.next_offset;
    }
    const bytes = encoder.encode(`[\n${chunks.join(',\n')}\n]\n`);
    await zip.add(`dados/${name}.json`, bytes); datasets.push({ name, rows: count, bytes: bytes.length }); rows += count;
    if (zip.size > EXPORT_MAX_BYTES - 1024 * 1024) throw new PlatformError(413, 'ERP_EXPORT_TOO_LARGE');
  }
  let files = 0; const skipped = [];
  for (const [index, file] of plan.files.entries()) {
    if (!object(file) || typeof file.key !== 'string') bad();
    if (zip.size + (file.size ?? 0) > EXPORT_FILES_BUDGET) { skipped.push({ key: file.key, reason: 'limite_do_pacote' }); continue; }
    let bytes = null;
    try { const response = await attachments.get(file.key); if (response.ok) bytes = new Uint8Array(await response.arrayBuffer()); else void response.body?.cancel().catch(() => {}); } catch { bytes = null; }
    if (!bytes) { skipped.push({ key: file.key, reason: 'indisponivel' }); continue; }
    await zip.add(`arquivos/${file.key}`, bytes); files++;
    if (index % 20 === 19) await rpc('erp_platform_task_progress', { ...held, p_progress: { summary: { datasets: datasets.length, rows, files } } });
  }
  const summary = { datasets: datasets.length, rows, files, files_skipped: skipped.length };
  const manifest = { formato: 'brufap-exportacao-v1', empresa: 'dados desta instalação do Brufap', gerado_em: new Date().toISOString(), dados_ate: plan.as_of,
    escopo: 'Tabelas da empresa (cadastros, documentos, finanças, estoque, notas, empresa, preferências, frente de caixa, preços, anexos, atividades, cobrança e cópia espelhada do Origin) e os arquivos anexados.',
    fora_do_pacote: plan.excluded, conjuntos: datasets, arquivos_omitidos: skipped.slice(0, 200), resumo: summary };
  await zip.add('manifesto.json', encoder.encode(JSON.stringify(manifest, null, 2)));
  const bytes = zip.finish();
  if (bytes.length > EXPORT_MAX_BYTES) throw new PlatformError(413, 'ERP_EXPORT_TOO_LARGE');
  const sha = await sha256Hex(bytes), objectKey = `exports/${plan.export_id}/${sha}.zip`;
  await exportStorage.put(objectKey, bytes);
  const stored = { summary: { ...summary, bytes: bytes.length }, datasets: datasets.slice(0, 120).map(d => ({ name: d.name, rows: d.rows })) };
  const done = await rpc('erp_platform_export_complete', { ...held, p_object_key: objectKey, p_size_bytes: bytes.length, p_sha256: sha, p_manifest: stored });
  if (!object(done) || done.export?.id !== plan.export_id) bad();
  return { export_id: plan.export_id, size_bytes: bytes.length, sha256: sha, rows, files, files_skipped: skipped.length };
}
async function runCleanup(task, lease, { rpc, exportStorage }) {
  const held = { p_task: task.id, p_lease: lease };
  const list = await rpc('erp_platform_export_expired', held);
  if (!object(list) || !Array.isArray(list.items)) bad();
  let removed = 0;
  for (const item of list.items) {
    if (!object(item) || !UUID.test(item.id || '')) bad();
    await exportStorage.remove(item.object_key);
    await rpc('erp_platform_export_removed', { ...held, p_export_id: item.id }); removed++;
  }
  return { removed };
}
export const TASK_HANDLERS = Object.freeze({
  notifications_generate: async (task, lease, { rpc }) => {
    const v = await rpc('erp_platform_notifications_run', { p_task: task.id, p_lease: lease });
    if (!object(v) || v.scope !== 'platform_notifications' || !Number.isInteger(v.created)) bad();
    return { day: v.day, created: v.created, members: v.members };
  },
  company_export: runExport,
  export_cleanup: runCleanup,
});

/** One run of the executor: optionally the periodic schedule, then due tasks one by one until the budget ends. */
export async function runPlatformTasks({ rpc, exportStorage, attachments, schedule = false, purposes = null, budgetMs = 25000, maxTasks = 10, now = () => Date.now(), lease = () => crypto.randomUUID() }) {
  const started = now(), ran = [];
  if (schedule) await rpc('erp_platform_schedule', { p_now: new Date(started).toISOString() });
  while (ran.length < maxTasks && now() - started < budgetMs) {
    const token = lease(), claimed = await rpc('erp_platform_task_claim', { p_lease: token, p_purposes: purposes });
    if (!object(claimed) || claimed.scope !== 'platform_task') bad();
    const task = claimed.task; if (task === null) break;
    if (!object(task) || !UUID.test(task.id || '') || !Object.hasOwn(TASK_HANDLERS, task.purpose)) bad();
    try {
      const result = await TASK_HANDLERS[task.purpose](task, token, { rpc, exportStorage, attachments });
      await rpc('erp_platform_task_finish', { p_task: task.id, p_lease: token, p_ok: true, p_result: result, p_error: null });
      ran.push({ id: task.id, purpose: task.purpose, ok: true });
    } catch (error) {
      // A lost lease (40001) means another run took the task: nothing to record here.
      const code = error instanceof PlatformError ? error.code : 'ERP_TASK_FAILED';
      if (code !== 'PG_40001') { try { await rpc('erp_platform_task_finish', { p_task: task.id, p_lease: token, p_ok: false, p_result: null, p_error: code.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80) }); } catch { /* The lease expires. */ } }
      ran.push({ id: task.id, purpose: task.purpose, ok: false, code });
    }
  }
  return ran;
}
