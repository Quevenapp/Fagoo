import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent,AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { conversionDocument } from '../src/lib/real-documents-model.ts';

// 202610200196 Origin "Gerar venda" / "Gerar ordem de serviço" (vendas.php#idOrigem/<id>): the new document opens prefilled with
// the proposta and nothing is saved until Salvar, which concludes the proposta. Synthetic controller; no DOM, no network.
const id='10000000-0000-4000-8000-000000000001',targetId='10000000-0000-4000-8000-000000000002',contact='20000000-0000-4000-8000-000000000001',actor='30000000-0000-4000-8000-000000000001';
const body={date:'2026-10-16',contact_id:contact,items:[{id:'40000000-0000-4000-8000-000000000001',description:'Serviço sintético',unit:'H',quantity:'0.123456',unit_price:'100',discount_percent:'0'}]};
const original={...normalizeDocument('sales_proposals',body),id,kind:'sales_proposals',number:'7',version:3,status:'approved',contact_snapshot:{id:contact,name:'Contato sintético'},effect_flags:{finance_active:false,stock_active:false},source_proposal_id:null,created_at:'2026-10-16T07:00:00Z',updated_at:'2026-10-16T07:00:00Z'};
const clone=value=>structuredClone(value);
function conversion(kind='service_orders'){
 const proposal={...clone(original),version:4,status:'completed'};
 const target={...clone(original),id:targetId,kind,number:'12',status:kind==='service_orders'?'open':'draft',version:1,source_proposal_id:id,items:original.items.map(item=>({...item,id:'40000000-0000-4000-8000-000000000002'}))};
 return{proposal,[kind==='service_orders'?'service_order':'sale']:target,replayed:false,data_mode:'erp_native',operational_effects:false};
}
const generate=kind=>kind==='service_orders'?'Gerar ordem de serviço':'Gerar pedido de venda';
const child=(view,name)=>view.nodes().find(node=>typeof node.type==='function'&&node.type.name===name);
const mountEditor=controller=>mountComponent('RealDocuments.tsx',{controller,kind:'sales_proposals',record:clone(original),writable:true,onClose(){},onSaved(){},onConverted(){}},{componentName:'Editor',location:'/documentos-empresa?tipo=sales_proposals'});

test('conversion union preserves the legacy sale shape and binds an OS to the same proposal',()=>{
 for(const kind of ['sales_orders','service_orders'])assert.equal(conversionDocument(conversion(kind)).kind,kind);
 for(const mutate of [v=>v.sale=clone(v.service_order),v=>v.service_order=null,v=>v.service_order.kind='sales_orders',v=>v.service_order.id=[targetId],v=>v.service_order.source_proposal_id=targetId,v=>v.proposal.status='approved',v=>v.operational_effects=true]){const wrong=conversion();mutate(wrong);assert.throws(()=>conversionDocument(wrong));}
});
for(const kind of ['service_orders','sales_orders'])test(`${kind}: Gerar opens the new document prefilled, without creating anything`,async()=>{
 const calls=[],controller={getSnapshot:()=>({phase:'ready',membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documents(path,options={}){calls.push({path,...options});return{document:clone(original)};}};
 const view=await mountEditor(controller);
 try{
  await view.click(generate(kind));
  assert.equal(calls.filter(call=>call.method).length,0,'nothing is created by the button');
  const params=new URLSearchParams(view.location().search);
  assert.deepEqual([params.get('tipo'),params.get('acao'),params.get('origem')],[kind,'proposta',id]);
 }finally{view.unmount();}
});
test('proposal status drafts and attachment selections block Gerar',async()=>{
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'admin',user_id:actor}}),catalog:async()=>({read:[],write:[]}),async documents(){return{document:clone(original)};}};
 const view=await mountEditor(controller);
 try{
  await view.change('doc-reason','Conferência pendente');assert.equal(view.button(generate('service_orders')).disabled,true);await view.change('doc-reason','');
  await view.click('Ver / adicionar anexos');child(view,'DocumentAttachments').props.onDraft(true);await view.flush();assert.equal(view.button(generate('service_orders')).disabled,true);
  child(view,'DocumentAttachments').props.onDraft(false);await view.flush();assert.equal(view.button(generate('service_orders')).disabled,false);
 }finally{view.unmount();}
});

