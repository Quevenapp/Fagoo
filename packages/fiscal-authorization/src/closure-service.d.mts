import type {ClosureInput,ClosureResult} from './closure-dto.mjs';
import type {ClosureRpc} from './closure-rpc.mjs';
import type {ReviewedRpc} from './reviewed-ledger-rpc.mjs';
export interface AuthorizationClosureService {closeExpired(input:{actor:string;request:ClosureInput},options?:{signal?:AbortSignal;deadline?:number}):Promise<ClosureResult>;closureCommand(input:{actor:string;commandId:string},options?:{signal?:AbortSignal;deadline?:number}):Promise<ClosureResult>;}
export function createAuthorizationClosureService(configuration:{reviewedRpc:ReviewedRpc;closureRpc:ClosureRpc}):Readonly<AuthorizationClosureService>;
