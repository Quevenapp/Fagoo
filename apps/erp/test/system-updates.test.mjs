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
 update_available:true,cloudflare_configured:true,can_apply:true,status:{state:'idle',phase:'ready',recovery_required:false,job_id:null,error:null,backup_id:null}});
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
