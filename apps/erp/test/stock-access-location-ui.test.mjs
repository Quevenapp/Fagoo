import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {LOCATION_COLUMN,loadLocations,locationsPath,parseLocations,withLocation,withLocations} from '../src/lib/stock-location-model.ts';
import {REPORTS,reportById} from '../src/lib/stock-reports-model.ts';
import {preferencePage} from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import {storedFields} from '../../../packages/erp-domain/src/preferences/core.mjs';
import {createBusinessFixture} from '../src/qa/business-fixture.ts';

// Estoque lane, wave E (260): the Localização of the product in the extrato and in the Controle de Estoque reports when
// Preferências › Cadastros › Configurações de produtos says so, and the Produtos dashboards behind their Meu Negócio permission.
// Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const P='e2600000-0000-4000-8000-000000000001',Q='e2600000-0000-4000-8000-000000000002',W='e2610000-0000-4000-8000-000000000001',actor='e2620000-0000-4000-8000-000000000001';
const stamp='2026-10-20T12:00:00+00:00';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const preferenceView=(values,role='estoque')=>{const page=preferencePage('cadastros-produtos');return{scope:'preferences_page',data_mode:'erp_native',page:page.id,owner:page.scope,role,can_manage:page.scope==='user'||role==='admin',directory:null,
 items:storedFields(page).map(field=>Object.hasOwn(values,field.key)?{key:field.key,value:values[field.key],version:1,updated_at:stamp}:{key:field.key,value:field.default,version:0,updated_at:null})};};
const locations=(ids,map)=>({scope:'stock_product_locations',data_mode:'erp_native',items:ids.filter(id=>Object.hasOwn(map,id)).map(id=>({product_id:id,location:map[id]}))});

test('260 model: Localização after Un only in the product reports, strict answers and 100 products per request',async()=>{
 const saldos=reportById('saldos'),notas=reportById('notas-operacao'),movement=reportById('movimentacao-produto');
 assert.deepEqual(withLocation(saldos.columns,true).map(column=>column.label),['Código','Descrição','Un','Localização','Saldo']);
 assert.deepEqual(withLocation(saldos.columns,false),saldos.columns);
 assert.deepEqual(withLocation(notas.columns,true),notas.columns,'grouped notes reports have no product per row');
 assert.deepEqual(withLocation(movement.columns,true),movement.columns);
 assert.equal(REPORTS.filter(report=>withLocation(report.columns,true).includes(LOCATION_COLUMN)).length,7,'the seven Controle de Estoque reports with a product per row');
 assert.equal(locationsPath([P,Q]),`/v1/estoque/produtos/localizacoes?ids=${P}%2C${Q}`);
 assert.deepEqual([...parseLocations(locations([P,Q],{[P]:'A-01',[Q]:null}),[P,Q])],[[P,'A-01'],[Q,null]]);
 for(const bad of[{...locations([P],{[P]:'A'}),scope:'other'},{...locations([P],{[P]:'A'}),data_mode:'origin'},{scope:'stock_product_locations',data_mode:'erp_native',items:[{product_id:Q,location:'A'}]},
  {scope:'stock_product_locations',data_mode:'erp_native',items:[{product_id:P,location:1}]},{scope:'stock_product_locations',data_mode:'erp_native',items:[{product_id:P,location:'A'},{product_id:P,location:'B'}]}])
  assert.throws(()=>parseLocations(bad,[P]),/INVALID_LOCATIONS/);
 const ids=Array.from({length:150},(_,n)=>`e2600000-0000-4000-8000-${String(n+1).padStart(12,'0')}`),calls=[];
 const map=await loadLocations({stock:async path=>{calls.push(path);const asked=new URL(path,'https://synthetic.invalid').searchParams.get('ids').split(',');return locations(asked,Object.fromEntries(asked.map(id=>[id,`L-${id.slice(-3)}`])));}},
  [...ids.map(product_id=>({product_id})),{product_id:ids[0]},{product_id:null},{key:'x'}]);
 assert.deepEqual(calls.map(path=>new URL(path,'https://synthetic.invalid').searchParams.get('ids').split(',').length),[100,50],'each product once, 100 per request');
 assert.equal(map.size,150);assert.equal(map.get(ids[149]),'L-150');
 assert.deepEqual(withLocations([{product_id:P,code:'1'},{label:'x'}],new Map([[P,'B-2']])),[{product_id:P,code:'1',location:'B-2'},{label:'x'}]);
});

