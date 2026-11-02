import type {BusinessBinding,ResolvedBusinessDocument} from '../../fiscal-core/src/business-document.mjs';
export interface BusinessXmlResult {
  profile:'sn-sp-internal-business-v1';schema_profile:'pl010f-v1.04';binding:BusinessBinding;identity:ResolvedBusinessDocument['identity'];access_key:string;
  unsignedXml:string;unsigned_xml_sha256:string;xml_generated:true;operational_effects:false;numbering_reserved:false;
  tax_rules_validated:false;xsd_validated:false;signature_verified:false;authorized:false;can_emit:false;can_transmit:false;
  pending:string[];transformations:string[];arithmetic_profile:'explicit-values-half-up-cent-check-v1';
}
/** Revalidates legacy BusinessDocumentInput by composition; ResolvedBusinessContent is not a serialization authorization. */
export function buildBusinessXml(input:unknown):BusinessXmlResult;
