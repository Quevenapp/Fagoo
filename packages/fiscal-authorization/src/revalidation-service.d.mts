import type {Options,Storage} from './service.mjs';
import type {RevalidationRpc} from './revalidation-rpc.mjs';
import type {StoredResponseInput,StoredResponseResult} from './stored-response-reader.mjs';
import type {RevalidationInput,RevalidationContext,RevalidationResult} from './revalidation-public-dto.mjs';
export class AuthorizationRevalidationError extends Error {readonly code:string;readonly command_id:string|null;readonly recovery_required:boolean;constructor(code:string,commandId?:string|null,recoveryRequired?:boolean)}
export function createAuthorizationRevalidationService(configuration:{rpc:RevalidationRpc;readStoredResponse:(input:StoredResponseInput,options?:Options)=>Promise<StoredResponseResult>;storage:Storage}):Readonly<{
 context(input:{actor:string;authorizationCommandId:string;expectedAttemptId:string},options?:Options):Promise<RevalidationContext>;
 revalidate(input:{actor:string;request:RevalidationInput},options?:Options):Promise<RevalidationResult>;
 command(input:{actor:string;commandId:string},options?:Options):Promise<RevalidationResult>;
}>;
