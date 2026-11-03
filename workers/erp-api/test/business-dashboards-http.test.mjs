import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{captureBusinessQuery,parseBusinessPanel,captureGoalSave,parseGoalResult}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000150',GOAL='30000000-0000-4000-8000-000000000150',COMMAND='20000000-0000-4000-8000-000000000150',STAMP='2026-10-20T12:00:00.000000+00:00';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const days=(from,n)=>Array.from({length:n},(_,i)=>new Date(Date.parse(`${from}T00:00:00Z`)+i*86400000).toISOString().slice(0,10));
const kpis=(total='16.00',orders=1)=>({total,orders,units:'7.000000',ticket:total});
const envelope=(panel,role,filters)=>({scope:'business_dashboard',data_mode:'erp_native',panel,role,as_of:STAMP,business_date:'2026-10-20',cost_visible:['admin','consulta','financeiro','estoque','fiscal'].includes(role),
 stock_visible:['admin','consulta','vendas','estoque','fiscal'].includes(role),filters});
function monthly(role='admin'){
 const cost=role!=='vendas';
 return{...envelope('mensal',role,{statuses:['verified','in_progress'],from:'2026-10-01',to:'2026-10-03',compare_from:null,compare_to:null}),
  kpis:{current:kpis(),previous:null},daily:{current:days('2026-10-01',3).map((day,i)=>({day,orders:i===1?1:0,total:i===1?'16.00':'0.00'})),previous:[]},
  statuses:[{status:'verified',orders:1,total:'16.00'},{status:'in_progress',orders:0,total:'0.00'}],
  indicators:{revenue_without_freight:'11.00',cost:cost?'3.00':null,gross_margin:cost?'8.00':null,gross_margin_pct:cost?'72.73':null,lines_without_cost:cost?1:null,taxes:null,fees:null,profit:null},
  channels:[{channel:'Pedido Manual',orders:1,total:'16.00'}],top_skus:[{product_id:GOAL,code:'CAN-1',name:'Caneta',units:'2.000000',total:'6.00',cost:null,margin_pct:null,stock:role==='financeiro'?null:'4.000000',forecast_days:6}],
  months:['2025-11','2025-12',...Array.from({length:10},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`)].map(month=>({month,total:'0.00'})),
  annual:kpis(),goals:[]};
}

test('150 strict routes: panels are GET-only with their own parameters, metas accepts one POST body',async()=>{
 assert.deepEqual(preferencesMethods('/v1/meu-negocio/mensal'),['GET']);assert.deepEqual(preferencesMethods('/v1/meu-negocio/metas'),['GET','POST']);
 const r=await parse(req('/v1/meu-negocio/mensal?situacoes=fulfilled,verified&de=2026-10-01&ate=2026-10-31'));
 // 229: every panel goes through erp_home_business_panel (Meu Negócio › Dashboard permissions), with the panel arguments inside.
 assert.equal(r.rpc,'erp_home_business_panel');assert.deepEqual({...r.args},{p_panel:'mensal',p_args:{p_statuses:['verified','fulfilled'],p_from:'2026-10-01',p_to:'2026-10-31',p_compare_from:null,p_compare_to:null}});
 assert.deepEqual({...(await parse(req('/v1/meu-negocio/atividade-carteira?de=2026-01-01&ate=2026-10-31&palavras=alfa,beta&dias=30'))).args},{p_panel:'atividade-carteira',p_args:{p_from:'2026-01-01',p_to:'2026-10-31',p_brand:null,p_min_days:30,p_keywords:['alfa','beta']}});
 assert.deepEqual({...(await parse(req('/v1/meu-negocio/venda-canal'))).args},{p_panel:'venda-canal',p_args:{}});
 for(const path of['/v1/meu-negocio/mensal?de=2026-10-01&ate=2026-10-31','/v1/meu-negocio/mensal?situacoes=x&de=2026-10-01&ate=2026-10-31','/v1/meu-negocio/mensal?situacoes=verified,verified&de=2026-10-01&ate=2026-10-31',
  '/v1/meu-negocio/mensal?situacoes=verified&de=2025-01-01&ate=2026-10-31','/v1/meu-negocio/mensal?situacoes=verified&de=2026-10-01&ate=2026-10-31&comparar_de=2026-09-01',
  '/v1/meu-negocio/pedidos-venda?situacoes=verified&de=2026-10-01&ate=2026-10-31&uf=XX','/v1/meu-negocio/previsao-estoque?de=2026-10-01&ate=2026-10-31','/v1/meu-negocio/venda-canal?x=1',
  '/v1/meu-negocio/mensal?situacoes=verified&situacoes=open&de=2026-10-01&ate=2026-10-31','/v1/meu-negocio/metas?aba=todas','/v1/meu-negocio/atividade-carteira?de=2026-01-01&ate=2026-10-31&dias=-1'])
  await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const path of['/v1/meu-negocio/estoque','/v1/meu-negocio','/v1/meu-negocio/metas/comandos/x'])await assert.rejects(()=>parse(req(path)),e=>e.status===404,path);
 await assert.rejects(()=>parse(req('/v1/meu-negocio/mensal',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})),e=>e.status===405);
 const body={command_id:COMMAND,goal_id:null,expected_version:0,data:{name:'Meta',start_on:'2026-10-01',end_on:'2026-10-31',segment:'geral',seller:null,target:'1000.5',active:true}};
 const save=await parse(req('/v1/meu-negocio/metas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));assert.equal(save.mutation,true);assert.equal(save.args.p_panel,'metas_save');assert.equal(save.args.p_args.p_data.target,'1000.5');
 for(const bad of[{...body,goal_id:GOAL},{...body,expected_version:1},{...body,data:{...body.data,segment:'loja'}},{...body,data:{...body.data,segment:'vendedor'}},{...body,data:{...body.data,target:'0'}},
  {...body,data:{...body.data,end_on:'2026-09-30'}},{...body,extra:1}])
  await assert.rejects(()=>parse(req('/v1/meu-negocio/metas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(bad)})),e=>e.status===400,JSON.stringify(bad));
});

test('150 projections fail closed: wrong panel, filters, visibility, totals or extra fields',()=>{
 const q=captureBusinessQuery('mensal',{situacoes:'in_progress,verified',de:'2026-10-01',ate:'2026-10-03'});
 assert.equal(parseBusinessPanel(monthly(),q).kpis.current.total,'16.00');assert.equal(parseBusinessPanel(monthly('vendas'),q).indicators.cost,null);
 for(const mutate of[v=>v.panel='diario',v=>v.filters.from='2026-10-02',v=>v.filters.statuses=['in_progress','verified'],v=>v.cost_visible=false,v=>v.indicators.cost='1',v=>v.kpis.current.total='17.00',
  v=>v.daily.current.pop(),v=>v.extra=1,v=>v.top_skus[0].cost='1.00',v=>v.role='root',v=>v.months.pop(),v=>v.top_skus[0].name=' Caneta']){const v=monthly();mutate(v);assert.throws(()=>parseBusinessPanel(v,q),undefined,String(mutate));}
 const vendas=monthly('vendas');vendas.indicators.cost='3.00';assert.throws(()=>parseBusinessPanel(vendas,q));
 const finance=monthly('financeiro');finance.top_skus[0].stock='1.000000';assert.throws(()=>parseBusinessPanel(finance,q));
 const input=captureGoalSave({command_id:COMMAND,goal_id:null,expected_version:0,data:{name:'Meta',start_on:'2026-10-01',end_on:'2026-10-31',segment:'geral',seller:null,target:'1000.5',active:true}});
 const goal={id:GOAL,name:'Meta',start_on:'2026-10-01',end_on:'2026-10-31',segment:'geral',seller:null,target:'1000.50',achieved:'0.00',active:true,version:1,updated_at:STAMP};
 const result={scope:'business_goal_command',data_mode:'erp_native',receipt:{command_id:COMMAND,goal_id:GOAL,changed_at:STAMP,from_version:0,to_version:1},goal,replayed:false};
 assert.equal(parseGoalResult(result,{commandId:COMMAND,input}).goal.target,'1000.50');
 assert.throws(()=>parseGoalResult({...result,goal:{...goal,target:'1000.00'}},{commandId:COMMAND,input}));assert.throws(()=>parseGoalResult(result,{commandId:COMMAND,lookup:true}));
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-150',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
test('150 composed handler: the panel RPC receives the token actor; upstream errors stay private; an uncertain goal save is ERP_RESULT_UNCONFIRMED',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:monthly());}});
 const r=await h(new Request('https://api.synthetic.test/v1/meu-negocio/mensal?situacoes=verified,in_progress&de=2026-10-01&ate=2026-10-03',{headers}),env);
 assert.equal(r.status,200);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_home_business_panel'));
 assert.deepEqual(JSON.parse(calls[1].o.body),{p_panel:'mensal',p_args:{p_statuses:['verified','in_progress'],p_from:'2026-10-01',p_to:'2026-10-03',p_compare_from:null,p_compare_to:null},p_user_id:ACTOR});
 const denied=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({code:'42501',message:'PRIVATE'},{status:403})});
 const d=await denied(new Request('https://api.synthetic.test/v1/meu-negocio/venda-canal',{headers}),env);assert.equal(d.status,403);assert.doesNotMatch(await d.text(),/PRIVATE/);
 const route=await parse(req('/v1/meu-negocio/metas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command_id:COMMAND,goal_id:null,expected_version:0,data:{name:'Meta',start_on:'2026-10-01',end_on:'2026-10-31',segment:'geral',seller:null,target:'10',active:true}})}));
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw new TypeError('network');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 // A dispatched command whose answer does not validate may have committed: it is uncertain, never "nothing saved".
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>({scope:'business_goal_command'})}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
});
