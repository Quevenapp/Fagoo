export const cutoverEntities = ['contacts','products','receivables','payables','stock_snapshot'] as const;
export type CutoverEntity=typeof cutoverEntities[number];
export const cutoverLabels:Record<string,string>={contacts:'Clientes e fornecedores',products:'Produtos',receivables:'Contas a receber',payables:'Contas a pagar',stock_snapshot:'Estoque exportado',sales_orders:'Linhas de vendas',purchase_orders:'Linhas de compras',cash_movements:'Movimentos de caixa'};
export const checkLabels:Record<string,string>={ABSENT_FROM_SELECTED_BACKUP:'Não consta neste backup',NOT_OBSERVED_IN_API:'ID ainda não observado pela API',MISSING_SOURCE_ID:'Sem ID da origem',NO_NATIVE_CATALOG_LINK:'Cadastro ainda sem vínculo no FAGOO',CSV_AMOUNT_UNAVAILABLE:'Valor do backup ausente ou em formato não reconhecido',CSV_PAID_UNAVAILABLE:'Valor pago/recebido do backup indisponível',CSV_FINANCIAL_ACCOUNT_MISSING:'Conta financeira ausente no backup',CSV_HAS_NO_CONTACT_ID:'Backup não informa ID do contato',CSV_QUANTITY_UNAVAILABLE:'Quantidade exportada indisponível',WAREHOUSE_MAPPING_NOT_DEFINED:'Depósito ainda sem correspondência confirmada',STOCK_SEMANTICS_REQUIRE_REVIEW:'Quantidade exportada exige conferência do tipo de lançamento',API_AMOUNT_UNAVAILABLE:'Valor da API indisponível',API_BALANCE_UNAVAILABLE:'Saldo da API indisponível',API_STATUS_UNRECOGNIZED:'Situação da API não reconhecida',SOURCE_OPEN_OR_PARTIAL_REQUIRES_REVIEW:'Aberto/parcial na origem: conferir para a virada',NO_NATIVE_CONTACT_LINK:'Contato da API ainda sem vínculo no FAGOO',STOCK_PRODUCT_MULTIPLE_ROWS:'Produto aparece em mais de uma linha/depósito; conferir vínculos',DUPLICATE_BACKUP_SOURCE_ID:'ID repetido no backup; ocorrências preservadas'};
export type Coverage={entity:string;rows:number;distinct_ids:number;ids_seen_in_api:number;missing_id_rows:number};
export type BackupBatch={backup_sha:string;status:string;stored_at:string;issues:number;counts:Coverage[]};
export type ApiSource={entity:string;records:number;oldest_observation:string|null;newest_observation:string|null;native_links:number;pending_candidates:number;statuses:{code:string|null;label:string|null;count:number}[]};
export type CutoverSummary={data_mode:'cutover_readonly';as_of:string;cutoff_at:null;reconciled:false;batches:BackupBatch[];batch_count:number;batches_truncated:boolean;api:ApiSource[];limitations:string[]};
export type CutoverRow={key:string;source_id:string|null;checks:string[];
 backup:null|{file_id:string;row:number;name:string|null;code:string|null;status:string|null;unit:string|null;amount:string|null;paid:string|null;quantity:string|null;due_date:string|null;depot_label:string|null;stock_mode:string|null;financial_account_present:boolean|null};
 api:null|{observed_at:string;source_hash:string;name:string|null;code:string|null;unit:string|null;product_kind:string|null;status_code:string|null;status_label:string|null;amount:string|null;balance:string|null;due_date:string|null;contact_source_id:string|null;native_contact_id:string|null};
 native:null|{record_id:string;version:number;active:boolean;state:string;candidate_pending:boolean;source_changed_since_apply:boolean}};
export type CutoverPage={data_mode:'cutover_readonly';as_of:string;backup_sha:string;entity:CutoverEntity;items:CutoverRow[];limit:number;has_more:boolean;next_cursor:string|null;cutoff_at:null;reconciled:false};
const hash=/^[a-f0-9]{64}$/;const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;const text=(v:unknown)=>v===null||typeof v==='string';
export function cutoverSummary(value:unknown):CutoverSummary{
 if(!object(value)||value.data_mode!=='cutover_readonly'||value.reconciled!==false||value.cutoff_at!==null||typeof value.as_of!=='string'||!Array.isArray(value.batches)||value.batches.length>20||!Array.isArray(value.api))throw new Error('cutover_invalid_response');
 for(const b of value.batches)if(!object(b)||!hash.test(String(b.backup_sha))||typeof b.stored_at!=='string'||!count(b.issues)||!Array.isArray(b.counts)||b.counts.some(c=>!object(c)||typeof c.entity!=='string'||!['rows','distinct_ids','ids_seen_in_api','missing_id_rows'].every(k=>count(c[k]))))throw new Error('cutover_invalid_response');
 for(const a of value.api)if(!object(a)||typeof a.entity!=='string'||!count(a.records)||!count(a.native_links)||!count(a.pending_candidates)||!text(a.oldest_observation)||!text(a.newest_observation)||!Array.isArray(a.statuses)||a.statuses.some(s=>!object(s)||!text(s.code)||!text(s.label)||!count(s.count)))throw new Error('cutover_invalid_response');
 return value as unknown as CutoverSummary;
}
export function cutoverPage(value:unknown,sha:string,entity:CutoverEntity):CutoverPage{
 if(!object(value)||value.data_mode!=='cutover_readonly'||value.reconciled!==false||value.cutoff_at!==null||value.backup_sha!==sha||value.entity!==entity||!Array.isArray(value.items)||value.items.length>25||typeof value.has_more!=='boolean'||!text(value.next_cursor))throw new Error('cutover_invalid_response');
 for(const r of value.items){
  if(!object(r)||typeof r.key!=='string'||!text(r.source_id)||!Array.isArray(r.checks)||r.checks.some(c=>typeof c!=='string'))throw new Error('cutover_invalid_response');
  for(const k of ['backup','api','native'])if(r[k]!==null&&!object(r[k]))throw new Error('cutover_invalid_response');
  if(object(r.backup)&&!['name','code','status','unit','amount','paid','quantity','due_date','depot_label','stock_mode'].every(k=>text((r.backup as Record<string,unknown>)[k])))throw new Error('cutover_invalid_response');
  if(object(r.api)&&!['name','code','unit','product_kind','status_code','status_label','amount','balance','due_date','observed_at'].every(k=>text((r.api as Record<string,unknown>)[k])))throw new Error('cutover_invalid_response');
 }
 return value as unknown as CutoverPage;
}
/** Decimal formatting only: no binary floating-point conversion or balance calculation. */
export function cutoverDecimal(value:string|null,money=false):string{
 if(value===null||! /^-?\d+(?:\.\d{1,6})?$/.test(value))return'Indisponível';
 const [integer,fraction='']=value.split('.');const grouped=integer.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
 return`${money?'R$ ':''}${grouped}${fraction?','+fraction:''}`;
}
export function cutoverMoment(value:string|null):string{
 if(!value||!Number.isFinite(Date.parse(value)))return'Sem observação';
 return new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(value));
}
