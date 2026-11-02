/** Closed browser-safe identities. No flags or evidence are accepted from a caller. */
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const RULE_PROFILE_V1_HASH='cefa45e6edb5bfe3fa06f64ebf74091d688c582a3a0d2e491a8546d956657c74';
export const RULE_PROFILE_V2_HASH='9430d9fd7cfdd6b901e650860411e122f137b79fa5d5c1cf1a0a1e3bb22e8126';
export const CURRENT_RULE_PROFILE_HASH=RULE_PROFILE_V2_HASH;
export const RULE_PROFILES=freeze([
 {profile:'sp-crt1-internal-sale-homologation-20261016-v1',profileHash:RULE_PROFILE_V1_HASH,validFrom:'2026-10-16T00:00:00-03:00',reviewBefore:'2026-10-26T00:00:00-03:00',gs1ManifestHash:null,policyHashes:{'55':'848ae4968217201ad773c6ea14def07a810e3438c24e944a1f2ae9b06c67ab28','65':'caf5d1149a0832acb4e392533838c1dcaaaa10639b814571119b58a9eeb34776'}},
 {profile:'sp-crt1-internal-sale-homologation-20261017-v2',profileHash:RULE_PROFILE_V2_HASH,validFrom:'2026-10-16T00:00:00-03:00',reviewBefore:'2026-10-26T00:00:00-03:00',gs1ManifestHash:'de4dcf61603e314d421575cfb7cb528896b489a44a24959b1a38145bc22d6140',policyHashes:{'55':'b0c8ae7bfb5218900dc73697628eba40aaf1d5612eeeac0ff88f0c5bde142f34','65':'a97da2efd79708e05171c492f24feb281ee131ba494cac5a80c75a3d5631b43d'}},
]);
export const ruleProfileByHash=hash=>typeof hash==='string'?RULE_PROFILES.find(p=>p.profileHash===hash)??null:null;
export const ruleProfileByName=name=>typeof name==='string'?RULE_PROFILES.find(p=>p.profile===name)??null:null;
export const matchesRuleProfile=(name,hash)=>{const profile=ruleProfileByHash(hash);return profile!==null&&profile.profile===name;};
