import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Private089 immutable journal. Only receipt-queries objects; no original journal writes. */
import { createHash } from 'node:crypto';
import {copy} from './service-common.mjs';

const BUCKET = 'brufap-fiscal-artifacts';
const MAX_BYTES = 512000, MAX_JSON = 8192, MAX_CALL_MS = 30000;
const SHA = '[a-f0-9]{64}', UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const OBJECT = new RegExp(`^receipt-queries/${UUID}/(requests|responses|processed|observations)/(${SHA})\\.(xml|json)$`);
const validPath = key => { const m=OBJECT.exec(key);return m!==null&&(m[1]==='observations'?m[3]==='json':m[3]==='xml'); };
const expectedPathHash = key => { const m=OBJECT.exec(key);return m&&['requests','processed'].includes(m[1])?m[2]:null; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class ReceiptQueryStorageError extends Error {
  constructor(code) { super(code); this.name = 'ReceiptQueryStorageError'; this.code = code; }
}
const need = (value, code) => { if (!value) throw new ReceiptQueryStorageError(code); };
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch { /* Cleanup cannot expose driver errors. */ } };

function captureInput(input, writing) {
  const keys = writing ? ['bucket', 'key', 'bytes', 'sha256', 'contentType', 'upsert', 'ifNoneMatch', 'signal', 'deadline']
    : ['bucket', 'key', 'signal', 'deadline'];
  need(plain(input), 'RECEIPT_QUERY_STORAGE_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  need(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(descriptors[key], 'value')), 'RECEIPT_QUERY_STORAGE_INPUT_INVALID');
  // Read each own data property once. Accessors and inherited/unknown options
  // cannot change the destination, signal or bytes after validation.
  const values = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) values[key] = descriptor.value;
  const { bucket, key, signal, deadline } = values;
  need(bucket === BUCKET && typeof key === 'string' && validPath(key), 'RECEIPT_QUERY_STORAGE_INPUT_INVALID');
  need(signal === undefined || signal instanceof AbortSignal, 'RECEIPT_QUERY_STORAGE_SIGNAL_INVALID');
  const now = Date.now();
  need(Number.isSafeInteger(deadline) && deadline > now, 'RECEIPT_QUERY_STORAGE_DEADLINE_INVALID');
  need(!signal?.aborted, 'RECEIPT_QUERY_STORAGE_ABORTED');
  const maxBytes = key.includes('/observations/')?8192:MAX_BYTES;
  let body;
  if (writing) {
    need(key.startsWith('receipt-queries/') && values.bytes instanceof Uint8Array && typeof values.sha256==='string' && /^[a-f0-9]{64}$/.test(values.sha256)
      && values.contentType === 'application/octet-stream' && values.upsert === false && values.ifNoneMatch === '*', 'RECEIPT_QUERY_STORAGE_WRITE_INVALID');
    body = copy(values.bytes,maxBytes);
    if (hash(body) !== values.sha256 || expectedPathHash(key)!==null && hash(body)!==expectedPathHash(key)) {
      body.fill(0);
      throw new ReceiptQueryStorageError('RECEIPT_QUERY_STORAGE_HASH_CONFLICT');
    }
  }
  return Object.freeze({ key, signal, body, maxBytes, end: Math.min(deadline, now + MAX_CALL_MS) });
}

