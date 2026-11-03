import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{applicableListsPath,readApplicableLists}from'../src/lib/document-price-list-model.ts';
import{purchaseLabelProducts}from'../src/lib/document-labels-model.ts';
import{titleSituation,titleStatusOptions,titleChips}from'../src/lib/finance-title-list.ts';
import{statusParam,emptyFinanceRoute}from'../src/lib/finance-list-route.ts';
import{notificationContent}from'../src/lib/system-model.ts';

// Mixed lane, wave F (282, 281, 283 and EST-018): synthetic controllers only, no DOM and no network.
let previous;
test.before(()=>{previous=globalThis.document;
 globalThis.document={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{append(){},classList:{add(){},remove(){}}},createElement:()=>({className:'',remove(){}})};});
test.after(()=>{globalThis.document=previous;});
const textOf=x=>Array.isArray(x)?x.map(textOf).join(''):x&&typeof x==='object'?textOf(x.props?.children):x===null||x===undefined||typeof x==='boolean'?'':String(x);
const actor='a0000000-0000-4000-8000-0000000000f1',customer='c0000000-0000-4000-8000-0000000000f1',seller='d0000000-0000-4000-8000-0000000000f1',other='d1000000-0000-4000-8000-0000000000f1';
const pix='b0000000-0000-4000-8000-0000000000f1',card='b1000000-0000-4000-8000-0000000000f1';
const all='e0000000-0000-4000-8000-0000000000f1',bySeller='e1000000-0000-4000-8000-0000000000f1',byPix='e2000000-0000-4000-8000-0000000000f1';
const header=(id,name,category)=>({id,name,category,list_type:'rates',factor:'5',factor_unit:'percent',direction:'discount',considers_datetime:false,starts_on:null,ends_on:null,start_time:null,end_time:null,
 version:1,created_at:'2026-10-01T12:00:00Z',updated_at:'2026-10-01T12:00:00Z',rule:'5% de desconto',products:1});

test('282 PRD-149 the Lista de preço asks the server with the vendedor and the formas of the parcelas, drops late answers and clears a list that no longer applies',async()=>{
 assert.equal(applicableListsPath({id:customer,state:'sp'},seller,[card,pix,card,'x']),`/v1/cadastros/listas-precos/aplicaveis?contato=${customer}&vendedor=${seller}&forma_pagamento=${[pix,card].sort().join('%2C')}&uf=SP`);
 assert.equal(applicableListsPath(null,null,[]),'/v1/cadastros/listas-precos/aplicaveis');
 // A cliente of the exterior mirrored from Origin ("EX") or any value that is not one of the 27 UFs is not sent (the API refuses it).
 for(const state of['EX','ex','XX','S'])assert.equal(applicableListsPath({id:customer,state},null,[]),`/v1/cadastros/listas-precos/aplicaveis?contato=${customer}`,state);
 assert.throws(()=>readApplicableLists({items:[header(all,'A','other'),header(all,'A','other')]}),/PRICE_LISTS_INVALID/);
 assert.deepEqual(readApplicableLists({items:[header(bySeller,'Vendedora','seller'),header(byPix,'Pix','payment_method')]}).map(l=>l.category),['seller','payment_method']);
 const calls=[],answers=new Map();let release;
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'vendas',user_id:actor}}),
  async catalog(path){calls.push(path);const params=new URLSearchParams(path.split('?')[1]??'');
   if(params.get('vendedor')===other)await new Promise(resolve=>{release=resolve;});
   const items=[header(all,'Todos','other'),...(params.get('vendedor')===seller?[header(bySeller,'Vendedora','seller')]:[]),...((params.get('forma_pagamento')??'').includes(pix)?[header(byPix,'Pix','payment_method')]:[])];
   answers.set(path,items);return{items,data_mode:'erp_native'};}};
 const selected=[];const props={controller,contact:{id:customer,state:'SP'},seller,paymentMethods:[pix],selected:null,disabled:false,busy:'',applicable:0,onSelect:(list,reason)=>selected.push({list,reason}),onApply(){}};
 const v=await mountComponent('DocumentPriceList.tsx',props,{});
 const settle=async()=>{for(let i=0;i<3;i+=1){await new Promise(resolve=>setTimeout(resolve,10));await v.flush();}};
 try{
  await settle();
  const options=()=>v.input('doc-price-list').props.children[2].map(o=>textOf(o));
  assert.deepEqual(options(),['Todos · 5% de desconto','Vendedora · 5% de desconto','Pix · 5% de desconto']);
  assert.match(calls.at(-1),new RegExp(`vendedor=${seller}`));assert.match(calls.at(-1),new RegExp(`forma_pagamento=${pix}`));
  // Another vendedor whose answer arrives late, then back to the first vendedor: the late answer is dropped.
  await v.updateProps({seller:other});await v.updateProps({seller,selected:{id:bySeller,name:'Vendedora'}});await settle();
  release();await settle();
  assert.deepEqual(options(),['Todos · 5% de desconto','Vendedora · 5% de desconto','Pix · 5% de desconto']);
  assert.equal(selected.length,0);
  // Without the forma Pix, the chosen list of that forma no longer applies: it is cleared with the reason.
  await v.updateProps({paymentMethods:[card],selected:{id:byPix,name:'Pix'}});await settle();
  assert.deepEqual(selected.at(-1),{list:null,reason:'A lista Pix não vale agora para este cliente, vendedor ou forma de pagamento.'});
 }finally{v.unmount();}
});

