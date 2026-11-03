import type {AccessState,AttachmentRequestOptions,NativeRequestOptions} from './real-access';

export interface ServiceEventsController {
 getSnapshot():Pick<AccessState,'phase'|'membership'>;
 serviceEvents(path:string,options?:NativeRequestOptions):Promise<unknown>;
 attachments(path:string,options?:AttachmentRequestOptions):Promise<unknown>;
}
export const EVENT_TYPES=['reception','customer_decision','delivery'] as const;
export type ServiceEventType=typeof EVENT_TYPES[number];
export const EVENT_LABELS:Record<ServiceEventType,string>={reception:'Recepção do equipamento',customer_decision:'Decisão do cliente',delivery:'Entrega do equipamento'};
export const DECLARANT_LABELS={customer:'Cliente',representative:'Representante',other:'Outra pessoa'} as const;
export const CHANNEL_LABELS={in_person:'Presencial',phone:'Telefone',email:'E-mail',message:'Mensagem',document:'Documento',other:'Outro meio'} as const;
export type EventDetails={accessories:string|null;apparent_condition:string}|{decision:'approved'|'rejected';channel:keyof typeof CHANNEL_LABELS}|{delivered_condition:string;tests_summary:string|null};
export interface ServiceEventData {type:ServiceEventType;occurred_on:string;declarant_name:string;declarant_role:keyof typeof DECLARANT_LABELS;details:EventDetails;notes:string|null;attachment_id:string|null;corrects_event_id:string|null;correction_reason:string|null;confirm_record:true}
export interface ServiceEventCommand {command_id:string;expected_document_version:number;data:ServiceEventData}
export interface ServiceEventAttachment {id:string;filename:string;mime_type:string;size_bytes:number;sha256:string}
export interface ServiceEventRecord {
 id:string;document_id:string;sequence:string;type:ServiceEventType;document_version:number;document_status:string;commercial_hash:string;total:string;
 snapshot:{number:string;contact:{id:string;name:string};equipment:string|null;serial_number:string|null;technician:string|null};
 occurred_on:string;declarant_name:string;declarant_role:keyof typeof DECLARANT_LABELS;details:EventDetails;notes:string|null;attachment:ServiceEventAttachment|null;
 corrects_event_id:string|null;correction_reason:string|null;actor_id:string;recorded_at:string;
}
export interface ServiceEventCurrent {document_version:number;document_status:string;document_version_changed:boolean;commercial_content_changed:boolean;total_changed:boolean;corrected_by_event_id:string|null;approval_basis_matches_current:boolean}
export interface ServiceEventRow {record:ServiceEventRecord;current:ServiceEventCurrent}
export interface ServiceEventContext {scope:'service_order_events';data_mode:'erp_native';signature_verified:false;consent_verified:false;changes_document_status:false;financial_mutation_performed:false;stock_mutation_performed:false;document:{id:string;kind:'service_orders';number:string;version:number;status:string;total:string;commercial_hash:string};can_record:boolean;allowed_event_types:ServiceEventType[]}
export interface ServiceEventPage extends ServiceEventContext {read_only:true;items:ServiceEventRow[];limit:number;has_more:boolean;next_before:string|null}
export interface ServiceEventEnvelope extends ServiceEventContext,ServiceEventRow {read_only?:true;replayed?:boolean}
export interface ServiceEventForm {type:ServiceEventType|'';occurred_on:string;declarant_name:string;declarant_role:keyof typeof DECLARANT_LABELS|'';accessories:string;apparent_condition:string;decision:'approved'|'rejected'|'';channel:keyof typeof CHANNEL_LABELS|'';delivered_condition:string;tests_summary:string;notes:string;attachment_choice:string;correction_reason:string;confirmed:boolean}
export const emptyEventForm=():ServiceEventForm=>({type:'',occurred_on:'',declarant_name:'',declarant_role:'',accessories:'',apparent_condition:'',decision:'',channel:'',delivered_condition:'',tests_summary:'',notes:'',attachment_choice:'',correction_reason:'',confirmed:false});
export type EventFormErrors=Partial<Record<keyof ServiceEventForm,string>>;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/,SEQ=/^[1-9][0-9]{0,9}$/;
const STATES=['open','quoted','service_done','finalized','rejected','approved','in_progress','waiting_parts','no_repair','cancelled'];
const FLAGS={scope:'service_order_events',data_mode:'erp_native',signature_verified:false,consent_verified:false,changes_document_status:false,financial_mutation_performed:false,stock_mutation_performed:false} as const;
const fail=():never=>{throw new Error('Não foi possível conferir os eventos desta OS. Atualize a consulta.');};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v),hash=(v:unknown):v is string=>typeof v==='string'&&HASH.test(v);
const seq=(v:unknown):v is string=>typeof v==='string'&&SEQ.test(v),version=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=2147483647;
const money=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(v);
const trim=/^[ \t\r\n\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\r\n\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g;
export const eventText=(v:string)=>v.replace(trim,'');
function text(v:unknown,max:number,nullable=false,multiline=false):v is string|null {return v===null?nullable:typeof v==='string'&&v===eventText(v)&&[...v].length>=1&&[...v].length<=max&&!/[<>]/.test(v)&&!(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/:/[\x00-\x1f\x7f-\x9f]/).test(v);}
const historicalText=(v:unknown,max:number,nullable=false):v is string|null=>v===null?nullable:typeof v==='string'&&[...v].length>=1&&[...v].length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(v);
export function eventDate(v:unknown):v is string {return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2099-12-31'&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function stamp(v:unknown):v is string {
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return (!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
export const serviceEventToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function serviceEventsPath(documentId:string,eventId?:string){if(!id(documentId)||eventId!==undefined&&!id(eventId))return fail();return `/v1/ordens-servico/${documentId}/eventos${eventId?`/${eventId}`:''}`;}
const allowed=(status:string):ServiceEventType[]=>status==='cancelled'?[]:['reception',...(['quoted','approved','rejected'].includes(status)?['customer_decision' as const]:[]),...(['service_done','finalized','no_repair'].includes(status)?['delivery' as const]:[])];
function details(v:unknown,type:ServiceEventType):EventDetails {
 if(type==='reception'&&exact(v,['accessories','apparent_condition'])&&text(v.accessories,1000,true,true)&&text(v.apparent_condition,1000,false,true))return{accessories:v.accessories,apparent_condition:v.apparent_condition!};
 if(type==='delivery'&&exact(v,['delivered_condition','tests_summary'])&&text(v.delivered_condition,1000,false,true)&&text(v.tests_summary,1000,true,true))return{delivered_condition:v.delivered_condition!,tests_summary:v.tests_summary};
 if(type==='customer_decision'&&exact(v,['decision','channel'])&&['approved','rejected'].includes(v.decision as string)&&typeof v.channel==='string'&&Object.hasOwn(CHANNEL_LABELS,v.channel))return{decision:v.decision as 'approved'|'rejected',channel:v.channel as keyof typeof CHANNEL_LABELS};
 return fail();
}
const MIME={'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','application/xml':'xml','text/plain':'txt'} as const;
function attachment(v:unknown):ServiceEventAttachment|null {
 if(v===null)return null;
 if(!object(v)||!id(v.id)||typeof v.mime_type!=='string'||!Object.hasOwn(MIME,v.mime_type)||typeof v.size_bytes!=='number'||!Number.isInteger(v.size_bytes)||v.size_bytes<1||v.size_bytes>10485760||!hash(v.sha256)||typeof v.filename!=='string'||!new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${MIME[v.mime_type as keyof typeof MIME]}$`).test(v.filename))return fail();
 return{id:v.id,filename:v.filename,mime_type:v.mime_type,size_bytes:v.size_bytes,sha256:v.sha256};
}
export function serviceEventAttachments(v:unknown,documentId:string):ServiceEventAttachment[] {
 if(!object(v)||v.data_mode!=='erp_native'||v.document_id!==documentId||!Array.isArray(v.items)||v.items.length>100)return fail();
 const seen=new Set<string>(),rows:ServiceEventAttachment[]=[];
 for(const item of v.items){if(!object(item)||item.document_id!==documentId||!['reserved','ready','aborted'].includes(item.status as string))return fail();const parsed=attachment(item);if(!parsed||seen.has(parsed.id))return fail();seen.add(parsed.id);if(item.status==='ready')rows.push(parsed);}
 return rows;
}
function context(v:unknown,documentId:string):ServiceEventContext {
 if(!object(v)||Object.entries(FLAGS).some(([k,value])=>v[k]!==value)||!object(v.document))return fail();const d=v.document;
 if(d.id!==documentId||d.kind!=='service_orders'||!seq(d.number)||!version(d.version)||!STATES.includes(d.status as string)||!money(d.total)||!hash(d.commercial_hash)||typeof v.can_record!=='boolean'||!Array.isArray(v.allowed_event_types))return fail();
 const expected=v.can_record?allowed(d.status as string):[];
 if(v.allowed_event_types.length!==expected.length||v.allowed_event_types.some((item,i)=>item!==expected[i])||d.status==='cancelled'&&v.can_record)return fail();
 return{...FLAGS,document:{id:documentId,kind:'service_orders',number:d.number,version:d.version,status:d.status as string,total:d.total,commercial_hash:d.commercial_hash},can_record:v.can_record,allowed_event_types:expected};
}
function row(v:unknown,document:ServiceEventContext['document']):ServiceEventRow {
 if(!object(v)||!object(v.record)||!object(v.current))return fail();const r=v.record,c=v.current,s=r.snapshot;
 if(!id(r.id)||r.document_id!==document.id||!seq(r.sequence)||!EVENT_TYPES.includes(r.type as ServiceEventType)||!version(r.document_version)||r.document_version>document.version||!STATES.includes(r.document_status as string)||!hash(r.commercial_hash)||!money(r.total)||!object(s)||s.number!==document.number||!object(s.contact)||!id(s.contact.id)||!historicalText(s.contact.name,200)||!historicalText(s.equipment,4000,true)||!historicalText(s.serial_number,100,true)||!historicalText(s.technician,200,true)||!eventDate(r.occurred_on)||!text(r.declarant_name,200)||typeof r.declarant_role!=='string'||!Object.hasOwn(DECLARANT_LABELS,r.declarant_role)||!text(r.notes,2000,true,true)||!(r.corrects_event_id===null||id(r.corrects_event_id))||!text(r.correction_reason,1000,r.corrects_event_id===null,true)||!id(r.actor_id)||!stamp(r.recorded_at))return fail();
 if(r.corrects_event_id===null?r.correction_reason!==null:r.corrects_event_id===r.id||r.correction_reason===null||[...r.correction_reason].length<3)return fail();
 const d=details(r.details,r.type as ServiceEventType),a=attachment(r.attachment);
 if(c.document_version!==document.version||c.document_status!==document.status||c.document_version_changed!==(r.document_version!==document.version)||c.commercial_content_changed!==(r.commercial_hash!==document.commercial_hash)||c.total_changed!==(r.total!==document.total)||!(c.corrected_by_event_id===null||id(c.corrected_by_event_id))||c.corrected_by_event_id===r.id||typeof c.approval_basis_matches_current!=='boolean')return fail();
 if(c.approval_basis_matches_current&&(r.type!=='customer_decision'||!('decision'in d)||d.decision!=='approved'||c.document_version_changed||c.commercial_content_changed||c.total_changed||c.corrected_by_event_id!==null||document.status==='cancelled'))return fail();
 return{record:{id:r.id,document_id:document.id,sequence:r.sequence,type:r.type as ServiceEventType,document_version:r.document_version,document_status:r.document_status as string,commercial_hash:r.commercial_hash,total:r.total,snapshot:{number:s.number as string,contact:{id:s.contact.id,name:s.contact.name!},equipment:s.equipment,serial_number:s.serial_number,technician:s.technician},occurred_on:r.occurred_on,declarant_name:r.declarant_name!,declarant_role:r.declarant_role as keyof typeof DECLARANT_LABELS,details:d,notes:r.notes,attachment:a,corrects_event_id:r.corrects_event_id,correction_reason:r.correction_reason,actor_id:r.actor_id,recorded_at:r.recorded_at},current:{document_version:document.version,document_status:document.status,document_version_changed:c.document_version_changed as boolean,commercial_content_changed:c.commercial_content_changed as boolean,total_changed:c.total_changed as boolean,corrected_by_event_id:c.corrected_by_event_id,approval_basis_matches_current:c.approval_basis_matches_current}};
}
function same(a:unknown,b:unknown):boolean {if(a===b)return true;if(!object(a)||!object(b))return false;return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
export const sameServiceEvent=(a:ServiceEventRecord,b:ServiceEventRecord)=>same(a,b);
export function serviceEventPage(v:unknown,documentId:string,before:string|null=null,limit=25):ServiceEventPage {
 const base=context(v,documentId);if(!object(v)||v.read_only!==true||v.limit!==limit||!Array.isArray(v.items)||v.items.length>limit||typeof v.has_more!=='boolean'||v.has_more&&v.items.length!==limit||before!==null&&!seq(before))return fail();
 let previous=BigInt(before??'10000000000');const seen=new Set<string>(),items=v.items.map(item=>{const parsed=row(item,base.document);if(BigInt(parsed.record.sequence)>=previous||seen.has(parsed.record.id))return fail();previous=BigInt(parsed.record.sequence);seen.add(parsed.record.id);return parsed;});
 const next=v.has_more?items.at(-1)!.record.sequence:null;if(v.next_before!==next)return fail();return{...base,read_only:true,items,limit,has_more:v.has_more,next_before:next};
}
export function serviceEventEnvelope(v:unknown,documentId:string,{eventId,command,actorId}:{eventId?:string;command?:ServiceEventCommand;actorId?:string}={}):ServiceEventEnvelope {
 const base=context(v,documentId),parsed=row(v,base.document);if(!object(v)||eventId&&parsed.record.id!==eventId)return fail();
 if(command){const r=parsed.record,d=command.data;if(typeof v.replayed!=='boolean'||!actorId||r.actor_id!==actorId||r.document_version!==command.expected_document_version||['type','occurred_on','declarant_name','declarant_role','notes','corrects_event_id','correction_reason'].some(k=>r[k as keyof ServiceEventRecord]!==d[k as keyof ServiceEventData])||!same(r.details,d.details)||(r.attachment?.id??null)!==d.attachment_id||!v.replayed&&(!base.can_record||base.document.version!==r.document_version||!base.allowed_event_types.includes(r.type)))return fail();return{...base,...parsed,replayed:v.replayed};}
 if(v.read_only!==true)return fail();return{...base,...parsed,read_only:true};
}
export function eventFormData(form:ServiceEventForm,correction:ServiceEventRecord|null,available:ServiceEventAttachment[],today=serviceEventToday()):{errors:EventFormErrors;data:ServiceEventData|null} {
 const errors:EventFormErrors={};const check=(key:keyof ServiceEventForm,max:number,required=false,multiline=false)=>{const value=eventText(String(form[key]));if(!text(value||null,max,!required,multiline))errors[key]=required&&!value?'Preencha este campo.':`Use até ${max} caracteres de texto simples.`;return value||null;};
 if(!EVENT_TYPES.includes(form.type as ServiceEventType)||correction&&form.type!==correction.type)errors.type='Escolha o tipo de registro.';
 if(!eventDate(form.occurred_on)||form.occurred_on>today)errors.occurred_on='Informe uma data válida, até hoje em São Paulo.';
 const name=check('declarant_name',200,true);if(!Object.hasOwn(DECLARANT_LABELS,form.declarant_role))errors.declarant_role='Informe o vínculo da pessoa com a OS.';
 let d:EventDetails={accessories:null,apparent_condition:''};
 if(form.type==='reception')d={accessories:check('accessories',1000,false,true),apparent_condition:check('apparent_condition',1000,true,true)??''};
 if(form.type==='customer_decision'){if(!['approved','rejected'].includes(form.decision))errors.decision='Selecione a decisão comunicada.';if(!Object.hasOwn(CHANNEL_LABELS,form.channel))errors.channel='Selecione o meio da comunicação.';d={decision:form.decision as 'approved'|'rejected',channel:form.channel as keyof typeof CHANNEL_LABELS};}
 if(form.type==='delivery')d={delivered_condition:check('delivered_condition',1000,true,true)??'',tests_summary:check('tests_summary',1000,false,true)};
 const notes=check('notes',2000,false,true),reason=correction?check('correction_reason',1000,true,true):null;if(correction&&reason&&[...reason].length<3)errors.correction_reason='Explique a correção com pelo menos 3 caracteres.';
 if(form.attachment_choice!=='none'&&!available.some(a=>a.id===form.attachment_choice))errors.attachment_choice='Escolha um anexo disponível ou informe que este registro será sem anexo.';
 if(!form.confirmed)errors.confirmed='Confirme a declaração e a versão da OS antes de registrar.';
 if(Object.keys(errors).length)return{errors,data:null};
 return{errors,data:{type:form.type as ServiceEventType,occurred_on:form.occurred_on,declarant_name:name!,declarant_role:form.declarant_role as keyof typeof DECLARANT_LABELS,details:d,notes,attachment_id:form.attachment_choice==='none'?null:form.attachment_choice,corrects_event_id:correction?.id??null,correction_reason:reason,confirm_record:true}};
}
export function correctionForm(record:ServiceEventRecord,available:ServiceEventAttachment[]):ServiceEventForm {
 const f={...emptyEventForm(),type:record.type,occurred_on:record.occurred_on,declarant_name:record.declarant_name,declarant_role:record.declarant_role,notes:record.notes??'',attachment_choice:record.attachment?(available.some(a=>a.id===record.attachment!.id)?record.attachment.id:''):'none'};
 if('accessories'in record.details){f.accessories=record.details.accessories??'';f.apparent_condition=record.details.apparent_condition;}
 if('decision'in record.details){f.decision=record.details.decision;f.channel=record.details.channel;}
 if('delivered_condition'in record.details){f.delivered_condition=record.details.delivered_condition;f.tests_summary=record.details.tests_summary??'';}
 return f;
}
export const serviceEventTime=(value:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(value));
export const serviceEventDay=(value:string)=>value.split('-').reverse().join('/');
