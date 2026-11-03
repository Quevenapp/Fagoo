import type {NativeRequestOptions} from './real-access';
import {PROGRESS_STATUS,PROGRESS_VARIANTS,EXTRA_PROGRESS_VARIANTS,type RunStatus} from './integration-progress-model.ts';

// 101: freshness of the Origin staging copy. Mirrors workers/erp-api/src/integration-progress.mjs.
export const FRESHNESS_PATH='/v1/integracao-origin/frescor';
export type FreshnessLevel='A'|'B'|'C';
export type FreshnessLane='recent'|'history'|'sweep';
export type FreshnessStatus='ok'|'attention'|'stale';
export const FRESHNESS_LEVELS:Record<FreshnessLevel,number>={A:600,B:1800,C:86400};
export const FRESHNESS_LEVEL_LABELS:Record<FreshnessLevel,string>={A:'10 min',B:'30 min',C:'24 h'};
export const FRESHNESS_STATUS:Record<FreshnessStatus,{label:string;tone:'success'|'warning'|'danger'}>={
 ok:{label:'Em dia',tone:'success'},attention:{label:'Atenção',tone:'warning'},stale:{label:'Desatualizado',tone:'danger'},
};
export const FRESHNESS_LANE_LABELS:Record<FreshnessLane,string>={recent:'passagem recente',history:'passagem histórica',sweep:'passagem sem período'};
const dated=(resource:string):[string,FreshnessLane][]=>[[resource,'recent'],[resource,'history']];
const balance=['zero','positive','negative'];
export const FRESHNESS_ENTITIES:readonly {entity:string;label:string;level:FreshnessLevel;lanes:[string,FreshnessLane][]}[]=[
 {entity:'contacts',label:'Contatos',level:'A',lanes:[['contacts','recent'],['contacts_deleted','sweep']]},
 {entity:'products',label:'Produtos',level:'A',lanes:[...balance.map((v):[string,FreshnessLane]=>[`products_${v}`,'recent']),...balance.map((v):[string,FreshnessLane]=>[`products_deleted_${v}`,'sweep'])]},
 {entity:'sales_orders',label:'Pedidos de venda',level:'A',lanes:[['sales_orders','recent']]},
 {entity:'nfe',label:'Notas fiscais (NF-e)',level:'A',lanes:['nfe_in','nfe_out','nfe_in_cancelled','nfe_out_cancelled'].flatMap(dated)},
 {entity:'nfce',label:'NFC-e',level:'A',lanes:dated('nfce')},
 {entity:'sales_proposals',label:'Propostas comerciais',level:'B',lanes:dated('sales_proposals')},
 {entity:'purchase_orders',label:'Pedidos de compra',level:'B',lanes:dated('purchase_orders')},
 {entity:'service_orders',label:'Ordens de serviço',level:'B',lanes:dated('service_orders')},
 {entity:'receivables',label:'Contas a receber',level:'B',lanes:dated('receivables')},
 {entity:'payables',label:'Contas a pagar',level:'B',lanes:dated('payables')},
 {entity:'cash_entries',label:'Caixas e bancos',level:'B',lanes:['cash_entries_registered','cash_entries_deleted'].flatMap(dated)},
 {entity:'stock_balances',label:'Saldos de estoque',level:'B',lanes:[['stock_balances','sweep']]},
 {entity:'sellers',label:'Vendedores',level:'C',lanes:[['sellers','recent'],['sellers_deleted','sweep']]},
 {entity:'payment_methods',label:'Formas de pagamento',level:'C',lanes:[['payment_methods_active','sweep'],['payment_methods_inactive','sweep']]},
 {entity:'warehouses',label:'Depósitos',level:'C',lanes:[['warehouses_active','sweep'],['warehouses_inactive','sweep']]},
 {entity:'product_categories',label:'Categorias de produtos',level:'C',lanes:[['product_categories','sweep']]},
 {entity:'financial_categories',label:'Categorias financeiras',level:'C',lanes:[['financial_categories','sweep']]},
 {entity:'ledger_accounts',label:'Contas contábeis',level:'C',lanes:[['ledger_accounts','sweep']]},
];
export const freshnessVariant=(resource:string)=>(PROGRESS_VARIANTS[resource]??EXTRA_PROGRESS_VARIANTS[resource])?.[2]??resource;
// A collector query named as on the Origin screens; other collector phases keep their recorded code.
export function freshnessResource(resource:string){
 const owner=FRESHNESS_ENTITIES.find(x=>x.lanes.some(([id])=>id===resource));
 return owner?`${owner.label} · ${freshnessVariant(resource)}`:resource;
}
export interface FreshnessLaneRow{resource:string;lane:FreshnessLane;checkpoint_present:boolean;open:boolean;completed_started_at:string|null;completed_finished_at:string|null}
export interface FreshnessEntityRow{
 entity:string;level:FreshnessLevel;target_seconds:number;records:number;last_changed_at:string|null;last_seen_at:string|null;oldest_seen_at:string|null;
 lanes_total:number;lanes_measured:number;freshness_at:string|null;age_seconds:number|null;pass_finished_at:string|null;pass_resource:string|null;pass_lane:FreshnessLane|null;
 status:FreshnessStatus;lanes:FreshnessLaneRow[];
}
export interface FreshnessCollector{
 oauth_connected:boolean;oauth_expires_at:string|null;last_run_status:RunStatus|null;last_run_started_at:string|null;last_run_finished_at:string|null;
 last_run_error_count:number|null;last_error_code:string|null;last_error_resource:string|null;
}
export interface OriginFreshness{
 profile:'origin-sync-freshness-v1';data_mode:'origin_sync_freshness_readonly';as_of:string;role:'admin';time_zone:'America/Sao_Paulo';coverage_certified:false;erp_mutations:false;
 levels:{level:FreshnessLevel;target_seconds:number;stale_after_seconds:number}[];collector:FreshnessCollector;entities:FreshnessEntityRow[];
}
export interface IntegrationFreshnessController{integrationFreshness:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}