export function createReceiptQueryStorage(configuration) {
  let values;try { need(plain(configuration),'RECEIPT_QUERY_STORAGE_CONFIG_INVALID');const d=Object.getOwnPropertyDescriptors(configuration);need(['projectUrl','serviceKey','fetchImpl'].every(k=>Object.hasOwn(d,k))&&Reflect.ownKeys(d).every(k=>typeof k==='string'&&['projectUrl','serviceKey','fetchImpl','supabaseDeployment'].includes(k)&&Object.hasOwn(d[k],'value')),'RECEIPT_QUERY_STORAGE_CONFIG_INVALID');values=Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v.value])); }catch { throw new ReceiptQueryStorageError('RECEIPT_QUERY_STORAGE_CONFIG_INVALID'); }
  const {projectUrl,supabaseDeployment='hosted',serviceKey,fetchImpl}=values;
  need(isConfiguredBackendOrigin(projectUrl,supabaseDeployment), 'RECEIPT_QUERY_STORAGE_PROJECT_INVALID');
  need(typeof serviceKey === 'string' && serviceKey.length >= 20 && serviceKey.length <= 8192 && /^[!-~]+$/.test(serviceKey), 'RECEIPT_QUERY_STORAGE_CREDENTIAL_INVALID');
  need(typeof fetchImpl === 'function', 'RECEIPT_QUERY_STORAGE_DRIVER_REQUIRED');

  async function execute(input, writing) {
    let captured;
    try { captured = captureInput(input, writing); }
    catch (error) {
      if (error instanceof ReceiptQueryStorageError) throw error;
      throw new ReceiptQueryStorageError('RECEIPT_QUERY_STORAGE_INPUT_INVALID');
    }
    const { key, signal, body, maxBytes, end } = captured;
    input = undefined; // Do not retain or consult the caller's argument object during I/O.
    const url = `${projectUrl}/storage/v1/object/${writing ? '' : 'authenticated/'}${BUCKET}/${key}`;
    const controller = new AbortController();
    let timer, response, reader, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });stopped.catch(()=>{});
    const stop = code => { controller.abort(); rejectStop(new ReceiptQueryStorageError(code)); };
    const onAbort = () => stop('RECEIPT_QUERY_STORAGE_ABORTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('RECEIPT_QUERY_STORAGE_TIMEOUT'), Math.max(1, end - Date.now()));
    const check = () => {
      need(!signal?.aborted, 'RECEIPT_QUERY_STORAGE_ABORTED');
      need(Date.now() < end && !controller.signal.aborted, 'RECEIPT_QUERY_STORAGE_TIMEOUT');
    };
    const bounded = async fn => { check(); return Promise.race([Promise.resolve().then(() => { check(); return fn(); }), stopped]); };
    async function bytesOf(limit) {
      const encoding = response.headers.get('content-encoding'), length = response.headers.get('content-length');
      need((encoding === null || encoding === 'identity') && (length === null || /^\d+$/.test(length) && Number(length) <= limit), 'RECEIPT_QUERY_STORAGE_BODY_INVALID');
      if (!response.body) return Buffer.alloc(0);
      reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const item = await bounded(() => reader.read());
          if (item.done) break;
          need(item.value instanceof Uint8Array && item.value.length > 0 && (size += item.value.length) <= limit, 'RECEIPT_QUERY_STORAGE_BODY_LIMIT');
          chunks.push(Buffer.from(item.value));
        }
        need(length === null || Number(length) === size, 'RECEIPT_QUERY_STORAGE_BODY_INVALID');
        check(); return Buffer.concat(chunks, size);
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        try { void reader.cancel().catch(() => {}); } catch {} try { reader.releaseLock(); } catch {} reader = undefined;
      }
    }
    async function errorCode() {
      need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''), 'RECEIPT_QUERY_STORAGE_HTTP_REJECTED');
      const bytes = await bytesOf(MAX_JSON);
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        need(plain(value), 'RECEIPT_QUERY_STORAGE_HTTP_REJECTED');
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
        || response.url === url), 'RECEIPT_QUERY_STORAGE_RESPONSE_INVALID');
      need(response.status < 300 || response.status >= 400, 'RECEIPT_QUERY_STORAGE_REDIRECT_REJECTED');
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
        throw new ReceiptQueryStorageError('RECEIPT_QUERY_STORAGE_HTTP_REJECTED');
      }
      if ([400, 404].includes(response.status)) {
        const code = await errorCode();
        // The authenticated endpoint also wraps a missing key in HTTP400 with
        // statusCode404. Require both exact structured fields for that legacy
        // transport shape; generic bad requests or free text are never absence.
        if (code.code === 'NoSuchKey' && (response.status === 404
          || code.statusCode === '404' || code.statusCode === 404)) return null;
        // Missing bucket, denied access or an ambiguous legacy 404 is not an absent XML.
        throw new ReceiptQueryStorageError('RECEIPT_QUERY_STORAGE_HTTP_REJECTED');
      }
      need(response.status === 200 && response.headers.get('content-type') === 'application/octet-stream', 'RECEIPT_QUERY_STORAGE_HTTP_REJECTED');
      const bytes = await bytesOf(maxBytes);
      try {
        need(bytes.length > 0, 'RECEIPT_QUERY_STORAGE_BODY_INVALID');
        const expected = expectedPathHash(key);
        need(expected===null || hash(bytes) === expected, 'RECEIPT_QUERY_STORAGE_HASH_CONFLICT');
        check();
        return new Response(new Uint8Array(bytes), { status: 200, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store',
        } });
      } finally { bytes.fill(0); }
    } catch (error) {
      if (error instanceof ReceiptQueryStorageError) throw error;
      throw new ReceiptQueryStorageError('RECEIPT_QUERY_STORAGE_IO_FAILED');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
      if (reader) { try { void reader.cancel().catch(() => {}); } catch {} try { reader.releaseLock(); } catch {} }
      else cancel(response?.body);
      body?.fill(0);
    }
  }
  return Object.freeze({ putImmutable: input => execute(input, true), read: input => execute(input, false) });
}
