import { configuredEndpoint } from '../../origin-sync/src/endpoints.mjs';
/** Sincronização de mão dupla com o Origin (migrações 202610220009-011).
 * - O banco monta cada requisição (erp_sync_claim) e confirma cada resultado (erp_sync_ack); este módulo só executa: envia ao
 *   Origin, relê o registro gravado e o devolve à área bruta (erp_sync_stage), para que o Brufap fique igual ao Origin.
 * - O cron de 2 minutos recebe (erp_sync_pull) e envia. O botão Sincronizar abre uma rodada (erp_sync_request) que, além disso,
 *   lista os IDs do Origin (censo) para achar o que foi criado ou excluído lá e o coletor ainda não viu.
 * - O token vem do coletor (origin_sync.credentials), com a mesma renovação e o mesmo lease de OAuth.
 * Nunca registra corpo de requisição, resposta, token ou dado pessoal: só códigos e mensagens de validação do Origin. */
import { accessToken } from '../../origin-sync/src/tokens.mjs';
import { Repository } from '../../origin-sync/src/repository.mjs';

export const ORIGIN_SYNC_BASE = '/v1/sincronizacao-origin';
const ID = '[1-9][0-9]{0,39}';
const WRITE_PATH = new RegExp(`^/(?:(?:contatos|produtos)(?:/${ID}(?:/situacoes)?)?|(?:pedidos/vendas|pedidos/compras)(?:/${ID}(?:/situacoes/${ID})?)?|propostas-comerciais(?:/${ID}(?:/situacoes)?)?|contas/(?:receber|pagar)(?:/${ID}(?:/baixar)?)?|estoques)$`);
const READ_PATH = new RegExp(`^/(?:contatos|produtos|pedidos/vendas|pedidos/compras|propostas-comerciais|contas/(?:receber|pagar))(?:/${ID})?$|^/estoques/saldos$`);
const MAX_BODY = 2 * 1024 * 1024;
const ENTITIES = ['contacts', 'products', 'sales_orders', 'sales_proposals', 'purchase_orders', 'receivables', 'payables'];
const DETAIL = { contacts: '/contatos', products: '/produtos', sales_orders: '/pedidos/vendas', sales_proposals: '/propostas-comerciais',
  purchase_orders: '/pedidos/compras', receivables: '/contas/receber', payables: '/contas/pagar', service_orders: null };

export class OriginWriteError extends Error {
  constructor(code, { status = null, retryable = false, detail = null } = {}) { super(code); this.code = code; this.status = status; this.retryable = retryable; this.detail = detail; }
}
export class OriginSyncRouteError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (text, max = 300) => typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : null;

/** The validation text Origin returns ("O campo X é obrigatório"), never the request or the token. */
export function originErrorDetail(value) {
  const error = isObject(value) ? value.error : null;
  if (!isObject(error)) return null;
  const fields = Array.isArray(error.fields) ? error.fields.map(f => clean(f?.msg, 160)).filter(Boolean).slice(0, 3) : [];
  return clean([clean(error.description, 200) || clean(error.message, 200), ...fields].filter(Boolean).join(' · '), 500);
}

export function retryDelay(header, attempt, now = Date.now()) {
  let ms;
  if (header && /^\d+(?:\.\d+)?$/.test(header.trim())) ms = Number(header) * 1000;
  else if (header && Number.isFinite(Date.parse(header))) ms = Date.parse(header) - now;
  else ms = 1000 * 2 ** attempt;
  return Math.min(30_000, Math.max(0, ms));
}

