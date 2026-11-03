import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {actor,record} from './helpers/document-commercial-fixtures.mjs';
import {createStockAvailabilityFixture,stockAvailabilityIds as stockIds} from '../src/qa/stock-availability-fixture.ts';

// Synthetic data only. The harness runs the real handlers without a DOM.
const created='e0000000-0000-4000-8000-000000000054',otherActor='e0000000-0000-4000-8000-000000000055',warehouse='e0000000-0000-4000-8000-000000000056';
const productIds=['e0000000-0000-4000-8000-000000000061','e0000000-0000-4000-8000-000000000062','e0000000-0000-4000-8000-000000000063'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const node=(view,name,predicate=()=>true)=>view.nodes().find(n=>typeof n.type==='function'&&n.type.name===name&&predicate(n));
const picker=(view,entity)=>node(view,'CatalogPicker',n=>n.props.entity===entity);
const quantity=(view,index)=>view.find(n=>n.type==='input'&&n.props['aria-label']===`Quantidade do item ${index}`).props.value;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function withDocument(){const previous=globalThis.document;globalThis.document={activeElement:null,addEventListener(){},removeEventListener(){}};return()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;};}
const contactRecord=(extra={})=>({id:created,entity:'contacts',version:1,active:true,name:'Cliente rápido fictício',code:null,person_type:'F',document:'529.982.247-25',roles:['customer'],source:null,created_at:'2026-10-19T12:00:00Z',updated_at:'2026-10-19T12:00:00Z',...extra});
const productRow=(id,extra={})=>({id,entity:'products',version:1,active:true,name:`Produto ${id.slice(-2)}`,code:null,gtin:null,unit:'UN',kind:'P',price:'2.5000',source:null,...extra});

function setup({role='vendas',kind='sales_proposals',access={read:['contacts','products','warehouses'],write:['contacts']},onPost=()=>{throw new AccessError(500);},onRead=()=>({entity:'contacts',record:contactRecord(),data_mode:'erp_native'})}={}){
 let session={phase:'ready',membership:{role,user_id:actor}},saved=null;
 const calls=[],documents=[];
 const controller={getSnapshot:()=>session,
  async catalog(path,options={}){
   calls.push({path,method:options.method??'GET',body:options.body===undefined?undefined:structuredClone(options.body)});
   if(path==='/v1/cadastros')return{...access,data_mode:'erp_native'};
   if(options.method==='POST')return onPost(calls.filter(call=>call.method==='POST').length,options.body);
   // Contatos onda C: the picker searches the contacts picker and reads the summary of the chosen contact.
   if(path.startsWith('/v1/cadastros/contatos/opcoes'))return{scope:'contact_options',role:null,limit:25,scoped:false,has_more:false,items:[],data_mode:'erp_native'};
   if(/^\/v1\/cadastros\/contatos\/[^/]+\/resumo$/.test(path))return{scope:'contact_summary',id:path.split('/')[4],name:'Contato fictício',code:null,situation:'A',notes:null,contact_info:null,persons:[],data_mode:'erp_native'};
   if(path.startsWith('/v1/cadastros/contatos/'))return onRead(path);
   throw new Error(`Unexpected catalog path ${path}`);
  },
  async documents(path,options={}){
   documents.push({path,method:options.method??'GET',body:options.body===undefined?undefined:structuredClone(options.body)});
   if(options.method)saved=options.body.data;
   return{kind,document:record(kind,saved,2),data_mode:'erp_native',operational_effects:false};
  }};
 return{controller,calls,documents,setSession(next){session=next;}};
}
const modalCancel=async view=>{const found=view.nodes().filter(n=>n.type==='button'&&n.props.className==='secondary-button'&&(Array.isArray(n.props.children)?n.props.children.join(''):n.props.children)==='Cancelar').at(-1);if(!found||found.disabled)throw new Error('Missing modal Cancelar');found.props.onClick?.({preventDefault(){}});await view.flush();};
const mountEditor=(controller,kind='sales_proposals',extra={})=>mountComponent('RealDocuments.tsx',{controller,kind,record:record(kind),writable:true,onSaved(){},onClose(){},onConverted(){},...extra},{componentName:'Editor',expandChildren:['DocumentQuickContact','Modal']});

