/** Historical response verification. This composition has no custody or SEFAZ transport port. */
import {fileURLToPath} from 'node:url';
import {createReviewedAuthorizationRpc} from '../../fiscal-authorization/src/reviewed-ledger-rpc.mjs';
import {createAuthorizationStorage} from '../../fiscal-authorization/src/storage.mjs';
import {createAuthorizationValidator} from '../../fiscal-authorization/src/validator.mjs';
import {createStoredResponseReader} from '../../fiscal-authorization/src/stored-response-reader.mjs';
import {createAuthorizationRevalidationRpc} from '../../fiscal-authorization/src/revalidation-rpc.mjs';
import {createAuthorizationRevalidationStorage} from '../../fiscal-authorization/src/revalidation-storage.mjs';
import {createAuthorizationRevalidationService} from '../../fiscal-authorization/src/revalidation-service.mjs';

export function createAuthorizationRevalidationComposition({projectUrl,supabaseDeployment,serviceKey,fetchImpl}){
 const reviewedRpc=createReviewedAuthorizationRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const historicalStorage=createAuthorizationStorage({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const validate=createAuthorizationValidator({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('../../fiscal-authorization/validator.py',import.meta.url))});
 const readStoredResponse=createStoredResponseReader({
  readCommand:({actor,authorizationCommandId},options)=>reviewedRpc('erp_fiscal_reviewed_authorization_command',{p_user_id:actor,p_command_id:authorizationCommandId},options),
  readObject:historicalStorage.read,validate,
 });
 const rpc=createAuthorizationRevalidationRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const storage=createAuthorizationRevalidationStorage({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 return createAuthorizationRevalidationService({rpc,readStoredResponse,storage:{read:storage.read,putImmutable:storage.putImmutable}});
}
