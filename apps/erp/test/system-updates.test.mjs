import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {createAccessController} from '../src/lib/real-access.ts';
import {resolvePreferences} from '../src/lib/origin-menu.ts';
import {parsePreferencesPath} from '../src/lib/preferences-route.ts';
import {UPDATE_PROGRESS_KEY} from '../src/lib/system-updates.ts';

const uid='a0000000-0000-4000-8000-000000000001';
const access=role=>({phase:'ready',membership:{user_id:uid,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false});
const available=()=>({protocol:1,installed:{version:'v0.2.0-dev.0',revision:'a'.repeat(40),installed_at:null},latest:{version:'v0.2.0',revision:'b'.repeat(40),notes:'Atualização de teste',manifest_sha256:'c'.repeat(64)},
 update_available:true,cloudflare_configured:true,can_apply:true,status:{state:'idle',phase:'ready',recovery_required:false,job_id:null,error:null,backup_id:null,updated_at:'2026-11-04T12:00:00Z'}});
const upToDate=()=>({...available(),installed:{...available().installed,version:'v0.2.0'},update_available:false,can_apply:false});
const checking=()=>({...upToDate(),status:{...available().status,state:'checking',phase:'search'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const applyButton=view=>view.nodes().find(n=>n.type==='button'&&n.props.className==='primary-button');
let originalStorage;
test.before(()=>{originalStorage=globalThis.sessionStorage;const values=new Map();globalThis.sessionStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};});
test.after(()=>{globalThis.sessionStorage=originalStorage;});

test('administrator finds the update page in Sistema; other roles do not receive this action',()=>{
 const entries=role=>resolvePreferences({role,resources:[]}).flatMap(c=>c.sections?.flatMap(s=>s.entries)||c.entries||[]);
 assert.ok(entries('admin').some(e=>e.to==='/preferencias/sistema/atualizacoes'));
 assert.equal(entries('vendas').some(e=>e.to==='/preferencias/sistema/atualizacoes'),false);
 assert.equal(parsePreferencesPath('/preferencias/sistema/atualizacoes').kind,'updates');
});
test('panel shows installed and available versions and starts the exact reviewed release',async()=>{
 const calls=[],controller={updates:async(action,options)=>{calls.push({action,body:options?.body});return {...available(),...(action==='apply'?{progress_token:'p'.repeat(43)}:{})};}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  assert.match(view.text(),/v0.2.0-dev.0/);assert.match(view.text(),/v0.2.0/);assert.equal(view.button('Atualizar agora').disabled,false);
  await view.click('Atualizar agora');const sent=calls.find(c=>c.action==='apply');
  assert.equal(sent.body.version,'v0.2.0');assert.equal(sent.body.manifest_sha256,'c'.repeat(64));assert.match(sent.body.request_id,/^[a-f0-9-]{36}$/);
  assert.equal(view.location().pathname,'/atualizacao');assert.equal(JSON.parse(sessionStorage.getItem(UPDATE_PROGRESS_KEY)).token,'p'.repeat(43));
 }finally{view.unmount();}
});
test('missing publication credentials and recovery state disable update activation',async()=>{
 for(const changes of[{cloudflare_configured:false},{status:{...available().status,recovery_required:true,state:'failed'}}]){
  const controller={updates:async()=>({...available(),...changes,can_apply:false})};const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
  try{assert.equal(view.button('Atualizar agora').disabled,true);}finally{view.unmount();}
 }
});
test('opening the page automatically checks and never confirms a cached version while the request is pending',async()=>{
 const reply=deferred(),calls=[];
 const controller={updates:async action=>{calls.push(action);return action==='check'?reply.promise:upToDate();}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  assert.deepEqual(calls,['status','check']);assert.match(view.text(),/Verificando…/);
  assert.match(view.text(),/Última versão conhecida: v0.2.0/);assert.doesNotMatch(view.text(),/Você está na versão mais recente/);
  assert.equal(applyButton(view).disabled,true);
  reply.resolve({...available(),latest:{...available().latest,version:'v0.2.1'}});await view.flush();
  assert.match(view.text(),/v0.2.1/);assert.match(view.text(),/Uma nova versão está disponível/);
  assert.match(view.text(),/Verificado em/);assert.equal(view.button('Atualizar agora').disabled,false);
  assert.equal(calls.includes('apply'),false);
 }finally{view.unmount();}
});
test('the same version is confirmed only by a fresh check and reopening checks again',async()=>{
 const calls=[],controller={updates:async action=>{calls.push(action);return upToDate();}};
 for(let visit=0;visit<2;visit++){
  const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
  try{
   assert.match(view.text(),/Você está na versão mais recente disponível/);
   assert.equal(view.find(n=>n.type==='time').props.dateTime,'2026-11-04T12:00:00Z');
   assert.equal(view.button('Atualizar agora').disabled,true);
  }finally{view.unmount();}
 }
 assert.deepEqual(calls,['status','check','status','check']);
});
test('an asynchronous check finishes through status polling without repeated checks',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const calls=[];let server=upToDate();
 const controller={updates:async action=>{calls.push(action);return action==='check'?checking():server;}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  assert.match(view.text(),/Verificando…/);assert.equal(applyButton(view).disabled,true);
  server=available();t.mock.timers.tick(5000);await view.flush();
  assert.match(view.text(),/Uma nova versão está disponível/);assert.equal(view.button('Atualizar agora').disabled,false);
  t.mock.timers.tick(5000);await view.flush();
  assert.deepEqual(calls,['status','check','status','status']);
 }finally{view.unmount();}
});
test('a check already running is followed without posting a duplicate',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const calls=[];let server=checking();const controller={updates:async action=>{calls.push(action);return server;}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  assert.match(view.text(),/Verificando…/);assert.deepEqual(calls,['status']);
  server=upToDate();t.mock.timers.tick(5000);await view.flush();
  assert.match(view.text(),/Você está na versão mais recente disponível/);assert.deepEqual(calls,['status','status']);
 }finally{view.unmount();}
});
test('a failed check stays unverified despite later cached status and can be retried',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let fail=true;const calls=[],controller={updates:async action=>{calls.push(action);if(action==='check'&&fail)throw new Error('offline');return upToDate();}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  assert.match(view.text(),/Não foi possível verificar/);assert.equal(applyButton(view).disabled,true);
  t.mock.timers.tick(5000);await view.flush();
  assert.match(view.text(),/Não foi possível verificar/);assert.doesNotMatch(view.text(),/Você está na versão mais recente/);
  fail=false;await view.click('Verificar atualizações');
  assert.match(view.text(),/Você está na versão mais recente disponível/);assert.doesNotMatch(view.text(),/Não foi possível verificar/);
  assert.deepEqual(calls,['status','check','status','check']);
 }finally{view.unmount();}
});
test('an asynchronous server check failure is distinct from an installation failure',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let server=checking();const controller={updates:async()=>server};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  server={...upToDate(),status:{...available().status,state:'failed',phase:'search',error:'UPDATE_OPERATION_FAILED'}};
  t.mock.timers.tick(5000);await view.flush();
  assert.match(view.text(),/Não foi possível verificar/);assert.doesNotMatch(view.text(),/Não foi possível concluir a atualização|Você está na versão mais recente/);
  server=upToDate();t.mock.timers.tick(5000);await view.flush();
  assert.match(view.text(),/Não foi possível verificar/);
 }finally{view.unmount();}
});
test('queued, running and recovery operations suppress automatic and manual checks',async()=>{
 for(const status of[{state:'queued'},{state:'running'},{state:'failed',recovery_required:true}]){
  const calls=[],controller={updates:async action=>{calls.push(action);return{...upToDate(),status:{...available().status,...status}};}};
  const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
  try{
   assert.deepEqual(calls,['status']);assert.match(view.text(),/Verificação pendente/);
   assert.doesNotMatch(view.text(),/Você está na versão mais recente/);
   assert.equal(view.button('Verificar atualizações').disabled,true);assert.equal(applyButton(view).disabled,true);
  }finally{view.unmount();}
 }
});
test('a channel without public releases is verified without claiming the installation is current',async()=>{
 const controller={updates:async action=>action==='status'?upToDate():{...upToDate(),latest:null,status:{...available().status,phase:'idle',error:'NO_PUBLIC_RELEASE'}}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  assert.match(view.text(),/Sem release pública/);assert.match(view.text(),/Verificado em/);
  assert.doesNotMatch(view.text(),/Você está na versão mais recente|Última versão conhecida/);assert.equal(applyButton(view).disabled,true);
 }finally{view.unmount();}
});
test('an older poll cannot replace a newer manual verification',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const stale=deferred();let reads=0,checks=0;
 const controller={updates:async action=>action==='status'?(++reads===2?stale.promise:available()):{...available(),latest:{...available().latest,version:++checks===1?'v0.2.0':'v0.2.1'}}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  t.mock.timers.tick(5000);await view.flush();await view.click('Verificar atualizações');
  stale.resolve(upToDate());await view.flush();
  assert.match(view.text(),/v0.2.1/);assert.doesNotMatch(view.text(),/Você está na versão mais recente/);
  assert.equal(view.button('Atualizar agora').disabled,false);
 }finally{view.unmount();}
});
test('changing administrator aborts the old check and ignores its late response',async()=>{
 const old=deferred(),signals=[];let checks=0;
 const controller={updates:async(action,options)=>{signals.push(options.signal);return action==='check'&&++checks===1?old.promise:available();}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{
  await view.updateProps({state:{...access('admin'),membership:{...access('admin').membership,user_id:'a0000000-0000-4000-8000-000000000002'}}});
  assert.equal(signals[0].aborted,true);assert.equal(checks,2);
  old.resolve(upToDate());await view.flush();
  assert.match(view.text(),/Uma nova versão está disponível/);assert.doesNotMatch(view.text(),/Você está na versão mais recente/);
 }finally{view.unmount();}
 assert.ok(signals.every(signal=>signal.aborted));
});
test('leaving before the initial status resolves never starts a release check',async()=>{
 const reply=deferred(),calls=[],controller={updates:async action=>{calls.push(action);return reply.promise;}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 view.unmount();reply.resolve(upToDate());await view.flush();assert.deepEqual(calls,['status']);
});
test('a non-administrator never queries the updater',async()=>{
 const calls=[],controller={updates:async action=>{calls.push(action);return available();}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('vendas')});
 try{assert.deepEqual(calls,[]);assert.match(view.text(),/Somente administradores/);}finally{view.unmount();}
});
test('uncertain apply response keeps the idempotency key for a retry',async()=>{
 const calls=[],controller={updates:async(action,options)=>{if(action==='apply'){calls.push(options.body);throw new Error('network failed');}return available();}};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{await view.click('Atualizar agora');await view.click('Atualizar agora');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);}finally{view.unmount();}
});
test('disabled session storage still opens the independent progress page',async()=>{
 const storage=globalThis.sessionStorage;
 globalThis.sessionStorage={getItem(){throw new Error('disabled');},setItem(){throw new Error('disabled');},removeItem(){throw new Error('disabled');}};
 const controller={updates:async action=>({...available(),...(action==='apply'?{progress_token:'p'.repeat(43)}:{})})};
 const view=await mountComponent('SystemUpdates.tsx',{controller,state:access('admin')});
 try{await view.click('Atualizar agora');assert.equal(view.location().pathname,'/atualizacao');assert.equal(view.location().state.progress.token,'p'.repeat(43));}
 finally{view.unmount();globalThis.sessionStorage=storage;}
});
test('controller refuses non-administrators before issuing an update API call',async()=>{
 const calls=[],session={access_token:'synthetic-session',user:{id:uid}};
 const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})};
 const controller=createAccessController(auth,'https://api.example.test',async url=>{calls.push(url);return Response.json(access('vendas').membership);});
 const stop=controller.start();await new Promise(resolve=>setTimeout(resolve,10));
 try{await assert.rejects(()=>controller.updates('check'),error=>error.status===403);assert.equal(calls.length,1);}finally{stop();}
});
