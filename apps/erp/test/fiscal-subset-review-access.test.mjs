import './helpers/synthetic-october-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as access from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {authorizationQaCandidate} from '../src/qa/authorization-fixture.ts';
import {actor,candidateId,otherActor} from '../../../packages/fiscal-authorization-http/test/fixtures.mjs';
import {context,result,saveBody} from '../../../packages/fiscal-authorization-runtime/test/review-fixtures.mjs';

const BASE='/v1/fiscal-authorization',path=`${BASE}/candidates/${candidateId}/review`,origin='https://review.synthetic.invalid';
const token='synthetic-subset-original-token',nextToken='synthetic-subset-renewed-token';
const session=(value=token,id=actor)=>({access_token:value,user:{id}});
const member=(role='fiscal',id=actor)=>({user_id:id,role,resources:['nfe','nfce'],data_mode:'staging_readonly'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate){for(let i=0;i<200&&!predicate();i++)await tick();assert.ok(predicate(),'bounded fixture wait');}
const candidate=()=>({...authorizationQaCandidate(),candidate_id:candidateId});
function setup({role='fiscal',before=()=>{},after=()=>{}}={}){
 let emit=()=>{};const state={role,actor},calls=[],saved=new Map(),phases=[];
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{emit('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=access.createAccessController(auth,'https://erp.synthetic.invalid',async(url,options)=>{
  const call={url,options};calls.push(call);const custom=await before(call,state);if(custom)return custom;
  let value;if(url.endsWith('/v1/me'))value=member(state.role,state.actor);
  else if(url===origin+path&&options.method==='POST'){
   const body=JSON.parse(options.body);value=result('save',body);value.receipt.reviewed_by=state.actor;saved.set(body.command_id,value);
  }else if(url===origin+path&&options.method==='GET'){
   value=context();const latest=[...saved.values()].at(-1);if(latest)value.review={matches_profile:true,receipt:latest.receipt,current:latest.current,declaration:latest.declaration};
  }else if(url.startsWith(origin+BASE+'/review-commands/')&&options.method==='GET'){
   const id=url.split('/').at(-1),known=saved.get(id);assert.ok(known,'lookup is bound to an actually committed synthetic command');value={...structuredClone(known),kind:'command',read_only:true,replayed:false};
  }else throw Error('UNEXPECTED_REVIEW_ROUTE');
  return await after(call,state,value)??Response.json(value);
 },{a1ApiUrl:origin});
 const stop=controller.start(),unsubscribe=controller.subscribe(()=>phases.push(controller.getSnapshot().phase));
 return{controller,state,calls,saved,phases,emit:(...args)=>emit(...args),close(){unsubscribe();stop();}};
}
const writes=f=>f.calls.filter(c=>c.url===origin+path&&c.options.method==='POST');
const commands=f=>f.calls.filter(c=>c.url.startsWith(origin+BASE+'/review-commands/'));
const me=f=>f.calls.filter(c=>c.url.endsWith('/v1/me'));
async function mount(f,{route=false}={}){
 await until(()=>f.controller.getSnapshot().phase==='ready');
 const options={ports:{access,candidate:candidate()},modules:{'../lib/real-access':'export const {AccessError,decimalMoney}=r.access;'}};
 if(!route)return mountComponent('FiscalSubsetReview.tsx',{controller:f.controller,candidate:candidate()},options);
 const source=fileURLToPath(new URL('../src/components/FiscalSubsetReview.tsx',import.meta.url)),names=['CompanyPreferences','OriginPurchaseReadiness','OriginSalesReadiness','OriginSalesHistory','ItauLegacyReadiness','OriginWarehouseImport','OriginStockObservations','RealStockOpening','StockWarehouses','StockCount','StockDashboards','ReceiptCheckin','StockReports','Catalog','ProductTaxonomy','ProductExport','PriceLists','CustomFields','HistoryView','RealDocuments','RealStock','RealFinance','FinanceBorderos','FinanceScreens','RealCnab','RealCnabOperational','RealCnabOperationalReturns','RealReceivedDfe','RealFiscalNumbering','CertificateA1','CompanySettings','RealImportCatalog','RealImportProposals','RealHome','CutoverReadiness','DueDateReport','SyncedXmlHistory','IntegrationProgress','SefazConnection','RealFiscalInvoices','RealOperationNatures','FiscalEventList','RealPdv'];
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:'/emissor-fiscal',expandChildren:true,ports:{access,controller:f.controller,candidate:candidate()},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});',
  '../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://erp.synthetic.invalid"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}',
  './CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './native-modules':`import Review from ${JSON.stringify(source)};import {jsx} from 'react/jsx-runtime';export function RealFiscalDrafts({controller}){return jsx(Review,{controller,candidate:r.candidate});}${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
 }});
}
async function editAndSave(v){
 await v.click('Conferir dados fiscais');
 const validity=v.find(n=>n.type==='input'&&n.props['aria-label']==='Validade da revisão (São Paulo)');
 validity.props.onChange({target:{value:'2026-10-25T12:00'}});await v.flush();
 await v.click('Salvar revisão fiscal');
}

