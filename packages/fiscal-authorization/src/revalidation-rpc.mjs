import {data} from './service-common.mjs';
import {createLedgerPort} from '../../fiscal-engine/ledger-port.mjs';
import {captureRevalidationRpc,projectRevalidationLedger,REVALIDATION_RPC_PREFIX,REVALIDATION_RPC_LIMITS} from './revalidation-dto.mjs';
const failures=new WeakSet();
export const isRevalidationSqlFailure=error=>error!==null&&typeof error==='object'&&failures.has(error);
export function createAuthorizationRevalidationRpc(configuration){
  const{execute}=data(configuration,['execute']);
  return createLedgerPort({execute,actions:['context','finish','command'],prefix:REVALIDATION_RPC_PREFIX,capture:captureRevalidationRpc,project:projectRevalidationLedger,limit:REVALIDATION_RPC_LIMITS.request,attestedFailures:failures,failure:'AUTHORIZATION_REVALIDATION_UNAVAILABLE'});
}
