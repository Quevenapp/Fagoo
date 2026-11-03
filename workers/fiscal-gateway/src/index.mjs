import { isConfiguredBackendOrigin } from '../../../packages/backend-config/src/origin.mjs';
import {createAuthorizationGateway} from '../../../packages/fiscal-authorization-runtime/src/gateway.mjs';
import { need, RuntimeError, route, readBounded, CONFIGURE_TYPE, uuid } from '../../../packages/fiscal-runtime/src/protocol.mjs';
import { digest, signRuntimeRequest } from '../../../packages/fiscal-runtime/src/auth.mjs';
import { publicResult } from '../../../packages/fiscal-runtime/src/dto.mjs';
import { createUnsignedGateway } from './unsigned.mjs';
import {createSignedGateway} from '../../../packages/fiscal-signed-runtime/src/gateway.mjs';
import {createWsdlGateway} from '../../../packages/fiscal-wsdl-runtime/src/gateway.mjs';
import {createReconciliationGateway} from '../../../packages/fiscal-reconciliation-runtime/src/gateway.mjs';
import {createDanfeGateway} from '../../../packages/fiscal-danfe-runtime/src/gateway.mjs';
import {createProcessedGateway} from '../../../packages/fiscal-danfe-runtime/src/processed-gateway.mjs';