test('068 real controller restricts roles/routes and never opens run, recover or fiscal ports',async()=>{
 for(const role of ['admin','fiscal']){const f=setup({role});try{await until(()=>f.controller.getSnapshot().phase==='ready');assert.equal((await f.controller.fiscalSubsetReview(path)).candidate.candidate_id,candidateId);}finally{f.close();}}
 for(const role of ['consulta','vendas','financeiro','estoque']){const f=setup({role});try{await until(()=>f.controller.getSnapshot().phase==='ready');await assert.rejects(f.controller.fiscalSubsetReview(path),e=>e.status===403);assert.equal(f.calls.filter(c=>c.url.startsWith(origin)).length,0);}finally{f.close();}}
 const f=setup();try{await until(()=>f.controller.getSnapshot().phase==='ready');for(const [url,options]of [[path+'?x=1',{}],[path,{method:'PUT'}],[path,{body:undefined}],[BASE+'/run',{method:'POST',body:{}}],[BASE+'/recover',{method:'POST',body:{}}]])await assert.rejects(f.controller.fiscalSubsetReview(url,options),e=>e.status===400);assert.equal(f.calls.filter(c=>c.url.startsWith(origin)).length,0);}finally{f.close();}
});

test('068 lost ACK403 keeps the UI intent through same-actor revalidation and recovers only by command GET',async()=>{
 const membership=deferred();let hold=false;
 const f=setup({before(call){if(hold&&call.url.endsWith('/v1/me'))return membership.promise;},after(call){if(call.url===origin+path&&call.options.method==='POST'){hold=true;return Response.json({error:'AUTHORIZATION_FORBIDDEN',recovery_required:true,command_id:JSON.parse(call.options.body).command_id},{status:403});}}});
 let v;try{v=await mount(f);f.phases.length=0;await editAndSave(v);await until(()=>me(f).length===2);assert.equal(f.saved.size,1);assert.equal(writes(f).length,1);assert.equal(commands(f).length,0);assert.match(v.text(),/resultado ainda não foi confirmado/);assert.equal(v.guard().changed,true);assert.ok(f.phases.every(p=>p==='ready'));
  membership.resolve(Response.json(member()));await v.flush();assert.equal(f.controller.getSnapshot().phase,'ready');await v.click('Consultar resultado da revisão');assert.equal(writes(f).length,1);assert.equal(commands(f).length,1);assert.equal(commands(f)[0].url.split('/').at(-1),[...f.saved.keys()][0]);assert.match(v.text(),/Revisão salva e conferida/);assert.equal(v.guard().changed,false);
 }finally{membership.resolve(Response.json(member()));v?.unmount();f.close();}
});

