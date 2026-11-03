import type {Rpc} from './service.mjs';
export function createAuthorizationRpc(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):Rpc;
export {AuthorizationServiceError} from './service.mjs';
