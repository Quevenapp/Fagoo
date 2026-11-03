import {mutationPath as authorizationMutationPath} from '../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
import {verifyRuntimeRequest as verifyAuthorizationRequest} from '../../../packages/fiscal-authorization-runtime/src/auth.mjs';
import {route as authorizationRoute,need as authorizationNeed,AuthorizationRuntimeError,ERROR_CODES as AUTHORIZATION_ERROR_CODES} from '../../../packages/fiscal-authorization-runtime/src/protocol.mjs';
import { verifyRuntimeRequest } from '../../../packages/fiscal-runtime/src/auth.mjs';
import { need, RuntimeError, route } from '../../../packages/fiscal-runtime/src/protocol.mjs';
import {verifyRuntimeRequest as verifySignedRequest} from '../../../packages/fiscal-signed-runtime/src/auth.mjs';
import {route as signedRoute,SignedRuntimeError} from '../../../packages/fiscal-signed-runtime/src/protocol.mjs';
import {verifyRuntimeRequest as verifyWsdlRequest} from '../../../packages/fiscal-wsdl-runtime/src/auth.mjs';
import {route as wsdlRoute,need as wsdlNeed,WsdlRuntimeError,ERROR_CODES as WSDL_ERROR_CODES} from '../../../packages/fiscal-wsdl-runtime/src/protocol.mjs';
import {verifyRuntimeRequest as verifyReconciliationRequest} from '../../../packages/fiscal-reconciliation-runtime/src/auth.mjs';
import {route as reconciliationRoute,need as reconciliationNeed,ReconciliationRuntimeError,ERROR_CODES as RECONCILIATION_ERROR_CODES} from '../../../packages/fiscal-reconciliation-runtime/src/protocol.mjs';
import {verifyRuntimeRequest as verifyDanfeRequest} from '../../../packages/fiscal-danfe-runtime/src/auth.mjs';
import {verifyRuntimeRequest as verifyProcessedDanfeRequest} from '../../../packages/fiscal-danfe-runtime/src/processed-auth.mjs';
import {route as processedDanfeRoute} from '../../../packages/fiscal-danfe-runtime/src/processed-protocol.mjs';
import {route as danfeRoute,need as danfeNeed,DanfeRuntimeError,ERROR_CODES as DANFE_ERROR_CODES} from '../../../packages/fiscal-danfe-runtime/src/protocol.mjs';
const RUNTIME_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'A1_TRANSPORT_SECRET', 'A1_TRANSPORT_KEY_ID', 'A1_AUDIENCE', 'A1_FINGERPRINT_SECRET', 'A1_KEK_RING_JSON', 'A1_CURRENT_KEK_ID'];
const STARTUP_TIMEOUT_MS=40000;
const unavailable=()=>new RuntimeError(503,'A1_UPSTREAM_UNAVAILABLE');
function cancel(body){try{void body?.cancel().catch(()=>{});}catch{/* No readiness payload is retained. */}}
/** Cancel one waiter without cancelling the shared startup or forwarding a late request. */
function abortable(action,signal){
 if(signal.aborted)return Promise.reject(unavailable());
 return new Promise((resolve,reject)=>{
  let stopped=false;const stop=()=>{stopped=true;signal.removeEventListener('abort',stop);reject(unavailable());};signal.addEventListener('abort',stop,{once:true});
  Promise.resolve().then(()=>{if(signal.aborted)throw unavailable();return action();}).then(value=>{signal.removeEventListener('abort',stop);if(stopped)cancel(value?.body);else resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
 });
}
function transport(value) {
  need(typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value), 503, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  need(bytes.length === 32 && btoa(String.fromCharCode(...bytes)) === value, 503, 'A1_RUNTIME_CONFIGURATION_INVALID'); return bytes;
}
/** Private service-binding adapter. A single fixed DO name prevents user-selected container creation. */
export function createContainerBridge(ctx, env, { now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), diagnostic = value => console.warn(value) } = {}) {
  let starting;
  async function ready() {
    const began = now(),deadline=began+STARTUP_TIMEOUT_MS,stop=new AbortController(),timer=setTimeout(()=>stop.abort(),STARTUP_TIMEOUT_MS); let phase = 'configuration';
    const remaining=()=>{const value=deadline-now();if(stop.signal.aborted||value<=0)throw unavailable();return value;};
    try {
    const container = ctx.container;
    need(container && typeof container.start === 'function', 503, 'A1_RUNTIME_CONFIGURATION_INVALID');
    if (!container.running) {
      need(RUNTIME_ENV.every(name => typeof env[name] === 'string' && env[name].length > 0), 503, 'A1_RUNTIME_CONFIGURATION_INVALID');
      phase = 'start';
      container.start({ image: container.images.base, instance: { vcpu: 0.25, memoryMib: 1024, diskMb: 4000 }, enableInternet: true,
        env: { ...Object.fromEntries(RUNTIME_ENV.map(name => [name, env[name]])), SUPABASE_DEPLOYMENT: env.SUPABASE_DEPLOYMENT ?? 'hosted', PORT: '8080', A1_OPENSSL_PATH: '/usr/bin/openssl', A1_ALLOW_LEGACY_PFX: env.A1_ALLOW_LEGACY_PFX === 'true' ? 'true' : 'false', FISCAL_PROTOCOL_ENABLED: env.FISCAL_PROTOCOL_ENABLED === 'true' ? 'true' : 'false', FISCAL_AUTHORIZATION_REVIEWED_ENABLED: env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED === 'true' ? 'true' : 'false', FISCAL_RECEIPT_QUERY_ENABLED: env.FISCAL_RECEIPT_QUERY_ENABLED === 'true' ? 'true' : 'false' } });
    }
    phase = 'inactivity';
    await abortable(()=>container.setInactivityTimeout(60000),stop.signal);remaining();
    phase = 'port';
    const port = container.getTcpPort(8080);
    phase = 'readiness';
    while (remaining()>0) {
      const probeDeadline=now()+Math.min(500,remaining()),probe=new AbortController(),end=()=>probe.abort(),probeTimer=setTimeout(end,Math.max(1,probeDeadline-now()));stop.signal.addEventListener('abort',end,{once:true});
      let result;
      try {
        // A deliberate unauthenticated request must be rejected by our application, not reveal configuration.
        result = await abortable(()=>port.fetch('http://container/internal/v1/a1', { signal: probe.signal }),probe.signal);remaining();if(now()>=probeDeadline)throw unavailable();
        if (result.status === 401 && result.headers.get('x-content-type-options') === 'nosniff') return port;
      } catch { /* No transport diagnostics or environment enter logs/responses. */ }
      finally{clearTimeout(probeTimer);stop.signal.removeEventListener('abort',end);probe.abort();cancel(result?.body);}
      await abortable(()=>wait(Math.min(200,remaining())),stop.signal);
    }
    throw new RuntimeError(503, 'A1_UPSTREAM_UNAVAILABLE');
    } catch (error) {
      // Fixed phase and timing only: never log platform errors, request data or environment.
      try { diagnostic(JSON.stringify({event:'fiscal_container_start_failed',phase,elapsed_ms:Math.max(0,Math.min(120000,Math.trunc(now()-began))),type_error:error instanceof TypeError})); } catch {}
      throw error;
    } finally{clearTimeout(timer);stop.abort();}
  }
  return async request => {
    let secret,authorization=false,signed=false,wsdl=false,reconciliation=false,danfe=false,recoveryRequired=false;
    try {
      const url = new URL(request.url);
      authorization=url.pathname==='/internal/v1/fiscal-authorization'||url.pathname.startsWith('/internal/v1/fiscal-authorization/');
      signed=url.pathname==='/internal/v1/fiscal-signed'||url.pathname.startsWith('/internal/v1/fiscal-signed/');
      wsdl=url.pathname==='/internal/v1/fiscal-wsdl'||url.pathname.startsWith('/internal/v1/fiscal-wsdl/');
      reconciliation=url.pathname==='/internal/v1/fiscal-reconciliation'||url.pathname.startsWith('/internal/v1/fiscal-reconciliation/');
      danfe=url.pathname==='/internal/v1/fiscal-danfe'||url.pathname.startsWith('/internal/v1/fiscal-danfe/');
      const processedDanfe=url.pathname.startsWith('/internal/v1/fiscal-danfe/authorizations/')||url.pathname.startsWith('/internal/v1/fiscal-danfe/revalidations/')||url.pathname.startsWith('/internal/v1/fiscal-danfe/receipt-queries/');
      recoveryRequired=request.method==='POST'&&(authorization?authorizationMutationPath(url.pathname,request.method):['/internal/v1/fiscal-reconciliation/run','/internal/v1/fiscal-reconciliation/recover'].includes(url.pathname));
      (authorization?authorizationNeed:danfe?danfeNeed:reconciliation?reconciliationNeed:wsdl?wsdlNeed:need)(url.origin === 'https://fiscal-runtime.internal' && !url.search && !url.hash, 400, authorization?'AUTHORIZATION_INVALID_REQUEST':danfe?'DANFE_INVALID_REQUEST':reconciliation?'RECONCILIATION_INVALID_REQUEST':wsdl?'WSDL_INVALID_REQUEST':'A1_INVALID_REQUEST');
      if(authorization)authorizationRoute(url.pathname,request.method);else if(danfe)(processedDanfe?processedDanfeRoute:danfeRoute)(url.pathname,request.method);else if(reconciliation)reconciliationRoute(url.pathname,request.method);else if(wsdl)wsdlRoute(url.pathname,request.method);else if(signed)signedRoute(url.pathname,request.method);else route(url.pathname, request.method);
      secret = transport(env.A1_TRANSPORT_SECRET);
      const verify=()=> (authorization?verifyAuthorizationRequest:danfe?(processedDanfe?verifyProcessedDanfeRequest:verifyDanfeRequest):reconciliation?verifyReconciliationRequest:wsdl?verifyWsdlRequest:signed?verifySignedRequest:verifyRuntimeRequest)({ header: request.headers.get('authorization'), secretBytes: secret, keyId: env.A1_TRANSPORT_KEY_ID, audience: authorization?`${env.A1_AUDIENCE}-authorization`:danfe?`${env.A1_AUDIENCE}-danfe`:reconciliation?`${env.A1_AUDIENCE}-reconciliation`:wsdl?`${env.A1_AUDIENCE}-wsdl`:signed?`${env.A1_AUDIENCE}-signed`:env.A1_AUDIENCE, method: request.method, path: url.pathname, now: now() });
      await verify();if(request.signal.aborted)throw unavailable();
      starting ??= ready().finally(() => { starting = undefined; });
      const shared=starting,port = await abortable(()=>shared,request.signal);
      if(request.signal.aborted)throw unavailable();await verify();if(request.signal.aborted)throw unavailable();
      const forwarded = new Request(`http://container${url.pathname}`, request); forwarded.headers.delete('host');
      return await port.fetch(forwarded);
    } catch (error) {
      if(authorization){
        const known=error instanceof AuthorizationRuntimeError&&AUTHORIZATION_ERROR_CODES.includes(error.code)&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599;
        const configuration=error instanceof RuntimeError&&error.code==='A1_RUNTIME_CONFIGURATION_INVALID';
        return Response.json({error:known?error.code:configuration?'AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID':'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:recoveryRequired},
          {status:known?error.status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      if(danfe){
        const known=error instanceof DanfeRuntimeError&&DANFE_ERROR_CODES.includes(error.code)&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599;
        const configuration=error instanceof RuntimeError&&error.code==='A1_RUNTIME_CONFIGURATION_INVALID';
        return Response.json({error:known?error.code:configuration?'DANFE_RUNTIME_CONFIGURATION_INVALID':'DANFE_UPSTREAM_UNAVAILABLE',recovery_required:false},
          {status:known?error.status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      if(reconciliation){
        const known=error instanceof ReconciliationRuntimeError&&RECONCILIATION_ERROR_CODES.includes(error.code)&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599;
        const configuration=error instanceof RuntimeError&&error.code==='A1_RUNTIME_CONFIGURATION_INVALID';
        return Response.json({error:known?error.code:configuration?'RECONCILIATION_RUNTIME_CONFIGURATION_INVALID':'RECONCILIATION_UPSTREAM_UNAVAILABLE',recovery_required:recoveryRequired},
          {status:known?error.status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      if(wsdl){
        const known=error instanceof WsdlRuntimeError&&WSDL_ERROR_CODES.includes(error.code)&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599;
        const configuration=error instanceof RuntimeError&&error.code==='A1_RUNTIME_CONFIGURATION_INVALID';
        return Response.json({error:known?error.code:configuration?'WSDL_RUNTIME_CONFIGURATION_INVALID':'WSDL_UPSTREAM_UNAVAILABLE',recovery_required:request.method==='POST'},
          {status:known?error.status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      const known=error instanceof RuntimeError||error instanceof SignedRuntimeError;
      return Response.json({ error: known ? error.code : signed?'SIGNED_UPSTREAM_UNAVAILABLE':'A1_UPSTREAM_UNAVAILABLE', recovery_required: request.method === 'POST' }, { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } finally { secret?.fill(0); }
  };
}
