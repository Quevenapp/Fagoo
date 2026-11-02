import {data} from './service-common.mjs';
import {createLedgerPort} from '../../fiscal-engine/ledger-port.mjs';
import {captureReceiptQueryRpc,projectReceiptQueryLedger,RECEIPT_QUERY_RPC_PREFIX,RECEIPT_QUERY_RPC_LIMITS} from './receipt-query-ledger-dto.mjs';
const failures=new WeakSet();
export const isReceiptQuerySqlFailure=error=>error!==null&&typeof error==='object'&&failures.has(error);
export function createReceiptQueryRpc(configuration){
  const{execute}=data(configuration,['execute']);
  return createLedgerPort({execute,actions:['context','begin','prepare','use','finish','fail','command','history'],prefix:RECEIPT_QUERY_RPC_PREFIX,capture:captureReceiptQueryRpc,project:projectReceiptQueryLedger,limit:RECEIPT_QUERY_RPC_LIMITS.request,attestedFailures:failures,failure:'RECEIPT_QUERY_UNAVAILABLE'});
}
