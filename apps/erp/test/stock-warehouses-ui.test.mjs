import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {resolveMenu,resolvePreferences} from '../src/lib/origin-menu.ts';
import {parseWarehousePage,warehouseSaveBody,warehousesPath} from '../src/lib/stock-warehouses-model.ts';

// Preferências > Suprimentos > Depósitos like Origin (migration 105). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const A='81000000-0000-4000-8000-000000000001',B='81000000-0000-4000-8000-000000000002',C='81000000-0000-4000-8000-000000000003',actor='81000000-0000-4000-8000-000000000009';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
function server({role='estoque',fail=()=>null}={}){
 const calls=[];let rows=[{id:A,name:'Geral',active:true,version:2,is_default:true,ignore_balance:false,setting_version:0},{id:B,name:'Avarias',active:true,version:1,is_default:false,ignore_balance:true,setting_version:1},{id:C,name:'Antigo',active:false,version:3,is_default:false,ignore_balance:false,setting_version:0}];
 let standard={warehouse_id:A,version:1};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:actor}}),
  async stock(path,options={}){calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});const url=new URL(path,'https://synthetic.invalid');
   if(options.method){const problem=fail(path,options);if(problem)throw problem;
    if(path.endsWith('/padrao')){const id=path.split('/').at(-2);standard={warehouse_id:id,version:standard.version+1};rows=rows.map(row=>({...row,is_default:row.id===id}));
     return{scope:'stock_warehouse',data_mode:'erp_native',replayed:false,warehouse:rows.find(row=>row.id===id),receipt:{command_id:options.body.command_id,action:'default',from:{warehouse_id:A,version:1},to:{warehouse_id:id,version:2},saved_at:'2026-10-20T12:00:00Z'}};}
    const created={id:'81000000-0000-4000-8000-000000000004',name:options.body.name,active:true,version:1,is_default:false,ignore_balance:options.body.ignore_balance,setting_version:options.body.ignore_balance?1:0};
    return{scope:'stock_warehouse',data_mode:'erp_native',replayed:false,warehouse:created,receipt:{command_id:options.body.command_id,action:'save',created:true,catalog_changed:true,setting_changed:false,from:{ignore_balance:false},to:{ignore_balance:options.body.ignore_balance},saved_at:'2026-10-20T12:00:00Z'}};}
   const situation=url.searchParams.get('situacao'),q=url.searchParams.get('q')??'';
   const items=rows.filter(row=>(!situation||row.active===(situation==='ativos'))&&row.name.toLowerCase().includes(q.toLowerCase()));
   return{scope:'stock_warehouses',data_mode:'erp_native',page:Number(url.searchParams.get('pagina')??1),size:100,total:items.length,items,default:standard,can_manage:['admin','estoque'].includes(role)};},
  async catalog(path,options={}){calls.push({path,...options});const id=path.split('/').at(-2);rows=rows.map(row=>row.id===id?{...row,active:options.body.active,version:row.version+1}:row);return{entity:'warehouses',record:{id,active:options.body.active},data_mode:'erp_native'};},
 };
 return{calls,controller,writes:()=>calls.filter(call=>call.method)};
}
const mount=(s,options={})=>mountComponent('StockWarehouses.tsx',{controller:s.controller},{location:'/cadastros-reais?cadastro=warehouses',...options});
const rowText=(view,id)=>textOf(view.find(node=>node.type==='tr'&&node.key===id));

test('lists active warehouses by Descrição with "Depósito padrão", the Origin search and the path Preferências › Suprimentos › Depósitos',async()=>{
 const s=server(),view=await mount(s);
 try{
  assert.equal(s.calls[0].path,'/v1/estoque/depositos?situacao=ativos');
  assert.match(view.text(),/PreferênciasSuprimentosDepósitos/);
  assert.equal(rowText(view,A),'GeralDepósito padrão');assert.equal(rowText(view,B),'AvariasSaldo desconsiderado');
  assert.equal(view.nodes().some(node=>node.type==='tr'&&node.key===C),false);
  assert.deepEqual(component(view,'OriginActionsPanel').props.info,[{label:'Quantidade de Depósitos',value:'2'}]);
  assert.equal(component(view,'OriginToolbar').props.searchPlaceholder,'Pesquisar por descrição');
  component(view,'OriginToolbar').props.onSearchChange('ava');await view.flush();component(view,'OriginToolbar').props.onSearch();await view.flush();
  assert.equal(s.calls.at(-1).path,'/v1/estoque/depositos?q=ava&situacao=ativos');assert.deepEqual(component(view,'AppliedChips').props.chips.map(chip=>chip.label),['Situação: Ativos','Pesquisa: ava']);
  component(view,'AppliedChips').props.chips[0].onRemove();await view.flush();assert.equal(s.calls.at(-1).path,'/v1/estoque/depositos?q=ava');
 }finally{view.unmount();}
});

