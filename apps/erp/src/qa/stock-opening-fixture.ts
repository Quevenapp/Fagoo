// QA_SYNTHETIC_STOCK_OPENING — synthetic local ports for the opening adoption screen, no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureStockOpeningRequest} from '../lib/stock-opening-request.ts';
import type {StockOpeningApplyInput,StockPolicyInput,StockOpeningRow,StockOpeningGroup,StockOpeningResult,StockPolicyResult,StockPolicy} from '../lib/stock-opening-model';
export const OPENING_QA_ACTOR='10000000-0000-4000-8000-000000000001';
export const OPENING_QA_SOURCE='700001';
const WAREHOUSE='10000000-0000-4000-8000-0000000000a1',STAMP='2026-10-18T10:00:00+00:00';
const uuid=(prefix:string,n:number)=>`${prefix}-0000-4000-8000-${String(n).padStart(12,'0')}`;
type Seed={id:string;kind:'pending'|'no_native_product'|'native_movements'|'invalid';target?:string};
export const OPENING_QA_SEEDS:readonly Seed[]=[{id:'9101',kind:'pending',target:'10.500000'},{id:'9102',kind:'pending',target:'0.000000'},{id:'9103',kind:'pending',target:'-2.250000'},
 {id:'9104',kind:'no_native_product'},{id:'9105',kind:'native_movements',target:'8.000000'},{id:'9106',kind:'invalid'}];
