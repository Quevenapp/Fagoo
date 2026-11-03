import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import * as access from '../src/lib/real-access.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {fixture,actor,profile,title,file} from './helpers/cnab-operational-v2-fixtures.mjs';
import {CNAB_ENCODINGS as E} from '../src/lib/cnab-operational-v2-model.ts';
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v===null||v===undefined||typeof v==='boolean'?'':String(v);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const names=['CompanyPreferences','OriginPurchaseReadiness','OriginSalesReadiness','OriginSalesHistory','ItauLegacyReadiness','OriginWarehouseImport','OriginStockObservations','RealStockOpening','StockWarehouses','StockCount','StockDashboards','ReceiptCheckin','StockReports','Catalog','ProductTaxonomy','ProductExport','PriceLists','CustomFields','HistoryView','RealDocuments','RealStock','RealFinance','FinanceBorderos','FinanceScreens','RealCnab','RealCnabOperationalReturns','RealReceivedDfe','RealFiscalNumbering','CertificateA1','CompanySettings','RealImportCatalog','RealImportProposals','RealHome','CutoverReadiness','RealFiscalDrafts','DueDateReport','SyncedXmlHistory','IntegrationProgress','SefazConnection','RealFiscalInvoices','RealOperationNatures','FiscalEventList','RealPdv'];
async function setup(){
 const gate=deferred(),s=fixture({ErrorType:access.AccessError,after:async call=>{if(call.op==='generate')await gate.promise;}});let user=actor,role='admin',emit,serial=1;const session=()=>({access_token:'synthetic-'+serial,user:{id:user}}),auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange:fn=>{emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})},requests=[];
 const controller=access.createAccessController(auth,'https://synthetic.invalid',async(url,options)=>{requests.push({url,options});const p=new URL(url).pathname;if(p==='/v1/me')return Response.json({user_id:user,role,resources:[],data_mode:'staging_readonly'});const native={method:options.method,signal:options.signal,...options.body?{body:JSON.parse(options.body)}:{}};try{return Response.json(await(p.startsWith('/v1/financeiro')?s.controller.finance(p,native):s.controller.cnabOperationalV2(p+new URL(url).search,native)));}catch(e){if(e instanceof access.AccessError)return Response.json({}, {status:e.status});throw e;}});
 const source=fileURLToPath(new URL('../src/components/RealCnabOperational.tsx',import.meta.url));
 const view=await mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:'/cobranca-operacional',expandChildren:true,ports:{access,controller},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});',
  '../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://synthetic.invalid"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}',
  './CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './native-modules':`export {default as RealCnabOperational} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
 }});
 return{s,gate,view,controller,requests,async role(value){role=value;serial++;emit('TOKEN_REFRESHED',session());await view.flush();},async actor(value){user=value;serial++;emit('SIGNED_IN',session());await view.flush();}};
}
const input=(v,label)=>v.input(v.find(n=>n.type==='label'&&text(n)===label).props.htmlFor);
async function pending(s){const v=s.view;await v.click('Incluir Remessa');await v.change(input(v,'Conta para cobrança *').props.id,profile.id);await v.change(input(v,'Formato da remessa *').props.id,E[1]);v.find(n=>n.type==='input'&&n.props['aria-label']==='Selecionar '+title.description).props.onChange({target:{checked:true}});await v.flush();await v.change(input(v,'Documento · '+title.description+' *').props.id,'TESTE');await v.submit();const box=v.find(n=>n.type==='input'&&n.props.type==='checkbox'&&!n.props['aria-label']);box.props.onChange({target:{checked:true}});await v.flush();await v.click('Reservar e gerar remessa');assert.equal(s.s.counts.generate,1);assert.equal(s.s.stored.size,1);return s.s.calls.find(x=>x.op==='generate').body.command_id;}
test('067 real route/controller retain committed uncertain command hidden/inert across same-actor READ loss and recover by GET after restoration',async()=>{
 const t=await setup();try{const command=await pending(t),oldLookup=t.view.button('Consultando…').props.onClick;await t.role('vendas');assert.match(t.view.text(),/perfil atual não permite acessar/);const held=t.view.find(n=>n.type==='div'&&n.props.hidden===true);assert.equal(held.props.inert,true);assert.equal(held.props['aria-hidden'],true);assert.equal(t.view.guard().busy,true);oldLookup();await t.view.flush();assert.equal(t.s.counts.command,undefined);
  t.gate.resolve();await t.view.flush();assert.equal(t.s.counts.command,undefined);assert.match(t.view.text(),new RegExp(command));assert.equal(t.view.button('Consultar comando').disabled,false);oldLookup();await t.view.flush();assert.equal(t.s.counts.command,undefined);
  await t.role('financeiro');assert.equal(t.view.nodes().some(n=>n.type==='div'&&n.props.hidden===true),false);assert.equal(input(t.view,'Conta para cobrança *').props.value,profile.id);assert.equal(t.view.guard().busy,true);await t.view.click('Consultar comando');assert.equal(t.s.counts.generate,1);assert.equal(t.s.counts.command,1);assert.match(t.view.text(),/Remessa registrada/);assert.equal(t.s.calls.find(x=>x.op==='command').path.split('/').at(-1),command);
 }finally{t.gate.resolve();t.view.unmount();}
});
for(const action of ['logout','otherActor'])test(`067 real route clears held command on ${action}, with no late read or restored intent`,async()=>{
 const t=await setup();try{const command=await pending(t);await t.role('vendas');if(action==='logout')await t.controller.logout();else await t.actor(file.id);t.gate.resolve();await t.view.flush();assert.equal(t.s.counts.command,undefined);assert.doesNotMatch(t.view.text(),new RegExp(command));if(action==='otherActor'){await t.role('financeiro');assert.doesNotMatch(t.view.text(),/Consultar comando/);assert.equal(t.view.nodes().some(n=>n.type==='input'&&n.props.value==='TESTE'),false);}assert.equal(t.s.counts.generate,1);
 }finally{t.gate.resolve();t.view.unmount();}
});
