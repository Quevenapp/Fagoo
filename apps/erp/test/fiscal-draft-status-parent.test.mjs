import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath}from'node:url';import{readFile}from'node:fs/promises';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';import{fixture,row,page,ACTOR,OTHER,deferred}from'./helpers/fiscal-draft-status-fixtures.mjs';
import{unsignedFixture}from'./helpers/fiscal-unsigned-fixtures.mjs';import{guideFixture}from'./helpers/fiscal-preparation-guide-fixture.mjs';import * as access from '../src/lib/real-access.ts';
const expanded=['FiscalDraftStatus','StatusList','AuthorizationSummary','RecordedResult','NativeListLayout','DraftEditor','PreparationFields','TaskMessage','CreateDraft','OrderPicker','FiscalPreparationGuide'];
function setup(){const draft=unsignedFixture().draft,r=row();r.draft.id=draft.record.id;const f=fixture({before:()=>page([r])}),calls=[];f.controller.fiscalDraft=async(path,o={})=>{calls.push({path,...o});assert.equal(o.method??'GET','GET');assert.equal(path,'/v1/rascunhos-fiscais/'+draft.record.id);return structuredClone(draft);};f.controller.documents=async()=>{throw Error('No document query expected');};return{...f,draft,callsNative:calls};}
test('082 real parent reads only the summary, opens the existing editor and refreshes summary after closing',async()=>{
 const f=setup(),v=await mountComponent('RealFiscalDrafts.tsx',{controller:f.controller,initialModel:'55'},{expandChildren:expanded});try{
  assert.equal(f.calls.length,1);assert.equal(f.callsNative.length,0);assert.match(v.text(),/Autorizada em homologação/);await v.click('Abrir preparação');assert.equal(f.callsNative.length,1);assert.match(v.text(),/Conferências da cópia do pedido/);assert.doesNotMatch(v.text(),/Atualizar resumo/);
  await v.click('Voltar à listagem');assert.equal(f.calls.length,2);assert.match(v.text(),/Autorizada em homologação/);assert.equal(f.callsNative.length,1);
 }finally{v.unmount();}
});
test('082 summary model selection remains aligned with the guide, route and existing creation form',async()=>{
 const f=guideFixture({empty:true}),q=fixture(),calls=[];f.controller.fiscalDraftStatus=async(path,o)=>{calls.push({path,...o});const model=new URL(path,'https://synthetic.invalid').searchParams.get('model');return page(q.rows.filter(r=>!model||r.draft.model===model));};
 const v=await mountComponent('RealFiscalDrafts.tsx',{controller:f.controller,initialModel:'55'},{expandChildren:expanded,location:'/emissor-fiscal?modelo=55'});try{
  const model=v.find(n=>n.type==='select'&&n.props.id.endsWith('-model'));await v.change(model.props.id,'65');assert.equal(v.location().search,'?modelo=65');assert.match(v.text(),/Preparar NFC-e/);
  await v.click('Incluir rascunho');assert.doesNotMatch(v.text(),/Atualizar resumo/);const creation=v.nodes().find(n=>n.type==='input'&&n.props.type==='radio'&&n.props.value==='65'&&n.props.checked);assert.ok(creation);assert.match(v.text(),/Nenhum pedido encontrado/);assert.equal(calls.length,2);assert.ok(f.calls.every(c=>(c.method??'GET')==='GET'));
 }finally{v.unmount();}
});
test('082 retained list callbacks cannot switch away from a pending editor mutation',async()=>{
 const f=setup(),gate=deferred();let writes=0;const read=f.controller.fiscalDraft;f.controller.fiscalDraft=async(path,o={})=>{if(o.method==='PATCH'){writes++;return gate.promise;}return read(path,o);};
 const v=await mountComponent('RealFiscalDrafts.tsx',{controller:f.controller,initialModel:'55'},{expandChildren:expanded});try{
  const staleCreate=v.button('Incluir rascunho').props.onClick,staleOpen=v.button('Abrir preparação').props.onClick;await v.click('Abrir preparação');const notes=v.find(n=>n.type==='textarea');await v.change(notes.props.id,'SYNTHETIC PENDING EDIT');await v.submit();assert.equal(writes,1);assert.equal(v.guard().busy,true);
  staleCreate();staleOpen();await v.flush();assert.equal(v.guard().busy,true);assert.equal(v.button('Voltar à listagem').disabled,true);assert.equal(f.calls.length,1);assert.equal(writes,1);assert.doesNotMatch(v.text(),/Atualizar resumo|Selecionar pedido de venda/);
 }finally{v.unmount();gate.resolve(f.draft);}
});
async function routeSetup(){
 let emit,user=ACTOR,role='fiscal',serial=0;const source=fileURLToPath(new URL('../src/components/RealFiscalDrafts.tsx',import.meta.url)),names=[...String(await readFile(new URL('../src/components/native-modules.ts',import.meta.url),'utf8')).matchAll(/export const (\w+) = lazy/g)].map(x=>x[1]).filter(x=>x!=='RealFiscalDrafts');
 const session=()=>({access_token:'synthetic082-'+serial,user:{id:user}}),calls=[],draft=unsignedFixture().draft;
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})};
 const controller=access.createAccessController(auth,'https://erp.synthetic.invalid',async(url,o)=>{
  if(url.endsWith('/me'))return Response.json({user_id:user,role,resources:[],data_mode:'staging_readonly'});calls.push({url,...o});assert.equal(o.method,'GET');assert.equal(o.body,undefined);
  if(new URL(url).pathname==='/v1/rascunhos-fiscais/resumo'){const r=row();r.draft.id=draft.record.id;r.draft.contact_name=user===ACTOR?'FIRST ACTOR SYNTHETIC':'SECOND ACTOR SYNTHETIC';return Response.json(page([r]));}
  if(new URL(url).pathname==='/v1/rascunhos-fiscais/'+draft.record.id)return Response.json(draft);if(new URL(url).pathname==='/v1/rascunhos-fiscais/'+draft.record.id+'/revisions')return Response.json({data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false,draft_id:draft.record.id,items:[],limit:25,has_more:false,next_cursor:null});throw Error('UNEXPECTED_ROUTE');
 });
 const view=await mountComponent('RealAccess.tsx',{}, {componentName:'ConnectedArea',location:'/emissor-fiscal',expandChildren:true,ports:{access,controller},modules:{
  '../lib/real-access':'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
  '@supabase/supabase-js':'export const createClient=()=>({auth:{}});',
  '../lib/access-config':'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://erp.synthetic.invalid"});',
  './NativeModuleBoundary':'export default function NativeModuleBoundary({children}){return children;}', './CompanyNavigation':'export default function CompanyNavigation(){return null;}',
  './FiscalPreparationGuide':'export default function FiscalPreparationGuide(){return null;}',
  './FiscalDraftReview':'export default function FiscalDraftReview(){return null;}', './FiscalItemPreparation':'export default function FiscalItemPreparation(){return null;}', './FiscalTaxPreparation':'export default function FiscalTaxPreparation(){return null;}', './FiscalBusinessCompletion':'export default function FiscalBusinessCompletion(){return null;}', './FiscalUnsignedPreview':'export default function FiscalUnsignedPreview(){return null;}', './RevisionHistory':'export default function RevisionHistory(){return null;}',
  './native-modules':`export {default as RealFiscalDrafts} from ${JSON.stringify(source)};${names.map(n=>`export function ${n}(){return null;}`).join('')}`,
 }});
 return{view,controller,calls,async role(value){role=value;serial++;emit('TOKEN_REFRESHED',session());await view.flush();},async actor(value){user=value;serial++;emit('SIGNED_IN',session());await view.flush();}};
}
test('082 actual actor-keyed route resets editor on actor change and accepts the new actor without reviving old callbacks',async()=>{
 const f=await routeSetup(),v=f.view;try{
  assert.match(v.text(),/FIRST ACTOR SYNTHETIC/);const oldOpen=v.button('Abrir preparação').props.onClick,oldCreate=v.button('Incluir rascunho').props.onClick;await v.click('Abrir preparação');assert.match(v.text(),/Voltar à listagem/);
  await f.actor(OTHER);assert.match(v.text(),/SECOND ACTOR SYNTHETIC/);assert.doesNotMatch(v.text(),/FIRST ACTOR SYNTHETIC|Voltar à listagem/);const count=f.calls.length;oldOpen();oldCreate();await v.flush();assert.equal(f.calls.length,count);assert.match(v.text(),/SECOND ACTOR SYNTHETIC/);
  await v.click('Abrir preparação');assert.match(v.text(),/Voltar à listagem/);assert.equal(f.calls.length,count+2); // Editor plus immutable revision history.
 }finally{v.unmount();}
});
test('082 actual route denies current role loss, then restores only a fresh read for the same actor',async()=>{
 const f=await routeSetup(),v=f.view;try{const old=v.button('Abrir preparação').props.onClick;await f.role('consulta');const count=f.calls.length;old();await v.flush();assert.equal(f.calls.length,count);assert.doesNotMatch(v.text(),/FIRST ACTOR SYNTHETIC|12345678901234567/);assert.equal(v.find(n=>n.type==='div'&&n.props.hidden===true).props.inert,true);await f.role('fiscal');assert.match(v.text(),/FIRST ACTOR SYNTHETIC/);await v.click('Abrir preparação');assert.match(v.text(),/Voltar à listagem/);}finally{v.unmount();}
});
