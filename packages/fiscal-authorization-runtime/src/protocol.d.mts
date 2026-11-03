export const PUBLIC_PREFIX:'/v1/fiscal-authorization';
export const INTERNAL_PREFIX:'/internal/v1/fiscal-authorization';
export const ERROR_CODES:readonly string[];
export const MAX_JSON_BYTES:4096;
export const MAX_RESPONSE_BYTES:131072;
export class AuthorizationRuntimeError extends Error {status:number;code:string;constructor(status:number,code:string);}