test('Incluir depósito and Editar depósito: Descrição and Desconsiderar saldo in one command; a lost reply resends the same command',async()=>{
 let first=true;const s=server({fail:()=>{if(first){first=false;return new AccessError(503);}return null;}}),view=await mount(s,{expandChildren:['StockWarehousePanel','StockSidePanel']});
 try{
  component(view,'OriginActionsPanel').props.primary.props.onClick();await view.flush();
  assert.match(view.text(),/Incluir depósito/);await view.change('stock-warehouse-name','  Loja  ');await view.change('stock-warehouse-ignore',true);assert.match(view.text(),/Ativado/);
  await view.click('Salvar');assert.match(view.text(),/Não foi possível confirmar o resultado/);assert.equal(view.input('stock-warehouse-name').disabled,true);
  await view.click('Conferir resultado');
  const [one,two]=s.writes();assert.equal(one.path,'/v1/estoque/depositos');assert.equal(one.method,'POST');assert.deepEqual(one.body,two.body);
  const {command_id,...body}=one.body;assert.deepEqual(body,{name:'Loja',ignore_balance:true});assert.match(view.text(),/Depósito Loja salvo\./);
  view.find(node=>node.type==='tr'&&node.key===B).props.onClick();await view.flush();
  assert.match(view.text(),/Editar depósito/);assert.equal(view.input('stock-warehouse-ignore').props.checked,true);
  await view.change('stock-warehouse-ignore',false);await view.click('Salvar');
  const edit=s.writes().at(-1);assert.equal(edit.path,`/v1/estoque/depositos/${B}`);assert.equal(edit.method,'PATCH');
  const {command_id:unused,...patch}=edit.body;assert.deepEqual(patch,{name:'Avarias',ignore_balance:false,expected_version:1,expected_setting_version:1});
 }finally{view.unmount();}
});

test('⋮ Tornar depósito padrão and Inativar/Reativar depósito: the default cannot be inactivated; an unknown result keeps the command',async()=>{
 let lost=true;const s=server({fail:path=>{if(path.endsWith('/padrao')&&lost){lost=false;return new AccessError(503);}return null;}}),view=await mount(s);
 try{
  const menus=()=>view.nodes().filter(node=>typeof node.type==='function'&&node.type.name==='RowMenu');
  const items=label=>menus().find(node=>node.props.label===label).props.items;
  assert.deepEqual(items('Geral').map(item=>[item.label,Boolean(item.disabled),item.title]),[['Inativar depósito',true,'Torne outro depósito padrão antes de inativar este.']]);
  assert.deepEqual(items('Avarias').map(item=>item.label),['Inativar depósito','Tornar depósito padrão']);
  items('Avarias')[1].onClick();await view.flush();
  assert.match(view.text(),/Não foi possível confirmar o resultado/);await view.click('Conferir resultado');
  const [first,second]=s.writes();assert.equal(first.path,`/v1/estoque/depositos/${B}/padrao`);assert.deepEqual(first.body,second.body);assert.equal(first.body.expected_version,1);
  assert.match(view.text(),/Avarias é o depósito padrão\./);assert.equal(rowText(view,B),'AvariasSaldo desconsideradoDepósito padrão');
  items('Geral')[0].onClick();await view.flush();const dialog=component(view,'BatchDialog');assert.equal(dialog.props.title,'Inativar depósito');
  assert.equal(dialog.props.plan.eligible.length,1);await dialog.props.run(dialog.props.plan.eligible[0]);
  const call=s.calls.at(-1);assert.equal(call.path,`/v1/cadastros/warehouses/${A}/active`);assert.equal(call.body.active,false);assert.equal(call.body.expected_version,2);
  dialog.props.onClose([{id:A,label:'Geral',outcome:'ok'}]);await view.flush();assert.equal(view.nodes().some(node=>node.type==='tr'&&node.key===A),false,'reloaded without the inactive warehouse');
 }finally{view.unmount();}
});

