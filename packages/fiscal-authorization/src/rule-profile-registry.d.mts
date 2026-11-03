export type RuleProfileDefinition=Readonly<{profile:string;profileHash:string;validFrom:string;reviewBefore:string;gs1ManifestHash:string|null;policyHashes:Readonly<Record<'55'|'65',string>>}>;
export const RULE_PROFILE_V1_HASH:string;
export const RULE_PROFILE_V2_HASH:string;
export const CURRENT_RULE_PROFILE_HASH:string;
export const RULE_PROFILES:readonly RuleProfileDefinition[];
export function ruleProfileByHash(hash:unknown):RuleProfileDefinition|null;
export function ruleProfileByName(name:unknown):RuleProfileDefinition|null;
export function matchesRuleProfile(name:unknown,hash:unknown):boolean;
