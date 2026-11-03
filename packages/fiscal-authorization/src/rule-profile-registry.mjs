/** Closed browser-safe identities. No flags or evidence are accepted from a caller. */
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const RULE_PROFILE_V1_HASH='e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504';
export const RULE_PROFILE_V2_HASH='d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6';
export const CURRENT_RULE_PROFILE_HASH=RULE_PROFILE_V2_HASH;
export const RULE_PROFILES=freeze([
 {profile:'sp-crt1-internal-sale-homologation-20261016-v1',profileHash:RULE_PROFILE_V1_HASH,validFrom:'2026-10-16T00:00:00-03:00',reviewBefore:'2026-10-26T00:00:00-03:00',gs1ManifestHash:null,policyHashes:{'55':'d825d62ab1b17b7e5303c0aa2a7a2b1c8e43c82570e49ca98113eb797063d7db','65':'963eb588baf7195067ff3f06f6b971107561d8da88db17b5c207f4714d7ef3c0'}},
 {profile:'sp-crt1-internal-sale-homologation-20261017-v2',profileHash:RULE_PROFILE_V2_HASH,validFrom:'2026-10-16T00:00:00-03:00',reviewBefore:'2026-10-26T00:00:00-03:00',gs1ManifestHash:'de4dcf61603e314d421575cfb7cb528896b489a44a24959b1a38145bc22d6140',policyHashes:{'55':'e70502bf2fa3a720dcd1eb7abf689d90cf61b192e01cdd182cbba816057e4f9b','65':'b4ddf9d9fff3a9efff05d6cc97e9904835314455ab730ee4cc8ba0c9e13b07f7'}},
]);
export const ruleProfileByHash=hash=>typeof hash==='string'?RULE_PROFILES.find(p=>p.profileHash===hash)??null:null;
export const ruleProfileByName=name=>typeof name==='string'?RULE_PROFILES.find(p=>p.profile===name)??null:null;
export const matchesRuleProfile=(name,hash)=>{const profile=ruleProfileByHash(hash);return profile!==null&&profile.profile===name;};
