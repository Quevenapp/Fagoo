import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// GET /v1/estoque/movimentos ledger mode (offset present) → erp_stock_ledger (migration 098). Synthetic IDs only.
const USER='a0000000-0000-4000-8000-000000000001',PRODUCT='b0000000-0000-4000-8000-000000000001',OTHER='b0000000-0000-4000-8000-000000000002';
const A='c0000000-0000-4000-8000-000000000001',B='c0000000-0000-4000-8000-000000000002',DOC='d0000000-0000-4000-8000-000000000001';
const M1='e0000000-0000-4000-8000-000000000001',M2='e0000000-0000-4000-8000-000000000002',M3='e0000000-0000-4000-8000-000000000003';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const parse=async query=>{const url=new URL(`https://api.example.test/v1/estoque/movimentos?${query}`);return stockOperation(new Request(url),stockRoute(url.pathname),url.searchParams);};
const none={type:'none',document_id:null,document_kind:null,document_number:null,via:null};
const entry=(quantity,balance,warehouse=A,version=1)=>({product_id:PRODUCT,warehouse_id:warehouse,quantity,unit:'UN',balance_after:balance,balance_version:version});
const row=(id,patch={})=>({id,kind:'receipt',occurred_on:'2026-10-10',reason:'Lançamento sintético',reference:null,created_at:'2026-10-10T15:00:00.123456+00:00',recorded_at_local:'2026-10-10T12:00:00',
 reverses_id:null,reversed_by:null,items:[entry('1.000000','1.000000')],other_items:0,origin:none,actor:'hidden',
 // 105: prices, observação revision and Balanço count of the row.
 revision:0,note:null,unit_price:null,unit_cost:null,price_source:null,balance:null,...patch});
const filters={warehouse_id:null,kind:null,origin:null,date_from:null,date_to:null,direction:null};
const page=(patch={})=>({product_id:PRODUCT,items:[row(M1,{kind:'issue',items:[entry('-2.000000','8.000000')],origin:{type:'sales',document_id:DOC,document_kind:'sales_orders',document_number:'12',via:'document_stock'}}),row(M2,{created_at:'2026-10-10T14:00:00+00:00',recorded_at_local:'2026-10-10T11:00:00'}),row(M3,{occurred_on:'2026-10-01'})],
 limit:100,offset:0,total:3,has_more:false,next_offset:null,filters,totals:{entries:'12.000001',exits:'2.000000',current_balance:'10.000001',unit:'UN'},data_mode:'erp_native',private:'hidden',...patch});
const project=async(value,query='product_id='+PRODUCT+'&offset=0')=>{const operation=await parse(query);return stockResponse(value,stockRoute('/v1/estoque/movimentos'),operation);};
// A valid three-row page whose last row receives one defect, so each case fails for that defect only.
const third=patch=>page({items:[row(M1),row(M2),row(M3,{occurred_on:'2026-10-01',...patch})]});
const upstream=promise=>assert.rejects(promise,error=>error.status===502&&error.code==='ERP_UPSTREAM_INVALID_RESPONSE');

test('ledger mode is explicit: offset selects erp_stock_ledger with strict args; the 009 cursor mode is unchanged',async()=>{
 assert.deepEqual(await parse(`product_id=${PRODUCT.toUpperCase()}&offset=0`),{rpc:'erp_stock_ledger',type:'ledger',args:{p_product_id:PRODUCT,p_warehouse_id:null,p_kind:null,p_origin:null,p_date_from:null,p_date_to:null,p_limit:100,p_offset:0,p_direction:null}});
 assert.deepEqual((await parse(`product_id=${PRODUCT}&limit=100&offset=200&warehouse_id=${B.toUpperCase()}&kind=reversal&origin=transfers&date_from=2026-10-01&date_to=2026-10-31`)).args,
  {p_product_id:PRODUCT,p_warehouse_id:B,p_kind:'reversal',p_origin:'transfers',p_date_from:'2026-10-01',p_date_to:'2026-10-31',p_limit:100,p_offset:200,p_direction:null});
 for(const kind of['receipt','issue','adjustment','transfer','reversal'])assert.equal((await parse(`product_id=${PRODUCT}&offset=0&kind=${kind}`)).args.p_kind,kind);
 for(const origin of['sales','purchases','services','transfers','none'])assert.equal((await parse(`product_id=${PRODUCT}&offset=0&origin=${origin}`)).args.p_origin,origin);
 assert.deepEqual(await parse(`product_id=${PRODUCT}&limit=25`),{rpc:'erp_stock_movements',args:{p_product_id:PRODUCT,p_limit:25,p_after:null},type:'list'});
});

