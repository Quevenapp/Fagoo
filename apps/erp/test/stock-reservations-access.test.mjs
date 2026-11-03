import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import * as access from '../src/lib/real-access.ts';
import {captureStockReservationsRequest} from '../src/lib/stock-reservations-request.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {stockFixture,BASE,ACTOR,ORDER,PRODUCT,WAREHOUSE,ITEM,H} from './helpers/stock-reservations-fixtures.mjs';
const origin='https://erp.synthetic.invalid',other='90000000-0000-4000-8000-000000000070';
const session=(token='original-synthetic',id=ACTOR)=>({access_token:token,user:{id}}),member=(role='admin',id=ACTOR)=>({user_id:id,role,resources:['products'],data_mode:'staging_readonly'});
const tick=()=>new Promise(resolve=>setImmediate(resolve)),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(p){for(let i=0;i<200&&!p();i++)await tick();assert.ok(p(),'bounded synthetic wait');}
const body=()=>({expected_document_version:1,occurred_on:'2026-10-16',reason:'Teste sintético',command_id:ITEM,preview_hash:H,ignored_item_ids:[PRODUCT]});
const preview=()=>({expected_document_version:1,occurred_on:'2026-10-16',reason:'Teste sintético'});
function setup({role='admin',before=()=>{},after=()=>{}}={}){
 let emit=()=>{};const s=stockFixture({AccessError:access.AccessError,role}),calls=[],phases=[];
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{emit('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=access.createAccessController(auth,origin,async(url,options)=>{
  const path=url.slice(origin.length),call={path,...options};calls.push(call);const early=await before(call,s);if(early)return early;let result;
  if(path==='/v1/me')result=member(s.role,s.actor);
  else if(path.startsWith(BASE))try{result=await s.controller.stockReservations(path,{...options,body:options.body?JSON.parse(options.body):undefined});}catch(e){return new Response(null,{status:e.status||500});}
  else if(path==='/v1/documentos')result={read:['sales_orders'],write:['sales_orders'],data_mode:'erp_native'};
  else if(path.includes('/v1/documentos/sales_orders?'))result={kind:'sales_orders',data_mode:'erp_native',items:[],limit:25,has_more:false,next_cursor:null};
  else if(path===`/v1/documentos/sales_orders/${ORDER}`)result={document:structuredClone(s.doc),data_mode:'erp_native'};
  else if(path==='/v1/cadastros')result={read:[],write:[]};
  else throw Error('Unexpected synthetic route '+path);
  return await after(call,s,result)??Response.json(result);
 });
 const stop=controller.start(),unsubscribe=controller.subscribe(()=>phases.push(controller.getSnapshot().phase));return{s,controller,calls,phases,emit:(...args)=>emit(...args),close(){unsubscribe();stop();}};
}
const writes=f=>f.calls.filter(c=>c.method==='POST'&&!c.path.endsWith('preview')),commands=f=>f.calls.filter(c=>c.path.includes('/comandos/')),me=f=>f.calls.filter(c=>c.path==='/v1/me');
async function mount(f,route=false){
 await until(()=>f.controller.getSnapshot().phase==='ready');
 if(!route)return mountComponent('SalesOrderReservations.tsx',{...f.s.props,controller:f.controller},{ports:{access},modules:{'../lib/real-access':'export const {AccessError,decimalMoney}=r.access;'}});
 const source=fileURLToPath(new URL('../src/components/RealDocuments.tsx',import.meta.url)),names=['CompanyPreferences','OriginPurchaseReadiness','OriginSalesReadiness','OriginSalesHistory','ItauLegacyReadiness','OriginWarehouseImport','OriginStockObservations','RealStockOpening','StockWarehouses','StockCount','StockDashboards','ReceiptCheckin','StockReports','Catalog','ProductTaxonomy','ProductExport','PriceLists','CustomFields','HistoryView','CutoverReadiness','RealStock','RealFinance','FinanceBorderos','FinanceScreens','RealCnab','RealCnabOperational','RealCnabOperationalReturns','RealReceivedDfe','RealFiscalNumbering','CertificateA1','CompanySettings','RealImportCatalog','RealImportProposals','RealHome','RealFiscalDrafts','DueDateReport','SyncedXmlHistory','IntegrationProgress','SefazConnection','RealFiscalInvoices','RealOperationNatures','FiscalEventList','RealPdv'];
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:`/documentos-empresa?tipo=sales_orders&documento=${ORDER}`,expandChildren:true,ports:{access,controller:f.controller},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});','../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://erp.synthetic.invalid"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}','./CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './native-modules':`export {default as RealDocuments} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
  './DocumentFinance':'export default function DocumentFinance(){return null;}','./DocumentStock':'export default function DocumentStock(){return null;}',
 }});
}
async function prepare(v){await v.click('Reservar produtos');for(const [suffix,value]of [['-day','2026-10-16'],['-reason','Reserva sintética']])await v.change(v.find(n=>n.type==='input'&&n.props.id?.endsWith(suffix)).props.id,value);await v.click('Conferir reserva');v.find(n=>n.type==='input'&&n.props.type==='checkbox'&&!n.props.id).props.onChange({target:{checked:true}});await v.flush();}

