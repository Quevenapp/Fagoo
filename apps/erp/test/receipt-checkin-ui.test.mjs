import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {matchItems,priceDiffers,receivedInput,stepReceived,verified,itemState,checkinNoteParam} from '../src/lib/receipt-checkin-model.ts';

// Estoque > Check-in de Recebimentos (migration 147). Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const N='81470000-0000-4000-8000-000000000001',O='81470000-0000-4000-8000-000000000002',P='82470000-0000-4000-8000-000000000001',C='83470000-0000-4000-8000-000000000001',actor='84470000-0000-4000-8000-000000000001';
const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const note=(id=N,patch={})=>({invoice_id:id,invoice_version:1,model:'55',issue_type:'T',status:8,series:1,number:id===N?123:456,access_key:null,supplier:{name:'Fornecedor sintético',document:'12345678000190',person_type:'J'},
 issue_date:'2026-10-20',created_at:'2026-10-20T13:00:00Z',items_count:2,checkin_state:'pending',open:true,...patch});
const item=(patch={})=>({position:1,product_id:P,product_code:'SKU-1',product_gtin:'7891000000017',description:'Peça sintética',supplier_code:'F-1',gtin:null,unit:'UN',quantity:'3.0000',unit_price:'10.0000000000',
 received:'0.0000',issue:null,issue_quantity:null,issue_action:null,state:'pending',requested:{quantity:'3.0000',prices:['9.5000000000']},...patch});
const state=(received,quantity,issue)=>issue?'issue':received==='0.0000'?'pending':BigInt(received.replace('.',''))<BigInt(quantity.replace('.',''))?'in_progress':'complete';
function server({role='estoque',fail=()=>null,hold=()=>null,stale=false}={}){
 const calls=[];let version=0,items=[item(),item({position:2,product_id:null,product_code:null,product_gtin:null,description:'Frete sintético',supplier_code:null,quantity:'1.0000',unit_price:'5.0000000000',requested:null})],finished=false,writes=0;
 const view=(id=N)=>{const summary={total:items.length,complete:items.filter(i=>i.state==='complete').length,issue:items.filter(i=>i.issue&&i.issue!=='refused').length,refused:items.filter(i=>i.issue==='refused').length,pending:items.filter(i=>['pending','in_progress'].includes(i.state)).length};
  return{scope:'stock_checkin',data_mode:'erp_native',note:note(id,{checkin_state:version?finished?'finished':'in_progress':'pending'}),checkin:version?{id:C,state:finished?'finished':'in_progress',version,invoice_version:1,stale,started_at:'2026-10-20T13:00:00Z',updated_at:'2026-10-20T13:05:00Z',finished_at:finished?'2026-10-20T14:00:00Z':null}:null,
   version,items:structuredClone(items),summary,events:[],can_manage:role==='estoque'||role==='admin'};};
 const controller={getSnapshot:()=>({phase:'ready',membership:{role,user_id:actor}}),
  async stock(path,options={}){calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});const url=new URL(path,'https://synthetic.invalid');
   const held=hold(path,options);if(held)await held;
   if(url.pathname==='/v1/estoque/checkin/notas')return{scope:'stock_checkin_notes',data_mode:'erp_native',query:url.searchParams.get('q'),offset:Number(url.searchParams.get('offset')??0),limit:50,total:2,can_manage:true,items:[note(N),note(O)]};
   const [,id,segment]=/^\/v1\/estoque\/checkin\/notas\/([0-9a-f-]{36})(?:\/(\w+))?$/.exec(url.pathname);
   if(!options.method)return view(id);
   writes++;const problem=fail(segment,writes);if(problem)throw problem;
   const body=options.body,from=version;
   if(segment==='recebidos')for(const change of body.items){const target=items.find(i=>i.position===change.position);target.received=Number(change.received).toFixed(4);target.state=state(target.received,target.quantity,target.issue);}
   if(segment==='pendencias'){const target=items.find(i=>i.position===body.position);Object.assign(target,{issue:body.kind,issue_quantity:body.quantity===null?null:Number(body.quantity).toFixed(4),issue_action:'none',state:'issue'});}
   if(segment==='lote')for(const position of body.positions){const target=items.find(i=>i.position===position);target.received=target.quantity;target.state=state(target.received,target.quantity,target.issue);}
   if(segment==='finalizacao'){finished=true;version++;}
   version++;
   return{...view(id),receipt:{command_id:body.command_id,action:{recebidos:'save',pendencias:'issue',lote:'batch',reinicio:'restart',finalizacao:'finish'}[segment],invoice_id:id,from_version:from,to_version:version,detail:{},saved_at:'2026-10-20T13:05:00Z'},replayed:false};}};
 return{calls,controller,writes:()=>calls.filter(call=>call.method)};
}
// 259: the Finalizar modal (with "Lançar estoque ao finalizar Check-in") is its own component.
const mount=(s,search='')=>mountComponent('ReceiptCheckin.tsx',{controller:s.controller},{location:`/checkin-recebimentos${search}`,expandChildren:['Modal','StockSidePanel','CheckinFinishModal']});
const field=(view,label)=>view.find(node=>node.type==='input'&&node.props['aria-label']===label);
const press=async(view,label)=>{const node=view.find(n=>n.type==='button'&&n.props['aria-label']===label);if(node.disabled)throw new Error(`Disabled: ${label}`);node.props.onClick();await view.flush();};

