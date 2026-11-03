import type {AuthorizationCustody} from '../../fiscal-authorization/src/dispatch-service.mjs';
import type {PreparationAuthorizer} from '../../fiscal-authorization/src/dispatch-preparation.mjs';
import type {PreparedSession} from '../../fiscal-authorization/src/operational-transport.mjs';
import type {AuthorizationVaultReader} from './authorization-vault-read.mjs';
export class AuthorizationCustodyError extends Error {readonly code:string;readonly retry_automatically:false;}
export function createAuthorizationCustodyPort(configuration:{
 readObject:AuthorizationVaultReader;keyring:Map<string,Uint8Array>;authorizePreparation:PreparationAuthorizer;
 loader:{withContext:(value:unknown,action:(session:PreparedSession)=>Promise<void>)=>Promise<void>};
}):AuthorizationCustody;