const preview=(kind='sales_orders')=>({kind,source:{id,kind:'sales_proposals',number:'7',version:3},data:{...clone(body),items:body.items.map(item=>({...item,id:null}))},contact:{id:contact,name:'Contato sintético'},price_list_name:null,persisted:false,data_mode:'erp_native',operational_effects:false});
function screen({kind='sales_orders',onPreview=()=>preview(kind),onPost}={}){
 const calls=[],posts=[];
 const saved=()=>({...normalizeDocument(kind,{...clone(body),items:body.items.map(item=>({...item,id:'40000000-0000-4000-8000-000000000009'}))}),id:targetId,kind,number:'31',version:1,status:'open',contact_snapshot:{id:contact,name:'Contato sintético'},effect_flags:{finance_active:false,stock_active:false},source_proposal_id:id,created_at:'2026-10-16T07:00:00Z',updated_at:'2026-10-16T07:00:00Z'});
 const controller={getSnapshot:()=>({phase:'ready',membership:{role:'vendas',user_id:actor}}),catalog:async()=>({read:['contacts','products'],write:[]}),async documents(path,options={}){
  calls.push({path,...options,body:options.body?clone(options.body):undefined});
  if(path==='/v1/documentos')return{read:['sales_proposals','sales_orders','service_orders'],write:['sales_proposals','sales_orders','service_orders'],data_mode:'erp_native',operational_effects:false};
  if(path.includes('/a-partir-da-proposta/'))return onPreview(path);
  if(options.method==='POST'){posts.push(clone(options.body));const result=onPost?.(posts.length);if(result instanceof Error)throw result;return{kind,document:saved(),source_proposal:{id,number:'7',version:4,status:'completed'},replayed:posts.length>1,data_mode:'erp_native',operational_effects:false};}
  if(path===`/v1/documentos/${kind}/${targetId}`)return{kind,document:saved(),data_mode:'erp_native',operational_effects:false};
  if(path.includes('?'))return{kind,items:[],limit:25,page:1,order:'date_desc',has_more:false,next_cursor:null,total_count:0,total_amount:'0.00',data_mode:'erp_native',operational_effects:false};
  throw new AccessError(404);
 }};
 return{controller,calls,posts};
}
for(const kind of ['sales_orders','service_orders'])test(`${kind}: acao=proposta opens the prefilled editor; Salvar sends the proposta and concludes it`,async()=>{
 const s=screen({kind}),view=await mountComponent('RealDocuments.tsx',{controller:s.controller,initialKind:kind},{location:`/documentos-empresa?tipo=${kind}&acao=proposta&origem=${id}`,expandChildren:['Editor']});
 try{
  for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,10));await view.flush();}
  assert.ok(view.nodes().some(node=>node.type==='form'&&node.props.id==='document-editor-form'),'the editor is open');
  assert.match(view.text(),/preenchid[oa] com a proposta nº 7\. Confira e salve: nada foi gravado ainda/);
  assert.equal(s.posts.length,0);
  await view.submit();for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,10));await view.flush();}
  assert.equal(s.posts.length,1);assert.deepEqual(s.posts[0].source_proposal,{id,expected_version:3});assert.equal(s.posts[0].data.items[0].description,'Serviço sintético');
  assert.match(view.text(),/Proposta 7 concluída\./);
 }finally{view.unmount();}
});
test('a lost answer keeps the same command and the proposta until "Conferir resultado"',async()=>{
 const s=screen({onPost:n=>n===1?new AccessError(503):null}),view=await mountComponent('RealDocuments.tsx',{controller:s.controller,initialKind:'sales_orders'},{location:`/documentos-empresa?tipo=sales_orders&acao=proposta&origem=${id}`,expandChildren:['Editor']});
 try{
  for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,10));await view.flush();}
  await view.submit();await view.flush();assert.match(view.text(),/Conferir resultado/);
  await view.click('Conferir resultado');for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,10));await view.flush();}
  assert.equal(s.posts.length,2);assert.equal(s.posts[0].command_id,s.posts[1].command_id);assert.deepEqual(s.posts[0],s.posts[1]);
 }finally{view.unmount();}
});
test('a proposta that already generated a document explains why nothing opened',async()=>{
 const s=screen({onPreview:()=>{throw new AccessError(409);}}),view=await mountComponent('RealDocuments.tsx',{controller:s.controller,initialKind:'sales_orders'},{location:`/documentos-empresa?tipo=sales_orders&acao=proposta&origem=${id}`,expandChildren:['Editor']});
 try{for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,10));await view.flush();}
  assert.equal(child(view,'Editor'),undefined);assert.match(view.text(),/Esta proposta já gerou uma venda ou ordem de serviço/);}
 finally{view.unmount();}
});
