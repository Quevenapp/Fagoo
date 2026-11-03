import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{parseNotifications,parseExpiring,parseStorage}from'../../../packages/erp-domain/src/system-profile.mjs';
import{parseBusinessPanel,captureBusinessQuery}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{createHandler}from'../src/index.mjs';
import{homeShortcutsOperation,homeShortcutsResponse,HOME_SHORTCUTS}from'../src/home.mjs';
import{companyOperation,companyRoute}from'../src/company.mjs';

// Wave C routes of Preferências, Sistema and Meu Negócio. Synthetic data only.
const ACTOR='10000000-0000-4000-8000-000000000187',P1='30000000-0000-4000-8000-000000000001',STAMP='2026-10-20T12:00:00.000000+00:00';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const expiring=(over={})=>({scope:'product_expiry',data_mode:'erp_native',business_date:'2026-10-20',days:7,total:1,items:[{product_id:P1,code:'QJ-1',name:'Queijo',expiry_date:'2026-10-19',expired:true}],...over});

test('187 GET /v1/sistema/validade: strict route and a closed answer',async()=>{
 assert.deepEqual(preferencesMethods('/v1/sistema/validade'),['GET']);
 const route=await parse(req('/v1/sistema/validade'));assert.equal(route.rpc,'erp_home_expiring');assert.deepEqual({...route.args},{});assert.equal(route.mutation,false);
 await assert.rejects(()=>parse(req('/v1/sistema/validade?dias=3')),e=>e.status===400);
 await assert.rejects(()=>parse(req('/v1/sistema/validade',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})),e=>e.status===405);
 assert.equal(parseExpiring(expiring()).items[0].expired,true);
 for(const mutate of[v=>v.items[0].expired=false,v=>v.items[0].expiry_date='2026-10-28',v=>v.total=2,v=>v.items[0].extra=1,v=>v.days=-1,v=>v.scope='x',v=>v.items[0].product_id='x'])
 {const v=structuredClone(expiring());mutate(v);assert.throws(()=>parseExpiring(v),undefined,String(mutate));}
 const out=await executePreferencesRoute(route,{userId:ACTOR,rpc:async(name,args)=>{assert.equal(name,'erp_home_expiring');assert.deepEqual(args,{p_user_id:ACTOR});return expiring();}});
 assert.equal(out.total,1);
});

test('187 the bell accepts Cliente a ser visitado and Produto com data de validade próxima for the roles that read them',()=>{
 const view=(role,type)=>({scope:'notifications',data_mode:'erp_native',tab:'todas',role,business_date:'2026-10-20',unread:1,items:[{id:'1',type,day:'2026-10-20',quantity:2,amount:null,created_at:STAMP,read:false}]});
 assert.equal(parseNotifications(view('vendas','validade'),{tab:'todas'}).items[0].type,'validade');
 assert.equal(parseNotifications(view('financeiro','cliente_visitado'),{tab:'todas'}).items[0].type,'cliente_visitado');
 assert.throws(()=>parseNotifications(view('financeiro','validade'),{tab:'todas'}),undefined,'financeiro does not read products');
 const amount=view('admin','validade');amount.items[0].amount='1.00';assert.throws(()=>parseNotifications(amount,{tab:'todas'}));
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-187',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
test('187 composed handler binds the token actor to the expiring products read',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:expiring());}});
 const r=await h(new Request('https://api.synthetic.test/v1/sistema/validade',{headers}),env);assert.equal(r.status,200);
 assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_home_expiring'));assert.deepEqual(JSON.parse(calls[1].o.body),{p_user_id:ACTOR});
 const bad=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:{...expiring(),total:9})});
 assert.equal((await bad(new Request('https://api.synthetic.test/v1/sistema/validade',{headers}),env)).status,502);
});

