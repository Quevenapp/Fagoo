import type { NativeDocumentCoverage } from './document-mirror.mjs';
export type ReportGroup='cadastros'|'suprimentos'|'vendas'|'financas'|'servicos'|'preferencias';
export type ReportColumnType='text'|'date'|'int'|'money'|'decimal';
export type ReportBaseId='produtos'|'contatos'|'contas_receber'|'contas_pagar'|'vendas'|'propostas'|'pedidos_compra'|'ordens_servico'|'notas_saida'|'notas_entrada'|'nfce'
 |'recebimentos'|'pagamentos'|'venda_parcela'|'comissoes'|'caixa'
 |'curva_abc'|'pessoas_contato'|'ficha_receber'|'ficha_pagar'|'ocorrencias_propostas'|'ocorrencias_os'|'ocorrencias_vendas'|'transporte_nota'|'transporte_venda';
export interface ReportColumn{id:string;label:string;type:ReportColumnType}
export interface ReportBase{base:ReportBaseId;group:ReportGroup;title:string;default_columns:readonly string[];columns:readonly ReportColumn[]}
export const REPORT_GROUPS:Readonly<Record<ReportGroup,string>>;
export const REPORT_BASES:readonly ReportBase[];
export const REPORT_PAGE:number,REPORT_PREVIEW:number,REPORT_MAX_LIMIT:number,REPORT_DEFAULT_LIMIT:number,FRAMEWORK_BODY_BYTES:number;
export class ReportsContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export function reportUuid(value:unknown):value is string;
export function reportBase(id:string):ReportBase|null;
export function sameJson(a:unknown,b:unknown):boolean;
export interface ReportFilter{column:string;value:string}
export interface ReportDefinition{base:ReportBaseId;title:string;columns:readonly string[];filters:readonly ReportFilter[];view_limit:number;with_totals:boolean;users:readonly string[]}
export interface SavedReport extends ReportDefinition{id:string;version:number;updated_at:string}
export interface ReportsView{scope:'reports';data_mode:'erp_native';can_manage:boolean;bases:ReportBase[];reports:SavedReport[];directory:{user_id:string;role:string;label:string|null}[]|null}
export interface ReportRunInput{base:ReportBaseId;columns:readonly string[];filters:readonly ReportFilter[];view_limit:number;offset:number;page:number}
export interface ReportRows extends NativeDocumentCoverage{scope:'report_rows';data_mode:'erp_native';base:ReportBaseId;columns:string[];rows:(string|null)[][];offset:number;total_rows:number;truncated:boolean;totals:Record<string,string>}
export interface ReportSaveInput{command_id:string;id:string|null;expected_version:number;data:ReportDefinition}
export interface FrameworkDeleteInput{command_id:string;items:readonly{id:string;expected_version:number}[]}
export type FrameworkOperation='report-save'|'reports-delete'|'label-save'|'labels-delete';
export interface FrameworkResult{scope:'reports_command'|'labels_command';data_mode:'erp_native';receipt:{command_id:string;action:string;target:string|null;count:number;changed_at:string};replayed:boolean}
export function parseReports(raw:unknown):ReportsView;
export function captureReportRun(raw:unknown):ReportRunInput;
export function parseReportRows(raw:unknown,run:ReportRunInput):ReportRows;
export function captureReportSave(raw:unknown):ReportSaveInput;
export function captureFrameworkDelete(raw:unknown):FrameworkDeleteInput;
export function parseFrameworkResult(raw:unknown,sent:ReportSaveInput|LabelSaveInput|FrameworkDeleteInput,operation:FrameworkOperation):FrameworkResult;
export type LabelType='contato'|'produto'|'nota_fiscal'|'ordem_servico'|'pedido_venda';
export type LabelBarcode='c128'|'ean13'|'upca'|'msi'|'upce'|'c93'|'qr'|'datamatrix';
export const LABEL_TYPES:readonly LabelType[];
export const LABEL_TYPE_LABELS:Readonly<Record<LabelType,string>>;
export const LABEL_FIELDS:Readonly<Record<LabelType,Readonly<Record<string,string>>>>;
export const LABEL_PRINTABLE:readonly LabelType[];
export const LABEL_FONTS:readonly(readonly[string,string])[];
export const LABEL_BARCODES:readonly(readonly[LabelBarcode,string])[];
export const LABEL_BARCODES_UNAVAILABLE:readonly string[];
export const LABEL_PAGES:Readonly<Record<'A2'|'A3'|'A4'|'A5',readonly[string,string]>>;
export interface LabelField{field:string;x:string;y:string;size:string;bold:boolean;barcode:boolean}
export interface LabelConfig{label:{width:string;height:string;font:string;font_size:string;barcode:LabelBarcode;barcode_text:boolean;currency:boolean;show_labels:boolean;columns_gap:string;rows_gap:string};
 page:{size:'A2'|'A3'|'A4'|'A5'|'custom';width:string|null;height:string|null;orientation:'portrait'|'landscape';margin_left:string;margin_top:string};fields:LabelField[]}
export interface LabelTemplate{id:string;type:LabelType;description:string;default:boolean;config:LabelConfig;version:number;updated_at:string|null}
export interface LabelsView{scope:'labels';data_mode:'erp_native';items:LabelTemplate[]}
export interface LabelSaveInput{command_id:string;id:string|null;expected_version:number;data:{type:LabelType;description:string;config:LabelConfig}}
export interface LabelRecordsQuery{type:LabelType;q:string|null}
export interface LabelRecords{scope:'label_records';data_mode:'erp_native';type:LabelType;items:{id:string;values:Record<string,string|null>}[]}
export const LABEL_DEFAULTS:readonly{id:string;type:LabelType;description:string;config:LabelConfig}[];
export function labelConfigValid(type:string,config:unknown):boolean;
export function parseLabels(raw:unknown):LabelsView;
export function captureLabelSave(raw:unknown):LabelSaveInput;
export function captureLabelRecordsQuery(raw?:{tipo?:string;busca?:string}):LabelRecordsQuery;
export function parseLabelRecords(raw:unknown,query:LabelRecordsQuery):LabelRecords;
export interface LabelInvoiceQuery{id:string}
export interface LabelInvoiceProducts{scope:'label_invoice_products';data_mode:'erp_native';invoice:{id:string;model:'55'|'65';number:string|null;series:string};
 items:{position:number;product_id:string|null;quantity:string;values:Record<string,string|null>}[]}
export function captureLabelInvoiceQuery(raw?:{id?:string}):LabelInvoiceQuery;
export function parseLabelInvoiceProducts(raw:unknown,query:LabelInvoiceQuery):LabelInvoiceProducts;
export const REPORT_BASES_149:readonly ReportBase[];
export const REPORT_BASES_264:readonly ReportBase[];
export const REPORT_BASES_230:readonly ReportBase[];
