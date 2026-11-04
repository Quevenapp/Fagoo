import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {readFile} from 'node:fs/promises';
import * as access from '../src/lib/real-access.ts';import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {createStockObservationsFixture} from '../src/qa/stock-observations-fixture.ts';
import {createWarehouseImportFixture,warehouseQaResult} from '../src/qa/warehouse-import-fixture.ts';
import {stockObservationsListPath,stockObservationsHref,stockObservationsRouteSource} from '../src/lib/origin-stock-observations-request.ts';
const ACTOR='87000000-0000-4000-8000-000000000001',OTHER='87000000-0000-4000-8000-000000000002',tick=()=>new Promise(r=>setTimeout(r,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
function setup({role='admin',history=true,before=()=>{}}={}){const f=createStockObservationsFixture();let currentRole=role,actor=ACTOR,emit,meGate;const calls=[];
 const auth={getSession:async()=>({data:{session:{access_token:'synthetic087',user:{id:ACTOR}}},error:null}),onAuthStateChange:fn=>(emit=fn,{data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
 const controller=access.createAccessController(auth,'https://api.synthetic.test',async(url,o)=>{if(url.endsWith('/me')){if(meGate)await meGate.promise;return Response.json({user_id:actor,role:currentRole,resources:[],data_mode:'staging_readonly',capabilities:{originHistory:history}});}const path=new URL(url).pathname+new URL(url).search,call={path,...o};calls.push(call);await before(call);return Response.json(await f.controller.stockObservations(path,{method:o.method,signal:o.signal}));});
 return{controller,calls,refresh(r,gate){currentRole=r;meGate=gate;emit('TOKEN_REFRESHED',{access_token:'renewed087',user:{id:actor}});},changeActor(){actor=OTHER;emit('SIGNED_IN',{access_token:'other087',user:{id:actor}});}};
}
test('087 current controller captures GET before refresh and refuses a role lost during refresh',async()=>{
 for(const role of['admin','consulta']){const f=setup(),stop=f.controller.start();await tick();try{const gate=deferred();f.refresh(role,gate);const options={method:'GET'},p=f.controller.stockObservations(stockObservationsListPath('007'),options);options.method='POST';options.body={quantity:1};gate.resolve();if(role==='admin'){await p;assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');assert.equal(f.calls[0].body,undefined);}else{await assert.rejects(p,e=>e.status===403);assert.equal(f.calls.length,0);}}finally{stop();}}
});
test('087 controller rejects malformed calls before any fetch and drops a late response after actor change',async()=>{
 const hold=deferred(),f=setup({before:()=>hold.promise}),stop=f.controller.start();await tick();try{
  for(const [path,options]of[['/v1/estoque',{}],[stockObservationsListPath('007'),{method:'POST'}],[stockObservationsListPath('007'),{body:{}}]])await assert.rejects(()=>f.controller.stockObservations(path,options),e=>e.status===400);
  assert.equal(f.calls.length,0);const p=f.controller.stockObservations(stockObservationsListPath('007'));await tick();f.changeActor();await tick();hold.resolve();await assert.rejects(p);assert.equal(f.calls.length,1);
 }finally{hold.resolve();stop();}
});
async function mountRoute(controller,location=stockObservationsHref('007')){
 const source=fileURLToPath(new URL('../src/components/OriginStockObservations.tsx',import.meta.url)),names=[...String(await readFile(new URL('../src/components/native-modules.ts',import.meta.url),'utf8')).matchAll(/export const (\w+) = lazy/g)].map(x=>x[1]).filter(n=>n!=='OriginStockObservations');
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location,expandChildren:true,ports:{access,controller},modules:{'../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;','@supabase/supabase-js':'export const createClient=()=>({auth:{}});','../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://api.synthetic.test"});','./NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}','./CompanyNavigation':'export default function CompanyNavigation(){return null;}','./native-modules':`export {default as OriginStockObservations} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`}});
}
test('087 real route is admin-only and exact warehouse query is mandatory, without fallback native reads',async()=>{
 for(const role of['admin','consulta','estoque','vendas','fiscal','financeiro']){const f=setup({role}),v=await mountRoute(f.controller);try{assert.equal(f.calls.length,role==='admin'?1:0);assert.match(v.text(),role==='admin'?/Geral demonstrativo/:/administrador/);}finally{v.unmount();}}
 for(const query of['','?deposito=0','?deposito=007&deposito=008','?deposito=007&other=1']){const f=setup(),v=await mountRoute(f.controller,'/preparacao-virada/depositos/estoque'+query);try{assert.equal(f.calls.length,0);assert.match(v.text(),/Selecione um depósito vinculado/);}finally{v.unmount();}}
 assert.equal(stockObservationsRouteSource('?deposito=007'),'007');assert.equal(stockObservationsRouteSource('?deposito=7'),'7');
});
test('087 warehouse shortcut only opens a bound current selection and respects deferred leave/session guards',async()=>{
 let next;const seen=[],f=createWarehouseImportFixture({after(c,p){if(c.path.endsWith('/preview')){const result=warehouseQaResult({command_id:'86000000-0000-4000-8000-000000000099',expected_source_hash:'a'.repeat(64),expected_source_version:'1',preview_hash:'b'.repeat(64),confirmed:true});return{...p,existing:result.receipt.binding,current:result.current,can_create:false,planned:null,preview_hash:null};}return p;}});
 const v=await mountComponent('OriginWarehouseImport.tsx',{controller:f.controller,onStockObservations:id=>seen.push(id)},{expandChildren:true,ports:{useUnsavedChanges:()=>({confirmLeave:run=>{next=run;}})}});
 try{assert.equal(v.nodes().some(n=>String(n.props.children).startsWith('Consultar estoque do depósito')),false);await v.click('Conferir depósito 100001');const old=v.button('Consultar estoque informado pelo Origin').props.onClick;await v.click('Consultar estoque informado pelo Origin');assert.deepEqual(seen,[]);f.setAccess({role:'consulta'});await v.flush();next();assert.deepEqual(seen,[]);f.setAccess({role:'admin'});await v.flush();old();assert.deepEqual(seen,[]);await v.click('Conferir depósito 100001');await v.click('Consultar estoque informado pelo Origin');next();assert.deepEqual(seen,['100001']);assert.ok(f.calls.every(c=>!c.path.endsWith('/import')));}finally{v.unmount();}
});
test('087 pending warehouse import never offers a stock shortcut; receipt readback does',async()=>{
 const seen=[],f=createWarehouseImportFixture({lostAck:true}),v=await mountComponent('OriginWarehouseImport.tsx',{controller:f.controller,onStockObservations:id=>seen.push(id)},{expandChildren:true});
 try{await v.click('Conferir depósito 100001');await v.change('warehouse-confirm',true);await v.click('Importar depósito');assert.equal(v.nodes().some(n=>n.type==='button'&&String(n.props.children).startsWith('Consultar estoque')),false);await v.click('Consultar o mesmo comando');await v.click('Consultar estoque informado pelo Origin');assert.deepEqual(seen,['100001']);assert.equal(f.calls.filter(c=>c.path.endsWith('/import')).length,1);}finally{v.unmount();}
});
test('086/087 breadcrumbs retain preparation/warehouse route without adding a daily menu item',async()=>{
 const old=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}};
 try{for(const [path,label]of[['/preparacao-virada/depositos','Depósitos do Origin'],[stockObservationsHref('007'),'Estoque informado pelo Origin']]){
  const f=createStockObservationsFixture(),v=await mountComponent('CompanyNavigation.tsx',{state:{...f.controller.getSnapshot(),membership:{...f.controller.getSnapshot().membership,capabilities:{originHistory:true}}},onLogout(){}},{location:path,ports:{access},expandChildren:['OriginTopBar'],modules:{'../lib/real-access':'export const {ROLE_LABELS}=r.access;'}});
  try{assert.match(v.text(),/Preparação da virada/);const current=v.nodes().find(n=>n.props['aria-current']==='page');assert.equal(current.props.children,label);assert.ok(v.nodes().some(n=>n.props.to==='/preparacao-virada'));if(path.includes('/estoque'))assert.ok(v.nodes().some(n=>n.props.to==='/preparacao-virada/depositos'));}finally{v.unmount();}
 }}finally{globalThis.window=old;}
 const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');assert.ok(app.includes("'/preparacao-virada/depositos/estoque'"));
});

test('stock history is hidden when its capability is disabled',async()=>{const f=setup({history:false}),v=await mountRoute(f.controller);try{assert.equal(f.calls.length,0);assert.doesNotMatch(v.text(),/Estoque informado pelo Origin/);}finally{v.unmount();}});