test('147 without a note: Aguardando seleção de nota, the Notas cards, and a card opens ?nota=',async()=>{
 const s=server(),view=await mount(s);
 try{
  assert.match(view.text(),/Aguardando seleção de notaNenhuma nota selecionadaSelecione uma nota importada para começar o check-in de recebimentos/);
  assert.match(view.text(),/NFe 123Check-in pendenteFornecedor sintético · 12\.345\.678\/0001-90/);
  assert.equal(view.button('Check-in em lote').disabled,true);
  view.find(n=>n.type==='button'&&n.props.className?.startsWith('checkin-note-card')).props.onClick();await view.flush();
  assert.equal(view.location().search,`?nota=${N}`);
  await view.change('checkin-note-query','NFe 456');await view.submit(0);
  assert.equal(s.calls.at(-1).path,'/v1/estoque/checkin/notas?q=NFe+456');
 }finally{view.unmount();}
});

test('147 Qtde Recebida: stepper and reader change drafts, the guard knows, Salvar alterações sends the exact command',async()=>{
 const s=server(),view=await mount(s,`?nota=${N}`);
 try{
  assert.match(view.text(),/FornecedorFornecedor sintético12\.345\.678\/0001-90Nota fiscal123Série 1/);
  assert.match(view.text(),/Peça sintética.*Preço diferente/,'the note price differs from the purchase order');
  assert.equal(view.button('Salvar alterações').disabled,true);
  await press(view,'Aumentar Peça sintética');await press(view,'Aumentar Peça sintética');
  assert.equal(field(view,'Qtde Recebida de Peça sintética').props.value,'2');assert.equal(view.guard().changed,true);
  await view.change('checkin-item-search','7891000000017');view.input('checkin-item-search').props.onKeyDown({key:'Enter',preventDefault(){}});await view.flush();
  assert.equal(field(view,'Qtde Recebida de Peça sintética').props.value,'3','a reading of the product GTIN adds one unit');
  await view.change('checkin-item-search','0000');view.input('checkin-item-search').props.onKeyDown({key:'Enter',preventDefault(){}});await view.flush();
  assert.match(view.text(),/O produto 0000 não foi localizado\. Insira manualmente a quantidade recebida\./);
  field(view,'Qtde Recebida de Frete sintético').props.onChange({target:{value:'4,5'}});await view.flush();
  assert.match(view.text(),/Frete sintético.*Quantidade maior que a nota/);
  await view.click('Salvar alterações');
  const write=s.writes()[0];assert.equal(write.path,`/v1/estoque/checkin/notas/${N}/recebidos`);
  const {command_id,...body}=write.body;assert.match(command_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(body,{expected_version:0,items:[{position:1,received:'3.0000'},{position:2,received:'4.5000'}]});
  assert.match(view.text(),/Alterações salvas\./);assert.equal(view.guard().changed,false);
  assert.match(view.text(),/Produtos verificados 2 \/ 2/);
 }finally{view.unmount();}
});

test('147 an unknown result keeps the same UUID and body; a later rejection never releases it',async()=>{
 const s=server({fail:(segment,writes)=>writes===1?new AccessError(503):writes===2?new AccessError(409):null}),view=await mount(s,`?nota=${N}`);
 try{
  await press(view,'Aumentar Peça sintética');await view.click('Salvar alterações');
  assert.match(view.text(),/Não foi possível confirmar o resultado/);assert.equal(view.guard().busy,true);
  assert.equal(field(view,'Qtde Recebida de Peça sintética').disabled,true,'the grid is frozen while the result is unknown');
  await view.click('Conferir resultado');assert.ok(view.button('Conferir resultado'),'a 409 after an unknown result keeps the command');
  await view.click('Conferir resultado');assert.match(view.text(),/Alterações salvas\./);
  const bodies=s.writes().map(call=>call.body);assert.deepEqual(bodies[0],bodies[1]);assert.deepEqual(bodies[0],bodies[2]);
 }finally{view.unmount();}
});

test('147 pendência, check-in em lote with "Não mostrar novamente", Finalizar and the read-only states',async()=>{
 const s=server(),view=await mount(s,`?nota=${N}`);
 try{
  await press(view,'Registrar pendência do produto Peça sintética');
  assert.match(view.text(),/Produto com divergência.*produto faltando.*Quantidade faltante.*Gerar crédito para o fornecedor.*Gerar nota de devolução.*Não aplicar nenhuma ação/);
  assert.ok(view.nodes().some(n=>n.type==='input'&&n.props.type==='radio'&&n.props.name==='checkin-issue-action'&&n.props.disabled),'credit and return note are shown disabled');
  await view.change('checkin-issue-quantity','4');await view.submit(1);
  assert.match(view.text(),/Informe uma quantidade maior que zero e até a quantidade da nota\./);assert.equal(s.writes().length,0);
  await view.change('checkin-issue-quantity','1');await view.submit(1);
  assert.deepEqual((({command_id,...rest})=>rest)(s.writes()[0].body),{expected_version:0,position:1,kind:'missing',quantity:'1.0000',action:'none'});
  assert.match(view.text(),/Pendência registrada\./);
  view.find(n=>n.type==='input'&&n.props['aria-label']==='Selecionar Frete sintético').props.onChange();await view.flush();
  await view.click('Check-in em lote');
  assert.match(view.text(),/Todos os produtos da linha selecionada serão marcados como verificados no check-in de recebimentos\./);
  view.find(n=>n.type==='input'&&n.props.type==='checkbox'&&textOf(n)===''&&n.props.onChange&&!n.props['aria-label']).props.onChange({target:{checked:true}});await view.flush();
  await view.click('Confirmar');
  assert.deepEqual(s.writes()[1].body.positions,[2]);
  await view.click('Finalizar');await view.click('Sim');
  assert.equal(s.writes()[2].path,`/v1/estoque/checkin/notas/${N}/finalizacao`);assert.deepEqual((({command_id,...rest})=>rest)(s.writes()[2].body),{expected_version:2});
  assert.match(view.text(),/O check-in foi finalizado e registrado no sistema\./);
  assert.equal(view.button('Salvar alterações').disabled,true);assert.equal(view.button('Finalizar').disabled,true);
  assert.equal(field(view,'Qtde Recebida de Frete sintético').disabled,true);
  await view.click('Resumo de conferências');assert.match(view.text(),/Resumo da conferência.*Conferidos sem pendências.*Frete sintético.*Conferidos com pendências.*produto faltando: 1/);
 }finally{view.unmount();}
 const reader=server({role:'fiscal'}),read=await mount(reader,`?nota=${N}`);
 try{
  assert.equal(read.nodes().some(n=>n.type==='button'&&['Salvar alterações','Finalizar','Reiniciar','Check-in em lote'].includes(textOf(n))),false,'no write control for fiscal');
  assert.equal(field(read,'Qtde Recebida de Peça sintética').disabled,true);assert.match(read.text(),/Somente consulta/);
 }finally{read.unmount();}
 // vendas does not read stock notes; consulta does not see the native notes of the Brufap (113), as in Notas fiscais de entrada.
 for(const role of['vendas','consulta']){
  const other=server({role}),denied=await mount(other);
  try{assert.match(denied.text(),/Check-in não liberado/,role);assert.equal(other.calls.length,0,role);}finally{denied.unmount();}
 }
});

test('147 a late answer of the previous note never shows; a stale check-in only restarts',async()=>{
 const gate=deferred(),s=server({hold:(path,options)=>!options.method&&path===`/v1/estoque/checkin/notas/${N}`?gate.promise:null}),view=await mount(s,`?nota=${N}`);
 try{
  await view.navigate(`/checkin-recebimentos?nota=${O}`);
  assert.match(view.text(),/Nota fiscal456/);
  gate.resolve();await view.flush();
  assert.match(view.text(),/Nota fiscal456/,'the answer of the first note is ignored');
 }finally{view.unmount();}
 const old=server({stale:true}),staleView=await mount(old,`?nota=${N}`);
 try{
  await press(staleView,'Aumentar Peça sintética');await staleView.click('Salvar alterações');
  await staleView.navigate(`/checkin-recebimentos?nota=${N}&x=1`);
  assert.match(staleView.text(),/A nota foi alterada depois do início do check-in/);
  assert.equal(staleView.button('Salvar alterações').disabled,true);assert.equal(staleView.button('Reiniciar').disabled,false);
 }finally{staleView.unmount();}
});

test('147 model: exact four-decimal quantities, readings by code, Preço diferente and the verified count',()=>{
 assert.equal(receivedInput('1,5'),'1.5000');assert.equal(receivedInput('0'),'0.0000');for(const bad of['-1','1.23456','1e3',''])assert.throws(()=>receivedInput(bad));
 assert.equal(stepReceived('0.0000',-1),'0.0000');assert.equal(stepReceived('1.2500',1),'2.2500');
 const items=[item(),item({position:2,description:'Arruela',supplier_code:'AR-9',product_gtin:null,product_code:null,requested:null})];
 assert.equal(matchItems(items,'ar-9').exact.position,2);assert.equal(matchItems(items,'sku-1').exact.position,1);assert.equal(matchItems(items,'arru').exact,null);
 assert.deepEqual(matchItems(items,'peca').filtered.map(i=>i.position),[1],'accents are ignored when filtering by name');
 assert.equal(priceDiffers(items[0]),true);assert.equal(priceDiffers({...items[0],requested:{quantity:'3.0000',prices:['10.0000000000']}}),false);
 assert.equal(itemState(items[0],'3.0000'),'complete');assert.equal(verified(items,{1:'3.0000'}),1);
 assert.equal(checkinNoteParam(`?nota=${N.toUpperCase()}`),N);assert.equal(checkinNoteParam('?nota=x'),null);
});

test('147 a known conflict releases the command and offers to reload the note',async()=>{
 const s=server({fail:()=>new AccessError(409)}),view=await mount(s,`?nota=${N}`);
 try{
  await press(view,'Aumentar Peça sintética');await view.click('Salvar alterações');
  assert.match(view.text(),/O check-in ou a nota foi alterado em outra tela\./);assert.equal(view.guard().busy,false);
  const reads=s.calls.filter(call=>!call.method&&call.path===`/v1/estoque/checkin/notas/${N}`).length;
  await view.click('Recarregar a nota');
  assert.equal(s.calls.filter(call=>!call.method&&call.path===`/v1/estoque/checkin/notas/${N}`).length,reads+1);
  assert.doesNotMatch(view.text(),/alterado em outra tela/);
 }finally{view.unmount();}
});
