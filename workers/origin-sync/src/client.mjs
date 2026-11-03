import { configuredEndpoint } from './endpoints.mjs';
/** Read-only API v3 client. Error messages never contain URLs, tokens or bodies. */
import { isCapturedPriceNumber, parsePriceJson, priceEndpoint } from './price-json.mjs';
import { parsePurchasePriceJson, purchasePriceEndpoint } from './purchase-price-json.mjs';
import { parseSalesPriceJson, salesPriceEndpoint } from './sales-price-json.mjs';
import { parseStockJson } from './stock-json.mjs';
import { parseServiceJson, serviceEndpoint } from './service-json.mjs';
import { xmlApiErrorCode } from './xml-api-error.mjs';
const API_PREFIX = '/Api/v3';
const ALLOWED_PATH = /^\/(?:contatos|produtos|pedidos\/(?:vendas|compras)|contas\/(?:receber|pagar)|propostas-comerciais|formas-pagamentos|vendedores|nfe|nfce)(?:\/[0-9]{1,40})?$/;
const EXTRA_PATH = /^\/(?:ordens\/servico|depositos|categorias\/(?:produtos|receitas-despesas)|contas-contabeis|caixas)(?:\/[0-9]{1,40})?$/;
const STOCK_PATH = '/estoques/saldos';
const CASH_DETAIL = /^\/caixas\/[0-9]{1,40}$/;
const XML_PATH = /^\/nfe\/documento\/[0-9]{44}$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 30_000;
const ATTEMPTS = 3;

export class OriginApiError extends Error {
  constructor(code, { status = null, retryable = false } = {}) {
    super(code);
    this.name = 'OriginApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function queryUrl(path, params, apiOrigin) {
  if (typeof path !== 'string' || (!ALLOWED_PATH.test(path)&&!EXTRA_PATH.test(path)&&path!==STOCK_PATH&&!XML_PATH.test(path))) throw new OriginApiError('ORIGIN_INVALID_PATH');
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new OriginApiError('ORIGIN_INVALID_PARAMS');
  if(XML_PATH.test(path)&&(Object.keys(params).length!==1||params.formato!=='xml'))throw new OriginApiError('ORIGIN_INVALID_PARAMS');
  if(path===STOCK_PATH&&(!Array.isArray(params['idsProdutos[]'])||params['idsProdutos[]'].length<1||params['idsProdutos[]'].length>25||new Set(params['idsProdutos[]']).size!==params['idsProdutos[]'].length||params['idsProdutos[]'].some(x=>typeof x!=='string'||!/^\d{1,40}$/.test(x)||/^0+$/.test(x))||![0,1,2].includes(params.filtroSaldoEstoque)||Object.keys(params).some(k=>!['idsProdutos[]','filtroSaldoEstoque'].includes(k))))throw new OriginApiError('ORIGIN_INVALID_PARAMS');
  const url = new URL(`${API_PREFIX}${path}`, apiOrigin);
  for (const [key, item] of Object.entries(params)) {
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\[\])?$/.test(key)) throw new OriginApiError('ORIGIN_INVALID_PARAMS');
    if (item === undefined) continue;
    const values = Array.isArray(item) ? item : [item];
    if (Array.isArray(item) && !key.endsWith('[]') && !(path==='/contas-contabeis'&&key==='situacoes'&&item.length===4&&item.every((v,i)=>v===i+1))) throw new OriginApiError('ORIGIN_INVALID_PARAMS');
    for (const value of values) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw new OriginApiError('ORIGIN_INVALID_PARAMS');
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new OriginApiError('ORIGIN_UNSAFE_NUMBER');
      if (String(value).length > 2048 || /[\r\n\0]/.test(String(value))) throw new OriginApiError('ORIGIN_INVALID_PARAMS');
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

function validatePayload(data) {
  if (data === null || typeof data !== 'object') throw new OriginApiError('ORIGIN_INVALID_DATA');
  const pending = [[data, 0, '']];
  let nodes = 0;
  while (pending.length) {
    const [value, depth, key] = pending.pop();
    if (++nodes > 200_000 || depth > 64) throw new OriginApiError('ORIGIN_RESPONSE_COMPLEXITY_LIMIT');
    if (isCapturedPriceNumber(value)) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new OriginApiError('ORIGIN_UNSAFE_NUMBER');
      if (/^id(?:$|[A-Z_])/.test(key) && (!Number.isSafeInteger(value) || value < 0)) throw new OriginApiError('ORIGIN_INVALID_ID_NUMBER');
    } else if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) pending.push([child, depth + 1, childKey]);
    }
  }
  return data;
}

