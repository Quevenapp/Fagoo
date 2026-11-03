import type {ReceiptQueryLedgerView,ReceiptQueryLedgerContext,ReceiptQueryLedgerHistory} from './receipt-query-ledger-dto.mjs';
import type {ReceiptQuerySource,ReceiptQueryResolution,ReceiptQuerySourceValidation} from './receipt-query-sql-contract.d.mts';
import type {ReceiptQueryPublicBinding,ReceiptQueryPublicContext,ReceiptQueryPublicHistory,ReceiptQueryPublicResult,ReceiptQueryPublicSource,ReceiptQueryPublicResolution} from './receipt-query-public-dto.mjs';
export function receiptQueryPublicSource(source:ReceiptQuerySource):ReceiptQueryPublicSource;
export function receiptQueryPublicResolution(resolution:ReceiptQueryResolution):ReceiptQueryPublicResolution;
export function receiptQueryPublicResult(view:ReceiptQueryLedgerView,options?:{readOnly?:boolean;replayed?:boolean}):ReceiptQueryPublicResult;
export function projectReceiptQueryResult(view:ReceiptQueryLedgerView,binding:Exclude<ReceiptQueryPublicBinding,{action:'receiptQueryContext'|'receiptQueryHistory'}>,options?:{readOnly?:boolean;replayed?:boolean}):ReceiptQueryPublicResult;
export function projectReceiptQueryHistory(view:ReceiptQueryLedgerHistory,binding:Extract<ReceiptQueryPublicBinding,{action:'receiptQueryHistory'}>):ReceiptQueryPublicHistory;
export function projectReceiptQueryContext(view:ReceiptQueryLedgerContext,binding:Extract<ReceiptQueryPublicBinding,{action:'receiptQueryContext'}>,attestation:{verified:boolean;enabled:boolean;validation?:ReceiptQuerySourceValidation}):ReceiptQueryPublicContext;
