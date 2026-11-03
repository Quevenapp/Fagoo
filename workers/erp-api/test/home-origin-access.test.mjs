import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {STATES} from '../../../packages/erp-domain/src/index.mjs';
import {HOME_SHORTCUTS,homePeriodBuckets,homePeriodRange} from '../src/home.mjs';

// Synthetic responses only: exercises the HTTP boundary of /v1/inicio (period) and /v1/inicio/atalhos.
const user='a0000000-0000-4000-8000-000000000001',command='b0000000-0000-4000-8000-000000000002';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const today='2026-10-19';
const base=(role='admin')=>({data_mode:'erp_native',as_of:'2026-10-19T12:00:00Z',business_date:today,timezone:'America/Sao_Paulo',role,
 catalog:['contacts','products','warehouses'].map(entity=>({entity,active:0,archived:0})),
 documents:Object.entries(STATES).map(([kind,statuses])=>({kind,count:0,statuses:Object.keys(statuses).map(status=>({status,count:0}))})),
 stock:{positions:0,positive_positions:0,zero_positions:0,products:0,warehouses:0},
 finance:{titles:['receivable','payable'].map(kind=>({kind,buckets:['overdue','today','next_7_days','later'].map(bucket=>({bucket,count:0,balance_cents:'0'}))})),accounts:{active:0,archived:0,opening_pending:0,recorded_balance_cents:'0'}}});
function period(key='30d',from=null,to=null){
 const [start,end]=homePeriodRange(key,today,from,to),{grain,buckets}=homePeriodBuckets(start,end);
 const points=buckets.map(bucket=>({bucket,sales_cents:'0',receivable_cents:'0',payable_cents:'0'}));
 points[0].sales_cents='1250';points[0].receivable_cents='999999999999999';points.at(-1).payable_cents='75';
 return {key,from:start,to:end,day_count:(Date.parse(end)-Date.parse(start))/86400000+1,grain,points,
  sales:{count:2,statuses:Object.keys(STATES.sales_orders).map(status=>({status,count:status==='open'||status==='cancelled'?1:0,total_cents:status==='open'?'1250':status==='cancelled'?'300':'0'}))},
  receivable:{count:1,total_cents:'999999999999999',open_cents:'999999999999999',fee_cents:'10'},payable:{count:1,total_cents:'75',open_cents:'0'},invoices:{count:1,total_cents:'1001'}};
}
const overview=(key,from,to)=>({...base(),period:period(key,from,to)});
const allowed=role=>Object.keys(HOME_SHORTCUTS).filter(path=>HOME_SHORTCUTS[path].includes(role));
const favorites=(extra={})=>({scope:'home_shortcuts',data_mode:'erp_native',role:'admin',version:0,customized:false,shortcuts:['/documentos-empresa?tipo=sales_orders'],available:allowed('admin'),...extra});
const request=(path,method='GET',body,headers={})=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic-token',Origin:'https://erp.example.test',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
const harness=(result,status=200)=>{const calls=[];return {calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:user}):Response.json(typeof result==='function'?result(calls):result,{status});}})};};