async function readData(response, expectList, endpoint, bareCashDetail=false) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new OriginApiError('ORIGIN_RESPONSE_SIZE_LIMIT');
  if (!response.body || typeof response.body.getReader !== 'function') throw new OriginApiError('ORIGIN_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new OriginApiError('ORIGIN_RESPONSE_SIZE_LIMIT');
      if (endpoint) chunks.push(value.slice());
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    try { await reader.cancel(); } catch { /* No response/error body is logged. */ }
    if (error instanceof OriginApiError) throw error;
    throw new OriginApiError('ORIGIN_INVALID_JSON');
  } finally {
    reader.releaseLock();
  }
  let parsed;
  if (endpoint) {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { parsed = await (endpoint === 'service_detail' ? parseServiceJson : endpoint === 'stock_balances' ? parseStockJson : endpoint === 'sales_detail' ? parseSalesPriceJson : endpoint === 'purchase_detail' ? parsePurchasePriceJson : parsePriceJson)(text, bytes, endpoint); }
    catch (error) { throw new OriginApiError(/^ORIGIN_[A-Z_]+$/.test(error?.code || '') ? error.code : 'ORIGIN_INVALID_JSON'); }
  } else {
    try { parsed = JSON.parse(text); } catch { throw new OriginApiError('ORIGIN_INVALID_JSON'); }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.hasOwn(parsed, 'error')) throw new OriginApiError('ORIGIN_INVALID_RESPONSE');
  // The official /caixas/{id} schema is the detail itself. Its `data` field is
  // a posting date, not the envelope used by the other collection/detail APIs.
  if(bareCashDetail&&Object.hasOwn(parsed,'id')){
    if(Object.hasOwn(parsed,'data')&&typeof parsed.data!=='string')throw new OriginApiError('ORIGIN_INVALID_RESPONSE');
    return validatePayload(parsed);
  }
  if(!Object.hasOwn(parsed,'data'))throw new OriginApiError('ORIGIN_INVALID_RESPONSE');
  if (Array.isArray(parsed.data) !== expectList) throw new OriginApiError('ORIGIN_INVALID_DATA_SHAPE');
  return validatePayload(parsed.data);
}

function retryDelay(header, attempt, now) {
  let milliseconds;
  if (header && /^\d+(?:\.\d+)?$/.test(header.trim())) milliseconds = Number(header) * 1000;
  else if (header && Number.isFinite(Date.parse(header))) milliseconds = Date.parse(header) - now;
  else milliseconds = 1000 * 2 ** attempt;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds));
}

export class OriginClient {
  #apiOrigin;
  #token;
  #fetch;
  #sleep;
  #now;
  #interval;
  #timeout;
  #budget;
  #deadline;
  #requests = 0;
  #lastStarted = null;
  #queue = Promise.resolve();
  #priceCapture;
  #purchasePriceCapture;
  #salesPriceCapture;

