import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{systemFixture,fails}from'./helpers/system-fixture.mjs';
import{captureBusinessQuery,businessArgs,parseBusinessPanel,BUSINESS_RPC,parseGoals,parseGoalResult,captureGoalSave,captureGoalsQuery}from'../../../packages/erp-domain/src/business-dashboards.mjs';

// One synthetic company: two customers, two products (one with a purchase price), three sales orders in October 2026.
async function company(){
 const f=await systemFixture();
 const a=await f.catalog('contacts',{name:'Cliente Alfa',state:'SP',email:'alfa@sintetico.test',mobile:'11999990000'}),b=await f.catalog('contacts',{name:'Cliente Beta',state:'RJ'});
 const pen=await f.catalog('products',{name:'Caneta azul',code:'CAN-1',unit:'UN',kind:'P',format:'S',price:'3',brand:'Marca X'}),pencil=await f.catalog('products',{name:'Lápis',code:'LAP-1',unit:'UN',kind:'P',format:'S',price:'1'});
 await f.document('purchase_orders',{contact:b.id,date:'2026-10-01',items:[{product_id:pen.id,description:'Caneta azul',quantity:'10',unit_price:'1.25'}]});
 // Before October: Alfa already bought, so Alfa is "recorrente" in October; Beta is "novo".
 await f.document('sales_orders',{contact:a.id,date:'2026-09-20',statuses:['open','verified'],items:[{product_id:pen.id,description:'Caneta azul',quantity:'1',unit_price:'3'}]});
 const o1=await f.document('sales_orders',{contact:a.id,date:'2026-10-10',statuses:['open','verified'],body:{freight:'5'},items:[{product_id:pen.id,description:'Caneta azul',quantity:'2',unit_price:'3'},{product_id:pencil.id,description:'Lápis',quantity:'5',unit_price:'1'}]});
 const o2=await f.document('sales_orders',{contact:b.id,date:'2026-10-12',statuses:['open','in_progress'],items:[{product_id:pen.id,description:'Caneta azul',quantity:'4',unit_price:'2.5'}]});
 await f.document('sales_orders',{contact:b.id,date:'2026-10-13',statuses:['open','cancelled'],items:[{product_id:pen.id,description:'Caneta azul',quantity:'1',unit_price:'3'}]});
 return{...f,a,b,pen,pencil,o1,o2};
}
const S='verified,in_progress,fulfilled';
// 265: the wave E API reads the Previsão de Estoque v2 (p_mode, composição); on the 150 function the contract refuses the answer (the
// documented 502 until 265 is applied), so these older checks read its raw answer.
async function panel(f,name,input,user=f.users.admin){const q=captureBusinessQuery(name,input);
 if(name==='previsao-estoque'){const{p_mode,...args}=businessArgs(q);const raw=await f.rpc(BUSINESS_RPC[name],{p_user_id:user,...args});assert.throws(()=>parseBusinessPanel(raw,q),e=>e.status===502);return raw;}
 return parseBusinessPanel(await f.rpc(BUSINESS_RPC[name],{p_user_id:user,...businessArgs(q)}),q);}

