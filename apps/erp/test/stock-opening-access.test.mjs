import test from'node:test';import assert from'node:assert/strict';import{fileURLToPath}from'node:url';import{readFile}from'node:fs/promises';
import * as access from'../src/lib/real-access.ts';import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createStockOpeningFixture}from'../src/qa/stock-opening-fixture.ts';import{resolvePreferences}from'../src/lib/origin-menu.ts';
const ACTOR='10000000-0000-4000-8000-000000000001',OTHER='10000000-0000-4000-8000-000000000002',COMMAND='10000000-0000-4000-8000-0000000000c1';
const tick=()=>new Promise(r=>setTimeout(r,0)),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,addEventListener(){},removeEventListener(){}};});test.after(()=>{globalThis.document=previous;});
function setup({role='admin',fixture={}}={}){const f=createStockOpeningFixture(fixture);f.setAccess({role});let currentRole=role,actor=ACTOR,emit,meGate,refreshes=0;const calls=[];
 const auth={getSession:async()=>({data:{session:{access_token:'synthetic100',user:{id:ACTOR}}},error:null}),onAuthStateChange:fn=>(emit=fn,{data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
 const controller=access.createAccessController(auth,'https://api.synthetic.test',async(url,o)=>{if(url.endsWith('/me')){if(meGate)await meGate.promise;return Response.json({user_id:actor,role:currentRole,resources:[],data_mode:'staging_readonly'});}
  const path=new URL(url).pathname+new URL(url).search,call={path,...o};calls.push(call);return Response.json(await f.controller.stockOpening(path,{method:o.method,body:o.body?JSON.parse(o.body):undefined,signal:o.signal}));});
 return{controller,calls,fixture:f,refresh(r,gate){currentRole=r;meGate=gate;emit('TOKEN_REFRESHED',{access_token:'renewed100-'+(++refreshes),user:{id:actor}});},changeActor(){actor=OTHER;emit('SIGNED_IN',{access_token:'other100',user:{id:actor}});}};}
const policyBody={command_id:COMMAND,expected_version:0,allow_negative:true,reason:'Venda sem saldo na virada',confirmed:true};

test('100 controller: policy GET for stock readers, every write and the adoption for administrador only, body captured before refresh',async()=>{
 for(const role of['consulta','estoque','vendas','fiscal']){const f=setup({role}),stop=f.controller.start();await tick();try{
  assert.equal((await f.controller.stockOpening('/v1/politica-estoque')).can_manage,false);
  for(const[path,options]of[['/v1/politica-estoque',{method:'POST',body:policyBody}],['/v1/saldo-abertura-estoque',{}],['/v1/saldo-abertura-estoque/700001?limit=50',{}],['/v1/saldo-abertura-estoque/700001/lote',{method:'POST',body:{occurred_on:'2026-10-18',limit:100}}]])
   await assert.rejects(()=>f.controller.stockOpening(path,options),e=>e instanceof access.AccessError&&e.status===403,`${role} ${path}`);
  assert.equal(f.calls.length,1);}finally{stop();}}
 const financial=setup({role:'financeiro'}),stopped=financial.controller.start();await tick();try{await assert.rejects(()=>financial.controller.stockOpening('/v1/politica-estoque'),e=>e.status===403);assert.equal(financial.calls.length,0);}finally{stopped();}
 const f=setup(),stop=f.controller.start();await tick();try{
  const gate=deferred();f.refresh('consulta',gate);const body={...policyBody},call=f.controller.stockOpening('/v1/politica-estoque',{method:'POST',body});body.allow_negative=false;gate.resolve();
  await assert.rejects(call,e=>e instanceof access.AccessError&&e.status===403);assert.equal(f.calls.length,0);
 }finally{stop();}
 const g=setup(),halt=g.controller.start();await tick();try{
  const again=deferred();g.refresh('admin',again);const sent={...policyBody},ok=g.controller.stockOpening('/v1/politica-estoque',{method:'POST',body:sent});sent.reason='Mutação posterior';again.resolve();await ok;
  assert.equal(g.calls.length,1);assert.equal(JSON.parse(g.calls[0].body).reason,'Venda sem saldo na virada');
  for(const path of['/v1/estoque/saldos','/v1/saldo-abertura-estoque/0','/v1/saldo-abertura-estoque?actor='+OTHER,'/v1/politica-estoque/comandos/x'])await assert.rejects(()=>g.controller.stockOpening(path),e=>e.status===400);
  assert.equal(g.calls.length,1);
 }finally{halt();}
});

async function mountRoute(controller,location='/estoque-abertura'){
 const source=fileURLToPath(new URL('../src/components/RealStockOpening.tsx',import.meta.url)),names=[...String(await readFile(new URL('../src/components/native-modules.ts',import.meta.url),'utf8')).matchAll(/export const (\w+) = lazy/g)].map(x=>x[1]).filter(n=>n!=='RealStockOpening');
 return mountComponent('RealAccess.tsx',{},{componentName:'ConnectedArea',location,expandChildren:true,ports:{access,controller},modules:{'../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;','@supabase/supabase-js':'export const createClient=()=>({auth:{}});','../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://api.synthetic.test"});','./NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}','./CompanyNavigation':'export default function CompanyNavigation(){return null;}','./native-modules':`export {default as RealStockOpening} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`}});
}
test('100 real route: only administrador reaches the screen; other roles get no business request',async()=>{
 for(const role of['admin','consulta','estoque','vendas','fiscal','financeiro']){const f=setup({role}),v=await mountRoute(f.controller);try{
  assert.equal(f.calls.length,role==='admin'?3:0,role);assert.match(v.text(),role==='admin'?/Saldo de abertura do estoque \(Origin\)/:/Saldo de abertura não liberado/);
 }finally{v.unmount();}}
});
test('100 real route: the same administrador losing and regaining the role keeps the pending command for “Conferir resultado”',async()=>{
 const hold=deferred(),f=setup({fixture:{before:c=>c.path.endsWith('/adotar')?hold.promise:undefined}}),v=await mountRoute(f.controller);try{
 await v.click('Adotar próximo lote');await v.change('opening-confirm',true);await v.click('Adotar lote');
 const sent=f.calls.find(c=>c.path.endsWith('/adotar')),command=JSON.parse(sent.body).command_id;
 f.refresh('estoque');await v.flush();assert.match(v.text(),/exige acesso ativo de administrador/);assert.doesNotMatch(v.text(),/Saldo de abertura não liberado/);
 hold.resolve(undefined);await v.flush();assert.ok(v.nodes().some(n=>n.props.hidden&&n.props.inert));f.refresh('admin');await v.flush();assert.ok(!v.nodes().some(n=>n.props.hidden&&n.props.inert));assert.match(v.text(),new RegExp(command));
 await v.click('Conferir resultado');assert.equal(f.calls.filter(c=>c.path.endsWith('/adotar')).length,1);
 assert.equal(f.calls.filter(c=>c.path==='/v1/saldo-abertura-estoque/comandos/'+command).length,1);assert.match(v.text(),/2 concluídos/);
}finally{hold.resolve(undefined);v.unmount();}});
test('100 Preferências › Suprimentos lists the screen for administrador only and the public App accepts the route',async()=>{
 const admin=resolvePreferences({role:'admin'});const category=admin.find(c=>c.id==='suprimentos');assert.ok(category);assert.ok(category.entries.map(e=>e.to).includes('/estoque-abertura'));assert.ok(category.entries.map(e=>e.to).includes('/cadastros-reais?cadastro=warehouses'));
 // Origin order (Empresa, Sistema, Cadastros, Suprimentos…): the tool sits in Suprimentos › Ferramentas do Brufap.
 {const ids=admin.map(c=>c.id);assert.equal(ids[0],'empresa');assert.ok(ids.indexOf('suprimentos')>0);}
 for(const role of['consulta','estoque','vendas','fiscal','financeiro'])assert.equal(resolvePreferences({role}).some(c=>c.entries.some(e=>e.to==='/estoque-abertura')),false,role);
 const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');assert.ok(app.includes("'/estoque-abertura'"));
 const v=await mountComponent('PreferencesPage.tsx',{homeTo:'/acesso',initialCategory:'suprimentos',categories:admin});try{assert.match(v.text(),/saldo de abertura e estoque negativo/);}finally{v.unmount();}
});