/** Rate-limited API v3 client for the two-way sync. One request at a time, at least `intervalMs` apart. */
export class OriginWriter {
  #apiOrigin;#token; #fetch; #sleep; #now; #interval; #budget; #deadline; #last = null; #requests = 0;
  constructor(token, { apiOrigin, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, intervalMs = 1000, maxRequests = 60, deadline = Infinity } = {}) {
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token)) throw new OriginWriteError('ORIGIN_INVALID_TOKEN');
    this.#apiOrigin = configuredEndpoint(apiOrigin, { originOnly: true, code: 'ORIGIN_INVALID_CLIENT_CONFIG' });
    this.#token = token; this.#fetch = fetchImpl.bind(globalThis); this.#sleep = sleep; this.#now = now;
    this.#interval = intervalMs; this.#budget = maxRequests; this.#deadline = deadline;
  }
  get requestsMade() { return this.#requests; }
  get remaining() { return this.#now() >= this.#deadline ? 0 : Math.max(0, this.#budget - this.#requests); }

  async call(method, path, { body, query } = {}) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new OriginWriteError('ORIGIN_INVALID_METHOD');
    if (!(method === 'GET' ? READ_PATH : WRITE_PATH).test(path)) throw new OriginWriteError('ORIGIN_INVALID_PATH');
    const url = new URL(`${this.#apiOrigin}/Api/v3${path}`);
    for (const [key, value] of Object.entries(query ?? {})) for (const item of Array.isArray(value) ? value : [value]) {
      if (!/^[A-Za-z][A-Za-z0-9]*(?:\[\])?$/.test(key) || !['string', 'number'].includes(typeof item) || /[\r\n\0]/.test(String(item))) throw new OriginWriteError('ORIGIN_INVALID_PARAMS');
      url.searchParams.append(key, String(item));
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && payload.length > 1_000_000) throw new OriginWriteError('ORIGIN_PAYLOAD_TOO_LARGE');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.remaining) throw new OriginWriteError('ORIGIN_REQUEST_BUDGET_EXHAUSTED', { retryable: true });
      if (this.#last !== null) { const wait = this.#interval - (this.#now() - this.#last); if (wait > 0) await this.#sleep(wait); }
      this.#last = this.#now(); this.#requests++;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
      let response;
      try {
        response = await this.#fetch(url.toString(), { method, redirect: 'manual', signal: controller.signal, body: payload,
          headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', 'enable-jwt': '1', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) } });
      } catch {
        clearTimeout(timer);
        if (method !== 'GET') throw new OriginWriteError('ORIGIN_WRITE_UNCONFIRMED');
        if (attempt < 2) { await this.#sleep(1000 * 2 ** attempt); continue; }
        throw new OriginWriteError('ORIGIN_NETWORK_ERROR', { retryable: true });
      }
      // A mutation can have committed even when the upstream returns 5xx or loses its response.
      // Without an upstream idempotency key, replay must require reconciliation.
      if (method !== 'GET' && (response.status >= 500 || response.status === 408)) {
        clearTimeout(timer); void response.body?.cancel?.();
        throw new OriginWriteError('ORIGIN_WRITE_UNCONFIRMED', { status: response.status });
      }
      if (response.status >= 300 && response.status < 400) { clearTimeout(timer); void response.body?.cancel?.(); throw new OriginWriteError('ORIGIN_REDIRECT_BLOCKED', { status: response.status }); }
      let text;
      try { text = await response.text(); }
      catch { throw new OriginWriteError(method === 'GET' ? 'ORIGIN_NETWORK_ERROR' : 'ORIGIN_WRITE_UNCONFIRMED', { status: response.status, retryable: method === 'GET' }); }
      finally { clearTimeout(timer); }
      if (text.length > MAX_BODY) throw new OriginWriteError(method === 'GET' ? 'ORIGIN_RESPONSE_SIZE_LIMIT' : 'ORIGIN_WRITE_UNCONFIRMED', { status: response.status });
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { if (response.ok) throw new OriginWriteError(method === 'GET' ? 'ORIGIN_INVALID_JSON' : 'ORIGIN_WRITE_UNCONFIRMED', { status: response.status }); } }
      if (response.ok) return { status: response.status, data };
      const status = response.status, retryable = status === 429 || status >= 500;
      if (retryable && attempt < 2) { await this.#sleep(retryDelay(response.headers.get('retry-after'), attempt, this.#now())); continue; }
      const code = status === 401 ? 'ORIGIN_UNAUTHORIZED' : status === 403 ? 'ORIGIN_FORBIDDEN' : status === 404 ? 'ORIGIN_NOT_FOUND'
        : status === 429 ? 'ORIGIN_RATE_LIMITED' : status >= 500 ? 'ORIGIN_SERVER_ERROR' : 'ORIGIN_VALIDATION_ERROR';
      throw new OriginWriteError(code, { status, retryable, detail: originErrorDetail(data) });
    }
    throw new OriginWriteError('ORIGIN_RETRIES_EXHAUSTED', { retryable: true });
  }
}

