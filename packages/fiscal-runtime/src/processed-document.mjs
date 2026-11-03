import {fileURLToPath} from 'node:url';
import {createReceiptQueryRpc} from '../../fiscal-authorization/src/receipt-query-rpc.mjs';
import {captureReceiptQueryRpc,projectReceiptQueryLedger} from '../../fiscal-authorization/src/receipt-query-ledger-dto.mjs';
import {captureReceiptQuerySourceInput,projectReceiptQuerySource} from '../../fiscal-authorization/src/receipt-query-evidence.mjs';
import {createReceiptQuerySource} from '../../fiscal-authorization/src/receipt-query-source.mjs';
import {createReceiptQueryStorage} from '../../fiscal-authorization/src/receipt-query-storage.mjs';
import {createAuthorizationValidator} from '../../fiscal-authorization/src/validator.mjs';
import {createReceiptValidator} from '../../fiscal-authorization/src/receipt-validator.mjs';
import {createProcessedReceiptQuerySource} from '../../fiscal-danfe-runtime/src/processed-receipt-query-source.mjs';
/** Read-only historical documents. No custody, fiscal transport or mutation service is injected. */
import {createReviewedAuthorizationRpc} from '../../fiscal-authorization/src/reviewed-ledger-rpc.mjs';
import {createAuthorizationStorage} from '../../fiscal-authorization/src/storage.mjs';
import {createAuthorizationRevalidationRpc} from '../../fiscal-authorization/src/revalidation-rpc.mjs';
import {createAuthorizationRevalidationStorage} from '../../fiscal-authorization/src/revalidation-storage.mjs';
import {createProcessedSource} from '../../fiscal-danfe-runtime/src/processed-source.mjs';
import {createProcessedRuntimeHandler} from '../../fiscal-danfe-runtime/src/processed-handler.mjs';
import {need} from '../../fiscal-danfe-runtime/src/processed-protocol.mjs';
import {renderProcessedHtml} from '../../fiscal-danfe/src/processed-render.mjs';

export function createProcessedDocumentComposition({projectUrl,supabaseDeployment,serviceKey,fetchImpl,transportSecret,transportKeyId,audience}){
 const original=createReviewedAuthorizationRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const revalidation=createAuthorizationRevalidationRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const historicalStorage=createAuthorizationStorage({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const derivedStorage=createAuthorizationRevalidationStorage({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const commandOnly=rpc=>(action,args,options)=>{need(action==='command',400,'DANFE_INVALID_REQUEST');return rpc(args,options);};
 const readLegacySource=createProcessedSource({
  authorizationRpc:commandOnly((args,options)=>original('erp_fiscal_reviewed_authorization_command',args,options)),
  revalidationRpc:commandOnly((args,options)=>revalidation('command',args,options)),
  storage:{read:input=>typeof input?.key==='string'&&input.key.startsWith('revalidations/')?derivedStorage.read(input):historicalStorage.read(input)},
 });
 const queryRpc=createReceiptQueryRpc({projectUrl,supabaseDeployment,serviceKey,fetchImpl}),queryStorage=createReceiptQueryStorage({projectUrl,supabaseDeployment,serviceKey,fetchImpl});
 const validateProcessed=createAuthorizationValidator({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('../../fiscal-authorization/validator.py',import.meta.url))});
 const validate=createReceiptValidator({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('../../fiscal-authorization/receipt-validator.py',import.meta.url))});
 const source103=createReceiptQuerySource({readSource:async(raw,options)=>{
  const input=captureReceiptQuerySourceInput(raw),args=captureReceiptQueryRpc('context',{p_user_id:input.actor,p_source_kind:input.sourceKind,p_source_command_id:input.sourceCommandId,p_expected_attempt_id:input.authorizationAttemptId});
  const view=projectReceiptQueryLedger('context',await queryRpc('context',args,options),args);return projectReceiptQuerySource(view.source,input);
 },readObject:historicalStorage.read,validate:validateProcessed});
 const readQuerySource=createProcessedReceiptQuerySource({rpc:queryRpc,readSource:source103,storage:{read:queryStorage.read},validate,validateProcessed});
 const readSource=(input,options)=>input?.sourceKind==='receipt_query'?readQuerySource(input,options):readLegacySource(input,options);
 return createProcessedRuntimeHandler({readSource,render:renderProcessedHtml,transportSecret,transportKeyId,audience});
}