test('150 Mensal: KPIs, daily series, indicators with the last purchase price and the period comparison, all validated by the shared contract',async()=>{const f=await company();try{
 const v=await panel(f,'mensal',{situacoes:S,de:'2026-10-01',ate:'2026-10-31',comparar_de:'2026-09-01',comparar_ate:'2026-09-30'});
 assert.deepEqual(v.kpis.current,{total:'26.00',orders:2,units:'11.000000',ticket:'13.00'});assert.deepEqual(v.kpis.previous,{total:'3.00',orders:1,units:'1.000000',ticket:'3.00'});
 assert.equal(v.daily.current.length,31);assert.equal(v.daily.current[9].total,'16.00');assert.equal(v.daily.previous.length,30);
 // Revenue without freight 21.00; cost = pen 6 units × 1.25 = 7.50; the pencil has no purchase price (one line without cost).
 assert.deepEqual(v.indicators,{revenue_without_freight:'21.00',cost:'7.50',gross_margin:'13.50',gross_margin_pct:'64.29',lines_without_cost:1,taxes:null,fees:null,profit:null});
 assert.deepEqual(v.statuses.map(s=>[s.status,s.orders]),[['verified',1],['in_progress',1],['fulfilled',0]]);
 assert.deepEqual(v.top_skus.map(s=>[s.code,s.units,s.stock,s.forecast_days]),[['CAN-1','6.000000','0.000000',0],['LAP-1','5.000000','0.000000',0]]);
 assert.equal(v.months.at(-1).month,'2026-10');assert.equal(v.annual.orders,3);assert.deepEqual(v.channels,[{channel:'Pedido Manual',orders:2,total:'26.00'}]);
 // Vendas reads sales orders but not purchase orders: no cost, no margin.
 const vendas=await panel(f,'mensal',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'},f.users.vendas);
 assert.equal(vendas.cost_visible,false);assert.equal(vendas.indicators.cost,null);assert.equal(vendas.indicators.gross_margin,null);assert.equal(vendas.kpis.previous,null);
 // Financeiro reads cost but not the stock.
 const finance=await panel(f,'mensal',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'},f.users.financeiro);assert.equal(finance.stock_visible,false);assert.equal(finance.top_skus[0].stock,null);
}finally{await f.close();}});

test('150 Diário, Pedidos de Venda, Vendas por Vendedor and Venda Canal follow the filters exactly',async()=>{const f=await company();try{
 const d=await panel(f,'diario',{situacoes:S,dia:'2026-10-12',comparar:'2026-10-10'});
 assert.deepEqual(d.kpis.current,{total:'10.00',orders:1,units:'4.000000',ticket:'10.00',new_customers:1});assert.equal(d.kpis.previous.new_customers,0);
 const o=await panel(f,'pedidos-venda',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.deepEqual(o.totals,{orders:2,units:'11.000000',total:'26.00',freight:'5.00',ticket:'13.00'});
 assert.deepEqual(o.by_state.map(s=>[s.state,s.total]),[['SP','16.00'],['RJ','10.00']]);
 assert.deepEqual(o.by_product.map(p=>[p.code,p.total,p.cost,p.margin_pct]),[['CAN-1','16.00','7.50','53.13'],['LAP-1','5.00',null,null]]);
 const sp=await panel(f,'pedidos-venda',{situacoes:S,de:'2026-10-01',ate:'2026-10-31',uf:'SP'});assert.equal(sp.totals.orders,1);
 const s=await panel(f,'vendas-vendedor',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.deepEqual(s.by_seller.map(x=>[x.seller,x.orders]),[[null,2]]);assert.equal(s.evolution.length,31);assert.deepEqual(s.sellers,[]);
 const c=await panel(f,'venda-canal',{});assert.equal(c.months.length,24);assert.deepEqual(c.channels,['Pedido Manual']);
 assert.deepEqual(c.filters.statuses,['verified','in_progress','fulfilled'],'Venda Canal uses Configurações Meu negócio');
 // Ajustes: only an administrador changes the finished statuses; Venda Canal follows them.
 await fails(assert,()=>f.preference('meu-negocio',[{key:'negocio.situacoes_finalizado',expected_version:0,value:['fulfilled']}],f.users.vendas),'42501');
 await f.preference('meu-negocio',[{key:'negocio.situacoes_finalizado',expected_version:0,value:['fulfilled','in_progress']}]);
 assert.deepEqual((await panel(f,'venda-canal',{})).filters.statuses,['in_progress','fulfilled']);
}finally{await f.close();}});

test('150 Margem por Pedido, Novos x Recorrentes, Atividade da Carteira, Curva ABC and Previsão de Estoque',async()=>{const f=await company();try{
 const m=await panel(f,'margem-pedido',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.equal(m.indicators.orders,2);assert.equal(m.indicators.orders_without_cost,1);assert.equal(m.indicators.contribution,'5.00');
 assert.deepEqual(m.orders.map(x=>[x.number,x.contribution]),[[f.o2.number,'5.00'],[f.o1.number,null]]);
 assert.equal((await panel(f,'margem-pedido',{situacoes:S,de:'2026-10-01',ate:'2026-10-31',aba:'prejuizo'})).orders.length,0);
 await fails(assert,()=>f.rpc('erp_home_business_margin',{p_user_id:f.users.vendas,p_statuses:['verified'],p_from:'2026-10-01',p_to:'2026-10-31',p_tab:'todos'}),'42501');
 const n=await panel(f,'novos-recorrentes',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.deepEqual([n.cards.novos.customers,n.cards.recorrentes.customers],[1,1]);assert.deepEqual(n.customers.map(c=>[c.name,c.kind]),[['Cliente Alfa','recorrente'],['Cliente Beta','novo']]);
 assert.equal(n.customers[0].mobile,'11999990000');
 const p=await panel(f,'atividade-carteira',{de:'2026-09-01',ate:'2026-10-31',palavras:'alfa'});
 assert.deepEqual(p.customers.map(c=>[c.name,c.orders,c.first_purchase,c.last_purchase,c.cycle_days,c.state,c.email]),[['Cliente Alfa',2,'2026-09-20','2026-10-10',20,'SP','alfa@sintetico.test']]);
 const abc=await panel(f,'curva-abc',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.deepEqual(abc.products.map(x=>[x.code,x.curve,x.cumulative_pct]),[['CAN-1','A','76.19'],['LAP-1','C','100.00']]);assert.deepEqual(abc.counts,{A:1,B:0,C:1});
 assert.equal((await panel(f,'curva-abc',{situacoes:S,de:'2026-10-01',ate:'2026-10-31',marca:'marca x'})).products.length,1);
 const fc=await panel(f,'previsao-estoque',{de:'2026-10-01',ate:'2026-10-31',reserva:'sim'});assert.deepEqual(fc.turnover.map(x=>[x.code,x.sold,x.coverage_days]),[['CAN-1','6.000000',0],['LAP-1','5.000000',0]]);
 await fails(assert,()=>f.rpc('erp_home_business_forecast',{p_user_id:f.users.financeiro,p_from:'2026-10-01',p_to:'2026-10-31',p_warehouse_id:null,p_reserve:false}),'42501');
}finally{await f.close();}});

test('150 inputs are refused before reading; inactive and unknown users read nothing; the RPCs are service-only',async()=>{const f=await company();try{
 for(const args of[{p_statuses:['x'],p_from:'2026-10-01',p_to:'2026-10-31',p_compare_from:null,p_compare_to:null},{p_statuses:['verified','verified'],p_from:'2026-10-01',p_to:'2026-10-31',p_compare_from:null,p_compare_to:null},
  {p_statuses:['verified'],p_from:'2026-10-31',p_to:'2026-10-01',p_compare_from:null,p_compare_to:null},{p_statuses:['verified'],p_from:'2025-01-01',p_to:'2026-10-31',p_compare_from:null,p_compare_to:null},
  {p_statuses:['verified'],p_from:'2026-10-01',p_to:'2026-10-31',p_compare_from:'2026-09-01',p_compare_to:null}])
  await fails(assert,()=>f.rpc('erp_home_business_monthly',{p_user_id:f.users.admin,...args}),'22023');
 for(const user of[f.users.inactive,randomUUID()])await fails(assert,()=>f.rpc('erp_home_business_channels',{p_user_id:user}),'42501');
 const grants=(await f.db.query(`select p.proname,array(select r.rolname from pg_roles r where has_function_privilege(r.oid,p.oid,'execute') and r.rolname in('anon','authenticated','service_role','public') order by 1) roles
  from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'erp_home_business_%' order by 1`)).rows;
 assert.equal(grants.length,13);for(const g of grants)assert.deepEqual(g.roles,['service_role'],g.proname);
 assert.equal(await f.scalar("select count(*)::int v from pg_proc p where p.pronamespace='erp_home'::regnamespace and has_function_privilege('service_role',p.oid,'execute')"),0);
}finally{await f.close();}});

test('150 Metas: administrador creates and edits with CAS, the same command replays, others only read; achieved follows Ajustes',async()=>{const f=await company();try{
 const input={command_id:randomUUID(),goal_id:null,expected_version:0,data:{name:'Meta de outubro',start_on:'2026-10-01',end_on:'2036-09-30',segment:'geral',seller:null,target:'1000',active:true}};
 const sent=captureGoalSave(input),args={p_command_id:sent.command_id,p_goal_id:null,p_expected_version:0,p_data:sent.data};
 await fails(assert,()=>f.rpc('erp_home_business_goal_save',{p_user_id:f.users.vendas,...args}),'42501');
 const saved=parseGoalResult(await f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,...args}),{commandId:sent.command_id,input:sent});
 assert.equal(saved.replayed,false);assert.equal(saved.goal.achieved,'26.00');assert.equal(saved.goal.target,'1000.00');
 assert.equal((await f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,...args})).replayed,true);
 await fails(assert,()=>f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,...args,p_data:{...sent.data,target:'2000'}}),'40001');
 const q=captureGoalsQuery({aba:'andamento'}),list=parseGoals(await f.rpc('erp_home_business_goals',{p_user_id:f.users.vendas,p_tab:'andamento'}),q);
 assert.equal(list.can_manage,false);assert.equal(list.items.length,1);
 const edit={p_command_id:randomUUID(),p_goal_id:saved.goal.id,p_expected_version:1,p_data:{...sent.data,active:false}};
 await fails(assert,()=>f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,...edit,p_expected_version:0}),'22023');
 await fails(assert,()=>f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,...edit,p_expected_version:2}),'40001');
 assert.equal((await f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,...edit})).goal.version,2);
 assert.equal((await f.rpc('erp_home_business_goals',{p_user_id:f.users.admin,p_tab:'inativas'})).items.length,1);
 assert.equal((await f.rpc('erp_home_business_goal_command',{p_user_id:f.users.admin,p_command_id:sent.command_id})).replayed,true);
 await fails(assert,()=>f.rpc('erp_home_business_goal_command',{p_user_id:f.users.other,p_command_id:sent.command_id}),'42501');
 await fails(assert,()=>f.db.query('update erp_home.goal set target=1'),'42501');await fails(assert,()=>f.db.query('delete from erp_home.goal_audit'),'42501');
 assert.equal(await f.scalar('select count(*)::int v from erp_home.goal_audit'),2);
}finally{await f.close();}});

