import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
const USER='a0000000-0000-4000-8000-000000000001',ID='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const request=(path,extra={})=>new Request(`https://api.example.test${path}`,{headers:{Authorization:'Bearer synthetic-user'},...extra});
function setup(value,status=200){const calls=[];return{calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:value),{status:url.endsWith('/user')?200:status});}})}}
test('finance access authenticates actor server-side, strips unapproved fields and respects CORS',async()=>{
  const {handler,calls}=setup({read:true,write:false,data_mode:'erp_native',private:'not-for-client'});
  assert.equal((await handler(request('/v1/financeiro',{headers:{}}),env)).status,401);assert.equal(calls.length,0);
  const response=await handler(request('/v1/financeiro'),env);assert.equal(response.status,200);assert.deepEqual(await response.json(),{read:true,write:false,data_mode:'erp_native'});
  assert.ok(calls[1].url.endsWith('/rpc/erp_finance_access'));assert.deepEqual(JSON.parse(calls[1].body),{p_user_id:USER});assert.equal(calls[1].headers.Authorization,'Bearer synthetic-service');
  assert.equal((await handler(request('/v1/financeiro/actions/settle',{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}}),env)).status,204);
  assert.equal((await handler(request('/v1/financeiro',{headers:{Origin:'https://evil.example.test'}}),env)).status,403);
});
test('finance RPC conflicts and RBAC failures map to sanitized API errors',async()=>{
  for(const [code,expected]of[['40001',409],['42501',403],['22023',400],['P0002',404]]){
    const {handler}=setup({code,message:'private database error'},400);
    const response=await handler(request('/v1/financeiro'),env);assert.equal(response.status,expected);assert.doesNotMatch(await response.text(),/private database/);
  }
});
test('financial mutation routes reject actor injection and floats before invoking an RPC',async()=>{
  const {handler,calls}=setup({});
  for(const data of [{id:ID,expected_version:1,amount_cents:100,posted_on:'2026-01-01',note:'Synthetic opening'},{id:ID,expected_version:1,amount_cents:'100',posted_on:'2026-01-01',note:'Synthetic opening',p_user_id:ID}]){
    const response=await handler(request('/v1/financeiro/actions/opening',{method:'POST',headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json'},body:JSON.stringify({command_id:ID,data})}),env);assert.equal(response.status,400);
  }assert.ok(calls.every(call=>call.url.endsWith('/auth/v1/user')));
});
test('stock routes reach the protected RPC and return projected balances',async()=>{
  // 145: the balances carry the "Reserva de estoque" settings of Preferências > Suprimentos > Estoque.
  const reservation={by_situation:false,by_warehouse:true,statuses:[],unassigned_quantity:'0.000000'};
  const {handler,calls}=setup({product_id:ID,items:[],reservation,data_mode:'erp_native',private:'hidden'});
  const response=await handler(request(`/v1/estoque/saldos?product_id=${ID}`),env);assert.equal(response.status,200);assert.deepEqual(await response.json(),{product_id:ID,items:[],reservation,data_mode:'erp_native'});
  assert.ok(calls[1].url.endsWith('/rpc/erp_stock_balances'));assert.equal(JSON.parse(calls[1].body).p_user_id,USER);
  assert.equal((await handler(request('/v1/estoque/movimentos',{method:'OPTIONS',headers:{Origin:'https://erp.example.test','Access-Control-Request-Method':'POST'}}),env)).status,204);
  const denied=setup({code:'42501',message:'private'},400);assert.equal((await denied.handler(request(`/v1/estoque/saldos?product_id=${ID}`),env)).status,403);
});
