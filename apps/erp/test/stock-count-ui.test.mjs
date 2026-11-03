import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {countMultiplier,parseCount,logLine} from '../src/lib/stock-count-model.ts';
import {quantityText} from '../src/lib/stock-model.ts';

// Estoque > Conferência de estoque like Origin (migration 106). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const S='91000000-0000-4000-8000-000000000001',S2='91000000-0000-4000-8000-000000000002',P='92000000-0000-4000-8000-000000000001',Q='92000000-0000-4000-8000-000000000002',W='93000000-0000-4000-8000-000000000001',W2='93000000-0000-4000-8000-000000000002';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const component=(view,name)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const count=(items=[],{id=S,version=1,warehouse=W}={})=>({session:{id,state:'open',version,warehouse_id:warehouse,warehouse_name:warehouse?'Geral':null,created_at:'2026-10-20T12:00:00Z',balance_scope:null,closed_at:null},
 total_read:`${items.reduce((sum,item)=>sum+Number(item.counted),0)}.000000`,readings:items.length,items_total:items.length,items,log:items.map((item,index)=>({id:`94000000-0000-4000-8000-00000000000${index}`,code:item.code,quantity:'1.000000',product_id:item.product_id,product_name:item.name,recorded_at_local:'2026-10-20T09:00:0'+index,deleted:false}))});
const pen={product_id:P,code:'CAN-1',name:'Caneta',location:'A1',unit:'UN',counted:'3.000000',physical:'7.000000',difference:'-4.000000'};
const pencil={product_id:Q,code:'LAP-1',name:'Lápis',location:null,unit:'UN',counted:'1.000000',physical:'0.000000',difference:'1.000000'};
function server({role='estoque',initial=null,fail=()=>null,hold=()=>null}={}){
 const calls=[];let current=initial,session={role};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:session.role,user_id:'95000000-0000-4000-8000-000000000001'}}),
  async stock(path,options={}){calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});
   // 181: the Depósito selector reads the light warehouse list.
   if(path==='/v1/estoque/depositos/opcoes')return{scope:'stock_warehouse_options',data_mode:'erp_native',total:2,items:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:W2,name:'Loja',active:true,is_default:false,ignore_balance:false}]};
   if(path==='/v1/estoque/totais')return{scope:'stock_totals',data_mode:'erp_native',warehouse_id:null,quantity:'0.000000',sale_value:'0.00',unpriced_products:0,ignored_warehouses:0,warehouses:[{id:W,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:W2,name:'Loja',active:true,is_default:false,ignore_balance:false}]};
   if(path==='/v1/estoque/conferencias/atual')return{scope:'stock_count',data_mode:'erp_native',count:current};
   const held=hold(path,options);if(held)await held;
   const problem=fail(path,options,calls.filter(call=>call.method).length);if(problem)throw problem;
   if(path.endsWith('/leituras')){if(options.body.code==='NADA')return{scope:'stock_count',data_mode:'erp_native',outcome:'rejected',reason:'not_found',code:'NADA',count:current,replayed:false};
    const item=options.body.code==='LAP-1'?pencil:pen;current=count([...(current?.items??[]).filter(row=>row.product_id!==item.product_id),item],{warehouse:options.body.warehouse_id});
    return{scope:'stock_count',data_mode:'erp_native',outcome:'read',reason:null,code:options.body.code,session_id:S,count:current,replayed:false};}
   if(path.endsWith('/exclusoes')){current=count(current.items.filter(row=>row.product_id!==options.body.product_id),{warehouse:current.session.warehouse_id});return{scope:'stock_count',data_mode:'erp_native',outcome:'deleted',count:current,replayed:false};}
   if(path.endsWith('/deposito')){current=count(current.items,{version:current.session.version+1,warehouse:options.body.warehouse_id});return{scope:'stock_count',data_mode:'erp_native',outcome:'warehouse',count:current,replayed:false};}
   if(path.endsWith('/reinicio')){current=count([],{id:S2,warehouse:current.session.warehouse_id});return{scope:'stock_count',data_mode:'erp_native',outcome:'restarted',count:current,replayed:false};}
   current=null;return{scope:'stock_count',data_mode:'erp_native',outcome:'balanced',session_id:S,warehouse_id:W,balance_scope:options.body.scope,occurred_on:'2026-10-20',changed:[{product_id:P,name:'Caneta',movement_id:S2,counted:'3.000000',previous:'7.000000'}],unchanged:1,skipped:[],replayed:false};}};
 return{calls,controller,writes:()=>calls.filter(call=>call.method),setRole(role){session={role};}};
}
const mount=(s,options={})=>mountComponent('StockCount.tsx',{controller:s.controller},{location:'/conferencia-estoque-empresa',expandChildren:['StockSidePanel','StockPrintPreview'],...options});
const read=async(view,code)=>{await view.change('stock-count-code',code);await view.submit();};

