import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ITAU_109_OBSERVED_PROFILE as PROFILE,prepareItau109ObservedTerms as prepare,generateObservedItau109Remittance as generate} from '../src/itau-observed.mjs';
import {generateRemittance} from '../src/index.mjs';
import {PROFILES,title} from './fixtures.mjs';

const declaration=()=>({confirmed:true,reference:'SYNTHETIC HISTORICAL PROFILE REVIEW'});
const terms=(amountCents='12345',overrides={})=>({profile:PROFILE,amountCents,dueOn:'2026-10-30',confirmation:declaration(),zeroDailyInterestConfirmed:false,...overrides});
const input=(overrides={})=>({profile:{...PROFILES.itau},historicalProfile:PROFILE,confirmation:declaration(),
  titles:[{...title(),zeroDailyInterestConfirmed:false}],generatedOn:'2026-10-16',remittanceSequence:'1',...overrides});
const rows=bytes=>new TextDecoder().decode(bytes).trimEnd().split('\r\n');
const at=(row,a,b)=>row.slice(a-1,b);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('historical profile and zero field require separate explicit decisions',async()=>{
  const pending=prepare(terms('1499',{confirmation:null}));
  assert.equal(pending.encodingReady,false);assert.equal(pending.encoding,null);
  assert.deepEqual(pending.pending,['HISTORICAL_PROFILE_UNCONFIRMED','ZERO_DAILY_FIELD_UNCONFIRMED']);
  const zero=prepare(terms('1499'));
  assert.deepEqual(zero.pending,['ZERO_DAILY_FIELD_UNCONFIRMED']);
  const ready=prepare(terms('1499',{zeroDailyInterestConfirmed:true}));
  assert.equal(ready.encodingReady,true);assert.equal(ready.encoding.dailyInterestCents,'0');
  assert.ok(ready.warnings.includes('ZERO_DAILY_FIELD_BANK_EFFECT_UNKNOWN'));
  for(const key of ['canEmit','canTransmit','bankPolicyVerified','bankAcceptanceVerified','bankTransmissionPerformed','financialMutationPerformed','originAuthenticated'])assert.equal(ready[key],false);
  assert.equal('automaticProtest' in ready,false);assert.equal('penaltyToleranceDays' in ready,false);
  await assert.rejects(generate(input({confirmation:null})),e=>e.code==='CNAB_ITAU_OBSERVED_TERMS_UNCONFIRMED');
  const small={...title({amountCents:'1499'}),zeroDailyInterestConfirmed:false};
  await assert.rejects(generate(input({titles:[small]})),e=>e.code==='CNAB_ITAU_OBSERVED_TERMS_UNCONFIRMED');
  const encoded=await generate(input({titles:[{...small,zeroDailyInterestConfirmed:true}]}));
  assert.equal(at(rows(encoded.bytes)[1],157,173),'0000'+'0'.repeat(13));
});

test('independent half-cent vectors, maximum money and real calendar boundaries',()=>{
  // Fixed decimal arithmetic vectors, not derived from the implementation.
  for(const [amount,daily]of [['1','0'],['1499','0'],['1500','1'],['2999','1'],['3000','1'],['4500','2'],['7500','3'],['12345','4'],['9999999999999','3333333333']]){
    const r=prepare(terms(amount,{zeroDailyInterestConfirmed:daily==='0'}));
    assert.equal(r.encoding.dailyInterestCents,daily);
  }
  for(const [due,next]of [['2026-12-31','2027-01-01'],['2028-02-28','2028-02-29'],['2028-02-29','2028-03-01'],['2026-02-28','2026-03-01']]){
    const r=prepare(terms('12345',{dueOn:due}));assert.equal(r.encoding.interestDateField,due);assert.equal(r.encoding.penaltyDateField,next);
  }
  assert.throws(()=>prepare(terms('12345',{dueOn:'2026-02-29'})),e=>e.code==='CNAB_DATE_INVALID');
  assert.throws(()=>prepare(terms('12345',{dueOn:'2099-12-31'})),e=>e.code==='CNAB_DATE_INVALID');
  assert.throws(()=>prepare(terms('10000000000000')),e=>e.code==='CNAB_AMOUNT_INVALID');
  assert.throws(()=>prepare(terms('0')),e=>e.code==='CNAB_AMOUNT_BELOW_MINIMUM');
  assert.throws(()=>prepare(terms('1.50')),e=>e.code==='CNAB_AMOUNT_INVALID');
  assert.throws(()=>prepare(terms('1500',{zeroDailyInterestConfirmed:true})),e=>e.code==='CNAB_ITAU_ZERO_CONFIRMATION_NOT_APPLICABLE');
});

