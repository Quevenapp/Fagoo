import type {AccessState,NativeRequestOptions} from './real-access';
import {SYSTEM_BASE} from '../../../../packages/erp-domain/src/system-profile.mjs';
import {REPORT_GROUPS,REPORT_BASES,REPORT_PAGE,REPORT_PREVIEW,REPORT_MAX_LIMIT,REPORT_DEFAULT_LIMIT,reportBase,parseReports,captureReportRun,parseReportRows,captureReportSave,captureFrameworkDelete,parseFrameworkResult,
 LABEL_TYPES,LABEL_TYPE_LABELS,LABEL_FIELDS,LABEL_PRINTABLE,LABEL_FONTS,LABEL_BARCODES,LABEL_BARCODES_UNAVAILABLE,LABEL_PAGES,labelConfigValid,parseLabels,captureLabelSave,captureLabelRecordsQuery,parseLabelRecords,captureLabelInvoiceQuery,parseLabelInvoiceProducts,
 type ReportGroup,type ReportBase,type ReportBaseId,type ReportColumn,type ReportFilter,type SavedReport,type ReportsView,type ReportRunInput,type ReportRows,type ReportSaveInput,type FrameworkDeleteInput,
 type LabelType,type LabelBarcode,type LabelConfig,type LabelField,type LabelTemplate,type LabelsView,type LabelSaveInput,type LabelRecords,type LabelRecordsQuery,type LabelInvoiceProducts,type LabelInvoiceQuery} from '../../../../packages/erp-domain/src/reports-labels.mjs';
export {REPORT_GROUPS,REPORT_BASES,REPORT_PAGE,REPORT_PREVIEW,REPORT_MAX_LIMIT,REPORT_DEFAULT_LIMIT,reportBase,parseReports,captureReportRun,parseReportRows,captureReportSave,captureFrameworkDelete,parseFrameworkResult,
 LABEL_TYPES,LABEL_TYPE_LABELS,LABEL_FIELDS,LABEL_PRINTABLE,LABEL_FONTS,LABEL_BARCODES,LABEL_BARCODES_UNAVAILABLE,LABEL_PAGES,labelConfigValid,parseLabels,captureLabelSave,captureLabelRecordsQuery,parseLabelRecords,captureLabelInvoiceQuery,parseLabelInvoiceProducts};
export type {ReportGroup,ReportBase,ReportBaseId,ReportColumn,ReportFilter,SavedReport,ReportsView,ReportRunInput,ReportRows,ReportSaveInput,FrameworkDeleteInput,LabelType,LabelBarcode,LabelConfig,LabelField,
 LabelTemplate,LabelsView,LabelSaveInput,LabelRecords,LabelRecordsQuery,LabelInvoiceProducts,LabelInvoiceQuery};