/** The ID Origin returns for a created record: {data:{id}} in most endpoints, {id} in contas a pagar. */
export function createdId(data) {
  const id = isObject(data?.data) ? data.data.id : isObject(data) ? data.id : null;
  return (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && /^[1-9]\d{0,39}$/.test(id)) ? String(id) : null;
}
const detailOf = data => isObject(data?.data) ? data.data : isObject(data) && !Object.hasOwn(data, 'error') ? data : null;
const entityOfPath = path => Object.entries(DETAIL).find(([, base]) => base && path.startsWith(`${base}/`))?.[0] ?? null;

/** Sends one claimed outbox item: its requests in order ({id} is the ID created by the first POST), then rereads it. */
export async function sendItem(item, { writer, rpc }) {
  let id = item.origin_id ?? null;
  let completedWrites = 0;
  try {
    for (const request of item.requests) {
      if (request.path.includes('{id}') && !id) throw new OriginWriteError('ORIGIN_CREATED_ID_MISSING');
      const path = request.path.replace('{id}', id ?? '');
      const result = await writer.call(request.method, path, request.body === undefined ? {} : { body: request.body });
      if (request.method !== 'GET') completedWrites++;
      if (request.method === 'POST' && !id && !path.endsWith('/baixar') && path !== '/estoques') {
        id = createdId(result.data);
        if (!id) throw new OriginWriteError('ORIGIN_CREATED_ID_MISSING', { status: result.status });
      }
    }
  } catch (error) {
    if (!(error instanceof OriginWriteError)) throw error;
    const code = completedWrites > 0 ? 'ORIGIN_PARTIAL_WRITE_REVIEW' : error.code;
    return { id: item.id, token: item.token, ok: false, status: error.status, code, retry: completedWrites ? false : error.retryable, origin_id: id,
      error: code === error.code ? (error.detail ? `${code}: ${error.detail}` : code) : `${code}: ${error.code}` };
  }
  // Reread: the Brufap gets the number, situação and values exactly as the Origin stored them.
  try {
    if (item.fetch && id) {
      const path = item.fetch.replace('{id}', id), entity = item.fetch_entity ?? entityOfPath(path) ?? item.entity;
      const got = await writer.call('GET', path);
      const detail = detailOf(got.data);
      if (detail) await rpc('erp_sync_stage', { p_entity: entity, p_source_id: path.split('/').pop(), p_payload: detail });
    }
    if (item.fetch_stock) await fetchStock([item.fetch_stock], { writer, rpc });
  } catch { /* The write already succeeded. The collector can reread/stage it later. Never replay it for a read failure. */ }
  return { id: item.id, token: item.token, ok: true, status: 200, origin_id: id, deleted: item.deleted === true };
}

export async function fetchStock(ids, { writer, rpc }) {
  for (let i = 0; i < ids.length; i += 25) {
    const got = await writer.call('GET', '/estoques/saldos', { query: { 'idsProdutos[]': ids.slice(i, i + 25) } });
    for (const row of Array.isArray(got.data?.data) ? got.data.data : []) {
      const product = row?.produto?.id;
      if ((typeof product === 'number' || typeof product === 'string') && /^[1-9]\d{0,39}$/.test(String(product))) await rpc('erp_sync_stage', { p_entity: 'stock_balances', p_source_id: String(product), p_payload: row });
    }
  }
}

/** Drains the outbox while there is time and request budget. */
export async function pushOutbox({ rpc, writer, deadline, now = Date.now, stats }) {
  for (let round = 0; round < 50; round++) {
    if (now() >= deadline || writer.remaining < 2) return false;
    // Claim only the next item: a terminated worker must not strand an untouched batch.
    const items = await rpc('erp_sync_claim', { p_limit: 1, p_token: crypto.randomUUID() });
    if (!Array.isArray(items) || !items.length) return true;
    for (const item of items) {
      const result = now() >= deadline || writer.remaining < 1
        ? { id: item.id, token: item.token, ok: false, retry: true, code: 'ORIGIN_TIME_BUDGET', error: 'ORIGIN_TIME_BUDGET' }
        : await sendItem(item, { writer, rpc });
      // Persist each outcome before another external write is attempted. An ack failure stops the cycle.
      await rpc('erp_sync_ack', { p_results: [result] });
      if (result.ok) stats.pushed++; else if (!result.retry) stats.failed++;
      if (result.code === 'ORIGIN_UNAUTHORIZED') return false;
    }
  }
  return false;
}

