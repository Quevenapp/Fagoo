/** Private local adapter, no public HTTP/runtime composition. Operational run remains unavailable. */
export class AuthorizationServiceError extends Error {readonly code:string;}
export type Options={signal?:AbortSignal;deadline?:number};
export type RunInput={actor:string;commandId:string;candidateId:string;signedHash:string;expectedIdentityVersion:number;expectedA1Version:number;expectedPolicyVersion:number;confirmed:true};
export type CommandInput={actor:string;commandId:string};
export type HistoryInput={actor:string;candidateId:string;limit:number;before:string|null};
export type PreviewInput={actor:string;candidateId:string;signedHash:string};
export type PrivateJson=Readonly<Record<string,unknown>>;
export type Rpc=(name:string,args:PrivateJson,options:{signal:AbortSignal;deadline:number})=>Promise<unknown>;
export interface Storage {
 read(input:{bucket:'brufap-fiscal-artifacts';key:string;signal:AbortSignal;deadline:number}):Promise<Response|null>;
 putImmutable(input:{bucket:'brufap-fiscal-artifacts';key:string;bytes:Uint8Array;sha256:string;contentType:'application/octet-stream';upsert:false;ifNoneMatch:'*';signal:AbortSignal;deadline:number}):Promise<{status:200|201|409;requires_readback:true}>;
}
export type AuthorizationService={
 preview(input:PreviewInput,options?:Options):Promise<PrivateJson>;
 run(input:RunInput,options?:Options):Promise<PrivateJson>;
 recover(input:CommandInput,options?:Options):Promise<PrivateJson>;
 command(input:CommandInput,options?:Options):Promise<PrivateJson>;
 history(input:HistoryInput,options?:Options):Promise<PrivateJson>;
};
export function createAuthorizationService(configuration:{
 mode:'synthetic'|'operational';enabled?:boolean;rpc:Rpc;storage:Storage;
 validate:(input:{request:Readonly<Record<string,unknown>>;xmlBytes:Uint8Array;kind:'request'|'response'|'processed'},options:{signal:AbortSignal;deadline:number})=>Promise<unknown>;
 binding:{origin:'synthetic';profile:string;ruleProfile:string;encode:(context:PrivateJson,payload:Uint8Array)=>Uint8Array|Promise<Uint8Array>;extract:(context:PrivateJson,response:Uint8Array)=>Uint8Array|Promise<Uint8Array>};
 withPreparedSession:(value:PrivateJson,action:(session:unknown)=>Promise<void>,options:{signal:AbortSignal;deadline:number})=>Promise<void>;
 transport:(value:PrivateJson,bytes:Uint8Array,session:unknown,options:{signal:AbortSignal;deadline:number})=>Promise<Response>;
}):AuthorizationService;
export const SERVICE_FAILURE_CODES:readonly string[];
