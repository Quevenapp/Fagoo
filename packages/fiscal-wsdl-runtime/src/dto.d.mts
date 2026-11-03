export interface WsdlReceipt {attempt_id:string;command_id:string;profile:'sp-homologation-wsdl-evidence-v1';model:'55'|'65';operation:'protocol'|'status'|'authorization'|'receipt';environment:'2';a1_version:number;identity_version:number;confirmed:true;created_at:string;}
export interface WsdlCurrent {state:'prepared'|'dispatched'|'stored'|'failed'|'uncertain';a1_version:number;identity_version:number|null;a1_changed:boolean;company_changed:boolean;certificate_time_valid_now:boolean;grant_consumed:boolean;lease_expired:boolean;expires_at:string;used_at:string|null;finished_at:string|null;recovery_required:boolean;retry_get_allowed:false;}
export interface WsdlArtifact {sha256:string;size_bytes:number;inspection_status:'supported'|'unsupported';inspection_code:string|null;created_at:string;}
export const FLAGS:Readonly<{data_mode:'fiscal_wsdl_evidence';profile:'sp-homologation-wsdl-evidence-v1';purpose:'sefaz-sp-wsdl-readonly-v1';environment:'2';binding_verified:false;operation_authorized:false;can_query:false;can_emit:false;can_transmit:false;sefaz_authorized:false}>;
export interface WsdlResult extends Readonly<typeof FLAGS> {status:WsdlCurrent['state']|'unconfirmed';command_id:string;recovery_required:boolean;read_only:boolean;recovered:boolean;failure_code:string|null;receipt:WsdlReceipt|null;current:WsdlCurrent|null;error_code:string|null;artifact:WsdlArtifact|null;}
export const INSPECTION_CODES:readonly string[];
export const FAILURES:readonly string[];
export const SERVICE_FAILURE_CODES:readonly string[];
export function timestamp(value:unknown):value is string;
export function publicResult(value:unknown,options:{action:'run'|'command';payload?:{command_id:string;model:'55'|'65';operation:'protocol'|'status'|'authorization'|'receipt';expected_a1_version:number;expected_identity_version:number;confirmed:true};commandId?:string}):WsdlResult;
