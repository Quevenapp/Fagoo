/** Arithmetic and the pinned NF-e prefix table only. No IO, XML mutation or authority assertion. */
import {GTIN_PREFIX_TABLE,GTIN_PREFIX_MANIFEST,GTIN_PREFIX_MANIFEST_HASH} from './gtin-prefix-manifest.mjs';
export {GTIN_PREFIX_TABLE,GTIN_PREFIX_MANIFEST,GTIN_PREFIX_MANIFEST_HASH};
export const GTIN_PREFIX_FLAGS=Object.freeze({ccgChecked:false,identifierAssignmentVerified:false,countryOfOriginVerified:false,taxRulesValidated:false,canEmit:false,canTransmit:false});
export class GtinPrefixError extends Error{constructor(){super('GTIN_FORMAT_INVALID');this.name='GtinPrefixError';this.code='GTIN_FORMAT_INVALID';}}
/** Never coerce a number, trim, strip zeros, expand UPC-E, or rewrite the caller's GTIN. */
export function inspectGtinPrefix(original){
 if(typeof original!=='string'||![8,12,13,14].includes(original.length)||/[^0-9]/.test(original))throw new GtinPrefixError();
 const normalized14=original.padStart(14,'0'),firstSixZero=normalized14.startsWith('000000');
 const prefix=firstSixZero?normalized14.slice(6,9):normalized14.slice(1,4);
 // Fixed-width decimal strings compare exactly; no numeric conversion of identifiers.
 const range=GTIN_PREFIX_TABLE.find(row=>row.from<=prefix&&prefix<=row.to)??null;
 let sum=0,weight=3;
 for(let i=original.length-2;i>=0;i--){sum+=(original.charCodeAt(i)-48)*weight;weight=4-weight;}
 const checkDigitMatches=(10-sum%10)%10===original.charCodeAt(original.length-1)-48;
 return Object.freeze({
  profile:GTIN_PREFIX_MANIFEST.profile,manifestHash:GTIN_PREFIX_MANIFEST_HASH,
  sourceSha256:GTIN_PREFIX_MANIFEST.source.sha256,observedOn:GTIN_PREFIX_MANIFEST.observedOn,
  original,length:original.length,normalized14,prefix,
  prefixMethod:firstSixZero?'positions_7_to_9':'positions_2_to_4',
  checkDigitMatches,prefixListed:range!==null,range,
  ...GTIN_PREFIX_FLAGS
 });
}