function reportsServer({values={},hold=()=>null,fail=()=>null,role='estoque'}={}){
 const calls=[];
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:actor}}),async catalog(){return{items:[]};},
  async preferences(path,options={}){calls.push({path,...options});if(path!=='/v1/preferencias/cadastros-produtos')throw new AccessError(404);return preferenceView(values,role);},
  async stock(path,options={}){calls.push({path,...options});const url=new URL(path,'https://synthetic.invalid');const held=hold(path);if(held)await held;const problem=fail(path);if(problem)throw problem;
   if(url.pathname==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/produtos/localizacoes')return locations(url.searchParams.get('ids').split(','),{[P]:'Corredor 3 - Prateleira B',[Q]:null});
   const report=url.pathname.split('/').at(-1);
   return{report,data_mode:'erp_native',scope:'stock_report_balances',filters:{},offset:0,limit:500,total:2,items:[{product_id:P,code:'P-1',name:'Parafuso',unit:'UN',quantity:'4.000000'},{product_id:Q,code:'P-2',name:'Porca',unit:'UN',quantity:'1.000000'}],totals:{quantity:'5.000000'}};}};
 return{calls,controller,located:()=>calls.filter(call=>call.path.startsWith('/v1/estoque/produtos/localizacoes'))};
}
const mountReports=s=>mountComponent('StockReports.tsx',{controller:s.controller},{location:'/relatorios-estoque?relatorio=saldos'});

test('260 relatórios: "Exibir localização nos relatórios de estoque" adds Localização after Un; off, nothing is asked',async()=>{
 const off=reportsServer(),plain=await mountReports(off);
 try{
  await plain.submit(0);
  assert.match(plain.text(),/CódigoDescriçãoUnSaldoP-1ParafusoUN4/);assert.doesNotMatch(plain.text(),/Localização/);
  assert.equal(off.located().length,0);assert.equal(off.calls[0].path,'/v1/preferencias/cadastros-produtos');assert.equal(off.calls[0].method,'GET');
 }finally{plain.unmount();}
 const gate=deferred(),on=reportsServer({values:{'produtos.localizacao_relatorios_estoque':true},hold:path=>path.includes('/localizacoes')?gate.promise:null}),view=await mountReports(on);
 try{
  await view.submit(0);
  assert.match(view.text(),/CódigoDescriçãoUnLocalizaçãoSaldoP-1ParafusoUN…4/,'while the location is read');
  gate.resolve();await view.flush();
  assert.match(view.text(),/CódigoDescriçãoUnLocalizaçãoSaldoP-1ParafusoUNCorredor 3 - Prateleira B4P-2PorcaUN-1TOTAL5/);
  assert.deepEqual(on.located().map(call=>call.path),[locationsPath([P,Q])]);
 }finally{view.unmount();}
});

test('260 relatórios: a failed location read keeps the report and says so; an invalid settings answer keeps the column off',async()=>{
 const s=reportsServer({values:{'produtos.localizacao_relatorios_estoque':true},fail:path=>path.includes('/localizacoes')?new AccessError(502):null}),view=await mountReports(s);
 try{
  await view.submit(0);
  assert.match(view.text(),/Não foi possível consultar a localização dos produtos\./);
  assert.match(view.text(),/UnLocalizaçãoSaldoP-1ParafusoUN-4/);
 }finally{view.unmount();}
 const broken=reportsServer({values:{'produtos.localizacao_relatorios_estoque':true}});broken.controller.preferences=async()=>({scope:'preferences_page'});
 const other=await mountReports(broken);
 try{await other.submit(0);assert.doesNotMatch(other.text(),/Localização/,'an invalid preferences answer keeps the column off');}finally{other.unmount();}
});

function stockServer({values={}}={}){
 const calls=[];const record={id:P,entity:'products',name:'Parafuso',code:'P-1',active:true,kind:'P',format:'S',unit:'UN',version:1,price:'2'};
 const balances=[{warehouse_id:W,warehouse_name:'Geral',warehouse_active:true,quantity:'4.000000',version:1,unit:'UN',warehouse_default:true,warehouse_ignored:false,reserved_quantity:'0.000000'}];
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'consulta',user_id:actor}}),
  async catalog(path){calls.push({path});return{record};},
  async preferences(path,options={}){calls.push({path,...options});return preferenceView(values,'consulta');},
  async stock(path,options={}){calls.push({path,...options});const url=new URL(path,'https://synthetic.invalid'),q=url.searchParams;
   if(url.pathname==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:q.get('warehouse_id'),quantity:'4.000000',sale_value:'8.00',unpriced_products:0,ignored_warehouses:0,warehouses:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/saldos')return{product_id:q.get('product_id'),items:structuredClone(balances),data_mode:'erp_native'};
   if(url.pathname==='/v1/estoque/produtos/localizacoes')return locations(q.get('ids').split(','),{[P]:'Corredor 3'});
   if(url.pathname==='/v1/estoque/reservas')return{scope:'stock_product_reservations',data_mode:'erp_native',product_id:q.get('product_id'),warehouse_id:q.get('warehouse_id'),items:[],total:0,quantity:'0.000000'};
   if(url.pathname==='/v1/estoque/movimentos'){const limit=Number(q.get('limit')),offset=Number(q.get('offset'));
    return{product_id:q.get('product_id'),items:[],limit,offset,total:0,has_more:false,next_offset:null,filters:{warehouse_id:q.get('warehouse_id'),kind:null,origin:null,date_from:null,date_to:null,direction:null},totals:{entries:'0.000000',exits:'0.000000',current_balance:'4.000000',unit:'UN'},data_mode:'erp_native'};}
   throw new AccessError(404);}};
 return{calls,controller,located:()=>calls.filter(call=>call.path.startsWith('/v1/estoque/produtos/localizacoes'))};
}