test('two independent record layouts encode only observed charge fields and physical sequence',async()=>{
  const v=input();const result=await generate(v),lines=rows(result.bytes);
  assert.equal(lines.length,4);assert.ok(lines.every(l=>l.length===400));
  assert.equal(result.bytes.length,4*402);assert.equal(result.fileHash,hash(result.bytes));
  assert.equal(result.totalCents,'12345');assert.equal(result.manifest.length,1);
  const detail=lines[1],penalty=lines[2];
  assert.equal(at(detail,148,160),'01N1510260000');
  assert.equal(at(detail,161,173),'0000000000004');
  assert.equal(at(detail,174,218),'0'.repeat(45));
  assert.equal(at(detail,71,83),'0'.repeat(13));
  assert.equal(at(detail,386,393),'30102600');
  assert.equal(at(penalty,1,23),'22311020260000000000200');
  assert.equal(at(penalty,24,394),' '.repeat(371));
  assert.deepEqual(lines.map(l=>at(l,395,400)),['000001','000002','000003','000004']);
  assert.equal(result.purpose,'offline-compatibility');assert.equal(result.canEmit,false);assert.equal(result.canTransmit,false);
  assert.equal(result.bankPolicyVerified,false);assert.equal(result.bankAcceptanceVerified,false);
  assert.equal(result.manifest[0].historicalTerms.profile,PROFILE);
  assert.ok(Object.isFrozen(result.manifest[0].historicalTerms.encoding));
});

test('30 titles have 62 records and preserve nominal totals; 31, duplicate ids and non-Itaú profiles fail',async()=>{
  const titles=Array.from({length:30},(_,i)=>({...title({id:`SYNTHETIC-${i}`,control:`TEST-${i}`,documentNumber:`T${i}`,ourNumber:String(i+1).padStart(8,'0'),amountCents:'4500'}),zeroDailyInterestConfirmed:false}));
  const output=await generate(input({titles})),lines=rows(output.bytes);
  assert.equal(lines.length,62);assert.equal(output.totalCents,'135000');assert.equal(output.manifest.length,30);
  assert.ok(lines.every((l,i)=>at(l,395,400)===String(i+1).padStart(6,'0')));
  assert.ok(titles.every((_,i)=>lines[1+2*i][0]==='1'&&lines[2+2*i][0]==='2'));
  await assert.rejects(generate(input({titles:[...titles,titles[0]]})),e=>e.code==='CNAB_HOMOLOGATION_TITLE_LIMIT');
  await assert.rejects(generate(input({titles:[titles[0],titles[0]]})),e=>e.code==='CNAB_DUPLICATE_TITLE_REFERENCE');
  await assert.rejects(generate(input({profile:{...PROFILES.inter}})),e=>e.code==='CNAB_ITAU_OBSERVED_PROFILE_UNSUPPORTED');
  await assert.rejects(generate(input({historicalProfile:'itau109-explicit-charges-v1'})),e=>e.code==='CNAB_ITAU_OBSERVED_PROFILE_UNSUPPORTED');
});

test('legacy generation is unchanged and historical decision cannot enter an old entry point',async()=>{
  const old={profile:{...PROFILES.itau},titles:[title()],generatedOn:'2026-10-16',remittanceSequence:'1',purpose:'homologation'};
  const before=await generateRemittance(old);
  await generate(input());
  const after=await generateRemittance(old);
  assert.deepEqual(after,before);assert.equal(rows(before.bytes).length,3);
  assert.equal(at(rows(before.bytes)[1],157,160),'1047');
  await assert.rejects(generateRemittance({...old,titles:[{...title(),collectionTerms:terms()}]}),e=>e.code==='CNAB_ITAU_TERMS_INVALID');
});

test('snapshot before awaits preserves body, decisions, bytes and manifest during caller mutation',async()=>{
  const expected=await generate(input());const v=input(),pending=generate(v);
  v.profile.account='99999';v.profile.accountId='REPLACED';v.confirmation.reference='REPLACED';
  v.titles[0].id='REPLACED';v.titles[0].amountCents='1';v.titles[0].dueOn='2026-12-31';
  v.titles[0].payer.name='REPLACED';v.titles[0].zeroDailyInterestConfirmed=true;v.titles.length=0;
  v.remittanceSequence='999';v.generatedOn='2026-12-31';
  assert.deepEqual(await pending,expected);
  const unchanged=input(),before=structuredClone(unchanged);await generate(unchanged);assert.deepEqual(unchanged,before);
});

test('unknown properties, accessors and prototypes cannot select hidden instructions or invoke callbacks',async()=>{
  let getters=0;const v=input();Object.defineProperty(v.titles[0],'amountCents',{enumerable:true,get(){getters++;return '12345';}});
  await assert.rejects(generate(v),e=>e.code==='CNAB_ITAU_OBSERVED_INPUT_INVALID');
  const array=input();Object.defineProperty(array.titles,'0',{enumerable:true,get(){getters++;return title();}});
  await assert.rejects(generate(array),e=>e.code==='CNAB_ITAU_OBSERVED_INPUT_INVALID');
  const inherited=input({profile:Object.create(PROFILES.itau)});
  await assert.rejects(generate(inherited),e=>e.code==='CNAB_ITAU_OBSERVED_INPUT_INVALID');
  await assert.rejects(generate({...input(),purpose:'operational'}),e=>e.code==='CNAB_ITAU_OBSERVED_INPUT_INVALID');
  assert.throws(()=>prepare({...terms(),instructions:['10','44']}),e=>e.code==='CNAB_ITAU_OBSERVED_INPUT_INVALID');
  assert.throws(()=>prepare(terms('12345',{confirmation:{confirmed:false,reference:'SYNTHETIC'}})),e=>e.code==='CNAB_ITAU_OBSERVED_CONFIRMATION_INVALID');
  assert.equal(getters,0);
});
