import type {createReceiptValidator} from '../../fiscal-authorization/src/receipt-validator.mjs';
import type {createAuthorizationValidator} from '../../fiscal-authorization/src/validator.mjs';
import type {Options} from '../../fiscal-authorization/src/service.mjs';
import type {ReceiptQuerySourceHandle,ReceiptQuerySourceInput} from '../../fiscal-authorization/src/receipt-query-source.mjs';
import type {ProcessedReceiptQueryMetadata} from './processed-dto.mjs';
declare const brand:unique symbol;
export type ProcessedReceiptQuerySource=Readonly<{[brand]:true;profile:'processed-receipt-query-source-089-v1'}>;
export function createProcessedReceiptQuerySource(configuration:{
 rpc:(action:'command',args:Readonly<{p_user_id:string;p_command_id:string}>,options:Options)=>Promise<unknown>;
 readSource:(input:ReceiptQuerySourceInput,options:Options)=>Promise<ReceiptQuerySourceHandle>;
 storage:{read:(input:{bucket:'brufap-fiscal-artifacts';key:string;signal:AbortSignal;deadline:number})=>Promise<Response|null>};
 validate:ReturnType<typeof createReceiptValidator>;validateProcessed:ReturnType<typeof createAuthorizationValidator>;
}):(input:{actor:string;sourceKind:'receipt_query';commandId:string},options?:Options)=>Promise<ProcessedReceiptQuerySource>;
export function isProcessedReceiptQuerySource(handle:unknown):handle is ProcessedReceiptQuerySource;
export function processedReceiptQuerySource(handle:ProcessedReceiptQuerySource):Readonly<{metadata:ProcessedReceiptQueryMetadata;signedBytes:Uint8Array;processedBytes:Uint8Array}>;
export function disposeProcessedReceiptQuerySource(handle:ProcessedReceiptQuerySource):void;
export function reauthorizeProcessedReceiptQuerySource(handle:ProcessedReceiptQuerySource,options?:Options):Promise<void>;
