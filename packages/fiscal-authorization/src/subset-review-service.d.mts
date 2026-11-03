import type {SpCrt1ReviewProjection,SpCrt1RuleReport} from './sp-crt1-rule-profile.mjs';
import type {SubsetReviewFlags,SubsetReviewDeclaration,SubsetReviewReceipt,SubsetReviewView} from './subset-review-dto.mjs';
import type {SubsetReviewRpc,SubsetReviewOptions} from './subset-review-rpc.mjs';
export const SUBSET_SERVICE_REQUEST_BYTES:147456;
export const SUBSET_SERVICE_RESPONSE_BYTES:1048576;
export const SUBSET_SAVE_BLOCKERS:readonly string[];
export class SubsetReviewServiceError extends Error{readonly code:string;readonly command_id:string|null;readonly recovery_required:boolean;constructor(code:string,options?:{commandId?:string|null;recoveryRequired?:boolean});}
export type SubsetReviewChoices=Readonly<{document:SubsetReviewDeclaration['document'];items:readonly Readonly<Omit<SubsetReviewDeclaration['items'][number],'item_hash'|'credit'>&{credit:null}>[]}>;
export type SubsetPublicDeclaration=Readonly<{document:SubsetReviewDeclaration['document'];items:readonly Readonly<Omit<SubsetReviewDeclaration['items'][number],'item_hash'>>[]}>;
export type SubsetPublicReview=Readonly<{receipt:Omit<SubsetReviewReceipt,'schema'>|null;current:SubsetReviewView['current'];declaration:SubsetPublicDeclaration|null}>;
export type SubsetReviewContext=SubsetReviewFlags&SpCrt1ReviewProjection&Readonly<{
 kind:'context';read_only:true;candidate:Readonly<{candidate_id:string;candidate_version:number;model:'55'|'65';signed_hash:string;facts_hash:string;profile:string;profile_hash:string}>;
 source_current:Readonly<{artifact_current:boolean;basis_changed:boolean;draft_archived:boolean;source_cancelled:boolean;a1_changed:boolean;is_latest_candidate:boolean;series_enabled:boolean;certificate_time_valid_now:boolean}>;
 review:SubsetPublicReview&Readonly<{matches_profile:boolean}>;report:SpCrt1RuleReport;save_available:boolean;save_blockers:readonly string[];
}>;
export type SubsetReviewResult=SubsetReviewFlags&SubsetPublicReview&Readonly<{kind:'save'|'command';read_only:boolean;command_id:string;replayed:boolean}>;
export type SubsetReviewSaveInput=Readonly<{actor:string;candidateId:string;commandId:string;expectedCandidateVersion:number;signedHash:string;expectedReviewVersion:number;expectedFactsHash:string;expectedProfileHash:string;validUntil:string;choices:SubsetReviewChoices}>;
export type SubsetReviewService=Readonly<{
 context(input:Readonly<{actor:string;candidateId:string}>,options?:Partial<SubsetReviewOptions>):Promise<SubsetReviewContext>;
 save(input:SubsetReviewSaveInput,options?:Partial<SubsetReviewOptions>):Promise<SubsetReviewResult>;
 command(input:Readonly<{actor:string;commandId:string}>,options?:Partial<SubsetReviewOptions>):Promise<SubsetReviewResult>;
}>;
export function captureSubsetReviewChoices(input:unknown):SubsetReviewChoices;
export function createSubsetReviewService(configuration:Readonly<{
 signedRpc:(name:'erp_fiscal_signed_get',args:Readonly<{p_user_id:string;p_candidate_id:string}>,options:SubsetReviewOptions)=>Promise<unknown>;
 profileHash?:string;
 reviewRpc:SubsetReviewRpc;
 storage:Readonly<{read:(input:Readonly<{bucket:'brufap-fiscal-artifacts';key:string;signal:AbortSignal;deadline:number}>)=>Promise<Response|null>}>;
}>):SubsetReviewService;