test('ledger query rejects unknown, repeated, empty and out-of-range parameters before any RPC',async()=>{
 const base=`product_id=${PRODUCT}&offset=0`;
 for(const suffix of['&raw=1','&after='+M1,'&offset=0','&kind=receipt&kind=issue','&kind=','&kind=balance','&kind=Receipt','&origin=','&origin=fiscal','&origin=excluida','&warehouse_id=','&warehouse_id=bad',
  '&date_from=2026-02-30','&date_from=26-10-01','&date_to=2101-01-01','&date_from=2026-10-02&date_to=2026-10-01','&limit=0','&limit=101','&limit=01','&limit=1.5','&q=x'])
  await assert.rejects(parse(base+suffix),error=>error.status===400&&error.code==='ERP_INVALID_QUERY',suffix);
 for(const query of[`product_id=${PRODUCT}&offset=-1`,`product_id=${PRODUCT}&offset=01`,`product_id=${PRODUCT}&offset=100001`,`product_id=${PRODUCT}&offset=`,'offset=0',`product_id=bad&offset=0`,
  `product_id=${PRODUCT}&kind=receipt`,`product_id=${PRODUCT}&limit=100`])
  await assert.rejects(parse(query),error=>error.status===400,query);
});

test('ledger response is projected: private fields dropped, exact decimal strings and links preserved',async()=>{
 const value=await project(page());
 assert.equal(value.private,undefined);assert.equal(value.items[0].actor,undefined);
 assert.deepEqual(value.totals,{entries:'12.000001',exits:'2.000000',current_balance:'10.000001',unit:'UN'});
 assert.deepEqual(value.items[0].origin,{type:'sales',document_id:DOC,document_kind:'sales_orders',document_number:'12',via:'document_stock'});
 assert.deepEqual(Object.keys(value),['product_id','items','limit','offset','total','has_more','next_offset','filters','totals','data_mode']);
 assert.equal(value.items[1].recorded_at_local,'2026-10-10T11:00:00');assert.equal(value.items[0].items[0].quantity,'-2.000000');
 const paged=await project(page({items:[row(M1)],limit:1,offset:1,total:3,has_more:true,next_offset:2}),`product_id=${PRODUCT}&offset=1&limit=1`);
 assert.deepEqual([paged.total,paged.next_offset,paged.has_more],[3,2,true]);
 const purchase={type:'purchases',document_id:DOC,document_kind:'purchase_orders',document_number:'9999999999',via:'purchase_receipt'};
 assert.deepEqual((await project(page({items:[row(M1,{kind:'reversal',reverses_id:M2,origin:purchase})],total:1}))).items[0].origin,purchase);
 const transfer=row(M1,{kind:'transfer',items:[entry('-1.000000','0.000000'),entry('1.000000','1.000000',B)],origin:{...none,type:'transfers'}});
 assert.equal((await project(page({items:[transfer],total:1,filters:{...filters,warehouse_id:B}}),`product_id=${PRODUCT}&offset=0&warehouse_id=${B}`)).items[0].items.length,2);
});

