import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
import {processedReceiptQueryFixtures} from './processed-receipt-query-fixture.mjs';
import {createProcessedReceiptQuerySource,processedReceiptQuerySource,isProcessedReceiptQuerySource} from '../src/processed-receipt-query-source.mjs';
import {processedSource,disposeProcessedSource,reauthorizeProcessedSource} from '../src/processed-source.mjs';
import {renderProcessedHtml} from '../../fiscal-danfe/src/processed-render.mjs';
import {createProcessedRuntimeHandler} from '../src/processed-handler.mjs';
import {signRuntimeRequest,digest} from '../src/processed-auth.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),failure=code=>Object.assign(Error('PRIVATE'),{code});
let f;test.before(async()=>{f=await processedReceiptQueryFixtures();});test.after(()=>f?.close());
const conflict=x=>{x.state.record.resolution={...x.state.record.resolution,state:'conflict',selected_query_id:null,query_ids:[x.state.record.query_id,randomUUID()],resolution_hash:'f'.repeat(64)};};
test('089 selected resolution reads exact archived bytes for55/65,069/079 and100/150, without current-head or write ports',async()=>{
 for(const model of['55','65'])for(const kind of['authorization','revalidation'])for(const status of['100','150']){
  const z=await f.create(model,kind,status),c=z.x.state.record.recovery;z.x.state.policyOff=true;z.x.state.sessionCalls=0;z.x.state.transports=0;z.x.calls.length=0;
  const h=await z.read(),v=processedSource(h);assert.equal(isProcessedReceiptQuerySource(h),true);assert.equal(v.metadata.source_kind,'receipt_query');assert.equal(v.metadata.source_command_id,z.input.commandId);assert.equal(v.metadata.resolution_hash,z.x.state.record.resolution.resolution_hash);assert.equal(v.metadata.protocol.cstat,status);assert.equal(v.metadata.protocol.number.length,17);
  assert.deepEqual(Buffer.from(v.signedBytes),z.x.x.files.get(z.x.x.signedKey));assert.deepEqual(Buffer.from(v.processedBytes),z.x.files.get(`receipt-queries/${c.query_id}/processed/${v.metadata.processed_hash}.xml`));
  const print=renderProcessedHtml(h);assert.match(print.html,/HOMOLOGAÇÃO/);assert.ok(print.html.includes(v.metadata.protocol.number));assert.equal(z.calls.command,2);await reauthorizeProcessedSource(h);assert.equal(z.calls.command,3);assert.equal(z.calls.read.length,5);assert.deepEqual(z.x.calls,['command','command','command']);assert.equal(z.x.state.sessionCalls,0);assert.equal(z.x.state.transports,0);
  v.processedBytes.fill(0);assert.notEqual(processedReceiptQuerySource(h).processedBytes[0],0);disposeProcessedSource(h);assert.throws(()=>processedSource(h));v.signedBytes.fill(0);
 }
});
test('089 forged/cloned handles and unsupported config do not execute getters or untrusted ports',async()=>{
 let touched=0;const raw={get profile(){touched++;throw Error('PRIVATE');}};assert.throws(()=>processedReceiptQuerySource(raw));assert.throws(()=>processedSource(raw));assert.equal(touched,0);
 const z=await f.create(),h=await z.read();assert.throws(()=>processedReceiptQuerySource({...h}));disposeProcessedSource(h);assert.throws(()=>createProcessedReceiptQuerySource({...z.ports,transport(){throw Error('NO');}}));
});
test('089 selected query, resolution and initial ACL gate all artifact reads',async()=>{
 for(const mode of['actor','conflict','other-selected','pending']){const z=await f.create();
  if(mode==='conflict')conflict(z.x);else if(mode==='other-selected'){z.x.state.record.resolution.selected_query_id=randomUUID();z.x.state.record.resolution.query_ids.push(z.x.state.record.resolution.selected_query_id);}else if(mode==='pending')z.x.state.record.resolution={state:'pending',selected_query_id:null,query_ids:[],protocol:null,resolution_hash:'f'.repeat(64)};
  const input=mode==='actor'?{...z.input,actor:randomUUID()}:z.input;await assert.rejects(createProcessedReceiptQuerySource(z.ports)(input));assert.equal(z.calls.source,0);assert.equal(z.calls.read.length,0);
 }
});
test('089 resolution change or revocation during bytes and after render prevents delivery',async()=>{
 for(const stage of[2,3])for(const reason of['conflict','revoked','hash']){const z=await f.create(),original=z.ports.rpc;let n=0;const reader=createProcessedReceiptQuerySource({...z.ports,rpc:async(...args)=>{if(++n===stage){if(reason==='revoked')throw failure('42501');else if(reason==='conflict')conflict(z.x);else z.x.state.record.resolution.resolution_hash='f'.repeat(64);}return original(...args);}});
  if(stage===2)await assert.rejects(reader(z.input));else{const h=await reader(z.input);renderProcessedHtml(h);await assert.rejects(reauthorizeProcessedSource(h));disposeProcessedSource(h);}
 }
});
test('089 stored request/response/sidecar/processed/candidate bytes and hashes are inseparable',async()=>{
 const baseline=await f.create(),h=await baseline.read();disposeProcessedSource(h);assert.equal(baseline.calls.read.length,5);
 for(let pos=0;pos<5;pos++)for(const missing of[false,true]){const z=await f.create(),keys=[`receipt-queries/${z.input.commandId}/requests/${z.x.state.record.recovery.request_hash}.xml`,`receipt-queries/${z.input.commandId}/responses/${z.x.state.record.recovery.request_hash}.xml`,`receipt-queries/${z.input.commandId}/observations/${z.x.state.record.recovery.request_hash}.json`,`receipt-queries/${z.input.commandId}/processed/${z.x.state.record.artifact.processed_hash}.xml`,z.x.x.signedKey],key=keys[pos],map=pos===4?z.x.x.files:z.x.files;
  if(missing)map.delete(key);else map.set(key,Buffer.from('PRIVATE_CORRUPTION'));await assert.rejects(z.read(),e=>e.code==='DANFE_STORAGE_INVALID');
 }
});
test('089 cryptographically consistent sidecar metadata cannot change TLS, query nonce or HTTP provenance',async()=>{
 for(const mutate of[m=>m.tls_origin_verified=false,m=>m.nonce=randomUUID(),m=>m.http_status=500]){const z=await f.create(),c=z.x.state.record.recovery,a=z.x.state.record.artifact,key=`receipt-queries/${c.query_id}/observations/${c.request_hash}.json`,meta=JSON.parse(z.x.files.get(key));mutate(meta);const bytes=Buffer.from(JSON.stringify(meta));z.x.files.set(key,bytes);a.observation_hash=sha(bytes);a.observation_size=bytes.length;a.evidence.observation_hash=sha(bytes);a.evidence.observation_size=bytes.length;await assert.rejects(z.read(),e=>e.code==='DANFE_STORAGE_INVALID');}
});
test('089 caller mutation, abort and late byte completion cannot substitute a source or return a handle',async()=>{
 const z=await f.create();let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);const base=z.ports.rpc,reader=createProcessedReceiptQuerySource({...z.ports,rpc:async(...args)=>{entered();await gate;return base(...args);}}),input={...z.input},stop=new AbortController(),pending=reader(input,{signal:stop.signal});await seen;input.commandId=randomUUID();stop.abort();release();await assert.rejects(pending,e=>e.code==='DANFE_UPSTREAM_UNAVAILABLE');assert.equal(z.calls.read.length,0);
});
test('089 handler rechecks ACL/resolution after HTML render, and XML never depends on rendering',async()=>{
 const secret=new Uint8Array(32).fill(9),keyId='qa',audience='qa-danfe';
 for(const action of['xml','print'])for(const altered of[false,true]){const z=await f.create(),reader=createProcessedReceiptQuerySource(z.ports);let renders=0;
  const handler=createProcessedRuntimeHandler({readSource:reader,render:h=>{renders++;const out=renderProcessedHtml(h);if(altered)conflict(z.x);return out;},transportSecret:secret,transportKeyId:keyId,audience});
  if(action==='xml'&&altered){const base=z.ports.rpc;let n=0;z.ports.rpc=async(...args)=>{if(++n===3)conflict(z.x);return base(...args);};handler.dispose();}
  const selected=action==='xml'&&altered?createProcessedRuntimeHandler({readSource:createProcessedReceiptQuerySource(z.ports),render:()=>{throw Error('NO_RENDER_FOR_XML');},transportSecret:secret,transportKeyId:keyId,audience}):handler;
  try{const path=`/internal/v1/fiscal-danfe/receipt-queries/${z.input.commandId}/${action}`,authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor:z.input.actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array())});const r=await selected(new Request('http://runtime.internal'+path,{headers:{authorization}})),out=await r.json();assert.equal(r.status,altered?409:200);if(altered){assert.equal(out.recovery_required,false);assert.equal(out.html,undefined);assert.equal(out.xml_base64,undefined);}else{assert.equal(out.source.resolution_hash,z.x.state.record.resolution.resolution_hash);assert.equal(out.source.source_kind,'receipt_query');}if(action==='xml')assert.equal(renders,0);}finally{selected.dispose();}
 }
});