type Receipt=NonNullable<StockOpeningRow['receipt']>;
export type OpeningQaCall={path:string;method?:string;body?:unknown;signal?:AbortSignal};
export function createStockOpeningFixture({before,after,lostAck=false,seeds=OPENING_QA_SEEDS}:{before?:(call:OpeningQaCall)=>unknown|Promise<unknown>;after?:(call:OpeningQaCall,value:unknown)=>unknown;lostAck?:boolean;seeds?:readonly Seed[]}={}){
 let state:AccessState={phase:'ready',membership:{user_id:OPENING_QA_ACTOR,role:'admin',resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:OpeningQaCall[]=[],receipts=new Map<string,Receipt>(),commands=new Map<string,StockOpeningResult>(),policyCommands=new Map<string,StockPolicyResult>();
 let policy:StockPolicy={allow_negative:false,version:0,updated_at:null},lose=lostAck,serial=0;
 const warehouse=()=>({source_id:OPENING_QA_SOURCE,warehouse_id:WAREHOUSE,name:'Depósito sintético',active:true,source_name:'Depósito sintético',imported_at:STAMP});
 const row=(seed:Seed):StockOpeningRow=>{
  const n=Number(seed.id),product=seed.kind==='no_native_product'?null:{id:uuid('10000000',n),name:'Produto sintético '+seed.id,code:'SINT-'+seed.id,unit:'UN'};
  const source={name:'Produto sintético '+seed.id,code:'SINT-'+seed.id,source_hash:'b'.repeat(63)+(n%10),source_version:'1',last_seen_at:STAMP};
  const receipt=receipts.get(seed.id)??null;
  if(receipt)return{product_source_id:seed.id,group:'adopted',status:receipt.outcome==='adopted_zero'?'adopted_zero':'adopted',reason:'ALREADY_ADOPTED',product,source,physical:seed.target??null,current:receipt.outcome==='adopted_zero'?{quantity:null,version:0}:{quantity:receipt.target,version:1},target:null,adjustment:null,receipt};
  if(seed.kind==='no_native_product')return{product_source_id:seed.id,group:'no_native_product',status:'no_native_product',reason:'NATIVE_PRODUCT_MISSING',product,source,physical:'4.000000',current:{quantity:null,version:0},target:null,adjustment:null,receipt:null};
  if(seed.kind==='native_movements')return{product_source_id:seed.id,group:'native_movements',status:'native_movements',reason:'NATIVE_MOVEMENTS',product,source,physical:seed.target!,current:{quantity:'-1.000000',version:1},target:null,adjustment:null,receipt:null};
  if(seed.kind==='invalid')return{product_source_id:seed.id,group:'invalid',status:'invalid',reason:'PHYSICAL_PRECISION',product,source,physical:null,current:{quantity:null,version:0},target:null,adjustment:null,receipt:null};
  const t=seed.target!,status=t.startsWith('-')?policy.allow_negative?'negative':'negative_blocked':t==='0.000000'?'zero':'positive';
  return{product_source_id:seed.id,group:status==='negative_blocked'?'negative':status,status,reason:status==='negative_blocked'?'NEGATIVE_NOT_ALLOWED':null,product,source,physical:t,current:{quantity:null,version:0},target:t,adjustment:t,receipt:null};
 };
 const rows=()=>seeds.map(row);
 const counts=(all:StockOpeningRow[])=>{const c={total:0,positive:0,zero:0,negative:0,negative_blocked:0,no_native_product:0,no_observation:0,invalid:0,adopted:0,native_movements:0,pending:0};
  for(const r of all){c.total++;c[r.group]++;if(r.status==='negative_blocked')c.negative_blocked++;if(['positive','zero','negative'].includes(r.status))c.pending++;}return c;};
 const pending=()=>rows().filter(r=>['positive','zero','negative'].includes(r.status));
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async stockOpening(path:string,options:NativeRequestOptions={}){
   const captured=captureStockOpeningRequest(path,options),call:OpeningQaCall={path,...captured.options};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   const u=new URL(path,'https://synthetic.invalid'),parts=u.pathname.split('/');let value:unknown;
   if(u.pathname==='/v1/politica-estoque'&&call.method==='POST'){
    const body=captured.options.body as StockPolicyInput;const known=policyCommands.get(body.command_id);
    if(known)value={...known,policy,replayed:true};
    else{if(body.expected_version!==policy.version)throw new AccessError(409);const from={allow_negative:policy.allow_negative,version:policy.version};policy={allow_negative:body.allow_negative,version:policy.version+1,updated_at:STAMP};
     const result:StockPolicyResult={scope:'stock_policy',data_mode:'erp_native',policy,replayed:false,receipt:{command_id:body.command_id,from,to:{allow_negative:policy.allow_negative,version:policy.version},reason:body.reason.trim(),changed_at:STAMP}};
     policyCommands.set(body.command_id,result);value=result;if(lose){lose=false;throw new AccessError(503);}}
   }else if(u.pathname==='/v1/politica-estoque'){value={scope:'stock_policy',policy,can_manage:state.membership?.role==='admin',data_mode:'erp_native'};}
   else if(parts.at(-2)==='comandos'&&u.pathname.startsWith('/v1/politica-estoque/')){const found=policyCommands.get(parts.at(-1)!);if(!found)throw new AccessError(404);value={...found,policy,replayed:true};}
   else if(parts.at(-2)==='comandos'){const found=commands.get(parts.at(-1)!);if(!found)throw new AccessError(404);value={...found,replayed:true};}
   else if(u.pathname==='/v1/saldo-abertura-estoque'){value={scope:'stock_opening_warehouses',profile:'origin-stock-opening-v1',items:[warehouse()],has_more:false,policy,data_mode:'erp_native'};}
   else if(parts.at(-1)==='lote'){const body=captured.options.body as {occurred_on:string;limit:number};const all=pending(),items=all.slice(0,body.limit);
    value={scope:'stock_opening_batch',profile:'origin-stock-opening-v1',warehouse:warehouse(),policy,occurred_on:body.occurred_on,items,pending:all.length,limit:body.limit,preview_hash:items.length?'d'.repeat(64):null,unit_source:'native_product',observed_at:STAMP,data_mode:'erp_native'};}
   else if(parts.at(-1)==='adotar'){const body=captured.options.body as StockOpeningApplyInput;const known=commands.get(body.command_id);
    if(known)value={...known,replayed:true};
    else{const items=body.items.map(i=>{const r=row(seeds.find(s=>s.id===i.product_source_id)!);
      if(!['positive','zero','negative'].includes(r.status)||r.product?.unit!==i.unit)return{product_source_id:i.product_source_id,product_id:i.product_id,outcome:'skipped' as const,reason:r.product?.unit!==i.unit?'UNIT_CHANGED' as const:r.reason??'SOURCE_CHANGED',target:i.target,adjustment:null,movement_id:null,receipt_id:null};
      const zero=i.target==='0.000000',id=uuid('30000000',++serial),movement=zero?null:uuid('20000000',serial);
      const receipt:Receipt={id,command_id:body.command_id,product_source_id:i.product_source_id,product_id:i.product_id,warehouse_id:WAREHOUSE,outcome:zero?'adopted_zero':'adopted',state:zero?'adopted_zero':'adopted',target:i.target,previous_quantity:'0.000000',adjustment:i.target,unit:i.unit,movement_id:movement,reversal_movement_id:null,occurred_on:body.occurred_on,source_hash:i.source_hash,source_version:i.source_version,created_at:STAMP};
      receipts.set(i.product_source_id,receipt);return{product_source_id:i.product_source_id,product_id:i.product_id,outcome:receipt.outcome,reason:null,target:i.target,adjustment:i.target,movement_id:movement,receipt_id:id};});
     const tally=(o:string)=>items.filter(i=>i.outcome===o).length;
     const result={scope:'stock_opening_command',profile:'origin-stock-opening-v1',data_mode:'erp_native',replayed:false,current:items.filter(i=>i.outcome!=='skipped').map(i=>receipts.get(i.product_source_id)!),
      receipt:{command_id:body.command_id,warehouse_source_id:OPENING_QA_SOURCE,warehouse_id:WAREHOUSE,occurred_on:body.occurred_on,preview_hash:body.preview_hash,completed_at:STAMP,items,summary:{adopted:tally('adopted'),adopted_zero:tally('adopted_zero'),skipped:tally('skipped')}}} as StockOpeningResult;
     commands.set(body.command_id,result);value=result;if(lose){lose=false;throw new AccessError(503);}}
   }else{const group=u.searchParams.get('grupo') as StockOpeningGroup|null,afterId=u.searchParams.get('after'),limit=Number(u.searchParams.get('limit')??25),all=rows();
    const filtered=all.filter(r=>(!group||r.group===group)&&(!afterId||r.product_source_id>afterId)),items=filtered.slice(0,limit),more=filtered.length>limit;
    value={scope:'stock_opening',profile:'origin-stock-opening-v1',warehouse:warehouse(),policy,counts:counts(all),group,items,limit,has_more:more,next_cursor:more?items.at(-1)!.product_source_id:null,unit_source:'native_product',observed_at:STAMP,data_mode:'erp_native'};}
   return after?after(call,structuredClone(value)):structuredClone(value);
  }};
 return{controller,calls,receipts,commands,get policy(){return policy;},setAccess(patch:{actor?:string|null;role?:AccessRole;phase?:AccessState['phase']}){const actor=Object.hasOwn(patch,'actor')?patch.actor:state.membership?.user_id;
  state={...state,phase:patch.phase??state.phase,membership:actor?{user_id:actor,role:patch.role??state.membership?.role??'admin',resources:[],data_mode:'staging_readonly'}:null};for(const fn of listeners)fn();}};
}
