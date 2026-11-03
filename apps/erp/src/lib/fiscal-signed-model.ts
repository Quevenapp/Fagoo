import type {A1Current} from './a1-model';
import type {UnsignedJob} from './fiscal-unsigned-model';

export const SIGNED_BASE='/v1/fiscal-signed';
export const SIGNED_FLAGS={offline_prototype:true,environment:'2',candidate_profile:'signed-homologation-sp-v1',tax_rules_validated:false,icp_brasil_chain_validated:false,revocation_checked:false,authorized:false,can_emit:false,can_transmit:false,financial_mutation_performed:false,stock_mutation_performed:false} as const;
type Flags=typeof SIGNED_FLAGS;
export interface SignedRun {readonly command_id:string;readonly unsigned_job_id:string;readonly unsigned_hash:string;readonly basis_hash:string;readonly expected_a1_version:number;}
export interface SignedCurrent {state:'pending'|'stored'|'failed';attempt_count:number;unsigned_artifact_current:boolean;basis_changed:boolean;draft_archived:boolean;source_cancelled:boolean;series_enabled:boolean;a1_version:number;a1_changed:boolean;certificate_time_valid_now:boolean;latest_candidate_id:string;latest_candidate_version:number;is_latest_candidate:boolean;artifact_current:boolean;}
export interface SignedCandidate extends Flags {status:'pending'|'stored'|'failed';command_id?:string;candidate_id:string;candidate_version:number;unsigned_job_id:string;unsigned_hash:string;basis_hash:string;model:'55'|'65';completion_version:number;completion_hash:string;a1_version:number;error_code:string|null;signed:boolean;signature_verified:boolean;xsd_validated:boolean;current:SignedCurrent;artifact:{sha256:string;size_bytes:number;created_at:string}|null;read_only?:true;recovered?:boolean;storage_operations?:number;code?:string;}
export interface SignedUnconfirmed extends Flags {status:'recoverable'|'blocked';command_id:string;code:string;phase:string;signed:null|false;outcome:'unconfirmed'|'not_started';storage_operations:number;signature_verified:false;xsd_validated:false;}
export interface SignedHistory extends Flags {read_only:true;unsigned_job_id:string;items:SignedCandidate[];limit:number;has_more:boolean;next_cursor:number|null;}
export interface SignedExpected {candidate_id?:string;command_id?:string;unsigned_job_id?:string;unsigned_hash?:string;basis_hash?:string;a1_version?:number;completion_version?:number;completion_hash?:string;model?:'55'|'65';read_only?:boolean;}
export const signedId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,max=2147483647,min=1):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const signedShape=(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>=>object(v)&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value')&&Object.getOwnPropertyDescriptor(v,k)!.enumerable)&&required.every(k=>Object.hasOwn(v,k));
const fail=():never=>{throw new Error('Não foi possível conferir o candidato assinado. Consulte novamente o resultado.');};
function need(v:unknown):asserts v {if(!v)fail();}
function frozen<T>(v:T):T {if(v!==null&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
function stamp(v:unknown):v is string {
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(v))return false;
 const t=Date.parse(v);if(!Number.isFinite(t))return false;const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return new Date(t+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
const terminal=new Set(['XML_INPUT_INVALID','SIGNATURE_INVALID','XSD_INVALID','QR_INVALID','XML_SIZE_LIMIT','CERTIFICATE_INVALID']);
const codes=new Set(['SIGNED_ABORTED','SIGNED_ALREADY_RUNNING','SIGNED_BYTES_CHANGED','SIGNED_CERTIFICATE_TIME_INVALID','SIGNED_COMMAND_BINDING_INVALID','SIGNED_CUSTODY_BINDING_INVALID','SIGNED_CUSTODY_CALLBACK_INVALID','SIGNED_CUSTODY_NOT_COMPLETED','SIGNED_DEADLINE_INVALID','SIGNED_EXECUTION_INVALID','SIGNED_FAILURE_INVALID','SIGNED_FINISH_INVALID','SIGNED_IDENTITY_INVALID','SIGNED_INPUT_INVALID','SIGNED_LEASE_EXPIRED','SIGNED_OPTIONS_INVALID','SIGNED_PORTS_REQUIRED','SIGNED_PORT_FAILED','SIGNED_RECEIPT_BINDING_INVALID','SIGNED_RESPONSE_INVALID','SIGNED_RPC_22023','SIGNED_RPC_40001','SIGNED_RPC_42501','SIGNED_RPC_55000','SIGNED_RPC_P0002','SIGNED_SIGNATURE_RESPONSE_INVALID','SIGNED_STORAGE_ACK_INVALID','SIGNED_STORAGE_HASH_CONFLICT','SIGNED_STORAGE_LIMIT','SIGNED_STORAGE_MISSING','SIGNED_STORAGE_RESPONSE_INVALID','SIGNED_STORAGE_SIZE_INVALID','SIGNED_TIMEOUT','SIGNED_UNSIGNED_ENCODING_INVALID','SIGNED_UNSIGNED_IDENTITY_CONFLICT','SIGNED_UNSIGNED_MISSING','SIGNED_UNSIGNED_OBJECT_INVALID','SIGNED_USE_BINDING_INVALID','SIGNED_XSD_REJECTED','SIGNED_XSD_RESPONSE_INVALID']);
const fields=['status','candidate_id','candidate_version','unsigned_job_id','unsigned_hash','basis_hash','model','completion_version','completion_hash','a1_version','error_code','signed','signature_verified','xsd_validated','current','artifact'];
const currentFields=['state','attempt_count','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];
const booleans=['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current'];
function flags(v:Record<string,unknown>){need(Object.entries(SIGNED_FLAGS).every(([k,x])=>v[k]===x));}
/** Historical receipt fields never become the current A1/head or a claim of issuance. */
export function signedCandidate(raw:unknown,expected:SignedExpected={}):SignedCandidate {
 need(signedShape(raw,[...Object.keys(SIGNED_FLAGS),...fields],['command_id','read_only','recovered','storage_operations','code']));flags(raw);
 need(['pending','stored','failed'].includes(String(raw.status))&&signedId(raw.candidate_id)&&signedId(raw.unsigned_job_id)&&integer(raw.candidate_version)&&integer(raw.completion_version)&&integer(raw.a1_version)&&['55','65'].includes(String(raw.model))&&['unsigned_hash','basis_hash','completion_hash'].every(k=>hash(raw[k])));
 if(Object.hasOwn(raw,'command_id'))need(signedId(raw.command_id));
 if(Object.hasOwn(raw,'read_only'))need(raw.read_only===true);
 if(expected.read_only===true){need(raw.read_only===true);if(expected.command_id===undefined)need(!Object.hasOwn(raw,'command_id'));need(!['recovered','storage_operations','code'].some(k=>Object.hasOwn(raw,k)));}
 if(expected.read_only===false)need(!Object.hasOwn(raw,'read_only'));
 for(const[k,v]of Object.entries(expected))if(k!=='read_only'&&v!==undefined)need(raw[k]===v);
 const c=raw.current,a=raw.artifact,stored=raw.status==='stored';
 need(signedShape(c,currentFields)&&c.state===raw.status&&integer(c.attempt_count,100)&&integer(c.a1_version,2147483647,0)&&signedId(c.latest_candidate_id)&&integer(c.latest_candidate_version)&&c.latest_candidate_version>=raw.candidate_version&&booleans.every(k=>typeof c[k]==='boolean'));
 need(c.is_latest_candidate===(c.latest_candidate_id===raw.candidate_id)&&c.is_latest_candidate===(c.latest_candidate_version===raw.candidate_version)&&c.a1_changed===(c.a1_version!==raw.a1_version));
 need(c.artifact_current===(stored&&c.is_latest_candidate&&!c.a1_changed&&c.certificate_time_valid_now&&c.unsigned_artifact_current&&c.series_enabled)&&(!c.artifact_current||!c.basis_changed&&!c.draft_archived&&!c.source_cancelled));
 need(['signed','signature_verified','xsd_validated'].every(k=>raw[k]===stored)&&(raw.status==='failed'?typeof raw.error_code==='string'&&terminal.has(raw.error_code):raw.error_code===null));
 need(stored?signedShape(a,['sha256','size_bytes','created_at'])&&hash(a.sha256)&&integer(a.size_bytes,512000)&&stamp(a.created_at):a===null);
 if(Object.hasOwn(raw,'recovered'))need(typeof raw.recovered==='boolean');
 if(Object.hasOwn(raw,'storage_operations'))need(integer(raw.storage_operations,5,0));
 if(Object.hasOwn(raw,'code'))need(raw.status==='failed'&&typeof raw.code==='string'&&codes.has(raw.code));
 return frozen({...raw,current:{...c},artifact:a===null?null:{...(a as Record<string,unknown>)}} as unknown as SignedCandidate);
}
export function signedOutcome(raw:unknown,body:SignedRun):SignedCandidate|SignedUnconfirmed {
 need(validSignedRun(body));
 if(object(raw)&&['pending','stored','failed'].includes(String(raw.status)))return signedCandidate(raw,{command_id:body.command_id,unsigned_job_id:body.unsigned_job_id,unsigned_hash:body.unsigned_hash,basis_hash:body.basis_hash,a1_version:body.expected_a1_version,read_only:false});
 need(signedShape(raw,[...Object.keys(SIGNED_FLAGS),'status','command_id','code','phase','signed','outcome','storage_operations','signature_verified','xsd_validated']));flags(raw);
 need(['blocked','recoverable'].includes(String(raw.status))&&raw.command_id===body.command_id&&typeof raw.code==='string'&&codes.has(raw.code)&&['recover','begin','use','read_unsigned','inspect','custody','xsd','storage','finish','readback'].includes(String(raw.phase))&&integer(raw.storage_operations,5,0)&&raw.signature_verified===false&&raw.xsd_validated===false);
 need(raw.status==='recoverable'?raw.outcome==='unconfirmed'&&raw.signed===null:raw.outcome==='not_started'&&raw.signed===false);
 return frozen({...raw} as unknown as SignedUnconfirmed);
}
export function signedHistory(raw:unknown,jobId:string,{limit=25,before=null}:{limit?:number;before?:number|null}={}):SignedHistory {
 need(signedId(jobId)&&integer(limit,25)&&(before===null||integer(before))&&signedShape(raw,[...Object.keys(SIGNED_FLAGS),'read_only','unsigned_job_id','items','limit','has_more','next_cursor']));flags(raw);
 need(raw.read_only===true&&raw.unsigned_job_id===jobId&&raw.limit===limit&&Array.isArray(raw.items)&&raw.items.length<=limit&&typeof raw.has_more==='boolean');
 let previous=before??2147483648;const seen=new Set<string>();
 const items=raw.items.map(v=>{const row=signedCandidate(v,{unsigned_job_id:jobId,read_only:true});need(row.candidate_version<previous&&!seen.has(row.candidate_id));previous=row.candidate_version;seen.add(row.candidate_id);return row;});
 need(raw.has_more?items.length===limit&&items.length>0&&raw.next_cursor===previous:raw.next_cursor===null);
 return frozen({...SIGNED_FLAGS,read_only:true,unsigned_job_id:jobId,items,limit,has_more:raw.has_more,next_cursor:raw.next_cursor as number|null});
}
export function validSignedRun(value:unknown):value is SignedRun {
 return signedShape(value,['command_id','unsigned_job_id','unsigned_hash','basis_hash','expected_a1_version'])&&signedId(value.command_id)&&signedId(value.unsigned_job_id)&&hash(value.unsigned_hash)&&hash(value.basis_hash)&&integer(value.expected_a1_version);
}
/** Explicit action only. No number, certificate reference, XML, or automatic command creation. */
export function signedRun(job:UnsignedJob,a1:A1Current,confirmed:boolean,commandId:string):SignedRun {
 need(confirmed===true&&signedId(commandId)&&job?.status==='stored'&&job.xml_generated===true&&signedId(job.job_id)&&hash(job.basis_hash)&&job.artifact&&hash(job.artifact.sha256)&&integer(job.artifact.size_bytes,480000)&&job.current?.artifact_current===true&&job.current.is_latest_job===true&&job.current.series_enabled===true&&!job.current.basis_changed&&!job.current.draft_archived&&!job.current.source_cancelled);
 need(a1?.state==='configured_offline'&&integer(a1.version)&&a1.company_changed===false&&a1.time_valid_now===true&&signedId(a1.credential_id)&&integer(a1.company_identity_version)&&a1.metadata!==null);
 return Object.freeze({command_id:commandId,unsigned_job_id:job.job_id,unsigned_hash:job.artifact.sha256,basis_hash:job.basis_hash,expected_a1_version:a1.version});
}
/** Current state may change after ACK; immutable bindings and a previously stored artifact may not. */
export function sameSignedCandidate(a:SignedCandidate,b:SignedCandidate):boolean {
 const same=['candidate_id','candidate_version','unsigned_job_id','unsigned_hash','basis_hash','model','completion_version','completion_hash','a1_version'] as const;
 return same.every(k=>a[k]===b[k])&&(!a.artifact||Boolean(b.artifact&&a.artifact.sha256===b.artifact.sha256&&a.artifact.size_bytes===b.artifact.size_bytes&&a.artifact.created_at===b.artifact.created_at));
}
const messages:Record<string,string>={XML_INPUT_INVALID:'O arquivo de origem precisa de revisão.',SIGNATURE_INVALID:'A assinatura não passou na conferência local.',XSD_INVALID:'O candidato não passou na validação estrutural.',QR_INVALID:'O complemento da NFC-e precisa de revisão.',XML_SIZE_LIMIT:'O arquivo ultrapassa o tamanho permitido.',CERTIFICATE_INVALID:'Confira o certificado selecionado.',SIGNED_RPC_40001:'A versão ou a autorização mudou. Consulte o estado atual.',SIGNED_RPC_42501:'Seu acesso precisa ser conferido.',SIGNED_TIMEOUT:'O prazo terminou. Consulte a mesma operação antes de repetir.',SIGNED_PORT_FAILED:'Não foi possível confirmar o resultado. Consulte a mesma operação.'};
export const signedMessage=(code:string|null|undefined)=>code&&messages[code]||'Não foi possível concluir a conferência. Consulte o resultado da mesma operação.';