test('read-only roles: no Incluir, no ⋮ and a read-only panel; the model refuses mismatched answers',async()=>{
 const s=server({role:'consulta'}),view=await mount(s,{expandChildren:['StockWarehousePanel','StockSidePanel']});
 try{
  assert.equal(component(view,'OriginActionsPanel').props.primary,undefined);assert.equal(view.nodes().some(node=>typeof node.type==='function'&&node.type.name==='RowMenu'),false);
  view.find(node=>node.type==='tr'&&node.key===A).props.onClick();await view.flush();
  assert.equal(view.input('stock-warehouse-name').disabled,true);assert.ok(view.button('Fechar'));assert.equal(view.nodes().some(node=>node.type==='button'&&textOf(node)==='Salvar'),false);
 }finally{view.unmount();}
 const page={scope:'stock_warehouses',data_mode:'erp_native',page:1,size:100,total:1,items:[{id:A,name:'Geral',active:true,version:2,is_default:true,ignore_balance:false,setting_version:0}],default:{warehouse_id:A,version:1},can_manage:true};
 assert.equal(parseWarehousePage(page,{query:'',situation:'ativos'},1).items.length,1);
 for(const bad of[{page:2},{default:{warehouse_id:B,version:1}},{items:[{...page.items[0],active:false}]}])assert.throws(()=>parseWarehousePage({...page,...bad},{query:'',situation:'ativos'},1));
 assert.equal(warehousesPath({query:' Geral ',situation:''},2),'/v1/estoque/depositos?q=Geral&pagina=2');
 assert.throws(()=>warehouseSaveBody('   ',false,null),/Informe a descrição/);
});

test('menu and Preferências: Estoque > Depósitos and Preferências > Suprimentos > Depósitos de estoque open the Origin screen at the published URL',()=>{
 for(const role of['admin','consulta','estoque']){
  const estoque=resolveMenu('real',{role,resources:[]}).find(group=>group.name==='Estoque');
  assert.equal(estoque.columns.flatMap(column=>column.items).find(item=>item.label==='Depósitos').to,'/cadastros-reais?cadastro=warehouses',role);
  assert.ok(resolvePreferences({role}).flatMap(category=>category.entries).some(entry=>entry.label==='Depósitos de estoque'&&entry.to==='/cadastros-reais?cadastro=warehouses'),role);
 }
 for(const role of['vendas','fiscal','financeiro'])assert.equal(resolvePreferences({role}).flatMap(category=>category.entries).some(entry=>entry.to==='/cadastros-reais?cadastro=warehouses'),false,role);
});

test('086 Importar depósitos do Origin stays on the Depósitos screen for administrador, behind the leave guard and a role recheck',async()=>{
 let role='admin',next,opened=0;const s=server({role:'admin'});const controller={...s.controller,getSnapshot:()=>({phase:'ready',membership:{user_id:actor,role}})};
 const view=await mountComponent('StockWarehouses.tsx',{controller,onPrepareWarehouses:()=>opened++},{location:'/cadastros-reais?cadastro=warehouses',ports:{useUnsavedChangesGuard:()=>({confirmLeave:run=>{next=run;}})}});
 try{
  await view.click('Importar depósitos do Origin');assert.equal(opened,0);role='consulta';next();assert.equal(opened,0,'a lost role never navigates');
  role='admin';await view.click('Importar depósitos do Origin');next();assert.equal(opened,1);
 }finally{view.unmount();}
 const reader=await mount(server({role:'estoque'}));try{assert.equal(reader.nodes().some(node=>node.type==='button'&&textOf(node)==='Importar depósitos do Origin'),false);}finally{reader.unmount();}
});
