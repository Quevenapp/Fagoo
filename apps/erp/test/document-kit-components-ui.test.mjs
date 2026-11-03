import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {kitBody,kitRows,kitTotal,parseKitComponents} from '../src/lib/document-kit-components-model.ts';

// 280 (estoque, onda F): "Componentes do item (kit)" of a pedido de venda item. Synthetic data only.
globalThis.document??={activeElement:null,getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{classList:{add(){},remove(){}},append(){},style:{}}};
const D='91000000-0000-4000-8000-000000000001',I='92000000-0000-4000-8000-000000000001',K='93000000-0000-4000-8000-000000000001',A='94000000-0000-4000-8000-000000000001',B='94000000-0000-4000-8000-000000000002',C='94000000-0000-4000-8000-000000000003';
const comp=(id,name,quantity,total,stock='10.000000')=>({component_id:id,name,code:null,unit:'UN',active:true,problem:null,quantity,total,stock});
const view=(patch={})=>({scope:'stock_item_components',data_mode:'erp_native',document:{id:D,kind:'sales_orders',number:'31',version:4,status:'open',warehouse_id:null},
 item:{id:I,position:1,product_id:K,description:'Kit sintético',quantity:'2.000000',unit:'UN'},product:{id:K,name:'Kit sintético',code:'KIT-1',unit:'UN',format:'E'},
 composition:{stock_type:'virtual',post_mode:'components',version:1},structure:[{component_id:A,quantity:'2.000000'},{component_id:B,quantity:'1.000000'}],edited:false,version:0,stock_visible:true,
 components:[comp(A,'Componente A','2.000000','4.000000000000'),comp(B,'Componente B','1.000000','2.000000000000')],editable:true,reason_code:null,...patch});

test('280 model: exact Qtde Total, the body of the save and refusals before any request',()=>{
 const v=parseKitComponents(view(),D,I);
 assert.equal(kitTotal('1,25','2.000000'),'2,5');assert.equal(kitTotal('0,333333','3.000001'),'0,999999333333');assert.equal(kitTotal('x','2.000000'),'—');
 const rows=kitRows(v);assert.deepEqual(rows.map(r=>r.quantity),['2','1']);
 assert.deepEqual(kitBody(v,[{...rows[0],quantity:'3,5'}]),{document_id:D,expected_document_version:4,expected_version:0,components:[{component_id:A,quantity:'3.5'}]});
 assert.deepEqual(kitBody(v,null).components,null,'Restaurar estrutura');
 assert.throws(()=>kitBody(v,[]),/ao menos um componente/);assert.throws(()=>kitBody(v,[rows[0],rows[0]]),/mais de uma vez/);
 assert.throws(()=>kitBody(v,[{...rows[0],quantity:'0'}]),/Qtde Un de Componente A/);
 assert.throws(()=>kitBody(parseKitComponents(view({editable:false,reason_code:'posted'}),D,I),rows),/estorne antes/);
 assert.throws(()=>parseKitComponents(view({components:[comp(A,'Componente A','2.000000','5.000000000000')]}),D,I),'a Qtde Total that does not match');
 assert.throws(()=>parseKitComponents(view({editable:false}),D,I));
});

function service({lose=false,refuse=null}={}){
 const calls=[];let state=view(),lost=lose;
 const stock=async(path,options={})=>{calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});
  if(path.startsWith('/v1/estoque/composicoes/componentes'))return{scope:'stock_composition_components',data_mode:'erp_native',query:new URL(path,'https://x.invalid').searchParams.get('q'),stock_visible:true,total:1,
   items:[{id:C,name:'Componente C',code:'C-1',unit:'UN',price:null,cost_price:null,stock:'7.000000'}]};
  if(path.startsWith(`/v1/estoque/composicoes/itens/${I}?`))return structuredClone(state);
  if(path===`/v1/estoque/composicoes/itens/${I}`&&options.method==='POST'){
   if(refuse)throw new AccessError(refuse);
   const list=options.body.components;
   state=list===null?view({document:{...view().document,version:5}}):view({document:{...view().document,version:5},edited:true,version:1,
    components:list.map(c=>{const name=c.component_id===A?'Componente A':c.component_id===B?'Componente B':'Componente C';const [w,fr='']=c.quantity.split('.');const q=`${w}.${fr.padEnd(6,'0')}`;
     const total=(BigInt(q.replace('.',''))*2000000n).toString().padStart(13,'0');return comp(c.component_id,name,q,`${total.slice(0,-12)}.${total.slice(-12)}`);})});
   if(lost){lost=false;throw new Error('network');}
   return{...structuredClone(state),scope:'stock_item_components_save',restored:list===null,replayed:false};}
  throw new Error(`unexpected ${path}`);};
 return{calls,controller:{stock},posts:()=>calls.filter(c=>c.method==='POST')};
}
const mountKit=(s,props={})=>mountComponent('DocumentKitComponents.tsx',{controller:s.controller,documentId:D,itemId:I,onClose(){},onSaved(){},...props},{expandChildren:['Modal']});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('280 Componentes do item (kit): Qtde Un, Remover, Adicionar, Salvar with Conferir resultado and the reload of the pedido',async()=>{
 const s=service({lose:true});let reloaded=0,closed=0;
 const v=await mountKit(s,{onSaved:async()=>{reloaded++;},onClose:()=>{closed++;}});
 try{
  assert.equal(s.calls[0].path,`/v1/estoque/composicoes/itens/${I}?documento=${D}`);
  assert.match(v.text(),/Componentes do item \(kit\)/);assert.match(v.text(),/Componentes da estrutura do produto/);
  assert.match(v.text(),/Componente A/);assert.match(v.text(),/4 UN/,'Qtde Total = 2 x 2');
  await v.change('kit-quantity-0','1,5');assert.match(v.text(),/3 UN/);
  v.find(n=>n.type==='button'&&n.props['aria-label']==='Remover Componente B').props.onClick();await v.flush();
  await v.change('kit-component-search','comp');await wait(300);await v.flush();
  v.find(n=>n.type==='button'&&/Componente C/.test(JSON.stringify(n.props.children))).props.onClick();await v.flush();
  assert.ok(s.calls.some(c=>c.path.startsWith('/v1/estoque/composicoes/componentes?')&&c.path.includes(`excluir=${K}`)),'the kit itself is never offered');
  await v.click('Salvar');
  assert.deepEqual(s.posts()[0].body.components,[{component_id:A,quantity:'1.5'},{component_id:C,quantity:'1'}]);
  assert.match(v.text(),/Use “Conferir resultado”/);assert.equal(v.button('Cancelar').disabled,true);
  await v.click('Conferir resultado');await v.flush();
  assert.equal(s.posts()[1].body.command_id,s.posts()[0].body.command_id,'the same command');
  assert.equal(reloaded,1);assert.equal(closed,1);
 }finally{v.unmount();}
});