test('282 EST-152 TagsDrawer: Adicionar tag needs Cadastro de tags and Adicionar grupo needs Cadastro de grupos de tags',async()=>{
 const permissions=keys=>({scope:'access_permissions',data_mode:'erp_native',user_id:actor,role:'estoque',user_type:'normal',permissions:keys,access:{open:true,until:null}});
 const base=['cadastros.produtos','cadastros.produtos.ie'];
 const mount=async keys=>mountComponent('TagsDrawer.tsx',{controller:{catalog:async()=>({}),system:async()=>permissions(keys)},writable:true,tags:[],groups:[],selected:[],onCancel(){},onApply(){}},
  {componentName:'TagsDrawer',expandChildren:['Modal']});
 const labels=v=>v.nodes().filter(n=>n.type==='button').map(textOf);
 for(const[keys,expected]of[[base,[]],[[...base,'outros.tags'],['Adicionar tag']],[[...base,'outros.grupos_tags'],['Adicionar grupo']],[null,['Adicionar tag','Adicionar grupo']]]){
  const v=await mount(keys);try{await v.flush();assert.deepEqual(labels(v).filter(l=>l.startsWith('Adicionar')),expected,JSON.stringify(keys));}finally{v.unmount();}}
});

test('282 EST-152 Gerenciar tags and Gerenciar grupos de tags are read only without their Outros permission',async()=>{
 const stamp='2026-10-20T12:00:00+00:00',tag={id:'95000000-0000-4000-8000-0000000000d1',kind:'tags',parent_id:null,name:'Promoção',version:1,created_at:stamp,updated_at:stamp,tag_type:'products',children:0,products:2,contacts:0};
 const permissions=keys=>({scope:'access_permissions',data_mode:'erp_native',user_id:actor,role:'estoque',user_type:'normal',permissions:keys,access:{open:true,until:null}});
 const controller=keys=>({getSnapshot:()=>({phase:'ready',membership:{user_id:actor,role:'estoque'}}),subscribe:()=>()=>{},
  async catalog(path){if(path==='/v1/cadastros')return{read:['contacts','products'],write:['products'],data_mode:'erp_native'};
   if(path==='/v1/cadastros/taxonomias/tags')return{kind:'tags',items:[tag],data_mode:'erp_native'};if(path==='/v1/cadastros/taxonomias/grupos-tags')return{kind:'tag_groups',items:[],data_mode:'erp_native'};
   throw new Error(path);},async system(){return permissions(keys);}});
 for(const[kind,keys,writable]of[['tags',['cadastros.produtos','cadastros.produtos.ie'],false],['tags',['cadastros.produtos','cadastros.produtos.ie','outros.tags'],true],['tag_groups',['cadastros.produtos','outros.tags'],false],['tags',null,true]]){
  const v=await mountComponent('ProductTaxonomy.tsx',{controller:controller(keys),kind},{});
  try{await v.flush();const add=v.nodes().some(n=>n.type==='button'&&/^Incluir (tag|grupo tag)$/.test(textOf(n)));
   assert.equal(add,writable,`${kind} ${JSON.stringify(keys)}`);assert.equal(/Somente consulta/.test(v.text()),!writable);}finally{v.unmount();}}
});