test('Contato rápido creates the customer once, recovers a lost answer and selects it without losing unsaved edits',async()=>{
 const restore=withDocument();
 const s=setup({onPost:count=>{if(count===1)throw new AccessError(503);return{entity:'contacts',record:contactRecord(),data_mode:'erp_native',replayed:true};},
  onRead:path=>{assert.equal(path,`/v1/cadastros/contatos/${created}`);return{entity:'contacts',record:contactRecord(),data_mode:'erp_native'};}});
 const view=await mountEditor(s.controller);
 try{
  await view.change('doc-notes','Observação ainda não salva');
  assert.equal(typeof picker(view,'contacts').props.onCreate,'function');
  picker(view,'contacts').props.onCreate('Cliente rápido fictício');await view.flush();
  assert.match(view.text(),/Contato rápido/);
  assert.equal(view.input('quick-contact-name').props.value,'Cliente rápido fictício');
  const customer=view.input('quick-contact-role-customer');assert.equal(customer.props.checked,true);assert.equal(customer.props.disabled,true);
  assert.equal(view.input('quick-contact-role-supplier').props.checked,false);
  await view.change('quick-contact-person-type','F');assert.equal(view.text().includes('CPF'),true);
  await view.change('quick-contact-document','529.982.247-24');await view.submit(1);
  assert.match(view.text(),/Erro ao salvar! Verifique o\(s\) campo\(s\) em destaque, antes de salvar\. Informe um CPF válido/);
  assert.equal(view.input('quick-contact-document').props['aria-invalid'],true);
  assert.equal(s.calls.filter(call=>call.method==='POST').length,0);
  await view.change('quick-contact-document','529.982.247-25');await view.change('quick-contact-phone','(11) 0000-0000');await view.submit(1);
  assert.match(view.text(),/Use “Conferir resultado” para repetir a mesma operação sem duplicar o contato/);
  assert.equal(view.input('quick-contact-name').disabled,true,'the retried body stays frozen');
  assert.equal(view.guard().changed,true);
  await view.click('Conferir resultado');
  const posts=s.calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);
  assert.equal(posts[0].path,'/v1/cadastros/contatos');assert.match(posts[0].body.command_id,UUID);
  assert.deepEqual(Object.keys(posts[0].body).sort(),['command_id','data']);
  assert.deepEqual(posts[0].body.data.types,['customer']);assert.equal(posts[0].body.data.roles,undefined);assert.equal(posts[0].body.data.situation,'A');assert.equal(posts[0].body.data.taxpayer,'9');assert.equal(posts[0].body.data.person_type,'F');assert.equal(posts[0].body.data.document,'529.982.247-25');assert.equal(posts[0].body.data.phone,'(11) 0000-0000');assert.equal(posts[0].body.data.city,null);
  assert.equal(s.calls.filter(call=>call.path===`/v1/cadastros/contatos/${created}`).length,1,'the replay is followed by a fresh read');
  assert.equal(view.nodes().some(n=>n.props?.id==='quick-contact-form'),false);
  assert.deepEqual(picker(view,'contacts').props.selected,{id:created,name:'Cliente rápido fictício'});
  assert.match(picker(view,'contacts').props.status,/Contato Cliente rápido fictício cadastrado e selecionado/);
  assert.equal(view.input('doc-notes').props.value,'Observação ainda não salva');
  await view.submit(0);
  const write=s.documents.find(call=>call.method==='PATCH');
  assert.equal(write.body.data.contact_id,created);assert.equal(write.body.data.notes,'Observação ainda não salva');assert.equal(write.body.expected_version,1);assert.equal(write.body.data.items[0].description,'Item sintético');
 }finally{view.unmount();restore();}
});

