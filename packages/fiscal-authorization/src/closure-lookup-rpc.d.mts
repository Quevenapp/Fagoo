import type {ClosureLedgerResult} from './closure-dto.mjs';
export const CLOSURE_LOOKUP_RPC:'erp_fiscal_reviewed_authorization_closure_lookup';
export type ClosureLookupRpc=(args:{p_user_id:string;p_authorization_command_id:string;p_expected_attempt_id:string},options?:{signal?:AbortSignal;deadline?:number})=>Promise<ClosureLedgerResult>;
export function createAuthorizationClosureLookupRpc(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):ClosureLookupRpc;
