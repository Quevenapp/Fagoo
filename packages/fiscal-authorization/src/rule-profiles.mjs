/** Backend engines are selected only by pinned identities, never by browser attestations. */
import * as v1 from './sp-crt1-rule-profile.mjs';
import * as v2 from './sp-crt1-rule-v2-profile.mjs';
import {RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH,CURRENT_RULE_PROFILE_HASH,ruleProfileByHash,ruleProfileByName} from './rule-profile-registry.mjs';
if(v1.SP_CRT1_RULE_MANIFEST_HASH!==RULE_PROFILE_V1_HASH||v2.SP_CRT1_RULE_V2_MANIFEST_HASH!==RULE_PROFILE_V2_HASH)throw Error('RULE_PROFILE_PIN_MISMATCH');
const versions=new Map([[RULE_PROFILE_V1_HASH,Object.freeze({...v1,manifest:v1.SP_CRT1_RULE_MANIFEST})],[RULE_PROFILE_V2_HASH,Object.freeze({...v2,manifest:v2.SP_CRT1_RULE_V2_MANIFEST})]]);
export function ruleEngine(hash=CURRENT_RULE_PROFILE_HASH){if(!ruleProfileByHash(hash))throw Object.assign(new Error('RULE_PROFILE_UNKNOWN'),{code:'RULE_PROFILE_UNKNOWN'});return versions.get(hash);}
export function ruleEngineByName(name){return ruleEngine(ruleProfileByName(name)?.profileHash??null);}