test('150 Configurações Meu negócio is a preferences page generated into migration 150; 115 keeps its block',async()=>{
 const{generatedBlock,committedBlock}=await import('../../../tools/preferences/generate-definitions.mjs');
 assert.equal(await committedBlock('150'),generatedBlock('150'),'run node tools/preferences/generate-definitions.mjs --write');assert.equal(await committedBlock('115'),generatedBlock('115'));
 const f=await systemFixture();try{
  const p=await f.rpc('erp_preferences_page',{p_user_id:f.users.vendas,p_page:'meu-negocio'});
  assert.deepEqual(p.items.map(i=>[i.key,i.value]),[['negocio.situacoes_finalizado',['fulfilled','in_progress','verified']]]);assert.equal(p.can_manage,false);
  assert.equal(await f.scalar("select ordinal v from erp_preferences.page where id='meu-negocio'"),17);
  await fails(assert,()=>f.preference('meu-negocio',[{key:'negocio.situacoes_finalizado',expected_version:0,value:['verified','fulfilled']}]),'22023');
 }finally{await f.close();}
});

test('150 review: Ajustes without any situação falls back to the default instead of breaking the dashboards and Metas',async()=>{const f=await company();try{
 // The page accepts an empty multi (the administrador may unmark everything); the dashboards that read Ajustes keep working.
 await f.preference('meu-negocio',[{key:'negocio.situacoes_finalizado',expected_version:0,value:[]}]);
 assert.deepEqual((await panel(f,'venda-canal',{})).filters.statuses,['verified','in_progress','fulfilled']);
 assert.deepEqual((await panel(f,'previsao-estoque',{de:'2026-10-01',ate:'2026-10-31',reserva:'nao'})).filters.statuses,['verified','in_progress','fulfilled']);
 assert.equal((await panel(f,'atividade-carteira',{de:'2026-09-01',ate:'2026-10-31'})).customers.length,2);
 const sent=captureGoalSave({command_id:randomUUID(),goal_id:null,expected_version:0,data:{name:'Meta sem ajustes',start_on:'2026-10-01',end_on:'2036-09-30',segment:'geral',seller:null,target:'10',active:true}});
 assert.equal(parseGoalResult(await f.rpc('erp_home_business_goal_save',{p_user_id:f.users.admin,p_command_id:sent.command_id,p_goal_id:null,p_expected_version:0,p_data:sent.data}),{commandId:sent.command_id,input:sent}).goal.achieved,'26.00');
 const goals=parseGoals(await f.rpc('erp_home_business_goals',{p_user_id:f.users.admin,p_tab:'andamento'}),captureGoalsQuery({aba:'andamento'}));
 assert.deepEqual(goals.statuses,['verified','in_progress','fulfilled']);assert.equal(goals.items.length,1);
 assert.equal((await panel(f,'mensal',{situacoes:'open',de:'2026-10-01',ate:'2026-10-31'})).goals.length,1);
}finally{await f.close();}});

