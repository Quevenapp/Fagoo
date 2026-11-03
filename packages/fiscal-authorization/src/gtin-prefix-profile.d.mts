import type {GtinPrefixRange} from './gtin-prefix-manifest.mjs';
export {GTIN_PREFIX_TABLE,GTIN_PREFIX_MANIFEST,GTIN_PREFIX_MANIFEST_HASH} from './gtin-prefix-manifest.mjs';
export const GTIN_PREFIX_FLAGS:Readonly<{ccgChecked:false;identifierAssignmentVerified:false;countryOfOriginVerified:false;taxRulesValidated:false;canEmit:false;canTransmit:false}>;
export class GtinPrefixError extends Error {readonly code:'GTIN_FORMAT_INVALID';}
export interface GtinPrefixInspection extends Readonly<typeof GTIN_PREFIX_FLAGS>{
 readonly profile:'nfe-gs1-prefix-observed-20261016-v1';readonly manifestHash:string;readonly sourceSha256:string;readonly observedOn:'2026-10-16';
 readonly original:string;readonly length:8|12|13|14;readonly normalized14:string;readonly prefix:string;
 readonly prefixMethod:'positions_7_to_9'|'positions_2_to_4';readonly checkDigitMatches:boolean;readonly prefixListed:boolean;readonly range:GtinPrefixRange|null;
}
/** Throws GTIN_FORMAT_INVALID for anything except an unchanged 8/12/13/14 ASCII-digit string. */
export function inspectGtinPrefix(value:unknown):Readonly<GtinPrefixInspection>;
