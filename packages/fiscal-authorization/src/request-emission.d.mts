import type {AuthorizationRequest} from './index.mjs';
import type {ReviewedAuthorizationSoapRequest} from './authorization-soap-binding.mjs';
export type AuthorizationEmissionIdentity=Readonly<{model:'55'|'65';environment:'2';emissionType:'1';issuedAt:string}>;
/** Private capability is attested before reading its properties. Returned identity is immutable. */
export function authorizationRequestEmission(handle:AuthorizationRequest):AuthorizationEmissionIdentity;
export function authorizationSoapEmission(handle:ReviewedAuthorizationSoapRequest):AuthorizationEmissionIdentity;
