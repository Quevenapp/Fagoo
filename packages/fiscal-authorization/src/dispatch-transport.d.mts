import type {ReviewedAuthorizationSoapRequest} from './authorization-soap-binding.mjs';
import type {PrivateJson,SubsetReviewProof} from './reviewed-ledger-dto.mjs';
import type {PreparedSession} from './operational-transport.mjs';
export type DispatchTransport=(input:Readonly<{request:ReviewedAuthorizationSoapRequest;grant:PrivateJson;rule_review:SubsetReviewProof}>,session:PreparedSession,options:{signal:AbortSignal;deadline:number})=>Promise<Readonly<{response:Response;tls:Readonly<{origin:'operational';protocol:'TLSv1.2'|'TLSv1.3';server_identity_verified:true;server_trust_profile:'node-bundled-plus-iti-ssl-v10-20261016';server_trust_anchor_sha256:string}>}>>;
/** Backend-only driver. Trust is not injectable here; it comes from the dedicated TLS loader. */
export function createAuthorizationDispatchTransport(configuration:{requestImpl:(options:Readonly<Record<string,unknown>>,callback:(response:unknown)=>void)=>unknown;/** Trusted local clock test seam, never HTTP input. */now?:()=>number}):DispatchTransport;
