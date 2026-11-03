import type {ClosureLedgerResult} from './closure-dto.mjs';
export const CLOSURE_RPC:'erp_fiscal_reviewed_authorization_close_expired',CLOSURE_COMMAND_RPC:'erp_fiscal_reviewed_authorization_closure_command';
export type ClosureRpc=(name:typeof CLOSURE_RPC|typeof CLOSURE_COMMAND_RPC,args:Record<string,unknown>,options?:{signal?:AbortSignal;deadline?:number})=>Promise<ClosureLedgerResult>;
export function createAuthorizationClosureRpc(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):ClosureRpc;
