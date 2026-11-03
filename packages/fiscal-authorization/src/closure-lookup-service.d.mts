import type {ClosureResult} from './closure-dto.mjs';
import type {ClosureLookupRpc} from './closure-lookup-rpc.mjs';
export interface AuthorizationClosureLookupService {closureLookup(input:{actor:string;authorizationCommandId:string;expectedAttemptId:string},options?:{signal?:AbortSignal;deadline?:number}):Promise<ClosureResult>;}
export function createAuthorizationClosureLookupService(configuration:{lookupRpc:ClosureLookupRpc}):Readonly<AuthorizationClosureLookupService>;
