import {createReceiptQueryComposition} from './receipt-query.mjs';
import {createReviewedDispatchComposition} from './authorization-dispatch.mjs';
import {createAuthorizationRevalidationComposition} from './authorization-revalidation.mjs';
import {createProcessedDocumentComposition} from './processed-document.mjs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createOpenSslLoader } from '../../fiscal-vault/src/index.mjs';
import { createRepository } from './repository.mjs';
import { createRuntimeHandler } from './handler.mjs';
import { need } from './protocol.mjs';
import {createFiscalSignedRpc} from '../../fiscal-signed-rpc/src/rpc.mjs';
import {createFiscalArtifactStorage} from '../../fiscal-artifact-storage/src/storage.mjs';
import {createSignedCustodyPort} from '../../fiscal-signed-custody/src/index.mjs';
import {createFiscalSchemaRunner} from '../../fiscal-schema-runner/src/index.mjs';
import {createSignedRuntimeHandler} from '../../fiscal-signed-runtime/src/handler.mjs';
import {request as httpsRequest} from 'node:https';
import {createWsdlRpc} from '../../fiscal-sefaz-wsdl/src/service-rpc.mjs';
import {createWsdlService,createWsdlPreparationAuthorizer} from '../../fiscal-sefaz-wsdl/src/service.mjs';
import {createWsdlCustodyPort} from './wsdl-custody.mjs';
import {createSpWsdlTlsLoader} from './wsdl-server-trust.mjs';
import {createWsdlRuntimeHandler} from '../../fiscal-wsdl-runtime/src/handler.mjs';
import {createReconciliationRpc} from '../../fiscal-reconciliation/src/rpc.mjs';
import {createReconciliationStorage} from '../../fiscal-reconciliation/src/storage.mjs';
import {createFiscalProtocolRunner} from '../../fiscal-schema-runner/src/protocol.mjs';
import {createProtocolPreparationAuthorizer} from '../../fiscal-reconciliation/src/preparation.mjs';
import {createProtocolTransport} from '../../fiscal-reconciliation/src/protocol-transport.mjs';
import {createReconciliationService} from '../../fiscal-reconciliation/src/service.mjs';
import {createProtocolCustodyPort} from './protocol-custody.mjs';
import {createSpProtocolTlsLoader} from './protocol-server-trust.mjs';
import {createReconciliationRuntimeHandler} from '../../fiscal-reconciliation-runtime/src/handler.mjs';
import {createSubsetReviewService} from '../../fiscal-authorization/src/subset-review-service.mjs';
import {createSubsetReviewRpc} from '../../fiscal-authorization/src/subset-review-rpc.mjs';
import {mutationPath as authorizationMutationPath} from '../../fiscal-authorization-runtime/src/review-protocol.mjs';
import {createAuthorizationReadService} from '../../fiscal-authorization/src/read-service.mjs';
import {createAuthorizationRpc} from '../../fiscal-authorization/src/rpc.mjs';
import {createAuthorizationStorage} from '../../fiscal-authorization/src/storage.mjs';
import {createAuthorizationRuntimeHandler} from '../../fiscal-authorization-runtime/src/handler.mjs';
import {createDanfeRuntimeHandler} from '../../fiscal-danfe-runtime/src/handler.mjs';

