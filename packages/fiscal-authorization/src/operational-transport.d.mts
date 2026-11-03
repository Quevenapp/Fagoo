// Node SecureContext and HTTPS driver are validated at runtime; no Node ambient types required.
import type {ReviewedAuthorizationSoapRequest} from './authorization-soap-binding.mjs';
import type {SubsetReviewProof,PrivateJson} from './operational-dto.mjs';
export type TlsMetadata=Readonly<{
 fingerprint_sha256:string;holder_cnpj:string;not_before:string;not_after:string;
 client_auth_usage:'explicit_client_auth'|'unrestricted_absent'|'unrestricted_any';presented_chain_links_checked:boolean;
 icp_brasil_chain_validated:false;revocation_checked:false;a1_policy_verified:false;can_emit:false;can_transmit:false;
}>;
export type PreparedSession=Readonly<{secureContext:object;metadata:TlsMetadata;signal:AbortSignal;deadline:number}>;
export type TlsObservation=Readonly<{origin:'synthetic';protocol:'TLSv1.2'|'TLSv1.3';server_identity_verified:true;server_trust_profile:'synthetic-mtls-v1';server_trust_anchor_sha256:string}>;
export type ReviewedTransport=(input:{request:ReviewedAuthorizationSoapRequest;grant:PrivateJson;rule_review:SubsetReviewProof},session:PreparedSession,options:{signal:AbortSignal;deadline:number})=>Promise<Readonly<{response:Response;tls:TlsObservation}>>;
/** No default HTTPS driver, root set, environment or live mode. Local synthetic roots are supplied explicitly. */
export function createReviewedAuthorizationTransport(configuration:{requestImpl:(options:Readonly<Record<string,unknown>>,callback:(response:unknown)=>void)=>unknown;serverTrustAnchorSha256:string;attestServerContext:(context:object)=>Readonly<{server_trust_profile:'synthetic-mtls-v1';server_trust_anchor_sha256:string}>}):ReviewedTransport;
