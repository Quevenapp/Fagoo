import type {NativeRequestOptions} from './real-access';
export interface ServiceJournalController {serviceJournal(path:string,options?:NativeRequestOptions):Promise<unknown>}
export interface ServiceJournalEntry {id:string;document_id:string;sequence:string;document_version:number;text:string;actor_id:string;recorded_at:string}
export interface ServiceJournalContext {scope:'service_order_journal';document_id:string;document_version:number;can_write:boolean;data_mode:'erp_native';operational_effects:false}
export interface ServiceJournalPage extends ServiceJournalContext {items:ServiceJournalEntry[];limit:number;has_more:boolean;next_before:string|null}
export interface ServiceJournalEnvelope extends ServiceJournalContext {entry:ServiceJournalEntry;replayed?:boolean}
export interface JournalCommand {command_id:string;expected_document_version:number;text:string}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,sequence=/^[1-9][0-9]{0,9}$/;
const fail=():never=>{throw new Error('Não foi possível conferir o diário desta OS. Atualize a consulta.');};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const version=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647;
export const journalText=(value:string)=>value.replace(/^ +| +$/g,'');
export function journalTextError(value:string):string|null {
 const clean=journalText(value);
 if(!/[^ \t\r\n]/.test(clean))return 'Descreva a atividade ou observação antes de registrar.';
 if([...clean].length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean))return 'Use até 4.000 caracteres, sem caracteres de controle.';
 return null;
}
export function journalPath(documentId:string,entryId?:string):string {
 if(!uuid.test(documentId)||(entryId!==undefined&&!uuid.test(entryId)))return fail();
 return `/v1/ordens-servico/${documentId.toLowerCase()}/diario${entryId?`/${entryId.toLowerCase()}`:''}`;
}
function context(value:unknown,documentId:string):ServiceJournalContext {
 if(!object(value)||value.scope!=='service_order_journal'||value.document_id!==documentId||!version(value.document_version)||typeof value.can_write!=='boolean'||value.data_mode!=='erp_native'||value.operational_effects!==false)return fail();
 return{scope:'service_order_journal',document_id:documentId,document_version:value.document_version,can_write:value.can_write,data_mode:'erp_native',operational_effects:false};
}
function entry(value:unknown,documentId:string):ServiceJournalEntry {
 if(!object(value)||typeof value.id!=='string'||!uuid.test(value.id)||value.document_id!==documentId||typeof value.sequence!=='string'||!sequence.test(value.sequence)||!version(value.document_version)
  ||typeof value.actor_id!=='string'||!uuid.test(value.actor_id)||typeof value.text!=='string'||journalTextError(value.text)!==null||value.text!==journalText(value.text)
  ||typeof value.recorded_at!=='string'||value.recorded_at.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.recorded_at)||!Number.isFinite(Date.parse(value.recorded_at)))return fail();
 return{id:value.id.toLowerCase(),document_id:documentId,sequence:value.sequence,document_version:value.document_version,text:value.text,actor_id:value.actor_id.toLowerCase(),recorded_at:value.recorded_at};
}
export function journalPage(value:unknown,documentId:string,before:string|null=null,limit=25):ServiceJournalPage {
 const base=context(value,documentId);if(!object(value)||!Array.isArray(value.items)||value.items.length>limit||value.limit!==limit||typeof value.has_more!=='boolean'||(value.has_more&&value.items.length!==limit)||(before!==null&&!sequence.test(before)))return fail();
 const rows=value.items.map(row=>entry(row,documentId)),ids=new Set<string>();let previous=before?BigInt(before):10000000000n;
 for(const row of rows){if(BigInt(row.sequence)>=previous||ids.has(row.id)||row.document_version>base.document_version)return fail();previous=BigInt(row.sequence);ids.add(row.id);}
 const next=value.has_more?rows.at(-1)!.sequence:null;if(value.next_before!==next)return fail();
 return{...base,items:rows,limit,has_more:value.has_more,next_before:next};
}
export function journalEnvelope(value:unknown,documentId:string,{entryId,command,actorId}:{entryId?:string;command?:JournalCommand;actorId?:string}={}):ServiceJournalEnvelope {
 const base=context(value,documentId);if(!object(value))return fail();const row=entry(value.entry,documentId);
 if(row.document_version>base.document_version||(entryId&&row.id!==entryId))return fail();
 if(command&&(row.text!==journalText(command.text)||row.document_version!==command.expected_document_version||typeof value.replayed!=='boolean'||!base.can_write||(actorId&&row.actor_id!==actorId)))return fail();
 return{...base,entry:row,...(command?{replayed:value.replayed as boolean}:{})};
}
export function sameJournalEntry(a:ServiceJournalEntry,b:ServiceJournalEntry):boolean {
 return a.id===b.id&&a.document_id===b.document_id&&a.sequence===b.sequence&&a.document_version===b.document_version&&a.text===b.text&&a.actor_id===b.actor_id&&a.recorded_at===b.recorded_at;
}
export function journalTime(value:string):string {return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(value));}
