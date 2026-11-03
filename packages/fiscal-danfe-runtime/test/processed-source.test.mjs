import test from 'node:test';
import assert from 'node:assert/strict';
import {processedFixtures} from './processed-fixtures.mjs';
import {createProcessedSource,processedSource,disposeProcessedSource,reauthorizeProcessedSource} from '../src/processed-source.mjs';
let f;test.before(async()=>{f=await processedFixtures();});test.after(()=>f?.close());
const failure=code=>Object.assign(new Error('PRIVATE_MESSAGE'),{code});
test('069/079,55/65,100/150 preserve exact bytes and historical protocol without any current credential port',async()=>{
 for(const kind of ['authorization','revalidation'])for(const model of ['55','65'])for(const status of ['100','150']){
  const x=f.create(model,kind,{status}),h=await createProcessedSource(x.ports)(x.input),v=processedSource(h);
  assert.equal(v.metadata.source_kind,kind);assert.equal(v.metadata.model,model);assert.equal(v.metadata.protocol.cstat,status);assert.equal(v.metadata.protocol.number.length,17);
  assert.deepEqual(Buffer.from(v.processedBytes),Buffer.from(x.processed.processedXml));assert.deepEqual(Buffer.from(v.signedBytes),x.files.get(x.signedKey));assert.equal(x.calls.command.length,2);assert.equal(x.calls.read.length,5);
  await reauthorizeProcessedSource(h);assert.equal(x.calls.command.length,3);v.processedBytes.fill(0);assert.notEqual(processedSource(h).processedBytes[0],0);disposeProcessedSource(h);assert.throws(()=>processedSource(h));
 }
});
test('fabricated handles/accessors/clones are rejected without reading getters',()=>{let touched=0;const fake={get profile(){touched++;throw Error('PRIVATE');}};assert.throws(()=>processedSource(fake));assert.equal(touched,0);});
test('no data or Storage read after initial ACL failure; revocation after bytes prevents delivery',async()=>{
 for(const stage of [1,2]){const x=f.create(),base=x.ports.authorizationRpc;let n=0;const read=createProcessedSource({...x.ports,authorizationRpc:async(...args)=>{if(++n===stage)throw failure('42501');return base(...args);}});
  await assert.rejects(read(x.input),e=>e.code==='DANFE_FORBIDDEN'&&!e.message.includes('PRIVATE'));assert.equal(x.calls.read.length,stage===1?0:5);
 }
});
test('missing/corrupt candidate,request,response,sidecar,processed never returns a handle',async()=>{
 for(let i=0;i<5;i++)for(const missing of [false,true]){const x=f.create(),keys=[...x.files.keys()].slice(0,5),key=keys[i];if(missing)x.files.delete(key);else x.files.set(key,Buffer.from('PRIVATE_CORRUPTION'));await assert.rejects(createProcessedSource(x.ports)(x.input),e=>e.code==='DANFE_STORAGE_INVALID');}
});
test('receipt/source mutation after Storage and forged operational flags are rejected',async()=>{
 const x=f.create(),base=x.ports.authorizationRpc;let n=0;const read=createProcessedSource({...x.ports,authorizationRpc:async(...args)=>{const v=await base(...args);if(++n===2)v.receipt.candidate_version++;return v;}});await assert.rejects(read(x.input));
 for(const edit of [r=>r.receipt.origin='synthetic',r=>r.artifact.evidence.processed_xsd_validated=false,r=>r.current.state='receipt_pending',r=>r.observation.sha256='0'.repeat(64)]){const y=f.create();edit(y.record);await assert.rejects(createProcessedSource(y.ports)(y.input));}
});
test('captured input survives caller mutation while final reauthorization still denies a revoked actor',async()=>{
 const x=f.create();let release;const gate=new Promise(r=>release=r),original=x.ports.authorizationRpc;let denied=false;
 const reader=createProcessedSource({...x.ports,authorizationRpc:async(...a)=>{await gate;if(denied)throw failure('42501');return original(...a);}}),input={...x.input},pending=reader(input);input.actor='f0000000-0000-4000-8000-000000000001';release();const h=await pending;denied=true;await assert.rejects(reauthorizeProcessedSource(h),e=>e.code==='DANFE_FORBIDDEN');disposeProcessedSource(h);
});
