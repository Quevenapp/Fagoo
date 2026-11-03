import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

const user='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',item='d0000000-0000-4000-8000-000000000001',command='c0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-server-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const data={date:'2026-10-16',contact_id:user,items:[{id:item,description:'Item sintético',unit:'UN',quantity:'1',unit_price:'12.50'}]};
const document={...normalizeDocument('sales_proposals',data),id,kind:'sales_proposals',number:'1',version:1,status:'draft',created_at:'2026-10-16T03:00:00Z',updated_at:'2026-10-16T03:00:00Z',source_proposal_id:null,effect_flags:{finance_active:false,stock_active:false},contact_snapshot:{id:user,version:1,name:'Contato sintético'},items:normalizeDocument('sales_proposals',data).items.map(row=>({...row,product_snapshot:null}))};
const envelope={kind:'sales_proposals',document,data_mode:'erp_native',operational_effects:false};
function harness(result=envelope,status=200){const calls=[];return {calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/auth/v1/user')?{id:user}:result),{status:url.endsWith('/auth/v1/user')?200:status});}})};}
const request=(path='/v1/documentos/sales_proposals',method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic-user',Origin:'https://erp.example.test',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});

test('document create validates decimal inputs and uses verified actor with exact RPC contract',async()=>{
 const h=harness({...envelope,raw_payload:'private',document:{...document,raw_payload:'private',contact_snapshot:{...document.contact_snapshot,credentials:'private'}}});
 const response=await h.handler(request(undefined,'POST',{command_id:command,data}),env);assert.equal(response.status,200);
 assert.ok(h.calls[1].url.endsWith('/erp_document_save'));
 assert.deepEqual(JSON.parse(h.calls[1].body),{p_kind:'sales_proposals',p_id:null,p_expected_version:0,p_command_id:command,p_body:data,p_user_id:user});
 assert.doesNotMatch(await response.text(),/raw_payload|private|credentials/);
});
test('permission access, summary lists and details filter output and match exact RPC signatures',async()=>{
 const access=harness({read:['sales_proposals'],write:['sales_proposals'],data_mode:'erp_native',operational_effects:false,secret:true});
 const result=await access.handler(request('/v1/documentos'),env);assert.equal(result.status,200);assert.equal((await result.json()).secret,undefined);
 const summary={id,kind:'sales_proposals',number:'1',version:1,status:'draft',date:'2026-10-16',total:'12.50',contact_id:user,contact_name:'Contato sintético',created_at:document.created_at,updated_at:document.updated_at,expected_date:null,next_contact:null,template:false,warehouse_id:null,warehouse_name:null,source_proposal_id:null,source_proposal_number:null,finance_active:false,stock_active:false,receipt_active:false,reservation_active:false,fiscal_draft:null,internal_notes:null,items:['private']};
 const list=harness({kind:'sales_proposals',items:[summary],limit:1,page:null,order:'id',has_more:true,next_cursor:id,total_count:2,total_amount:'25.00',data_mode:'erp_native',operational_effects:false});
 const response=await list.handler(request(`/v1/documentos/sales_proposals?limit=1&after=${id}&status=draft`),env);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/private/);
 assert.deepEqual(JSON.parse(list.calls[1].body),{p_kind:'sales_proposals',p_limit:1,p_after:id,p_page:null,p_order:'id',p_statuses:['draft'],p_query:null,p_date_type:'date',p_date_from:null,p_date_to:null,p_warehouse_id:null,p_product_id:null,p_city:null,p_state:null,p_technician:null,p_equipment:null,p_serial_number:null,p_internal_note:null,p_user_id:user});
 const detail=harness();assert.equal((await detail.handler(request(`/v1/documentos/sales_proposals/${id}`),env)).status,200);assert.ok(detail.calls[1].url.endsWith('/erp_document_get'));
});
test('document search and inclusive period use bounded literal parameters and reject invalid calendar dates before upstream',async()=>{
 const empty={kind:'sales_proposals',items:[],limit:25,page:null,order:'id',has_more:false,next_cursor:null,total_count:0,total_amount:'0.00',data_mode:'erp_native',operational_effects:false};
 const h=harness(empty);
 const params=new URLSearchParams({q:'  QA_%  ',date_from:'2024-02-29',date_to:'2026-10-16',status:'draft'});
 assert.equal((await h.handler(request(`/v1/documentos/sales_proposals?${params}`),env)).status,200);
 assert.deepEqual(JSON.parse(h.calls[1].body),{p_kind:'sales_proposals',p_limit:25,p_after:null,p_page:null,p_order:'id',p_statuses:['draft'],p_query:'QA_%',p_date_type:'date',p_date_from:'2024-02-29',p_date_to:'2026-10-16',p_warehouse_id:null,p_product_id:null,p_city:null,p_state:null,p_technician:null,p_equipment:null,p_serial_number:null,p_internal_note:null,p_user_id:user});
 for(const query of ['date_from=2026-02-29','date_from=2026-04-31','date_from=1899-12-31','date_to=2100-01-01','date_from=2026-10-17&date_to=2026-10-16','date_from=','date_from=2026-10-16&date_from=2026-10-17','q=a&q=b','q=%0Asecret',`q=${'x'.repeat(121)}`,'status=finalized','sort=date']){
  const invalid=harness(empty);assert.equal((await invalid.handler(request(`/v1/documentos/sales_proposals?${query}`),env)).status,400,query);assert.equal(invalid.calls.length,0);
 }
});
test('CAS update, explicit status action and proposal conversion are separate commands',async()=>{
 for(const [path,method,body,rpc]of [
  [`/v1/documentos/sales_proposals/${id}`,'PATCH',{command_id:command,expected_version:1,data},'erp_document_save'],
  [`/v1/documentos/sales_proposals/${id}/status`,'POST',{command_id:command,expected_version:1,status:'open'},'erp_document_transition']]){
  const h=harness();assert.equal((await h.handler(request(path,method,body),env)).status,200);assert.ok(h.calls[1].url.endsWith(rpc));assert.equal(JSON.parse(h.calls[1].body).p_expected_version,1);
 }
 const sale={...document,id:'b0000000-0000-4000-8000-000000000002',kind:'sales_orders',source_proposal_id:id};
 const h=harness({proposal:{...document,status:'completed'},sale,replayed:false,data_mode:'erp_native',operational_effects:false});
 assert.equal((await h.handler(request(`/v1/documentos/sales_proposals/${id}/convert`,'POST',{command_id:command,expected_version:1}),env)).status,200);
 assert.deepEqual(JSON.parse(h.calls[1].body),{p_id:id,p_expected_version:1,p_command_id:command,p_user_id:user});
});
test('invalid shapes, monetary numbers, computed fields and unknown routes cannot mutate upstream',async()=>{
 const h=harness();
 for(const input of [{...data,total:'0'},{...data,status:'approved'},{...data,items:[{...data.items[0],unit_price:12.5}]},{...data,installments:[{due_date:'2026-12-01',amount:'1'}]}, {...data,date:'2026-02-30'}])
  assert.equal((await h.handler(request(undefined,'POST',{command_id:command,data:input}),env)).status,400);
 assert.equal((await h.handler(request(undefined,'POST',{command_id:command,data,p_user_id:user}),env)).status,400);
 assert.equal((await h.handler(request(`/v1/documentos/sales_proposals/${id}`,'PATCH',{command_id:command,expected_version:0,data}),env)).status,400);
 assert.equal((await h.handler(request('/v1/documentos/sales_proposals?limit=101'),env)).status,400);
 assert.equal((await h.handler(request(`/v1/documentos/sales_orders/${id}/convert`),env)).status,404);
 assert.equal((await h.handler(request(`/v1/documentos/sales_proposals/${id}/STATUS`),env)).status,404);
 assert.equal(h.calls.length,0);
});
test('server totals are checked against decimal recomputation and effects must remain disabled',async()=>{
 for(const result of [{...envelope,operational_effects:true},{...envelope,document:{...document,totals:{...document.totals,total:'999.00'}}},{...envelope,document:{...document,items:[{...document.items[0],total:'0.00'}]}}]){
  const h=harness(result);const response=await h.handler(request(`/v1/documentos/sales_proposals/${id}`),env);assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/999|Contato|Snapshot/);
 }
});
test('auth, errors and CORS retain the existing boundary for document mutations',async()=>{
 const h=harness();const unauth=request(undefined,'POST',{command_id:command,data});unauth.headers.delete('Authorization');assert.equal((await h.handler(unauth,env)).status,401);assert.equal(h.calls.length,0);
 for(const [code,status]of [['42501',403],['40001',409],['22023',400],['P0002',404]]){const mock=harness({code,message:'private financial detail'},400);const response=await mock.handler(request(undefined,'POST',{command_id:command,data}),env);assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/private|financial/);}
 const preflight=new Request('https://api.example.test/v1/documentos/sales_proposals',{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}});
 assert.equal((await h.handler(preflight,env)).status,204);
});
const listRow=(over={})=>({id,kind:'sales_orders',number:'7',version:2,status:'open',date:'2026-10-16',total:'10.00',contact_id:user,contact_name:'Contato sintético',created_at:document.created_at,updated_at:document.updated_at,expected_date:'2026-10-20',next_contact:null,template:false,warehouse_id:item,warehouse_name:'Depósito sintético',source_proposal_id:command,source_proposal_number:'3',finance_active:true,stock_active:false,receipt_active:false,reservation_active:true,fiscal_draft:null,internal_notes:'Observação sintética',...over});
const listPage=(over={})=>({kind:'sales_orders',items:[listRow()],limit:100,page:1,order:'date_desc',has_more:false,next_cursor:null,total_count:1,total_amount:'10.00',data_mode:'erp_native',operational_effects:false,...over});
test('Origin list parameters map to one bounded RPC call with page, order, multi-status and kind-specific filters',async()=>{
 const h=harness(listPage({page:2,order:'number_asc',limit:50,total_count:51,total_amount:'999999999999999999.99',items:[listRow()]}));
 const params=new URLSearchParams({limit:'50',page:'2',order:'number_asc',status:'open,verified',q:' 12.345.678/0001-90 ',date_type:'expected_date',date_from:'2026-10-01',date_to:'2026-10-31',warehouse_id:item.toUpperCase(),product_id:command,city:' Piracicaba ',state:'SP'});
 const response=await h.handler(request(`/v1/documentos/sales_orders?${params}`),env);assert.equal(response.status,200);
 assert.deepEqual(JSON.parse(h.calls[1].body),{p_kind:'sales_orders',p_limit:50,p_after:null,p_page:2,p_order:'number_asc',p_statuses:['open','verified'],p_query:'12.345.678/0001-90',p_date_type:'expected_date',p_date_from:'2026-10-01',p_date_to:'2026-10-31',p_warehouse_id:item,p_product_id:command,p_city:'Piracicaba',p_state:'SP',p_technician:null,p_equipment:null,p_serial_number:null,p_internal_note:null,p_user_id:user});
 const body=await response.json();assert.equal(body.total_count,51);assert.equal(body.total_amount,'999999999999999999.99');assert.equal(body.items[0].source_proposal_number,'3');assert.equal(body.items[0].reservation_active,true);
 const service=harness(listPage({kind:'service_orders',limit:25,items:[],total_count:0,total_amount:'0.00'}));
 assert.equal((await service.handler(request('/v1/documentos/service_orders?page=1&technician=T%C3%A9cnico&equipment=Bomba&serial_number=SN-1'),env)).status,200);
 assert.deepEqual(['p_technician','p_equipment','p_serial_number'].map(key=>JSON.parse(service.calls[1].body)[key]),['Técnico','Bomba','SN-1']);
 const purchase=harness(listPage({kind:'purchase_orders',limit:25,items:[],total_count:0,total_amount:'0.00'}));
 assert.equal((await purchase.handler(request('/v1/documentos/purchase_orders?page=1&internal_note=lote'),env)).status,200);assert.equal(JSON.parse(purchase.calls[1].body).p_internal_note,'lote');
 const proposals=harness(listPage({kind:'sales_proposals',limit:25,items:[],total_count:0,total_amount:'0.00'}));
 assert.equal((await proposals.handler(request('/v1/documentos/sales_proposals?page=1&date_type=next_contact&date_from=2026-10-01'),env)).status,200);
});
test('Origin list parameters reject ambiguous paging, unknown orders, repeated or foreign situações and filters outside their screen',async()=>{
 for(const [kind,query] of [['sales_orders',`page=1&after=${id}`],['sales_orders','page=0'],['sales_orders','page=100001'],['sales_orders','page=1.5'],['sales_orders','order=total_desc'],['sales_orders','status=open,open'],['sales_orders','status=open,'],['sales_orders','status=approved'],['sales_orders',`status=${Array(21).fill('open').join(',')}`],
  ['sales_orders','date_type=next_contact'],['sales_orders','date_type=saida'],['sales_orders','warehouse_id=nope'],['sales_orders','product_id=1'],['sales_orders','technician=x'],['sales_orders','internal_note=x'],['sales_orders','state=sp'],['sales_orders','state=XX'],['sales_orders','city=%20%20'],['sales_orders',`city=${'x'.repeat(101)}`],['sales_orders','city=a%0Ab'],
  ['purchase_orders','city=Piracicaba'],['purchase_orders','state=SP'],['service_orders','internal_note=x'],['service_orders',`technician=${'x'.repeat(201)}`],['sales_proposals','serial_number=x'],['sales_orders','order=date_desc&order=date_asc']]){
  const h=harness(listPage());assert.equal((await h.handler(request(`/v1/documentos/${kind}?${query}`),env)).status,400,`${kind} ${query}`);assert.equal(h.calls.length,0);
 }
});
test('Origin list responses must agree with the requested page and the filtered totals',async()=>{
 const ok=harness(listPage());assert.equal((await ok.handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env)).status,200);
 // 202610200129: Preferências "Exibir totais em listas" may leave the user without the sum (null, never absent).
 const hidden=harness(listPage({total_amount:null}));const hiddenResponse=await hidden.handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env);
 assert.equal(hiddenResponse.status,200);assert.equal((await hiddenResponse.json()).total_amount,null);
 for(const result of [listPage({page:2}),listPage({order:'date_asc'}),listPage({total_count:0}),listPage({total_count:'1'}),listPage({total_amount:'10.5'}),listPage({total_amount:10}),listPage({total_amount:undefined}),listPage({total_count:5}),listPage({has_more:true,next_cursor:id,total_count:1}),
  listPage({items:[listRow({source_proposal_number:null})]}),listPage({items:[listRow({source_proposal_id:null})]}),listPage({items:[listRow({fiscal_draft:'sim'})]}),listPage({items:[listRow({receipt_active:true})]}),listPage({items:[listRow({template:true})]}),listPage({items:[listRow({internal_notes:'x'.repeat(281)})]}),
  listPage({items:[listRow({expected_date:'2026-02-30'})]}),listPage({items:[listRow({warehouse_id:null})]}),listPage({items:[listRow(),listRow()],total_count:2})]){
  const h=harness(result);const response=await h.handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env);assert.equal(response.status,502,JSON.stringify(result).slice(0,160));assert.doesNotMatch(await response.text(),/sintétic/);
 }
 const purchase=harness(listPage({kind:'purchase_orders',items:[listRow({kind:'purchase_orders',source_proposal_id:null,source_proposal_number:null,reservation_active:false,receipt_active:true,fiscal_draft:true})]}));
 assert.equal((await purchase.handler(request('/v1/documentos/purchase_orders?limit=100&page=1'),env)).status,502,'the nota indicator exists only for sales orders');
 const cursor=harness(listPage({page:null,limit:1,has_more:true,next_cursor:id,total_count:3}));
 assert.equal((await cursor.handler(request(`/v1/documentos/sales_orders?limit=1&order=date_desc&after=${command}`),env)).status,200);
 assert.deepEqual(['p_page','p_order','p_after'].map(key=>JSON.parse(cursor.calls[1].body)[key]),[null,'date_desc',command]);
 const legacy=harness(listPage({page:null,order:'id',limit:25,total_count:1}));
 assert.equal((await legacy.handler(request('/v1/documentos/sales_orders'),env)).status,200,'calls without page/order keep the UUID cursor contract');
 assert.deepEqual(['p_page','p_order'].map(key=>JSON.parse(legacy.calls[1].body)[key]),[null,'id']);
 for(const query of ['order=id','page=1&order=id'])assert.equal((await harness(listPage()).handler(request(`/v1/documentos/sales_orders?${query}`),env)).status,400,query);
});
test('Origin list: a page past the end is an empty page, profiles without stock read get null reservation and names count characters',async()=>{
 const beyond=harness(listPage({page:3,items:[],has_more:false,next_cursor:null,total_count:120,total_amount:'10.00'}));
 const response=await beyond.handler(request('/v1/documentos/sales_orders?limit=100&page=3'),env);assert.equal(response.status,200);
 const body=await response.json();assert.deepEqual([body.items,body.has_more,body.total_count,body.page],[[],false,120,3]);
 for(const result of [listPage({page:3,items:[],has_more:true,next_cursor:id,total_count:120}),listPage({page:2,items:[],total_count:120}),listPage({page:2,limit:100,items:[listRow()],has_more:false,total_count:300})]){
  assert.equal((await harness(result).handler(request(`/v1/documentos/sales_orders?limit=100&page=${result.page}`),env)).status,502,JSON.stringify(result).slice(0,120));
 }
 const finance=harness(listPage({items:[listRow({reservation_active:null,warehouse_name:null})]}));
 const financeResponse=await finance.handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env);assert.equal(financeResponse.status,200);
 const financeRow=(await financeResponse.json()).items[0];assert.equal(financeRow.reservation_active,null);assert.equal(financeRow.warehouse_name,null);assert.equal(financeRow.warehouse_id,item);
 for(const reservation of ['sim',1])assert.equal((await harness(listPage({items:[listRow({reservation_active:reservation})]})).handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env)).status,502,String(reservation));
 const emoji='😀',wide=harness(listPage({items:[listRow({contact_name:`Contato ${emoji.repeat(190)}`,warehouse_name:emoji.repeat(200),internal_notes:emoji.repeat(280)})]}));
 assert.equal((await wide.handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env)).status,200,'SQL limits are characters, not UTF-16 units');
 assert.equal((await harness(listPage({items:[listRow({internal_notes:emoji.repeat(281)})]})).handler(request('/v1/documentos/sales_orders?limit=100&page=1'),env)).status,502);
});