test('Contato rápido follows the document type, refuses known errors and never selects after a session change',async()=>{
 const restore=withDocument();
 try{
  for(const [role,write] of [['estoque',[]],['estoque',['contacts']],['consulta',[]]]){
   const s=setup({role,kind:'purchase_orders',access:{read:['contacts','products','warehouses'],write}});const view=await mountEditor(s.controller,'purchase_orders',{record:null});
   try{assert.equal(picker(view,'contacts').props.onCreate,undefined,role);assert.equal(picker(view,'contacts').props.label,'Fornecedor *');}finally{view.unmount();}
  }
  const readOnly=setup({role:'vendas'}),closed=await mountEditor(readOnly.controller,'sales_proposals',{writable:false});
  try{assert.equal(picker(closed,'contacts').props.disabled,true);picker(closed,'contacts').props.onCreate('Nome');await closed.flush();assert.equal(closed.nodes().some(n=>n.props?.id==='quick-contact-form'),false);}finally{closed.unmount();}

  let s=setup({role:'admin',kind:'purchase_orders',onPost:count=>{if(count===1)throw new AccessError(403);return{entity:'contacts',record:contactRecord({roles:['supplier']}),data_mode:'erp_native'};}});
  // A new purchase order: an open saved one waits for its receipts panel before editing.
  let view=await mountEditor(s.controller,'purchase_orders',{record:null});
  try{
   picker(view,'contacts').props.onCreate('11.222.333/0001-81');await view.flush();
   assert.equal(view.input('quick-contact-document').props.value,'11.222.333/0001-81');assert.equal(view.input('quick-contact-person-type').props.value,'J');
   assert.equal(view.input('quick-contact-role-supplier').props.disabled,true);
   await view.change('quick-contact-name','Fornecedor rápido fictício');await view.submit(1);
   assert.match(view.text(),/Seu perfil não permite cadastrar contatos/);assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.children==='Conferir resultado'),false);
   assert.equal(view.input('quick-contact-name').disabled,false);
   await view.submit(1);
   const posts=s.calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);assert.notEqual(posts[0].body.command_id,posts[1].body.command_id);assert.deepEqual(posts[1].body.data.types,['supplier']);
   assert.equal(picker(view,'contacts').props.selected.id,created);
  }finally{view.unmount();}

  s=setup({role:'vendas',onPost:()=>{s.setSession({phase:'ready',membership:{role:'vendas',user_id:otherActor}});return{entity:'contacts',record:contactRecord(),data_mode:'erp_native'};}});
  view=await mountEditor(s.controller);
  try{
   const before=picker(view,'contacts').props.selected;picker(view,'contacts').props.onCreate('Cliente de outra sessão');await view.flush();await view.submit(1);
   assert.match(view.text(),/a sessão ou o perfil mudou/);assert.deepEqual(picker(view,'contacts').props.selected,before);
   await view.submit(1);assert.equal(s.calls.filter(call=>call.method==='POST').length,1,'the other session cannot reuse the dialog');
   assert.equal(view.input('quick-contact-name').disabled,true,'a created contact is never saved again');assert.equal(view.guard().changed,false);
   await view.click('Fechar');assert.equal(view.nodes().some(n=>n.props?.id==='quick-contact-form'),false);assert.equal(view.guard().changed,false);
  }finally{view.unmount();}
 }finally{restore();}
});

