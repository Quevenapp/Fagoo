import type {ReceiptQuerySqlArgs,ReceiptQueryContext,ReceiptQueryView,ReceiptQueryRecovery,ReceiptQueryHistory,ReceiptQuerySelection,ReceiptQueryPolicy} from './receipt-query-sql-contract.d.mts';
export const RECEIPT_QUERY_RPC_PREFIX:'erp_fiscal_receipt_query_';
export const RECEIPT_QUERY_RPC_LIMITS:Readonly<{request:32768;response:524288}>;
export const RECEIPT_QUERY_LEDGER_FLAGS:Readonly<{data_mode:'fiscal_receipt_query';environment:'2';can_query:false;can_emit:false;can_transmit:false;tax_rules_validated:false;production_authorized:false;retry_submission_allowed:false;financial_mutation_performed:false;stock_mutation_performed:false}>;
export type ReceiptQueryLedgerFlags=typeof RECEIPT_QUERY_LEDGER_FLAGS;
export type ReceiptQueryLedgerSelection=Omit<ReceiptQuerySelection,'expected_identity_version'|'expected_a1_version'|'expected_query_policy_version'>&Readonly<{expected_identity_version:number|null;expected_a1_version:number|null;expected_query_policy_version:number|null}>;
export type ReceiptQueryObservedPolicy=Omit<ReceiptQueryPolicy,'profile'|'manifest_hash'>&Readonly<{profile:string;manifest_hash:string|null}>;
export type ReceiptQueryLedgerContext=ReceiptQueryLedgerFlags&Omit<ReceiptQueryContext,'heads'|'selection'|'policy'|'history'>&Readonly<{heads:Readonly<{identity_version:number|null;a1_version:number|null}>;selection:ReceiptQueryLedgerSelection;policy:ReceiptQueryObservedPolicy|null;history:readonly ReceiptQueryLedgerView[]}>;
export type ReceiptQueryLedgerView=ReceiptQueryLedgerFlags&ReceiptQueryView;
export type ReceiptQueryLedgerGrant=ReceiptQueryLedgerFlags&Readonly<{private_executor_only:true;grant:ReceiptQueryRecovery&Readonly<{issued_at:string}>}>;
export type ReceiptQueryLedgerHistory=ReceiptQueryLedgerFlags&Omit<ReceiptQueryHistory,'items'>&Readonly<{items:readonly ReceiptQueryLedgerView[]}>;
export type ReceiptQueryLedgerResults={context:ReceiptQueryLedgerContext;begin:ReceiptQueryLedgerView&Readonly<{replayed:boolean;execution:ReceiptQueryRecovery|null}>;prepare:ReceiptQueryLedgerView&Readonly<{replayed:boolean}>;use:ReceiptQueryLedgerGrant;finish:ReceiptQueryLedgerView&Readonly<{replayed:boolean}>;fail:ReceiptQueryLedgerView&Readonly<{replayed:boolean}>;command:ReceiptQueryLedgerView&Readonly<{read_only:true;replayed:true;execution:null}>;history:ReceiptQueryLedgerHistory};
export function captureReceiptQueryRpc<A extends keyof ReceiptQuerySqlArgs>(action:A,raw:unknown):Readonly<ReceiptQuerySqlArgs[A]>;
export function projectReceiptQueryLedger<A extends keyof ReceiptQuerySqlArgs>(action:A,raw:unknown,args:ReceiptQuerySqlArgs[A]):Readonly<ReceiptQueryLedgerResults[A]>;
/** Parsing checks structure and binding; it does not attest where the object came from. */
export function receiptQueryRecovery(raw:unknown,expected?:Partial<ReceiptQueryRecovery>):ReceiptQueryRecovery;
export function receiptQueryGrant(raw:unknown,args:ReceiptQuerySqlArgs['use']):ReceiptQueryLedgerGrant;