function secret(text) {
  need(typeof text === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(text), 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const value = Buffer.from(text, 'base64'); need(value.length === 32 && value.toString('base64') === text, 500, 'A1_RUNTIME_CONFIGURATION_INVALID'); return value;
}
export async function fromEnvironment(env = process.env, {fetchImpl = (...args) => globalThis.fetch(...args)} = {}) {
  let ring;
  try { ring = JSON.parse(env.A1_KEK_RING_JSON); } catch { need(false, 500, 'A1_RUNTIME_CONFIGURATION_INVALID'); }
  need(ring && typeof ring === 'object' && !Array.isArray(ring) && Object.keys(ring).length >= 1 && Object.keys(ring).length <= 5, 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const keyring = new Map(Object.entries(ring).map(([id, value]) => [id, secret(value)]));
  const transportSecret = secret(env.A1_TRANSPORT_SECRET), fingerprintSecret = secret(env.A1_FINGERPRINT_SECRET);
  const all = [...keyring.values(), transportSecret, fingerprintSecret];
  need(new Set(all.map(value => value.toString('hex'))).size === all.length, 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const repository = createRepository({ supabaseUrl: env.SUPABASE_URL, supabaseDeployment: env.SUPABASE_DEPLOYMENT, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl });
  const loader = await createOpenSslLoader({ binaryPath: env.A1_OPENSSL_PATH || '/usr/bin/openssl', allowLegacy: env.A1_ALLOW_LEGACY_PFX === 'true', timeoutMs: 5000 });
  need(env.A1_ALLOW_LEGACY_PFX === undefined || ['true', 'false'].includes(env.A1_ALLOW_LEGACY_PFX), 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const custody = createRuntimeHandler({ repository, loader, transportSecret, transportKeyId: env.A1_TRANSPORT_KEY_ID, audience: env.A1_AUDIENCE,
    fingerprintSecret, keyring, currentKeyId: env.A1_CURRENT_KEK_ID });
  const rpc=createFiscalSignedRpc({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const storage=createFiscalArtifactStorage({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const withAuthorizedSigner=createSignedCustodyPort({readObject:repository.readObject,loader,keyring});
  const validateXsd=createFiscalSchemaRunner({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('../../fiscal-schema/validator.py',import.meta.url))});
  const signed=createSignedRuntimeHandler({rpc,storage,withAuthorizedSigner,validateXsd,transportSecret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-signed`});
  const wsdlRpc=createWsdlRpc({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const wsdlLoader=await createSpWsdlTlsLoader({binaryPath:env.A1_OPENSSL_PATH||'/usr/bin/openssl',allowLegacy:env.A1_ALLOW_LEGACY_PFX==='true',timeoutMs:5000});
  const withPreparedTlsSession=createWsdlCustodyPort({readObject:repository.readObject,loader:wsdlLoader,keyring,
    authorizePreparation:createWsdlPreparationAuthorizer({rpc:wsdlRpc}),
    // Closed, bounded pre-use codes only; no original error or credential data.
    diagnostic:line=>{process.stderr.write(line+'\n');}});
  const wsdlService=createWsdlService({rpc:wsdlRpc,storage,requestImpl:httpsRequest,withPreparedTlsSession});
  const wsdl=createWsdlRuntimeHandler({service:wsdlService,transportSecret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-wsdl`});
  // This separate profile cannot become enabled by truthy or misspelled environment values.
  need(env.FISCAL_PROTOCOL_ENABLED===undefined||['true','false'].includes(env.FISCAL_PROTOCOL_ENABLED),500,'A1_RUNTIME_CONFIGURATION_INVALID');
  const reconciliationRpc=createReconciliationRpc({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const reconciliationStorage=createReconciliationStorage({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const protocolLoader=await createSpProtocolTlsLoader({binaryPath:env.A1_OPENSSL_PATH||'/usr/bin/openssl',allowLegacy:env.A1_ALLOW_LEGACY_PFX==='true',timeoutMs:5000});
  const withPreparedSession=createProtocolCustodyPort({readObject:repository.readObject,loader:protocolLoader,keyring,
    authorizePreparation:createProtocolPreparationAuthorizer({rpc:reconciliationRpc})});
  const validateProtocol=createFiscalProtocolRunner({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('../../fiscal-schema/protocol_validator.py',import.meta.url))});
  const reconciliationService=createReconciliationService({mode:'operational',enabled:env.FISCAL_PROTOCOL_ENABLED==='true',rpc:reconciliationRpc,
    storage:reconciliationStorage,validateProtocol,withPreparedSession,transport:createProtocolTransport({requestImpl:httpsRequest})});
  const reconciliation=createReconciliationRuntimeHandler({service:reconciliationService,transportSecret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-reconciliation`});
  const danfe=createDanfeRuntimeHandler({rpc,storage,transportSecret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-danfe`});
  const processedDanfe=createProcessedDocumentComposition({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl,transportSecret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-danfe`});
  // Read composition has no authorization binding, validator, TLS or credential port.
  const authorizationRpc=createAuthorizationRpc({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const authorizationStorage=createAuthorizationStorage({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const authorizationService=createAuthorizationReadService({rpc:authorizationRpc,storage:{read:authorizationStorage.read}});
  const reviewRpc=createSubsetReviewRpc({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const reviewService=createSubsetReviewService({signedRpc:rpc,reviewRpc,storage:{read:storage.read}});
  need(env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED===undefined||['true','false'].includes(env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED),500,'A1_RUNTIME_CONFIGURATION_INVALID');
  const dispatch=await createReviewedDispatchComposition({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl,signedRpc:rpc,keyring,binaryPath:env.A1_OPENSSL_PATH||'/usr/bin/openssl',allowLegacy:env.A1_ALLOW_LEGACY_PFX==='true',enabled:env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED==='true'});
  const revalidationService=createAuthorizationRevalidationComposition({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  need(env.FISCAL_RECEIPT_QUERY_ENABLED===undefined||['true','false'].includes(env.FISCAL_RECEIPT_QUERY_ENABLED),500,'A1_RUNTIME_CONFIGURATION_INVALID');
  const receiptQuery=await createReceiptQueryComposition({projectUrl:env.SUPABASE_URL,supabaseDeployment:env.SUPABASE_DEPLOYMENT,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl,keyring,binaryPath:env.A1_OPENSSL_PATH||'/usr/bin/openssl',allowLegacy:env.A1_ALLOW_LEGACY_PFX==='true',enabled:env.FISCAL_RECEIPT_QUERY_ENABLED==='true'});
  const authorization=createAuthorizationRuntimeHandler({service:authorizationService,reviewService,dispatch,revalidationService,receiptQueryService:receiptQuery.service,transportSecret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-authorization`});
  let active=0,closed=false;
  const handler=async request=>{
    const path=new URL(request.url).pathname,isAuthorization=path==='/internal/v1/fiscal-authorization'||path.startsWith('/internal/v1/fiscal-authorization/'),isSigned=path==='/internal/v1/fiscal-signed'||path.startsWith('/internal/v1/fiscal-signed/'),
      isWsdl=path==='/internal/v1/fiscal-wsdl'||path.startsWith('/internal/v1/fiscal-wsdl/'),
      isReconciliation=path==='/internal/v1/fiscal-reconciliation'||path.startsWith('/internal/v1/fiscal-reconciliation/'),
      isDanfe=path==='/internal/v1/fiscal-danfe'||path.startsWith('/internal/v1/fiscal-danfe/');
    const recoveryRequired=request.method==='POST'&&(!isAuthorization||authorizationMutationPath(path,request.method))&&(!isReconciliation||['/internal/v1/fiscal-reconciliation/run','/internal/v1/fiscal-reconciliation/recover'].includes(path));
    if(closed||active>=2)return Response.json({error:isAuthorization?'AUTHORIZATION_RUNTIME_BUSY':isDanfe?'DANFE_RUNTIME_BUSY':isReconciliation?'RECONCILIATION_RUNTIME_BUSY':isWsdl?'WSDL_RUNTIME_BUSY':isSigned?'SIGNED_RUNTIME_BUSY':'A1_RUNTIME_BUSY',recovery_required:!isDanfe&&recoveryRequired},
      {status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    active++;
    const isProcessedDanfe=path.startsWith('/internal/v1/fiscal-danfe/authorizations/')||path.startsWith('/internal/v1/fiscal-danfe/revalidations/')||path.startsWith('/internal/v1/fiscal-danfe/receipt-queries/');
    try{return await(isAuthorization?authorization(request):isDanfe?(isProcessedDanfe?processedDanfe(request):danfe(request)):isReconciliation?reconciliation(request):isWsdl?wsdl(request):isSigned?signed(request):custody(request));}finally{active--;}
  };
  // OpenSSL is spawned with its own environment whitelist; remove convenient process-level references too.
  for (const name of ['A1_KEK_RING_JSON', 'A1_TRANSPORT_SECRET', 'A1_FINGERPRINT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) delete env[name];
  return { handler, dispose() { closed=true; authorization.dispose(); signed.dispose(); wsdl.dispose(); reconciliation.dispose(); danfe.dispose(); processedDanfe.dispose(); for (const value of all) value.fill(0); } };
}
export function createServer(handler) {
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 5000, keepAliveTimeout: 5000 }, async (incoming, outgoing) => {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    const onClose = () => { if (!outgoing.writableFinished) abort.abort(); };
    incoming.once('aborted', onAbort); outgoing.once('close', onClose);
    try {
      need(typeof incoming.url === 'string' && incoming.url.startsWith('/') && !incoming.url.startsWith('//') && incoming.url.length <= 300, 400, 'A1_INVALID_REQUEST');
      const request = new Request(`http://runtime.internal${incoming.url}`, { method: incoming.method, headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }), signal: abort.signal });
      const result = await handler(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(new Uint8Array(await result.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      outgoing.end('{"error":"A1_INVALID_REQUEST"}');
    } finally { incoming.removeListener('aborted', onAbort); outgoing.removeListener('close', onClose); }
  });
  server.maxConnections = 64; server.maxHeadersCount = 32; server.maxRequestsPerSocket = 30;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let runtime;
  try {
    runtime = await fromEnvironment();
    const port = Number(process.env.PORT || 8080); need(Number.isInteger(port) && port >= 1024 && port <= 65535, 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
    const server = createServer(runtime.handler);
    server.listen(port, '0.0.0.0', () => process.stdout.write('{"status":"a1_custody_ready","can_transmit":false}\n'));
    const stop = () => { server.close(() => { runtime.dispose(); process.exit(0); }); setTimeout(() => { runtime.dispose(); process.exit(0); }, 5000).unref(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch { runtime?.dispose(); process.stderr.write('{"error":"A1_RUNTIME_START_FAILED"}\n'); process.exitCode = 1; }
}
