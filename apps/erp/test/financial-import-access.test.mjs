import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as access from '../src/lib/real-access.ts';
import {captureFinancialImportRequest} from '../src/lib/financial-import-request.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {importRequest,applyRequest,importPreview,importAck,importBatch,financialPage,financialRow} from './fixtures/financial-import.mjs';
const BASE='/v1/importacao-financeira-origin',origin='https://erp.synthetic.invalid',actor='a0000000-0000-4000-8000-000000000001',other='a0000000-0000-4000-8000-000000000002';
const session=(token='synthetic-original-token',id=actor)=>({access_token:token,user:{id}});
const member=(role='admin',id=actor)=>({user_id:id,role,resources:['contacts'],data_mode:'staging_readonly'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate){for(let i=0;i<200&&!predicate();i++)await tick();assert.ok(predicate(),'bounded synthetic wait');}
function setup({role='admin',before=()=>{},after=()=>{}}={}){
 let emit=()=>{};const state={role,actor},calls=[],saved=new Map(),phases=[];
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{emit('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=access.createAccessController(auth,origin,async(url,options)=>{
  const call={url,options};calls.push(call);const early=await before(call,state);if(early)return early;
  const path=new URL(url).pathname;let value;
  if(path==='/v1/me')value=member(state.role,state.actor);
  else if(path===BASE+'/preview')value=importPreview(JSON.parse(options.body));
  else if(path===BASE+'/apply'){value=importAck(JSON.parse(options.body));saved.set(value.batch.id,value);}
  else if(path.startsWith(BASE+'/batches/')){const known=saved.get(path.split('/').at(-1));if(!known)return new Response(null,{status:404});value=importBatch(known);}
  else if(path==='/v1/preparacao-virada')value={data_mode:'cutover_readonly',as_of:'2026-10-16T15:00:00Z',cutoff_at:null,reconciled:false,batches:[],batch_count:0,batches_truncated:false,api:[],limitations:[]};
  else if(path==='/v1/conferencia-financeira-origin'){const p=new URL(url).searchParams,filters={entity:p.get('entity'),status:p.get('status'),q:p.get('q')||'',from:p.get('from')||'',to:p.get('to')||''};value=financialPage([financialRow('0001',filters.entity)],filters);}
  else if(path==='/v1/financeiro/categories')value={entity:'categories',data_mode:'erp_native',limit:25,has_more:false,next_cursor:null,items:[]};
  else throw Error('UNEXPECTED_FINANCIAL_IMPORT_ROUTE');
  return await after(call,state,value)??Response.json(value);
 });
 const stop=controller.start(),unsubscribe=controller.subscribe(()=>phases.push(controller.getSnapshot().phase));
 return{controller,state,calls,saved,phases,emit:(...args)=>emit(...args),close(){unsubscribe();stop();}};
}
const writes=f=>f.calls.filter(c=>c.url===origin+BASE+'/apply');
const reads=f=>f.calls.filter(c=>c.url.startsWith(origin+BASE+'/batches/'));
const me=f=>f.calls.filter(c=>c.url.endsWith('/v1/me'));
async function mount(f,route=false){
 await until(()=>f.controller.getSnapshot().phase==='ready');
 if(!route)return mountComponent('FinancialImportReview.tsx',{controller:f.controller},{expandChildren:true,ports:{access},modules:{'../lib/real-access':'export const {AccessError,decimalMoney}=r.access;'}});
 const source=fileURLToPath(new URL('../src/components/CutoverReadiness.tsx',import.meta.url)),names=['CompanyPreferences','OriginPurchaseReadiness','OriginSalesReadiness','OriginSalesHistory','ItauLegacyReadiness','OriginWarehouseImport','OriginStockObservations','RealStockOpening','StockWarehouses','StockCount','StockDashboards','ReceiptCheckin','StockReports','Catalog','ProductTaxonomy','ProductExport','PriceLists','CustomFields','HistoryView','RealDocuments','RealStock','RealFinance','FinanceBorderos','FinanceScreens','RealCnab','RealCnabOperational','RealCnabOperationalReturns','RealReceivedDfe','RealFiscalNumbering','CertificateA1','CompanySettings','RealImportCatalog','RealImportProposals','RealHome','RealFiscalDrafts','DueDateReport','SyncedXmlHistory','IntegrationProgress','SefazConnection','RealFiscalInvoices','RealOperationNatures','FiscalEventList','RealPdv'];
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:'/preparacao-virada',expandChildren:true,ports:{access,controller:f.controller},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});',
  '../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://erp.synthetic.invalid"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}',
  './CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './native-modules':`export {default as CutoverReadiness} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
 }});
}
async function review(v){
 v.find(n=>n.type==='input'&&n.props['aria-label']==='Selecionar título 0001').props.onChange({target:{checked:true}});await v.flush();await v.click('Escolher categoria de 0001');await v.click('Manter este título sem categoria');await v.change('financial-import-duplicates',true);await v.click('Preparar prévia da importação');await v.change('financial-import-confirm',true);
}

