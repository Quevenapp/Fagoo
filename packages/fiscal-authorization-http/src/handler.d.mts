import type {AuthorizationService} from '../../fiscal-authorization/src/service.mjs';
/** Only the future authenticated composition may construct this context. */
export type VerifiedContext={actor:string;signal?:AbortSignal;deadline?:number};
/** Does not verify sessions or HMAC. POST /run always returns503 and never calls service.run. */
export function createAuthorizationHttpBoundary(configuration:{service:AuthorizationService}):(request:Request,context:VerifiedContext)=>Promise<Response>;
