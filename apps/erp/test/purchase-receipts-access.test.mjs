import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as access from '../src/lib/real-access.ts';
import {createPurchaseReceiptsFixture} from '../src/qa/purchase-receipts-fixture.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {record as commercialRecord,input as commercialInput} from './helpers/document-commercial-fixtures.mjs';
const BASE='/v1/recebimentos-compras',origin='https://erp.synthetic.invalid',ACTOR='a0000000-0000-4000-8000-000000000090',OTHER='a0000000-0000-4000-8000-000000000091',ID='e0000000-0000-4000-8000-000000000090';
const member=(role='admin',id=ACTOR)=>({user_id:id,role,resources:['products'],data_mode:'staging_readonly'}),session=(token='original-synthetic',id=ACTOR)=>({access_token:token,user:{id}});
const tick=()=>new Promise(resolve=>setImmediate(resolve)),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(p){for(let i=0;i<200&&!p();i++)await tick();assert.ok(p(),'bounded synthetic wait');}
const body=s=>({expected_document_version:s.current.document.version,occurred_on:'2026-10-17',reason:'Conferência sintética',items:[{item_id:s.current.items[0].item_id,quantity:'1.000001'}],command_id:ID,preview_hash:'a'.repeat(64),confirmed:true});
const writes=f=>f.calls.filter(c=>['receive','reverse'].includes(c.path.split('/').at(-1))),commands=f=>f.calls.filter(c=>c.path.includes('/comandos/')),me=f=>f.calls.filter(c=>c.path==='/v1/me');
function setup({role='admin',before=()=>{},after=()=>{}}={}){
 let emit=()=>{};const s=createPurchaseReceiptsFixture({role}),calls=[],phases=[];s.role=role;s.actor=ACTOR;
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{emit('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=access.createAccessController(auth,origin,async(url,options)=>{
  const path=url.slice(origin.length),call={path,...options};calls.push(call);const early=await before(call,s);if(early)return early;let result;
  if(path==='/v1/me')result=member(s.role,s.actor);
  else if(path.startsWith(BASE))try{result=await s.controller.purchaseReceipts(path,{method:options.method,signal:options.signal,...(options.body?{body:JSON.parse(options.body)}:{})});}catch(e){return new Response(null,{status:e.status||500});}
  else if(path==='/v1/documentos')result={read:['purchase_orders'],write:['purchase_orders'],data_mode:'erp_native'};
  else if(path.startsWith('/v1/documentos/purchase_orders?'))result={kind:'purchase_orders',data_mode:'erp_native',items:[],limit:25,has_more:false,next_cursor:null};
  else if(path===`/v1/documentos/purchase_orders/${s.record.id}`){const c=s.current;result={document:{...commercialRecord('purchase_orders',{...commercialInput(),warehouse_id:c.document.warehouse_id,items:c.items.map(i=>({id:i.item_id,product_id:i.product_id,description:i.description,quantity:i.ordered_quantity,unit:i.unit,unit_price:'1'})),installments:[]}),...s.record,version:c.document.version,status:c.document.status,effect_flags:{finance_active:false,stock_active:c.document.active_receipts>0}},data_mode:'erp_native'};}
  else if(path==='/v1/cadastros')result={read:[],write:[]};else throw Error('Unexpected synthetic route '+path);
  return await after(call,s,result)??Response.json(result);
 });
 const stop=controller.start(),unsubscribe=controller.subscribe(()=>phases.push(controller.getSnapshot().phase));return{s,controller,calls,phases,emit:(...a)=>emit(...a),close(){unsubscribe();stop();}};
}
async function mount(f,route=false){
 await until(()=>f.controller.getSnapshot().phase==='ready');
 if(!route)return mountComponent('PurchaseReceipts.tsx',{record:f.s.record,controller:f.controller},{expandChildren:true,ports:{access},modules:{'../lib/real-access':'export const {AccessError,decimalMoney}=r.access;'}});
 const source=fileURLToPath(new URL('../src/components/RealDocuments.tsx',import.meta.url)),names=['CompanyPreferences','OriginPurchaseReadiness','OriginSalesReadiness','OriginSalesHistory','ItauLegacyReadiness','OriginWarehouseImport','OriginStockObservations','RealStockOpening','StockWarehouses','StockCount','StockDashboards','ReceiptCheckin','StockReports','Catalog','ProductTaxonomy','ProductExport','PriceLists','CustomFields','HistoryView','CutoverReadiness','RealStock','RealFinance','FinanceBorderos','FinanceScreens','RealCnab','RealCnabOperational','RealCnabOperationalReturns','RealReceivedDfe','RealFiscalNumbering','CertificateA1','CompanySettings','RealImportCatalog','RealImportProposals','RealHome','RealFiscalDrafts','DueDateReport','SyncedXmlHistory','IntegrationProgress','SefazConnection','RealFiscalInvoices','RealOperationNatures','FiscalEventList','RealPdv'];
 return mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:`/documentos-empresa?tipo=purchase_orders&documento=${f.s.record.id}`,expandChildren:true,ports:{access,controller:f.controller},modules:{
 '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
 '@supabase/supabase-js':'export const createClient=()=>({auth:{}});','../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://erp.synthetic.invalid"});',
 './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}','./CompanyNavigation':'export default function CompanyNavigation(){return null;}',
 './native-modules':`export {default as RealDocuments} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
 './DocumentFinance':'export default function DocumentFinance(){return null;}','./DocumentStock':'export default function DocumentStock(){return null;}',
 }});
}
async function prepare(v){await v.click('Receber produtos');for(const [end,value]of [['-reason','Conferência sintética']])await v.change(v.find(n=>n.type==='input'&&n.props.id?.endsWith(end)).props.id,value);await v.change(v.find(n=>n.type==='input'&&n.props.id?.includes('-quantity-')).props.id,'1,000001');await v.click('Conferir quantidades');v.find(n=>n.type==='input'&&n.props.type==='checkbox'&&n.props.id===undefined).props.onChange({target:{checked:true}});await v.flush();}
test('090 access closes invalid requests and all routes to non-stock roles before fetch',async()=>{
 const f=setup();try{await until(()=>f.controller.getSnapshot().phase==='ready');const baseline=f.calls.length;for(const[path,options]of [[BASE,{}],[`${BASE}/${f.s.record.id}?limit=26`,{}],[`${BASE}/comandos/${ID}?actor_id=${ACTOR}`,{}],[`${BASE}/${f.s.record.id}/receive`,{method:'POST',body:{...body(f.s),actor_id:ACTOR}}],[`${BASE}/${f.s.record.id}`,{method:'PATCH'}]])await assert.rejects(f.controller.purchaseReceipts(path,options),e=>e.status===400);assert.equal(f.calls.length,baseline);}finally{f.close();}
 for(const role of ['admin','estoque','vendas','consulta','fiscal','financeiro']){const f=setup({role});try{await until(()=>f.controller.getSnapshot().phase==='ready');const baseline=f.calls.length;for(const path of [`${BASE}/${f.s.record.id}`,`${BASE}/${f.s.record.id}/receive`]){const p=f.controller.purchaseReceipts(path,path.endsWith('/receive')?{method:'POST',body:body(f.s)}:{});if(['admin','estoque'].includes(role))await p;else await assert.rejects(p,e=>e.status===403);}if(!['admin','estoque'].includes(role))assert.equal(f.calls.length,baseline);}finally{f.close();}}
});
test('090 captures exact request before credential refresh, and reduced role/abort/actor switch never dispatch',async()=>{
 for(const outcome of ['allowed','role','abort','actor']){const gate=deferred(),f=setup({before(c){if(c.path==='/v1/me'&&c.headers.Authorization==='Bearer renewed-synthetic')return gate.promise;}});try{await until(()=>f.controller.getSnapshot().phase==='ready');f.emit('TOKEN_REFRESHED',session('renewed-synthetic'));await until(()=>me(f).length===2);const b=body(f.s),expected=structuredClone(b),abort=new AbortController(),options={method:'POST',body:b,signal:abort.signal},pending=f.controller.purchaseReceipts(`${BASE}/${f.s.record.id}/receive`,options);const check=outcome==='allowed'?pending:assert.rejects(pending,e=>outcome==='role'?e.status===403:e.name==='AbortError');b.items[0].quantity='999';b.reason='changed';options.body={};options.signal=new AbortController().signal;if(outcome==='abort')abort.abort();if(outcome==='role')f.s.role='consulta';if(outcome==='actor'){f.s.actor=OTHER;f.emit('SIGNED_IN',session('other-synthetic',OTHER));}gate.resolve(Response.json(member(f.s.role)));await check;assert.equal(writes(f).length,outcome==='allowed'?1:0);if(outcome==='allowed'){assert.deepEqual(JSON.parse(writes(f)[0].body),expected);assert.equal(writes(f)[0].headers.Authorization,'Bearer renewed-synthetic');}}finally{gate.resolve(Response.json(member()));f.close();}}
});
test('090 role downgrade while GET response is pending discards the received data',async()=>{
 const gate=deferred(),f=setup({after(c,s,result){if(c.path.startsWith(BASE))return gate.promise.then(()=>Response.json(result));}});try{await until(()=>f.controller.getSnapshot().phase==='ready');const reading=f.controller.purchaseReceipts(`${BASE}/${f.s.record.id}`),rejected=assert.rejects(reading,e=>e.status===403);await until(()=>f.calls.some(c=>c.path.startsWith(BASE)));f.s.role='consulta';f.emit('TOKEN_REFRESHED',session('reduced-synthetic'));await until(()=>f.controller.getSnapshot().membership.role==='consulta');gate.resolve();await rejected;}finally{gate.resolve();f.close();}
});
for(const outcome of ['allowed','role','failure','abort'])test(`090 waits for an in-flight renewed membership before exposing a response: ${outcome}`,async()=>{
 const responseGate=deferred(),membershipGate=deferred(),abort=new AbortController();
 const f=setup({before(c){if(c.path==='/v1/me'&&c.headers.Authorization==='Bearer race-synthetic')return membershipGate.promise;},after(c,s,result){if(c.path.startsWith(BASE))return responseGate.promise.then(()=>Response.json(result));}});
 try{
  await until(()=>f.controller.getSnapshot().phase==='ready');let settled=false;
  const reading=f.controller.purchaseReceipts(`${BASE}/${f.s.record.id}`,{signal:abort.signal});reading.then(()=>{settled=true;},()=>{settled=true;});
  const verified=outcome==='allowed'?reading:assert.rejects(reading,e=>outcome==='abort'?e.name==='AbortError':e.status===(outcome==='role'?403:503));
  await until(()=>f.calls.some(c=>c.path.startsWith(BASE)));f.emit('TOKEN_REFRESHED',session('race-synthetic'));await until(()=>me(f).length===2);
  responseGate.resolve();for(let i=0;i<5;i++)await tick();assert.equal(settled,false,'response must wait for current membership');
  if(outcome==='abort')abort.abort();if(outcome==='role')f.s.role='consulta';
  membershipGate.resolve(outcome==='failure'?new Response(null,{status:503}):Response.json(member(f.s.role)));
  await verified;assert.equal(f.calls.filter(c=>c.path.startsWith(BASE)).length,1,'never replay request during membership refresh');
 }finally{responseGate.resolve();membershipGate.resolve(Response.json(member()));f.close();}
});
test('090 actual route preserves committed attempt on same-actor role loss and restores GET-only recovery',async()=>{
 const gate=deferred(),f=setup({after(c){if(c.path.endsWith('/receive'))return gate.promise;}});let v;try{v=await mount(f,true);await prepare(v);await v.click('Confirmar recebimento');assert.equal(f.s.commands.size,1);const id=[...f.s.commands.keys()][0],stale=v.button('Consultar resultado').props.onClick;f.s.role='financeiro';f.emit('TOKEN_REFRESHED',session('reduced-synthetic'));await v.flush();gate.resolve(Response.json(f.s.commands.get(id)));await v.flush();stale();await v.flush();assert.equal(commands(f).length,0);assert.equal(writes(f).length,1);assert.ok(v.find(n=>n.props.hidden===true).props.inert);f.s.role='estoque';f.emit('TOKEN_REFRESHED',session('restored-synthetic'));await v.flush();await v.click('Consultar resultado');assert.equal(writes(f).length,1);assert.equal(commands(f).length,1);assert.equal(f.calls.filter(c=>c.path===`/v1/documentos/purchase_orders/${f.s.record.id}`).length,2);assert.match(v.text(),/Ver recebimento/);}finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});
for(const action of ['logout','actor'])test(`090 actual route ${action} rejects late ACK and retained GET callback`,async()=>{
 const gate=deferred(),f=setup({after(c){if(c.path.endsWith('/receive'))return gate.promise;}});let v;try{v=await mount(f,true);await prepare(v);await v.click('Confirmar recebimento');const stale=v.button('Consultar resultado').props.onClick;if(action==='logout')await f.controller.logout();else{f.s.actor=OTHER;f.emit('SIGNED_IN',session('other-synthetic',OTHER));}await v.flush();gate.resolve(Response.json([...f.s.commands.values()][0]));await v.flush();stale();await v.flush();assert.equal(commands(f).length,0);assert.equal(writes(f).length,1);assert.doesNotMatch(v.text(),/Consultar resultado/);}finally{gate.resolve(Response.json({}));v?.unmount();f.close();}
});
