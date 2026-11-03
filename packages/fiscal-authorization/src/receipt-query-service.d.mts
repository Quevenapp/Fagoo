import type {Options,Storage} from './service.mjs';
import type {ReceiptQuerySourceHandle,ReceiptQuerySourceInput} from './receipt-query-source.mjs';
import type {ReceiptQuerySqlArgs} from './receipt-query-sql-contract.d.mts';
import type {ReceiptQuery} from './receipt-core.mjs';
import type {ReceiptValidationReport} from './receipt-validator.mjs';
import type {AuthorizationRequest} from './index.mjs';
import type {ValidationReport} from './validator.mjs';
import type {ReceiptQueryCustody} from './receipt-query-custody.mjs';
import type {ReceiptQueryTransport} from './receipt-query-transport.mjs';
import type {ReceiptQueryContextInput,ReceiptQueryHistoryInput,ReceiptQueryRunInput,ReceiptQueryPublicContext,ReceiptQueryPublicHistory,ReceiptQueryPublicResult} from './receipt-query-public-dto.mjs';
export type ReceiptQueryRpc=(action:keyof ReceiptQuerySqlArgs,args:unknown,options?:Options)=>Promise<unknown>;
export type ReceiptQueryService=Readonly<{
 context(input:{actor:string;request:ReceiptQueryContextInput},options?:Options):Promise<ReceiptQueryPublicContext>;
 history(input:{actor:string;request:ReceiptQueryHistoryInput},options?:Options):Promise<ReceiptQueryPublicHistory>;
 run(input:{actor:string;request:ReceiptQueryRunInput},options?:Options):Promise<ReceiptQueryPublicResult>;
 command(input:{actor:string;commandId:string},options?:Options):Promise<ReceiptQueryPublicResult>;
 recover(input:{actor:string;commandId:string;confirmed:true},options?:Options):Promise<ReceiptQueryPublicResult>;
}>;
export class ReceiptQueryServiceError extends Error {readonly code:string;readonly command_id:string|null;readonly recovery_required:boolean;constructor(code:string,commandId?:string|null,recoveryRequired?:boolean)}
export function createReceiptQueryService(configuration:{
 rpc:ReceiptQueryRpc;readSource:(input:ReceiptQuerySourceInput,options:Options)=>Promise<ReceiptQuerySourceHandle>;storage:Storage;
 validate:(input:{request:ReceiptQuery;xmlBytes:Uint8Array;kind:'request'|'response'},options:Options)=>Promise<ReceiptValidationReport>;
 validateProcessed:(input:{request:AuthorizationRequest;xmlBytes:Uint8Array;kind:'processed'},options:Options)=>Promise<ValidationReport>;
 withPreparedSession:ReceiptQueryCustody;transport:ReceiptQueryTransport;enabled?:boolean;
}):ReceiptQueryService;
