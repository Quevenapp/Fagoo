export type ActivityModule='campos_customizados'|'certificado_digital'|'caixa'|'comissao'|'financas'|'clientes_fornecedores'|'estoque'|'frente_caixa'|'cobranca'|'notas_fiscais'|'ordens_servico'|'pagamento_recebimento'|'pedidos_compra'|'pedidos_venda'|'produtos'|'propostas'
 |'anexos'|'depositos'|'documentos'|'empresa'|'meu_negocio'|'pagina_inicial'|'preferencias'|'usuarios';
export type ActivityOperation='atualizacao'|'atualizacao_situacao'|'criacao'|'envio'|'estorno'|'exclusao'|'lancamento'|'transferencia';
export type FileOrder='data'|'nome'|'tamanho';
export type DocumentKind='sales_proposals'|'sales_orders'|'purchase_orders'|'service_orders';
export type FileOrigin='documentos'|'contatos'|'financeiro'|'produtos'|'empresa';
export type FileSourceKind=DocumentKind|'contact'|'contact_photo'|'title'|'cash_entry'|'product'|'logo'|'company_file';
export const FILE_ORIGINS:readonly FileOrigin[];
export const FILE_SOURCE_KINDS:Readonly<Record<FileOrigin,readonly FileSourceKind[]>>;
export const FILE_MIMES:readonly string[];
export const ACTIVITY_BASE:'/v1/registro-atividades';
export const FILES_BASE:'/v1/gerenciador-arquivos';
export const ACTIVITY_MAX_BYTES:number;
export const ACTIVITY_MODULES:readonly ActivityModule[];
export const ACTIVITY_OPERATIONS:readonly ActivityOperation[];
export const ACTIVITY_SOURCES:readonly string[];
export const ACTIVITY_DETAIL_SOURCES:readonly string[];
export interface ActivityDetailQuery{source:string;id:string}
export interface ActivityDetail{scope:'activity_detail';data_mode:'erp_native';source:string;id:string;available:boolean;truncated:boolean;before:unknown;after:unknown}
export function captureActivityDetailQuery(query:{source:string;id:string}):ActivityDetailQuery;
export function parseActivityDetail(raw:unknown,query:ActivityDetailQuery):ActivityDetail;
export const FILE_ORDERS:readonly FileOrder[];
export class ActivityContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export interface ActivityQuery{from:string;to:string;module:ActivityModule|null;operation:ActivityOperation|null;actor:string|null;q:string|null;limit:number;offset:number}
export interface ActivityEntry{source:string;id:string;created_at:string;actor:{user_id:string;label:string};module:ActivityModule;operation:ActivityOperation;code:string|null;description:string|null}
export interface ActivityPage{scope:'activity';data_mode:'erp_native';from:string;to:string;module:ActivityModule|null;operation:ActivityOperation|null;actor:string|null;query:string|null;limit:number;offset:number;total:number;has_more:boolean;items:ActivityEntry[]}
export interface FilesQuery{q:string|null;from:string|null;to:string|null;order:FileOrder;origin:FileOrigin|null;limit:number;offset:number}
export interface FileEntry{id:string;origin:FileOrigin;filename:string;mime_type:string;size_bytes:number;sha256:string;created_at:string;owner:{user_id:string;label:string};source:{kind:FileSourceKind;id:string;code:string|null;label:string|null}}
export interface FilesPage{scope:'files';data_mode:'erp_native';query:string|null;from:string|null;to:string|null;order:FileOrder;origin:FileOrigin|null;limit:number;offset:number;total:number;total_bytes:string;has_more:boolean;items:FileEntry[]}
export function activityUuid(value:unknown):value is string;
export function captureActivityQuery(query:Partial<ActivityQuery>&{from:string;to:string}):ActivityQuery;
export function parseActivity(raw:unknown,query:ActivityQuery):ActivityPage;
export function captureFilesQuery(query?:Partial<FilesQuery>):FilesQuery;
export function parseFiles(raw:unknown,query:FilesQuery):FilesPage;