test('EST-018 Imprimir etiquetas of the pedidos de compra comes with one label per quantity (rounded up, 1 to 999), still editable',async()=>{
 const p1='a2000000-0000-4000-8000-0000000000f1',p2='a2000000-0000-4000-8000-0000000000f2',p3='a2000000-0000-4000-8000-0000000000f3';
 const item=(product_id,quantity)=>({product_id,description:'Item',code:'C-1',quantity,product_snapshot:{name:`Produto ${product_id?.slice(-1)}`,price:'9.9000',gtin:null}});
 const labels=purchaseLabelProducts([{items:[item(p1,'2.5'),item(p2,'0.001'),item(null,'7'),item(p3,'1000')]},{items:[item(p1,'3')]}]);
 assert.deepEqual(labels.quantities,{[p1]:'6',[p2]:'1',[p3]:'999'});
 const v=await mountComponent('ProductLabels.tsx',{products:labels.products,initialQuantities:{...labels.quantities,[p2]:'0'},onClose(){}},{componentName:'ProductLabels'});
 try{
  const quantity=id=>v.nodes().find(n=>n.type==='input'&&String(n.props['aria-label']).startsWith(`Quantidade de etiquetas de Produto ${id.slice(-1)}`)).props.value;
  assert.deepEqual([quantity(p1),quantity(p2),quantity(p3)],['6','1','999'],'an invalid initial quantity starts at 1');
  assert.match(v.text(),/Imprimir etiquetas · 1006 etiqueta\(s\)/);
 }finally{v.unmount();}
});

test('281 FIN-011 Situação Devolvido: the option of Emitidas, the canonical URL order, the chip and the badge of the conta',()=>{
 assert.deepEqual(titleStatusOptions('receivable').map(o=>o.label),['Cancelada','Devolvido','Em aberto','Parcialmente Recebida','Recebida']);
 assert.deepEqual(titleStatusOptions('payable').map(o=>o.label),['Cancelada','Devolvido','Em aberto','Parcialmente Paga','Paga']);
 assert.equal(statusParam(['paid','returned','cancelled']),'cancelled,returned,paid');
 const route={...emptyFinanceRoute('receivable'),option:'issued',status:'returned'};
 assert.ok(titleChips(route,'receivable').some(c=>c.label==='Situação: Devolvido'));
 const conta={kind:'receivable',status:'cancelled',overdue:false,due_on:'2026-10-10',cancelled:true,deleted_at:null};
 assert.equal(titleSituation({...conta,returned:true},'2026-10-20').label,'Devolvido');
 assert.equal(titleSituation({...conta,returned:false},'2026-10-20').label,'Cancelada');
 assert.equal(titleSituation(conta,'2026-10-20').label,'Cancelada','a database before 281 sends no flag');
});

test('283 the bell shows Lote próximo ao vencimento with the lots and opens the stock',()=>{
 const n={id:'1',type:'lote_vencimento',day:'2026-10-20',quantity:3,amount:null,created_at:'2026-10-20T12:00:00Z',read:false};
 assert.deepEqual(notificationContent(n),{title:'Lote próximo ao vencimento',text:'3 lotes com saldo vencem dentro do prazo de aviso de validade.',to:'/estoque-empresa'});
 assert.equal(notificationContent({...n,quantity:1}).text,'1 lote com saldo vence dentro do prazo de aviso de validade.');
});