test('068 credential refresh captures body and signal before awaiting membership; no write uses the old token',async()=>{
 const membership=deferred(),f=setup({before(call){if(call.url.endsWith('/v1/me')&&call.options.headers.Authorization===`Bearer ${nextToken}`)return membership.promise;}});
 try{await until(()=>f.controller.getSnapshot().phase==='ready');f.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(f).length===2);
  const cancel=new AbortController(),counts={add:0,remove:0},add=cancel.signal.addEventListener.bind(cancel.signal),remove=cancel.signal.removeEventListener.bind(cancel.signal);cancel.signal.addEventListener=(...args)=>{counts.add++;return add(...args);};cancel.signal.removeEventListener=(...args)=>{counts.remove++;return remove(...args);};
  const body=saveBody(),expected=structuredClone(body),options={method:'POST',body,signal:cancel.signal},pending=f.controller.fiscalSubsetReview(path,options);body.command_id=otherActor;body.choices.document.operation='outside_scope';options.method='GET';options.signal=new AbortController().signal;
  await tick();assert.equal(writes(f).length,0);membership.resolve(Response.json(member()));const ack=await pending;assert.equal(ack.command_id,expected.command_id);assert.deepEqual(JSON.parse(writes(f)[0].options.body),expected);assert.equal(writes(f)[0].options.headers.Authorization,`Bearer ${nextToken}`);assert.deepEqual(counts,{add:1,remove:1});
  let invoked=0;const bad=Object.defineProperty({},'signal',{enumerable:true,get(){invoked++;return undefined;}});await assert.rejects(f.controller.fiscalSubsetReview(path,bad),e=>e.status===400);assert.equal(invoked,0);
 }finally{membership.resolve(Response.json(member()));f.close();}
});

test('068 real route retains committed pending review through role loss, hides it and permits only GET recovery after restore',async()=>{
 const gate=deferred(),f=setup({after(call){if(call.url===origin+path&&call.options.method==='POST')return gate.promise;}});let v;
 try{v=await mount(f,{route:true});await editAndSave(v);assert.equal(f.saved.size,1);const id=[...f.saved.keys()][0],oldLookup=v.button('Consultar resultado da revisão').props.onClick;
  f.state.role='vendas';f.emit('TOKEN_REFRESHED',session(nextToken));await v.flush();gate.resolve(Response.json(f.saved.get(id)));await v.flush();
  assert.doesNotMatch(v.text(),/SYNTHETIC PRODUCT/);oldLookup();await v.flush();assert.equal(commands(f).length,0);const hidden=v.find(n=>n.type==='div'&&n.props.hidden===true);assert.equal(hidden.props.inert,true);assert.equal(hidden.props['aria-hidden'],true);
  f.state.role='fiscal';f.emit('TOKEN_REFRESHED',session('synthetic-subset-restored-token'));await v.flush();assert.match(v.text(),/Consultar resultado da revisão/);await v.click('Consultar resultado da revisão');
  assert.equal(writes(f).length,1);assert.equal(commands(f).length,1);assert.equal(commands(f)[0].url.split('/').at(-1),id);assert.match(v.text(),/Revisão salva e conferida/);
 }finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});

for(const action of ['logout','actor'])test(`068 real route ${action} clears UI intent and prevents late readback or data adoption`,async()=>{
 const gate=deferred(),f=setup({after(call){if(call.url===origin+path&&call.options.method==='POST')return gate.promise;}});let v;
 try{v=await mount(f,{route:true});await editAndSave(v);assert.equal(f.saved.size,1);const oldButton=v.button('Consultar resultado da revisão').props.onClick;
  if(action==='logout')await f.controller.logout();else{f.state.actor=otherActor;f.emit('SIGNED_IN',session(nextToken,otherActor));}
  await v.flush();gate.resolve(Response.json([...f.saved.values()][0]));await v.flush();oldButton();await v.flush();assert.equal(commands(f).length,0);assert.equal(writes(f).length,1);assert.doesNotMatch(v.text(),/Consultar resultado da revisão|SYNTHETIC PRODUCT|Revisão salva e conferida/);if(action==='actor')assert.equal(v.guard().changed,false);
 }finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});

