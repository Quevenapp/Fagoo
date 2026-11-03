import test from 'node:test';
import assert from 'node:assert/strict';
import {generateRemittance,generateOperationalRemittance} from '../src/index.mjs';
import {PROFILES,title} from './fixtures.mjs';

test('operational encoder preserves bank positions and cannot turn the homologation entry into an operational endpoint',async()=>{
 const source={profile:PROFILES.itau,titles:[title()],generatedOn:'2026-10-16',remittanceSequence:'1'};
 const h=await generateRemittance({...source,purpose:'homologation'}),o=await generateOperationalRemittance({...source,purpose:'operational'});
 assert.deepEqual(o.bytes,h.bytes);assert.equal(o.fileHash,h.fileHash);assert.equal(o.filename,'ITAU_COBRANCA_0000001.REM');assert.equal(h.filename,'ITAU_TESTE_0000001.REM');
 assert.equal(o.productionReady,false);assert.equal(o.originAuthenticated,false);assert.equal(o.bankTransmissionPerformed,false);assert.equal(o.financialMutationPerformed,false);
 await assert.rejects(()=>generateRemittance({...source,purpose:'operational'}),e=>e.code==='CNAB_PRODUCTION_GENERATION_UNAVAILABLE');
 await assert.rejects(()=>generateOperationalRemittance({...source,purpose:'homologation'}),e=>e.code==='CNAB_OPERATIONAL_PURPOSE_REQUIRED');
});
test('operational entry preserves exact money validation and does not permit unsupported instructions',async()=>{
 const source={profile:PROFILES.itau,generatedOn:'2026-10-16',remittanceSequence:'1',purpose:'operational'};
 for(const override of[{amountCents:12345},{amountCents:'123.45'},{interestCents:'100'}])await assert.rejects(()=>generateOperationalRemittance({...source,titles:[title(override)]}));
});
