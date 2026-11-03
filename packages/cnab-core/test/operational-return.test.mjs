import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReturn,verifyOperationalReturnEvent} from '../src/index.mjs';
import {PROFILES,returnFile,replaceField} from './fixtures.mjs';

async function proof(bank='itau') {
 const profile=PROFILES[bank],bytes=returnFile({bank:profile.bank}),parsed=await parseReturn(bytes,{profile});
 const {eventHash,lineHash,line,...payload}=parsed.events[0];
 return {bytes,profile,fileHash:parsed.fileHash,eventHash,lineHash,line,payload,fileWarnings:parsed.warnings,generatedOn:parsed.generatedOn};
}
test('operational proof reparses both banks and never attests bank origin or authorizes a payment',async()=>{
 for(const bank of ['itau','inter']){
  const result=await verifyOperationalReturnEvent(await proof(bank));
  assert.equal(result.bytesVerified,true);assert.equal(result.originAuthenticated,false);assert.equal(result.financialMutationPerformed,false);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.event));
  assert.throws(()=>{result.event.paidCents='0';},TypeError);
 }
});
test('operational proof rejects altered payload, file, line, date, warnings and private bytes',async()=>{
 const p=await proof();
 for(const change of [{fileHash:'0'.repeat(64)},{eventHash:'0'.repeat(64)},{lineHash:'0'.repeat(64)},{line:3},{generatedOn:'2026-10-15'},
  {fileWarnings:[]},{payload:{...p.payload,paidCents:'1'}},{payload:{...p.payload,extra:true}},
  {bytes:replaceField(p.bytes,2,325,'OUTRO NOME FICTICIO')}, {profile:{...p.profile,account:'54321'}}]){
  await assert.rejects(()=>verifyOperationalReturnEvent({...p,...change}),e=>typeof e.code==='string'&&e.code.startsWith('CNAB_'));
 }
});
test('operational proof cannot substitute a validated-looking object for bounded original bytes',async()=>{
 const p=await proof();
 for(const change of [{bytes:{validated:true,...p}},{bytes:new Uint8Array(4020001)},{century:1900},{line:2.5},{payload:null},{fileWarnings:null}])
  await assert.rejects(()=>verifyOperationalReturnEvent({...p,...change}),e=>e.code==='CNAB_OPERATIONAL_PROOF_INVALID');
});
