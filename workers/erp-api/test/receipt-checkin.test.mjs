import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// Routes and projections of migration 147 (Check-in de Recebimentos) under /v1/estoque/checkin. Synthetic IDs only.
const USER='a1470000-0000-4000-8000-000000000001',N='b1470000-0000-4000-8000-000000000001',P='c1470000-0000-4000-8000-000000000001',C='d1470000-0000-4000-8000-000000000001',CMD='e1470000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const parse=async(path,method,body)=>{const req=request(path,method,body),url=new URL(req.url);return stockOperation(req,stockRoute(url.pathname),url.searchParams);};
const project=async(path,method,body,value)=>{const op=await parse(path,method,body);return stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),op);};
const invalid=promise=>assert.rejects(promise,error=>error.status===400&&error.code==='ERP_INVALID_QUERY');
const bad=promise=>assert.rejects(promise,error=>error.status===502&&error.code==='ERP_UPSTREAM_INVALID_RESPONSE');
const note=(patch={})=>({invoice_id:N,invoice_version:1,model:'55',issue_type:'T',status:8,series:1,number:123,access_key:null,supplier:{name:'Fornecedor sintético',document:'12345678000190',person_type:'J'},
 issue_date:'2026-10-20',created_at:'2026-10-20T10:00:00Z',items_count:2,checkin_state:'in_progress',open:true,...patch});
const item=(patch={})=>({position:1,product_id:P,product_code:'P-1',product_gtin:null,description:'Peça sintética',supplier_code:'F-1',gtin:null,unit:'UN',quantity:'3.0000',unit_price:'10.0000000000',
 received:'2.0000',issue:null,issue_quantity:null,issue_action:null,state:'in_progress',requested:{quantity:'3.0000',prices:['9.5000000000']},...patch});
const view=(patch={})=>({scope:'stock_checkin',data_mode:'erp_native',note:note(),checkin:{id:C,state:'in_progress',version:2,invoice_version:1,stale:false,started_at:'2026-10-20T10:00:00Z',updated_at:'2026-10-20T10:05:00Z',finished_at:null},
 version:2,items:[item(),item({position:2,product_id:null,requested:null,received:'0.0000',state:'pending',description:'Frete'})],summary:{total:2,complete:0,issue:0,refused:0,pending:2},
 events:[{id:1,action:'received',position:1,description:'Peça sintética',quantity:'2.0000',previous:'0.0000',at:'2026-10-20T10:05:00Z'}],...patch});
const receipt=(patch={})=>({command_id:CMD,action:'save',invoice_id:N,from_version:1,to_version:2,detail:{changes:[{position:1,from:'0.0000',to:'2.0000',description:'Peça sintética'}]},saved_at:'2026-10-20T10:05:00Z',...patch});

