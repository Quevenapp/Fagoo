import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {ACTOR,OTHER,BASE,page,detail,deferred} from './helpers/sales-history-fixtures.mjs';
import * as access from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {resolvePreferences} from '../src/lib/origin-menu.ts';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
const tick=()=>new Promise(r=>setTimeout(r,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
const session={access_token:'synthetic-token-083',user:{id:ACTOR}},me=role=>({user_id:ACTOR,role,resources:[],data_mode:'staging_readonly'});
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
test('083 real controller rejects other roles and every mutation without business fetch',async()=>{
 for(const role of ['admin','consulta','vendas','financeiro','estoque','fiscal']){
  let calls=0;const c=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me(role)):(calls++,Response.json(page()))),stop=c.start();await tick();
  try{if(role!=='admin')await assert.rejects(()=>c.salesHistory(BASE),status(403));else{
   for(const options of [{method:'POST'},{method:'PATCH'},{body:{}}])await assert.rejects(()=>c.salesHistory(BASE,options),status(400));
   for(const p of [BASE+'?actor='+ACTOR,BASE+'/../inicio',BASE+'/%31',BASE+'?limit=26'])await assert.rejects(()=>c.salesHistory(p),status(400));
  }assert.equal(calls,0);}finally{stop();}
 }
});
test('083 real controller captures GET options and enforces response size',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.synthetic.test',async(url,o)=>url.endsWith('/me')?Response.json(me('admin')):(calls.push({url,o}),Response.json(page()))),stop=c.start();await tick();
 try{const options={method:'GET'},result=c.salesHistory(BASE+'?limit=25',options);options.method='POST';options.body={changed:true};await result;assert.equal(calls.length,1);assert.equal(calls[0].o.method,'GET');assert.equal(calls[0].o.body,undefined);assert.equal(calls[0].o.headers.Authorization,'Bearer synthetic-token-083');assert.equal(calls[0].o.redirect,'error');}finally{stop();}
 const large=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me('admin')):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'1048577'}})),end=large.start();await tick();try{await assert.rejects(()=>large.salesHistory(BASE),status(502));}finally{end();}
});
test('083 logout suppresses late data and current permission loss prevents the next query',async()=>{
 const gate=deferred();let signal;const c=createAccessController(auth,'https://api.synthetic.test',async(url,o)=>url.endsWith('/me')?Response.json(me('admin')):(signal=o.signal,gate.promise)),stop=c.start();await tick();
 const read=c.salesHistory(BASE);await tick();await c.logout();gate.resolve(Response.json(page()));await assert.rejects(read,e=>e.name==='AbortError');assert.equal(signal.aborted,true);stop();
 let checks=0,calls=0;const changed=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me(++checks===1?'admin':'consulta')):(calls++,Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403}))),end=changed.start();await tick();
 try{await assert.rejects(()=>changed.salesHistory(BASE),status(403));await tick();await assert.rejects(()=>changed.salesHistory(BASE),status(403));assert.equal(calls,1);assert.equal(changed.getSnapshot().membership.role,'consulta');}finally{end();}
});

test('083 token refresh rechecks admin before dispatch and preserves the captured GET',async()=>{
 let emit,checks=0,role='admin',block=null,calls=0;
 const a={...auth,onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};}};
 const c=createAccessController(a,'https://api.synthetic.test',async(url,o)=>{
  if(url.endsWith('/me')){checks++;if(block)await block.promise;return Response.json(me(role));}
  calls++;assert.equal(o.method,'GET');assert.equal(o.body,undefined);return Response.json(page());
 }),stop=c.start();await tick();
 try{
  block=deferred();emit('TOKEN_REFRESHED',{...session,access_token:'synthetic-refreshed'});await tick();
  const options={method:'GET'},r=c.salesHistory(BASE,options);options.method='POST';options.body={actor:OTHER};role='consulta';block.resolve();
  await assert.rejects(r,status(403));assert.equal(calls,0);assert.ok(checks>=2);
 }finally{block?.resolve();stop();}
});

async function mountRoute(controller){
 const source=fileURLToPath(new URL('../src/components/OriginSalesHistory.tsx',import.meta.url));
 const names=[...String(await readFile(new URL('../src/components/native-modules.ts',import.meta.url),'utf8')).matchAll(/export const (\w+) = lazy/g)].map(x=>x[1]).filter(x=>x!=='OriginSalesHistory');
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:'/historico-vendas-origin',expandChildren:true,ports:{access,controller},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});',
  '../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://api.synthetic.test"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}',
  './CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './native-modules':`export {default as OriginSalesHistory} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
 }});
}
test('083 authenticated route loads only for admin and hides detail after current role changes',async()=>{
 let emit,role='admin',gets=0;const a={...auth,onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};}};
 const c=createAccessController(a,'https://api.synthetic.test',async(url,o)=>{
  if(url.endsWith('/me'))return Response.json(me(role));gets++;assert.equal(o.method,'GET');assert.equal(o.body,undefined);return Response.json(url.includes('?')?page():detail());
 });
 const v=await mountRoute(c);try{await v.click('Consultar histórico 100001');assert.match(v.text(),/Componente demonstrativo preservado/);const old=v.button('Atualizar consulta').props.onClick;role='consulta';emit('TOKEN_REFRESHED',{...session,access_token:'synthetic-next'});await v.flush();old();await v.flush();assert.doesNotMatch(v.text(),/Componente demonstrativo preservado|Cliente demonstrativo preservado/);assert.match(v.text(),/Somente administradores/);assert.equal(gets,2);}finally{v.unmount();}
 for(const denied of ['vendas','financeiro','estoque','fiscal','consulta']){
  let reads=0;const x=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me(denied)):(reads++,Response.json(page()))),view=await mountRoute(x);
  try{assert.match(view.text(),/Somente administradores/);assert.equal(reads,0);}finally{view.unmount();}
 }
});
test('083 Preferências expose the entry only for an active administrator',async()=>{
 // Since 19/10/2026 Brufap-only tools sit in Preferências (gear), as in Origin; the daily menus stay Origin-exact.
 for(const role of ['admin','consulta','vendas','financeiro','estoque','fiscal']){
  const v=await mountComponent('PreferencesPage.tsx',{homeTo:'/acesso',initialCategory:'integracoes',categories:resolvePreferences({role,resources:[]})});
  try{const links=v.nodes().filter(n=>n.props?.to==='/historico-vendas-origin');assert.equal(links.length,role==='admin'?1:0);}finally{v.unmount();}
 }
});
