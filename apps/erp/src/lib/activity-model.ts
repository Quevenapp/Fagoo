import type {AccessState,NativeRequestOptions,AttachmentRequestOptions} from './real-access';
import {parseActivity,parseFiles,captureActivityQuery,captureFilesQuery,ACTIVITY_MODULES,ACTIVITY_OPERATIONS,type ActivityModule,type ActivityOperation,type ActivityPage,type ActivityQuery,type FilesPage,type FilesQuery,type FileEntry,type FileOrder,type DocumentKind} from '../../../../packages/erp-domain/src/activity.mjs';
export {parseActivity,parseFiles,captureActivityQuery,captureFilesQuery,ACTIVITY_MODULES,ACTIVITY_OPERATIONS};
export type {ActivityModule,ActivityOperation,ActivityPage,ActivityQuery,FilesPage,FilesQuery,FileEntry,FileOrder,DocumentKind};
export interface SystemLogController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;systemLog:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;accessUsers?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;attachments?:(path:string,options?:AttachmentRequestOptions)=>Promise<unknown>}
// Origin names of the Módulo filter (registro.atividades.php); the last ones are Brufap modules Origin does not list.
export const MODULE_TEXT:Record<ActivityModule,string>={campos_customizados:'Campos Customizados',certificado_digital:'Certificado Digital',caixa:'Caixa',comissao:'Comissão',financas:'Contas a Pagar/Receber',clientes_fornecedores:'Contato',estoque:'Estoque',frente_caixa:'Frente de Caixa',
 cobranca:'Geração de cobranças',notas_fiscais:'Notas Fiscais',ordens_servico:'Ordens de Serviço',pagamento_recebimento:'Pagamento/Recebimento',pedidos_compra:'Pedidos de Compra',pedidos_venda:'Pedidos de Venda',
 produtos:'Produto',propostas:'Propostas Comerciais',anexos:'Anexos',depositos:'Depósitos',documentos:'Documentos',empresa:'Dados da empresa',meu_negocio:'Meu Negócio',pagina_inicial:'Página inicial',
 preferencias:'Preferências',usuarios:'Usuários'};
export const OPERATION_TEXT:Record<ActivityOperation,string>={atualizacao:'Atualização',atualizacao_situacao:'Atualização de situação',criacao:'Criação',envio:'Envio',estorno:'Estorno',exclusao:'Exclusão',lancamento:'Lançamento',transferencia:'Transferência'};
export const ORDER_TEXT:Record<FileOrder,string>={data:'Data',nome:'Nome',tamanho:'Tamanho'};
/** São Paulo calendar date (contrato 8), never the browser time zone. */
export const todaySP=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(now);
const shift=(day:string,days:number)=>new Date(Date.parse(`${day}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
export type PeriodKind='ultimos'|'mes'|'dia'|'periodo';
export const PERIOD_TEXT:Record<PeriodKind,string>={ultimos:'Últimos incluídos',mes:'Do mês',dia:'Do dia',periodo:'De um período'};
/** "Últimos incluídos" covers the last 30 days; "Do mês" the current month; "Do dia" today (São Paulo). */
export function periodRange(kind:PeriodKind,today:string,from='',to=''):{from:string;to:string}|null{
 if(kind==='dia')return{from:today,to:today};if(kind==='mes')return{from:`${today.slice(0,7)}-01`,to:today};if(kind==='ultimos')return{from:shift(today,-29),to:today};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return null;
 try{captureActivityQuery({from,to});return{from,to};}catch{return null;}
}
export const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'medium'});
export function fileSize(bytes:number|string){const n=Number(bytes);if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1).replace('.',',')} KB`;return `${(n/1048576).toFixed(1).replace('.',',')} MB`;}
export const KIND_TEXT:Record<DocumentKind,string>={sales_proposals:'Proposta comercial',sales_orders:'Pedido de venda',purchase_orders:'Pedido de compra',service_orders:'Ordem de serviço'};