test('188 contracts: IMPOSTOS and LUCRO, Impostos and Margem Contribuição % by channel for cost readers only, and the storage limit',()=>{
 const q=captureBusinessQuery('pedidos-venda',{situacoes:'verified',de:'2026-10-01',ate:'2026-10-31'});
 const panel=(role,channel)=>({scope:'business_dashboard',data_mode:'erp_native',panel:'pedidos-venda',role,as_of:STAMP,business_date:'2026-10-20',cost_visible:role!=='vendas',stock_visible:role!=='financeiro',
  filters:{statuses:['verified'],from:'2026-10-01',to:'2026-10-31',state:null},totals:{orders:1,units:'1.000000',total:'10.00',freight:'0.00',ticket:'10.00'},statuses:[{status:'verified',orders:1,total:'10.00'}],
  by_state:[],by_product:[],by_channel:[{channel:'Pedido Manual',orders:1,ticket:'10.00',units:'1.000000',cost:role==='vendas'?null:'5.00',total:'10.00',freight:'0.00',unit_value:'10.00',margin_pct:role==='vendas'?null:'50.00',taxes:'1.05',fees:null,contribution_pct:role==='vendas'?null:'39.50',...channel}]});
 assert.equal(parseBusinessPanel(panel('admin'),q).by_channel[0].contribution_pct,'39.50');
 assert.equal(parseBusinessPanel(panel('vendas'),q).by_channel[0].taxes,'1.05');
 assert.throws(()=>parseBusinessPanel(panel('vendas',{contribution_pct:'39.50'}),q),undefined,'vendas does not read the cost');
 assert.throws(()=>parseBusinessPanel(panel('admin',{fees:'1.00'}),q),undefined,'no marketplace fees');
 const storage={scope:'storage_usage',data_mode:'erp_native',total_bytes:'10',objects:1,limit_bytes:'2147483648',groups:null,as_of:STAMP};
 assert.equal(parseStorage(storage).limit_bytes,'2147483648');assert.throws(()=>parseStorage({...storage,limit_bytes:'0'}));assert.throws(()=>parseStorage({...storage,limit_bytes:'-1'}));
});

