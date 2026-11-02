export const BUSINESS_PROFILE:'sn-sp-internal-business-v1';
export const BUSINESS_SCHEMA:'pl010f-v1.04';
export const BUSINESS_BUILDER:'fagoo-business-builder-v1';
export const BUSINESS_CONTENT_FINGERPRINT_PROFILE:'fagoo-business-content-basis-v1';
export const HOMOLOGATION_RECIPIENT:string;
export const HOMOLOGATION_PRODUCT:string;
export const BUSINESS_FLAGS:Readonly<Record<'operational_effects'|'numbering_reserved'|'tax_rules_validated'|'xsd_validated'|'signature_verified'|'authorized'|'can_emit'|'can_transmit',false>>;
export const BUSINESS_ERRORS:Readonly<Record<string,string>>;
export const TOTAL_FIELDS:readonly string[];
export class BusinessDocumentError extends Error {code:string;item_id:string|null;pending:string;}
export interface BusinessCompletion {
  identity:{series:string;number:string;cNF:string;issuedAt:string};
  operation:{tpNF:'1';idDest:'1';finNFe:'1';indFinal:'0'|'1';indPres:'1'};
  recipient:{municipality_code:string;indIEDest:'1'|'2'|'9'};
  items:Array<{item_id:string;tributary:{unit:string;quantity:string;unit_price:string};
    allocations:{global_discount:string;freight:string;other:string};cest_absence:'omit'|null;
    icms:{credit:null|{base:string;amount:string};groups500:null|Record<'retention'|'fcp'|'effective','include'|'omit'>}}>
  totals:Record<string,string>;
  payments:{items:Array<{type:'01'|'15';timing:'0'|'1';amount:string}>;change:string};
  transport_mode:'0'|'1'|'2'|'3'|'4'|'9';
  excluded_groups:Record<'ipi'|'ii'|'issqn'|'ibs_cbs'|'is'|'monophase'|'destination_icms','not_included_in_profile'>;
  homologation_labels:'apply_test_labels';additional_information:string|null;
}
/** Authenticated DTOs 022/035/040 must be supplied by a future backend adapter, never by a browser. */
export interface BusinessDocumentInput {draft:unknown;itemPreparation:unknown;taxPreparation:unknown;completion:BusinessCompletion;}
export interface BusinessBinding {draft_id:string;draft_version:number;snapshot_hash:string;item_preparation_version:number;tax_preparation_version:number;company_identity_version:number;company_fiscal_version:number;source_document_id:string;source_document_version:number;}
export interface BusinessAddress {street:string;number:string;complement:string|null;district:string;city:string;municipality_code:string;state:'SP';postal_code:string;}
export interface BusinessItem {
  item_id:string;position:number;code:string;description:string;ncm:string;origin:string;cest:string|null;gtin:string;gtin_tax:string;cfop:string;
  unit:string;quantity:string;unit_price:string;tributary:{unit:string;quantity:string;unit_price:string};product_amount:string;discount:string;freight:string;other:string;
  icms:{csosn:'102'}|{csosn:'101';credit_rate:string;credit_amount:string}|{csosn:'500';retention:null|{base:string;rate:string;substitute_icms:string|null;retained_icms:string};fcp:null|{base:string;rate:string;amount:string};effective:null|{reduction_rate:string;base:string;rate:string;amount:string}};
  pis:{cst:'49';base:string;rate:string;amount:string};cofins:{cst:'49';base:string;rate:string;amount:string};
}
export interface ResolvedBusinessDocument {
  profile:typeof BUSINESS_PROFILE;schema_profile:typeof BUSINESS_SCHEMA;binding:BusinessBinding;
  identity:{cUF:'35';cnpj:string;model:'55'|'65';environment:'2';series:string;number:string;cNF:string;issuedAt:string;tpEmis:'1'};access_key:string;
  operation:BusinessCompletion['operation']&{nature:string};issuer:{cnpj:string;name:string;trade_name:string|null;ie:string;crt:'1';address:BusinessAddress};
  recipient:{document_type:'CNPJ'|'CPF';document:string;name:string;indIEDest:'1'|'2'|'9';ie:string|null;address:BusinessAddress};
  items:BusinessItem[];totals:Record<string,string>;payments:BusinessCompletion['payments'];transport_mode:BusinessCompletion['transport_mode'];additional_information:string|null;
  pending:string[];transformations:string[];arithmetic_profile:'explicit-values-half-up-cent-check-v1';
  operational_effects:false;numbering_reserved:false;tax_rules_validated:false;xsd_validated:false;signature_verified:false;authorized:false;can_emit:false;can_transmit:false;
}
export function resolveBusinessDocument(input:unknown):ResolvedBusinessDocument;
export interface BusinessBasisHashes {draft_record_hash:string;item_record_hash:string;tax_record_hash:string;completion_record_hash:string;}
/** Records and record::text hashes captured together by the authorized server; hashes alone do not authenticate inputs. */
export interface BusinessContentInput {draft:unknown;itemPreparation:unknown;taxPreparation:unknown;completionPreparation:unknown;basisHashes:BusinessBasisHashes;}
export interface BusinessContentBinding extends BusinessBinding,BusinessBasisHashes {completion_version:number;}
export interface ResolvedBusinessContent extends Omit<ResolvedBusinessDocument,'identity'|'access_key'|'binding'> {
  builder:typeof BUSINESS_BUILDER;binding:BusinessContentBinding;model:'55'|'65';environment:'2';
  identity_assigned:false;numbering_bound:false;xml_generated:false;
  /** Only the explicit arithmetic_profile passed; no tax-rule, schema, signature or authorization conclusion. */
  arithmetic_verified:true;
  basis_fingerprint_profile:typeof BUSINESS_CONTENT_FINGERPRINT_PROFILE;
  /** JSON array of 20 constrained strings. SQL uses to_json(text[])::text; a trusted adapter may hash its UTF-8 bytes. */
  basis_fingerprint_text:string;
}
export function resolveBusinessContent(input:unknown):ResolvedBusinessContent;
/** Requires an immutable result issued by resolveBusinessContent in this process. Not session/issuer authorization. */
export function assertResolvedBusinessContent(value:unknown):asserts value is ResolvedBusinessContent;
/** Pure structural checks. No local attestation, numbering reservation or operational permission is created. */
export function resolveBusinessIdentity(identity:unknown,context:{cnpj:string;model:'55'|'65'}):Pick<ResolvedBusinessDocument,'identity'|'access_key'>;
