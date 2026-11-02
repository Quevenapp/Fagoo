import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareItau109Terms} from '../itau-terms.mjs';
import {generateRemittance} from '../index.mjs';
import {PROFILES,title} from './fixtures.mjs';
const resolution=()=>({monthDays:30,rounding:'half-up',dailyInterestCents:'4',interestStartsOn:'2026-10-31',penaltyStartsOn:'2026-10-31',penaltyDateRule:'due-plus-tolerance',confirmed:true,reference:'SYNTHETIC CONVENTION TEST ONLY'});
const terms=value=>({profile:'itau109-explicit-charges-v1',monthlyInterestPercent:'1.00',penaltyPercent:'2.00',penaltyToleranceDays:1,punctualityDiscountPercent:'0.00',species:'DM',acceptance:'N',sourceInstructions:'absent',automaticProtest:false,resolution:value});
const input=value=>({amountCents:'12345',dueOn:'2026-10-30',terms:terms(value)});
test('interest rounding and penalty dates require an explicit consistent convention',()=>{
  assert.equal(prepareItau109Terms(input(null)).encodingReady,false);
  const prepared=prepareItau109Terms(input(resolution()));assert.equal(prepared.encoding.dailyInterestCents,'4');assert.equal(prepared.bankAcceptanceVerified,false);assert.equal(prepared.financialMutationPerformed,false);
  assert.throws(()=>prepareItau109Terms(input({...resolution(),dailyInterestCents:'5'})),/CNAB_ITAU_DAILY_INTEREST_MISMATCH/);
  assert.throws(()=>prepareItau109Terms(input({...resolution(),penaltyStartsOn:'2026-11-01'})),/CNAB_ITAU_PENALTY_DATE_MISMATCH/);
  assert.throws(()=>prepareItau109Terms(input({...resolution(),rounding:'exact'})),/CNAB_ITAU_INTEREST_FRACTION_UNRESOLVED/);
});
test('homologation encodes reviewed charges and a correctly sequenced penalty record',async()=>{
  const result=await generateRemittance({profile:PROFILES.itau,titles:[title({collectionTerms:terms(resolution())})],generatedOn:'2026-10-15',remittanceSequence:'1',purpose:'homologation'});
  const rows=Buffer.from(result.bytes).toString('ascii').trimEnd().split('\r\n');assert.equal(rows.length,4);
  assert.equal(rows[1].slice(156,160),'1044');assert.equal(rows[1].slice(160,173),'0000000000004');
  assert.equal(rows[2].slice(0,10),'2231102026');assert.equal(rows[2].slice(10,23),'0000000000200');assert.equal(rows[2].slice(394),'000003');assert.equal(rows[3].slice(394),'000004');
  assert.ok(result.warnings.includes('BANK_CHARGES_POLICY_NOT_VERIFIED'));
});
