/** Backend artifact verification, not CCG/assignment validation. No runtime IO. */
import {createHash} from 'node:crypto';
import {GTIN_PREFIX_MANIFEST,GTIN_PREFIX_MANIFEST_HASH,GTIN_PREFIX_TABLE,inspectGtinPrefix} from './gtin-prefix-profile.mjs';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=()=>{throw Object.assign(new Error('GS1_PREFIX_TABLE_NOT_PINNED'),{code:'GS1_PREFIX_TABLE_NOT_PINNED'});};
/** Kept internal to this backend module; callers cannot supply a replacement table. */
function verified(){
 if(GTIN_PREFIX_MANIFEST_HASH!=='de4dcf61603e314d421575cfb7cb528896b489a44a24959b1a38145bc22d6140'||digest(GTIN_PREFIX_MANIFEST)!==GTIN_PREFIX_MANIFEST_HASH||digest(GTIN_PREFIX_TABLE)!=='4aa57784b9c1be68465a608d9be357a6873ee0d00ba250856b3ca67cbbeaee4a'||GTIN_PREFIX_MANIFEST.source.sha256!=='6f75b924f7fc97a2b5c4b6483479c035304ec642b48eebc61bd2b1afb5b62606'||GTIN_PREFIX_TABLE.length!==127)fail();
 const seen=new Set();for(const r of GTIN_PREFIX_TABLE){if(!/^[0-9]{3}$/.test(r.from)||!/^[0-9]{3}$/.test(r.to)||r.from>r.to)fail();for(let n=Number(r.from);n<=Number(r.to);n++){if(seen.has(n))fail();seen.add(n);}}
 if(seen.size!==701)fail();return inspectGtinPrefix;
}
export const inspectPinnedGtinPrefix=verified();
