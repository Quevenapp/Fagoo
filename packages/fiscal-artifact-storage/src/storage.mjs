import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Internal Storage port. No environment, default fetch, credential loader or product wiring. */
import { createHash } from 'node:crypto';

const BUCKET = 'brufap-fiscal-artifacts';
const MAX_BYTES = 8388608, MAX_JSON = 8192, MAX_CALL_MS = 30000;
const SHA = '[a-f0-9]{64}', UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const OBJECT = new RegExp(`^(?:jobs|candidates|wsdl)/${UUID}/(${SHA})\\.xml$`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class FiscalArtifactStorageError extends Error {
  constructor(code) { super(code); this.name = 'FiscalArtifactStorageError'; this.code = code; }
}
const need = (value, code) => { if (!value) throw new FiscalArtifactStorageError(code); };
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch { /* Cleanup cannot expose driver errors. */ } };

function captureInput(input, writing) {
  const keys = writing ? ['bucket', 'key', 'bytes', 'contentType', 'upsert', 'ifNoneMatch', 'signal', 'deadline']
    : ['bucket', 'key', 'signal', 'deadline'];
  need(plain(input), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  need(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(descriptors[key], 'value')), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  // Read each own data property once. Accessors and inherited/unknown options
  // cannot change the destination, signal or bytes after validation.
  const values = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) values[key] = descriptor.value;
  const { bucket, key, signal, deadline } = values;
  need(bucket === BUCKET && typeof key === 'string' && OBJECT.test(key), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  need(signal === undefined || signal instanceof AbortSignal, 'FISCAL_ARTIFACT_STORAGE_SIGNAL_INVALID');
  const now = Date.now();
  need(Number.isSafeInteger(deadline) && deadline > now, 'FISCAL_ARTIFACT_STORAGE_DEADLINE_INVALID');
  need(!signal?.aborted, 'FISCAL_ARTIFACT_STORAGE_ABORTED');
  const maxBytes = key.startsWith('wsdl/') ? 512000 : MAX_BYTES;
  let body;
  if (writing) {
    need(values.bytes instanceof Uint8Array && values.bytes.length > 0 && values.bytes.length <= maxBytes
      && values.contentType === 'application/octet-stream' && values.upsert === false && values.ifNoneMatch === '*', 'FISCAL_ARTIFACT_STORAGE_WRITE_INVALID');
    body = Buffer.from(values.bytes);
    if (hash(body) !== OBJECT.exec(key)?.[1]) {
      body.fill(0);
      throw new FiscalArtifactStorageError('FISCAL_ARTIFACT_STORAGE_HASH_CONFLICT');
    }
  }
  return Object.freeze({ key, signal, body, maxBytes, end: Math.min(deadline, now + MAX_CALL_MS) });
}

export function createFiscalArtifactStorage({ projectUrl, supabaseDeployment = 'hosted', serviceKey, fetchImpl } = {}) {
  need(isConfiguredBackendOrigin(projectUrl,supabaseDeployment), 'FISCAL_ARTIFACT_STORAGE_PROJECT_INVALID');
  need(typeof serviceKey === 'string' && serviceKey.length >= 20 && serviceKey.length <= 8192 && /^[!-~]+$/.test(serviceKey), 'FISCAL_ARTIFACT_STORAGE_CREDENTIAL_INVALID');
  need(typeof fetchImpl === 'function', 'FISCAL_ARTIFACT_STORAGE_DRIVER_REQUIRED');

  async function execute(input, writing) {
    let captured;
    try { captured = captureInput(input, writing); }
    catch (error) {
      if (error instanceof FiscalArtifactStorageError) throw error;
      throw new FiscalArtifactStorageError('FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
    }
    const { key, signal, body, maxBytes, end } = captured;
    input = undefined; // Do not retain or consult the caller's argument object during I/O.
    const url = `${projectUrl}/storage/v1/object/${writing ? '' : 'authenticated/'}${BUCKET}/${key}`;
    const controller = new AbortController();
    let timer, response, reader, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => { controller.abort(); rejectStop(new FiscalArtifactStorageError(code)); };
    const onAbort = () => stop('FISCAL_ARTIFACT_STORAGE_ABORTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('FISCAL_ARTIFACT_STORAGE_TIMEOUT'), Math.max(1, end - Date.now()));
    const check = () => {
      need(!signal?.aborted, 'FISCAL_ARTIFACT_STORAGE_ABORTED');
      need(Date.now() < end && !controller.signal.aborted, 'FISCAL_ARTIFACT_STORAGE_TIMEOUT');
    };
    const bounded = async fn => { check(); return Promise.race([Promise.resolve().then(() => { check(); return fn(); }), stopped]); };
    async function bytesOf(limit) {
      const encoding = response.headers.get('content-encoding'), length = response.headers.get('content-length');
      need((encoding === null || encoding === 'identity') && (length === null || /^\d+$/.test(length) && Number(length) <= limit), 'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
      if (!response.body) return Buffer.alloc(0);
      reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const item = await bounded(() => reader.read());
          if (item.done) break;
          need(item.value instanceof Uint8Array && (size += item.value.length) <= limit, 'FISCAL_ARTIFACT_STORAGE_BODY_LIMIT');
          chunks.push(Buffer.from(item.value));
        }
        need(length === null || Number(length) === size, 'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
        check(); return Buffer.concat(chunks, size);
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        void reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined;
      }
    }
    async function errorCode() {
      need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''), 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
      const bytes = await bytesOf(MAX_JSON);
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        need(plain(value), 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
        // Exact provider codes only. Never return, log or infer from the free-text message.
        return { code: value.code, legacy: value.error, statusCode: value.statusCode };
      } finally { bytes.fill(0); }
    }
    try {
      check();
      const pending = Promise.resolve().then(() => {
        check();
        return fetchImpl(url, {
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
        || response.url === url), 'FISCAL_ARTIFACT_STORAGE_RESPONSE_INVALID');
      need(response.status < 300 || response.status >= 400, 'FISCAL_ARTIFACT_STORAGE_REDIRECT_REJECTED');
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
        throw new FiscalArtifactStorageError('FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
      }
      if ([400, 404].includes(response.status)) {
        const code = await errorCode();
        // The authenticated endpoint also wraps a missing key in HTTP400 with
        // statusCode404. Require both exact structured fields for that legacy
        // transport shape; generic bad requests or free text are never absence.
        if (code.code === 'NoSuchKey' && (response.status === 404
          || code.statusCode === '404' || code.statusCode === 404)) return null;
        // Missing bucket, denied access or an ambiguous legacy 404 is not an absent XML.
        throw new FiscalArtifactStorageError('FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
      }
      need(response.status === 200 && response.headers.get('content-type') === 'application/octet-stream', 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
      const bytes = await bytesOf(maxBytes);
      try {
        need(bytes.length > 0, 'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
        const expected = OBJECT.exec(key)?.[1];
        need(hash(bytes) === expected, 'FISCAL_ARTIFACT_STORAGE_HASH_CONFLICT');
        check();
        return new Response(new Uint8Array(bytes), { status: 200, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store',
        } });
      } finally { bytes.fill(0); }
    } catch (error) {
      if (error instanceof FiscalArtifactStorageError) throw error;
      throw new FiscalArtifactStorageError('FISCAL_ARTIFACT_STORAGE_IO_FAILED');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else cancel(response?.body);
      body?.fill(0);
    }
  }
  return Object.freeze({ putImmutable: input => execute(input, true), read: input => execute(input, false) });
}
