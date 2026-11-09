import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
const actor=randomUUID(),unit=randomUUID(),contact=randomUUID(),funnel=randomUUID(),opportunity=randomUUID();
const context={user_id:actor,role:'operacao',units:[{id:unit,name:'Recepção',timezone:'America/Sao_Paulo',capabilities:['crm.read','crm.write'],team_ids:[]}]};
const snapshot={unit_id:unit,contacts:[{id:contact,name:'Contato Sintético'}],funnels:[{id:funnel,name:'Comercial',active:true,version:1,stages:[{id:'new',name:'Novo',status:'open'},{id:'won',name:'Ganho',status:'won'}]}],opportunities:[{id:opportunity,title:'Proposta',contact_id:contact,owner_id:actor,funnel_id:funnel,stage:'new',amount:'90',version:1,can_write:true}],tasks:[],timeline:[],members:[{user_id:actor,name:'Operador'}],can_configure:false};
test('CRM uncertain move recovers the receipt without sending the command twice',async()=>{
 const calls=[];const controller={async crm(path,options={}){calls.push({path,...options});if(path.endsWith('/snapshot'))return structuredClone(snapshot);if(path.includes('/contacts?'))return {contacts:snapshot.contacts};if(options.method==='POST')throw new AccessError(503);if(path.includes('/commands/'))return {status:'succeeded'};throw new Error(path);},async communication(){throw new Error('not authorized');}};
 const view=await mountComponent('FagooCrm.tsx',{controller,context});try{
  view.find(n=>n.props?.['aria-label']==='Etapa de Proposta').props.onChange({target:{value:'won'}});await view.flush();
  assert.match(view.text(),/Resultado pendente/);const command=calls.find(c=>c.method==='POST').body;assert.ok(command.command_id);assert.equal(command.payload.expected_version,1);
  view.button('Consultar resultado').props.onClick();await view.flush();assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.ok(calls.some(c=>c.path.endsWith(command.command_id)));assert.match(view.text(),/Operação confirmada/);
 }finally{view.unmount();}
});
test('CRM read-only unit shows no write controls or communication requests',async()=>{
 const calls=[];const controller={async crm(path){calls.push(path);return path.includes('/contacts?')?{contacts:[]}:structuredClone(snapshot);},async communication(){throw new Error('forbidden');}};
 const readContext={...context,units:[{...context.units[0],capabilities:['crm.read']}]};const view=await mountComponent('FagooCrm.tsx',{controller,context:readContext});try{
  assert.throws(()=>view.button('Nova oportunidade'));assert.throws(()=>view.find(n=>n.props?.['aria-label']==='Etapa de Proposta'));assert.match(view.text(),/Contato Sintético/);
 }finally{view.unmount();}
});
test('a missing CRM receipt retries the exact command identity and payload',async()=>{
 const writes=[];const controller={async crm(path,options={}){if(path.endsWith('/snapshot'))return structuredClone(snapshot);if(path.includes('/contacts?'))return {contacts:[]};if(options.method==='POST'){writes.push(structuredClone(options.body));if(writes.length===1)throw new AccessError(503);return {status:'succeeded'};}return {status:'not_found'};},async communication(){return {data:[]};}};
 const view=await mountComponent('FagooCrm.tsx',{controller,context});try{view.find(n=>n.props?.['aria-label']==='Etapa de Proposta').props.onChange({target:{value:'won'}});await view.flush();view.button('Consultar resultado').props.onClick();await view.flush();view.button('Reenviar a mesma operação').props.onClick();await view.flush();assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);}finally{view.unmount();}
});
test('selected canonical contact combines authorized relationship and communication histories',async()=>{
 const calls=[],stamp='2026-11-09T12:00:00Z';const controller={async crm(path){calls.push(path);if(path.endsWith('/snapshot'))return structuredClone(snapshot);if(path.includes('/contacts?'))return {contacts:snapshot.contacts};if(path.includes('/history?'))return {events:[{id:'document:1',at:stamp,kind:'commercial.document',title:'Pedido permitido',href:'/documentos-empresa?documento=synthetic'}]};throw new Error(path);},async communication(path){calls.push(path);return {data:[{id:'protocol:1',at:stamp,kind:'protocol',title:'Protocolo permitido'}]};}};
 const view=await mountComponent('FagooCrm.tsx',{controller,context:{...context,units:[{...context.units[0],capabilities:['crm.read','communication.read']}]}});try{view.find(n=>n.type==='select'&&n.props.value==='').props.onChange({target:{value:contact}});await view.flush();assert.match(view.text(),/Pedido permitido/);assert.match(view.text(),/Protocolo permitido/);assert.ok(calls.includes(`/v1/crm/units/${unit}/history?contact_id=${contact}`));assert.ok(calls.includes(`/v1/communication/units/${unit}/contact-timeline/${contact}`));}finally{view.unmount();}
});
test('Setup issue displays token once, hides it on another step, and never includes it in saved payload',async()=>{
 const device=randomUUID(),calls=[];const controller={async fagoo(path,options={}){calls.push({path,...options});if(path==='/v1/fagoo/setup')return {units:[{id:unit,name:'Recepção',timezone:'America/Sao_Paulo',active:true,settings:{},version:1}],members:[],devices:[{id:device,unit_id:unit,name:'Tela',active:true,capabilities:['panel.read'],settings:{},version:1}],capabilities:['panel.read']};if(options.method==='POST')return {token:'synthetic-token-shown-once'};throw new Error(path);}};
 const view=await mountComponent('FagooSetup.tsx',{controller,context:{...context,role:'admin'}});try{
  view.button('4. Dispositivos').props.onClick();await view.flush();assert.throws(()=>view.button('Emitir credencial'));view.find(n=>n.props?.['aria-label']==='Modo avançado').props.onChange({target:{checked:true}});await view.flush();view.button('Emitir credencial').props.onClick();await view.flush();assert.match(view.text(),/synthetic-token-shown-once/);
  const sent=calls.find(c=>c.method==='POST');assert.deepEqual(sent.body.payload,{id:device});view.button('5. Canais').props.onClick();await view.flush();assert.doesNotMatch(view.text(),/synthetic-token-shown-once/);
 }finally{view.unmount();}
});
test('Setup does not load global configuration for a unit operator',async()=>{
 const view=await mountComponent('FagooSetup.tsx',{controller:{async fagoo(){throw new Error('must not load');}},context});try{assert.match(view.text(),/precisa de permissão/);}finally{view.unmount();}
});
test('workspace permits a team-chat-only unit without granting private WhatsApp',async()=>{
 const view=await mountComponent('FagooHome.tsx',{context:{...context,units:[{...context.units[0],capabilities:['team.chat']}]}});
 try{assert.ok(view.find(n=>n.props?.to==='/atendimento'));assert.throws(()=>view.find(n=>n.props?.to==='/crm'));assert.throws(()=>view.find(n=>n.props?.to==='/configurar'));}finally{view.unmount();}
});
test('queue contact link opens the exact authorized CRM contact outside the initial search page',async()=>{
 const selected=randomUUID(),calls=[];const controller={async crm(path){calls.push(path);if(path.endsWith('/snapshot'))return structuredClone(snapshot);if(path.includes('contact_id=')&&path.includes('/contacts?'))return {contacts:[{id:selected,name:'Contato da fila'}]};if(path.includes('/contacts?'))return {contacts:snapshot.contacts};if(path.includes('/history?'))return {events:[{id:'ticket:1',at:'2026-11-09T12:00:00Z',kind:'queue.ticket',title:'Senha vinculada'}]};throw new Error(path);},async communication(){throw new Error('not authorized');}};
 const view=await mountComponent('FagooCrm.tsx',{controller,context},{location:`/crm?unit=${unit}&contact=${selected}`});try{assert.match(view.text(),/Contato da fila/);assert.match(view.text(),/Senha vinculada/);assert.ok(view.find(n=>n.type==='select'&&n.props.value===selected));assert.ok(calls.includes(`/v1/crm/units/${unit}/history?contact_id=${selected}`));}finally{view.unmount();}
});
test('same actor capability changes keep an uncertain CRM receipt for GET-only recovery',async()=>{
 const writes=[],reads=[];const controller={async crm(path,options={}){if(options.method==='POST'){writes.push(options.body);throw new AccessError(503);}reads.push(path);if(path.endsWith('/snapshot'))return structuredClone(snapshot);if(path.includes('/contacts?'))return {contacts:[]};return {status:'succeeded'};},async communication(){return {data:[]};}};
 const view=await mountComponent('FagooCrm.tsx',{controller,context});try{view.find(n=>n.props?.['aria-label']==='Etapa de Proposta').props.onChange({target:{value:'won'}});await view.flush();await view.updateProps({context:{...context,units:[{...context.units[0],capabilities:['crm.read']}]}});assert.match(view.text(),/Resultado pendente/);view.button('Consultar resultado').props.onClick();await view.flush();assert.equal(writes.length,1);assert.ok(reads.some(path=>path.endsWith(writes[0].command_id)));assert.match(view.text(),/Operação confirmada/);}finally{view.unmount();}
});
test('context refresh keeps same actor on transient failure but clears forbidden, malformed and signed-out access',async()=>{
 let response=context;const controller={async fagoo(){if(response instanceof Error)throw response;return response;}};const state={phase:'ready',membership:{user_id:actor}};
 // This fixture exercises useFagooContext; the lazy communication page and its
 // documentation context are outside that hook's rendering boundary.
 const modules={
  './NativeModuleBoundary':'export default ({children})=>children;',
  './ApiDocumentation':'export const ApiDocumentationProvider=({children})=>children;export const ManagedApiDocumentation=()=>null;export const documentationHref=()=>"/atendimento?page=api-docs";export const ApiDocumentationLink=props=>r.jsx("a",props);',
 };
 const view=await mountComponent('../../test/fixtures/FagooContextFixture.tsx',{controller,state},{modules});try{assert.match(view.text(),new RegExp(actor));response=new AccessError(503);view.button('Revalidar').props.onClick();await view.flush();assert.match(view.text(),new RegExp(actor));response=new AccessError(403);view.button('Revalidar').props.onClick();await view.flush();assert.match(view.text(),/no-context/);response=context;view.button('Revalidar').props.onClick();await view.flush();response={...context,user_id:randomUUID()};view.button('Revalidar').props.onClick();await view.flush();assert.match(view.text(),/no-context/);response=context;view.button('Revalidar').props.onClick();await view.flush();await view.updateProps({state:{phase:'signed-out'}});assert.match(view.text(),/no-context/);}finally{view.unmount();}
});
