import type {AuthorizationService,Rpc,Storage} from './service.mjs';
/** Only reads; run always fails. Recover authorizes command then reports unavailable without mutation. */
export function createAuthorizationReadService(configuration:{rpc:Rpc;storage:Pick<Storage,'read'>}):AuthorizationService;