test('260 extrato: "Exibir localização no controle de estoque" shows the Localização under the product title',async()=>{
 for(const on of[false,true]){
  const s=stockServer({values:on?{'produtos.localizacao_controle_estoque':true}:{}}),view=await mountComponent('RealStock.tsx',{controller:s.controller},{location:`/estoque-empresa?produto=${P}`});
  try{
   await view.flush();
   const heading=textOf(view.find(node=>node.type==='h2'&&textOf(node).startsWith('P-1 - Parafuso')));
   assert.equal(heading,on?'P-1 - Parafuso - Unidade: UNLocalização: Corredor 3':'P-1 - Parafuso - Unidade: UN');
   assert.deepEqual(s.located().map(call=>call.path),on?[locationsPath([P])]:[]);
  }finally{view.unmount();}
 }
});

const permissions=(keys,role='estoque')=>({scope:'access_permissions',data_mode:'erp_native',user_id:actor,role,user_type:'normal',permissions:keys,access:{open:true,until:null}});
test('260 PRF-222 Dashboard produtos: a panel without its Meu Negócio permission is listed disabled and never asked',async()=>{
 const calls=[];
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'estoque',user_id:actor}}),
  async system(path,options={}){calls.push({path,...options});return permissions(['meu_negocio.dashboard','meu_negocio.dashboard.estoque_produtos']);},
  async stock(path,options={}){calls.push({path,...options});const url=new URL(path,'https://synthetic.invalid');
   if(url.pathname==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:1,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
   if(url.pathname==='/v1/estoque/painel/estoque')return{scope:'stock_dashboard_stock',data_mode:'erp_native',page:1,size:100,total:0,filters:{},items:[],totals:{quantity:'0.000000',value:'0.00',unpriced:0},warehouses:[]};
   throw new AccessError(403);}};
 const view=await mountComponent('StockDashboards.tsx',{controller},{location:'/painel-produtos-empresa?painel=sugestao',expandChildren:['StockDashboardsNav']});
 try{
  await view.flush();
  assert.equal(calls[0].path,'/v1/sistema/permissoes');
  assert.ok(view.nodes().some(n=>n.type==='span'&&n.props['aria-disabled']==='true'&&textOf(n)==='Sugestão de Compras'));
  assert.ok(view.nodes().some(n=>n.type==='span'&&n.props['aria-disabled']==='true'&&textOf(n)==='Sem Movimentação'));
  assert.ok(view.nodes().some(n=>n.type==='test-router-link'&&textOf(n)==='Estoque de Produtos'));
  assert.match(view.text(),/Dashboard não liberadoSeu usuário não tem a permissão deste dashboard/);
  assert.equal(calls.some(call=>call.path.startsWith('/v1/estoque/painel/sugestao')),false,'the refused panel is not asked');
 }finally{view.unmount();}
 const f=createBusinessFixture({role:'estoque',before:call=>call.path==='/v1/sistema/permissoes'?permissions(['meu_negocio.dashboard','meu_negocio.dashboard.sem_movimentacao'],'estoque'):undefined});
 const business=await mountComponent('BusinessDashboards.tsx',{controller:f.controller},{location:'/meu-negocio',expandChildren:true});
 try{
  await business.flush();
  assert.ok(business.nodes().some(n=>n.type==='span'&&n.props['aria-disabled']==='true'&&textOf(n)==='Estoque de Produtos'));
  assert.ok(business.nodes().some(n=>n.type==='test-router-link'&&textOf(n)==='Sem Movimentação'));
 }finally{business.unmount();}
});
