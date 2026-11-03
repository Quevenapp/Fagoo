import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const content=Buffer.from('<nfe>synthetic</nfe>');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
function fixture(overrides={}){
 let state={phase:'ready',membership:{role:'admin',user_id:'PRIVATE_ACTOR'}};const listeners=new Set(),calls=[];
 const controller={getSnapshot:()=>state,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},historyDownload:async(path,signal)=>{calls.push({path,signal});return new Blob([content]);},syncedXmlDownload:async(path,signal)=>{calls.push({path,signal});return new Blob([content]);},...overrides};
 return{controller,calls,setSession(next){state=next;for(const listener of [...listeners])listener();},listeners};
}
function plan(){return{profile:'origin-storage-audit-plan-v1',inventory_sha256:'a'.repeat(64),inventory_payload_sha256:'b'.repeat(64),entries:[
 {reference_sha256:'c'.repeat(64),sha256:digest(content),size_bytes:content.length,download:{kind:'backup_xml',backup_sha256:'d'.repeat(64),xml_sha256:digest(content)}},
 {reference_sha256:'e'.repeat(64),sha256:digest(content),size_bytes:content.length,download:{kind:'synced_xml',item_id:'12345678-1234-1234-1234-123456789abc'}}]};}
const file=value=>new File([JSON.stringify(value)],'private-plan.json',{type:'application/json'});
async function choose(app,value){const input=app.nodes().find(n=>n.type==='input'&&n.props.type==='file');input.props.onChange({target:{files:[value]}});await app.flush();}
const textArea=app=>app.nodes().find(n=>n.type==='textarea');
async function paste(app,text){textArea(app).props.onChange({target:{value:text}});await app.flush();}
async function settled(app){for(let i=0;i<10;i++){await app.flush();if(app.nodes().some(n=>n.type==='button'&&n.props.children==='Salvar relatório'))return;}throw new Error('Audit did not settle');}

test('Storage audit component validates input, uses both real model GET ports and exports only the finite report',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 const originalDocument=globalThis.document,createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL;let saved,download,revoked;
 try{
  await choose(app,{size:16*1024*1024+1,arrayBuffer(){throw new Error('must not read oversized file');}});assert.match(app.text(),/excede o limite/);assert.equal(f.calls.length,0);
  await choose(app,file({...plan(),url:'https://PRIVATE_TOKEN.invalid'}));assert.match(app.text(),/Não foi possível carregar/);assert.equal(f.calls.length,0);
  await choose(app,file(plan()));assert.match(app.text(),/2 arquivos/);assert.doesNotMatch(app.text(),/PRIVATE_ACTOR|PRIVATE_TOKEN|private-plan/);
  await app.click('Conferir arquivos');await settled(app);assert.equal(f.calls.length,2);assert.match(f.calls[0].path,/^\/v1\/history\/xml\/[a-f0-9]{64}\/download\?backup=[a-f0-9]{64}$/);assert.match(f.calls[1].path,/^\/v1\/xmls-sincronizados\/[a-f0-9-]{36}\/download$/);assert.match(app.text(),/2 confirmados, 0 com pendência e 0 não consultados/);
  URL.createObjectURL=blob=>{saved=blob;return'blob:synthetic';};URL.revokeObjectURL=url=>{revoked=url;};globalThis.document={createElement:()=>({set href(v){assert.equal(v,'blob:synthetic');},set download(v){download=v;},click(){}})};
  await app.click('Salvar relatório');assert.equal(revoked,'blob:synthetic');assert.match(download,/^conferencia-arquivos-[a-f0-9]{12}\.json$/);
  const text=await saved.text(),report=JSON.parse(text);assert.equal(report.profile,'origin-storage-audit-report-v1');assert.equal(report.read_only,true);assert.equal(report.results.length,2);assert(report.results.every(row=>row.status==='verified'));assert.doesNotMatch(text,/PRIVATE_ACTOR|PRIVATE_TOKEN|https:|\/v1\/|private-plan/);
 }finally{app.unmount();globalThis.document=originalDocument;URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;}
});

test('Storage audit drops late file loading and a completed report when the administrator changes',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller}),pending=deferred();
 try{
  await choose(app,{size:100,arrayBuffer:()=>pending.promise});assert.match(app.text(),/Lendo lista/);
  f.setSession({phase:'ready',membership:{role:'admin',user_id:'ANOTHER_PRIVATE_ACTOR'}});await app.flush();pending.resolve(await file(plan()).arrayBuffer());await app.flush();assert.doesNotMatch(app.text(),/Lista carregada/);assert.equal(f.calls.length,0);
  await choose(app,file(plan()));await app.click('Conferir arquivos');await settled(app);
  f.setSession({phase:'ready',membership:{role:'consulta',user_id:'ANOTHER_PRIVATE_ACTOR'}});await app.flush();assert.equal(app.text(),'');assert.equal(app.nodes().filter(n=>n.type==='button').length,0);
 }finally{app.unmount();}
});

