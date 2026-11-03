import {fileURLToPath} from 'node:url';
import * as access from '../../src/lib/real-access.ts';
import {mountComponent} from './component-recovery-harness.mjs';
const actor='10000000-0000-4000-8000-000000000001',otherActor='10000000-0000-4000-8000-000000000002',doc='20000000-0000-4000-8000-000000000001',event='30000000-0000-4000-8000-000000000001',contact='40000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64),tick=()=>new Promise(r=>setTimeout(r,0)),copy=structuredClone;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const flags={scope:'service_order_events',data_mode:'erp_native',signature_verified:false,consent_verified:false,changes_document_status:false,financial_mutation_performed:false,stock_mutation_performed:false};
function setup({meResponse=()=>undefined,writeStatuses=[503,403,200],dataResponse=()=>undefined}={}){
 const s={me:0,writes:[],reads:[],requests:[],records:[],role:'admin',user:actor,authCallback(){},session:{access_token:'synthetic-token',user:{id:actor}}};
 const membership=()=>({user_id:s.user,role:s.role,resources:['contacts','products'],data_mode:'staging_readonly'});
 const context=()=>({...flags,document:{id:doc,kind:'service_orders',number:'1',version:3,status:'quoted',total:'25.70',commercial_hash:hash},can_record:['admin','vendas'].includes(s.role),allowed_event_types:['admin','vendas'].includes(s.role)?['reception','customer_decision']:[]});
 const row=r=>({record:r,current:{document_version:3,document_status:'quoted',document_version_changed:false,commercial_content_changed:false,total_changed:false,corrected_by_event_id:null,approval_basis_matches_current:false}});
 const auth={getSession:async()=>({data:{session:s.session},error:null}),onAuthStateChange(callback){s.authCallback=callback;return{data:{subscription:{unsubscribe(){s.authCallback=()=>{};}}}};},signOut:async()=>({error:null})};
 s.fetcher=async(url,o={})=>{const p=new URL(url).pathname;s.requests.push({url,...o});
  if(p==='/v1/me'){s.me++;const custom=await meResponse(s.me,s,o);return custom??Response.json(membership());}
  const custom=await dataResponse(p,s,o);if(custom!==undefined)return custom;
  if(p.endsWith('/anexos'))return Response.json({data_mode:'erp_native',document_id:doc,items:[]});
  if(p.includes('/eventos')){
   if(o.method==='POST'){const body=JSON.parse(o.body);s.writes.push(body);let saved=s.records.find(r=>r.command_id===body.command_id);if(!saved){const d=body.data;saved={command_id:body.command_id,id:event,document_id:doc,sequence:'1',type:d.type,document_version:3,document_status:'quoted',commercial_hash:hash,total:'25.70',snapshot:{number:'1',contact:{id:contact,name:'Cliente sintético'},equipment:null,serial_number:null,technician:null},occurred_on:d.occurred_on,declarant_name:d.declarant_name,declarant_role:d.declarant_role,details:d.details,notes:null,attachment:null,corrects_event_id:null,correction_reason:null,actor_id:actor,recorded_at:'2026-10-16T12:00:00Z'};s.records.push(saved);}
    const status=writeStatuses[s.writes.length-1]??200;if(status!==200)return Response.json({}, {status});const{command_id,...r}=saved;return Response.json({...context(),...row(r),replayed:s.writes.length>1});}
   s.reads.push(p);if(p.endsWith('/eventos'))return Response.json({...context(),read_only:true,items:s.records.map(({command_id,...r})=>row(r)),limit:25,has_more:false,next_before:null});
   const{command_id,...r}=s.records[0];return Response.json({...context(),read_only:true,...row(r)});
  }
  return Response.json({}, {status:403});
 };
 s.controller=access.createAccessController(auth,'https://api.synthetic.test',s.fetcher,{a1ApiUrl:'https://fiscal.synthetic.test'});
 s.emit=(user=actor,token='synthetic-next-token',authEvent='SIGNED_IN')=>{s.user=user;s.session={access_token:token,user:{id:user}};s.authCallback(authEvent,s.session);};return s;
}
const moduleNames=['CompanyPreferences','Catalog','ProductTaxonomy','ProductExport','PriceLists','CustomFields','HistoryView','RealStock','RealFinance','FinanceBorderos','FinanceScreens','RealCnab','RealCnabOperational','RealCnabOperationalReturns','RealReceivedDfe','RealFiscalNumbering','CertificateA1','CompanySettings','RealImportCatalog','RealImportProposals','OriginPurchaseReadiness','OriginSalesReadiness','OriginSalesHistory','ItauLegacyReadiness','OriginWarehouseImport','OriginStockObservations','RealStockOpening','StockWarehouses','StockCount','StockDashboards','ReceiptCheckin','StockReports','RealHome','CutoverReadiness','RealFiscalDrafts','DueDateReport','SyncedXmlHistory','IntegrationProgress','SefazConnection','RealFiscalInvoices','RealOperationNatures','FiscalEventList','RealPdv'];
async function mountAccess(s){
 const source=fileURLToPath(new URL('../../src/components/ServiceOrderEvents.tsx',import.meta.url));
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:'/documentos-empresa?tipo=service_orders',expandChildren:['NativeModuleBoundary','RealDocuments','ServiceOrderEvents'],ports:{access,controller:s.controller},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});',
  '../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://api.synthetic.test"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}',
  './CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './native-modules':`import Events from ${JSON.stringify(source)};import {jsx} from 'react/jsx-runtime';export function RealDocuments({controller}){return jsx(Events,{controller,document:{id:${JSON.stringify(doc)},version:3}});}${moduleNames.map(name=>`export function ${name}(){return null;}`).join('')}`,
 }});
}
const fill=async v=>{for(const [k,value]of Object.entries({type:'reception',occurred_on:'2026-01-15',declarant_name:'Pessoa sintética',declarant_role:'customer',apparent_condition:'Condição relatada',attachment_choice:'none',confirmed:true}))await v.change('service-event-'+k,value);};
const status=n=>e=>e instanceof access.AccessError&&e.status===n;


export {access,actor,otherActor,doc,event,tick,deferred,setup,mountAccess,fill,status};