test('280 Componentes do item (kit): read-only reasons, the editor guard and Restaurar estrutura',async()=>{
 const posted=service();posted.controller.stock=async()=>view({editable:false,reason_code:'posted'});
 const locked=await mountKit(posted);
 try{assert.match(locked.text(),/O estoque do pedido já foi lançado; estorne antes/);assert.equal(locked.nodes().some(n=>n.type==='input'&&n.props.id==='kit-quantity-0'),false);
  assert.equal(locked.nodes().some(n=>n.type==='button'&&n.props.children==='Salvar'),false);}finally{locked.unmount();}
 const s=service();const dirty=await mountKit(s,{blocked:'Salve ou descarte as alterações do pedido antes de editar os componentes do item.'});
 try{assert.match(dirty.text(),/Salve ou descarte as alterações do pedido/);assert.equal(dirty.nodes().some(n=>n.type==='button'&&n.props.children==='Salvar'),false);}finally{dirty.unmount();}
 const edited=service();let state=view({edited:true,version:1,components:[comp(C,'Componente C','1.000000','2.000000000000')]});
 const stock=edited.controller.stock;edited.controller.stock=async(path,options={})=>!options.method&&path.includes('?documento=')?structuredClone(state):stock(path,options);
 let reloaded=0;const r=await mountKit(edited,{onSaved:()=>{reloaded++;}});
 try{assert.match(r.text(),/Componentes próprios deste item/);await r.click('Restaurar estrutura');assert.equal(edited.posts()[0].body.components,null);assert.equal(reloaded,1);}finally{r.unmount();}
 const refused=service({refuse:409});const no=await mountKit(refused);
 try{await no.change('kit-quantity-0','3');await no.click('Salvar');assert.match(no.text(),/O pedido ou os componentes mudaram/);assert.equal(no.button('Cancelar').disabled,false);}finally{no.unmount();}
});

test('280 the editor offers "Editar componentes do produto" only on a saved composition item of a pedido de venda',async()=>{
 const {createPurchaseReceiptsFixture}=await import('../src/qa/purchase-receipts-fixture.ts');
 const {record,input,itemId}=await import('./helpers/document-commercial-fixtures.mjs');
 const P='95000000-0000-4000-8000-000000000001';
 const make=format=>{const data=input();data.items=[{...data.items[0],product_id:P}];const doc=record('sales_orders',data,3);
  doc.status='open';doc.items=doc.items.map(item=>({...item,product_snapshot:{id:P,format}}));doc.effect_flags={finance_active:false,stock_active:false};return doc;};
 const mountEditor=async doc=>{const s=createPurchaseReceiptsFixture();const calls=[];
  s.controller.catalog=async()=>({read:['contacts','products'],write:[]});s.controller.documents=async()=>({document:structuredClone(doc)});s.controller.documentCopy=async()=>{throw new AccessError(503);};
  s.controller.stock=async path=>{calls.push(path);if(path.startsWith('/v1/estoque/composicoes/itens/'))return{...view(),item:{...view().item,id:itemId},document:{...view().document,id:doc.id}};throw new AccessError(503);};
  const v=await mountComponent('RealDocuments.tsx',{controller:s.controller,kind:'sales_orders',record:doc,writable:true,onSaved(){},onClose(){},onConverted(){},onCopyPrepared(){}},{componentName:'Editor'});
  return{v,calls};};
 const kit=await mountEditor(make('E'));
 try{
  const pencil=kit.v.nodes().find(n=>n.type==='a'&&n.props['aria-label']==='Editar componentes do produto do item 1');
  assert.ok(pencil,'the pencil of a composition item');
  pencil.props.onClick({preventDefault(){}});await kit.v.flush();
  assert.ok(kit.v.nodes().some(n=>typeof n.type==='function'&&n.type.name==='DocumentKitComponents'),'opens Componentes do item (kit)');
 }finally{kit.v.unmount();}
 const simple=await mountEditor(make('S'));
 try{assert.equal(simple.v.nodes().some(n=>n.type==='a'&&n.props['aria-label']==='Editar componentes do produto do item 1'),false,'a simple product has no components to edit');}finally{simple.v.unmount();}
});
