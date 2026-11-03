import type {NativeRequestOptions} from './real-access';
export const INTEGRATION_LABELS:Record<string,string>={contacts:'Clientes e fornecedores',products:'Produtos',sales_orders:'Pedidos de venda',sales_proposals:'Orçamentos',purchase_orders:'Pedidos de compra',receivables:'Contas a receber',payables:'Contas a pagar',nfe:'NF-e',nfce:'NFC-e',payment_methods:'Formas de pagamento',sellers:'Vendedores'};
export const PROGRESS_VARIANTS:Record<string,[string,boolean,string]>={
 contacts:['contacts',true,'Todos'],contacts_deleted:['contacts',false,'Excluídos'],
 products_zero:['products',true,'Estoque zero'],products_positive:['products',true,'Estoque positivo'],products_negative:['products',true,'Estoque negativo'],
 products_deleted_zero:['products',false,'Excluídos: estoque zero'],products_deleted_positive:['products',false,'Excluídos: estoque positivo'],products_deleted_negative:['products',false,'Excluídos: estoque negativo'],
 sales_orders:['sales_orders',true,'Pedidos'],sales_proposals:['sales_proposals',true,'Orçamentos'],purchase_orders:['purchase_orders',true,'Compras'],
 receivables:['receivables',true,'Emissão'],payables:['payables',true,'Emissão'],
 nfe_in:['nfe',true,'Entrada'],nfe_out:['nfe',true,'Saída'],nfe_in_cancelled:['nfe',true,'Entrada cancelada'],nfe_out_cancelled:['nfe',true,'Saída cancelada'],nfce:['nfce',true,'Notas'],
 payment_methods_active:['payment_methods',false,'Ativas'],payment_methods_inactive:['payment_methods',false,'Inativas'],sellers:['sellers',true,'Todos'],sellers_deleted:['sellers',false,'Excluídos'],
};
export const EXTRA_INTEGRATION_LABELS:Record<string,string>={service_orders:'Ordens de serviço',warehouses:'Depósitos',product_categories:'Categorias de produtos',financial_categories:'Categorias financeiras',ledger_accounts:'Contas contábeis',cash_entries:'Lançamentos de caixas e bancos',stock_balances:'Observações de estoque por produto'};
export const EXTRA_PROGRESS_VARIANTS:Record<string,[string,boolean,string]>={
 service_orders:['service_orders',true,'Data de entrada'],warehouses_active:['warehouses',false,'Ativos'],warehouses_inactive:['warehouses',false,'Inativos'],
 product_categories:['product_categories',false,'Categorias declaradas'],financial_categories:['financial_categories',false,'Receitas e despesas'],ledger_accounts:['ledger_accounts',false,'Contas declaradas'],
 cash_entries_registered:['cash_entries',true,'Registrados no período'],cash_entries_deleted:['cash_entries',true,'Excluídos no período'],stock_balances:['stock_balances',false,'Produtos conhecidos; três partições de saldo'],
};
export type RunStatus='completed'|'partial'|'failed'|'skipped_time'|'skipped_budget'|'unknown';
export const PROGRESS_STATUS:Record<RunStatus,string>={completed:'Ciclo encerrado',partial:'Ciclo com pendências',failed:'Ciclo falhou',skipped_time:'Etapa limitada pelo tempo',skipped_budget:'Etapa limitada pelas consultas',unknown:'Estado não reconhecido'};
export interface ProgressRun{status:RunStatus;started_at:string|null;finished_at:string|null;pages:number|null;records:number|null;requests:number|null;attempted:number|null;stored:number|null;files:number|null;error_count:number|null}
export interface ProgressEntity{entity:string;records:number;oldest_observation:string|null;newest_observation:string|null}
export interface ProgressResource{resource:string;entity:string;windowed:boolean;checkpoint_present:boolean;state_updated_at:string|null;recent_completed_local:string|null;history_completed_local:string|null;sweep_completed_local:string|null;recent_open:boolean;history_open:boolean;sweep_open:boolean}
export interface ProgressFinance{entity:'payables'|'receivables';known_open_partial:number;observed_over_hour_ago:number;unavailable_balance:number;backing_off:number;oldest_observation:string|null;last_success_at:string|null;retry_after:string|null}
export interface ProgressExtras{profile:'origin-extra-progress-v1';coverage_certified:false;entities:ProgressEntity[];resources:ProgressResource[];stock_last_observation:null|{requested:number;returned:number;unavailable:number;observed_at:string;coverage_complete:false}}
export interface IntegrationSummary{
 data_mode:'integration_progress_readonly';as_of:string;role:'admin';coverage_certified:false;erp_mutations:false;runtime_configuration_known:false;
 extra_resources:ProgressExtras|null;
 entities:ProgressEntity[];resources:ProgressResource[];last_run:ProgressRun|null;last_xml_run:ProgressRun|null;last_finance_run:ProgressRun|null;
 xml:{known_origins:number;eligible_origins:number;without_valid_key:number;with_preserved_revision:number;without_preserved_revision:number;never_attempted:number;retry_origins:number;blocked_origins:number;backing_off:number;preserved_objects:number;preserved_revisions:number;last_success_at:string|null;validation:'structural_only';authorization_verified:false};
 finance_refresh:{entities:ProgressFinance[];reference_limits:{max_ids:8;max_seconds:40;max_attempts:24;shared_requests:120;observation_age_seconds:3600}};
}
export interface IntegrationProgressController{integrationProgress:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
const bad=():never=>{throw new Error('INTEGRATION_PROGRESS_INVALID');};
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))bad();return v as Record<string,unknown>;};
const n=(v:unknown):number=>{if(!Number.isSafeInteger(v)||(v as number)<0)bad();return v as number;};
const b=(v:unknown):boolean=>{if(typeof v!=='boolean')bad();return v as boolean;};
const time=(v:unknown):string=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))bad();const s=v as string;if(new Date(`${s.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)!==s.slice(0,10))bad();return s;};
const nullable=<T>(v:unknown,read:(v:unknown)=>T):T|null=>v===null?null:read(v);
const local=(v:unknown):string=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(v))bad();const s=v as string;time(`${s.replace(' ','T')}${s.length===10?'T00:00:00':''}Z`);return s;};
const rows=(v:unknown,ids:string[],key:string):Record<string,unknown>[]=>{if(!Array.isArray(v)||v.length!==ids.length)bad();const result=(v as unknown[]).map(obj);if(result.some(r=>!ids.includes(r[key] as string))||new Set(result.map(r=>r[key])).size!==ids.length)bad();return result;};
const run=(value:unknown):ProgressRun|null=>{
 if(value===null)return null;const v=obj(value);if(!Object.hasOwn(PROGRESS_STATUS,v.status as string))bad();
 return{status:v.status as RunStatus,started_at:nullable(v.started_at,time),finished_at:nullable(v.finished_at,time),pages:nullable(v.pages,n),records:nullable(v.records,n),requests:nullable(v.requests,n),attempted:nullable(v.attempted,n),stored:nullable(v.stored,n),files:nullable(v.files,n),error_count:nullable(v.error_count,n)};
};
function entityRows(value:unknown,names:string[]):ProgressEntity[]{
 return rows(value,names,'entity').map(r=>{
  const x={entity:r.entity as string,records:n(r.records),oldest_observation:nullable(r.oldest_observation,time),newest_observation:nullable(r.newest_observation,time)};
  if(x.records===0?(x.oldest_observation!==null||x.newest_observation!==null):(!x.oldest_observation||!x.newest_observation||Date.parse(x.oldest_observation)>Date.parse(x.newest_observation)))bad();return x;
 });
}
function resourceRows(value:unknown,variants:Record<string,[string,boolean,string]>):ProgressResource[]{
 return rows(value,Object.keys(variants),'resource').map(r=>{
  const[entity,windowed]=variants[r.resource as string];if(r.entity!==entity||r.windowed!==windowed)bad();
  const x={resource:r.resource as string,entity,windowed,checkpoint_present:b(r.checkpoint_present),state_updated_at:nullable(r.state_updated_at,time),
   recent_completed_local:nullable(r.recent_completed_local,local),history_completed_local:nullable(r.history_completed_local,local),sweep_completed_local:nullable(r.sweep_completed_local,local),recent_open:b(r.recent_open),history_open:b(r.history_open),sweep_open:b(r.sweep_open)};
  if(x.checkpoint_present!==(x.state_updated_at!==null)||windowed&&(x.sweep_open||x.sweep_completed_local!==null)||!windowed&&(x.recent_open||x.history_open||x.recent_completed_local!==null||x.history_completed_local!==null))bad();return x;
 });
}
function extraResources(value:unknown):ProgressExtras|null{
 if(value===undefined||value===null)return null;
 const v=obj(value);if(v.profile!=='origin-extra-progress-v1'||v.coverage_certified!==false)bad();
 const entities=entityRows(v.entities,Object.keys(EXTRA_INTEGRATION_LABELS)),resources=resourceRows(v.resources,EXTRA_PROGRESS_VARIANTS);
 for(const r of resources)if(!r.checkpoint_present&&(r.recent_open||r.history_open||r.sweep_open||r.recent_completed_local!==null||r.history_completed_local!==null||r.sweep_completed_local!==null))bad();
 let stock_last_observation:ProgressExtras['stock_last_observation']=null;
 if(v.stock_last_observation!==null){
  const x=obj(v.stock_last_observation);if(x.coverage_complete!==false)bad();
  stock_last_observation={requested:n(x.requested),returned:n(x.returned),unavailable:n(x.unavailable),observed_at:time(x.observed_at),coverage_complete:false};
  if(stock_last_observation.requested>25||stock_last_observation.returned+stock_last_observation.unavailable!==stock_last_observation.requested||!resources.find(r=>r.resource==='stock_balances')?.checkpoint_present)bad();
 }
 return{profile:'origin-extra-progress-v1',coverage_certified:false,entities,resources,stock_last_observation};
}
export function parseIntegrationSummary(value:unknown):IntegrationSummary{
 const v=obj(value);if(v.data_mode!=='integration_progress_readonly'||v.role!=='admin'||v.coverage_certified!==false||v.erp_mutations!==false||v.runtime_configuration_known!==false)bad();
 const entities=entityRows(v.entities,Object.keys(INTEGRATION_LABELS)),resources=resourceRows(v.resources,PROGRESS_VARIANTS);
 const raw=obj(v.xml);if(raw.validation!=='structural_only'||raw.authorization_verified!==false)bad();
 const xml:IntegrationSummary['xml']={known_origins:n(raw.known_origins),eligible_origins:n(raw.eligible_origins),without_valid_key:n(raw.without_valid_key),with_preserved_revision:n(raw.with_preserved_revision),without_preserved_revision:n(raw.without_preserved_revision),never_attempted:n(raw.never_attempted),retry_origins:n(raw.retry_origins),blocked_origins:n(raw.blocked_origins),backing_off:n(raw.backing_off),preserved_objects:n(raw.preserved_objects),preserved_revisions:n(raw.preserved_revisions),last_success_at:nullable(raw.last_success_at,time),validation:'structural_only',authorization_verified:false};
 if(xml.eligible_origins+xml.without_valid_key!==xml.known_origins||xml.with_preserved_revision+xml.without_preserved_revision!==xml.eligible_origins||xml.never_attempted>xml.without_preserved_revision||xml.retry_origins+xml.blocked_origins>xml.eligible_origins||xml.backing_off>xml.eligible_origins||xml.preserved_revisions<xml.with_preserved_revision)bad();
 const f=obj(v.finance_refresh),lim=obj(f.reference_limits),reference_limits:IntegrationSummary['finance_refresh']['reference_limits']={max_ids:8,max_seconds:40,max_attempts:24,shared_requests:120,observation_age_seconds:3600};
 for(const[key,value]of Object.entries(reference_limits))if(lim[key]!==value)bad();
 const finance=rows(f.entities,['payables','receivables'],'entity').map(r=>{
  const x:ProgressFinance={entity:r.entity as ProgressFinance['entity'],known_open_partial:n(r.known_open_partial),observed_over_hour_ago:n(r.observed_over_hour_ago),unavailable_balance:n(r.unavailable_balance),backing_off:n(r.backing_off),oldest_observation:nullable(r.oldest_observation,time),last_success_at:nullable(r.last_success_at,time),retry_after:nullable(r.retry_after,time)};
  if(x.observed_over_hour_ago>x.known_open_partial||x.unavailable_balance>x.known_open_partial||x.backing_off>x.known_open_partial||(x.known_open_partial===0)!==(x.oldest_observation===null))bad();return x;
 });
 const last_run=run(v.last_run),last_xml_run=run(v.last_xml_run),last_finance_run=run(v.last_finance_run);if(!last_run&&(last_xml_run||last_finance_run))bad();
 return{data_mode:'integration_progress_readonly',as_of:time(v.as_of),role:'admin',coverage_certified:false,erp_mutations:false,runtime_configuration_known:false,entities,resources,xml,finance_refresh:{entities:finance,reference_limits},last_run,last_xml_run,last_finance_run,extra_resources:extraResources(v.extra_resources)};
}
export const progressMoment=(value:string|null)=>value?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'Sem registro';
export const progressLocal=(value:string|null)=>value?`${value.slice(8,10)}/${value.slice(5,7)}/${value.slice(0,4)}${value.length>10?` ${value.slice(11)}`:''}`:'Sem passagem concluída';
