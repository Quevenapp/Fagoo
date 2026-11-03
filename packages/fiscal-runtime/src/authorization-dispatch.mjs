import {createAuthorizationClosureLookupRpc} from '../../fiscal-authorization/src/closure-lookup-rpc.mjs';
import {createAuthorizationClosureLookupService} from '../../fiscal-authorization/src/closure-lookup-service.mjs';
import {createAuthorizationPreflightRpc} from '../../fiscal-authorization/src/preflight-rpc.mjs';
import {createAuthorizationPreflightService} from '../../fiscal-authorization/src/preflight-service.mjs';
import {createAuthorizationClosureRpc} from '../../fiscal-authorization/src/closure-rpc.mjs';
import {createAuthorizationClosureService} from '../../fiscal-authorization/src/closure-service.mjs';
/** Private069 composition. No environment reads; the caller supplies the explicit disabled-by-default gate. */
import {fileURLToPath} from 'node:url';
import {request} from 'node:https';
import {createReviewedAuthorizationRpc} from '../../fiscal-authorization/src/reviewed-ledger-rpc.mjs';
import {createSubsetReviewRpc} from '../../fiscal-authorization/src/subset-review-rpc.mjs';
import {createPersistedSubsetReviewReader} from '../../fiscal-authorization/src/subset-review-reader.mjs';
import {createAuthorizationStorage} from '../../fiscal-authorization/src/storage.mjs';
import {createAuthorizationValidator} from '../../fiscal-authorization/src/validator.mjs';
import {createAuthorizationDispatchService} from '../../fiscal-authorization/src/dispatch-service.mjs';
import {createAuthorizationPreparationAuthorizer} from '../../fiscal-authorization/src/dispatch-preparation.mjs';
import {createAuthorizationDispatchTransport} from '../../fiscal-authorization/src/dispatch-transport.mjs';
import {createDispatchAccessReader} from '../../fiscal-authorization-runtime/src/dispatch-access.mjs';
import {createAuthorizationVaultReader} from './authorization-vault-read.mjs';
import {createAuthorizationCustodyPort} from './authorization-custody.mjs';
import {createSpAuthorizationTlsLoader} from './authorization-server-trust.mjs';
export async function createReviewedDispatchComposition({projectUrl,supabaseDeployment,serviceKey,fetchImpl,signedRpc,keyring,binaryPath,allowLegacy,enabled=false}){
 if(typeof enabled!=='boolean')throw Error('AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID');
 const rpc=createReviewedAuthorizationRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl}),reviewRpc=createSubsetReviewRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const readReview=createPersistedSubsetReviewReader({rpc:reviewRpc}),storage=createAuthorizationStorage({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const preflight=createAuthorizationPreflightService({rpc:createAuthorizationPreflightRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl}),signedRpc,reviewRpc,storage:{read:storage.read},enabled});
 const loader=await createSpAuthorizationTlsLoader({binaryPath,allowLegacy,timeoutMs:5000});
 const withPreparedSession=createAuthorizationCustodyPort({readObject:createAuthorizationVaultReader({projectUrl,supabaseDeployment,serviceKey,fetchImpl}),loader,keyring,authorizePreparation:createAuthorizationPreparationAuthorizer({rpc,readReview})});
 const validate=createAuthorizationValidator({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('../../fiscal-authorization/validator.py',import.meta.url))});
 const service=createAuthorizationDispatchService({rpc,storage,validate,readReview,selectReview:preflight.select,withPreparedSession,transport:createAuthorizationDispatchTransport({requestImpl:request}),enabled});
 const closure=createAuthorizationClosureService({reviewedRpc:rpc,closureRpc:createAuthorizationClosureRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl})});
 const lookup=createAuthorizationClosureLookupService({lookupRpc:createAuthorizationClosureLookupRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl})});
 return Object.freeze({service:Object.freeze({...service,preflight:preflight.preflight,...closure,...lookup}),readAccess:createDispatchAccessReader({projectUrl,supabaseDeployment,serviceKey,fetchImpl}),enabled});
}
