import type {PrivateJson} from './service.mjs';
import type {RevalidationAction} from './revalidation-rpc.mjs';
import type {RevalidationBinding,RevalidationContext,RevalidationResult} from './revalidation-public-dto.mjs';
export const REVALIDATION_RPC_PREFIX:'erp_fiscal_reviewed_authorization_revalidation_';
export const REVALIDATION_RPC_LIMITS:Readonly<{request:32768;response:262144}>;
export function revalidationSource(raw:unknown,args?:PrivateJson):PrivateJson;
export function captureRevalidationRpc(action:RevalidationAction,raw:unknown):PrivateJson;
export function projectRevalidationLedger(action:RevalidationAction,raw:unknown,args:PrivateJson):PrivateJson;
export function revalidationPublicFromLedger(raw:PrivateJson,binding:RevalidationBinding):RevalidationContext|RevalidationResult;
