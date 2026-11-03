import {publicResult,FLAGS} from '../../../../packages/fiscal-reconciliation-runtime/src/dto.mjs';
import {signedId,signedShape,signedCandidate,type SignedCandidate} from './fiscal-signed-model.ts';
import {wsdlReady} from './wsdl-model.ts';
import type {A1Current,A1Company} from './a1-model.ts';
import type {NativeRequestOptions} from './real-access.ts';
export {FLAGS as RECONCILIATION_FLAGS};
export const RECONCILIATION_BASE='/v1/fiscal-reconciliation';
export interface ReconciliationRun {readonly command_id:string;readonly candidate_id:string;readonly signed_hash:string;readonly expected_identity_version:number;readonly expected_a1_version:number;readonly confirmed:true;}
export interface ReconciliationReceipt {candidate_id:string;candidate_version:number;unsigned_job_id:string;reservation_id:string;draft_id:string;model:'55'|'65';signed_hash:string;signed_size:number;signing_a1_version:number;basis_hash:string;completion_version:number;completion_hash:string;attempt_id:string;ordinal:number;command_id:string;profile:typeof FLAGS.profile;environment:'2';identity_version:number;a1_version:number;confirmed:true;created_at:string;}
export type ReconciliationState='prepared'|'dispatched'|'stored'|'failed_before_dispatch'|'uncertain';
export interface ReconciliationCurrent {state:ReconciliationState;identity_version:number|null;a1_version:number;company_changed:boolean;a1_changed:boolean;grant_consumed:boolean;lease_expired:boolean;expires_at:string;used_at:string|null;finished_at:string|null;recovery_required:boolean;retry_transport_allowed:false;candidate:SignedCandidate['current'] & {state:'stored';lease_until:null};}
export interface ReconciliationArtifact {sha256:string;size_bytes:number;outcome:'validated'|'rejected';rejection_code:string|null;cstat:string|null;event_reconciliation_required:boolean|null;created_at:string;tls_origin_verified:true;}
export interface ReconciliationResult extends Readonly<typeof FLAGS> {status:ReconciliationState|'unconfirmed';command_id:string;receipt:ReconciliationReceipt|null;current:ReconciliationCurrent|null;error_code:string|null;artifact:ReconciliationArtifact|null;recovered:boolean;failure_code:string|null;retry_transport_allowed:false;recovery_required:boolean;read_only:boolean;recoverable_by_actor:boolean;}
export interface ReconciliationHistory extends Readonly<typeof FLAGS> {read_only:true;candidate_id:string;items:ReconciliationResult[];limit:number;has_more:boolean;next_cursor:string|null;}
export interface ReconciliationQuery {readonly limit:number;readonly before:string|null;}
export type ReconciliationSelected={action:'run';method:'POST';payload:ReconciliationRun;signal?:AbortSignal}|{action:'recover';method:'POST';payload:{readonly command_id:string};signal?:AbortSignal}|{action:'command';method:'GET';id:string;signal?:AbortSignal}|{action:'history';method:'POST';id:string;payload:ReconciliationQuery;signal?:AbortSignal};
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=2147483647;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fail():never{throw new Error('Não foi possível conferir esta consulta de protocolo. Consulte a mesma tentativa novamente.');}
function frozen<T>(v:T):T {if(v!==null&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
export function validReconciliationRun(v:unknown):v is ReconciliationRun {return signedShape(v,['command_id','candidate_id','signed_hash','expected_identity_version','expected_a1_version','confirmed'])&&signedId(v.command_id)&&signedId(v.candidate_id)&&hash(v.signed_hash)&&integer(v.expected_identity_version)&&integer(v.expected_a1_version)&&v.confirmed===true;}
/** Captures all request data before token refresh, lazy import or another await. */
export function captureReconciliationRequest(path:string,options:NativeRequestOptions={}):ReconciliationSelected {
 if(!signedShape(options,[],['method','body','signal'])||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||typeof path!=='string'||/[?#%\\]/.test(path))fail();
 const signal=options.signal,method=options.method??'GET',body=options.body;
 if(path===RECONCILIATION_BASE+'/run'){
  if(method!=='POST'||!validReconciliationRun(body))fail();return Object.freeze({action:'run',method,payload:Object.freeze({...body}),signal});
 }
 if(path===RECONCILIATION_BASE+'/recover'){
  if(method!=='POST'||!signedShape(body,['command_id'])||!signedId(body.command_id))fail();return Object.freeze({action:'recover',method,payload:Object.freeze({command_id:body.command_id}),signal});
 }
 const command=new RegExp(`^${RECONCILIATION_BASE}/commands/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$`).exec(path);
 if(command){if(method!=='GET'||Object.hasOwn(options,'body'))fail();return Object.freeze({action:'command',method,id:command[1],signal});}
 const history=new RegExp(`^${RECONCILIATION_BASE}/candidates/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/history$`).exec(path);
 if(!history||method!=='POST'||!signedShape(body,['limit','before'])||!integer(body.limit)||body.limit>25||body.before!==null&&(typeof body.before!=='string'||! /^[1-9][0-9]{0,18}$/.test(body.before)||BigInt(body.before)>9223372036854775807n))fail();
 return Object.freeze({action:'history',method,id:history[1],payload:Object.freeze({limit:body.limit,before:body.before as string|null}),signal});
}
export function reconciliationReady(candidate:SignedCandidate,a1:A1Current|null,company:A1Company|null):boolean {
 try{const c=signedCandidate(candidate);return c.status==='stored'&&c.artifact!==null&&wsdlReady(a1,company);}catch{return false;}
}
export function reconciliationRun(candidate:SignedCandidate,a1:A1Current|null,company:A1Company|null,confirmed:boolean,commandId:string):ReconciliationRun {
 if(confirmed!==true||!signedId(commandId)||!reconciliationReady(candidate,a1,company))fail();
 return Object.freeze({command_id:commandId,candidate_id:candidate.candidate_id,signed_hash:candidate.artifact!.sha256,expected_identity_version:company!.version,expected_a1_version:a1!.version,confirmed:true});
}
const ROOT=[...Object.keys(FLAGS),'status','command_id','receipt','current','error_code','artifact','recovered','failure_code','retry_transport_allowed','recovery_required','read_only','recoverable_by_actor'];
const RECEIPT=['candidate_id','candidate_version','unsigned_job_id','reservation_id','draft_id','model','signed_hash','signed_size','signing_a1_version','basis_hash','completion_version','completion_hash','attempt_id','ordinal','command_id','profile','environment','identity_version','a1_version','confirmed','created_at'];
const CURRENT=['state','identity_version','a1_version','company_changed','a1_changed','grant_consumed','lease_expired','expires_at','used_at','finished_at','recovery_required','retry_transport_allowed','candidate'];
const CANDIDATE=['state','attempt_count','lease_until','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];
const ARTIFACT=['sha256','size_bytes','outcome','rejection_code','cstat','event_reconciliation_required','created_at','tls_origin_verified'];
function strictResult(v:unknown){
 if(!signedShape(v,ROOT)||v.receipt!==null&&!signedShape(v.receipt,RECEIPT)||v.current!==null&&(!signedShape(v.current,CURRENT)||!signedShape(v.current.candidate,CANDIDATE))||v.artifact!==null&&!signedShape(v.artifact,ARTIFACT))fail();
}
export function reconciliationResponse(raw:unknown,selected:ReconciliationSelected):ReconciliationResult|ReconciliationHistory {
 try{
  if(selected.action==='history'){
   if(!signedShape(raw,[...Object.keys(FLAGS),'read_only','candidate_id','items','limit','has_more','next_cursor'])||!Array.isArray(raw.items))fail();raw.items.forEach(strictResult);
   return frozen(publicResult(raw,{action:'history',candidateId:selected.id,payload:selected.payload}) as ReconciliationHistory);
  }
  strictResult(raw);return frozen(publicResult(raw,selected.action==='command'?{action:'command',commandId:selected.id}:{action:selected.action,payload:selected.payload}) as ReconciliationResult);
 }catch{return fail();}
}
/** Current metadata can change; the acknowledged receipt and stored bytes cannot. */
export function bindReconciliationResult(value:ReconciliationResult,candidate:SignedCandidate,body:ReconciliationRun|null=null,previous:ReconciliationResult|null=null):ReconciliationResult {
 const r=value.receipt;if(r&&(r.candidate_id!==candidate.candidate_id||r.candidate_version!==candidate.candidate_version||r.model!==candidate.model||r.signed_hash!==candidate.artifact?.sha256||r.signed_size!==candidate.artifact?.size_bytes||r.unsigned_job_id!==candidate.unsigned_job_id||r.basis_hash!==candidate.basis_hash||r.completion_version!==candidate.completion_version||r.completion_hash!==candidate.completion_hash||r.signing_a1_version!==candidate.a1_version))fail();
 if(body&&(value.command_id!==body.command_id||r&&(r.a1_version!==body.expected_a1_version||r.identity_version!==body.expected_identity_version)))fail();
 if(previous){if(value.command_id!==previous.command_id)fail();if(previous.receipt&&(!r||Object.entries(previous.receipt).some(([k,v])=>r[k as keyof ReconciliationReceipt]!==v)))fail();if(previous.artifact&&(!value.artifact||Object.entries(previous.artifact).some(([k,v])=>value.artifact![k as keyof ReconciliationArtifact]!==v)))fail();}
 return value;
}
export const RECONCILIATION_LABELS:Record<ReconciliationResult['status'],string>={prepared:'Consulta preparada, ainda não enviada',dispatched:'Consulta enviada; resultado pendente',stored:'Resposta guardada',failed_before_dispatch:'Consulta encerrada antes do envio',uncertain:'Resultado ainda incerto',unconfirmed:'Resultado ainda não confirmado'};