const bad=():never=>{throw new Error('ORIGIN_FRESHNESS_INVALID');};
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))bad();return v as Record<string,unknown>;};
const n=(v:unknown):number=>{if(!Number.isSafeInteger(v)||(v as number)<0)bad();return v as number;};
const b=(v:unknown):boolean=>{if(typeof v!=='boolean')bad();return v as boolean;};
const time=(v:unknown):string=>{if(typeof v!=='string'||v.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))bad();const s=v as string;if(new Date(`${s.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)!==s.slice(0,10))bad();return s;};
const nullable=<T>(v:unknown,read:(v:unknown)=>T):T|null=>v===null?null:read(v);
const matching=(re:RegExp)=>(v:unknown):string=>{if(typeof v!=='string'||!re.test(v))bad();return v as string;};
const ms=(v:string)=>Date.parse(v),SKEW_MS=300000;
export const freshnessStatus=(age:number|null,target:number):FreshnessStatus=>age===null?'stale':age<=target?'ok':age<=3*target?'attention':'stale';
const RUN_STATUS=Object.keys(PROGRESS_STATUS);
function collector(value:unknown):FreshnessCollector{
 const v=obj(value);
 const c:FreshnessCollector={oauth_connected:b(v.oauth_connected),oauth_expires_at:nullable(v.oauth_expires_at,time),
  last_run_status:nullable(v.last_run_status,x=>RUN_STATUS.includes(x as string)?x as RunStatus:bad()),
  last_run_started_at:nullable(v.last_run_started_at,time),last_run_finished_at:nullable(v.last_run_finished_at,time),last_run_error_count:nullable(v.last_run_error_count,n),
  last_error_code:nullable(v.last_error_code,matching(/^[A-Z][A-Z0-9_]{0,80}$/)),last_error_resource:nullable(v.last_error_resource,matching(/^[a-z][a-z0-9_]{0,79}$/))};
 if(c.oauth_connected!==(c.oauth_expires_at!==null))bad();
 if(c.last_run_status===null&&(c.last_run_started_at!==null||c.last_run_finished_at!==null||c.last_run_error_count!==null))bad();
 if((c.last_error_code!==null||c.last_error_resource!==null)&&!((c.last_run_error_count??0)>0))bad();
 return c;
}
function entityRow(value:unknown,spec:typeof FRESHNESS_ENTITIES[number],asOf:string):FreshnessEntityRow{
 const r=obj(value),target=FRESHNESS_LEVELS[spec.level];
 if(r.entity!==spec.entity||r.level!==spec.level||r.target_seconds!==target)bad();
 const records=n(r.records),last_changed_at=nullable(r.last_changed_at,time),last_seen_at=nullable(r.last_seen_at,time),oldest_seen_at=nullable(r.oldest_seen_at,time);
 if(records===0?(last_changed_at!==null||last_seen_at!==null||oldest_seen_at!==null):(last_changed_at===null||last_seen_at===null||oldest_seen_at===null||ms(oldest_seen_at)>ms(last_seen_at)))bad();
 if(!Array.isArray(r.lanes)||r.lanes.length!==spec.lanes.length)bad();
 const lanes=(r.lanes as unknown[]).map((raw,i):FreshnessLaneRow=>{
  const l=obj(raw);if(l.resource!==spec.lanes[i][0]||l.lane!==spec.lanes[i][1])bad();
  const x:FreshnessLaneRow={resource:spec.lanes[i][0],lane:spec.lanes[i][1],checkpoint_present:b(l.checkpoint_present),open:b(l.open),
   completed_started_at:nullable(l.completed_started_at,time),completed_finished_at:nullable(l.completed_finished_at,time)};
  if(!x.checkpoint_present&&(x.open||x.completed_finished_at!==null)||x.completed_finished_at!==null&&ms(x.completed_finished_at)>ms(asOf)+SKEW_MS
   ||x.completed_started_at!==null&&(x.completed_finished_at===null||ms(x.completed_started_at)>ms(x.completed_finished_at)))bad();
  return x;
 });
 const measured=lanes.filter(x=>x.completed_started_at!==null),complete=measured.length===lanes.length;
 if(r.lanes_total!==lanes.length||r.lanes_measured!==measured.length)bad();
 const freshness_at=nullable(r.freshness_at,time),pass_finished_at=nullable(r.pass_finished_at,time),age_seconds=nullable(r.age_seconds,n);
 const pass_resource=nullable(r.pass_resource,matching(/^[a-z][a-z0-9_]{0,79}$/)),pass_lane=nullable(r.pass_lane,x=>['recent','history','sweep'].includes(x as string)?x as FreshnessLane:bad());
 if(!complete){if(freshness_at!==null||pass_finished_at!==null||age_seconds!==null||pass_resource!==null||pass_lane!==null)bad();}
 else{
  const oldest=Math.min(...measured.map(x=>ms(x.completed_started_at as string))),limit=measured.find(x=>x.resource===pass_resource&&x.lane===pass_lane);
  if(freshness_at===null||age_seconds===null||!limit||ms(freshness_at)!==oldest||ms(limit.completed_started_at as string)!==oldest||pass_finished_at===null||ms(pass_finished_at)!==ms(limit.completed_finished_at as string))bad();
  const elapsed=Math.max(0,(ms(asOf)-oldest)/1000);if((age_seconds as number)<elapsed-0.001||(age_seconds as number)>=elapsed+1.001)bad();
 }
 if(r.status!==freshnessStatus(age_seconds,target))bad();
 return{entity:spec.entity,level:spec.level,target_seconds:target,records,last_changed_at,last_seen_at,oldest_seen_at,lanes_total:lanes.length,lanes_measured:measured.length,
  freshness_at,age_seconds,pass_finished_at,pass_resource,pass_lane,status:r.status as FreshnessStatus,lanes};
}
export function parseOriginFreshness(value:unknown):OriginFreshness{
 const v=obj(value);
 if(v.profile!=='origin-sync-freshness-v1'||v.data_mode!=='origin_sync_freshness_readonly'||v.role!=='admin'||v.time_zone!=='America/Sao_Paulo'||v.coverage_certified!==false||v.erp_mutations!==false)bad();
 const as_of=time(v.as_of),levels=(Object.entries(FRESHNESS_LEVELS) as [FreshnessLevel,number][]).map(([level,target_seconds])=>({level,target_seconds,stale_after_seconds:3*target_seconds}));
 if(!Array.isArray(v.levels)||v.levels.length!==levels.length)bad();
 levels.forEach((l,i)=>{const raw=obj((v.levels as unknown[])[i]);if(raw.level!==l.level||raw.target_seconds!==l.target_seconds||raw.stale_after_seconds!==l.stale_after_seconds)bad();});
 if(!Array.isArray(v.entities)||v.entities.length!==FRESHNESS_ENTITIES.length)bad();
 return{profile:'origin-sync-freshness-v1',data_mode:'origin_sync_freshness_readonly',as_of,role:'admin',time_zone:'America/Sao_Paulo',coverage_certified:false,erp_mutations:false,
  levels,collector:collector(v.collector),entities:FRESHNESS_ENTITIES.map((spec,i)=>entityRow((v.entities as unknown[])[i],spec,as_of))};
}
// Age as read by a person: whole minutes, then hours and minutes, then days.
export function freshnessAge(seconds:number){
 if(seconds<60)return 'menos de 1 min';
 const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes} min`;
 const hours=Math.floor(minutes/60);if(hours<48)return minutes%60?`${hours} h ${minutes%60} min`:`${hours} h`;
 return `${Math.floor(hours/24)} dias`;
}