test('empty count in the depósito padrão; a reading creates the server count with "Quantidade a ser lida"; refusals use Origin words',async()=>{
 const s=server(),view=await mount(s);
 try{
  assert.match(view.text(),/Nenhum item registradoVocê ainda não possui nenhum item registrado, faça a busca de um produto no campo acima\./);
  assert.equal(view.input('stock-count-warehouse').props.value,W);assert.equal(view.input('stock-count-multiplier').props.value,'1');
  await view.change('stock-count-multiplier','3');await read(view,' CAN-1 ');
  const write=s.writes()[0];assert.equal(write.path,'/v1/estoque/conferencias/leituras');const {command_id,...body}=write.body;
  assert.deepEqual(body,{session_id:null,code:'CAN-1',quantity:'3',warehouse_id:W});
  assert.match(textOf(view.find(node=>node.type==='table')),/#ImagemProdutoLocalizaçãoLidosEstoque físico atualDiferençaExcluir leitura1CAN-1 - CanetaA137−4$/,"181: Imagem column of Origin");
  assert.equal(view.input('stock-count-total').props.value,'3');assert.match(view.input('stock-count-log').props.value,/09:00:00 · CAN-1 · 1 · Caneta/);
  await read(view,'NADA');assert.match(view.text(),/Produto Inexistente\. \(NADA\)/);
  await view.change('stock-count-multiplier','0');const writes=s.writes().length;await read(view,'CAN-1');assert.match(view.text(),/Quantidade inválida!/);assert.equal(s.writes().length,writes,'nothing is sent');
 }finally{view.unmount();}
});

test('readings are sent one at a time in order with the session of the previous answer; an unknown result pauses the queue',async()=>{
 const gate=deferred();let holding=true;const s=server({hold:(path,options)=>holding&&options.body?.code==='CAN-1'?gate.promise:null}),view=await mount(s);
 try{
  await read(view,'CAN-1');await read(view,'LAP-1');assert.equal(s.writes().length,1,'the second reading waits');assert.match(view.text(),/1 leitura\(s\) aguardando para salvar/);
  holding=false;gate.resolve();await view.flush();
  assert.equal(s.writes().length,2);assert.equal(s.writes()[1].body.session_id,S,'the queued reading uses the count just created');
  assert.equal(component(view,'StockSidePanel'),undefined);
 }finally{view.unmount();}
 let first=true;const lost=server({fail:path=>{if(path.endsWith('/leituras')&&first){first=false;return new AccessError(503);}return null;}}),again=await mount(lost);
 try{
  await read(again,'CAN-1');assert.match(again.text(),/Não foi possível confirmar o resultado/);assert.equal(again.input('stock-count-code').disabled,true);
  await again.click('Conferir resultado');const [one,two]=lost.writes();assert.deepEqual(one.body,two.body,'same UUID and body');assert.match(textOf(again.find(node=>node.type==='table')),/CAN-1 - Caneta/);
 }finally{again.unmount();}
});

test('excluir leitura and reiniciar ask Sim/Não; the depósito change is versioned',async()=>{
 const s=server({initial:count([pen,pencil])}),view=await mount(s,{expandChildren:['StockSidePanel','StockPrintPreview','Modal']});
 try{
  view.find(node=>node.type==='button'&&node.props['aria-label']==='Excluir leitura Lápis').props.onClick();await view.flush();
  assert.match(view.text(),/Você tem certeza que deseja excluir a leitura Lápis\?/);await view.click('Sim');
  assert.deepEqual(s.writes().at(-1).path,`/v1/estoque/conferencias/${S}/exclusoes`);assert.equal(s.writes().at(-1).body.product_id,Q);assert.doesNotMatch(textOf(view.find(node=>node.type==='table')),/Lápis/);
  await view.change('stock-count-warehouse',W2);const change=s.writes().at(-1);assert.equal(change.path,`/v1/estoque/conferencias/${S}/deposito`);assert.deepEqual([change.body.expected_version,change.body.warehouse_id],[1,W2]);
  await view.change('stock-count-warehouse','');assert.equal(s.writes().at(-1).body.warehouse_id,null,'"Todos"');
  await view.click('Reiniciar');assert.match(view.text(),/Você tem certeza que deseja reiniciar a conferência de estoque\?/);await view.click('Sim');
  assert.equal(s.writes().at(-1).path,`/v1/estoque/conferencias/${S}/reinicio`);assert.match(view.text(),/Nenhum item registrado/);
 }finally{view.unmount();}
});

test('Gerar balanço: one warehouse and one reading required; "Todos os produtos ativos" needs the confirmation; report after success',async()=>{
 const none=server(),empty=await mount(none);
 try{await empty.click('Gerar balanço');assert.match(empty.text(),/Nenhuma leitura foi efetuada\./);}finally{empty.unmount();}
 const all=server({initial:count([pen],{warehouse:null})}),wide=await mount(all);
 try{await wide.click('Gerar balanço');assert.match(wide.text(),/Selecione apenas um depósito para gerar o balanço\./);assert.equal(component(wide,'StockSidePanel'),undefined);}finally{wide.unmount();}
 const s=server({initial:count([pen])}),view=await mount(s);
 try{
  await view.click('Gerar balanço');assert.match(view.text(),/Gerar balanço para:Apenas produtos conferidosTodos os produtos ativos cadastrados/);
  assert.match(view.text(),/Essa opção irá gerar balanço APENAS PARA OS PRODUTOS CONFERIDOS com as suas quantidades lidas\. Depósito: Geral\./);
  await view.change('stock-count-scope','all_active');assert.match(view.text(),/Para os produtos não conferidos, a quantidade em estoque atual será ZERADA\./);
  const button=()=>view.nodes().filter(node=>node.type==='button'&&textOf(node)==='Gerar balanço').at(-1);
  assert.equal(button().disabled,true,'"Estou ciente…" is required');
  await view.change('stock-count-aware',true);await view.change('stock-count-print',true);button().props.onClick();await view.flush();
  const write=s.writes().at(-1);assert.equal(write.path,`/v1/estoque/conferencias/${S}/balanco`);const {command_id,...body}=write.body;assert.deepEqual(body,{expected_version:1,scope:'all_active',confirmed:true});
  assert.match(view.text(),/Balanço gerado com sucesso\./);assert.match(view.text(),/1 produto\(s\) com balanço lançado, 1 sem diferença/);
  assert.match(view.text(),/Relatório de conferência de estoque.*DepósitoGeral.*Todos os produtos ativos cadastrados.*CAN-1 - CanetaA137−4/);
 }finally{view.unmount();}
});

test('a role change hides the count and sends nothing; the model keeps exact strings',async()=>{
 const s=server({initial:count([pen])}),view=await mount(s);
 try{
  s.setRole('consulta');await view.updateProps({});
  const section=view.find(node=>node.type==='section'&&node.props.className==='stock-count');assert.equal(section.props.hidden,true);assert.equal(section.props.inert,true);
  assert.match(view.text(),/Conferência de estoque não liberada/);
  const before=s.calls.length;view.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await view.flush();assert.equal(s.calls.length,before);
 }finally{view.unmount();}
 const blocked=server({role:'vendas'}),closed=await mount(blocked);
 try{assert.match(closed.text(),/Conferência de estoque não liberada/);assert.equal(blocked.calls.length,0);}finally{closed.unmount();}
 assert.equal(countMultiplier('2,5'),'2.5');for(const value of['0','-1','1.1234567','x'])assert.throws(()=>countMultiplier(value),/Quantidade inválida!/);
 assert.throws(()=>parseCount({...count([pen]),items:[{...pen,difference:'-3.000000'}]}));
 assert.equal(logLine({id:S,code:'CAN-1',quantity:'2.500000',product_id:P,product_name:'Caneta',recorded_at_local:'2026-10-20T09:01:02',deleted:true},quantityText),'09:01:02 · CAN-1 · 2,5 · Caneta (excluída)');
});

test('menu: Estoque > Conferência de estoque opens the real screen for administrador and estoque only',async()=>{
 const {resolveMenu}=await import('../src/lib/origin-menu.ts');
 const entry=role=>resolveMenu('real',{role,resources:[]}).find(group=>group.name==='Estoque')?.columns.flatMap(column=>column.items).find(item=>item.label==='Conferência de estoque');
 for(const role of['admin','estoque'])assert.equal(entry(role).to,'/conferencia-estoque-empresa',role);
 for(const role of['consulta','vendas','fiscal'])assert.equal(entry(role)?.disabled??true,true,role);
});
