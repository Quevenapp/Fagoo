import type {AccessRole} from './access-users.mjs';
export declare const SECURITY_BASE:'/v1/seguranca';
export declare const SECURITY_BODY_BYTES:number;
export declare const SECURITY_RESPONSE_BYTES:number;
export declare class AccessSecurityContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export interface SecurityMember{user_id:string;name:string;role:AccessRole;factor:boolean}
export interface SecurityPolicyState{mfa_required:boolean;version:number;updated_at:string|null;members:SecurityMember[]}
export interface SecurityPolicy{scope:'access_security_policy';data_mode:'erp_native';policy:SecurityPolicyState;self:{factor:boolean;aal2:boolean}}
export interface SecurityPolicySaveInput{command_id:string;expected_version:number;mfa_required:boolean}
export interface SecurityPolicyAnswer{scope:'access_security_command';data_mode:'erp_native';receipt:{command_id:string;from_version:number;to_version:number;changed_at:string};policy:SecurityPolicyState;replayed:boolean}
export interface MfaResetAnswer{scope:'access_mfa_reset';data_mode:'erp_native';command_id:string;target:string;removed:number;changed_at:string;replayed:boolean}
export declare function securityUuid(value:unknown):value is string;
export declare function parseSecurityPolicy(raw:unknown):SecurityPolicy;
export declare function captureSecurityPolicySave(raw:unknown):Readonly<SecurityPolicySaveInput>;
export declare function parseSecurityPolicyResult(raw:unknown,input:SecurityPolicySaveInput):SecurityPolicyAnswer&{gates:{user_id:string;gate_required:boolean}[]};
export declare function parseSecurityPolicyAnswer(raw:unknown,input:SecurityPolicySaveInput):SecurityPolicyAnswer;
export declare function captureMfaReset(raw:unknown):Readonly<{command_id:string}>;
export declare function parseMfaResetAnswer(raw:unknown,expected:{commandId:string;target:string}):MfaResetAnswer;
