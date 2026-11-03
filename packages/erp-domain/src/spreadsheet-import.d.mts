export type ImportKind='products'|'contacts'|'purchase_orders'|'stock_movements'|'receivables'|'payables'|'sales_orders'|'nfe'|'compositions'|'custom_fields'|'product_suppliers'|'lots';
export type ImportResultStatus='valid'|'created'|'updated'|'unchanged'|'invalid';
export type ImportJobStatus='em_andamento'|'concluida';
export const IMPORT_BASE:'/v1/importacoes';
export const IMPORT_BODY_BYTES:number;
export const IMPORT_MAX_BYTES:number;
export const IMPORT_BATCH_ITEMS:number;
export const IMPORT_BATCH_LINES:number;
export const IMPORT_FILE_ROWS:number;
export const IMPORT_FILE_BYTES:number;
export const IMPORT_KINDS:readonly ImportKind[];
export const IMPORT_SLUGS:Readonly<Record<ImportKind,string>>;
export const IMPORT_RESULT_STATUSES:readonly ImportResultStatus[];
export const IMPORT_JOB_STATUSES:readonly ImportJobStatus[];
export class ImportContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export interface ImportOption{value:string;label:string;aliases:string[]}
export interface ImportColumn{label:string;key:string;t:'text'|'digits'|'decimal'|'integer'|'date'|'bool'|'option';max?:number;multiline?:boolean;lengths?:number[];int?:number;scale?:number;
 signed?:boolean;positive?:boolean;options?:ImportOption[];required?:boolean;createRequired?:boolean;match?:boolean;group?:boolean;line?:boolean}
export interface ImportGroup{key:string;unit:string;max?:number;tooMany:string;itemRequired:readonly string[];itemOneOf?:readonly string[];contact:boolean}
export interface ImportTemplate{kind:ImportKind;title:string;noun:[string,string];file:string;columns:readonly ImportColumn[]|null;readOnly:readonly string[];rule:string;oneOf?:readonly string[];grouped?:ImportGroup}
export const IMPORT_TEMPLATES:Readonly<Record<ImportKind,ImportTemplate>>;
export type ImportValue=string|boolean|ImportData[]|string[];
export interface ImportData{[key:string]:ImportValue}
export interface ImportItem{row:number;lines:number[];data:ImportData;problems:string[]}
export interface TemplateRows{items:ImportItem[];missing:string[];unknown:string[];readOnly:string[]}
export function importUuid(value:unknown):value is string;
export function importKindOf(slug:string):ImportKind|null;
export function foldHeader(value:unknown):string;
export function isGroupedKind(kind:ImportKind):boolean;
export function isoDay(value:unknown):value is string;
export function normalizeCell(column:ImportColumn,raw:unknown):{value?:string|boolean;problem?:string};
export function mapHeader(columns:readonly ImportColumn[],header:readonly string[],mapping?:Record<string,string>):{index:Map<string,number>;unknown:string[]};
export function templateRows(kind:ImportKind,cells:readonly (readonly string[])[],mapping?:Record<string,string>):TemplateRows;
export function templateHeader(kind:ImportKind):string[];
export interface ImportBatchInput{kind:ImportKind;command_id:string|null;job_id:string|null;file_name:string;total_rows:number;dry_run:boolean;items:readonly {row:number;lines:number[];data:unknown}[]}
export function captureImportBatch(kind:ImportKind,body:unknown,options?:{validateContact?:(data:unknown)=>unknown}):ImportBatchInput;
export interface ImportResult{row:number;status:ImportResultStatus;action:'create'|'update'|null;reason:string|null;field:string|null;record_id:string|null;reference:string|null}
export interface ImportJob{id:string;kind:ImportKind;file_name:string;total_rows:number;rows_done:number;created:number;updated:number;unchanged:number;invalid:number;status:ImportJobStatus;
 actor:{user_id:string;label:string};created_at:string;updated_at:string;finished_at:string|null}
export interface ImportBatchResult{scope:'import_batch';data_mode:'erp_native';kind:ImportKind;dry_run:boolean;replayed:boolean;job:ImportJob|null;items:ImportResult[]}
export function parseImportBatchResult(raw:unknown,input:Pick<ImportBatchInput,'kind'|'dry_run'|'job_id'|'file_name'|'total_rows'|'items'>):ImportBatchResult;
export interface ImportJobsQuery{status:ImportJobStatus|null;limit:number;offset:number}
export interface ImportJobsPage{scope:'import_jobs';data_mode:'erp_native';status:ImportJobStatus|null;limit:number;offset:number;total:number;has_more:boolean;all_users:boolean;items:ImportJob[]}
export function captureJobsQuery(query?:{situacao?:string|null;limit?:number;offset?:number}):ImportJobsQuery;
export function parseJobs(raw:unknown,query:ImportJobsQuery):ImportJobsPage;
export interface ImportJobQuery{id:string;errors:boolean;limit:number;offset:number}
export interface ImportJobPage{scope:'import_job';data_mode:'erp_native';job:ImportJob;errors:boolean;limit:number;offset:number;total:number;has_more:boolean;items:ImportResult[]}
export function captureJobQuery(id:string,query?:{erros?:string|null;limit?:number;offset?:number}):ImportJobQuery;
export function parseJob(raw:unknown,query:ImportJobQuery):ImportJobPage;