test('Contato rápido re-reads a created contact without posting again and never saves a created contact twice',async()=>{
 const restore=withDocument();
 try{
  let reads=0;
  const s=setup({onPost:()=>({entity:'contacts',record:contactRecord(),data_mode:'erp_native'}),onRead:()=>{reads++;if(reads===1)throw new AccessError(503);return{entity:'contacts',record:contactRecord(),data_mode:'erp_native'};}});
  let view=await mountEditor(s.controller);
  try{
   picker(view,'contacts').props.onCreate('Cliente rápido fictício');await view.flush();await view.submit(1);
   assert.match(view.text(),/O contato foi cadastrado, mas a versão atual não pôde ser consultada/);assert.equal(view.guard().changed,true);
   await view.click('Conferir resultado');
   assert.equal(s.calls.filter(call=>call.method==='POST').length,1,'the retry only reads the created contact');assert.equal(reads,2);
   assert.deepEqual(picker(view,'contacts').props.selected,{id:created,name:'Cliente rápido fictício'});
  }finally{view.unmount();}
  const inactive=setup({onPost:()=>({entity:'contacts',record:contactRecord(),data_mode:'erp_native'}),onRead:()=>({entity:'contacts',record:contactRecord({active:false,version:2}),data_mode:'erp_native'})});
  view=await mountEditor(inactive.controller);
  try{
   const before=picker(view,'contacts').props.selected;
   picker(view,'contacts').props.onCreate('Cliente rápido fictício');await view.flush();await view.submit(1);
   assert.match(view.text(),/O contato foi cadastrado, mas já está inativo/);assert.deepEqual(picker(view,'contacts').props.selected,before);
   assert.equal(view.nodes().some(n=>n.type==='button'&&n.props.form==='quick-contact-form'),false,'no Salvar after the contact exists');
   assert.equal(view.input('quick-contact-name').disabled,true);
   await view.submit(1);assert.equal(inactive.calls.filter(call=>call.method==='POST').length,1,'a created contact is never posted again');
   assert.equal(view.guard().changed,false);
   await view.click('Fechar');assert.equal(view.nodes().some(n=>n.props?.id==='quick-contact-form'),false);
  }finally{view.unmount();}
 }finally{restore();}
});

test('Contato rápido asks before discarding typed data and leaves a notice after an unconfirmed result',async()=>{
 const restore=withDocument();
 const s=setup({onPost:()=>{throw new AccessError(503);}}),view=await mountEditor(s.controller),open=()=>view.nodes().some(n=>n.props?.id==='quick-contact-form');
 try{
  picker(view,'contacts').props.onCreate('');await view.flush();
  await modalCancel(view);assert.equal(open(),false,'an untouched form closes at once');
  picker(view,'contacts').props.onCreate('');await view.flush();
  await view.change('quick-contact-name','Cliente digitado');assert.equal(view.guard().changed,true);
  await modalCancel(view);
  assert.equal(open(),true,'typed data is not dropped by Cancelar, Escape or a click outside');assert.match(view.text(),/Os dados digitados no contato rápido ainda não foram salvos/);
  await view.click('Continuar no cadastro');assert.equal(open(),true);assert.equal(view.input('quick-contact-name').props.value,'Cliente digitado');assert.doesNotMatch(view.text(),/ainda não foram salvos/);
  await modalCancel(view);await view.click('Descartar');assert.equal(open(),false);assert.equal(view.guard().changed,false);
  picker(view,'contacts').props.onCreate('');await view.flush();await view.change('quick-contact-name','Cliente incerto');
  await modalCancel(view);assert.match(view.text(),/ainda não foram salvos/);
  await view.submit(1);
  assert.match(view.text(),/Use “Conferir resultado”/);assert.equal(view.guard().changed,true);
  assert.doesNotMatch(view.text(),/ainda não foram salvos/,'saving withdraws the discard question');assert.throws(()=>view.button('Descartar'));
  await modalCancel(view);assert.equal(open(),false,'an unconfirmed result closes without a second question');
  assert.match(picker(view,'contacts').props.status,/O resultado do cadastro rápido não foi confirmado\. Pesquise o contato pelo nome ou CPF\/CNPJ/);
  assert.equal(view.guard().changed,false);assert.equal(s.documents.length,0);
 }finally{view.unmount();restore();}
});