  constructor(token, { apiOrigin, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = 700, now = Date.now, maxRequests = 120, timeoutMs = 15_000, deadline = Infinity, priceCaptureEnabled = false, purchasePriceCaptureEnabled = false, salesPriceCaptureEnabled = false } = {}) {
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token)) throw new OriginApiError('ORIGIN_INVALID_TOKEN');
    if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 0 || !Number.isSafeInteger(maxRequests) || maxRequests < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new OriginApiError('ORIGIN_INVALID_CLIENT_CONFIG');
    this.#apiOrigin = configuredEndpoint(apiOrigin, { originOnly: true, code: 'ORIGIN_INVALID_CLIENT_CONFIG' });
    this.#token = token;
    this.#fetch = fetchImpl.bind(globalThis);
    this.#sleep = sleep;
    this.#now = now;
    this.#interval = intervalMs;
    this.#timeout = timeoutMs;
    this.#budget = maxRequests;
    if(typeof deadline!=='number'||Number.isNaN(deadline)||deadline<=0)throw new OriginApiError('ORIGIN_INVALID_CLIENT_CONFIG');
    this.#deadline = deadline;
    if (typeof priceCaptureEnabled !== 'boolean' || typeof purchasePriceCaptureEnabled !== 'boolean' || typeof salesPriceCaptureEnabled !== 'boolean') throw new OriginApiError('ORIGIN_INVALID_CLIENT_CONFIG');
    this.#priceCapture = priceCaptureEnabled;
    this.#purchasePriceCapture = purchasePriceCaptureEnabled;
    this.#salesPriceCapture = salesPriceCaptureEnabled;
  }

  get requestsMade() { return this.#requests; }
  get remainingRequests() { return Math.max(0, this.#budget - this.#requests); }

  get(path, params = {}, { deadline = this.#deadline, maxAttempts = ATTEMPTS } = {}) {
    if(typeof deadline!=='number'||Number.isNaN(deadline)||deadline<=0)return Promise.reject(new OriginApiError('ORIGIN_INVALID_CLIENT_CONFIG'));
    if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>ATTEMPTS)return Promise.reject(new OriginApiError('ORIGIN_INVALID_CLIENT_CONFIG'));
    // Serializing also prevents concurrent callers from bypassing rate/budget.
    const job = this.#queue.then(() => this.#get(path, params,Math.min(deadline,this.#deadline),maxAttempts));
    this.#queue = job.catch(() => {});
    return job;
  }

  async #get(path, params,deadline,maxAttempts) {
    const url = queryUrl(path, params, this.#apiOrigin);
    // A retry deadline/budget failure must retain the upstream stop condition.
    let retryStatus = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if(this.#now()>=deadline)throw new OriginApiError('ORIGIN_TIME_BUDGET_EXHAUSTED',{status:retryStatus});
      if (!this.remainingRequests) throw new OriginApiError('ORIGIN_REQUEST_BUDGET_EXHAUSTED',{status:retryStatus});
      if (this.#lastStarted !== null) {
        const wait = this.#interval - (this.#now() - this.#lastStarted);
        if (wait > 0) {if(this.#now()+wait>=deadline)throw new OriginApiError('ORIGIN_TIME_BUDGET_EXHAUSTED',{status:retryStatus});await this.#sleep(wait);}
      }
      // A delayed timer must not start a new request after its phase has closed.
      if(this.#now()>=deadline)throw new OriginApiError('ORIGIN_TIME_BUDGET_EXHAUSTED',{status:retryStatus});
      this.#lastStarted = this.#now();
      this.#requests++;
      const controller = new AbortController();
      let timeout;
      const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new OriginApiError('ORIGIN_TIMEOUT',{status:retryStatus}));
        }, Math.min(this.#timeout,Math.max(1,deadline-this.#now())));
      });
      let result;
      try {
        result = await Promise.race([
          this.#attempt(url, controller.signal, XML_PATH.test(path)||!/\/\d+$/.test(path), serviceEndpoint(path) ?? (path === STOCK_PATH ? 'stock_balances' : null) ?? (this.#salesPriceCapture ? salesPriceEndpoint(path) : null) ?? (this.#purchasePriceCapture ? purchasePriceEndpoint(path) : null) ?? (this.#priceCapture ? priceEndpoint(path) : null), CASH_DETAIL.test(path)),
          timedOut,
        ]);
      } catch (error) {
        const aborted = controller.signal.aborted;
        controller.abort();
        if (error instanceof OriginApiError) throw error;
        throw new OriginApiError(aborted ? 'ORIGIN_TIMEOUT' : 'ORIGIN_NETWORK_ERROR',{status:retryStatus});
      } finally {
        clearTimeout(timeout);
      }
      if (Object.hasOwn(result, 'data')) return result.data;
      if (!result.retryable || attempt === maxAttempts - 1) throw result.error;
      retryStatus=result.error.status;
      const delay=retryDelay(result.retryAfter, attempt, this.#now());
      if(this.#now()+delay>=deadline)throw new OriginApiError('ORIGIN_TIME_BUDGET_EXHAUSTED',{status:result.error.status});
      await this.#sleep(delay);
    }
    throw new OriginApiError('ORIGIN_RETRIES_EXHAUSTED');
  }

  async #attempt(url, signal, expectList, endpoint, bareCashDetail) {
    const response = await this.#fetch(url, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', 'enable-jwt': '1' },
    });
    if (!response || !Number.isInteger(response.status) || !response.headers) throw new OriginApiError('ORIGIN_INVALID_RESPONSE');
    // Workers exposes redirects in manual mode; never follow their Location.
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new OriginApiError('ORIGIN_REDIRECT_BLOCKED', { status: response.status });
    if (response.status >= 200 && response.status < 300) return { data: await readData(response, expectList, endpoint, bareCashDetail) };
    const status = response.status;
    const retryable = status === 429 || (status >= 500 && status <= 599);
    let code = status === 401 ? 'ORIGIN_UNAUTHORIZED' : status === 403 ? 'ORIGIN_FORBIDDEN' : status === 404 ? 'ORIGIN_NOT_FOUND' : status === 429 ? 'ORIGIN_RATE_LIMITED' : status >= 500 ? 'ORIGIN_SERVER_ERROR' : 'ORIGIN_HTTP_ERROR';
    if(status===400&&XML_PATH.test(new URL(url).pathname.slice(API_PREFIX.length)))code=await xmlApiErrorCode(response,signal);
    const retryAfter = response.headers.get('retry-after');
    // Headers already establish the stop/retry status. Cleanup cannot hide it.
    try { void response.body?.cancel()?.catch(() => {}); } catch { /* Best-effort discard; never read/log the body. */ }
    return { retryable, retryAfter, error: new OriginApiError(code, { status, retryable }) };
  }
}