export async function drainPull({ rpc, deadline, now = Date.now, stats, limit = 100 }) {
  for (let round = 0; round < 40 && now() < deadline; round++) {
    const result = await rpc('erp_sync_pull', { p_limit: limit, p_entity: null });
    if (!isObject(result) || result.state !== 'ready') return result?.state ?? 'unknown';
    stats.pulled += result.applied ?? 0; stats.pull_failed = (stats.pull_failed ?? 0) + (result.failed ?? 0);
    if (!result.processed || (result.processed === result.deferred)) return 'drained';
  }
  return 'partial';
}

// ---------------------------------------------------------------------------------------------------------------
// Censo da rodada: lista os IDs do Origin por entidade (documentos e contas no último ano) e confere a diferença.
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
export function censusPlans(today = Date.now()) {
  const from = isoDay(today - 364 * 86400000), to = isoDay(today);
  return [
    { entity: 'contacts', path: '/contatos', partitions: [{ criterio: 1 }], since: null },
    { entity: 'products', path: '/produtos', partitions: [0, 1, 2].map(f => ({ criterio: 5, tipo: 'T', filtroSaldoEstoque: f })), since: null },
    { entity: 'sales_orders', path: '/pedidos/vendas', partitions: [{ dataInicial: from, dataFinal: to }], since: from },
    { entity: 'sales_proposals', path: '/propostas-comerciais', partitions: [{ dataInicial: from, dataFinal: to }], since: from },
    { entity: 'purchase_orders', path: '/pedidos/compras', partitions: [{ dataInicial: from, dataFinal: to }], since: from },
    { entity: 'receivables', path: '/contas/receber', partitions: [{ dataInicial: from, dataFinal: to, tipoFiltroData: 'E' }], since: from },
    { entity: 'payables', path: '/contas/pagar', partitions: [{ dataEmissaoInicial: from, dataEmissaoFinal: to }], since: from },
  ];
}
const listIds = data => (Array.isArray(data?.data) ? data.data : []).map(row => row?.id).filter(id => (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && /^[1-9]\d{0,39}$/.test(id))).map(String);

