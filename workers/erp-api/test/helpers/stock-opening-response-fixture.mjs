// Synthetic, self-consistent migration100 responses for HTTP/DTO tests. No real data.
export const ACTOR='10000000-0000-4000-8000-000000000001',COMMAND='10000000-0000-4000-8000-0000000000c1',WAREHOUSE='10000000-0000-4000-8000-0000000000a1',SOURCE='700001';
const product=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const policy=(allow=false,version=allow?1:0)=>({allow_negative:allow,version,updated_at:version?'2026-10-18T10:00:00+00:00':null});
export const warehouse=()=>({source_id:SOURCE,warehouse_id:WAREHOUSE,name:'Depósito sintético',active:true,source_name:'Depósito sintético',imported_at:'2026-10-18T10:00:00+00:00'});
const source=id=>({name:'Produto sintético '+id,code:'SINT-'+id,source_hash:id.padStart(64,'a').slice(-64).replace(/[^a-f]/g,'b'),source_version:'1',last_seen_at:'2026-10-18T09:00:00-03:00'});
export function row(id,status='positive',target='1.000000',{allow=false}={}){
 const pending=['positive','zero','negative','negative_blocked'].includes(status);
 return{product_source_id:id,group:status==='negative_blocked'?'negative':status,status,reason:status==='negative_blocked'?'NEGATIVE_NOT_ALLOWED':pending?null:'NATIVE_MOVEMENTS',
  product:{id:product(Number(id)),name:'Produto sintético '+id,code:null,unit:'UN'},source:source(id),physical:target,current:pending?{quantity:null,version:0}:{quantity:'1.000000',version:1},
  target:pending?target:null,adjustment:pending?target:null,receipt:null};
}
export const counts=(items,allow=false)=>{const c={total:0,positive:0,zero:0,negative:0,negative_blocked:0,no_native_product:0,no_observation:0,invalid:0,adopted:0,native_movements:0,pending:0};
 for(const i of items){c.total++;c[i.group]++;if(i.status==='negative_blocked')c.negative_blocked++;if(['positive','zero','negative'].includes(i.status))c.pending++;}return c;};
export function page({allow=false,items=[row('9101','positive','10.500000'),row('9102','zero','0.000000'),row('9103',allow?'negative':'negative_blocked','-2.250000'),row('9109','native_movements','8.000000')],limit=25,group=null}={}){
 return{scope:'stock_opening',profile:'origin-stock-opening-v1',warehouse:warehouse(),policy:policy(allow),counts:counts(items,allow),group,items,limit,has_more:false,next_cursor:null,unit_source:'native_product',observed_at:'2026-10-18T10:00:00+00:00',data_mode:'erp_native'};
}
export function batch({allow=false,limit=100,occurred_on='2026-10-18'}={}){
 const items=[row('9101','positive','10.500000'),row('9102','zero','0.000000'),...(allow?[row('9103','negative','-2.250000')]:[])];
 return{scope:'stock_opening_batch',profile:'origin-stock-opening-v1',warehouse:warehouse(),policy:policy(allow),occurred_on,items,pending:items.length,limit,preview_hash:'d'.repeat(64),unit_source:'native_product',observed_at:'2026-10-18T10:00:00+00:00',data_mode:'erp_native'};
}
export const intent=(b=batch(),command=COMMAND)=>({command_id:command,occurred_on:b.occurred_on,preview_hash:b.preview_hash,confirmed:true,
 items:b.items.map(i=>({product_source_id:i.product_source_id,product_id:i.product.id,unit:i.product.unit,source_hash:i.source.source_hash,source_version:i.source.source_version,target:i.target}))});
export function result(input=intent(),{replayed=false,skip=[]}={}){
 const items=input.items.map((i,n)=>{const skipped=skip.includes(i.product_source_id),zero=i.target==='0.000000';
  return{product_source_id:i.product_source_id,product_id:i.product_id,outcome:skipped?'skipped':zero?'adopted_zero':'adopted',reason:skipped?'SOURCE_CHANGED':null,target:i.target,
   adjustment:skipped?null:i.target,movement_id:skipped||zero?null:`20000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`,receipt_id:skipped?null:`30000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`};});
 const current=items.filter(i=>i.outcome!=='skipped').map(i=>({id:i.receipt_id,command_id:input.command_id,product_source_id:i.product_source_id,product_id:i.product_id,warehouse_id:WAREHOUSE,
  outcome:i.outcome,state:i.outcome==='adopted_zero'?'adopted_zero':'adopted',target:i.target,previous_quantity:'0.000000',adjustment:i.adjustment,unit:input.items.find(x=>x.product_source_id===i.product_source_id).unit,movement_id:i.movement_id,reversal_movement_id:null,
  occurred_on:input.occurred_on,source_hash:input.items.find(x=>x.product_source_id===i.product_source_id).source_hash,source_version:'1',created_at:'2026-10-18T10:00:00+00:00'}));
 const tally=o=>items.filter(i=>i.outcome===o).length;
 return{scope:'stock_opening_command',profile:'origin-stock-opening-v1',data_mode:'erp_native',replayed,current,
  receipt:{command_id:input.command_id,warehouse_source_id:SOURCE,warehouse_id:WAREHOUSE,occurred_on:input.occurred_on,preview_hash:input.preview_hash,completed_at:'2026-10-18T10:00:00+00:00',items,
   summary:{adopted:tally('adopted'),adopted_zero:tally('adopted_zero'),skipped:tally('skipped')}}};
}
export const warehouses=()=>({scope:'stock_opening_warehouses',profile:'origin-stock-opening-v1',items:[warehouse()],has_more:false,policy:policy(),data_mode:'erp_native'});
export const policyView=(allow=false,manage=true)=>({scope:'stock_policy',policy:policy(allow),can_manage:manage,data_mode:'erp_native'});
export const policyInput=(allow=true,command=COMMAND)=>({command_id:command,expected_version:allow?0:1,allow_negative:allow,reason:'Venda sem saldo durante a virada',confirmed:true});
export const policyResult=(input=policyInput(),replayed=false)=>({scope:'stock_policy',data_mode:'erp_native',replayed,policy:policy(input.allow_negative,input.expected_version+1),
 receipt:{command_id:input.command_id,from:{allow_negative:!input.allow_negative,version:input.expected_version},to:{allow_negative:input.allow_negative,version:input.expected_version+1},reason:input.reason.trim(),changed_at:'2026-10-18T10:00:00+00:00'}});
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