test('150 review: a huge stock against a tiny sale caps the day counts instead of failing the panel',async()=>{const f=await company();try{
 const warehouse=await f.catalog('warehouses',{name:'Depósito sintético 150'}),bulk=await f.catalog('products',{name:'Granel sintético',code:'GRA-1',unit:'KG',kind:'P',format:'S',price:'1'});
 await f.rpc('erp_stock_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-01',p_reason:'Entrada sintética 150',
  p_items:[{product_id:bulk.id,warehouse_id:warehouse.id,quantity:'999999999',expected_version:0}],p_reference:'REF-150'});
 await f.document('sales_orders',{contact:f.a.id,date:'2026-10-11',statuses:['open','verified'],items:[{product_id:bulk.id,description:'Granel sintético',quantity:'0.001',unit_price:'1'}]});
 const m=await panel(f,'mensal',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.equal(m.top_skus.find(x=>x.code==='GRA-1').forecast_days,2147483647);
 const fc=await panel(f,'previsao-estoque',{de:'2026-10-01',ate:'2026-10-31',reserva:'nao'});
 assert.equal(fc.turnover.find(x=>x.code==='GRA-1').coverage_days,2147483647);
}finally{await f.close();}});

test('150 review: long tables keep the first rows that fit the response bound, in their order',async()=>{const f=await systemFixture();try{
 const list=Array.from({length:2000},(_,i)=>({n:i,name:'Á'.repeat(200),email:`${'x'.repeat(240)}@sintetico.test`}));
 const fit=await f.scalar('select erp_home.biz_fit($1::jsonb,160000) v',[JSON.stringify(list)]);
 assert.ok(fit.length>100&&fit.length<2000,String(fit.length));assert.deepEqual(fit.map(x=>x.n),[...Array(fit.length).keys()]);
 assert.ok(await f.scalar('select octet_length(erp_home.biz_fit($1::jsonb,160000)::text) v',[JSON.stringify(list)])<=160000);
 assert.deepEqual(await f.scalar("select erp_home.biz_fit('[1,2,3]'::jsonb,1000) v"),[1,2,3]);assert.deepEqual(await f.scalar("select erp_home.biz_fit('[]'::jsonb,10) v"),[]);
 // Every long table of the panels goes through the budget.
 const src=await f.scalar("select string_agg(prosrc,' ') v from pg_proc where proname in('erp_home_business_orders','erp_home_business_sellers','erp_home_business_forecast','erp_home_business_margin','erp_home_business_customers','erp_home_business_portfolio','erp_home_business_abc')");
 assert.equal(src.match(/erp_home\.biz_fit\(/g).length,7);
}finally{await f.close();}});
