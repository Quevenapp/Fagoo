export const MAX_CONFIGURE_BYTES = 16 + 4096 + 1048576 + 1024;
export const MAX_JSON_BYTES = 4096;
export const CONFIGURE_TYPE = 'application/vnd.brufap.a1+octet-stream';
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const uuid = value => typeof value === 'string' && UUID.test(value);
export const sha256 = value => typeof value === 'string' && HASH.test(value);
export class RuntimeError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
export function need(condition, status, code) { if (!condition) throw new RuntimeError(status, code); }
export function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function version(value, min = 0) { return Number.isInteger(value) && value >= min && value <= 2147483647; }
export function reason(value) { return typeof value === 'string' && [...value].length >= 3 && [...value].length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value) && /\S/u.test(value); }
export function route(path, method, prefix = '/internal/v1/a1') {
  let action, commandId = null;
  if (path === prefix && method === 'GET') action = 'metadata';
  else if (path === `${prefix}/configure` && method === 'POST') action = 'configure';
  else if (path === `${prefix}/rewrap` && method === 'POST') action = 'rewrap';
  else if (path === `${prefix}/disable` && method === 'POST') action = 'disable';
  else if (method === 'GET' && path.startsWith(`${prefix}/commands/`) && UUID.test(path.slice(`${prefix}/commands/`.length))) {
    action = 'command'; commandId = path.slice(`${prefix}/commands/`.length);
  }
  need(action, 404, 'A1_NOT_FOUND');
  return { action, commandId, path, method, limit: action === 'configure' ? MAX_CONFIGURE_BYTES : method === 'POST' ? MAX_JSON_BYTES : 0 };
}
export async function readBounded(request, { limit, timeoutMs = 10000, decodedResponse = false } = {}) {
  const length = request.headers.get('content-length'), encoding = request.headers.get('content-encoding');
  need(decodedResponse || encoding === null || encoding.trim().toLowerCase() === 'identity', 400, 'A1_ENCODING_UNSUPPORTED');
  need(length === null || /^\d+$/.test(length) && Number(length) <= limit, 413, 'A1_BODY_TOO_LARGE');
  if (!request.body) { need(!length || Number(length) === 0, 400, 'A1_BODY_INVALID'); return new Uint8Array(); }
  const reader = request.body.getReader(), chunks = []; let size = 0, timer, stopped = false;
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (stopped) { value?.fill(0); throw new RuntimeError(408, 'A1_BODY_TIMEOUT'); }
      if (done) break;
      size += value.length;
      if (size > limit) { value.fill(0); throw new RuntimeError(413, 'A1_BODY_TOO_LARGE'); }
      chunks.push(value);
    }
    need(decodedResponse || length === null || Number(length) === size, 400, 'A1_BODY_INVALID');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  })();
  try { return await Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => { stopped = true; reject(new RuntimeError(408, 'A1_BODY_TIMEOUT')); }, timeoutMs); })]); }
  finally { stopped = true; clearTimeout(timer); void reader.cancel().catch(() => {}); chunks.forEach(chunk => chunk.fill(0)); }
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
  catch { throw new RuntimeError(400, 'A1_BODY_INVALID'); }
}
export function parseConfigure(bytes) {
  need(bytes instanceof Uint8Array && bytes.length >= 16 && bytes.length <= MAX_CONFIGURE_BYTES, 400, 'A1_BODY_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  need(view.getUint32(0) === 0x42413100, 400, 'A1_BODY_INVALID');
  const metaSize = view.getUint32(4), pfxSize = view.getUint32(8), passwordSize = view.getUint32(12);
  need(metaSize > 0 && metaSize <= 4096 && pfxSize > 0 && pfxSize <= 1048576 && passwordSize > 0 && passwordSize <= 1024 &&
    bytes.length === 16 + metaSize + pfxSize + passwordSize, 400, 'A1_BODY_INVALID');
  const metadata = json(bytes.subarray(16, 16 + metaSize));
  need(exact(metadata, ['command_id', 'expected_version', 'expected_identity_version', 'reason']) && uuid(metadata.command_id) &&
    version(metadata.expected_version) && version(metadata.expected_identity_version, 1) && reason(metadata.reason), 400, 'A1_BODY_INVALID');
  return { ...metadata, pfxBytes: bytes.subarray(16 + metaSize, 16 + metaSize + pfxSize), passwordBytes: bytes.subarray(16 + metaSize + pfxSize) };
}
export function parseCommand(bytes, action) {
  const data = json(bytes);
  const keys = ['command_id', 'expected_version', 'reason', ...(action === 'rewrap' ? ['expected_identity_version'] : [])];
  need(exact(data, keys) && uuid(data.command_id) && version(data.expected_version) && reason(data.reason) &&
    (action !== 'rewrap' || version(data.expected_identity_version, 1)), 400, 'A1_BODY_INVALID');
  return data;
}
/** Intended for the future administrative UI; returned buffers must be wiped after sending. */
export function encodeConfigure({ command_id, expected_version, expected_identity_version, reason: why, pfxBytes, passwordBytes }) {
  const metadata = new TextEncoder().encode(JSON.stringify({ command_id, expected_version, expected_identity_version, reason: why }));
  need(pfxBytes instanceof Uint8Array && passwordBytes instanceof Uint8Array, 400, 'A1_BODY_INVALID');
  need(metadata.length <= 4096 && pfxBytes.length > 0 && pfxBytes.length <= 1048576 && passwordBytes.length > 0 && passwordBytes.length <= 1024, 400, 'A1_BODY_INVALID');
  const result = new Uint8Array(16 + metadata.length + pfxBytes.length + passwordBytes.length), view = new DataView(result.buffer);
  view.setUint32(0, 0x42413100); view.setUint32(4, metadata.length); view.setUint32(8, pfxBytes.length); view.setUint32(12, passwordBytes.length);
  result.set(metadata, 16); result.set(pfxBytes, 16 + metadata.length); result.set(passwordBytes, 16 + metadata.length + pfxBytes.length);
  parseConfigure(result); return result;
}