export async function advanceRun(run, { rpc, writer, deadline, now = Date.now, stats, today = Date.now() }) {
  const plans = censusPlans(today);
  let phase = run.phase, cursor = isObject(run.cursor) ? { ...run.cursor } : {};
  const save = (extra = {}) => rpc('erp_sync_run_update', { p_run: run.id, p_state: extra.state ?? 'running', p_phase: phase, p_cursor: cursor, p_stats: { ...stats, ...extra.stats }, p_error: extra.error ?? null });
  if (run.state === 'queued') await save();
  try {
    if (phase === 'push') {
      const drained = await pushOutbox({ rpc, writer, deadline, now, stats });
      if (!drained) return save();
      phase = 'census'; cursor = { entity: 0, partition: 0, page: 1 };
    }
    while (phase === 'census' || phase === 'fetch') {
      if (now() >= deadline || writer.remaining < 2) return save();
      const plan = plans[cursor.entity];
      if (!plan) { phase = 'pull'; break; }
      if (phase === 'census') {
        const got = await writer.call('GET', plan.path, { query: { ...plan.partitions[cursor.partition], pagina: cursor.page, limite: 100 } });
        const ids = listIds(got.data);
        if (ids.length) await rpc('erp_sync_census_add', { p_run: run.id, p_entity: plan.entity, p_ids: ids });
        stats.listed = (stats.listed ?? 0) + ids.length;
        if (ids.length === 100 && cursor.page < 500) cursor.page++;
        else if (cursor.partition + 1 < plan.partitions.length) { cursor.partition++; cursor.page = 1; }
        else { phase = 'fetch'; }
        await save();
        continue;
      }
      // fetch: new in the Origin -> read and stage; gone from the listing -> read: 404 confirms the deletion.
      const diff = await rpc('erp_sync_census_diff', { p_run: run.id, p_entity: plan.entity, p_limit: 200, p_since: plan.since });
      const fetch = (Array.isArray(diff?.fetch) ? diff.fetch : []).filter(id => !(cursor.done ?? []).includes(id));
      const check = (Array.isArray(diff?.check) ? diff.check : []).filter(id => !(cursor.done ?? []).includes(id));
      if (!fetch.length && !check.length) { phase = 'census'; cursor = { entity: cursor.entity + 1, partition: 0, page: 1 }; await save(); continue; }
      for (const id of [...fetch, ...check]) {
        if (now() >= deadline || writer.remaining < 1) return save();
        try {
          const got = await writer.call('GET', `${DETAIL[plan.entity]}/${id}`);
          const detail = detailOf(got.data);
          if (detail) { await rpc('erp_sync_stage', { p_entity: plan.entity, p_source_id: id, p_payload: detail }); stats.fetched = (stats.fetched ?? 0) + 1; }
        } catch (error) {
          if (!(error instanceof OriginWriteError)) throw error;
          if (error.status === 404) { await rpc('erp_sync_remote_deleted', { p_entity: plan.entity, p_origin: id }); stats.deleted_in_origin = (stats.deleted_in_origin ?? 0) + 1; }
          else if (error.retryable) return save();
        }
        cursor.done = [...(cursor.done ?? []), id].slice(-1000);
      }
      // A full page of differences may have more behind it; the next loop asks again without the ones already handled.
      if (fetch.length + check.length < 200) { phase = 'census'; cursor = { entity: cursor.entity + 1, partition: 0, page: 1 }; }
      await save();
    }
    if (phase === 'pull') {
      const pulled = await drainPull({ rpc, deadline, now, stats });
      if (pulled === 'partial') return save();
      const pushed = await pushOutbox({ rpc, writer, deadline, now, stats });
      if (!pushed) return save();
      phase = 'done';
      return save({ state: 'done' });
    }
    return save();
  } catch (error) {
    if (error instanceof OriginWriteError && (error.retryable || error.code === 'ORIGIN_REQUEST_BUDGET_EXHAUSTED')) return save();
    return save({ state: 'failed', error: error?.code ?? 'ORIGIN_SYNC_FAILED' });
  }
}

/** Builds the writer from the collector credentials, or null when the Worker has no Origin app secrets. */
export async function originWriterFromEnv(env, { fetchImpl = globalThis.fetch, deadline, maxRequests, repoFactory = value => new Repository(value) } = {}) {
  if (env.ORIGIN_ENABLED !== 'true' || !env.TOKEN_ENCRYPTION_KEY || !env.ORIGIN_CLIENT_ID || !env.ORIGIN_CLIENT_SECRET) return null;
  const apiOrigin = configuredEndpoint(env.ORIGIN_API_ORIGIN, { originOnly: true });
  const token = await accessToken(repoFactory(env), env);
  return new OriginWriter(token, { apiOrigin, fetchImpl, deadline, maxRequests: maxRequests ?? Number(env.ORIGIN_SYNC_MAX_REQUESTS || 60), intervalMs: Number(env.ORIGIN_SYNC_INTERVAL_MS || 1000) });
}

