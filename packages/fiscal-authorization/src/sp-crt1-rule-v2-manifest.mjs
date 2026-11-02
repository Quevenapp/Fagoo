/** V2 changes only the pinned GS1-prefix check. V1 remains a separate identity. */
import {createHash} from 'node:crypto';
import {SP_CRT1_RULE_MANIFEST as previous,SP_CRT1_RULE_MANIFEST_HASH as previousHash} from './sp-crt1-rule-manifest.mjs';
import {GTIN_PREFIX_MANIFEST as prefix,GTIN_PREFIX_MANIFEST_HASH} from './gtin-prefix-manifest.mjs';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const SP_CRT1_RULE_V2_MANIFEST=freeze({
 ...structuredClone(previous),profile:'sp-crt1-internal-sale-homologation-20261017-v2',reviewedOn:'2026-10-17',
 predecessor:{profile:previous.profile,manifestHash:previousHash},
 gtinPrefix:{profile:prefix.profile,manifestHash:GTIN_PREFIX_MANIFEST_HASH,tableSha256:prefix.source.ranges.sha256,sourceSha256:prefix.source.sha256,recheckedOn:'2026-10-17',ccgChecked:false,identifierAssignmentVerified:false,countryOfOriginVerified:false},
 sources:[...structuredClone(previous.sources),{id:'gs1prefix20261016',url:prefix.source.url,sha256:prefix.source.sha256,observedOn:prefix.observedOn,recheckedOn:'2026-10-17',publisherVersion:null,effectiveFrom:null}],
 exclusions:previous.exclusions.map(x=>x==='No NCM/CEST or GS1-prefix table snapshot in this module'?'No NCM/CEST table snapshot or GTIN assignment verification':x),
});
export const SP_CRT1_RULE_V2_MANIFEST_HASH=createHash('sha256').update(JSON.stringify(SP_CRT1_RULE_V2_MANIFEST)).digest('hex');
