import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {STATES} from '../../../packages/erp-domain/src/index.mjs';
const user='a0000000-0000-4000-8000-000000000001',sha='a'.repeat(64);
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const home=()=>({data_mode:'erp_native',as_of:'2026-10-16T12:00:00Z',business_date:'2026-10-16',timezone:'America/Sao_Paulo',role:'admin',catalog:['contacts','products','warehouses'].map(entity=>({entity,active:0,archived:0})),documents:Object.entries(STATES).map(([kind,statuses])=>({kind,count:0,statuses:Object.keys(statuses).map(status=>({status,count:0}))})),stock:{positions:0,positive_positions:0,zero_positions:0,products:0,warehouses:0},finance:{titles:['receivable','payable'].map(kind=>({kind,buckets:['overdue','today','next_7_days','later'].map(bucket=>({bucket,count:0,balance_cents:'0'}))})),accounts:{active:0,archived:0,opening_pending:0,recorded_balance_cents:'0'}}});
const cutover=()=>({data_mode:'cutover_readonly',as_of:'2026-10-16T12:00:00Z',reconciled:false,cutoff_at:null,batches:[],batch_count:0,batches_truncated:false,api:['contacts','products','receivables','payables'].map(entity=>({entity,records:0,native_links:0,pending_candidates:0,oldest_observation:null,newest_observation:null,statuses:[]})),limitations:['CUTOFF_NOT_DEFINED','API_COVERAGE_NOT_CERTIFIED','BACKUP_AND_API_DIFFERENT_TIMES','NO_BANK_BALANCE_RECONSTRUCTION','WAREHOUSE_MAPPING_NOT_DEFINED','NO_OPERATIONAL_EFFECTS']});
const request=(path,method='GET')=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic-token',Origin:'https://erp.example.test'}});
const harness=(result,status=200)=>{const calls=[];return {calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:user,user_metadata:{role:'admin',user_id:'forged'}}):Response.json(result,{status});}})};};
test('home and cutover route only verified actors to fixed read RPCs and strip unapproved fields',async()=>{
 for(const [path,result,rpc]of [['/v1/inicio',home(),'erp_home_summary'],['/v1/preparacao-virada',cutover(),'erp_cutover_summary']]){
  const h=harness({...result,secret:'PRIVATE_SOURCE',actor:'forged'});const response=await h.handler(request(path),env);assert.equal(response.status,200);assert.equal(h.calls.length,2);assert.ok(h.calls[1].url.endsWith(`/rpc/${rpc}`));assert.deepEqual(JSON.parse(h.calls[1].options.body),{p_user_id:user});assert.equal(h.calls[1].options.redirect,'manual');assert.doesNotMatch(await response.text(),/PRIVATE_SOURCE|forged/);
 }
 const path=`/v1/preparacao-virada/${sha}/contacts?limit=25&after=a%3A099&q=100%25`;
 const h=harness({data_mode:'cutover_readonly',as_of:'2026-10-16T12:00:00Z',reconciled:false,cutoff_at:null,backup_sha:sha,entity:'contacts',items:[],limit:25,has_more:false,next_cursor:null});
 assert.equal((await h.handler(request(path),env)).status,200);assert.deepEqual(JSON.parse(h.calls[1].options.body),{p_user_id:user,p_backup_sha:sha,p_entity:'contacts',p_limit:25,p_after:'a:099',p_query:'100%'});
});
test('overview endpoints authenticate before query parsing and never accept writes or identity overrides',async()=>{
 for(const path of ['/v1/inicio','/v1/preparacao-virada']){
  const h=harness(home());const unauth=request(`${path}?actor=forged`);unauth.headers.delete('Authorization');assert.equal((await h.handler(unauth,env)).status,401);assert.equal(h.calls.length,0);
  assert.equal((await h.handler(request(`${path}?actor=forged`),env)).status,400);assert.equal(h.calls.length,1);
  for(const method of ['POST','PATCH','PUT','DELETE'])assert.equal((await h.handler(request(path,method),env)).status,405);
 }
 for(const path of ['/v1/inicio/extra','/v1/inicio-other','/v1/preparacao-virada-other',`/v1/preparacao-virada/${sha}/unknown`])assert.equal((await harness(home()).handler(request(path),env)).status,404);
 const anon=createHandler({fetchImpl:async()=>Response.json({id:user,is_anonymous:true})});assert.equal((await anon(request('/v1/preparacao-virada'),env)).status,403);
});
test('SQL membership denial stays403 despite metadata admin; errors and bad DTOs fail without raw details',async()=>{
 for(const path of ['/v1/inicio','/v1/preparacao-virada'])for(const [sql,expected]of [['42501',403],['22023',400],['P0002',404],['40001',409]]){
  const h=harness({code:sql,message:'PRIVATE_SQL_PAYLOAD'},400);const response=await h.handler(request(path),env);assert.equal(response.status,expected);assert.doesNotMatch(await response.text(),/PRIVATE_SQL_PAYLOAD/);
 }
 for(const [path,value]of [['/v1/inicio',{...home(),role:'vendas'}],['/v1/preparacao-virada',{...cutover(),reconciled:true}]])assert.equal((await harness(value).handler(request(path),env)).status,502);
});
test('overview CORS allows only authenticated GET preflight from configured origin',async()=>{
 for(const path of ['/v1/inicio','/v1/preparacao-virada']){
  const h=harness(home());const req=new Request(`https://api.example.test${path}`,{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization'}});
  const response=await h.handler(req,env);assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Methods'),'GET');assert.equal(h.calls.length,0);
  req.headers.set('Access-Control-Request-Method','POST');assert.equal((await h.handler(req,env)).status,403);req.headers.set('Access-Control-Request-Method','GET');req.headers.set('Origin','https://other.invalid');assert.equal((await h.handler(req,env)).status,403);
 }
});
