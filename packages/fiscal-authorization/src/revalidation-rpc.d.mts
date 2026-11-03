import type {Options,PrivateJson} from './service.mjs';
export type RevalidationAction='context'|'finish'|'command';
export type RevalidationRpc=(action:RevalidationAction,args:PrivateJson,options?:Options)=>Promise<PrivateJson>;
export function createAuthorizationRevalidationRpc(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):RevalidationRpc;
export function isRevalidationSqlFailure(error:unknown):boolean;