test('039 synchronous capture preserves exact nested fields and rejects accessors without invoking them',()=>{
 const body=applyRequest(importRequest()),expected=structuredClone(body),cancel=new AbortController(),options={method:'POST',body,signal:cancel.signal};const captured=captureFinancialImportRequest(BASE+'/apply',options);
 body.items[0].source_id='999';body.items.length=0;options.method='GET';options.signal=new AbortController().signal;
 assert.deepEqual(captured.options.body,expected);assert.equal(captured.options.signal,cancel.signal);assert.ok(Object.isFrozen(captured.options.body.items[0]));assert.ok(Object.isFrozen(captured.options.body.items));
 let invoked=0;const getter=()=>{invoked++;return 'unsafe';};
 const optionGetter=Object.defineProperty({},'body',{get:getter}),bodyGetter=Object.defineProperty(applyRequest(importRequest()),'items',{get:getter}),arrayGetter=applyRequest(importRequest());Object.defineProperty(arrayGetter.items,'0',{get:getter});const itemGetter=applyRequest(importRequest());Object.defineProperty(itemGetter.items[0],'source_id',{get:getter});
 for(const value of [optionGetter,{method:'POST',body:bodyGetter},{method:'POST',body:arrayGetter},{method:'POST',body:itemGetter}])assert.throws(()=>captureFinancialImportRequest(BASE+'/apply',value));assert.equal(invoked,0);
 const bad=applyRequest(importRequest());bad.items.push({...bad.items[0]});assert.throws(()=>captureFinancialImportRequest(BASE+'/apply',{method:'POST',body:bad}));
});

test('039 credential refresh captures body and signal before await and sends only with verified new credential',async()=>{
 const gate=deferred(),f=setup({before(call){if(call.url.endsWith('/v1/me')&&call.options.headers.Authorization==='Bearer synthetic-renewed-token')return gate.promise;}});
 try{await until(()=>f.controller.getSnapshot().phase==='ready');f.emit('TOKEN_REFRESHED',session('synthetic-renewed-token'));await until(()=>me(f).length===2);
  const cancel=new AbortController(),counts={add:0,remove:0},add=cancel.signal.addEventListener.bind(cancel.signal),remove=cancel.signal.removeEventListener.bind(cancel.signal);cancel.signal.addEventListener=(...args)=>{counts.add++;return add(...args);};cancel.signal.removeEventListener=(...args)=>{counts.remove++;return remove(...args);};
  const body=applyRequest(importRequest()),expected=structuredClone(body),options={method:'POST',body,signal:cancel.signal},pending=f.controller.financialImport(BASE+'/apply',options);body.items[0].category_id=other;body.items.length=0;options.body={};options.signal=new AbortController().signal;
  await tick();assert.equal(writes(f).length,0);gate.resolve(Response.json(member()));await pending;assert.deepEqual(JSON.parse(writes(f)[0].options.body),expected);assert.equal(writes(f)[0].options.headers.Authorization,'Bearer synthetic-renewed-token');assert.deepEqual(counts,{add:1,remove:1});
 }finally{gate.resolve(Response.json(member()));f.close();}
});

test('039 admin lost during credential verification prevents dispatch and cancelled waits send nothing',async()=>{
 for(const cancelWait of [false,true]){const gate=deferred(),f=setup({before(call){if(call.url.endsWith('/v1/me')&&call.options.headers.Authorization==='Bearer synthetic-renewed-token')return gate.promise;}});
  try{await until(()=>f.controller.getSnapshot().phase==='ready');f.emit('TOKEN_REFRESHED',session('synthetic-renewed-token'));await until(()=>me(f).length===2);const cancel=new AbortController(),pending=f.controller.financialImport(BASE+'/apply',{method:'POST',body:applyRequest(importRequest()),signal:cancel.signal});const rejected=assert.rejects(pending,e=>cancelWait?e.name==='AbortError':e.status===403);if(cancelWait)cancel.abort();f.state.role='consulta';gate.resolve(Response.json(member('consulta')));await rejected;assert.equal(writes(f).length,0);assert.equal(f.saved.size,0);
  }finally{gate.resolve(Response.json(member('consulta')));f.close();}
 }
});

