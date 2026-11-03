import type {Options} from './service.mjs';
import type {ReceiptQuerySourceHandle} from './receipt-query-source.mjs';
import type {ReceiptQuery} from './receipt-core.mjs';
import type {ReceiptQueryRecovery} from './receipt-query-sql-contract.d.mts';
import type {ReceiptQueryRpc} from './receipt-query-service.mjs';
export type ReceiptQueryPreparationInput=Readonly<{actor:string;context:ReceiptQueryRecovery;source:ReceiptQuerySourceHandle;request:ReceiptQuery}>;
export function captureReceiptQueryPreparation(raw:unknown):ReceiptQueryPreparationInput;
export type ReceiptQueryPreparationAuthorizer=(input:ReceiptQueryPreparationInput,options:Options)=>Promise<ReceiptQueryRecovery>;
export function createReceiptQueryPreparationAuthorizer(configuration:{rpc:ReceiptQueryRpc}):ReceiptQueryPreparationAuthorizer;
