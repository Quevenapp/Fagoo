import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockMethods,stockOperation,stockResponse} from '../src/stock.mjs';

// Routes of migration 105 under /v1/estoque: lançamentos, edição, reservas, totais e depósitos. Synthetic IDs only.
const USER='a1000000-0000-4000-8000-000000000001',P='b1000000-0000-4000-8000-000000000001',A='c1000000-0000-4000-8000-000000000001',B='c1000000-0000-4000-8000-000000000002';
const M='e1000000-0000-4000-8000-000000000001',CMD='f1000000-0000-4000-8000-000000000001',DOC='d1000000-0000-4000-8000-000000000001',R='d2000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
const parse=async(path,method,body)=>{const req=request(path,method,body),url=new URL(req.url);return stockOperation(req,stockRoute(url.pathname),url.searchParams);};
const project=async(path,method,body,value)=>{const op=await parse(path,method,body);return stockResponse(value,stockRoute(new URL(`https://x${path}`).pathname),op);};
const invalid=promise=>assert.rejects(promise,error=>error.status===400&&error.code==='ERP_INVALID_QUERY');
const upstream=fn=>assert.throws(fn,error=>error.status===502&&error.code==='ERP_UPSTREAM_INVALID_RESPONSE');
const launchBody=(patch={})=>({command_id:CMD,kind:'receipt',product_id:P,warehouse_id:A,quantity:'10',expected_version:0,unit_price:'1.5',unit_cost:'1.75',note:null,...patch});
const line=(quantity,balance,warehouse=A,version=1)=>({product_id:P,warehouse_id:warehouse,quantity,unit:'UN',balance_after:balance,balance_version:version});
const movement=(patch={})=>({id:M,kind:'receipt',occurred_on:'2026-10-20',reason:'Lançamento manual',reference:null,created_at:'2026-10-20T12:00:00+00:00',reverses_id:null,reversed_by:null,items:[line('10.000000','10.000000')],...patch});
const launched=(patch={})=>({scope:'stock_launch',data_mode:'erp_native',kind:'receipt',occurred_on:'2026-10-20',movement:movement(),detail:{revision:1,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Lançamento manual'},balance:null,replayed:false,private:'x',...patch});

test('routes and methods: new paths live under /v1/estoque without changing the 009 contract',()=>{
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/lancamentos')),['POST']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/movimentos/${M}`)),['PATCH']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/movimentos/${M}/estorno`)),['POST']);
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/depositos')),['GET','POST']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/depositos/${A}`)),['PATCH']);
 assert.deepEqual(stockMethods(stockRoute(`/v1/estoque/depositos/${A}/padrao`)),['POST']);
 assert.deepEqual(stockMethods(stockRoute('/v1/estoque/totais')),['GET']);assert.deepEqual(stockMethods(stockRoute('/v1/estoque/reservas')),['GET']);
 for(const path of['/v1/estoque/movimentos/bad','/v1/estoque/depositos/x/padrao','/v1/estoque/lancamentos/1','/v1/estoque/movimentos/bad/estorno','/v1/estoque/outros'])assert.equal(stockRoute(path),null,path);
});

test('launch body is strict: kinds, exact decimals, prices, destination only for transfers, no cost for Saída',async()=>{
 assert.deepEqual(await parse('/v1/estoque/lancamentos','POST',launchBody({product_id:P.toUpperCase()})),{type:'launch',rpc:'erp_stock_launch',args:{p_command_id:CMD,p_kind:'receipt',p_product_id:P,p_warehouse_id:A,p_quantity:'10',p_expected_version:0,p_unit_price:'1.5',p_unit_cost:'1.75',p_note:null,p_destination_id:null,p_destination_version:null}});
 assert.equal((await parse('/v1/estoque/lancamentos','POST',launchBody({kind:'balance',quantity:'-2.5'}))).args.p_quantity,'-2.5');
 assert.equal((await parse('/v1/estoque/lancamentos','POST',launchBody({kind:'balance',quantity:'0'}))).args.p_quantity,'0');
 assert.deepEqual((await parse('/v1/estoque/lancamentos','POST',launchBody({kind:'transfer',destination_id:B,destination_version:3}))).args.p_destination_version,3);
 for(const patch of[{kind:'adjustment'},{quantity:'0'},{quantity:'-1'},{quantity:'1,5'},{quantity:'1.1234567'},{quantity:1},{kind:'balance',quantity:'-0'},{unit_price:'1,5'},{unit_price:1.5},{unit_price:'1.12345678901'},
  {kind:'issue',unit_cost:'1'},{destination_id:B,destination_version:0},{kind:'transfer'},{kind:'transfer',destination_id:A,destination_version:0},{expected_version:-1},{expected_version:2147483647},{note:'a\u0007'},{note:'x'.repeat(501)},
  {command_id:'bad'},{extra:true},{product_id:'bad'}])
  await invalid(parse('/v1/estoque/lancamentos','POST',launchBody(patch)));
 await invalid(parse('/v1/estoque/lancamentos?x=1','POST',launchBody()));
 await invalid(parse('/v1/estoque/lancamentos','POST','{"command_id":'));
 await invalid(stockOperation(new Request('https://api.example.test/v1/estoque/lancamentos',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(launchBody())}),stockRoute('/v1/estoque/lancamentos'),new URLSearchParams()));
});

test('launch response is cross-checked against the request: kind, quantity, warehouses, prices, Balanço difference',async()=>{
 const value=await project('/v1/estoque/lancamentos','POST',launchBody(),launched());
 assert.equal(value.private,undefined);assert.equal(value.movement.items[0].quantity,'10.000000');assert.deepEqual(value.detail,{revision:1,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Lançamento manual'});
 const balance=launched({kind:'balance',movement:movement({kind:'adjustment',items:[line('-2.000000','5.000000')]}),balance:{counted:'5.000000',previous:'7.000000',warehouse_id:A,source:'launch'}});
 assert.equal((await project('/v1/estoque/lancamentos','POST',launchBody({kind:'balance',quantity:'5'}),balance)).balance.previous,'7.000000');
 const transfer=launched({kind:'transfer',movement:movement({kind:'transfer',reason:'Transferência',items:[line('-2.000000','8.000000'),line('2.000000','2.000000',B)]}),detail:{revision:1,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Transferência'}});
 assert.equal((await project('/v1/estoque/lancamentos','POST',launchBody({kind:'transfer',quantity:'2',destination_id:B,destination_version:0}),transfer)).movement.items.length,2);
 const bad=[launched({kind:'issue'}),launched({movement:movement({items:[line('9.000000','9.000000')]})}),launched({movement:movement({items:[line('10.000000','10.000000',B)]})}),
  launched({detail:{revision:1,unit_price:'1.4000000000',unit_cost:'1.7500000000',note:'Lançamento manual'}}),launched({detail:{revision:2,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Lançamento manual'}}),
  launched({detail:{revision:1,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Outra'}}),launched({balance:{counted:'1.000000',previous:'0.000000',warehouse_id:A,source:'launch'}}),launched({replayed:'no'}),
  launched({movement:movement({occurred_on:'2026-10-19'})}),launched({movement:movement({kind:'issue'})}),launched({scope:'stock_amend'}),launched({movement:movement({items:[{...line('10.000000','10.000000'),product_id:B}]})})];
 for(const value of bad)await assert.rejects(project('/v1/estoque/lancamentos','POST',launchBody(),value),error=>error.status===502);
 await assert.rejects(project('/v1/estoque/lancamentos','POST',launchBody({kind:'balance',quantity:'5'}),{...balance,balance:{...balance.balance,previous:'8.000000'}}),error=>error.status===502);
 await assert.rejects(project('/v1/estoque/lancamentos','POST',launchBody({kind:'transfer',quantity:'2',destination_id:B,destination_version:0}),{...transfer,movement:movement({kind:'transfer',items:[line('-2.000000','8.000000'),line('3.000000','3.000000',B)]})}),error=>error.status===502);
});

test('amend, reservations, totals and warehouses: strict params and fail-closed projections',async()=>{
 const amend={command_id:CMD,product_id:P,expected_revision:1,unit_price:'1.6',unit_cost:'1.8',note:' Compra '};
 assert.deepEqual((await parse(`/v1/estoque/movimentos/${M}`,'PATCH',amend)).args,{p_command_id:CMD,p_movement_id:M,p_product_id:P,p_expected_revision:1,p_unit_price:'1.6',p_unit_cost:'1.8',p_note:' Compra '});
 for(const patch of[{note:undefined},{expected_revision:'1'},{unit_price:'x'},{extra:1},{product_id:undefined}])await invalid(parse(`/v1/estoque/movimentos/${M}`,'PATCH',{...amend,...patch}));
 const amended={scope:'stock_amend',data_mode:'erp_native',movement_id:M,product_id:P,from:{revision:1,unit_price:'1.5000000000',unit_cost:'1.7500000000',note:'Lançamento manual'},detail:{revision:2,unit_price:'1.6000000000',unit_cost:'1.8000000000',note:'Compra'},amended_at:'2026-10-20T12:00:00Z',replayed:false};
 assert.equal((await project(`/v1/estoque/movimentos/${M}`,'PATCH',amend,amended)).detail.note,'Compra');
 for(const value of[{...amended,detail:{...amended.detail,revision:3}},{...amended,product_id:B},{...amended,detail:{...amended.detail,note:' Compra '}},{...amended,from:{...amended.from,revision:0}}])
  await assert.rejects(project(`/v1/estoque/movimentos/${M}`,'PATCH',amend,value),error=>error.status===502);
 // Reservations ("Visualizar vendas").
 const reservation={reservation_id:R,source:'reservation',document_id:DOC,document_number:'12',status:'verified',contact_name:'Cliente sintético',warehouse_id:A,warehouse_ignored:false,quantity:'1.000000',unit:'UN',reserved_at:'2026-10-20T12:00:00Z'};
 const reservations={scope:'stock_product_reservations',data_mode:'erp_native',product_id:P,warehouse_id:A,items:[reservation],total:1,quantity:'1.000000',reservation:{by_situation:false,by_warehouse:true,statuses:[]}};
 assert.equal((await project(`/v1/estoque/reservas?product_id=${P}&warehouse_id=${A}`,'GET',undefined,reservations)).items[0].contact_name,'Cliente sintético');
 await assert.rejects(project(`/v1/estoque/reservas?product_id=${P}&warehouse_id=${A}`,'GET',undefined,{...reservations,quantity:'2.000000'}),error=>error.status===502);
 await assert.rejects(project(`/v1/estoque/reservas?product_id=${P}&warehouse_id=${A}`,'GET',undefined,{...reservations,items:[{...reservation,warehouse_id:B}]}),error=>error.status===502);
 for(const query of['',`?product_id=${P}&product_id=${P}`,`?product_id=${P}&warehouse_id=`,`?product_id=bad`,`?product_id=${P}&x=1`])await invalid(parse(`/v1/estoque/reservas${query}`,'GET'));
 // Totals and warehouse options of the extrato.
 const totals={scope:'stock_totals',data_mode:'erp_native',warehouse_id:null,quantity:'12.500000',sale_value:'31.25',unpriced_products:0,ignored_warehouses:1,cost_visible:true,cost_value:'20.00',uncosted_products:0,cost_basis:'preco_compra',warehouses:[{id:A,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:B,name:'Avarias',active:true,is_default:false,ignore_balance:true}]};
 assert.equal((await project('/v1/estoque/totais','GET',undefined,totals)).warehouses.length,2);
 for(const value of[{...totals,sale_value:'31.2'},{...totals,ignored_warehouses:0},{...totals,warehouses:[...totals.warehouses,{...totals.warehouses[0]}]},{...totals,warehouses:[{...totals.warehouses[0],active:false},totals.warehouses[1]]},{...totals,quantity:'-0.000000'}])
  await assert.rejects(project('/v1/estoque/totais','GET',undefined,value),error=>error.status===502);
 await assert.rejects(project(`/v1/estoque/totais?warehouse_id=${A}`,'GET',undefined,totals),error=>error.status===502,'the answer must be for the filtered warehouse');
 // Depósitos.
 assert.deepEqual((await parse('/v1/estoque/depositos?q=Geral&situacao=ativos&pagina=2','GET')).args,{p_query:'Geral',p_active:true,p_page:2,p_size:100});
 for(const query of['?situacao=todos','?pagina=0','?pagina=01','?q=','?size=10'])await invalid(parse(`/v1/estoque/depositos${query}`,'GET'));
 const item={id:A,name:'Geral',active:true,version:2,is_default:true,ignore_balance:false,setting_version:0};
 const list={scope:'stock_warehouses',data_mode:'erp_native',page:1,size:100,total:1,items:[item],default:{warehouse_id:A,version:1},can_manage:true};
 assert.equal((await project('/v1/estoque/depositos','GET',undefined,list)).items[0].is_default,true);
 for(const value of[{...list,items:[{...item,is_default:false}]},{...list,total:2},{...list,items:[{...item,ignore_balance:true}]},{...list,default:{warehouse_id:null,version:1}}])
  await assert.rejects(project('/v1/estoque/depositos','GET',undefined,value),error=>error.status===502);
 await assert.rejects(project('/v1/estoque/depositos?q=avaria','GET',undefined,list),error=>error.status===502,'a row outside the search');
 assert.equal((await project('/v1/estoque/depositos?q=ger%C3%A1l','GET',undefined,list)).items.length,1,'accent folding like erp_catalog.fold');
 assert.deepEqual((await parse('/v1/estoque/depositos','POST',{command_id:CMD,name:'Geral',ignore_balance:true})).args,{p_command_id:CMD,p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:'Geral',p_ignore_balance:true});
 assert.deepEqual((await parse(`/v1/estoque/depositos/${A}`,'PATCH',{command_id:CMD,name:'Geral',ignore_balance:false,expected_version:2,expected_setting_version:1})).args.p_expected_setting_version,1);
 for(const body of[{command_id:CMD,name:' Geral',ignore_balance:true},{command_id:CMD,name:'',ignore_balance:true},{command_id:CMD,name:'Geral',ignore_balance:'sim'},{command_id:CMD,name:'Geral',ignore_balance:true,expected_version:1}])
  await invalid(parse('/v1/estoque/depositos','POST',body));
 await invalid(parse(`/v1/estoque/depositos/${A}`,'PATCH',{command_id:CMD,name:'Geral',ignore_balance:false,expected_version:0,expected_setting_version:0}));
 assert.deepEqual((await parse(`/v1/estoque/depositos/${A}/padrao`,'POST',{command_id:CMD,expected_version:1})).args,{p_command_id:CMD,p_warehouse_id:A,p_expected_version:1});
 const saved={scope:'stock_warehouse',data_mode:'erp_native',replayed:false,warehouse:item,receipt:{command_id:CMD,action:'default',from:{warehouse_id:B,version:1},to:{warehouse_id:A,version:2},saved_at:'2026-10-20T12:00:00Z'}};
 assert.equal((await project(`/v1/estoque/depositos/${A}/padrao`,'POST',{command_id:CMD,expected_version:1},saved)).receipt.to.version,2);
 await assert.rejects(project(`/v1/estoque/depositos/${A}/padrao`,'POST',{command_id:CMD,expected_version:1},{...saved,warehouse:{...item,is_default:false}}),error=>error.status===502);
});

test('composed handler: authenticated actor, exact RPC, p_user_id appended, database errors mapped, PATCH preflight',async()=>{
 const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:launched()),{status:200});}});
 const authed=(path,method,body,extra={})=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json',...extra},body:JSON.stringify(body)});
 const response=await handler(authed('/v1/estoque/lancamentos','POST',launchBody()),env);assert.equal(response.status,200);
 assert.equal((await response.json()).private,undefined);
 assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_stock_launch'));assert.equal(calls[1].headers.Authorization,'Bearer synthetic-service');
 assert.equal(JSON.parse(calls[1].body).p_user_id,USER);
 const before=calls.length;
 assert.equal((await handler(authed('/v1/estoque/lancamentos','POST',launchBody({p_user_id:USER})),env)).status,400);
 assert.equal((await handler(new Request('https://api.example.test/v1/estoque/lancamentos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(launchBody())}),env)).status,401);
 assert.equal((await handler(authed('/v1/estoque/lancamentos','PATCH',launchBody()),env)).status,405);
 assert.equal(calls.length,before,'invalid or anonymous writes never reach auth or the RPC');
 const preflight=await handler(new Request(`https://api.example.test/v1/estoque/movimentos/${M}`,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'PATCH','Access-Control-Request-Headers':'authorization,content-type'}}),env);
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),'PATCH');
 for(const [code,status]of[['42501',403],['22023',400],['P0002',404],['40001',409]]){
  const denied=createHandler({fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:{code,message:'private database error'}),{status:url.endsWith('/user')?200:400})});
  const out=await denied(authed('/v1/estoque/lancamentos','POST',launchBody()),env);assert.equal(out.status,status);assert.doesNotMatch(await out.text(),/private database/);
 }
 const wrong=createHandler({fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:launched({kind:'issue'})),{status:200})});
 assert.equal((await wrong(authed('/v1/estoque/lancamentos','POST',launchBody()),env)).status,502);
});

test('ledger rows of 105: direction filter, detail and Balanço are validated against the query',async()=>{
 const none={type:'none',document_id:null,document_kind:null,document_number:null,via:null};
 const row=(patch={})=>({id:M,kind:'adjustment',occurred_on:'2026-10-20',reason:'Lançamento manual',reference:null,created_at:'2026-10-20T12:00:00+00:00',recorded_at_local:'2026-10-20T09:00:00',reverses_id:null,reversed_by:null,
  items:[line('-2.000000','5.000000')],other_items:0,origin:none,revision:1,note:'ok',unit_price:'1.5000000000',unit_cost:'1.7500000000',price_source:'detail',balance:{counted:'5.000000',previous:'7.000000',warehouse_id:A,source:'launch'},...patch});
 const page=(items,direction='balance')=>({product_id:P,items,limit:100,offset:0,total:items.length,has_more:false,next_offset:null,filters:{warehouse_id:null,kind:null,origin:null,date_from:null,date_to:null,direction},totals:{entries:'0.000000',exits:'0.000000',current_balance:'5.000000',unit:'UN'},data_mode:'erp_native'});
 const path=direction=>`/v1/estoque/movimentos?product_id=${P}&offset=0&direction=${direction}`;
 assert.equal((await project(path('balance'),'GET',undefined,page([row()]))).items[0].balance.counted,'5.000000');
 assert.equal((await parse(path('exit'),'GET')).args.p_direction,'exit');
 await invalid(parse(`/v1/estoque/movimentos?product_id=${P}&offset=0&direction=Balanço`,'GET'));
 for(const value of[page([row({balance:{counted:'6.000000',previous:'7.000000',warehouse_id:A,source:'launch'}})]),page([row({kind:'receipt'})]),page([row({balance:null})]),
  page([row({revision:0})]),page([row({price_source:'document'})]),page([row({unit_price:'1.5'})]),page([row({balance:{counted:'5.000000',previous:'7.000000',warehouse_id:B,source:'launch'}})])])
  upstream(()=>stockResponse(value,stockRoute('/v1/estoque/movimentos'),{type:'ledger',args:{p_product_id:P,p_warehouse_id:null,p_kind:null,p_origin:null,p_date_from:null,p_date_to:null,p_limit:100,p_offset:0,p_direction:'balance'}}));
 const entryArgs={p_product_id:P,p_warehouse_id:null,p_kind:null,p_origin:null,p_date_from:null,p_date_to:null,p_limit:100,p_offset:0,p_direction:'entry'};
 upstream(()=>stockResponse(page([row()],'entry'),stockRoute('/v1/estoque/movimentos'),{type:'ledger',args:entryArgs}));
 upstream(()=>stockResponse(page([row({kind:'issue',balance:null,items:[line('-1.000000','4.000000')]})],'entry'),stockRoute('/v1/estoque/movimentos'),{type:'ledger',args:entryArgs}));
});
