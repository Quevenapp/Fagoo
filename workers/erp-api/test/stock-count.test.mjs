import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// Routes of migration 106 under /v1/estoque/conferencias. Synthetic IDs only.
const USER='a2000000-0000-4000-8000-000000000001',S='b2000000-0000-4000-8000-000000000001',P='c2000000-0000-4000-8000-000000000001',W='d2000000-0000-4000-8000-000000000001',CMD='e2000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const parse=async(path,body)=>{const url=new URL(`https://api.example.test${path}`),request=body===undefined?new Request(url):new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return stockOperation(request,stockRoute(url.pathname),url.searchParams);};
const project=async(path,body,value)=>stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),await parse(path,body));
const invalid=promise=>assert.rejects(promise,error=>error.status===400);
const upstream=promise=>assert.rejects(promise,error=>error.status===502);
const count=(patch={})=>({session:{id:S,state:'open',version:1,warehouse_id:W,warehouse_name:'Geral',created_at:'2026-10-20T12:00:00Z',balance_scope:null,closed_at:null},total_read:'3.000000',readings:2,items_total:1,
 items:[{product_id:P,code:'CAN-1',name:'Caneta',location:null,unit:'UN',counted:'3.000000',physical:'7.000000',difference:'-4.000000'}],log:[{id:CMD,code:'CAN-1',quantity:'1.000000',product_id:P,product_name:'Caneta',recorded_at_local:'2026-10-20T09:00:00',deleted:false}],...patch});
const readBody={command_id:CMD,session_id:S,code:'CAN-1',quantity:'2',warehouse_id:W};
const read=(patch={})=>({scope:'stock_count',data_mode:'erp_native',outcome:'read',reason:null,code:'CAN-1',reading:{product_id:P,product_name:'Caneta',quantity:'2.000000'},session_id:S,count:count(),replayed:false,...patch});

test('count routes: GET of the open count and POST commands with strict bodies',async()=>{
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/conferencias/atual')),['GET']);
 for(const action of['exclusoes','deposito','reinicio','balanco'])assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/conferencias/${S}/${action}`)),['POST']);
 assert.equal(stockRoute('/v1/estoque/conferencias/x/balanco'),null);assert.equal(stockRoute(`/v1/estoque/conferencias/${S}`),null);
 assert.deepEqual(await parse('/v1/estoque/conferencias/leituras',readBody),{type:'count-read',rpc:'erp_stock_count_read',args:{p_command_id:CMD,p_session_id:S,p_code:'CAN-1',p_quantity:'2',p_warehouse_id:W}});
 assert.equal((await parse('/v1/estoque/conferencias/leituras',{...readBody,session_id:null,warehouse_id:null})).args.p_session_id,null);
 for(const patch of[{code:''},{code:'a\u0001'},{quantity:2},{session_id:'x'},{warehouse_id:'x'},{extra:1},{session_id:undefined}])await invalid(parse('/v1/estoque/conferencias/leituras',{...readBody,...patch}));
 assert.deepEqual((await parse(`/v1/estoque/conferencias/${S}/balanco`,{command_id:CMD,expected_version:3,scope:'all_active',confirmed:true})).args,{p_command_id:CMD,p_session_id:S,p_expected_version:3,p_scope:'all_active',p_confirmed:true});
 await invalid(parse(`/v1/estoque/conferencias/${S}/balanco`,{command_id:CMD,expected_version:3,scope:'all_active',confirmed:false}));
 await invalid(parse(`/v1/estoque/conferencias/${S}/balanco`,{command_id:CMD,expected_version:0,scope:'counted',confirmed:false}));
 assert.equal((await parse(`/v1/estoque/conferencias/${S}/deposito`,{command_id:CMD,expected_version:1,warehouse_id:null})).args.p_warehouse_id,null);
 await invalid(parse(`/v1/estoque/conferencias/${S}/deposito`,{command_id:CMD,expected_version:1}));
 await invalid(parse('/v1/estoque/conferencias/atual?x=1'));
});

test('count responses are closed and cross-checked: differences, totals, session and Origin refusals',async()=>{
 const value=await project('/v1/estoque/conferencias/leituras',readBody,read());assert.equal(value.count.items[0].difference,'-4.000000');
 assert.equal((await project('/v1/estoque/conferencias/leituras',readBody,read({replayed:true,count:undefined}))).count,null,'a replay is re-read by GET');
 assert.equal((await project('/v1/estoque/conferencias/leituras',readBody,{scope:'stock_count',data_mode:'erp_native',outcome:'rejected',reason:'not_found',code:'X',count:null,replayed:false})).reason,'not_found');
 for(const bad of[read({reading:{product_id:P,product_name:'Caneta',quantity:'3.000000'}}),read({session_id:W}),read({count:count({items:[{...count().items[0],difference:'-3.000000'}]})}),
  read({count:count({total_read:'4.000000'})}),read({count:count({session:{...count().session,state:'closed'}})}),read({count:count({items_total:2})}),read({outcome:'rejected',reason:'unknown'}),
  read({code:'CAN\u0001'}),read({code:7}),read({outcome:'rejected',reason:'not_found',code:'x'.repeat(101),count:null})])
  await upstream(project('/v1/estoque/conferencias/leituras',readBody,bad));
 const balanced={scope:'stock_count',data_mode:'erp_native',outcome:'balanced',session_id:S,warehouse_id:W,balance_scope:'counted',occurred_on:'2026-10-20',changed:[{product_id:P,name:'Caneta',movement_id:CMD,counted:'3.000000',previous:'7.000000'}],unchanged:0,skipped:[],replayed:false};
 assert.equal((await project(`/v1/estoque/conferencias/${S}/balanco`,{command_id:CMD,expected_version:1,scope:'counted',confirmed:false},balanced)).changed.length,1);
 for(const bad of[{...balanced,balance_scope:'all_active'},{...balanced,changed:[{...balanced.changed[0],counted:'7.000000'}]},{...balanced,skipped:[{product_id:P,name:'Caneta',reason:'reserved'}]},{...balanced,session_id:P}])
  await upstream(project(`/v1/estoque/conferencias/${S}/balanco`,{command_id:CMD,expected_version:1,scope:'counted',confirmed:false},bad));
 const restarted={scope:'stock_count',data_mode:'erp_native',outcome:'restarted',session_id:S,discarded_readings:2,count:count({session:{...count().session,id:CMD},readings:0,items_total:0,items:[],log:[],total_read:'0.000000'}),replayed:false};
 assert.equal((await project(`/v1/estoque/conferencias/${S}/reinicio`,{command_id:CMD,expected_version:1},restarted)).count.session.id,CMD);
 await upstream(project(`/v1/estoque/conferencias/${S}/reinicio`,{command_id:CMD,expected_version:1},{...restarted,count:count()}));
});

test('composed handler: authenticated actor and erp_stock_count_* RPCs only',async()=>{
 const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:read()),{status:200});}});
 const response=await handler(new Request('https://api.example.test/v1/estoque/conferencias/leituras',{method:'POST',headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json'},body:JSON.stringify(readBody)}),env);
 assert.equal(response.status,200);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_stock_count_read'));assert.equal(JSON.parse(calls[1].body).p_user_id,USER);
 assert.equal((await handler(new Request('https://api.example.test/v1/estoque/conferencias/atual',{method:'POST',headers:{Authorization:'Bearer synthetic-user'}}),env)).status,405);
});
