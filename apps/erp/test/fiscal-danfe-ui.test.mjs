import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {signedFixture} from './helpers/fiscal-signed-ui-fixture.mjs';
import {AccessError} from '../src/lib/real-access.ts';
import {fixture,actor} from '../../../packages/fiscal-danfe-runtime/test/fixtures.mjs';

const values={55:await fixture(),65:await fixture({model:'65'})},copy=structuredClone;
const OPEN='Visualizar prévia de impressão',PRINT='Imprimir prévia sem valor fiscal',CLOSE='Fechar prévia';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function setup({model='55',read}={}){
 const f=values[model],signed=signedFixture({model,state:'stored'}),candidate=signed.candidate,subscribers=new Set(),calls=[];
 Object.assign(candidate,{candidate_id:f.id,candidate_version:f.dto.candidate_version});Object.assign(candidate.current,{latest_candidate_id:f.id,latest_candidate_version:f.dto.candidate_version});
 Object.assign(candidate.artifact,{sha256:f.dto.source_sha256,size_bytes:f.dto.source_size_bytes});
 let snapshot={phase:'ready',membership:{user_id:actor,role:'fiscal'}};
 const controller={...signed.controller,getSnapshot:()=>snapshot,subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);},
  async fiscalDanfe(path,o={}){const call={path,method:o.method??'GET',signal:o.signal};calls.push(call);return read?read(call):copy(f.dto);}};
 return{f,signed,candidate,controller,calls,change(snapshotValue){snapshot=snapshotValue;for(const fn of subscribers)fn();},listeners:()=>subscribers.size};
}
const mount=(s,props={})=>mountComponent('FiscalDanfePreview.tsx',{controller:s.controller,candidate:copy(s.candidate),...props},{ports:{AccessError}});
const frames=v=>v.nodes().filter(n=>n.type==='iframe');
function connect(v){
 const node=v.find(n=>n.type==='iframe'),calls={focus:0,print:0};
 const element={contentWindow:{focus(){calls.focus++;},print(){calls.print++;}}};node.props.ref.current=element;
 return{node,element,calls,load:async()=>{node.props.onLoad({currentTarget:element});await v.flush();}};
}
test('DANFE UI opens only on click, binds both rendered models and prints only after its sandboxed frame loads',async()=>{
 for(const model of ['55','65']){const s=setup({model}),v=await mount(s);try{
  assert.equal(s.calls.length,0);assert.equal(frames(v).length,0);assert.match(v.text(),/Sem autorização fiscal e sem valor fiscal/);
  await v.click(OPEN);assert.equal(s.calls.length,1);assert.equal(s.calls[0].path,`/v1/fiscal-danfe/candidates/${s.f.id}/preview`);assert.equal(s.calls[0].method,'GET');
  const f=connect(v);assert.equal(f.node.props.srcDoc,s.f.dto.html);assert.equal(f.node.props.referrerPolicy,'no-referrer');
  const sandbox=new Set(f.node.props.sandbox.split(' '));assert.deepEqual(sandbox,new Set(['allow-same-origin','allow-modals']));assert.equal(sandbox.has('allow-scripts'),false);assert.equal(f.node.props.src,undefined);
  assert.equal(v.button(PRINT).disabled,true);v.button(PRINT).props.onClick();assert.equal(f.calls.print,0);
  await f.load();assert.equal(v.button(PRINT).disabled,false);await v.click(PRINT);assert.deepEqual(f.calls,{focus:1,print:1});assert.equal(s.calls.length,1);
 }finally{v.unmount();assert.equal(s.listeners(),0);}}
});
test('DANFE UI refuses a validly hashed response bound to another candidate, hash, size, version or model',async()=>{
 const changes=[v=>v.candidate_id=randomUUID(),v=>v.source_sha256='0'.repeat(64),v=>v.source_size_bytes++,v=>v.candidate_version++,v=>{v.model='65';v.profile='candidate-danfe65-manual6-v1';v.page_count=null;}];
 for(const change of changes){const value=copy(values[55].dto);change(value);const s=setup({read:async()=>value}),v=await mount(s);try{
  await v.click(OPEN);assert.equal(frames(v).length,0);assert.match(v.text(),/Não foi possível abrir a prévia/);assert.equal(s.calls.length,1);
 }finally{v.unmount();}}
});
test('close or unmount aborts an in-flight GET and late success cannot restore HTML or issue another request',async()=>{
 for(const mode of ['close','unmount']){const response=gate(),s=setup({read:()=>response.promise}),v=await mount(s);let unmounted=false;try{
  await v.click(OPEN);assert.equal(s.calls.length,1);assert.equal(v.button(OPEN).disabled,true);
  if(mode==='close')await v.click(CLOSE);else{v.unmount();unmounted=true;}
  assert.equal(s.calls[0].signal.aborted,true);response.resolve(copy(s.f.dto));await v.flush();assert.equal(frames(v).length,0);assert.equal(s.calls.length,1);
 }finally{response.resolve(copy(s.f.dto));if(!unmounted)v.unmount();}}
});
test('logout, actor change and revoked role clear loaded HTML and invalidate captured load/print callbacks',async()=>{
 for(const next of [{phase:'signed_out',membership:null},{phase:'ready',membership:{user_id:randomUUID(),role:'fiscal'}},{phase:'ready',membership:{user_id:actor,role:'consulta'}}]){
  const s=setup(),v=await mount(s);try{await v.click(OPEN);const f=connect(v);await f.load();const print=v.button(PRINT).props.onClick;
   s.change(next);await v.flush();assert.equal(frames(v).length,0);f.node.props.onLoad({currentTarget:f.element});print();await v.flush();assert.equal(f.calls.print,0);assert.equal(s.calls.length,1);
  }finally{v.unmount();}
 }
});
test('a changed source identity, hash, size, status, model or version cancels the in-flight preview',async()=>{
 const changes=[c=>c.candidate_id=randomUUID(),c=>c.artifact.sha256='0'.repeat(64),c=>c.artifact.size_bytes++,c=>c.status='pending',c=>c.model='65',c=>c.candidate_version++];
 for(const change of changes){const response=gate(),s=setup({read:()=>response.promise}),v=await mount(s);try{
  await v.click(OPEN);const candidate=copy(s.candidate);change(candidate);await v.updateProps({candidate});
  assert.equal(s.calls[0].signal.aborted,true,`source must abort: ${change}`);response.resolve(copy(s.f.dto));await v.flush();assert.equal(frames(v).length,0);assert.equal(s.calls.length,1);
 }finally{response.resolve(copy(s.f.dto));v.unmount();}}
});
test('closing loaded HTML invalidates old handlers, including after reopening identical HTML before the new frame load',async()=>{
 const s=setup(),v=await mount(s);try{
  await v.click(OPEN);const first=connect(v);await first.load();const oldPrint=v.button(PRINT).props.onClick;
  await v.click(CLOSE);oldPrint();first.node.props.onLoad({currentTarget:first.element});await v.flush();assert.equal(first.calls.print,0);assert.equal(frames(v).length,0);
  await v.click(OPEN);const second=connect(v);assert.equal(v.button(PRINT).disabled,true);
  oldPrint();first.node.props.onLoad({currentTarget:first.element});await v.flush();assert.equal(second.calls.print,0);assert.equal(v.button(PRINT).disabled,true);
  await second.load();await v.click(PRINT);assert.equal(second.calls.print,1);assert.equal(s.calls.length,2);
 }finally{v.unmount();}
});
test('blocked/not-stored/unauthorized controls cannot open or print, including stale enabled handlers',async()=>{
 const s=setup(),v=await mount(s);try{
  const oldOpen=v.button(OPEN).props.onClick;await v.updateProps({blocked:true});oldOpen();await v.flush();assert.equal(s.calls.length,0);
  await v.updateProps({blocked:false});await v.click(OPEN);const f=connect(v);await f.load();const oldPrint=v.button(PRINT).props.onClick;
  await v.updateProps({blocked:true});oldPrint();assert.equal(f.calls.print,0);assert.equal(v.button(PRINT).disabled,true);
 }finally{v.unmount();}
 const p=setup(),view=await mount(p,{candidate:{...copy(p.candidate),status:'pending',artifact:null}});try{assert.equal(view.button(OPEN).disabled,true);view.button(OPEN).props.onClick();await view.flush();assert.equal(p.calls.length,0);}finally{view.unmount();}
});
test('DANFE failures do not auto retry or show HTML and historical previews retain their explicit notice',async()=>{
 for(const status of [401,403,404,409,422,503]){const s=setup({read:async()=>{throw new AccessError(status);}}),v=await mount(s);try{await v.click(OPEN);assert.equal(frames(v).length,0);assert.equal(s.calls.length,1);assert.ok(v.nodes().some(n=>n.props.role==='alert'));await v.flush();assert.equal(s.calls.length,1);}finally{v.unmount();}}
 const raw=copy(values[55].dto);raw.current.artifact_current=false;raw.current.a1_changed=true;const s=setup({read:async()=>raw}),v=await mount(s);try{await v.click(OPEN);assert.match(v.text(),/Arquivo histórico/);assert.equal(frames(v).length,1);}finally{v.unmount();}
});
test('signed parent includes the optional preview only for a stored artifact and available read/subscription ports',async()=>{
 for(const available of [false,true]){const s=setup(),controller={...s.controller};if(!available)delete controller.fiscalDanfe;
  const v=await mountComponent('FiscalSignedCandidate.tsx',{controller,job:copy(s.signed.f.job),model:'55'},{expandChildren:['FiscalDanfePreview'],ports:{AccessError}});try{
   assert.deepEqual(s.signed.calls.map(c=>c.kind),['a1','history']);assert.equal(s.calls.length,0);
   assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children===OPEN),available);
   if(available){await v.click(OPEN);assert.equal(s.calls.length,1);assert.equal(s.signed.counts.run,undefined);assert.equal(frames(v).length,1);}
  }finally{v.unmount();}
 }
});
