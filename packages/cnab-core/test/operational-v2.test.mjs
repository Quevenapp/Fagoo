import test from 'node:test';
import assert from 'node:assert/strict';
import {generateOperationalRemittanceV2 as generate,operationalEncodingTerms,generateOperationalRemittance} from '../src/index.mjs';
import {generateObservedItau109Remittance} from '../src/itau-observed.mjs';
import {PROFILES,title} from './fixtures.mjs';
export const observed='itau109-origin-observed-v1',legacy='itau109-no-charges-v1';
export function snapshot(encoding=observed,amount='12345'){
 const t=title({amountCents:amount});if(encoding===observed)t.encodingTerms={...operationalEncodingTerms({amountCents:amount,dueOn:t.dueOn,zeroDailyInterestConfirmed:BigInt(amount)<1500n})};
 return{profile:{...PROFILES.itau,simpleCollectionPolicyVerified:encoding===legacy},titles:[t],generatedOn:'2026-10-16',remittanceSequence:'1',purpose:'operational',preview_hash:'a'.repeat(64),
 operational_authorization:{approval_version:1,profile_config_hash:'b'.repeat(64),identity_version:1},encoding_profile:encoding,
 encoding_authorization:{approval_version:1,policy_hash:'c'.repeat(64),reference:'SYNTHETIC DECLARATION',confirmed_on:'2026-10-16',compatibility_confirmed:encoding===observed,permanent_instructions_acknowledged:encoding===observed}};
}
test('v2 observed bytes match independent historical encoder without forging simple policy',async()=>{
 const s=snapshot(),r=await generate(s),base=await generateObservedItau109Remittance({profile:{...s.profile,simpleCollectionPolicyVerified:true},historicalProfile:observed,
 confirmation:{confirmed:true,reference:s.encoding_authorization.reference},titles:s.titles.map(({encodingTerms,...t})=>({...t,zeroDailyInterestConfirmed:false})),generatedOn:s.generatedOn,remittanceSequence:s.remittanceSequence});
 assert.deepEqual(r.bytes,base.bytes);assert.equal(r.fileHash,base.fileHash);assert.equal(r.purpose,'operational');assert.equal(r.filename,'ITAU_COBRANCA_0000001.REM');assert.deepEqual(r.manifest[0].encodingTerms,s.titles[0].encodingTerms);
 assert.equal(s.profile.simpleCollectionPolicyVerified,false);for(const k of['canEmit','canTransmit','bankPolicyVerified','bankAcceptanceVerified','financialMutationPerformed','bankTransmissionPerformed','originAuthenticated'])assert.equal(r[k],false);
});
test('explicit legacy v2 reproduces original operational bytes and six-field manifest',async()=>{
 const s=snapshot(legacy),before=await generateOperationalRemittance(s),r=await generate(s);assert.deepEqual(r.bytes,before.bytes);assert.deepEqual(r.manifest,before.manifest);assert.deepEqual(r.warnings,before.warnings);
 await assert.rejects(()=>generate({...s,encoding_profile:undefined}));await assert.rejects(()=>generate({...s,profile:{...s.profile,simpleCollectionPolicyVerified:false}}));
});
test('captured calculated terms and zero confirmation cannot be changed or omitted',async()=>{
 for(const [k,v]of Object.entries({dailyInterestCents:'5',interestDateField:'2026-10-29',penaltyDateField:'2026-11-01',penaltyPercentHundredths:'201',version:2,profile:legacy,zeroDailyInterestConfirmed:true})){
  const s=snapshot();s.titles[0].encodingTerms[k]=v;await assert.rejects(()=>generate(s));
 }
 const s=snapshot(observed,'1499');s.titles[0].encodingTerms.zeroDailyInterestConfirmed=false;await assert.rejects(()=>generate(s),e=>e.code==='CNAB_ITAU_OBSERVED_TERMS_UNCONFIRMED');
 const r=await generate(snapshot(observed,'1499'));assert.ok(r.warnings.includes('ZERO_DAILY_FIELD_BANK_EFFECT_UNKNOWN'));assert.equal(r.manifest[0].encodingTerms.dailyInterestCents,'0');
 for(const k of['compatibility_confirmed','permanent_instructions_acknowledged']){const v=snapshot();v.encoding_authorization[k]=false;await assert.rejects(()=>generate(v));}
});
test('all caller state captured before digest; accessors and hidden fields rejected without invocation',async()=>{
 const v=snapshot(),expected=await generate(v),pending=generate(v);v.titles[0].amountCents='1';v.titles[0].encodingTerms.dailyInterestCents='0';v.profile.account='99999';v.encoding_authorization.reference='MUTATED';v.titles=[];assert.deepEqual(await pending,expected);
 let hits=0;const s=snapshot();Object.defineProperty(s.titles[0].encodingTerms,'dailyInterestCents',{enumerable:true,get(){hits++;return'4';}});await assert.rejects(()=>generate(s));assert.equal(hits,0);
 const h=snapshot();Object.defineProperty(h,'hidden',{value:true});await assert.rejects(()=>generate(h));
});
test('approval reference preserves SQL ASCII trimming and Unicode character limits without changing bytes',async()=>{
 const baseline=await generate(snapshot());
 for(const reference of['\u00a0SYNTHETIC REVIEW\u00a0','🔎'.repeat(200)]){
  const s=snapshot();s.encoding_authorization.reference=reference;const result=await generate(s);
  assert.deepEqual(result.bytes,baseline.bytes);assert.equal(s.encoding_authorization.reference,reference);
 }
 for(const reference of['\u00a0\u00a0\u00a0','ABC ',' ABC','🔎'.repeat(201),'AB\tC']){
  const s=snapshot();s.encoding_authorization.reference=reference;await assert.rejects(()=>generate(s));
 }
});
