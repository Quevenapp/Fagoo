// Public synthetic DTO fixtures only; no staging payload or personal data.
export const ACTOR='11111111-1111-4111-8111-111111111111',COMMAND='22222222-2222-4222-8222-222222222222',HISTORY='bsh_33333333-3333-4333-8333-333333333333';
export function publicHistory(){
 const at='2026-10-17T00:00:00Z',flags={profile:'origin-sales-history-v1',read_only:true,can_convert:false,native_effects:false,commercial_math_reconciled:false,coverage_certified:false,observed_at:at};
 const o=(value,kind='number')=>value===undefined?{state:'absent',kind:null,value:null}:value===null?{state:'null',kind:null,value:null}:{state:'value',kind,value:String(value)};
 const b=id=>({state:'missing_staging',source_id:id,record_id:null,record_version:null,unit:null});
 const source={namespace:'origin_api',entity:'sales_orders',source_id:'31',source_hash:'a'.repeat(64),source_version:'1',last_seen_at:at,source_updated_at:null};
 const capture={state:'bound',reason:null,profile:'origin-sales-price-json-v1',observed_at:at,response_sha256:'b'.repeat(64),numeric_tokens:1,scope:'numeric_itens_valor_only'};
 const summary={history_id:HISTORY,source,snapshot_hash:'c'.repeat(64),captured_at:at,number:o(1),date:o('2026-10-17','string'),situation:{id:o(9),value:o(99)},item_count:1,capture};
 const item={position:1,item_state:'object',source_product_id:o(22),code:o('X','string'),description:o('Observação sintética','string'),unit:o('CX','string'),quantity:o('2'),unit_price:o('9999999999.1234567891'),discount:o('7'),list_price:o('1'),ipi:o(0),price_lexeme:'9999999999.1234567891'};
 const detail={...flags,snapshot:summary,customer:{source_id:o(21),name:o('Cliente sintético','string')},invoice_reference:{structure_present:true,source_id:o(0)},items_state:'array',items:[item],commercial:{total:o('1'),total_products:o('1'),freight:o(null),other_expenses:o(undefined),discount_value:o(7),discount_unit:o('UNKNOWN','string'),installment_count:0},current:{source:{state:'same',source_hash:source.source_hash,source_version:'1',last_seen_at:at},customer:b('21'),products:[{position:1,binding:b('22')} ]}};
 const receipt={command_id:COMMAND,history_id:HISTORY,source,snapshot_hash:summary.snapshot_hash,captured_at:at};
 return {page:{...flags,items:[summary],limit:25,has_more:false,next_cursor:null},detail,command:{...flags,receipt},preview:{...flags,source,snapshot_hash:summary.snapshot_hash,capture,existing:null}};
}
