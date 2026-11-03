// QA_SYNTHETIC_STOCK_OBSERVATIONS — local synthetic data only; no fetch.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureStockObservationsRequest} from '../lib/origin-stock-observations-request.ts';
import type {StockObservedValue,StockObservationRow,StockObservationsPage,StockObservationsDetail,StockWarehouseContext} from '../lib/origin-stock-observations-model';
export const STOCK_OBS_QA_ACTOR='87000000-0000-4000-8000-000000000001';
export const STOCK_OBS_QA_WAREHOUSE='007';
const stamp=()=>({source_hash:'a'.repeat(64),source_version:'1',last_seen_at:'2026-10-17T12:00:00Z'});
export const stockQaObserved=(value:string|null,state:StockObservedValue['state']=value===null?'absent':'value'):StockObservedValue=>({state,value});
export const stockQaWarehouse=(id=STOCK_OBS_QA_WAREHOUSE):StockWarehouseContext=>({source_id:id,record_id:'87000000-0000-4000-8000-000000000007',imported_at:'2026-10-17T10:00:00Z',binding_source_hash:'a'.repeat(64),binding_source_version:'1',source_state:'same',record_state:'same',source:{...stamp(),name:'Geral demonstrativo',status:1,is_default:true,exclude_balance:false,valid:true},record:{name:'Geral demonstrativo',active:true,human_edited:false,version:1}});
export const stockQaFlags=()=>({profile:'origin-stock-observations-v1' as const,read_only:true as const,can_import_balance:false as const,coverage_certified:false as const,lexical_precision_certified:false as const,reconciled:false as const,native_effects:false as const,numeric_representation:'parsed_json_number' as const,units_compared:false as const,observed_at:'2026-10-17T12:05:00Z'});
export function stockQaRow(id='001'):StockObservationRow{return{product_source_id:id,product:{source_known:true,source_name:stockQaObserved(`Produto demonstrativo ${id}`),source_code:stockQaObserved(`QA-${id}`),record_id:'87000000-0000-4000-8000-000000000101',record_name:'Produto no FAGOO',record_unit:'CX',active:true,human_edited:false,binding_state:'current'},observation:{state:'available',source:stamp(),product_code:stockQaObserved(`QA-${id}`),physical_total:stockQaObserved('25.125'),virtual_total:stockQaObserved('20.5'),warehouse:{state:'present',physical:stockQaObserved('12.125'),virtual:stockQaObserved('10.5')},issues:[]}};}
export function stockQaRows():StockObservationRow[]{
 const normal=stockQaRow();
 const zero:StockObservationRow={...stockQaRow('002'),observation:{...normal.observation,warehouse:{state:'present',physical:stockQaObserved('0'),virtual:stockQaObserved('-0.125')}}};
 const missing:StockObservationRow={...stockQaRow('003'),product:{...stockQaRow('003').product,record_id:null,record_name:null,record_unit:null,active:null,human_edited:null,binding_state:'missing_native'},observation:{state:'missing',source:null,product_code:stockQaObserved(null),physical_total:stockQaObserved(null),virtual_total:stockQaObserved(null),warehouse:{state:'unavailable',physical:stockQaObserved(null),virtual:stockQaObserved(null)},issues:[]}};
 const invalid:StockObservationRow={...stockQaRow('004'),observation:{...normal.observation,warehouse:{state:'present',physical:stockQaObserved(null,'invalid'),virtual:stockQaObserved(null,'null')},issues:['OBSERVED_NUMBER_INVALID']}};
 return[normal,zero,missing,invalid];
}
export type StockQaCall={path:string;method:'GET';signal?:AbortSignal};
export function createStockObservationsFixture({rows=stockQaRows(),warehouse,before,after}:{rows?:readonly StockObservationRow[];warehouse?:StockWarehouseContext;before?:(call:StockQaCall)=>unknown|Promise<unknown>;after?:(call:StockQaCall,value:StockObservationsPage|StockObservationsDetail)=>unknown}={}){
 let state:AccessState={phase:'ready',membership:{user_id:STOCK_OBS_QA_ACTOR,role:'admin',resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const calls:StockQaCall[]=[],listeners=new Set<()=>void>();
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},async stockObservations(path:string,options:NativeRequestOptions={}){
  const c=captureStockObservationsRequest(path,options),call={path,...c.options};calls.push(call);const replacement=await before?.(call);if(replacement!==undefined)return replacement;
  const w=warehouse??stockQaWarehouse(c.warehouseSourceId);let value:StockObservationsPage|StockObservationsDetail;
  if(c.productSourceId){const item=rows.find(r=>r.product_source_id===c.productSourceId);if(!item)throw new AccessError(404);value={...stockQaFlags(),warehouse:w,item};}
  else{const q=new URL(path,'https://synthetic.invalid').searchParams.get('q')??'',filtered=rows.filter(r=>(!c.after||r.product_source_id>c.after)&&[r.product_source_id,r.product.source_name.value,r.product.source_code.value].some(v=>v?.includes(q))).sort((a,b)=>a.product_source_id<b.product_source_id?-1:1),items=filtered.slice(0,c.limit),known=rows.filter(r=>r.product.source_known).length,observed=rows.filter(r=>r.observation.state!=='missing').length;
   value={...stockQaFlags(),warehouse:w,items,counts:{scope:'exact_staging_product_ids',product_ids:String(rows.length),known_product_ids:String(known),stock_observation_ids:String(observed),known_without_observation:String(rows.length-observed),observation_without_product:String(rows.length-known),invalid_product_ids:'0',invalid_stock_ids:'0'},limit:c.limit,has_more:filtered.length>c.limit,next_cursor:filtered.length>c.limit?items.at(-1)!.product_source_id:null};
  }
  const copy=structuredClone(value);return after?after(call,copy):copy;
 }};
 return{controller,calls,setAccess(p:{actor?:string|null;role?:AccessRole;phase?:AccessState['phase']}){const actor=Object.hasOwn(p,'actor')?p.actor:state.membership?.user_id;state={...state,phase:p.phase??state.phase,membership:actor?{user_id:actor,role:p.role??state.membership?.role??'admin',resources:[],data_mode:'staging_readonly'}:null};for(const l of listeners)l();}};
}
