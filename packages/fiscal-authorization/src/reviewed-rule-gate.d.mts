import type {AuthorizationRequest} from './index.mjs';
import type {SpCrt1ReviewQuery,SpCrt1RuleReport} from './sp-crt1-rule-profile.mjs';
import type {SubsetReviewProof} from './reviewed-ledger-dto.mjs';
import type {Options} from './service.mjs';
/** Authenticated backend only: bind the supplied actor and immutable candidate version before returning a persisted record. */
export type ReadSubsetReview=(query:SpCrt1ReviewQuery&Readonly<{actor:string;candidateVersion:number}>,options:Readonly<{signal:AbortSignal;deadline:number;maxBytes:131072}>)=>Promise<Uint8Array|null>;
export function createReviewedRuleGate(configuration:{readReview:ReadSubsetReview}):(input:{actor:string;candidateId:string;candidateVersion:number;request:AuthorizationRequest;ruleProfile:string},options?:Options)=>Promise<Readonly<{proof:SubsetReviewProof;report:SpCrt1RuleReport}>>;
