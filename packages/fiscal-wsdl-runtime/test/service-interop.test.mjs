import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../fiscal-sefaz-wsdl/test/service-fixture.mjs';
import {FLAGS as SERVICE_FLAGS} from '../../fiscal-sefaz-wsdl/src/service-dto.mjs';
import {WSDL_UNSUPPORTED_CODES} from '../../fiscal-sefaz-wsdl/src/inspect-wsdl.mjs';
import {FLAGS,INSPECTION_CODES,publicResult} from '../src/dto.mjs';
const request=input=>({command_id:input.commandId,model:input.model,operation:input.operation,expected_a1_version:input.expectedA1Version,expected_identity_version:input.expectedIdentityVersion,confirmed:true});
test('service SQL051 → orchestration → public DTO preserves both models and read-only recovery without external I/O',async()=>{
 assert.deepEqual(FLAGS,SERVICE_FLAGS);assert.deepEqual(INSPECTION_CODES,WSDL_UNSUPPORTED_CODES);
 for(const model of ['55','65']){
  const f=await serviceFixture({model});try{
   const service=f.service(),p=request(f.input),run=publicResult(await service.run(f.input),{action:'run',payload:p,commandId:p.command_id});
   assert.equal(run.status,'stored');assert.equal(run.receipt.model,model);assert.equal(run.read_only,false);assert.equal(run.failure_code,null);
   const calls=f.wire.calls,read=publicResult(await service.command({actor:f.actor,commandId:p.command_id}),{action:'command',commandId:p.command_id});
   assert.equal(read.read_only,true);assert.deepEqual(read.artifact,run.artifact);
   const replay=publicResult(await service.run(f.input),{action:'run',payload:p});assert.equal(replay.recovered,true);assert.deepEqual(replay.receipt,run.receipt);
   assert.equal(f.wire.calls,calls);assert.doesNotMatch(JSON.stringify(read),/issuer_cnpj|fingerprint|envelope_hash|credential_id|lease_id|storage|evidence.*tls/);
  }finally{await f.close();}
 }
});
test('a lost use acknowledgement remains recoverable and does not issue a GET during lookup or rerun',async()=>{
 const f=await serviceFixture();try{
  const rpc=async(name,args,options)=>{const value=await f.ports.rpc(name,args,options);if(name==='erp_fiscal_wsdl_use')throw Error('PRIVATE_USE_ACK');return value;};
  const service=f.service({rpc}),p=request(f.input),value=publicResult(await service.run(f.input),{action:'run',payload:p});
  assert.equal(value.recovery_required,true);assert.equal(value.status,'dispatched');assert.equal(value.current.grant_consumed,true);assert.equal(value.current.retry_get_allowed,false);
  assert.equal(f.wire.calls,0);const lookup=publicResult(await service.command({actor:f.actor,commandId:p.command_id}),{action:'command',commandId:p.command_id});assert.equal(lookup.current.state,'dispatched');
  publicResult(await service.run(f.input),{action:'run',payload:p});assert.equal(f.wire.calls,0);
 }finally{await f.close();}
});
