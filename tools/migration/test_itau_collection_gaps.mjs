import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReturn} from '../../packages/cnab-core/src/return.mjs';
import {planItau109NetCredit} from '../../packages/cnab-core/src/itau-net-credit.mjs';
import {operationalEncodingTerms} from '../../packages/cnab-core/src/operational-v2.mjs';
import {PROFILES,returnFile,replaceField} from '../../packages/cnab-core/test/fixtures.mjs';

// Diagnosis only: synthetic bytes, no database, Storage, source files or bank access.
const category={id:'11111111-1111-4111-8111-111111111111',version:1,name:'Tarifa sintética',kind:'payable',active:true};
async function event({combined='0',sequence='00001'}={}){
 const bytes=replaceField(returnFile({fileSequence:sequence,events:[{amount:'300000',paid:(300000n+BigInt(combined)-250n).toString(),fee:'250'}]}),2,267,combined.padStart(13,'0'));
 return (await parseReturn(bytes,{profile:PROFILES.itau})).events[0];
}
const plan=e=>planItau109NetCredit({bank:e.bank,wallet:e.wallet,nominal_cents:e.amountCents,credited_cents:e.paidCents,adjustments:e.adjustments,fee_category:category,expected_fee_category_version:1});

test('067 encoded terms cannot classify the combined mora/multa of a 043 return',async()=>{
 const encoded=operationalEncodingTerms({amountCents:'300000',dueOn:'2026-10-30',zeroDailyInterestConfirmed:false});
 assert.equal(encoded.dailyInterestCents,'100');assert.equal(encoded.penaltyPercentHundredths,'200');
 const parsed=await event({combined:'6100'});
 assert.equal(parsed.paidCents,'305850');assert.equal(parsed.adjustments.interest,'6100');
 assert.equal(BigInt(parsed.paidCents)+BigInt(parsed.adjustments.fee),BigInt(parsed.amountCents)+BigInt(parsed.adjustments.interest));
 // The same observed aggregate has several exact decompositions; the parser provides none.
 assert.equal(100n+6000n,6100n);assert.equal(6100n+0n,6100n);
 assert.equal(Object.hasOwn(parsed.adjustments,'penalty'),false);
 const result=plan(parsed);assert.equal(result.posting,null);assert.ok(result.issues.includes('MORA_PENALTY_UNSUPPORTED'));
});

test('058 accepts the zero-aggregate equation, but does not establish title linkage or bank origin',async()=>{
 const parsed=await event(),result=plan(parsed);
 assert.deepEqual(result.issues,[]);assert.equal(result.posting.principal_cents,'300000');assert.equal(result.posting.net_cash_cents,'299750');
 assert.deepEqual(result.posting.legs,[{kind:'payment',delta_cents:'300000'},{kind:'bank_fee',delta_cents:'-250'}]);
 assert.equal(Object.hasOwn(result,'title_id'),false);assert.equal(Object.hasOwn(result,'originAuthenticated'),false);
 const withoutCategory=planItau109NetCredit({bank:parsed.bank,wallet:parsed.wallet,nominal_cents:parsed.amountCents,credited_cents:parsed.paidCents,adjustments:parsed.adjustments,fee_category:null,expected_fee_category_version:1});
 assert.equal(withoutCategory.posting,null);assert.ok(withoutCategory.issues.includes('FEE_CATEGORY_NOT_READY'));
});

test('another return file sequence does not create another bank event identity',async()=>{
 const first=await event({sequence:'00001'}),again=await event({sequence:'00002'});
 assert.equal(first.eventHash,again.eventHash);assert.equal(first.lineHash,again.lineHash);
 const changed=await event({combined:'1'});assert.notEqual(first.eventHash,changed.eventHash);
});