const SECURITY = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' };
const ERRORS = new Set(['A1_RUNTIME_UNAUTHORIZED', 'A1_BODY_AUTHENTICATION_FAILED', 'A1_FORBIDDEN', 'A1_NOT_FOUND', 'A1_CONFLICT', 'A1_INVALID_REQUEST', 'A1_RUNTIME_BUSY', 'A1_UPSTREAM_UNAVAILABLE', 'A1_COMPANY_CHANGED', 'A1_KEY_ROTATION_UNAVAILABLE', 'A1_LEASE_EXPIRED', 'A1_CREDENTIAL_REJECTED', 'A1_RUNTIME_FAILED', 'A1_RESPONSE_INVALID', 'A1_STORAGE_VALIDATION_FAILED', 'A1_BODY_TOO_LARGE', 'A1_BODY_TIMEOUT', 'A1_BODY_INVALID', 'A1_ENCODING_UNSUPPORTED', 'A1_CONTENT_TYPE_UNSUPPORTED']);
function key(value) {
  need(typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value), 503, 'A1_GATEWAY_UNAVAILABLE');
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  need(bytes.length === 32 && btoa(String.fromCharCode(...bytes)) === value, 503, 'A1_GATEWAY_UNAVAILABLE'); return bytes;
}
function origins(value) {
  const list = typeof value === 'string' ? value.split(',').map(v => v.trim()) : [];
  need(list.length >= 1 && list.length <= 5 && list.every(value => { try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password; } catch { return false; } }), 503, 'A1_GATEWAY_UNAVAILABLE');
  return list;
}
/** A dedicated binding, not a route added to the general ERP API. It never receives a KEK. */
export function createGateway({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, nonce = () => crypto.randomUUID() } = {}) {
  return async (request, env) => {
    let bytes, secret, allowedOrigin = null, timer, abort, failure = 'A1_GATEWAY_UNAVAILABLE';
    const reply = (value, status = 200, extra = {}) => new Response(value === null ? null : JSON.stringify(value), { status, headers: { ...SECURITY, ...(value === null ? {} : { 'Content-Type': 'application/json' }), ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {}), ...extra } });
    try {
      const origin = request.headers.get('origin');
      need(origin && origins(env.ALLOWED_ORIGINS).includes(origin), 403, 'A1_ORIGIN_FORBIDDEN'); allowedOrigin = origin;
      const url = new URL(request.url);
      need(!url.search && !url.hash && !url.username && !url.password, 400, 'A1_INVALID_REQUEST');
      const effectiveMethod = request.method === 'OPTIONS' ? request.headers.get('access-control-request-method') : request.method;
      const selected = route(url.pathname, effectiveMethod, '/v1/a1');
      if (request.method === 'OPTIONS') {
        const requested = (request.headers.get('access-control-request-headers') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
        need(requested.every(x => ['authorization', 'content-type'].includes(x)), 403, 'A1_ORIGIN_FORBIDDEN');
        return reply(null, 204, { 'Access-Control-Allow-Methods': effectiveMethod, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '300' });
      }
      need(env.A1_RUNTIME && typeof env.A1_RUNTIME.fetch === 'function', 503, 'A1_GATEWAY_UNAVAILABLE');
      const base = new URL(env.SUPABASE_URL);
      need(isConfiguredBackendOrigin(env.SUPABASE_URL, env.SUPABASE_DEPLOYMENT, { allowTrailingSlash: true, legacyHosted: true }) &&
        typeof env.SUPABASE_ANON_KEY === 'string' && env.SUPABASE_ANON_KEY.length >= 20 && env.SUPABASE_ANON_KEY.length <= 4096 && !/[\r\n]/.test(env.SUPABASE_ANON_KEY), 503, 'A1_GATEWAY_UNAVAILABLE');
      const bearer = request.headers.get('authorization');
      need(typeof bearer === 'string' && /^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(bearer), 401, 'A1_UNAUTHENTICATED');
      abort = new AbortController(); timer = setTimeout(() => abort.abort(), 55000);
      const authAbort = new AbortController(), authTimer = setTimeout(() => authAbort.abort(), 10000);
      let actor;
      try {
        failure = 'A1_AUTH_SERVICE_UNAVAILABLE';
        const auth = await fetchImpl(`${base.origin}/auth/v1/user`, { headers: { Authorization: bearer, apikey: env.SUPABASE_ANON_KEY }, redirect: 'manual', signal: authAbort.signal });
        failure = 'A1_RESPONSE_INVALID';
        need(auth.status === 200, 401, 'A1_UNAUTHENTICATED');
        const raw = await readBounded(auth, { limit: 262144, timeoutMs: 10000, decodedResponse: true });
        try { const user = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)); need(user?.is_anonymous !== true, 401, 'A1_UNAUTHENTICATED'); actor = user.id; }
        finally { raw.fill(0); }
        need(uuid(actor) && !authAbort.signal.aborted, 401, 'A1_UNAUTHENTICATED');
      } finally { clearTimeout(authTimer); authAbort.abort(); }
      if (request.method === 'POST') need(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === (selected.action === 'configure' ? CONFIGURE_TYPE : 'application/json'), 415, 'A1_CONTENT_TYPE_UNSUPPORTED');
      bytes = await readBounded(request, { limit: selected.limit, timeoutMs: 10000 });
      failure = 'A1_REQUEST_SIGNING_FAILED';
      const path = `/internal${url.pathname}`, bodyHash = await digest(bytes);
      secret = key(env.A1_TRANSPORT_SECRET);
      const authorization = await signRuntimeRequest({ secretBytes: secret, keyId: env.A1_TRANSPORT_KEY_ID, audience: env.A1_AUDIENCE, actor, nonce: nonce(), method: request.method, path, bodyHash, now: now() });
      const internal = new Request(`https://fiscal-runtime.internal${path}`, { method: request.method, headers: { Authorization: authorization, ...(request.method === 'POST' ? { 'Content-Type': selected.action === 'configure' ? CONFIGURE_TYPE : 'application/json' } : {}) }, ...(request.method === 'POST' ? { body: bytes } : {}), redirect: 'manual', signal: abort.signal });
      failure = 'A1_RUNTIME_BINDING_UNAVAILABLE';
      const result = await env.A1_RUNTIME.fetch(internal);
      failure = 'A1_RESPONSE_INVALID';
      const raw = await readBounded(result, { limit: 65536, timeoutMs: 10000, decodedResponse: true });
      let value; try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)); } finally { raw.fill(0); }
      need(!abort.signal.aborted, 503, 'A1_UPSTREAM_UNAVAILABLE');
      if (result.status !== 200) {
        need([400, 401, 403, 404, 408, 409, 413, 415, 422, 500, 502, 503].includes(result.status) && ERRORS.has(value?.error), 502, 'A1_RESPONSE_INVALID');
        return reply({ error: value.error, recovery_required: value.recovery_required === true }, result.status);
      }
      // Determine command binding from the bounded binary/JSON metadata; never return private payload fields.
      let commandId = selected.commandId;
      if (request.method === 'POST') {
        if (selected.action === 'configure') {
          const { parseConfigure } = await import('../../../packages/fiscal-runtime/src/protocol.mjs'); commandId = parseConfigure(bytes).command_id;
        } else {
          const { parseCommand } = await import('../../../packages/fiscal-runtime/src/protocol.mjs'); commandId = parseCommand(bytes, selected.action).command_id;
        }
      }
      return reply(publicResult(value, { action: selected.action, commandId }));
    } catch (error) { return reply({ error: error instanceof RuntimeError ? error.code : failure, recovery_required: Boolean(bytes?.length) }, error instanceof RuntimeError ? error.status : 503); }
    finally { clearTimeout(timer); abort?.abort(); bytes?.fill(0); secret?.fill(0); }
  };
}
const authorizationGateway=createAuthorizationGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
const a1Gateway=createGateway();
const unsignedGateway=createUnsignedGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
const signedGateway=createSignedGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
const wsdlGateway=createWsdlGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
const reconciliationGateway=createReconciliationGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
const danfeGateway=createDanfeGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
const processedDanfeGateway=createProcessedGateway({fetchImpl:(...args)=>globalThis.fetch(...args),now:Date.now,nonce:()=>crypto.randomUUID()});
export default {fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/v1/fiscal-authorization'||path.startsWith('/v1/fiscal-authorization/'))return authorizationGateway(request,env);
 if(path==='/v1/fiscal-unsigned'||path.startsWith('/v1/fiscal-unsigned/'))return unsignedGateway(request,env);
 if(path==='/v1/fiscal-signed'||path.startsWith('/v1/fiscal-signed/'))return signedGateway(request,env);
 if(path==='/v1/fiscal-wsdl'||path.startsWith('/v1/fiscal-wsdl/'))return wsdlGateway(request,env);
 if(path==='/v1/fiscal-reconciliation'||path.startsWith('/v1/fiscal-reconciliation/'))return reconciliationGateway(request,env);
 if(path.startsWith('/v1/fiscal-danfe/authorizations/')||path.startsWith('/v1/fiscal-danfe/revalidations/')||path.startsWith('/v1/fiscal-danfe/receipt-queries/'))return processedDanfeGateway(request,env);
 if(path==='/v1/fiscal-danfe'||path.startsWith('/v1/fiscal-danfe/'))return danfeGateway(request,env);
 return a1Gateway(request,env);
}};