test('period summary sends only allow-listed period arguments to the overview RPC and strips extra fields',async()=>{
 for(const [query,args,result] of [['periodo=30d',{p_period:'30d',p_from:null,p_to:null},overview('30d')],['periodo=hoje',{p_period:'hoje',p_from:null,p_to:null},overview('hoje')],
  ['periodo=12m',{p_period:'12m',p_from:null,p_to:null},overview('12m')],['periodo=7d',{p_period:'7d',p_from:null,p_to:null},overview('7d')],
  ['periodo=3m',{p_period:'3m',p_from:null,p_to:null},overview('3m')],['periodo=6m',{p_period:'6m',p_from:null,p_to:null},overview('6m')],['periodo=customizado&de=2026-01-15&ate=2027-01-15',{p_period:'customizado',p_from:'2026-01-15',p_to:'2027-01-15'},overview('customizado','2026-01-15','2027-01-15')]]){
  const h=harness({...result,secret:'PRIVATE',period:{...result.period,actor:'forged'}});const response=await h.handler(request(`/v1/inicio?${query}`),env);
  assert.equal(response.status,200,query);assert.ok(h.calls[1].url.endsWith('/rpc/erp_home_overview'));assert.deepEqual(JSON.parse(h.calls[1].options.body),{...args,p_user_id:user});
  const text=await response.text(),body=JSON.parse(text);assert.doesNotMatch(text,/PRIVATE|forged/);assert.equal(body.period.key,args.p_period);
  assert.equal(body.period.receivable.total_cents,'999999999999999');assert.equal(body.period.points.length,result.period.points.length);
 }
 const plain=harness(base());assert.equal((await plain.handler(request('/v1/inicio'),env)).status,200);assert.ok(plain.calls[1].url.endsWith('/rpc/erp_home_summary'));
});
test('period queries are validated strictly after authentication and never reach the database when invalid',async()=>{
 for(const query of ['periodo=1d','periodo=7D','periodo=HOJE','periodo=30d&periodo=12m','periodo=30d&de=2026-01-01&ate=2026-01-02','periodo=customizado','periodo=customizado&de=2026-01-01',
  'periodo=customizado&de=2026-02-30&ate=2026-03-01','periodo=customizado&de=2026-03-02&ate=2026-03-01','periodo=customizado&de=2026-01-01&ate=2027-01-02','periodo=customizado&de=1899-12-31&ate=1900-01-01',
  'periodo=30d&actor=forged','de=2026-01-01&ate=2026-01-02']){
  const h=harness(overview('30d'));assert.equal((await h.handler(request(`/v1/inicio?${query}`),env)).status,400,query);assert.equal(h.calls.length,1,query);
 }
});
test('period responses that disagree with the request, the business date or the role fail closed',async()=>{
 const check=async(mutate,query='periodo=30d',role='admin')=>{const value=overview('30d');value.role=role;mutate(value);return (await harness(value).handler(request(`/v1/inicio?${query}`),env)).status;};
 assert.equal(await check(v=>{v.period.from='2026-09-21';}),502);
 assert.equal(await check(v=>{v.period.grain='month';}),502);
 assert.equal(await check(v=>{v.period.points.pop();}),502);
 assert.equal(await check(v=>{v.period.points[0].sales_cents='1251';}),502);
 assert.equal(await check(v=>{v.period.points[0].sales_cents=1250;}),502);
 assert.equal(await check(v=>{v.period.receivable.open_cents='1000000000000000';}),502);
 assert.equal(await check(v=>{v.period.sales.count=3;}),502);
 assert.equal(await check(v=>{delete v.period;}),502);
 assert.equal(await check(()=>{},'periodo=12m'),502);
 const consulta=overview('30d');Object.assign(consulta,{role:'consulta'});assert.equal((await harness(consulta).handler(request('/v1/inicio?periodo=30d'),env)).status,502);
 consulta.period.invoices=null;assert.equal((await harness(consulta).handler(request('/v1/inicio?periodo=30d'),env)).status,200);
});
test('shortcuts route reads and saves with a strict body, validated role permissions and replay flags',async()=>{
 const get=harness(favorites({secret:'PRIVATE'}));const response=await get.handler(request('/v1/inicio/atalhos'),env);
 assert.equal(response.status,200);assert.ok(get.calls[1].url.endsWith('/rpc/erp_home_shortcuts_get'));assert.deepEqual(JSON.parse(get.calls[1].options.body),{p_user_id:user});
 const read=await response.json();assert.equal(read.secret,undefined);assert.deepEqual(read.available,allowed('admin'));
 const list=['/financeiro-empresa?area=payable','/estoque-empresa'];
 const save=harness(favorites({version:4,customized:true,shortcuts:list,replayed:false}));
 const saved=await save.handler(request('/v1/inicio/atalhos','POST',{command_id:command.toUpperCase(),expected_version:3,shortcuts:list}),env);
 assert.equal(saved.status,200);assert.ok(save.calls[1].url.endsWith('/rpc/erp_home_shortcuts_save'));
 assert.deepEqual(JSON.parse(save.calls[1].options.body),{p_command_id:command,p_expected_version:3,p_shortcuts:list,p_user_id:user});assert.equal((await saved.json()).replayed,false);
 for(const body of [{command_id:command,expected_version:3,shortcuts:list,actor:'forged'},{command_id:'x',expected_version:3,shortcuts:list},{command_id:command,expected_version:-1,shortcuts:list},
  {command_id:command,expected_version:'3',shortcuts:list},{command_id:command,expected_version:3,shortcuts:['/acesso']},{command_id:command,expected_version:3,shortcuts:[list[0],list[0]]},
  {command_id:command,expected_version:3,shortcuts:Array.from({length:21},()=>list[0])},{command_id:command,expected_version:3},'[]','{"command_id":',`{"command_id":"${command}","expected_version":3,"shortcuts":[],"pad":"${'x'.repeat(9000)}"}`]){
  const h=harness(favorites());assert.equal((await h.handler(request('/v1/inicio/atalhos','POST',body),env)).status,400);assert.equal(h.calls.length,1);
 }
 const plain=harness(favorites());assert.equal((await plain.handler(request('/v1/inicio/atalhos','POST',{command_id:command,expected_version:0,shortcuts:[]},{'Content-Type':'text/plain'}),env)).status,400);
 assert.equal((await plain.handler(request('/v1/inicio/atalhos?x=1'),env)).status,400);
 for(const method of ['PUT','PATCH','DELETE'])assert.equal((await harness(favorites()).handler(request('/v1/inicio/atalhos',method),env)).status,405);
 for(const path of ['/v1/inicio/atalhos/extra','/v1/inicio/atalho'])assert.equal((await harness(favorites()).handler(request(path),env)).status,404);
});
test('shortcut responses with forbidden screens, wrong versions or a different list fail closed; SQL errors map without details',async()=>{
 const list=['/estoque-empresa'],body={command_id:command,expected_version:1,shortcuts:list};
 for(const value of [favorites({role:'financeiro',available:allowed('financeiro'),shortcuts:['/estoque-empresa']}),favorites({available:allowed('vendas')}),favorites({version:1}),favorites({shortcuts:['/acesso']})])
  assert.equal((await harness(value).handler(request('/v1/inicio/atalhos'),env)).status,502);
 for(const value of [favorites({version:3,customized:true,shortcuts:list,replayed:false}),favorites({version:2,customized:true,shortcuts:[],replayed:false}),favorites({version:2,customized:true,shortcuts:list})])
  assert.equal((await harness(value).handler(request('/v1/inicio/atalhos','POST',body),env)).status,502);
 for(const [sql,expected] of [['42501',403],['22023',400],['40001',409],['23505',409]]){
  const h=harness({code:sql,message:'PRIVATE_SQL_PAYLOAD'},400);const response=await h.handler(request('/v1/inicio/atalhos','POST',body),env);
  assert.equal(response.status,expected);assert.doesNotMatch(await response.text(),/PRIVATE_SQL_PAYLOAD/);
 }
});
test('CORS preflight allows GET and POST only on the shortcuts route and keeps the summary GET-only',async()=>{
 const preflight=(path,method)=>new Request(`https://api.example.test${path}`,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}});
 const h=harness(favorites());const response=await h.handler(preflight('/v1/inicio/atalhos','POST'),env);
 assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Methods'),'GET, POST');assert.equal(h.calls.length,0);
 assert.equal((await h.handler(preflight('/v1/inicio/atalhos','DELETE'),env)).status,403);
 assert.equal((await h.handler(preflight('/v1/inicio','POST'),env)).status,403);
 const unauth=request('/v1/inicio/atalhos','POST',{command_id:command,expected_version:0,shortcuts:[]});unauth.headers.delete('Authorization');
 const anonymous=harness(favorites());assert.equal((await anonymous.handler(unauth,env)).status,401);assert.equal(anonymous.calls.length,0);
});
