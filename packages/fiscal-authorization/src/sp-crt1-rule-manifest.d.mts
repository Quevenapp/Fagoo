export type ReviewedRuleSource = Readonly<{
 id:string;url:string;sha256:string|null;pages?:readonly number[];sections?:readonly string[];
 capture?:string;observed?:Readonly<Record<string,string>>;note?:string;
}>;
export type RuleTimePolicy = Readonly<{
 validFrom:string;reviewBefore:string;kind:'brufap_conservative_review_boundary';officialTaxDeadline:false;
}>;
export const SP_CRT1_RULE_MANIFEST:Readonly<{
 profile:'sp-crt1-internal-sale-homologation-20261016-v1';reviewedOn:'2026-10-16';
 scope:Readonly<{uf:'SP';environment:'2';crt:'1';models:readonly ('55'|'65')[];tpNF:'1';idDest:'1';finNFe:'1';tpEmis:'1';indPres:'1';cfop:readonly string[];payment:readonly string[]}>;
 timePolicy:RuleTimePolicy;sources:readonly ReviewedRuleSource[];exclusions:readonly string[];operationalEnabled:false;
}>;
export const SP_CRT1_RULE_MANIFEST_HASH:string;
