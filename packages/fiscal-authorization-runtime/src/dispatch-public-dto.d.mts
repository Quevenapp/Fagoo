import type {ClosureLookupInput} from '../../fiscal-authorization/src/closure-lookup-dto.mjs';
export type {ClosureLookupInput} from '../../fiscal-authorization/src/closure-lookup-dto.mjs';
import type {AuthorizationResult,AuthorizationReceipt,AuthorizationHistory} from '../../fiscal-authorization-http/src/dto.mjs';
export {FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
export const DISPATCH_FAILURE_CODES:readonly string[];
export type {SelectedRunInput as DispatchRunInput} from '../../fiscal-authorization/src/selected-run-dto.mjs';
import type {SelectedRunInput as DispatchRunInput} from '../../fiscal-authorization/src/selected-run-dto.mjs';
import type {PreflightInput,PreflightResult} from '../../fiscal-authorization/src/preflight-dto.mjs';
import type {ClosureInput,ClosureResult} from '../../fiscal-authorization/src/closure-dto.mjs';
export type {ClosureInput,ClosureResult} from '../../fiscal-authorization/src/closure-dto.mjs';
export type {PreflightInput,PreflightResult} from '../../fiscal-authorization/src/preflight-dto.mjs';
export interface DispatchSubsetReview {candidate_version:number;profile:'sp-crt1-internal-sale-homologation-20261016-v1'|'sp-crt1-internal-sale-homologation-20261017-v2';profile_hash:string;review_id:string;review_version:number;review_hash:string;coverage:'listed_rules_only_not_full_tax_validation';tax_rules_validated:false;}
export interface DispatchResult extends AuthorizationResult {receipt:(AuthorizationReceipt&{origin:'operational'})|null;tax_rules_validated:false;dispatch_profile:'authorization-reviewed-dispatch-v1';authorized_in_homologation:boolean;observation:{sha256:string;size_bytes:number}|null;subset_review:DispatchSubsetReview|null;}
export interface DispatchHistory extends AuthorizationHistory {tax_rules_validated:false;items:DispatchResult[];}
export type DispatchStatus=Readonly<typeof import('../../fiscal-authorization-http/src/dto.mjs').FLAGS&{tax_rules_validated:false;dispatch_profile:'authorization-reviewed-dispatch-v1';read_only:true;runtime_enabled:boolean;policy_checked:false}>;
export type DispatchBinding={action:'status'}|{action:'preflight';input:PreflightInput}|{action:'run'|'command'|'recover';commandId:string;input?:DispatchRunInput}|{action:'history';candidateId:string;limit:number;before:string|null}|{action:'closeExpired'|'closureCommand';commandId:string;input?:ClosureInput}|{action:'closureLookup';input:ClosureLookupInput};
export function projectDispatchPublic(value:unknown,binding:{action:'status'}):Readonly<DispatchStatus>;
export function projectDispatchPublic(value:unknown,binding:{action:'history';candidateId:string;limit:number;before:string|null}):Readonly<DispatchHistory>;
export function projectDispatchPublic(value:unknown,binding:{action:'run'|'command'|'recover';commandId:string;input?:DispatchRunInput}):Readonly<DispatchResult>;

export function projectDispatchPublic(value:unknown,binding:{action:'preflight';input:PreflightInput}):Readonly<PreflightResult>;
export function projectDispatchPublic(value:unknown,binding:{action:'closeExpired'|'closureCommand';commandId:string;input?:ClosureInput}):Readonly<ClosureResult>;

export function projectDispatchPublic(value:unknown,binding:{action:'closureLookup';input:ClosureLookupInput}):Readonly<ClosureResult>;
