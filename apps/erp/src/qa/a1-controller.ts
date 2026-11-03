/** DEV-only fixture. This module is never imported by a production entry point. */
import {parseConfigure} from '../../../../packages/fiscal-runtime/src/protocol.mjs';
import type {A1Controller,A1Current,A1Receipt} from '../lib/a1-model';
export const A1_QA_FILE='BRUFAP_A1_SYNTHETIC_QA_ONLY';
export const A1_QA_PASSWORD='senha-de-teste';
const flags={data_mode:'a1_custody' as const,environment:'2' as const,purpose:'offline-homologation' as const,can_emit:false as const,can_transmit:false as const};
const company={section:'identity',data_mode:'erp_native',emission_enabled:false,record:{version:1,data:{legal_name:'EMPRESA FICTÍCIA · TESTE A1',cnpj:'12ABC34501DE35'}}};
const failure=(status:number)=>Object.assign(new Error('A1_SYNTHETIC_QA_ERROR'),{status});
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
export function createA1QaController():A1Controller {
 if(!import.meta.env.DEV||globalThis.location?.hostname!=='127.0.0.1')throw new Error('A1_QA_LOCAL_ONLY');
 let current:A1Current={version:0,state:'unconfigured',credential_id:null,company_identity_version:null,metadata:null,company_changed:false,time_valid_now:false};
 const commands=new Map<string,{receipt:A1Receipt;fingerprint:string}>();let failReadback=false;
 return{
  async company(path,{signal}={}){if(signal?.aborted)throw new DOMException('Aborted','AbortError');if(path!=='/v1/empresa/identidade')throw failure(404);return structuredClone(company);},
  async a1(path,options={}){
   if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
   if(!options.method||options.method==='GET'){
    if(path==='/v1/a1'){if(failReadback){failReadback=false;throw failure(503);}return structuredClone({...flags,current});}
    const id=/^\/v1\/a1\/commands\/([a-f0-9-]{36})$/.exec(path)?.[1],entry=id&&commands.get(id);if(!entry)throw failure(404);
    return structuredClone({...flags,current,state:'committed',receipt:entry.receipt,error_code:null});
   }
   if(options.method!=='POST'||!['/v1/a1/configure','/v1/a1/disable'].includes(path))throw failure(404);
   let request:{command_id:string;expected_version:number;expected_identity_version?:number;reason:string},fingerprint:string;
   if(path.endsWith('/configure')){
    if(!(options.body instanceof Uint8Array))throw failure(400);
    const decoded=parseConfigure(options.body);
    if(!equal(decoded.pfxBytes,new TextEncoder().encode(A1_QA_FILE))||new TextDecoder().decode(decoded.passwordBytes)!==A1_QA_PASSWORD)throw failure(422);
    request=decoded;fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',options.body as Uint8Array<ArrayBuffer>))).map(v=>v.toString(16).padStart(2,'0')).join('');
   }else{if(!options.body||options.body instanceof Uint8Array)throw failure(400);request=options.body as unknown as typeof request;fingerprint=JSON.stringify(request);}
   if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
   const prior=commands.get(request.command_id);
   if(prior){if(prior.fingerprint!==fingerprint)throw failure(409);return structuredClone({...flags,current,state:'committed',receipt:prior.receipt,replayed:true,error_code:null});}
   if(commands.size>=20||request.expected_version!==current.version||path.endsWith('/configure')&&request.expected_identity_version!==1)throw failure(409);
   const action=path.endsWith('/configure')?'configure':'disable',now=new Date(),version=current.version+1;
   if(action==='configure')current={version,state:'configured_offline',credential_id:crypto.randomUUID(),company_identity_version:1,company_changed:false,time_valid_now:true,metadata:{profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:'a'.repeat(64),holder_cnpj:company.record.data.cnpj,not_before:new Date(now.getTime()-86400000).toISOString(),not_after:new Date(now.getTime()+86400000).toISOString(),rsa_bits:2048,presented_chain:['a'.repeat(64)],validated_at:now.toISOString(),key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false}};
   else current={version,state:'disabled',credential_id:null,company_identity_version:null,metadata:null,company_changed:false,time_valid_now:false};
   const receipt:A1Receipt={command_id:request.command_id,action,version,state:current.state as 'disabled'|'configured_offline',credential_id:current.credential_id,company_identity_version:current.company_identity_version,metadata:current.metadata,recorded_at:now.toISOString()};commands.set(request.command_id,{receipt,fingerprint});
   if(request.reason.includes('QA-READBACK'))failReadback=true;
   if(request.reason.includes('QA-RETRY'))throw failure(503);
   return structuredClone({...flags,current,state:'committed',receipt,replayed:false,error_code:null});
  }
 };
}
