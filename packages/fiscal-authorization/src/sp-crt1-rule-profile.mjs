/** Frozen v1 semantics. Numeric GTIN intentionally retains the unpinned-table issue. */
import {createRuleEngine} from './sp-crt1-rule-engine.mjs';
import {SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH} from './sp-crt1-rule-manifest.mjs';
export {SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH};
export {MAX_RULE_REVIEW_BYTES,RULE_PROFILE_FLAGS,SpCrt1RuleError} from './sp-crt1-rule-engine.mjs';
export const {inspectSpCrt1Candidate,projectSpCrt1CandidateReview,createSpCrt1ReviewReader,evaluateSpCrt1Rules,assertSpCrt1RuleReport}=createRuleEngine(SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH);
