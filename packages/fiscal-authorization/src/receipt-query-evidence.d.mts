import type {PrivateJson} from './service.mjs';
export type ReceiptQuerySourceInput=Readonly<{actor:string;sourceKind:'authorization'|'revalidation';sourceCommandId:string;authorizationCommandId:string;authorizationAttemptId:string}>;
export type ReceiptQueryOriginalSource=Readonly<{receipt:PrivateJson;recovery:PrivateJson;artifact:PrivateJson;rule_review:PrivateJson;observation:PrivateJson}>;
export type ReceiptQuerySourceSnapshot=Readonly<{source_kind:'authorization'|'revalidation';source_command_id:string;authorization_command_id:string;authorization_attempt_id:string;candidate_id:string;candidate_version:number;signed_hash:string;signed_size:number;model:'55'|'65';environment:'2';origin:'operational';source_binding_hash:string;original_source:ReceiptQueryOriginalSource;selected_revalidation:Readonly<{receipt:PrivateJson;source:ReceiptQueryOriginalSource}>|null}>;
export function captureReceiptQuerySourceInput(raw:unknown):ReceiptQuerySourceInput;
export function projectReceiptQuerySource(raw:unknown,input:ReceiptQuerySourceInput):ReceiptQuerySourceSnapshot;
export function receiptQuerySourceEvidence(source:ReceiptQuerySourceSnapshot):PrivateJson;