test('Storage audit stops a pending download, retains a partial report and ignores late success',async()=>{
 const pending=deferred(),signals=[],f=fixture({historyDownload:(_path,signal)=>{signals.push(signal);return pending.promise;},syncedXmlDownload:(_path,signal)=>{signals.push(signal);return pending.promise;}});
 const app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 try{
  await choose(app,file(plan()));await app.click('Conferir arquivos');assert.equal(signals.length,2);assert(app.nodes().find(n=>n.type==='input').disabled);
  await app.click('Interromper');await settled(app);assert(signals.every(s=>s.aborted));assert.match(app.text(),/Conferência interrompida/);assert.match(app.text(),/0 confirmados, 2 com pendência/);
  pending.resolve(new Blob([content]));await app.flush();assert.doesNotMatch(app.text(),/2 confirmados, 0 com pendência/);
 }finally{app.unmount();}
});

test('Storage audit unmount aborts outstanding reads and subscription failure prevents controls',async()=>{
 const pending=deferred(),signals=[],f=fixture({historyDownload:(_path,signal)=>{signals.push(signal);return pending.promise;},syncedXmlDownload:(_path,signal)=>{signals.push(signal);return pending.promise;}});
 const app=await mountComponent('StorageAudit.tsx',{controller:f.controller});await choose(app,file(plan()));await app.click('Conferir arquivos');app.unmount();assert(signals.every(s=>s.aborted));await app.flush();assert.equal(f.listeners.size,0);pending.resolve(new Blob([content]));await app.flush();
 const denied=await mountComponent('StorageAudit.tsx',{controller:fixture({subscribe(){throw new Error('PRIVATE_SUBSCRIPTION_ERROR');}}).controller});try{assert.equal(denied.text(),'');}finally{denied.unmount();}
});

test('Storage audit stale controls cannot start an old plan after replacement or administrator change',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 try{
  await choose(app,file(plan()));const oldStart=app.button('Conferir arquivos').props.onClick;
  await choose(app,file(plan()));oldStart();await app.flush();assert.equal(f.calls.length,0);
  const previousActorStart=app.button('Conferir arquivos').props.onClick;
  const previousActorInput=app.nodes().find(n=>n.type==='input').props.onChange;
  f.setSession({phase:'ready',membership:{role:'admin',user_id:'ANOTHER_PRIVATE_ACTOR'}});await app.flush();previousActorStart();previousActorInput({target:{files:[file(plan())]}});await app.flush();assert.equal(f.calls.length,0);assert.doesNotMatch(app.text(),/Lista carregada/);
 }finally{app.unmount();}
});

test('Storage audit cancels an unfinished file read immediately and ignores its eventual bytes',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller}),pending=deferred();
 try{
  await choose(app,{size:100,arrayBuffer:()=>pending.promise});await app.click('Interromper');assert.match(app.text(),/Leitura interrompida/);assert.equal(app.nodes().find(n=>n.type==='input').disabled,false);
  pending.resolve(await file(plan()).arrayBuffer());await app.flush();assert.doesNotMatch(app.text(),/Lista carregada/);assert.equal(f.calls.length,0);
 }finally{app.unmount();}
});

test('Storage audit pasted text preserves exact UTF8 bytes and displays the same hash as the exported report',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 const text='\ufeff\r\n'+JSON.stringify(plan(),null,2).replace(/\n/g,'\r\n').replace('"profile"','"\\u0070rofile"')+'\r\n\t';
 const expected=digest(new TextEncoder().encode(text)),originalDocument=globalThis.document,createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL;let saved;
 try{
  await paste(app,text);assert.equal(textArea(app).props.value,text);assert.equal(f.calls.length,0);assert(app.button('Conferir arquivos').disabled);
  await app.click('Carregar texto');assert.match(app.text(),/Lista carregada: 2 arquivos/);assert(app.text().includes(expected));assert.notEqual(expected,digest(JSON.stringify(plan())));assert.equal(f.calls.length,0);
  await app.click('Conferir arquivos');await settled(app);assert.equal(f.calls.length,2);
  URL.createObjectURL=blob=>{saved=blob;return'blob:synthetic';};URL.revokeObjectURL=()=>{};globalThis.document={createElement:()=>({click(){}})};
  await app.click('Salvar relatório');assert.equal(JSON.parse(await saved.text()).plan_sha256,expected);
 }finally{app.unmount();globalThis.document=originalDocument;URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;}
});

