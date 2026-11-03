/** QA_SYNTHETIC_SALES_HISTORY: synthetic data only, never imported by the product. */
import type {SalesHistoryController} from '../components/OriginSalesHistory';
import type {AccessState} from '../lib/real-access';
import {captureSalesHistoryRequest} from '../lib/origin-sales-history-request.ts';
import {parseSalesHistoryPage,parseSalesHistoryDetail,type HistoryObserved,type SalesHistoryId,type SalesHistoryDetail} from '../../../../packages/erp-domain/src/origin-sales-history-dto.mjs';
export const historyQaId=(n:number)=>`bsh_83000000-0000-4000-8000-${String(n).padStart(12,'0')}` as SalesHistoryId;
const at='2026-10-17T06:00:00Z',hash='a'.repeat(64);
export const historyQaObserved=(value:string|null|undefined,kind:'number'|'string'='number'):HistoryObserved=>({state:value===undefined?'absent':value===null?'null':'value',kind:value==null?null:kind,value:value??null});
export function historyQaDetail(n=1):SalesHistoryDetail{
 const o=historyQaObserved,missing=n===2,sourceId=String(100000+n);
 const source={namespace:'origin_api' as const,entity:'sales_orders' as const,source_id:sourceId,source_hash:hash,source_version:'1',last_seen_at:at,source_updated_at:null};
 const capture={state:'bound' as const,reason:null,profile:'origin-sales-price-json-v1' as const,observed_at:at,response_sha256:'b'.repeat(64),numeric_tokens:1,scope:'numeric_itens_valor_only' as const};
 return {profile:'origin-sales-history-v1',read_only:true,can_convert:false,native_effects:false,commercial_math_reconciled:false,coverage_certified:false,observed_at:'2026-10-17T07:00:00Z',snapshot:{history_id:historyQaId(n),source,snapshot_hash:'c'.repeat(64),captured_at:at,number:o(`QA-083-${String(n).padStart(2,'0')}`,'string'),date:o('2026-10-16','string'),situation:{id:o('9'),value:o('99')},item_count:1,capture},customer:{source_id:o('601'),name:o('Cliente demonstrativo preservado','string')},invoice_reference:{structure_present:true,source_id:o('0')},items_state:'array',items:[{position:1,item_state:'object',source_product_id:o('501'),code:o('DEMO-083','string'),description:o('Componente demonstrativo preservado','string'),unit:o('CX','string'),quantity:o('1.234567'),unit_price:o('12.1234567891'),discount:o('2.5000'),list_price:o('15.1234567891'),ipi:o('0'),price_lexeme:'1.21234567891e1'}],commercial:{total:o('14.97'),total_products:o('14.97'),freight:o(null),other_expenses:o(undefined),discount_value:o('0'),discount_unit:o('REAL','string'),installment_count:0},current:{source:missing?{state:'missing',source_hash:null,source_version:null,last_seen_at:null}:{state:'changed',source_hash:'d'.repeat(64),source_version:'2',last_seen_at:'2026-10-17T06:55:00Z'},customer:{state:'missing_native',source_id:'601',record_id:null,record_version:null,unit:null},products:[{position:1,binding:{state:missing?'needs_review':'current',source_id:'501',record_id:'83000000-0000-4000-8000-000000000501',record_version:2,unit:'UN'}}]}};
}
export function historyQaPage(numbers=[1,2],limit=25,after:SalesHistoryId|null=null){
 const details=numbers.map(historyQaDetail),first=historyQaDetail(),items=details.map(v=>v.snapshot).filter(v=>after===null||v.history_id>after).sort((a,b)=>a.history_id.localeCompare(b.history_id));
 return parseSalesHistoryPage({profile:first.profile,read_only:true,can_convert:false,native_effects:false,commercial_math_reconciled:false,coverage_certified:false,observed_at:first.observed_at,items:items.slice(0,limit),limit,has_more:items.length>limit,next_cursor:items.length>limit?items[limit-1].history_id:null},{limit,after});
}
export function createSalesHistoryQaFixture(onChange:()=>void=()=>{}){
 const counts={list:0,detail:0,rejected:0},state:AccessState={phase:'ready',membership:{user_id:'83000000-0000-4000-8000-000000000900',role:'admin',resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const controller:SalesHistoryController={getSnapshot:()=>state,subscribe:()=>()=>{},async salesHistory(path,options){
  let request;try{request=captureSalesHistoryRequest(path,options);}catch(error){counts.rejected++;onChange();throw error;}request.options.signal?.throwIfAborted();let value;
  if(request.historyId){const n=[1,2].find(n=>historyQaId(n)===request.historyId);if(!n)throw Error('QA_SYNTHETIC_HISTORY_UNKNOWN');counts.detail++;value=parseSalesHistoryDetail(historyQaDetail(n),{historyId:request.historyId});}
  else{counts.list++;const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams.get('q')??'',limit=Number(url.searchParams.get('limit')??25),after=url.searchParams.get('after') as SalesHistoryId|null;value=historyQaPage([1,2].filter(n=>{const s=historyQaDetail(n).snapshot;return s.source.source_id.includes(q)||s.number.value!.includes(q);}),limit,after);}
  onChange();return value;
 }};return{controller,counts};
}
