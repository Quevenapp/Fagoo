import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Internal Storage port. No environment, default fetch, credential loader or product wiring. */
import { createHash } from 'node:crypto';

const BUCKET = 'brufap-received-dfe';
const MAX_BYTES = 8388608, MAX_JSON = 8192, MAX_CALL_MS = 30000;
const SHA = '[a-f0-9]{64}', UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const OBJECT = new RegExp(`^objects/(${SHA})\\.xml$`);
const JOURNAL = new RegExp(`^responses/${UUID}/${SHA}\\.xml$`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class DfeStorageError extends Error {
  constructor(code) { super(code); this.name = 'DfeStorageError'; this.code = code; }
}
const need = (value, code) => { if (!value) throw new DfeStorageError(code); };
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch { /* Cleanup cannot expose driver errors. */ } };

export function createDfeStorage({ projectUrl, supabaseDeployment = 'hosted', serviceKey, fetchImpl } = {}) {
  need(isConfiguredBackendOrigin(projectUrl,supabaseDeployment), 'DFE_STORAGE_PROJECT_INVALID');
  need(typeof serviceKey === 'string' && serviceKey.length >= 20 && serviceKey.length <= 8192 && /^[!-~]+$/.test(serviceKey), 'DFE_STORAGE_CREDENTIAL_INVALID');
  need(typeof fetchImpl === 'function', 'DFE_STORAGE_DRIVER_REQUIRED');

  async function execute(input, writing) {
    const keys = writing ? ['bucket', 'key', 'bytes', 'contentType', 'upsert', 'ifNoneMatch', 'signal', 'deadline']
      : ['bucket', 'key', 'signal', 'deadline'];
    need(plain(input) && Object.keys(input).every(key => keys.includes(key)) && input.bucket === BUCKET
      && typeof input.key === 'string' && (OBJECT.test(input.key) || JOURNAL.test(input.key)), 'DFE_STORAGE_INPUT_INVALID');
    need(input.signal === undefined || input.signal instanceof AbortSignal, 'DFE_STORAGE_SIGNAL_INVALID');
    const now = Date.now();
    need(Number.isSafeInteger(input.deadline) && input.deadline > now, 'DFE_STORAGE_DEADLINE_INVALID');
    need(!input.signal?.aborted, 'DFE_STORAGE_ABORTED');
    if (writing) {
      need(input.bytes instanceof Uint8Array && input.bytes.length > 0 && input.bytes.length <= MAX_BYTES
        && input.contentType === 'application/octet-stream' && input.upsert === false && input.ifNoneMatch === '*', 'DFE_STORAGE_WRITE_INVALID');
      const expected = OBJECT.exec(input.key)?.[1];
      need(!expected || hash(input.bytes) === expected, 'DFE_STORAGE_HASH_CONFLICT');
    }
    const body = writing ? Buffer.from(input.bytes) : undefined;
    const controller = new AbortController(), end = Math.min(input.deadline, now + MAX_CALL_MS);
    let timer, response, reader, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => { controller.abort(); rejectStop(new DfeStorageError(code)); };
    const onAbort = () => stop('DFE_STORAGE_ABORTED');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('DFE_STORAGE_TIMEOUT'), Math.max(1, end - Date.now()));
    const check = () => {
      need(!input.signal?.aborted, 'DFE_STORAGE_ABORTED');
      need(Date.now() < end && !controller.signal.aborted, 'DFE_STORAGE_TIMEOUT');
    };
    const bounded = async fn => { check(); return Promise.race([Promise.resolve().then(() => { check(); return fn(); }), stopped]); };
    async function bytesOf(limit) {
      const encoding = response.headers.get('content-encoding'), length = response.headers.get('content-length');
      need((encoding === null || encoding === 'identity') && (length === null || /^\d+$/.test(length) && Number(length) <= limit), 'DFE_STORAGE_BODY_INVALID');
      if (!response.body) return Buffer.alloc(0);
      reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const item = await bounded(() => reader.read());
          if (item.done) break;
          need(item.value instanceof Uint8Array && (size += item.value.length) <= limit, 'DFE_STORAGE_BODY_LIMIT');
          chunks.push(Buffer.from(item.value));
        }
        need(length === null || Number(length) === size, 'DFE_STORAGE_BODY_INVALID');
        check(); return Buffer.concat(chunks, size);
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        void reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined;
      }
    }
    async function errorCode() {
      need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''), 'DFE_STORAGE_HTTP_REJECTED');
      const bytes = await bytesOf(MAX_JSON);
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        need(plain(value), 'DFE_STORAGE_HTTP_REJECTED');
        // Exact provider codes only. Never return, log or infer from the free-text message.
        return { code: value.code, legacy: value.error };
      } finally { bytes.fill(0); }
    }
    try {
      check();
      const pending = Promise.resolve().then(() => {
        check();
        return fetchImpl(`${projectUrl}/storage/v1/object/${writing ? '' : 'authenticated/'}${BUCKET}/${input.key}`, {
          method: writing ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
          cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Cache-Control': 'no-store', 'Accept-Encoding': 'identity',
            ...(writing ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
              Accept: 'application/json', 'x-upsert': 'false', 'If-None-Match': '*' } : { Accept: 'application/octet-stream' }) },
          ...(writing ? { body } : {}),
        });
      });
      try { response = await bounded(() => pending); }
      catch (error) { void pending.then(result => cancel(result?.body)).catch(() => {}); throw error; }
      need(response instanceof Response && !response.redirected && (response.url === ''
        || response.url === `${projectUrl}/storage/v1/object/${writing ? '' : 'authenticated/'}${BUCKET}/${input.key}`), 'DFE_STORAGE_RESPONSE_INVALID');
      need(response.status < 300 || response.status >= 400, 'DFE_STORAGE_REDIRECT_REJECTED');
      if (writing) {
        if ([200, 201].includes(response.status)) {
          const ack = await bytesOf(MAX_JSON); ack.fill(0);
          return Object.freeze({ status: response.status, requires_readback: true });
        }
        if ([400, 409].includes(response.status)) {
          const code = await errorCode();
          if (['ResourceAlreadyExists', 'KeyAlreadyExists', 'already_exists'].includes(code.code)
            || code.code === undefined && code.legacy === 'Duplicate') {
            return Object.freeze({ status: 409, requires_readback: true });
          }
        }
        throw new DfeStorageError('DFE_STORAGE_HTTP_REJECTED');
      }
      if (response.status === 404) {
        const code = await errorCode();
        if (code.code === 'NoSuchKey') return null;
        // Missing bucket, denied access or an ambiguous legacy 404 is not an absent XML.
        throw new DfeStorageError('DFE_STORAGE_HTTP_REJECTED');
      }
      need(response.status === 200 && response.headers.get('content-type') === 'application/octet-stream', 'DFE_STORAGE_HTTP_REJECTED');
      const bytes = await bytesOf(MAX_BYTES);
      try {
        need(bytes.length > 0, 'DFE_STORAGE_BODY_INVALID');
        const expected = OBJECT.exec(input.key)?.[1];
        need(!expected || hash(bytes) === expected, 'DFE_STORAGE_HASH_CONFLICT');
        check();
        return new Response(new Uint8Array(bytes), { status: 200, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store',
        } });
      } finally { bytes.fill(0); }
    } catch (error) {
      if (error instanceof DfeStorageError) throw error;
      throw new DfeStorageError('DFE_STORAGE_IO_FAILED');
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else cancel(response?.body);
      body?.fill(0);
    }
  }
  return Object.freeze({ putImmutable: input => execute(input, true), read: input => execute(input, false) });
}
