import type {SalesReadinessController} from '../components/OriginSalesReadiness';
import type {AccessState} from '../lib/real-access';
import {captureSalesReadinessRequest} from '../lib/origin-sales-readiness-request.ts';
import {SALES_READINESS_PENDING,parseSalesReadinessPage,parseSalesReadinessDetail,type ObservedValue,type SalesReadinessBinding,type SalesReadinessDetail,type SalesReadinessSource} from '../../../../packages/erp-domain/src/origin-sales-readiness-dto.mjs';

const H='a'.repeat(64),TIME='2026-10-17T01:55:30Z';
const observed=(value:string|null|undefined):ObservedValue=>({state:value===undefined?'absent':value===null?'null':'value',value:value??null});
const flags=()=>({profile:'origin-sales-readiness-v1' as const,read_only:true as const,can_import:false as const,coverage_certified:false as const,native_effects:false as const,observed_at:TIME,pending_contracts:[...SALES_READINESS_PENDING]});
function source(id:string):SalesReadinessSource{return{source_id:id,source_hash:H,source_version:'2',last_seen_at:TIME,number:observed(id==='100000'?'QA-081-01':'QA-081-02'),date:observed('2026-10-16'),situation:{id:id==='100000'?'6':'9',value:observed(id==='100000'?'0':'1')},item_count:2,capture:id==='100000'?{state:'bound',profile:'origin-sales-price-json-v1',observed_at:TIME,response_sha256:'b'.repeat(64)}:{state:'absent',profile:null,observed_at:null,response_sha256:null}};}
function binding(entity:'contacts'|'products'):SalesReadinessBinding{return{entity,source_id:entity==='contacts'?'601':'501',record_id:entity==='contacts'?'c0000000-0000-4000-8000-000000000081':'d0000000-0000-4000-8000-000000000081',record_version:1,name:entity==='contacts'?'Cliente demonstrativo':'Peça demonstrativa',unit:entity==='contacts'?null:'UN',active:true,human_edited:false,origin_state:'synced',candidate_pending:false,applied_hash:H,latest_hash:H,source_hash:H,source_version:'2',valid:true,state:'current'};}
export function salesReadinessQaDetail(id:string):SalesReadinessDetail{
 const pending=id==='100001',result:SalesReadinessDetail={...flags(),source:source(id),customer:binding('contacts'),invoice_reference:{state:pending?'declared':'zero',source_id:pending?'8001':null},items:[
  {position:1,code:observed('DEMO-01'),description:observed('Componente de fixação demonstrativo'),unit:observed('UN'),quantity:observed('1.234567'),unit_price:observed('12.1234567891'),quantity_supported:true,unit_price_supported:true,product:binding('products'),ipi:observed('0'),discount:observed('2.5000'),list_price:observed('15.0000000001')},
  {position:2,code:observed('DEMO-02'),description:observed('Embalagem demonstrativa — conferir unidade da origem'),unit:observed(pending?'CX':'UN'),quantity:observed('2.000000'),unit_price:observed('5.0000'),quantity_supported:true,unit_price_supported:true,product:{...binding('products'),name:'Embalagem demonstrativa'},ipi:observed('0'),discount:observed('0'),list_price:observed(undefined)},
 ],commercial:{total:observed('24.97'),total_products:observed('24.97'),freight:observed(null),other_expenses:observed('0'),discount_value:observed('0'),discount_unit:observed('REAL'),installment_count:0,taxation_present:false},history:{comparison:'not_available',reason:'SALES_BACKUP_NOT_COMPARED',backup_rows:'30',backup_batches:'2',backup_rows_without_source_id:'30',exact_id_rows_uncompared:'0',last_backup_stored_at:TIME,current_capture_is_history:false},issues:[]};
 if(pending){result.items[1].product={...result.items[1].product,record_id:null,record_version:null,name:null,unit:null,active:null,human_edited:null,origin_state:null,applied_hash:null,latest_hash:null,valid:false,state:'missing_native'};result.issues=[{code:'PRICE_CAPTURE_CURRENT_MISSING',field:'itens.valor',position:null},{code:'PRODUCT_BINDING_UNAVAILABLE',field:'itens.produto.id',position:2}];}
 return parseSalesReadinessDetail(result,{sourceId:id});
}
/** No fetch, credentials, persistence or mutation ports. Only synthetic GET projections. */
export function createSalesReadinessQaFixture(onChange:()=>void=()=>{}){
 const counts={list:0,detail:0,rejected:0},state:AccessState={phase:'ready',membership:{user_id:'a0000000-0000-4000-8000-000000000081',role:'admin',resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const controller:SalesReadinessController={getSnapshot:()=>state,subscribe:()=>()=>{},async salesReadiness(path,options){
  let captured;try{captured=captureSalesReadinessRequest(path,options);}catch(error){counts.rejected++;onChange();throw error;}
  captured.options.signal?.throwIfAborted();const u=new URL(path,'https://sales-qa.invalid');let result;
  if(captured.sourceId){if(!['100000','100001'].includes(captured.sourceId))throw new Error('QA_SYNTHETIC_SALES_UNKNOWN_SOURCE');counts.detail++;result=salesReadinessQaDetail(captured.sourceId);}
  else{counts.list++;const q=u.searchParams.get('q')?.trim()??'',after=u.searchParams.get('after'),limit=Number(u.searchParams.get('limit')??25),items=['100000','100001'].map(source).filter(row=>(after===null||row.source_id>after)&&(row.source_id.includes(q)||row.number.value!.includes(q)));result=parseSalesReadinessPage({...flags(),items:items.slice(0,limit),limit,has_more:items.length>limit,next_cursor:items.length>limit?items[limit-1].source_id:null},{limit,after});}
  onChange();return result;
 }};return{controller,counts};
}
