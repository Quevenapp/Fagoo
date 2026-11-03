import {publicResult,type A1Current,type A1Envelope,type A1Receipt} from '../../../../packages/fiscal-runtime/src/dto.mjs';
import {encodeConfigure,reason,uuid} from '../../../../packages/fiscal-runtime/src/protocol.mjs';
import type {A1RequestOptions,NativeRequestOptions} from './real-access';
export type {A1Current,A1Envelope,A1Receipt};
export interface A1Controller {a1:(path:string,options?:A1RequestOptions)=>Promise<unknown>;company:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
export interface A1Company {version:number;cnpj:string;legal_name:string;}
export type CustodyAction='configure'|'disable';
export interface A1Attempt {id:string;action:CustodyAction;expectedVersion:number;expectedIdentityVersion:number|null;holder:string|null;body:Uint8Array|Record<string,unknown>|null;state:'unknown'|'pending'|'committed'|'rejected';errorCode:string|null;retryAt:number;}
const bad=():never=>{throw Object.assign(new Error('A1_RESPONSE_INVALID'),{code:'A1_RESPONSE_INVALID'});};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:bad();
export function a1Company(value:unknown):A1Company|null {
 const v=object(value);if(v.section!=='identity'||v.data_mode!=='erp_native'||v.emission_enabled!==false||v.record===undefined)bad();
 if(v.record===null)return null;const r=object(v.record),data=object(r.data);
 if(!Number.isInteger(r.version)||(r.version as number)<1||(r.version as number)>2147483647||typeof data.cnpj!=='string'||!/^([A-Z0-9]{12}[0-9]{2})$/.test(data.cnpj)||typeof data.legal_name!=='string'||!data.legal_name.trim()||[...data.legal_name].length>200)bad();
 return{version:r.version as number,cnpj:data.cnpj as string,legal_name:data.legal_name as string};
}
export function a1Metadata(value:unknown):A1Current {try{return publicResult(value,{action:'metadata'}).current;}catch{ return bad(); }}
export function a1Command(value:unknown,attempt:A1Attempt,ack=false):A1Envelope {
 let v:A1Envelope;try{v=publicResult(value,{action:ack?attempt.action:'command',commandId:attempt.id});}catch{return bad();}
 if(ack&&v.state==='pending')bad();
 if(v.state==='committed'){
  const r=v.receipt;if(!r)return bad();if(r.action!==attempt.action||r.version!==attempt.expectedVersion+1)bad();
  if(attempt.action==='configure'&&(r.company_identity_version!==attempt.expectedIdentityVersion||r.metadata?.holder_cnpj!==attempt.holder))bad();
 }
 return v;
}
export function checkedReason(text:string):string {const value=text.trim();if(!reason(value))throw new Error('A1_REASON_INVALID');return value;}
export function configureBytes({id,current,company,why,pfx,password}:{id:string;current:A1Current;company:A1Company;why:string;pfx:Uint8Array;password:string}):Uint8Array {
 if(!uuid(id)||!password||/[\u0000\r\n]/u.test(password))throw new Error('A1_INPUT_INVALID');
 const secret=new TextEncoder().encode(password);
 try{return encodeConfigure({command_id:id,expected_version:current.version,expected_identity_version:company.version,reason:checkedReason(why),pfxBytes:pfx,passwordBytes:secret});}
 finally{secret.fill(0);}
}
export function wipeAttempt(attempt:A1Attempt|null){if(attempt?.body instanceof Uint8Array)attempt.body.fill(0);if(attempt)attempt.body=null;}
export const A1_REJECTION_LABELS:Record<string,string>={CREDENTIAL_INPUT_INVALID:'Confira o arquivo e a senha informados.',CERTIFICATE_REJECTED:'O certificado não passou nas verificações deste perfil. Confira o arquivo, a senha e o titular.',CERTIFICATE_EXPIRED:'O certificado ou a cadeia apresentada está fora da validade.',HOLDER_MISMATCH:'O titular do certificado não corresponde à empresa cadastrada.',UNSUPPORTED_PROFILE:'O formato do arquivo precisa de avaliação de compatibilidade.',ENVELOPE_INVALID:'Não foi possível confirmar a integridade da credencial.',STORAGE_VALIDATION_FAILED:'Não foi possível conferir o arquivo cifrado armazenado.'};