test('Storage audit text editing invalidates the prepared plan, progress, report and retained controls',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 try{
  await paste(app,JSON.stringify(plan()));await app.click('Carregar texto');const oldStart=app.button('Conferir arquivos').props.onClick,oldLoad=app.button('Carregar texto').props.onClick;
  await paste(app,JSON.stringify(plan())+'\n');oldStart();oldLoad();await app.flush();assert.equal(f.calls.length,0);assert.doesNotMatch(app.text(),/Lista carregada|SHA-256 do plano/);assert(app.button('Conferir arquivos').disabled);
  await app.click('Carregar texto');await app.click('Conferir arquivos');await settled(app);const oldSave=app.button('Salvar relatório').props.onClick;assert.equal(f.calls.length,2);
  await paste(app,JSON.stringify(plan())+'\n\n');oldStart();oldSave();await app.flush();assert.equal(f.calls.length,2);assert.doesNotMatch(app.text(),/Lista carregada|Conferência encerrada|de 2 conferidos/);assert(!app.nodes().some(n=>n.type==='button'&&n.props.children==='Salvar relatório'));
 }finally{app.unmount();}
});

test('Storage audit pasted text is cleared for actor/controller change and stale handlers cannot reload after unmount',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 try{
  await paste(app,JSON.stringify(plan()));const oldLoad=app.button('Carregar texto').props.onClick,oldEdit=textArea(app).props.onChange;
  f.setSession({phase:'ready',membership:{role:'admin',user_id:'ANOTHER_PRIVATE_ACTOR'}});await app.flush();assert.equal(textArea(app).props.value,'');oldLoad();oldEdit({target:{value:JSON.stringify(plan())}});await app.flush();assert.equal(textArea(app).props.value,'');assert.doesNotMatch(app.text(),/Lista carregada/);
  await paste(app,JSON.stringify(plan()));const priorControllerLoad=app.button('Carregar texto').props.onClick;const next=fixture();await app.updateProps({controller:next.controller});assert.equal(textArea(app).props.value,'');priorControllerLoad();await app.flush();assert.doesNotMatch(app.text(),/Lista carregada/);
  await paste(app,JSON.stringify(plan()));const detachedLoad=app.button('Carregar texto').props.onClick;app.unmount();detachedLoad();await app.flush();assert.equal(f.calls.length+next.calls.length,0);
 }finally{app.unmount();}
});

test('Storage audit paste rejects actual UTF8 oversize without truncation and retains the normal file path',async()=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 try{
  const large='á'.repeat(8*1024*1024+1);await paste(app,large);await app.click('Carregar texto');assert.match(app.text(),/excede o limite de 16 MB/);assert.equal(textArea(app).props.value,large);assert.equal(f.calls.length,0);
  await paste(app,'not JSON');await app.click('Carregar texto');assert.match(app.text(),/Não foi possível carregar/);assert(app.button('Conferir arquivos').disabled);
  const selected=file(plan()),expected=digest(new Uint8Array(await selected.arrayBuffer()));await choose(app,selected);assert.equal(textArea(app).props.value,'');assert(app.text().includes(expected));await app.click('Conferir arquivos');await settled(app);assert.equal(f.calls.length,2);
 }finally{app.unmount();}
});

test('Storage audit text controls are locked while loading and a late digest cannot revive a stopped selection',async(t)=>{
 const f=fixture(),app=await mountComponent('StorageAudit.tsx',{controller:f.controller}),gate=deferred(),original=crypto.subtle.digest.bind(crypto.subtle);let hashing=false;
 const mocked=t.mock.method(crypto.subtle,'digest',async(...args)=>{hashing=true;await gate.promise;return original(...args);});
 try{
  const value=JSON.stringify(plan());await paste(app,value);await app.click('Carregar texto');assert(hashing);assert(textArea(app).disabled);assert(app.button('Carregar texto').disabled);assert(app.nodes().find(n=>n.type==='input').disabled);
  textArea(app).props.onChange({target:{value:'changed while loading'}});app.button('Carregar texto').props.onClick();await app.flush();assert.equal(textArea(app).props.value,value);
  await app.click('Interromper');gate.resolve();await app.flush();assert.doesNotMatch(app.text(),/Lista carregada/);assert.equal(f.calls.length,0);assert.equal(textArea(app).disabled,false);
 }finally{gate.resolve();mocked.mock.restore();app.unmount();}
});

test('Storage audit pasted plan cannot be replaced or reloaded during downloads',async()=>{
 const gate=deferred(),f=fixture({historyDownload:()=>{f.calls.push('backup');return gate.promise;},syncedXmlDownload:()=>{f.calls.push('synced');return gate.promise;}}),app=await mountComponent('StorageAudit.tsx',{controller:f.controller});
 try{
  const value=JSON.stringify(plan());await paste(app,value);await app.click('Carregar texto');await app.click('Conferir arquivos');assert.equal(f.calls.length,2);assert(textArea(app).disabled);assert(app.button('Carregar texto').disabled);
  textArea(app).props.onChange({target:{value:'replacement'}});app.button('Carregar texto').props.onClick();await app.flush();assert.equal(textArea(app).props.value,value);assert.equal(f.calls.length,2);
  await app.click('Interromper');await settled(app);gate.resolve(new Blob([content]));await app.flush();assert.match(app.text(),/Conferência interrompida/);assert.equal(f.calls.length,2);
 }finally{gate.resolve(new Blob([content]));app.unmount();}
});