test('code entry adds quantity 1, then adds 1 to the same line; refusals leave the items untouched',async()=>{
 const s=setup({role:'vendas'}),view=await mountEditor(s.controller);
 try{
  const row=productRow(productIds[0],{code:'LIDO-1',gtin:'7890000000017'}),products=()=>picker(view,'products');
  assert.equal(products().props.stockWarehouse,null,'no depósito: the picker shows the total stock');
  assert.match(products().props.onCode(row),/Produto 61 incluído com quantidade 1/);await view.flush();
  assert.equal(quantity(view,2),'1');assert.equal(view.find(n=>n.type==='input'&&n.props['aria-label']==='Preço do item 2').props.value,'2,5');
  assert.match(products().props.onCode(row),/quantidade do item 2 alterada para 2/);await view.flush();assert.equal(quantity(view,2),'2');
  products().props.onSelect(row);await view.flush();assert.equal(quantity(view,3),'1','a manual choice keeps adding a new line');
  products().props.onCode(row);await view.flush();assert.equal(quantity(view,3),'2');assert.equal(quantity(view,2),'2');
  view.find(n=>n.type==='input'&&n.props['aria-label']==='Quantidade do item 3').props.onChange({target:{value:'999999999'}});await view.flush();
  assert.match(products().props.onCode(row),/Não foi possível somar 1 à quantidade do item 3/);await view.flush();assert.equal(quantity(view,3),'999999999');
  const stock=node(view,'DocumentProductStock');assert.deepEqual({id:stock.props.product.id,name:stock.props.product.name},{id:productIds[0],name:'Produto 61'});assert.equal(stock.props.warehouseId,null);
  picker(view,'warehouses').props.onSelect({id:warehouse,entity:'warehouses',name:'Depósito fictício',active:true,version:1});await view.flush();
  assert.equal(products().props.stockWarehouse,warehouse);assert.equal(node(view,'DocumentProductStock').props.warehouseId,warehouse);
  products().props.onCode(productRow(productIds[2],{code:'SERV',kind:'S'}));await view.flush();assert.equal(quantity(view,4),'1');
  assert.equal(node(view,'DocumentProductStock'),undefined,'a service has no físico/disponível panel');
  assert.equal(s.documents.length,0,'adding items never saves the document');
 }finally{view.unmount();}
 const other=setup({role:'vendas'}),closed=await mountEditor(other.controller,'sales_proposals',{writable:false});
 try{assert.equal(picker(closed,'products'),undefined);}finally{closed.unmount();}
});

function pickerController({rows={},positions=null,role='vendas'}={}){
 const calls=[],state={session:{phase:'ready',membership:{role,user_id:actor}}};
 const controller={getSnapshot:()=>state.session,
  async catalog(path){calls.push(path);const url=new URL(path,'https://synthetic.invalid');
   if(url.searchParams.get('limit')==='25')return{entity:url.pathname.split('/').at(-1),items:rows.list??[],has_more:false,next_cursor:null,limit:25,data_mode:'erp_native'};
   let value=rows[url.searchParams.get('q')];if(typeof value==='function')value=value();if(value instanceof Error)throw value;
   return{entity:'products',items:value??[],has_more:false,next_cursor:null,limit:100,data_mode:'erp_native'};},
  async stockPositions(path){calls.push(path);if(positions instanceof Error)throw positions;return typeof positions==='function'?positions(path):positions;}};
 return{controller,calls,state};
}
const keyEnter=(view)=>{let prevented=false;view.find(n=>n.type==='input').props.onKeyDown({key:'Enter',preventDefault(){prevented=true;}});return prevented;};
async function type(view,value){view.find(n=>n.type==='input').props.onChange({target:{value}});await view.flush();}

