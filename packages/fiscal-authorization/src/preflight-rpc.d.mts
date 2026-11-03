import type {PreflightSnapshot} from './preflight-dto.mjs';
export const PREFLIGHT_RPC:'erp_fiscal_reviewed_authorization_preflight';
export type PreflightServiceInput=Readonly<{actor:string;candidateId:string;signedHash:string}>;
export type PreflightOptions=Readonly<{signal?:AbortSignal;deadline?:number}>;
export type PreflightRpc=(input:PreflightServiceInput,options?:PreflightOptions)=>Promise<PreflightSnapshot>;
export function createAuthorizationPreflightRpc(configuration:Readonly<{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}>):PreflightRpc;
