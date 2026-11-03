import type {AuthorizationRequest,Model} from './index.mjs';
export const AUTHORIZATION_VALIDATOR_PROFILE:Readonly<{profile:string;validatorHash:string;manifestHash:string}>;
export type ValidationReport = Readonly<{
  ok:boolean;code?:string;kind:'request'|'response'|'processed';xmlDigest:string;model?:Model;environment?:'2';
  schemaProfile?:string;validatorHash?:string;schemaManifestHash?:string;xsdValidated:boolean;contextMatched:boolean;
  cStat?:string|null;protocolCStat?:string|null;referenceDigestMatched?:boolean;authorizationDeclared?:boolean;
  signatureVerified:false;tlsOriginVerified:false;sefazAuthorized:false;authorizedInHomologation:false;canEmit:false;canTransmit:false;
}>;
export function createAuthorizationValidator(configuration:{pythonPath:string;validatorPath:string;spawnImpl?:(...args:unknown[])=>unknown}):(
  input:{request:AuthorizationRequest;xmlBytes:Uint8Array;kind:'request'|'response'|'processed'},
  options?:{signal?:AbortSignal;deadline?:number}
) => Promise<ValidationReport>;