test('Enter in the item field never submits the document: exact code or GTIN adds, everything else explains',async()=>{
 const inactive=productRow(productIds[1],{code:'VELHO',active:false});
 const p=pickerController({rows:{'7890000000017':[productRow(productIds[0],{gtin:'7890000000017'}),productRow(productIds[2],{code:'78900000000170'})],VELHO:[inactive],DUPLO:[productRow(productIds[0],{code:'duplo'}),productRow(productIds[2],{gtin:'DUPLO'})],FALHA:new AccessError(503)}});
 const added=[],view=await mountComponent('DocumentCatalogPicker.tsx',{controller:p.controller,entity:'products',label:'Adicionar produto do cadastro',onSelect(){},onCode:row=>{added.push(row.id);return `${row.name} incluído com quantidade 1.`;}},{componentName:'CatalogPicker'});
 try{
  assert.equal(view.find(n=>n.type==='input').props.placeholder,'Pesquise por código, descrição ou GTIN');
  await type(view,'  7890000000017 ');assert.equal(keyEnter(view),true);await view.flush();
  assert.deepEqual(added,[productIds[0]]);assert.equal(view.find(n=>n.type==='input').props.value,'');assert.match(view.text(),/Produto 61 incluído com quantidade 1/);
  assert.ok(p.calls.includes('/v1/cadastros/products?limit=100&q=7890000000017'),'the lookup includes inactive products only to explain them');
  for(const [code,message] of [['VELHO',/O produto Produto 62 \(VELHO\) está inativo e não pode ser incluído/],['DUPLO',/Mais de um produto ativo usa o código ou GTIN DUPLO/],['NADA',/Nenhum produto encontrado com o código ou GTIN NADA/],['FALHA',/Não foi possível conferir o código FALHA/]]){
   await type(view,code);assert.equal(keyEnter(view),true);await view.flush();assert.match(view.text(),message);
  }
  assert.deepEqual(added,[productIds[0]]);
  const lookups=p.calls.filter(path=>path.includes('limit=100')).length;assert.equal(keyEnter(view),true);await view.flush();assert.equal(p.calls.filter(path=>path.includes('limit=100')).length,lookups,'an empty Enter does nothing');
  let prevented=false;view.find(n=>n.type==='input').props.onKeyDown({key:'a',preventDefault(){prevented=true;}});assert.equal(prevented,false);
 }finally{view.unmount();}
 const contacts=pickerController(),contactView=await mountComponent('DocumentCatalogPicker.tsx',{controller:contacts.controller,entity:'contacts',label:'Cliente *',onSelect(){}},{componentName:'CatalogPicker'});
 try{await type(contactView,'Cliente');assert.equal(keyEnter(contactView),true);await wait(300);await contactView.flush();assert.equal(contacts.calls.some(path=>path.includes('limit=100')),false);assert.match(contactView.text(),/Cadastre-o em Cadastros da empresa/);}finally{contactView.unmount();}
 const disabled=pickerController({rows:{X:()=>{disabled.state.session={phase:'ready',membership:{role:'vendas',user_id:otherActor}};return[productRow(productIds[0],{code:'X'})];}}}),late=[];
 const disabledView=await mountComponent('DocumentCatalogPicker.tsx',{controller:disabled.controller,entity:'products',label:'Produto',disabled:false,onSelect(){},onCode:row=>{late.push(row.id);return 'ok';}},{componentName:'CatalogPicker'});
 try{await type(disabledView,'X');keyEnter(disabledView);await disabledView.flush();assert.deepEqual(late,[],'a session change discards the late lookup');}finally{disabledView.unmount();}
});

