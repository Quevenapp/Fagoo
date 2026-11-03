import type {PrivateJson,ReviewedAction} from './reviewed-ledger-dto.mjs';
export type ReviewedRpc=(name:`erp_fiscal_reviewed_authorization_${ReviewedAction|'begin_selected'}`,args:PrivateJson,options:{deadline:number;signal?:AbortSignal})=>Promise<PrivateJson>;
export function createReviewedAuthorizationRpc(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):ReviewedRpc;
export {AuthorizationServiceError} from './service.mjs';