test('068 route never mounts fiscal data for a never-authorized actor; later grant starts with an empty panel',async()=>{
 const f=setup({role:'vendas'});let v;try{v=await mount(f,{route:true});assert.match(v.text(),/Preparação fiscal não liberada/);assert.equal(v.nodes().some(n=>n.type==='div'&&n.props.hidden===true),false);assert.equal(f.calls.filter(c=>c.url.startsWith(origin)).length,0);
  f.state.role='fiscal';f.emit('TOKEN_REFRESHED',session(nextToken));await v.flush();assert.match(v.text(),/Conferir dados fiscais/);assert.doesNotMatch(v.text(),/SYNTHETIC PRODUCT|Consultar resultado da revisão/);assert.equal(f.calls.filter(c=>c.url.startsWith(origin)).length,0);
 }finally{v?.unmount();f.close();}
});

test('real controller command404 after503 exposes only explicit identical retry, including a previously persisted receipt',async()=>{
 for(const committed of [false,true]){let posts=0,reads=0;const f=setup({before(call){if(call.url===origin+path&&call.options.method==='POST'){posts++;if(posts===1&&!committed)return Response.json({error:'AUTHORIZATION_RUNTIME_FAILED',recovery_required:true,command_id:JSON.parse(call.options.body).command_id},{status:503});}if(call.url.includes('/review-commands/')&&++reads<=2)return Response.json({error:reads===1?'AUTHORIZATION_RUNTIME_FAILED':'AUTHORIZATION_NOT_FOUND',recovery_required:false},{status:reads===1?503:404});},after(call){if(committed&&call.url===origin+path&&call.options.method==='POST'&&posts===1)return Response.json({error:'AUTHORIZATION_RUNTIME_FAILED',recovery_required:true,command_id:JSON.parse(call.options.body).command_id},{status:503});}});let v;
  try{v=await mount(f);await editAndSave(v);const original=writes(f)[0].options.body;assert.equal(f.saved.size,committed?1:0);assert.match(v.text(),new RegExp(JSON.parse(original).command_id));await v.click('Consultar resultado da revisão');assert.doesNotMatch(v.text(),/Repetir o mesmo salvamento/);await v.click('Consultar resultado da revisão');assert.equal(writes(f).length,1);assert.match(v.text(),/Repetir o mesmo salvamento/);await v.click('Repetir o mesmo salvamento');assert.equal(writes(f).length,2);assert.equal(writes(f)[1].options.body,original);assert.equal(f.saved.size,1);assert.equal([...f.saved.values()][0].receipt.review_version,1);assert.ok(commands(f).every(c=>c.url.endsWith(JSON.parse(original).command_id)));assert.match(v.text(),/Revisão salva e conferida/);assert.equal(v.guard().changed,false);
  }finally{v?.unmount();f.close();}}
});
test('real controller rechecks permission during explicit retry credential refresh and retains the uncertain UUID',async()=>{
 const membership=deferred();let refreshing=false;const f=setup({before(call){if(call.url.endsWith('/v1/me')&&refreshing)return membership.promise;if(call.url===origin+path&&call.options.method==='POST')return Response.json({error:'AUTHORIZATION_RUNTIME_FAILED',recovery_required:true,command_id:JSON.parse(call.options.body).command_id},{status:503});if(call.url.includes('/review-commands/'))return Response.json({error:'AUTHORIZATION_NOT_FOUND',recovery_required:false},{status:404});}});let v;
 try{v=await mount(f);await editAndSave(v);const original=JSON.parse(writes(f)[0].options.body);await v.click('Consultar resultado da revisão');const stale=v.button('Repetir o mesmo salvamento').props.onClick;refreshing=true;f.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(f).length===2);stale();await v.flush();assert.equal(writes(f).length,1);membership.resolve(Response.json(member('consulta')));await v.flush();assert.equal(writes(f).length,1);assert.doesNotMatch(v.text(),new RegExp(original.command_id));assert.equal(v.guard().changed,true);
  refreshing=false;f.state.role='fiscal';f.emit('TOKEN_REFRESHED',session('synthetic-review-retry-restored'));await v.flush();stale();await v.flush();assert.equal(writes(f).length,1);assert.match(v.text(),new RegExp(original.command_id));assert.doesNotMatch(v.text(),/Repetir o mesmo salvamento/);await v.click('Consultar resultado da revisão');assert.match(v.text(),/Repetir o mesmo salvamento/);
 }finally{membership.resolve(Response.json(member()));v?.unmount();f.close();}
});
