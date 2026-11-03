import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publicResult,FLAGS,INSPECTION_CODES} from '../src/dto.mjs';
import {payload,result,unconfirmed,command} from './fixtures.mjs';
const run={action:'run',payload:payload(),commandId:command},read={action:'command',commandId:command};
test('known states preserve immutable receipt and current A1/company separately without private evidence',()=>{
 for(const state of ['prepared','dispatched','stored','failed','uncertain'])for(const readonly of [true,false]){
  const raw=result(state,payload(),readonly);raw.execution={credential:'PRIVATE'};raw.evidence={fingerprint:'PRIVATE'};raw.receipt.issuer_cnpj='PRIVATE';
  if(raw.artifact)raw.artifact.evidence={xml:'PRIVATE'};
  const value=publicResult(raw,readonly?read:run);assert.equal(value.status,state);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|execution|fingerprint|issuer_cnpj|lease_id/);
 }
 const raw=result('stored');raw.current.a1_version=2;raw.current.a1_changed=true;raw.current.identity_version=3;raw.current.company_changed=true;
 const value=publicResult(raw,run);assert.equal(value.receipt.a1_version,1);assert.equal(value.current.a1_version,2);assert.equal(value.artifact.sha256,'a'.repeat(64));
});
test('unconfirmed outcome never implies GET may safely repeat; current may be last known context',()=>{
 const unknown=publicResult(unconfirmed(),run);assert.equal(unknown.receipt,null);assert.equal(unknown.recovery_required,true);
 const prior=result('prepared');const raw={...prior,status:'unconfirmed',failure_code:'WSDL_SERVICE_TIMEOUT',recovery_required:true};
 const value=publicResult(raw,run);assert.equal(value.status,'unconfirmed');assert.equal(value.current.state,'prepared');assert.equal(value.current.retry_get_allowed,false);
 for(const patch of [{recovery_required:false},{recovered:true},{failure_code:null},{status:'stored'}])assert.throws(()=>publicResult({...unconfirmed(),...patch},run));
 assert.throws(()=>publicResult({...raw,read_only:true},read));
});
test('DTO rejects binding swaps, impossible timelines and false trust claims',()=>{
 const raw=result();for(const patch of [{command_id:randomUUID()},{can_emit:true},{binding_verified:true},{can_query:true},{read_only:true},{status:'prepared'},{failure_code:'SENSITIVE_DIAGNOSTIC'}])assert.throws(()=>publicResult({...raw,...patch},run));
 for(const patch of [{model:'65'},{operation:'status'},{a1_version:2},{identity_version:3},{confirmed:false},{created_at:'2026-02-30T12:00:00Z'}])assert.throws(()=>publicResult({...raw,receipt:{...raw.receipt,...patch}},run));
 for(const patch of [{grant_consumed:false},{recovery_required:true},{retry_get_allowed:true},{a1_changed:true},{used_at:'2026-10-16T12:02:00Z'},{finished_at:'2026-10-16T11:00:00Z'},{expires_at:'2026-09-31T12:00:00Z'}])assert.throws(()=>publicResult({...raw,current:{...raw.current,...patch}},run));
 for(const patch of [{size_bytes:512001},{inspection_status:'verified'},{inspection_code:'unknown'},{created_at:'2026-10-16T12:00:00+14:01'}])assert.throws(()=>publicResult({...raw,artifact:{...raw.artifact,...patch}},run));
});
test('safe unsupported WSDL remains an artifact with structural limitations and no binding authorization',()=>{
 for(const code of INSPECTION_CODES){const raw=result();raw.artifact.inspection_status='unsupported';raw.artifact.inspection_code=code;const value=publicResult(raw,run);assert.equal(value.artifact.inspection_code,code);assert.equal(value.operation_authorized,false);}
 const raw=result('prepared');raw.current.lease_expired=true;raw.error_code='WSDL_GRANT_EXPIRED';assert.equal(publicResult(raw,run).error_code,'WSDL_GRANT_EXPIRED');
 const dispatched=result('dispatched');dispatched.current.lease_expired=true;dispatched.error_code='WSDL_RESULT_UNCONFIRMED';assert.equal(publicResult(dispatched,run).recovery_required,true);
});
test('public fields cannot be replaced with accessors during projection',()=>{
 let getters=0;const raw=result();Object.defineProperty(raw,'artifact',{get(){getters++;return null;}});assert.throws(()=>publicResult(raw,run));assert.equal(getters,0);
 assert.equal(Object.values(FLAGS).includes(true),false);
});
