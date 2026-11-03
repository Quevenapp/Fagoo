// Conferência de estoque no padrão do Origin (migração 106). Quantidades exatas em texto; nenhuma conta em ponto flutuante.
import {units} from './stock-launch-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOTAL=/^-?(0|[1-9]\d{0,31})\.\d{6}$/,LOCAL=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_COUNT');};
function need(value:unknown):asserts value {if(!value)fail();}
// 181: Imagem of Origin (the first external image of the product, https only); null without image or on an older API.
export interface CountItem {product_id:string;code:string|null;name:string;location:string|null;unit:string|null;counted:string;physical:string;difference:string;image_url?:string|null}
export interface CountLog {id:string;code:string;quantity:string;product_id:string;product_name:string;recorded_at_local:string;deleted:boolean}
export interface StockCountState {session:{id:string;version:number;warehouse_id:string|null;warehouse_name:string|null;created_at:string};total_read:string;readings:number;items_total:number;items:CountItem[];log:CountLog[]}
export type CountRejection='not_found'|'ambiguous'|'invalid_kind'|'invalid_format'|'inactive'|'invalid_quantity';
// Origin messages of the reading field.
// 226: like Origin, only "Simples" or "Com composição" with estoque Físico (the composition's own stock) can be read.
export const COUNT_REJECTIONS:Record<CountRejection,string>={not_found:'Produto Inexistente.',ambiguous:'Mais de um produto usa este código. Leia o código (SKU) do produto.',
 invalid_kind:'Tipo inválido. Apenas produtos do tipo "Produto" podem ser lidos.',invalid_format:'Formato inválido. Apenas produtos de formato "Simples" ou "Com composição" com estoque físico podem ser lidos.',
 inactive:'Produto inativo.',invalid_quantity:'Quantidade inválida!'};
export const COUNT_EMPTY_TITLE='Nenhum item registrado';
export const COUNT_EMPTY_TEXT='Você ainda não possui nenhum item registrado, faça a busca de um produto no campo acima.';
export const COUNT_SAVED_INFO='As leituras realizadas são salvas automaticamente na nuvem.';
export const COUNT_RESTART='Você tem certeza que deseja reiniciar a conferência de estoque?';
export const COUNT_AWARE='Estou ciente que não é possível desfazer essa ação e desejo prosseguir.';
// "Gerar balanço para:" of Origin.
export const COUNT_SCOPE_COUNTED='Essa opção irá gerar balanço APENAS PARA OS PRODUTOS CONFERIDOS com as suas quantidades lidas.';
export const COUNT_SCOPE_ALL='Essa opção irá gerar balanço para TODOS OS PRODUTOS ATIVOS. Para aqueles que foram conferidos a quantidade será a lida. Para os produtos não conferidos, a quantidade em estoque atual será ZERADA.';
export const COUNT_SINGLE_WAREHOUSE='Selecione apenas um depósito para gerar o balanço.';
export const COUNT_NO_READING='Nenhuma leitura foi efetuada.';
export const COUNT_DONE='Balanço gerado com sucesso.';
export const COUNT_SKIP_REASONS:Record<string,string>={composition:'composição Virtual ou sem estrutura, ou produto com variações',unavailable:'produto indisponível para lançamentos',reserved:'a contagem é menor que a quantidade reservada em pedidos',limit:'diferença acima do limite de quantidade'};
export const countDeleteQuestion=(name:string)=>`Você tem certeza que deseja excluir a leitura ${name}?`;
/** "Quantidade a ser lida": a positive multiplier typed with comma or dot (validated again by SQL). */
export function countMultiplier(text:string):string {
  const value=text.trim();
  if(!/^(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/.test(value)||/^0(?:[.,]0+)?$/.test(value))throw new Error(COUNT_REJECTIONS.invalid_quantity);
  return value.replace(',','.');
}
export function parseCount(value:unknown):StockCountState|null {
  if(value===null)return null;
  need(isObject(value)&&isObject(value.session)&&Array.isArray(value.items)&&Array.isArray(value.log)&&Number.isInteger(value.readings)&&Number.isInteger(value.items_total)&&typeof value.total_read==='string'&&TOTAL.test(value.total_read));
  const s=value.session as Record<string,unknown>;
  need(typeof s.id==='string'&&UUID.test(s.id)&&Number.isInteger(s.version)&&(s.warehouse_id===null||(typeof s.warehouse_id==='string'&&UUID.test(s.warehouse_id))));
  const items=(value.items as unknown[]).map(item=>{need(isObject(item)&&typeof item.product_id==='string'&&typeof item.name==='string'&&typeof item.counted==='string'&&TOTAL.test(item.counted)
    &&typeof item.physical==='string'&&TOTAL.test(item.physical)&&typeof item.difference==='string'&&TOTAL.test(item.difference)&&units(item.difference)===units(item.counted)-units(item.physical)
    &&(item.image_url===undefined||item.image_url===null||(typeof item.image_url==='string'&&/^https:\/\/\S+$/.test(item.image_url))));return {...item,image_url:(item.image_url as string|null|undefined)??null} as unknown as CountItem;});
  const log=(value.log as unknown[]).map(entry=>{need(isObject(entry)&&typeof entry.id==='string'&&typeof entry.code==='string'&&typeof entry.quantity==='string'&&typeof entry.recorded_at_local==='string'&&LOCAL.test(entry.recorded_at_local)&&typeof entry.deleted==='boolean');return entry as unknown as CountLog;});
  return {session:{id:s.id as string,version:s.version as number,warehouse_id:s.warehouse_id as string|null,warehouse_name:(s.warehouse_name as string|null)??null,created_at:String(s.created_at)},total_read:value.total_read as string,readings:value.readings as number,items_total:value.items_total as number,items,log};
}
export interface CountBalanceResult {changed:{product_id:string;name:string;counted:string;previous:string}[];unchanged:number;skipped:{product_id:string;name:string;reason:string}[];occurred_on:string;balance_scope:'counted'|'all_active'}
export function parseCountBalance(value:unknown):CountBalanceResult {
  need(isObject(value)&&value.outcome==='balanced'&&Array.isArray(value.changed)&&Array.isArray(value.skipped)&&Number.isInteger(value.unchanged)&&typeof value.occurred_on==='string');
  return value as unknown as CountBalanceResult;
}
/** One line of the "Log de leituras": time, code, multiplier and product, newest first. */
export const logLine=(entry:CountLog,quantityText:(value:string)=>string)=>`${entry.recorded_at_local.slice(11)} · ${entry.code} · ${quantityText(entry.quantity)} · ${entry.product_name}${entry.deleted?' (excluída)':''}`;