export interface ReportsController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;system:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
export const REPORTS_PATH=`${SYSTEM_BASE}/relatorios`,REPORT_RUN_PATH=`${SYSTEM_BASE}/relatorios/execucao`,REPORTS_DELETE_PATH=`${SYSTEM_BASE}/relatorios/exclusao`;
export const LABELS_PATH=`${SYSTEM_BASE}/etiquetas`,LABELS_DELETE_PATH=`${SYSTEM_BASE}/etiquetas/exclusao`;
/** 230: the product labels of one note ("Imprimir etiquetas" of the notas list). */
export const labelInvoicePath=(id:string)=>`${SYSTEM_BASE}/etiquetas/nota?id=${id}`;
export const labelRecordsPath=(q:LabelRecordsQuery)=>`${SYSTEM_BASE}/etiquetas/registros?tipo=${q.type}${q.q?`&busca=${encodeURIComponent(q.q)}`:''}`;
export const REPORTS_SCREEN='/preferencias/sistema/relatorios-customizados',LABELS_SCREEN='/preferencias/sistema/etiquetas-customizadas';
const group=(digits:string)=>digits.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
/** Decimal string to pt-BR (exact: no float). Money keeps two decimals. */
export function brNumber(value:string|null,type:ReportColumn['type']|'money'='decimal'){
 if(value===null)return '';const negative=value.startsWith('-'),[whole='0',fraction='']=value.replace('-','').split('.');
 const frac=type==='money'?fraction.padEnd(2,'0').slice(0,2):fraction.replace(/0+$/,'').padEnd(2,'0');
 return `${negative?'-':''}${type==='money'?'R$ ':''}${group(whole)}${type==='int'?'':`,${frac}`}`;
}
export const brDate=(value:string|null)=>value?value.split('-').reverse().join('/'):'';
export function cellText(column:ReportColumn,value:string|null){
 if(value===null)return '';if(column.type==='date')return brDate(value);if(column.type==='money')return brNumber(value,'money');if(column.type==='decimal')return brNumber(value,'decimal');
 if(column.type==='int')return group(value);return value;
}
/** Sum of decimal strings, exact (scaled bigint), with the largest scale of the inputs. */
export function sumDecimals(values:readonly(string|null)[]){
 const list=values.filter((v):v is string=>v!==null),scale=Math.max(2,...list.map(v=>(v.split('.')[1]??'').length));
 const total=list.reduce((s,v)=>{const negative=v.startsWith('-'),[w='0',f='']=v.replace('-','').split('.');const n=BigInt(w+f.padEnd(scale,'0'));return s+(negative?-n:n);},0n);
 const negative=total<0n,digits=(negative?-total:total).toString().padStart(scale+1,'0');
 return `${negative?'-':''}${digits.slice(0,-scale)}.${digits.slice(-scale)}`;
}
/** Messages of a refused command (the SQL code reaches the browser as the HTTP status). */
export function frameworkFailure(status:number|null,subject:string){
 if(status===409)return{definitive:true,reload:true,message:`${subject} foi alterado por outra pessoa ou o nome já existe. A tela foi recarregada; confira e tente de novo.`};
 if(status===400)return{definitive:true,reload:false,message:`${subject}: os dados não foram aceitos. Confira os campos e tente de novo.`};
 if(status===403)return{definitive:true,reload:false,message:'Somente administradores alteram estas configurações.'};
 if(status===404)return{definitive:true,reload:true,message:`${subject} não existe mais. A tela foi recarregada.`};
 return{definitive:false,reload:false,message:'Não foi possível confirmar se a alteração foi salva. Use Conferir resultado para reenviar o mesmo comando.'};
}
/** Page size of the label sheet in millimeters, after the orientation. */
export function pageSize(config:LabelConfig):[number,number]{
 const [w,h]=config.page.size==='custom'?[Number(config.page.width),Number(config.page.height)]:LABEL_PAGES[config.page.size].map(Number) as [number,number];
 return config.page.orientation==='landscape'?[h,w]:[w,h];
}
/** How many labels fit in one page (columns × rows), at least one. */
export function labelsPerPage(config:LabelConfig){
 const [w,h]=pageSize(config),l=config.label,cols=Math.max(1,Math.floor((w-Number(config.page.margin_left)+Number(l.columns_gap))/(Number(l.width)+Number(l.columns_gap))));
 const rows=Math.max(1,Math.floor((h-Number(config.page.margin_top)+Number(l.rows_gap))/(Number(l.height)+Number(l.rows_gap))));
 return{cols,rows,total:cols*rows};
}
/** Sample values for the editor preview, one per field of the type. */
export const LABEL_SAMPLE:Record<LabelType,Record<string,string>>={
 produto:{codigo:'CAN-001',descricao:'Caneta esferográfica azul',preco:'2.50',unidade:'UN',gtin:'7891234567895',ncm:'96081000'},
 contato:{nome:'Cliente Exemplo Ltda',fantasia:'Exemplo',documento:'11.222.333/0001-81',endereco:'Rua Exemplo, 100',bairro:'Centro',cidade_uf:'São Paulo/SP',cep:'01001-000',telefone:'(11) 3333-0000'},
 pedido_venda:{numero:'1234',data:'2026-10-20',cliente:'Cliente Exemplo Ltda',endereco_cliente:'Rua Exemplo, 100',cidade_uf:'São Paulo/SP',cep:'01001-000',total:'150.00'},
 ordem_servico:{numero:'567',data:'2026-10-20',cliente:'Cliente Exemplo Ltda',total:'320.00'},
 nota_fiscal:{numero:'000123',serie:'1',cliente:'Cliente Exemplo Ltda',endereco_cliente:'Rua Exemplo, 100',cidade_uf:'São Paulo/SP',chave:'35261011222333000181550010000001231000001230'},
};
/** Text of one field on a label (money with R$ when "moeda" is on, dates in dd/mm/aaaa). */
export function labelText(type:LabelType,field:string,value:string|null,config:LabelConfig){
 if(value===null)return '';const label=config.label.show_labels?`${LABEL_FIELDS[type][field]}: `:'';
 const money=['preco','total'].includes(field),date=field==='data';
 return label+(money?(config.label.currency?brNumber(value,'money'):brNumber(value,'decimal')):date?brDate(value):value);
}
