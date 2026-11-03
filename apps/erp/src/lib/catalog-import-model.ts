import type {NativeRequestOptions} from './real-access';
export type ImportEntity='contacts'|'products';
export type ImportAction='create'|'update'|'pending_human_review'|'pending_source_deleted'|'unchanged'|'invalid_source'|'missing_source';
export interface ImportItem {source_id:string;source_hash:string;}
export interface ImportSource {source_id:string;source_hash:string|null;source_version:string|null;last_seen_at:string|null;name:string|null;code:string|null;source_status:string|null;record_id:string|null;record_version:number|null;local_name:string|null;human_edited:boolean;stock_locked:boolean;origin_state:string|null;candidate_retained:boolean;action:ImportAction;operation_action:ImportAction;error:string|null;}
export interface ImportChange {field:string;redacted:boolean;before:string|boolean|string[]|null;after:string|boolean|string[]|null;}
export interface ImportPreview extends ImportSource {changes:ImportChange[];}
export interface ImportPage {entity:ImportEntity;items:ImportSource[];limit:number;has_more:boolean;next_cursor:string|null;source:'origin_staging';data_mode:'erp_native';operational_effects:false;}
export interface ImportPlan {entity:ImportEntity;items:ImportPreview[];preview_hash:string;dry_run:true;data_mode:'erp_native';operational_effects:false;}
export interface ImportResult {entity:ImportEntity;items:{source_id:string;source_hash:string|null;source_version:string|null;record_id:string|null;action:ImportAction;error:string|null}[];preview_hash:string;dry_run:false;replayed:boolean;data_mode:'erp_native';operational_effects:false;}
export interface ImportController {catalogImport(path:string,options?:NativeRequestOptions):Promise<unknown>;}
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourceId=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=200&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalidResponse=()=>{throw new Error('Não foi possível conferir a resposta da importação.');};
function checkedEnvelope(value:unknown,entity:ImportEntity):Record<string,unknown>&{items:Record<string,unknown>[]} {
 if(!object(value)||value.entity!==entity||value.data_mode!=='erp_native'||value.operational_effects!==false||!Array.isArray(value.items)||value.items.length>100
  ||value.items.some(row=>!object(row)||!sourceId(row.source_id)||typeof row.action!=='string'||!Object.hasOwn(IMPORT_LABELS,row.action))
  ||new Set(value.items.map(row=>row.source_id)).size!==value.items.length)return invalidResponse();
 return value as Record<string,unknown>&{items:Record<string,unknown>[]};
}
export function checkedImportPage(value:unknown,entity:ImportEntity,limit:number):ImportPage {
 const result=checkedEnvelope(value,entity);
 if(result.source!=='origin_staging'||result.limit!==limit||result.items.length>limit||typeof result.has_more!=='boolean'
  ||(result.has_more?result.items.length!==limit||!sourceId(result.next_cursor)||result.next_cursor!==result.items.at(-1)?.source_id:result.next_cursor!==null))return invalidResponse();
 return result as unknown as ImportPage;
}
export function checkedImportPlan(value:unknown,entity:ImportEntity,items:ImportItem[]):ImportPlan {
 const result=checkedEnvelope(value,entity);
 if(result.dry_run!==true||!hash(result.preview_hash)||result.items.length!==items.length
  ||result.items.some((row,index)=>row.source_id!==items[index].source_id||!Array.isArray(row.changes)))return invalidResponse();
 return result as unknown as ImportPlan;
}
export function checkedImportResult(value:unknown,entity:ImportEntity,items:ImportItem[],previewHash:string):ImportResult {
 const result=checkedEnvelope(value,entity);
 if(result.dry_run!==false||typeof result.replayed!=='boolean'||result.preview_hash!==previewHash||result.items.length!==items.length
  ||result.items.some((row,index)=>row.source_id!==items[index].source_id))return invalidResponse();
 return result as unknown as ImportResult;
}
export function importListPath(entity:ImportEntity,limit:number,after:string|null,query:string){
 const params=new URLSearchParams({limit:String(limit)});if(after)params.set('after',after);if(query)params.set('q',query);
 return `/v1/importacao-cadastros/${entity}?${params}`;
}
export const IMPORT_LABELS:Record<ImportAction,string>={create:'Criar cadastro',update:'Atualizar cadastro importado',pending_human_review:'Guardar para revisão humana',pending_source_deleted:'Guardar exclusão para revisão',unchanged:'Sem alteração da origem',invalid_source:'Origem precisa de correção',missing_source:'Origem indisponível'};
export const IMPORT_EXPLANATIONS:Record<ImportAction,string>={create:'Cria um cadastro próprio com vínculo ao ID do Origin.',update:'Atualiza um cadastro que ainda não foi editado no FAGOO.',pending_human_review:'Preserva o cadastro atual e guarda uma proposta de alteração. Não substitui a edição humana nem a unidade protegida pelo estoque.',pending_source_deleted:'Preserva o cadastro atual e guarda a exclusão informada pela origem para conferência.',unchanged:'Esta versão da origem já foi processada.',invalid_source:'O cadastro recebido não atende ao mapeamento ou tem uma situação desconhecida. Não será importado.',missing_source:'O registro não está disponível na cópia local. Atualize a listagem.'};
export const IMPORT_FIELDS:Record<string,string>={name:'Nome',code:'Código',active:'Ativo',trade_name:'Nome fantasia',person_type:'Tipo de pessoa',document:'CPF / CNPJ',ie:'Inscrição estadual',email:'E-mail',phone:'Telefone',mobile:'Celular',postal_code:'CEP',street:'Endereço',number:'Número',complement:'Complemento',district:'Bairro',city:'Município',state:'UF',roles:'Papéis do contato',unit:'Unidade',price:'Preço',kind:'Tipo',format:'Formato',description:'Descrição',ncm:'NCM',gtin:'GTIN'};
export const canSelectImport=(row:ImportSource)=>Boolean(row.source_hash&&!['invalid_source','missing_source','unchanged'].includes(row.action));
export function importSelection(rows:ImportSource[],selected:ReadonlySet<string>):ImportItem[]{
 const items=rows.filter(row=>selected.has(row.source_id));
 if(!items.length||items.length>100||items.length!==selected.size||items.some(row=>!canSelectImport(row)))throw new Error('Selecione de 1 a 100 cadastros disponíveis nesta página.');
 return items.map(row=>({source_id:row.source_id,source_hash:row.source_hash!}));
}
export function importChangeText(change:ImportChange,side:'before'|'after'){
 if(change.redacted)return side==='before'?'Valor protegido':'Alteração em campo protegido';
 const value=change[side];if(value===null)return 'Não informado';if(typeof value==='boolean')return value?'Sim':'Não';
 if(Array.isArray(value))return value.length?value.map(role=>({customer:'Cliente',supplier:'Fornecedor',carrier:'Transportador'})[role]||role).join(', '):'Não classificado';return value;
}
