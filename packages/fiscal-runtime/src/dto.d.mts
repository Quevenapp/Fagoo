export interface CredentialMetadata {
  profile:'openssl3-pkcs12';legacy_provider_enabled:boolean;pfx_mac:string;pfx_mac_iterations:number;
  fingerprint_sha256:string;holder_cnpj:string;not_before:string;not_after:string;rsa_bits:number;presented_chain:string[];validated_at:string;
  key_matches_certificate:true;presented_chain_links_checked:true;icp_brasil_chain_validated:false;revocation_checked:false;a1_policy_verified:false;client_auth_eku_verified:false;can_transmit:false;
}
export interface A1Current {version:number;state:'unconfigured'|'disabled'|'configured_offline';credential_id:string|null;company_identity_version:number|null;metadata:CredentialMetadata|null;company_changed:boolean;time_valid_now:boolean;}
export interface A1Receipt {command_id:string;action:'configure'|'rewrap'|'disable';version:number;state:'disabled'|'configured_offline';credential_id:string|null;company_identity_version:number|null;metadata:CredentialMetadata|null;recorded_at:string;}
export interface A1Envelope {data_mode:'a1_custody';environment:'2';purpose:'offline-homologation';can_emit:false;can_transmit:false;current:A1Current;state?:'pending'|'committed'|'rejected';receipt?:A1Receipt|null;error_code?:string|null;replayed?:boolean;}
export function publicResult(value:unknown,options:{action:'metadata'|'command'|'configure'|'rewrap'|'disable';commandId?:string}):A1Envelope;
export function timestamp(value:unknown):value is string;