test('039 lost ACK then GET403 keeps same-actor intent through access revalidation and never rePOSTs',async()=>{
 const gate=deferred();let hold=false,lookups=0;const f=setup({before(call){if(hold&&call.url.endsWith('/v1/me'))return gate.promise;if(call.url.includes('/batches/')&&++lookups===1){hold=true;return new Response(null,{status:403});}},after(call){if(call.url===origin+BASE+'/apply')return new Response(null,{status:503});}});let v;
 try{v=await mount(f);await review(v);await v.click('Importar títulos revisados');assert.equal(f.saved.size,1);f.phases.length=0;await v.click('Consultar resultado do lote');await until(()=>me(f).length===2);assert.equal(writes(f).length,1);assert.equal(v.guard().busy,true);assert.ok(f.phases.every(p=>p==='ready'));assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Reenviar o mesmo lote'),false);
  gate.resolve(Response.json(member()));await v.flush();await v.click('Consultar resultado do lote');assert.equal(writes(f).length,1);assert.equal(reads(f).length,2);assert.ok(reads(f).every(c=>c.url.endsWith([...f.saved.keys()][0])));assert.match(v.text(),/Lote registrado e situação atual consultada/);
 }finally{gate.resolve(Response.json(member()));v?.unmount();f.close();}
});

test('039 real cutover route retains a committed intent hidden/inert on role loss; stale controls cannot discard or dispatch',async()=>{
 const gate=deferred(),f=setup({after(call){if(call.url===origin+BASE+'/apply')return gate.promise;}});let v;
 try{v=await mount(f,true);await v.click('Importar títulos em aberto');await review(v);const staleNav=v.button('Cobertura e backup').props.onClick,staleApply=v.button('Importar títulos revisados').props.onClick;await v.click('Importar títulos revisados');assert.equal(f.saved.size,1);const id=[...f.saved.keys()][0],staleRead=v.button('Consultar resultado do lote').props.onClick;
  f.state.role='consulta';f.emit('TOKEN_REFRESHED',session('synthetic-reduced-token'));await v.flush();gate.resolve(Response.json(f.saved.get(id)));await v.flush();staleNav();staleApply();staleRead();await v.flush();assert.equal(reads(f).length,0);assert.equal(writes(f).length,1);const hidden=v.find(n=>n.type==='div'&&n.props.hidden===true);assert.equal(hidden.props.inert,true);assert.equal(hidden.props['aria-hidden'],true);assert.match(v.text(),/Preparação não liberada/);
  f.state.role='admin';f.emit('TOKEN_REFRESHED',session('synthetic-restored-token'));await v.flush();assert.match(v.text(),/O lote foi registrado/);await v.click('Consultar situação atual');assert.equal(writes(f).length,1);assert.equal(reads(f).length,1);assert.ok(reads(f)[0].url.endsWith(id));assert.match(v.text(),/Lote registrado e situação atual consultada/);
 }finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});

for(const action of ['logout','actor'])test(`039 real route ${action} clears pending intent and ignores late ACK and old handlers`,async()=>{
 const gate=deferred(),f=setup({after(call){if(call.url===origin+BASE+'/apply')return gate.promise;}});let v;
 try{v=await mount(f,true);await v.click('Importar títulos em aberto');await review(v);await v.click('Importar títulos revisados');assert.equal(f.saved.size,1);const stale=v.button('Consultar resultado do lote').props.onClick;
  if(action==='logout')await f.controller.logout();else{f.state.actor=other;f.emit('SIGNED_IN',session('synthetic-other-token',other));}
  await v.flush();gate.resolve(Response.json([...f.saved.values()][0]));await v.flush();stale();await v.flush();assert.equal(reads(f).length,0);assert.equal(writes(f).length,1);assert.doesNotMatch(v.text(),/Consultar resultado do lote|Lote registrado e situação atual consultada/);if(action==='actor'){await v.click('Importar títulos em aberto');assert.equal(v.guard().changed,false);assert.doesNotMatch(v.text(),/[0-9a-f]{8}-[0-9a-f-]{27}/);}
 }finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});

test('039 route does not mount hidden financial data before first admin access',async()=>{
 const f=setup({role:'consulta'});let v;try{v=await mount(f,true);assert.match(v.text(),/Preparação não liberada/);assert.equal(f.calls.length,1);assert.equal(v.nodes().some(n=>n.type==='div'&&n.props.hidden===true),false);
  f.state.role='admin';f.emit('TOKEN_REFRESHED',session('synthetic-admin-token'));await v.flush();await v.click('Importar títulos em aberto');assert.match(v.text(),/Consultar lote já registrado/);assert.equal(v.guard().changed,false);assert.equal(writes(f).length,0);
 }finally{v?.unmount();f.close();}
});
