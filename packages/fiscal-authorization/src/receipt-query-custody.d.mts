import type {PreparedSession} from './operational-transport.mjs';
import type {ReceiptQueryPreparationInput,ReceiptQueryPreparationAuthorizer} from './receipt-query-preparation.mjs';
import type {AuthorizationVaultReader} from '../../fiscal-runtime/src/authorization-vault-read.mjs';
export type ReceiptQueryCustody=(input:ReceiptQueryPreparationInput,action:(session:PreparedSession)=>Promise<void>,options:Readonly<{signal?:AbortSignal;deadline:number}>)=>Promise<void>;
export class ReceiptQueryCustodyError extends Error {readonly code:string;readonly retry_automatically:false;}
export function createReceiptQueryCustodyPort(configuration:{readObject:AuthorizationVaultReader;loader:{withContext:(value:unknown,action:(session:PreparedSession)=>Promise<void>)=>Promise<void>};keyring:Map<string,Uint8Array>;authorizePreparation:ReceiptQueryPreparationAuthorizer}):ReceiptQueryCustody;
