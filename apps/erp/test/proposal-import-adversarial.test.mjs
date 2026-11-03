import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {BASE,page,row,preview,ack,current,state,actor,document,originMetadata} from './helpers/proposal-import-v2-fixtures.mjs';

function server(intercept=()=>{}){
 const calls=[],commands=new Map(),s={access:state(),post:0,get:0};
 const controller={getSnapshot:()=>s.access,async proposalImport(path,options={}){
  const route=new URL(path,'https://synthetic.invalid'),op=route.pathname===BASE?'list':route.pathname.endsWith('/preview')?'preview':route.pathname.endsWith('/apply')?'apply':route.pathname.includes('/commands/')?'command':'origin';
  const call={path,op,body:options.body?structuredClone(options.body):undefined,signal:options.signal};calls.push(call);
  if(op==='apply')s.post++;if(op==='command')s.get++;
  const intercepted=await intercept(call,s,commands);if(intercepted!==undefined)return intercepted;
  if(op==='list')return page();if(op==='preview')return preview(call.body.source_id);
  if(op==='apply'){const old=commands.get(call.body.command_id);if(old){assert.deepEqual(old.body,call.body);return{...structuredClone(old.receipt),replayed:true};}const receipt=ack(call.body);commands.set(call.body.command_id,{body:call.body,receipt});return structuredClone(receipt);}
  const saved=op==='command'?commands.get(route.pathname.split('/').at(-1)):[...commands.values()][0];if(!saved)throw new AccessError(404);return current(saved.receipt);
 }};return{controller,s,calls,commands};
}
const mount=(s,ports={})=>mountComponent('RealImportProposals.tsx',{controller:s.controller},{expandChildren:['NativeListLayout'],ports});
async function review(v){await v.click('Conferir prévia 9520000001');await v.change('proposal-import-duplicates',true);await v.change('proposal-import-confirm',true);}

test('independent versioned proposal import ACK then404 keeps GET-only recovery and does not offer another POST',async()=>{
 const s=server((call,x)=>{if(call.op==='command'&&x.get<=2)throw new AccessError(x.get===1?404:503);}),v=await mount(s);
 try{
  await review(v);const staleBack=v.button('Voltar à lista'),staleCheck=v.input('proposal-import-confirm');await v.click('Criar rascunho revisado');
  assert.match(v.text(),/Recibo confirmado/);assert.equal(v.guard().busy,true);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Reenviar a mesma confirmação'),false);
  staleBack.props.onClick();staleCheck.props.onChange({target:{checked:false}});await v.flush();assert.equal(v.input('proposal-import-confirm').props.checked,true);
  await v.click('Consultar resultado');assert.equal(v.guard().busy,true);assert.equal(s.s.post,1);await v.click('Consultar resultado');assert.equal(s.s.post,1);assert.equal(s.s.get,3);assert.equal(v.guard().busy,false);assert.match(v.text(),/Importação registrada/);
 }finally{v.unmount();}
});
test('independent versioned proposal import declined discard preserves review and a delayed confirmation cannot clear an in-flight attempt',async()=>{
 let leave;const s=server(call=>{if(call.op==='apply')throw new AccessError(503);}),v=await mount(s,{useUnsavedChanges:()=>({confirmLeave:fn=>{leave=fn;}})});
 try{
  await review(v);await v.click('Voltar à lista');assert.match(v.text(),/Conferir orçamento/);assert.equal(v.input('proposal-import-confirm').props.checked,true);
  await v.click('Criar rascunho revisado');assert.equal(s.s.post,1);leave();await v.flush();assert.match(v.text(),/resultado pendente/);assert.equal(v.button('Voltar à lista').disabled,true);assert.equal(s.s.post,1);
 }finally{v.unmount();}
});
test('independent versioned proposal import fifty blocked issues stay visible in Portuguese, with São Paulo observation date and no apply controls',async()=>{
 const s=server(call=>{
  if(call.op!=='preview')return;const p=preview();p.source_seen_at='2026-10-17T01:30:00Z';p.can_apply=false;p.proposed=null;p.source_evidence=null;p.transformations=[];p.issues=Array.from({length:50},(_,i)=>({code:'PRODUCT_MAPPING_UNAVAILABLE',field:'produto.id',position:i+1}));return p;
 }),v=await mount(s);
 try{
  await v.click('Conferir prévia 9520000001');const text=v.text();assert.match(text,/16\/10\/2026/);assert.match(text,/22:30/);assert.match(text,/Item 50: Produto:/);assert.equal((text.match(/correspondência exata, ativa/g)||[]).length,50);assert.doesNotMatch(text,/PRODUCT_MAPPING_UNAVAILABLE|undefined|NaN/);
  assert.equal(v.nodes().some(n=>n.props.id==='proposal-import-confirm'),false);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Criar rascunho revisado'),false);assert.equal(s.s.post,0);
 }finally{v.unmount();}
});
test('independent versioned proposal import existing import navigates to the native proposal by UUID without modifying the receipt',async()=>{
 const body={source_id:'9520000001',preview_hash:'b'.repeat(64),command_id:'f0000000-0000-4000-8000-000000000001',confirm_import:true,duplicate_reviewed:true};
 const s=server(call=>{if(call.op==='list')return page([{...row(),document_id:document}]);if(call.path.includes('/documents/'))return originMetadata();if(call.op==='origin'){const v=current(ack(body));v.current_document.version=2;v.current_document.status='cancelled';return v;}}),v=await mount(s);
 try{await v.click('Consultar importação 9520000001');assert.match(v.text(),/rascunho, versão 1/);assert.match(v.text(),/Cancelado · versão 2/);const link=v.find(n=>n.type==='test-router-link');assert.equal(link.props.to,'/documentos-empresa?tipo=sales_proposals&documento='+document);assert.equal(s.s.post,0);assert.equal(s.calls.filter(c=>c.op==='preview').length,0);}finally{v.unmount();}
});
test('independent versioned proposal import role loss during uncertain recovery blocks old controls and a new actor cannot inherit the command',async()=>{
 const s=server(call=>{if(call.op==='apply')throw new AccessError(503);}),v=await mount(s);
 try{
  await review(v);await v.click('Criar rascunho revisado');const recover=v.button('Consultar resultado');s.s.access={...state(),membership:{...state().membership,role:'consulta'}};await v.updateProps({controller:s.controller});
  recover.props.onClick();await v.flush();assert.equal(s.s.get,0);assert.match(v.text(),/Somente administradores/);
  s.s.access={...state(),membership:{...state().membership,user_id:actor.replace(/1$/,'2')}};await v.updateProps({controller:s.controller});recover.props.onClick();await v.flush();assert.equal(s.s.get,0);assert.equal(s.s.post,1);assert.match(v.text(),/Somente administradores/);
 }finally{v.unmount();}
});
