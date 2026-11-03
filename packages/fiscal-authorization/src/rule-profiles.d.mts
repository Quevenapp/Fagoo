import type * as api from './sp-crt1-rule-profile.mjs';
export type RuleEngine=Readonly<{manifest:Readonly<Record<string,unknown>>;inspectSpCrt1Candidate:typeof api.inspectSpCrt1Candidate;projectSpCrt1CandidateReview:typeof api.projectSpCrt1CandidateReview;createSpCrt1ReviewReader:typeof api.createSpCrt1ReviewReader;evaluateSpCrt1Rules:typeof api.evaluateSpCrt1Rules;assertSpCrt1RuleReport:typeof api.assertSpCrt1RuleReport}>;
export function ruleEngine(hash?:string):RuleEngine;
export function ruleEngineByName(name:string):RuleEngine;
