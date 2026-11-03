import type {Options} from './service.mjs';
export type ReceiptQueryRpcAction='context'|'begin'|'prepare'|'use'|'finish'|'fail'|'command'|'history';
export function isReceiptQuerySqlFailure(error:unknown):boolean;
export function createReceiptQueryRpc(configuration:{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}):(action:ReceiptQueryRpcAction,args:unknown,options?:Options)=>Promise<unknown>;
