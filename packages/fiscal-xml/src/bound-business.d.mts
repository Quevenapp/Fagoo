import type {ResolvedBusinessContent,ResolvedBusinessDocument} from '../../fiscal-core/src/business-document.mjs';
import type {BusinessXmlResult} from './business-builder.mjs';
export interface BoundBusinessJob {id:string;reservation_id:string;version:number;basis_hash:string;created_at:string;}
export interface BoundBusinessDocument extends Omit<ResolvedBusinessContent,'identity_assigned'|'numbering_bound'> {
  identity:ResolvedBusinessDocument['identity'];access_key:string;job:BoundBusinessJob;identity_assigned:true;numbering_bound:true;
}
export interface BoundBusinessXml extends BusinessXmlResult {
  builder:ResolvedBusinessContent['builder'];binding:ResolvedBusinessContent['binding'];job:BoundBusinessJob;identity_assigned:true;numbering_bound:true;arithmetic_verified:true;
  basis_fingerprint_profile:ResolvedBusinessContent['basis_fingerprint_profile'];basis_fingerprint_text:string;
}
/** Immutable locally attested content + trusted server 048 receipt. Does not authorize execution, reserve a number or use a certificate. */
export function bindResolvedBusinessContent(input:{content:ResolvedBusinessContent;receipt:unknown}):BoundBusinessDocument;
/** Requires the exact local binder object; JSON/cloned results must be resolved and bound again. */
export function buildBoundBusinessXml(bound:BoundBusinessDocument):BoundBusinessXml;