test('product options show the depósito stock, keep “sem lançamentos” apart from zero and never block the choice',async()=>{
 const rows=[productRow(productIds[0],{code:'A1'}),productRow(productIds[1],{code:'B2'}),productRow(productIds[2],{code:'SERV',kind:'S'})];
 const position=(id,selected,global={state:'recorded',quantity:'12.500000',recorded_warehouse_count:'1',scope:'all_recorded_warehouses'})=>({product:{id,version:1,name:'Produto',code:null,active:true,unit:'UN',kind:'P',format:'S',gtin:null,brand:null,location:null,stock_min:null,stock_max:null},global,selected_position:selected,limit_state:global.state==='recorded'?'not_configured':global.state});
 const page={scope:'stock_positions',data_mode:'erp_native',warehouse:{id:warehouse,name:'Depósito fictício',active:true},limit:25,has_more:false,next_cursor:null,items:[
  position(productIds[0],{warehouse_id:warehouse,state:'recorded',quantity:'12.500000',version:3}),position(productIds[1],{warehouse_id:warehouse,state:'no_movements',quantity:null,version:0})]};
 const chosen=[],p=pickerController({rows:{list:rows},positions:page});
 const view=await mountComponent('DocumentCatalogPicker.tsx',{controller:p.controller,entity:'products',label:'Adicionar produto do cadastro',stockWarehouse:warehouse,onSelect:row=>chosen.push(row?.id)},{componentName:'CatalogPicker'});
 try{
  await wait(300);await view.flush();
  assert.ok(p.calls.includes(`/v1/posicoes-estoque?active=true&warehouse_id=${warehouse}&limit=25`));
  const options=view.nodes().filter(n=>n.type==='option').map(n=>n.props.children);
  assert.deepEqual(options.slice(1),['Produto 61 · A1 · Estoque: 12,5 UN','Produto 62 · B2 · Estoque: sem lançamentos','Produto 63 · SERV']);
  assert.match(view.text(),/Estoque físico no depósito do documento/);
  view.find(n=>n.type==='select').props.onChange({target:{value:productIds[1]}});assert.deepEqual(chosen,[productIds[1]],'no stock is not a refusal');
 }finally{view.unmount();}
 const failed=pickerController({rows:{list:rows},positions:new AccessError(403)}),failedView=await mountComponent('DocumentCatalogPicker.tsx',{controller:failed.controller,entity:'products',label:'Produto',stockWarehouse:null,onSelect:row=>chosen.push(row?.id)},{componentName:'CatalogPicker'});
 try{
  await wait(300);await failedView.flush();
  assert.ok(failed.calls.includes('/v1/posicoes-estoque?active=true&limit=25'));
  assert.match(failedView.text(),/Estoque não consultado\. A escolha do produto continua liberada/);
  assert.equal(failedView.find(n=>n.type==='select').disabled,false);
  assert.deepEqual(failedView.nodes().filter(n=>n.type==='option').map(n=>n.props.children).slice(1),['Produto 61 · A1','Produto 62 · B2','Produto 63 · SERV']);
 }finally{failedView.unmount();}
 const hidden=pickerController({rows:{list:rows},positions:page}),hiddenView=await mountComponent('DocumentCatalogPicker.tsx',{controller:hidden.controller,entity:'products',label:'Produto',onSelect(){}},{componentName:'CatalogPicker'});
 try{await wait(300);await hiddenView.flush();assert.equal(hidden.calls.some(path=>path.startsWith('/v1/posicoes-estoque')),false,'without stock permission nothing is read');}finally{hiddenView.unmount();}
 let moved;const stale=pickerController({rows:{list:rows},positions:()=>{stale.state.session={phase:'ready',membership:{role:'vendas',user_id:otherActor}};return page;}});moved=await mountComponent('DocumentCatalogPicker.tsx',{controller:stale.controller,entity:'products',label:'Produto',stockWarehouse:warehouse,onSelect(){}},{componentName:'CatalogPicker'});
 try{await wait(300);await moved.flush();assert.doesNotMatch(moved.text(),/Estoque: 12,5/);}finally{moved.unmount();}
});

test('the included product shows físico, reservado and disponível of the document depósito as information only',async()=>{
 const f=createStockAvailabilityFixture(),product={id:stockIds.product,name:'Produto de demonstração',seq:1};
 const view=await mountComponent('DocumentProductStock.tsx',{controller:f.controller,product,warehouseId:stockIds.recorded});
 try{
  assert.match(view.text(),/Produto de demonstração no depósito do documento: Físico 18,125 UN · Reservado 3,125 UN · Disponível 15 UN/);
  assert.match(view.text(),/a inclusão do item não depende do saldo/);
  await view.updateProps({warehouseId:stockIds.empty});
  assert.match(view.text(),/Físico Não conferido · Reservado 0 · Disponível Não conferido/);assert.match(view.text(),/Não há lançamentos neste depósito/);
  await view.updateProps({warehouseId:null});assert.match(view.text(),/o documento não tem depósito previsto, por isso o saldo e o disponível por depósito não foram consultados/);
  const before=f.calls.length;await view.updateProps({product:{...product,seq:2},warehouseId:stockIds.recorded});assert.equal(f.calls.length,before+1,'each inclusion reads the current balance again');
  assert.ok(f.calls.every(call=>(call.options.method??'GET')==='GET'&&call.options.body===undefined&&call.path.startsWith('/v1/reservas-estoque/disponibilidade?')));
 }finally{view.unmount();}
 f.setSession({...f.controller.getSnapshot(),membership:{...f.controller.getSnapshot().membership,role:'financeiro'}});
 const calls=f.calls.length,hidden=await mountComponent('DocumentProductStock.tsx',{controller:f.controller,product,warehouseId:stockIds.recorded});
 try{assert.equal(hidden.text(),'');assert.equal(f.calls.length,calls);}finally{hidden.unmount();}
});
