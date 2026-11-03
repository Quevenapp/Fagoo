import test from'node:test';import assert from'node:assert/strict';import{build}from'esbuild';
import{encodeConfigure}from'../../../packages/fiscal-runtime/src/protocol.mjs';
const id='a0000000-0000-4000-8000-000000000001';
async function fixture(dev=true){const result=await build({entryPoints:['apps/erp/src/qa/a1-controller.ts'],bundle:true,write:false,format:'esm',define:{'import.meta.env.DEV':String(dev)},logLevel:'silent'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
test('A1 QA adapter fails closed outside development and loopback',async()=>{
 const previous=globalThis.location;
 const module=await fixture(),production=await fixture(false);try{globalThis.location={hostname:'saas.example.test'};assert.throws(()=>module.createA1QaController(),/A1_QA_LOCAL_ONLY/);globalThis.location={hostname:'127.0.0.1'};assert.throws(()=>production.createA1QaController(),/A1_QA_LOCAL_ONLY/);}finally{globalThis.location=previous;}
});
test('A1 QA only accepts synthetic marker, models lost commit/readback and keeps replay historical',async()=>{
 const previous=globalThis.location;globalThis.location={hostname:'127.0.0.1'};
 try{const module=await fixture(),controller=module.createA1QaController(),encode=(file=module.A1_QA_FILE)=>encodeConfigure({command_id:id,expected_version:0,expected_identity_version:1,reason:'QA-RETRY QA-READBACK',pfxBytes:new TextEncoder().encode(file),passwordBytes:new TextEncoder().encode(module.A1_QA_PASSWORD)});
  await assert.rejects(()=>controller.a1('/v1/a1/configure',{method:'POST',body:encode('NOT-A-SYNTHETIC-MARKER')}),e=>e.status===422);assert.equal((await controller.a1('/v1/a1')).current.version,0);
  const body=encode();await assert.rejects(()=>controller.a1('/v1/a1/configure',{method:'POST',body}),e=>e.status===503);const read=await controller.a1('/v1/a1/commands/'+id);assert.equal(read.receipt.version,1);
  await assert.rejects(()=>controller.a1('/v1/a1'),e=>e.status===503);assert.equal((await controller.a1('/v1/a1')).current.version,1);
  await controller.a1('/v1/a1/disable',{method:'POST',body:{command_id:'a0000000-0000-4000-8000-000000000002',expected_version:1,reason:'Desativação sintética'}});
  const replay=await controller.a1('/v1/a1/configure',{method:'POST',body});assert.equal(replay.replayed,true);assert.equal(replay.receipt.version,1);assert.equal(replay.current.state,'disabled');body.fill(0);
 }finally{globalThis.location=previous;}
});
