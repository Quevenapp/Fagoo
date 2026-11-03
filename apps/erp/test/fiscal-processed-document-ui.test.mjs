import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {processedUiFixtures} from './helpers/fiscal-processed-document-fixtures.mjs';
let f;test.before(async()=>f=await processedUiFixtures());test.after(()=>f?.close());
const view='Visualizar DANFE de homologação',download='Baixar XML do teste';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function setup(x,before){let state={phase:'ready',membership:{role:'fiscal',user_id:x.actor}};const listeners=new Set(),calls=[];return{calls,controller:{getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},fiscalProcessedDocument:async(path,opts)=>{calls.push({path,opts});return before?before(path,opts):path.endsWith('/xml')?x.xml:x.print;}},set state(s){state=s;listeners.forEach(fn=>fn());}};}
test('55/65 start with zero reads and show sandboxed protocol document only on explicit click',async()=>{
 for(const model of ['55','65']){const x=await f.create(model,'revalidation'),s=setup(x),v=await mountComponent('FiscalProcessedDocument.tsx',{controller:s.controller,source:x.reference});try{assert.equal(s.calls.length,0);await v.click(view);assert.equal(s.calls.length,1);assert.equal(s.calls[0].opts.body,undefined);const frame=v.find(n=>n.type==='iframe');assert.equal(frame.props.sandbox,'allow-same-origin allow-modals');assert.match(frame.props.srcDoc,/SEM VALOR FISCAL/);assert.match(v.text(),new RegExp(x.print.source.protocol.number));assert.equal(v.button('Imprimir DANFE sem valor fiscal').disabled,true);await v.click('Fechar arquivos');assert.equal(v.nodes().some(n=>n.type==='iframe'),false);}finally{v.unmount();}}
});
test('late responses after role loss/logout/actor/source change are hidden; old source handlers cannot request another document',async()=>{
 for(const mode of ['role','logout','actor','source','protocol']){const x=await f.create(),wait=deferred(),s=setup(x,()=>wait.promise),v=await mountComponent('FiscalProcessedDocument.tsx',{controller:s.controller,source:x.reference});try{const old=v.button(view);old.props.onClick();await v.flush();if(mode==='source'||mode==='protocol')await v.updateProps({source:{...x.reference,...(mode==='source'?{candidateVersion:2}:{protocolNumber:'1'.repeat(x.reference.protocolNumber.length)})}});else s.state=mode==='logout'?{phase:'signed_out',membership:null}:{phase:'ready',membership:{role:mode==='role'?'consulta':'fiscal',user_id:mode==='actor'?'f0000000-0000-4000-8000-000000000001':x.actor}};await v.flush();old.props.onClick();wait.resolve(x.print);await v.flush();assert.equal(v.nodes().some(n=>n.type==='iframe'),false);assert.equal(s.calls.length,1);}finally{wait.resolve(x.print);v.unmount();}}
});
test('valid document DTO with another recorded protocol never reaches iframe or XML download',async t=>{
 const x=await f.create('65','revalidation');let downloads=0;t.mock.method(URL,'createObjectURL',()=>{downloads++;return'blob:unexpected';});
 const s=setup(x,path=>{const raw=structuredClone(path.endsWith('/xml')?x.xml:x.print);raw.source.protocol.number='1'.repeat(raw.source.protocol.number.length);return raw;}),v=await mountComponent('FiscalProcessedDocument.tsx',{controller:s.controller,source:x.reference});
 try{await v.click(view);assert.equal(v.nodes().some(n=>n.type==='iframe'),false);await v.click(download);assert.equal(downloads,0);assert.equal(s.calls.length,2);assert.equal(v.nodes().some(n=>n.props?.role==='alert'),true);}finally{v.unmount();}
});
test('layout failure preserves download choice and a click downloads exact verified XML without an automatic second GET',async t=>{
 const x=await f.create(),s=setup(x,path=>{if(path.endsWith('/print'))throw new AccessError(422);return x.xml;}),v=await mountComponent('FiscalProcessedDocument.tsx',{controller:s.controller,source:x.reference});const prior=globalThis.document;let blob,clicked=0,revoke=0;
 t.mock.method(URL,'createObjectURL',b=>{blob=b;return'blob:synthetic';});t.mock.method(URL,'revokeObjectURL',()=>revoke++);globalThis.document={createElement:()=>({click(){clicked++;}})};
 try{await v.click(view);assert.equal(v.button(download).disabled,false);await v.click(download);assert.equal(clicked,1);assert.equal(s.calls.length,2);assert.equal(await blob.text(),Buffer.from(x.xml.xml_base64,'base64').toString());assert.ok(revoke>=1);}finally{v.unmount();if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});