/** One cycle: receive, send, and advance the Sincronizar run. Without Origin secrets it only receives. */
export async function runOriginTwoWay({ rpc, env, writerFactory = originWriterFromEnv, budgetMs = 90_000, now = Date.now }) {
  const deadline = now() + budgetMs, stats = { pulled: 0, pushed: 0, failed: 0 };
  if (env.ORIGIN_ENABLED !== 'true' || env.ORIGIN_TWO_WAY_ENABLED !== 'true') return { state: 'disabled' };
  const pull = await drainPull({ rpc, deadline, now, stats });
  // Receiving an initial baseline must never consume the outgoing queue.
  if (env.ORIGIN_WRITE_ENABLED === 'false') return { state: 'receive_only', pull, ...stats };
  let writer = null, writerError = null;
  try { writer = await writerFactory(env, { deadline }); } catch (error) { writerError = typeof error?.message === 'string' && /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'ORIGIN_AUTHORIZATION_UNAVAILABLE'; }
  const found = await rpc('erp_sync_run_get', {}), run = isObject(found) && typeof found.id === 'string' && ['queued', 'running'].includes(found.state) ? found : null;
  if (!writer) {
    if (run) await rpc('erp_sync_run_update', { p_run: run.id, p_state: 'failed', p_phase: run.phase, p_cursor: null, p_stats: stats, p_error: writerError ?? 'ORIGIN_WRITE_NOT_CONFIGURED' });
    return { state: writerError ? 'unauthorized' : 'receive_only', pull, ...stats };
  }
  if (run) await advanceRun(run, { rpc, writer, deadline, now, stats });
  else await pushOutbox({ rpc, writer, deadline, now, stats });
  // The rereads of what was just sent are applied in the same cycle.
  await drainPull({ rpc, deadline, now, stats });
  return { state: 'ready', pull, requests: writer.requestsMade, ...stats };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP: GET situação, POST pede uma rodada. Only aggregate fields and validation codes leave the Worker.
export const originSyncRoute = path => path === ORIGIN_SYNC_BASE;
export const originSyncMethods = () => ['GET', 'POST'];
const TS = v => v === null || (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)));
const N = v => Number.isSafeInteger(v) && v >= 0;
const T = (v, max) => v === null || v === undefined || (typeof v === 'string' && v.length <= max);
export function originSyncStatus(value) {
  const bad = () => { throw new OriginSyncRouteError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
  if (!isObject(value) || value.scope !== 'origin_sync' || typeof value.enabled !== 'boolean' || typeof value.actor_configured !== 'boolean') bad();
  const side = (v, keys) => { if (!isObject(v)) bad(); return Object.fromEntries(keys.map(([k, test]) => { if (!test(v[k] ?? null)) bad(); return [k, v[k] ?? null]; })); };
  const push = side(value.push, [['pending', N], ['failed', N], ['last_sent_at', TS]]);
  const pull = side(value.pull, [['pending', N], ['failed', N], ['last_applied_at', TS]]);
  if (!N(value.issues) || !Array.isArray(value.recent_issues) || value.recent_issues.length > 20) bad();
  const recent = value.recent_issues.map(i => {
    if (!isObject(i) || !TS(i.at) || !['push', 'pull', 'census'].includes(i.direction) || !T(i.entity, 40) || !T(i.code, 80) || !T(i.detail, 500) || !T(i.source_id, 40)
      || !(i.record_id === null || (typeof i.record_id === 'string' && /^[0-9a-f-]{36}$/.test(i.record_id)))) bad();
    return { at: i.at, direction: i.direction, entity: i.entity, record_id: i.record_id, source_id: i.source_id ?? null, code: i.code, detail: i.detail ?? null };
  });
  let run = null;
  if (value.run !== null && value.run !== undefined) {
    const r = value.run;
    if (!isObject(r) || typeof r.id !== 'string' || !['queued', 'running', 'done', 'failed'].includes(r.state) || !['push', 'census', 'fetch', 'pull', 'stock', 'done'].includes(r.phase)
      || !TS(r.requested_at) || !TS(r.started_at ?? null) || !TS(r.finished_at ?? null) || !T(r.error, 500) || !isObject(r.stats)) bad();
    const stats = Object.fromEntries(Object.entries(r.stats).filter(([k, v]) => /^[a-z_]{1,30}$/.test(k) && N(v)).slice(0, 20));
    run = { id: r.id, state: r.state, phase: r.phase, requested_at: r.requested_at, started_at: r.started_at ?? null, finished_at: r.finished_at ?? null, stats, error: r.error ?? null };
  }
  return { scope: 'origin_sync', enabled: value.enabled, actor_configured: value.actor_configured, push, pull, issues: value.issues, recent_issues: recent, run,
    ...(typeof value.requested_run === 'string' ? { requested_run: value.requested_run } : {}) };
}
export { ENTITIES as ORIGIN_SYNC_ENTITIES };