test('ledger response fails closed on any mismatch with the query, ordering, totals or origin contract',async()=>{
 const cases=[
  page({product_id:OTHER}),page({limit:25}),page({offset:100}),page({total:4}),page({total:-1}),page({total:'3'}),page({has_more:true}),page({next_offset:3}),page({items:page().items.slice(0,2)}),
  page({filters:{...filters,kind:'receipt'}}),page({filters:{warehouse_id:null,kind:null,origin:null,date_from:null,date_to:null}}),page({filters:null}),
  page({totals:{entries:'12.5',exits:'2.000000',current_balance:'10.000001',unit:'UN'}}),page({totals:{entries:12,exits:'2.000000',current_balance:'10.000001',unit:'UN'}}),
  page({totals:{entries:'-1.000000',exits:'2.000000',current_balance:'10.000001',unit:'UN'}}),page({totals:{entries:'1.000000',exits:'2.000000',current_balance:'-0.000000',unit:'UN'}}),page({totals:{entries:'1.000000',exits:'-2.000000',current_balance:'10.000001',unit:'UN'}}),page({totals:{entries:'1.000000',exits:'2.000000',current_balance:'10.000001'}}),
  third({items:[{...entry('1.000000','1.000000'),product_id:OTHER}]}),
  third({other_items:-1}),third({other_items:100}),
  third({recorded_at_local:'2026-10-10 12:00:00'}),third({recorded_at_local:'2026-02-30T12:00:00'}),
  third({created_at:'ontem'}),
  third({origin:{...none,type:'deleted'}}),third({origin:{...none,type:'transfers'}}),
  third({origin:{...none,document_id:DOC}}),third({origin:{type:'sales',document_id:DOC,document_kind:'purchase_orders',document_number:'1',via:'document_stock'}}),
  third({origin:{type:'sales',document_id:DOC,document_kind:'sales_orders',document_number:'1',via:'purchase_receipt'}}),
  third({origin:{type:'services',document_id:DOC,document_kind:'service_orders',document_number:'01',via:'document_stock'}}),
  third({kind:'adjustment',origin:{type:'services',document_id:DOC,document_kind:'service_orders',document_number:'1',via:'document_stock'}}),
  third({origin:{type:'none',document_id:null,document_kind:null,document_number:null}}),
  page({items:[row(M3,{occurred_on:'2026-10-01'}),row(M1),row(M2)]}),page({items:[row(M2,{created_at:'2026-10-10T14:00:00+00:00'}),row(M1),row(M3,{occurred_on:'2026-10-01'})]}),page({items:[row(M1),row(M1),row(M3,{occurred_on:'2026-10-01'})]}),
  page({data_mode:'staging_readonly'}),
 ];
 assert.equal((await project(third({}))).items.length,3,'the control page is valid');
 for(const value of cases)await upstream(project(value));
 // Each row must honour the filters it was asked for.
 await upstream(project(page({filters:{...filters,kind:'issue'}}),`product_id=${PRODUCT}&offset=0&kind=issue`));
 await upstream(project(page({filters:{...filters,origin:'sales'}}),`product_id=${PRODUCT}&offset=0&origin=sales`));
 await upstream(project(page({filters:{...filters,warehouse_id:B}}),`product_id=${PRODUCT}&offset=0&warehouse_id=${B}`));
 await upstream(project(page({filters:{...filters,date_from:'2026-10-05'}}),`product_id=${PRODUCT}&offset=0&date_from=2026-10-05`));
 await upstream(project(page({filters:{...filters,date_to:'2026-10-05'}}),`product_id=${PRODUCT}&offset=0&date_to=2026-10-05`));
});

test('composed handler authenticates the actor, calls only erp_stock_ledger with p_user_id and maps database errors',async()=>{
 const calls=[];const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:page()),{status:200});}});
 const request=(query,extra={})=>new Request(`https://api.example.test/v1/estoque/movimentos?${query}`,{headers:{Authorization:'Bearer synthetic-user'},...extra});
 const response=await handler(request(`product_id=${PRODUCT}&offset=0`),env);assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.private,undefined);assert.equal(body.items.length,3);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_stock_ledger'));assert.equal(calls[1].headers.Authorization,'Bearer synthetic-service');
 assert.deepEqual(JSON.parse(calls[1].body),{p_product_id:PRODUCT,p_warehouse_id:null,p_kind:null,p_origin:null,p_date_from:null,p_date_to:null,p_limit:100,p_offset:0,p_direction:null,p_user_id:USER});
 const before=calls.length;
 assert.equal((await handler(request(`product_id=${PRODUCT}&offset=0&p_user_id=${USER}`),env)).status,400);
 assert.equal((await handler(request(`product_id=${PRODUCT}&offset=0`,{headers:{}}),env)).status,401);
 assert.equal(calls.length,before,'invalid or anonymous ledger queries never reach auth or the RPC');
 for(const [code,status]of[['42501',403],['22023',400],['P0002',404]]){
  const denied=createHandler({fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:{code,message:'private database error'}),{status:url.endsWith('/user')?200:400})});
  const out=await denied(request(`product_id=${PRODUCT}&offset=0`),env);assert.equal(out.status,status);assert.doesNotMatch(await out.text(),/private database/);
 }
 const wrong=createHandler({fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:page({offset:100})),{status:200})});
 assert.equal((await wrong(request(`product_id=${PRODUCT}&offset=0`),env)).status,502);
});

test('ledger accepts a negative Saldo atual when the company allows negative stock (migration100)',async()=>{
 const value=await project(page({totals:{entries:'12.000001',exits:'2.000000',current_balance:'-3.500000',unit:'UN'}}));
 assert.equal(value.totals.current_balance,'-3.500000');
});