test('147 routes: strict params, closed bodies and the five commands',async()=>{
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/checkin/notas')),['GET']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/checkin/notas/${N}`)),['GET']);
 for(const action of['recebidos','pendencias','lote','reinicio','finalizacao'])assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/checkin/notas/${N}/${action}`)),['POST']);
 assert.equal(stockRoute(`/v1/estoque/checkin/notas/${N}/excluir`),null);assert.equal(stockRoute('/v1/estoque/checkin/notas/bad'),null);
 assert.deepEqual((await parse('/v1/estoque/checkin/notas?q=NFe%20123&offset=50','GET')).args,{p_query:'NFe 123',p_offset:50,p_limit:50});
 for(const query of['?q=abc','?q=12345678901','?offset=-1','?q=1&q=2','?x=1','?q=']) await invalid(parse(`/v1/estoque/checkin/notas${query}`,'GET'));
 await invalid(parse(`/v1/estoque/checkin/notas/${N}?x=1`,'GET'));
 const save={command_id:CMD,expected_version:0,items:[{position:1,received:'2.5'}]};
 assert.deepEqual((await parse(`/v1/estoque/checkin/notas/${N}/recebidos`,'POST',save)).args,{p_command_id:CMD,p_invoice_id:N,p_expected_version:0,p_items:[{position:1,received:'2.5'}]});
 for(const body of[{...save,items:[]},{...save,items:[{position:1,received:2}]},{...save,items:[{position:1,received:'1.12345'}]},{...save,items:[{position:1,received:'1'},{position:1,received:'2'}]},
  {...save,extra:1},{...save,command_id:'x'},{...save,expected_version:-1},{...save,items:[{position:0,received:'1'}]}])await invalid(parse(`/v1/estoque/checkin/notas/${N}/recebidos`,'POST',body));
 const issue={command_id:CMD,expected_version:2,position:1,kind:'missing',quantity:'1',action:'none'};
 assert.deepEqual((await parse(`/v1/estoque/checkin/notas/${N}/pendencias`,'POST',issue)).args.p_kind,'missing');
 for(const body of[{...issue,action:'credit'},{...issue,kind:'refused'},{...issue,kind:'lost'},{...issue,quantity:'0'},{...issue,kind:'refused',quantity:'1'}])await invalid(parse(`/v1/estoque/checkin/notas/${N}/pendencias`,'POST',body));
 assert.equal((await parse(`/v1/estoque/checkin/notas/${N}/pendencias`,'POST',{...issue,kind:'refused',quantity:null})).args.p_quantity,null);
 assert.deepEqual((await parse(`/v1/estoque/checkin/notas/${N}/lote`,'POST',{command_id:CMD,expected_version:0,positions:[2,1]})).args.p_positions,[2,1]);
 await invalid(parse(`/v1/estoque/checkin/notas/${N}/lote`,'POST',{command_id:CMD,expected_version:0,positions:[1,1]}));
 for(const action of['reinicio','finalizacao']){
  assert.ok(await parse(`/v1/estoque/checkin/notas/${N}/${action}`,'POST',{command_id:CMD,expected_version:1}));
  await invalid(parse(`/v1/estoque/checkin/notas/${N}/${action}`,'POST',{command_id:CMD,expected_version:0}));
  await invalid(parse(`/v1/estoque/checkin/notas/${N}/${action}`,'POST',{command_id:CMD,expected_version:1,items:[]}));
 }
 await invalid(parse(`/v1/estoque/checkin/notas/${N}/reinicio?x=1`,'POST',{command_id:CMD,expected_version:1}));
});

test('147 projections fail closed: states, summary, stale flag, history and receipts must match',async()=>{
 const path=`/v1/estoque/checkin/notas/${N}`;
 const out=await project(path,'GET',undefined,{...view(),can_manage:true,private:'x'});
 assert.deepEqual([out.version,out.items[0].requested.prices,out.can_manage,out.private],[2,['9.5000000000'],true,undefined]);
 for(const value of[view({items:[item({state:'complete'}),view().items[1]]}),view({summary:{total:2,complete:1,issue:0,refused:0,pending:1}}),view({checkin:{...view().checkin,stale:true}}),
  view({checkin:{...view().checkin,version:3}}),view({note:note({invoice_id:P})}),view({items:[item({issue:'missing',issue_quantity:null,issue_action:'none',state:'issue'}),view().items[1]],summary:{total:2,complete:0,issue:1,refused:0,pending:1}}),
  view({items:[item({received:'2.5'}),view().items[1]]}),view({events:[{...view().events[0],action:'deleted'}]}),view({checkin:null}),view({items:[view().items[1],item()]}),
  view({items:[item({issue:'refused',issue_quantity:null,issue_action:'other',state:'issue'}),view().items[1]]})])
  await bad(project(path,'GET',undefined,{...value,can_manage:true}));
 const fresh={...view({checkin:null,version:0,events:[],note:note({checkin_state:'pending'}),items:[item({received:'0.0000',state:'pending'})],summary:{total:1,complete:0,issue:0,refused:0,pending:1}}),can_manage:false};
 assert.equal((await project(path,'GET',undefined,fresh)).checkin,null);
 const body={command_id:CMD,expected_version:1,items:[{position:1,received:'2'}]},cmd=`${path}/recebidos`;
 const saved=await project(cmd,'POST',body,{...view(),receipt:receipt(),replayed:false});
 assert.deepEqual([saved.receipt.to_version,saved.replayed],[2,false]);
 assert.equal((await project(cmd,'POST',body,{...view({version:4,checkin:{...view().checkin,version:4}}),receipt:receipt(),replayed:true})).version,4,'a replay shows the current state');
 for(const value of[{...view(),receipt:receipt({command_id:N}),replayed:false},{...view(),receipt:receipt({from_version:0}),replayed:false},{...view(),receipt:receipt({action:'batch'}),replayed:false},
  {...view({version:3,checkin:{...view().checkin,version:3}}),receipt:receipt(),replayed:false},{...view(),receipt:receipt()},{...view({checkin:null,version:0}),receipt:receipt(),replayed:false}])
  await bad(project(cmd,'POST',body,value));
 const finished={...view({version:4,checkin:{...view().checkin,version:4,state:'finished',finished_at:'2026-10-20T11:00:00Z'},note:note({checkin_state:'finished'}),
  events:[...view().events,{id:2,action:'finish',position:null,description:null,quantity:null,previous:null,at:'2026-10-20T11:00:00Z'}]}),receipt:receipt({action:'finish',from_version:2,to_version:4,detail:{}}),replayed:false};
 assert.equal((await project(`${path}/finalizacao`,'POST',{command_id:CMD,expected_version:2},finished)).checkin.state,'finished');
 await bad(project(`${path}/finalizacao`,'POST',{command_id:CMD,expected_version:2},{...finished,checkin:{...finished.checkin,state:'in_progress',finished_at:null},note:note()}));
 const notes={scope:'stock_checkin_notes',data_mode:'erp_native',query:null,offset:0,limit:50,total:2,can_manage:true,items:[note({created_at:'2026-10-20T11:00:00Z'}),note({invoice_id:P,created_at:'2026-10-20T10:00:00Z'})]};
 assert.equal((await project('/v1/estoque/checkin/notas','GET',undefined,notes)).items.length,2);
 for(const value of[{...notes,items:[...notes.items].reverse()},{...notes,total:3},{...notes,items:[note({open:false}),notes.items[1]]},{...notes,items:[note(),note()]},{...notes,items:[note({supplier:{name:'X',document:'123',person_type:'J'}}),notes.items[1]]}])
  await bad(project('/v1/estoque/checkin/notas','GET',undefined,value));
});

test('147 composed handler: the actor comes from the token and commands reach the protected RPC',async()=>{
 const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:{...view(),receipt:receipt(),replayed:false}),{status:200});}});
 const response=await handler(new Request(`https://api.example.test/v1/estoque/checkin/notas/${N}/recebidos`,{method:'POST',headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json'},
  body:JSON.stringify({command_id:CMD,expected_version:1,items:[{position:1,received:'2'}]})}),env);
 assert.equal(response.status,200);assert.equal((await response.json()).receipt.command_id,CMD);
 assert.ok(calls[1].url.endsWith('/rpc/erp_stock_checkin_save'));assert.deepEqual(JSON.parse(calls[1].body),{p_command_id:CMD,p_invoice_id:N,p_expected_version:1,p_items:[{position:1,received:'2'}],p_user_id:USER});
 const injected=await handler(new Request(`https://api.example.test/v1/estoque/checkin/notas/${N}/recebidos`,{method:'POST',headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json'},
  body:JSON.stringify({command_id:CMD,expected_version:1,items:[{position:1,received:'2'}],p_user_id:N})}),env);
 assert.equal(injected.status,400,'an actor in the body is refused before any RPC');
});