test('070 synchronous capture freezes body and IDs, retains signal, and rejects accessors without invoking them',()=>{
 const value=body(),expected=structuredClone(value),abort=new AbortController(),options={method:'POST',body:value,signal:abort.signal},captured=captureStockReservationsRequest(`${BASE}/pedidos/${ORDER}/reserve`,options);
 value.ignored_item_ids.length=0;value.reason='changed';options.signal=new AbortController().signal;options.body={};assert.deepEqual(captured.options.body,expected);assert.equal(captured.options.signal,abort.signal);assert.ok(Object.isFrozen(captured.options.body.ignored_item_ids));
 let calls=0;const getter=()=>{calls++;return 'forged';},items=body();Object.defineProperty(items.ignored_item_ids,'0',{get:getter});
 for(const opts of [Object.defineProperty({},'body',{get:getter}),{method:'POST',body:Object.defineProperty(body(),'reason',{get:getter})},{method:'POST',body:items}])assert.throws(()=>captureStockReservationsRequest(`${BASE}/pedidos/${ORDER}/reserve`,opts));assert.equal(calls,0);
});
test('070 routes, bodies, limits and roles are closed before fetch',async()=>{
 const f=setup();try{await until(()=>f.controller.getSnapshot().phase==='ready');const baseline=f.calls.length;
  for(const[path,options]of [[BASE,{}],[`${BASE}/pedidos/${ORDER}?limit=26`,{}],[`${BASE}/pedidos/${ORDER}?limit=1&limit=2`,{}],[`${BASE}/comandos/${ITEM}?actor_id=${ACTOR}`,{}],[`${BASE}/disponibilidade?product_id=${PRODUCT}`,{}],[`${BASE}/pedidos/${ORDER}/reserve`,{method:'POST',body:{...body(),actor_id:ACTOR}}],[`${BASE}/pedidos/${ORDER}/preview`,{method:'POST',body:{...preview(),expected_document_version:'1'}}],[`${BASE}/pedidos/${ORDER}/reserve`,{method:'POST',body:{...body(),ignored_item_ids:[PRODUCT,PRODUCT]}}],[`${BASE}/pedidos/${ORDER}/reserve`,{method:'POST',body:{...body(),reason:'x'.repeat(501)}}],[`${BASE}/pedidos/${ORDER}/reserve?`,{method:'POST',body:body()}],[`${BASE}/pedidos/${ORDER}/reserve`,{method:'GET'}],[`${BASE}/pedidos/${ORDER}`,{method:'DELETE'}]])await assert.rejects(f.controller.stockReservations(path,options),e=>e.status===400);assert.equal(f.calls.length,baseline);
  await f.controller.stockReservations(`${BASE}/disponibilidade?product_id=${PRODUCT}&warehouse_id=${WAREHOUSE}`);assert.equal(f.calls.length,baseline+1);
 }finally{f.close();}
 for(const role of ['admin','estoque','vendas','consulta','fiscal','financeiro']){const f=setup({role});try{await until(()=>f.controller.getSnapshot().phase==='ready');const p=f.controller.stockReservations(`${BASE}/pedidos/${ORDER}/preview`,{method:'POST',body:preview()});if(['admin','estoque'].includes(role))await p;else await assert.rejects(p,e=>e.status===403);const read=f.controller.stockReservations(`${BASE}/pedidos/${ORDER}?limit=25`);if(role==='financeiro')await assert.rejects(read,e=>e.status===403);else await read;}finally{f.close();}}
});
test('070 refresh captures the exact mutation before await; reduced role or aborted wait never dispatches',async()=>{
 for(const outcome of ['allowed','role','abort']){const gate=deferred(),f=setup({before(c){if(c.path==='/v1/me'&&c.headers.Authorization==='Bearer renewed-synthetic')return gate.promise;}});
  try{await until(()=>f.controller.getSnapshot().phase==='ready');f.emit('TOKEN_REFRESHED',session('renewed-synthetic'));await until(()=>me(f).length===2);const b=body(),expected=structuredClone(b),abort=new AbortController(),options={method:'POST',body:b,signal:abort.signal},pending=f.controller.stockReservations(`${BASE}/pedidos/${ORDER}/reserve`,options);const check=outcome==='allowed'?pending:assert.rejects(pending,e=>outcome==='abort'?e.name==='AbortError':e.status===403);
   b.ignored_item_ids.length=0;b.reason='changed';options.body={};options.signal=new AbortController().signal;if(outcome==='abort')abort.abort();if(outcome==='role')f.s.role='consulta';gate.resolve(Response.json(member(f.s.role)));await check;assert.equal(writes(f).length,outcome==='allowed'?1:0);if(outcome==='allowed'){assert.deepEqual(JSON.parse(writes(f)[0].body),expected);assert.equal(writes(f)[0].headers.Authorization,'Bearer renewed-synthetic');}
  }finally{gate.resolve(Response.json(member()));f.close();}
 }
});
test('070 lost ACK and GET403 revalidation preserve same-actor command, ready phase and GET-only recovery',async()=>{
 let hold=false,count=0;const gate=deferred(),f=setup({before(c){if(c.path==='/v1/me'&&hold)return gate.promise;if(c.path.includes('/comandos/')&&++count===1){hold=true;return new Response(null,{status:403});}},after(c){if(c.method==='POST'&&c.path.endsWith('/reserve'))return new Response(null,{status:503});}});let v;
 try{v=await mount(f);await prepare(v);await v.click('Confirmar reserva');assert.equal(f.s.commands.size,1);f.phases.length=0;await v.click('Consultar resultado');await until(()=>me(f).length===2);assert.ok(f.phases.every(x=>x==='ready'));assert.equal(writes(f).length,1);assert.equal(f.s.busy,true);gate.resolve(Response.json(member()));await v.flush();await v.click('Consultar resultado');assert.equal(writes(f).length,1);assert.equal(commands(f).length,2);assert.ok(commands(f).every(c=>c.path.endsWith([...f.s.commands.keys()][0])));assert.equal(f.s.busy,false);
 }finally{gate.resolve(Response.json(member()));v?.unmount();f.close();}
});
test('070 actual document route retains a committed attempt hidden/inert on same-actor role loss and restores GET only',async()=>{
 const gate=deferred(),f=setup({after(c){if(c.method==='POST'&&c.path.endsWith('/reserve'))return gate.promise;}});let v;
 try{v=await mount(f,true);await prepare(v);const stale=v.button('Confirmar reserva').props.onClick;await v.click('Confirmar reserva');assert.equal(f.s.commands.size,1);const id=[...f.s.commands.keys()][0];f.s.role='financeiro';f.emit('TOKEN_REFRESHED',session('reduced-synthetic'));await v.flush();gate.resolve(Response.json(f.s.commands.get(id)));await v.flush();stale();await v.flush();assert.equal(commands(f).length,0);assert.equal(writes(f).length,1);const hidden=v.find(n=>n.type==='section'&&n.props.hidden===true);assert.equal(hidden.props.inert,true);assert.equal(hidden.props['aria-hidden'],true);
  f.s.role='estoque';f.emit('TOKEN_REFRESHED',session('restored-synthetic'));await v.flush();await v.click('Consultar resultado');assert.equal(writes(f).length,1);assert.equal(commands(f).length,1);assert.equal(f.calls.filter(c=>c.path===`/v1/documentos/sales_orders/${ORDER}`).length,2);assert.match(v.text(),/Reserva ativa/);
 }finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});
for(const action of ['logout','actor'])test(`070 actual route ${action} discards the late ACK and retained command callback`,async()=>{
 const gate=deferred(),f=setup({after(c){if(c.method==='POST'&&c.path.endsWith('/reserve'))return gate.promise;}});let v;
 try{v=await mount(f,true);await prepare(v);await v.click('Confirmar reserva');const stale=v.button('Consultar resultado').props.onClick;if(action==='logout')await f.controller.logout();else{f.s.actor=other;f.emit('SIGNED_IN',session('other-synthetic',other));}await v.flush();gate.resolve(Response.json([...f.s.commands.values()][0]));await v.flush();stale();await v.flush();assert.equal(commands(f).length,0);assert.equal(writes(f).length,1);assert.doesNotMatch(v.text(),/Consultar resultado|Comando:/);
 }finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});