const json=(path,body,method='POST')=>new Request('https://synthetic.invalid'+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const C1='20000000-0000-4000-8000-000000000189';
test('189 strict routes: graficos-inicio, top-produtos and empresa-socios; closed answers',async()=>{
 for(const path of['/v1/sistema/graficos-inicio','/v1/sistema/empresa-socios'])assert.deepEqual(preferencesMethods(path),['GET','POST']);
 assert.deepEqual(preferencesMethods('/v1/sistema/top-produtos'),['GET']);
 assert.equal((await parse(req('/v1/sistema/graficos-inicio'))).rpc,'erp_home_charts_get');assert.equal((await parse(req('/v1/sistema/empresa-socios'))).rpc,'erp_company_partners_get');
 const save=await parse(json('/v1/sistema/graficos-inicio',{command_id:C1,expected_version:2,charts:['top_skus','resumo']}));
 assert.deepEqual({...save.args},{p_command_id:C1,p_expected_version:2,p_charts:['top_skus','resumo']});assert.equal(save.mutation,true);
 for(const body of[{command_id:C1,expected_version:0,charts:['resumo','resumo']},{command_id:C1,expected_version:0,charts:['pizza']},{command_id:C1,expected_version:-1,charts:[]},{command_id:'x',expected_version:0,charts:[]}])
  await assert.rejects(()=>parse(json('/v1/sistema/graficos-inicio',body)),e=>e.status===400,JSON.stringify(body));
 assert.deepEqual({...(await parse(req('/v1/sistema/top-produtos?periodo=customizado&de=2026-10-01&ate=2026-10-20'))).args},{p_period:'customizado',p_from:'2026-10-01',p_to:'2026-10-20'});
 assert.deepEqual({...(await parse(req('/v1/sistema/top-produtos?periodo=7d'))).args},{p_period:'7d',p_from:null,p_to:null});
 for(const path of['/v1/sistema/top-produtos','/v1/sistema/top-produtos?periodo=7D','/v1/sistema/top-produtos?periodo=7d&de=2026-10-01','/v1/sistema/top-produtos?periodo=customizado&de=2026-10-02&ate=2026-10-01'])
  await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 const partners=await parse(json('/v1/sistema/empresa-socios',{command_id:C1,expected_version:0,partners:[{name:'Ana',cpf:'52998224725',share:'50',role:null,email:null,phone:null}]}));assert.equal(partners.rpc,'erp_company_partners_save');
 await assert.rejects(()=>parse(json('/v1/sistema/empresa-socios',{command_id:C1,expected_version:0,partners:[{name:'Ana',cpf:'12345678900',share:null,role:null,email:null,phone:null}]})),e=>e.status===400);
 // Top 5 answers stay in order and inside the period of the request.
 const q={key:'7d',from:null,to:null},top={scope:'home_top_products',data_mode:'erp_native',key:'7d',from:'2026-10-14',to:'2026-10-20',items:[{product_id:P1,code:'A',name:'A',units:'2.000000',total_cents:'100'},{product_id:'30000000-0000-4000-8000-000000000002',code:null,name:'B',units:'3.000000',total_cents:'50'}]};
 const{parseTopProducts}=await import('../../../packages/erp-domain/src/system-profile.mjs');assert.throws(()=>parseTopProducts(top,q),undefined,'quantity order');
 top.items.reverse();assert.equal(parseTopProducts(top,q).items[0].name,'B');
});

test('189 home favorites with names: body with labels only when there is a name, answers checked against the request',async()=>{
 const link='/documentos-empresa?tipo=sales_orders&situacao=open';
 const named=await homeShortcutsOperation(json('/v1/inicio/atalhos',{command_id:C1,expected_version:0,shortcuts:['/estoque-empresa',link],labels:{[link]:'Vendas em aberto'}}),new URLSearchParams());
 assert.deepEqual(named.args.p_labels,{[link]:'Vendas em aberto'});
 const plain=await homeShortcutsOperation(json('/v1/inicio/atalhos',{command_id:C1,expected_version:0,shortcuts:['/estoque-empresa']}),new URLSearchParams());assert.equal('p_labels' in plain.args,false);
 for(const body of[{command_id:C1,expected_version:0,shortcuts:[link],labels:{'/estoque-empresa':'X'}},{command_id:C1,expected_version:0,shortcuts:[link],labels:{[link]:' X'}},
  {command_id:C1,expected_version:0,shortcuts:['/documentos-empresa?tipo=sales_orders&tipo=x']},{command_id:C1,expected_version:0,shortcuts:[],extra:1}])
  await assert.rejects(()=>homeShortcutsOperation(json('/v1/inicio/atalhos',body),new URLSearchParams()),e=>e.status===400,JSON.stringify(body));
 const answer={scope:'home_shortcuts',data_mode:'erp_native',role:'vendas',version:1,customized:true,shortcuts:['/estoque-empresa',link],labels:{[link]:'Vendas em aberto'},available:Object.keys(HOME_SHORTCUTS).filter(p=>HOME_SHORTCUTS[p].includes('vendas')),replayed:false};
 assert.deepEqual(homeShortcutsResponse(answer,named).labels,{[link]:'Vendas em aberto'});
 assert.throws(()=>homeShortcutsResponse({...answer,labels:{}},named),undefined,'the name the command sent');
 const old={...answer};delete old.labels;old.shortcuts=['/estoque-empresa'];assert.deepEqual(homeShortcutsResponse(old,{type:'get'}).labels,{},'before 189 there are no names');
});

test('189 company identity: the correction reason is optional and strict; without it the command is the one of 016',async()=>{
 const data={legal_name:'Empresa Sintética Ltda',trade_name:'Sintética',cnpj:'11222333000181',ie:null,postal_code:'01001000',street:'Rua Sintética',number:'1',complement:null,district:'Centro',city:'São Paulo',municipality_code:'3550308',state:'SP',phone:null,email:null};
 const route=companyRoute('/v1/empresa/identidade');
 const withReason=await companyOperation(json('/v1/empresa/identidade',{command_id:C1,expected_version:1,data,reason:'Contrato social'}),route,new URLSearchParams());assert.equal(withReason.args.p_reason,'Contrato social');
 const without=await companyOperation(json('/v1/empresa/identidade',{command_id:C1,expected_version:1,data}),route,new URLSearchParams());assert.equal('p_reason' in without.args,false);
 for(const reason of['ab',1,'x'.repeat(1001),'linha\nquebrada'])await assert.rejects(()=>companyOperation(json('/v1/empresa/identidade',{command_id:C1,expected_version:1,data,reason}),route,new URLSearchParams()),e=>e.status===400,String(reason));
});
