export interface GtinPrefixRange {readonly from:string;readonly to:string;readonly specialIllustrative:boolean;readonly sourceRow:number;}
export const GTIN_PREFIX_TABLE:readonly GtinPrefixRange[];
export const GTIN_PREFIX_MANIFEST:Readonly<{
 profile:'nfe-gs1-prefix-observed-20261016-v1';observedOn:'2026-10-16';
 source:Readonly<{title:string;url:string;indexUrl:string;sha256:string;sizeBytes:number;publisherVersion:null;internalModifiedAt:string;effectiveFrom:null;ranges:Readonly<{sheet:string;cells:string;count:127;sha256:string}>;instructions:Readonly<{sheet:string;cells:readonly string[]}>}>;
 algorithm:Readonly<{acceptedLengths:readonly (8|12|13|14)[];comparisonRepresentation:'left_zero_pad_to_14_only';prefixWhenFirstSixZero:'positions_7_to_9_1_based';prefixOtherwise:'positions_2_to_4_1_based';rangesInclusive:true;specialFlagIsIllustrative:true}>;
 references:readonly Readonly<{title:string;url:string;sha256:string;pages:readonly number[]}>[];
 limitations:readonly string[];
}>;
export const GTIN_PREFIX_MANIFEST_HASH:string;
