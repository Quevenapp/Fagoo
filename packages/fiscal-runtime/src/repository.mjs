import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
import { RuntimeError, need, uuid, sha256, readBounded } from './protocol.mjs';
import { digest } from './auth.mjs';

const RPCS = new Set(['authorize', 'metadata', 'reserve', 'finalize', 'reject', 'disable', 'command']);
const MAX_ENVELOPE = 1500000;
function objectPath(credentialId, hash) {
  need(uuid(credentialId) && sha256(hash), 502, 'A1_STORAGE_REFERENCE_INVALID');
  return `credentials/${credentialId}/${hash}.json`;
}
function statusError(status, code) {
  if (status === 401 || status === 403 || code === '42501') return new RuntimeError(403, 'A1_FORBIDDEN');
  if (status === 404 || code === 'P0002') return new RuntimeError(404, 'A1_NOT_FOUND');
  if (status === 409 || ['40001', '23505'].includes(code)) return new RuntimeError(409, 'A1_CONFLICT');
  if (code === '22023') return new RuntimeError(400, 'A1_INVALID_REQUEST');
  return new RuntimeError(503, 'A1_UPSTREAM_UNAVAILABLE');
}
/** This adapter belongs only to the isolated runtime, never the general ERP Worker. */
export function createRepository({ supabaseUrl, supabaseDeployment = 'hosted', serviceKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = new URL(supabaseUrl);
  need(isConfiguredBackendOrigin(supabaseUrl, supabaseDeployment, { allowTrailingSlash: true, legacyHosted: true }) &&
    typeof serviceKey === 'string' && serviceKey.length >= 20 && serviceKey.length <= 4096 && !/[\r\n]/.test(serviceKey), 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  async function request(path, { method = 'GET', body, type = 'application/json', limit = 65536, signal, accepted = [200] } = {}) {
    const abort = new AbortController(); let timer;
    const cancel = () => abort.abort();
    need(!signal?.aborted, 503, 'A1_UPSTREAM_UNAVAILABLE');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      timer = setTimeout(cancel, timeoutMs);
      const response = await fetchImpl(`${base.origin}${path}`, { method, headers: { ...headers, 'Content-Type': type, 'x-upsert': 'false' }, body, redirect: 'error', signal: abort.signal });
      const bytes = await readBounded(response, { limit: accepted.includes(response.status) ? limit : 32768, timeoutMs, decodedResponse: true });
      need(!abort.signal.aborted, 503, 'A1_UPSTREAM_UNAVAILABLE');
      if (!accepted.includes(response.status)) {
        let code; try { code = JSON.parse(new TextDecoder().decode(bytes)).code; } catch { /* No upstream diagnostics cross this boundary. */ }
        bytes.fill(0); throw statusError(response.status, code);
      }
      return { bytes, status: response.status, type: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() };
    } catch (error) { throw error instanceof RuntimeError ? error : new RuntimeError(503, 'A1_UPSTREAM_UNAVAILABLE'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  return {
    async rpc(name, args, { signal } = {}) {
      need(RPCS.has(name), 500, 'A1_RPC_UNSUPPORTED');
      const { bytes } = await request(`/rest/v1/rpc/erp_a1_${name}`, { method: 'POST', body: JSON.stringify(args), signal });
      try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
      catch { throw new RuntimeError(502, 'A1_RESPONSE_INVALID'); }
      finally { bytes.fill(0); }
    },
    async readObject(reference, { signal } = {}) {
      need(reference && reference.bucket === 'brufap-a1-vault' && sha256(reference.hash) && Number.isInteger(reference.size) && reference.size >= 1 && reference.size <= MAX_ENVELOPE &&
        typeof reference.path === 'string' && /^credentials\/[a-f0-9-]{36}\/[a-f0-9]{64}\.json$/.test(reference.path), 502, 'A1_STORAGE_REFERENCE_INVALID');
      const parts = reference.path.split('/');
      need(reference.path === objectPath(parts[1], reference.hash), 502, 'A1_STORAGE_REFERENCE_INVALID');
      const { bytes, type } = await request(`/storage/v1/object/authenticated/brufap-a1-vault/${reference.path}`, { limit: MAX_ENVELOPE, signal });
      if (type !== 'application/json' || bytes.length !== reference.size || await digest(bytes) !== reference.hash) {
        bytes.fill(0); throw new RuntimeError(502, 'A1_STORAGE_VALIDATION_FAILED');
      }
      return bytes;
    },
    async storeObject(credentialId, bytes, { signal } = {}) {
      need(bytes instanceof Uint8Array && bytes.length >= 1 && bytes.length <= MAX_ENVELOPE, 500, 'A1_ENVELOPE_INVALID');
      const hash = await digest(bytes), path = objectPath(credentialId, hash);
      // An uncertain upload can be recovered only by reading the exact content-addressed object.
      let uploadError;
      try { const result = await request(`/storage/v1/object/brufap-a1-vault/${path}`, { method: 'POST', body: bytes, limit: 32768, signal }); result.bytes.fill(0); }
      catch (error) { uploadError = error; }
      const reference = { bucket: 'brufap-a1-vault', path, hash, size: bytes.length };
      try { const stored = await this.readObject(reference, { signal }); stored.fill(0); }
      catch (error) { throw uploadError || error; }
      return reference;
    },
  };
}
