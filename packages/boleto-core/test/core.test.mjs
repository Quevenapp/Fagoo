import test from 'node:test';
import assert from 'node:assert/strict';
import { BoletoError, BOLETO_FLAGS, calculateDueFactor, calculateBarcodeDigit, barcodeToDigitableLine, createBoletoDigits } from '../src/index.mjs';
import { generateRemittance, interOurNumberDigit } from '../../cnab-core/src/index.mjs';
import { title as cnabTitle } from '../../cnab-core/test/fixtures.mjs';

// Public manual examples and fabricated data only. No backup, bank account,
// network, file generation or registration is used by this test suite.
const profile = () => ({ bank:'341',wallet:'109',layout:'itau-cnab400-2017-01',agency:'1234',account:'12345',accountDigit:'1',cnpj:'12345678000195',accountId:'synthetic-account',companyName:'EMPRESA FICTICIA',contractVerified:true,agreementReference:'SYNTHETIC CONTRACT ONLY',simpleCollectionPolicyVerified:true });
const input = () => ({purpose:'offline-validation',profile:profile(),allocation:{ourNumber:'00000001',confirmed:true,reference:'SYNTHETIC ALLOCATION ONLY'},title:{amountCents:'12345',dueOn:'2025-02-22',referenceOn:'2025-02-22'}});
const errorCode = (work, code) => assert.throws(work, error => error instanceof BoletoError && error.code === code && error.message === code);
const inter = () => {
  const value=input();Object.assign(value.profile,{bank:'077',wallet:'110',layout:'inter-cnab400-v2.2-2024-08-26',agency:'0001',account:'000123456',reservedRange:{start:'0004309500',end:'0004309599',verified:true}});value.allocation.ourNumber='0004309540';return value;
};

test('published Itaú Annex2 and Annex3 vectors independently fix the general and line digits',()=>{
  // Exact expected output printed on pp55–56. This wallet110 example validates
  // common arithmetic; it does NOT enable generation for Itaú110.
  const barcode='34196166700000123451101234567880057123457000';
  assert.equal(calculateBarcodeDigit('3419166700000123451101234567880057123457000'),'6');
  assert.deepEqual(barcodeToDigitableLine(barcode),{
    digits:'34191101213456788005871234570001616670000012345',
    formatted:'34191.10121 34567.880058 71234.570001 6 16670000012345',
  });
});

test('published Itaú109 our-number example and free-field positions are preserved',()=>{
  // Itaú note23 p35: agency0057/account72192/wallet109/98712345 -> digit8.
  // The account DV below is synthetic; the manual example does not supply it.
  const value=input();Object.assign(value.profile,{agency:'0057',account:'72192',accountDigit:'0'});value.allocation.ourNumber='98712345';
  const output=createBoletoDigits(value);
  assert.equal(output.ourNumberWithDigit,'987123458');assert.equal(output.freeField,'1099871234580057721920000');
  assert.equal(output.barcode.length,44);assert.equal(output.barcode.slice(19,22),'109');assert.equal(output.barcode.slice(22,30),'98712345');assert.equal(output.barcode[30],'8');
  assert.equal(output.barcode.slice(31,35),'0057');assert.equal(output.barcode.slice(35,40),'72192');assert.equal(output.barcode[40],'0');assert.equal(output.barcode.slice(41),'000');
});

test('the account check digit must match the documented Itaú agency/account modulo10 and is never rewritten',()=>{
  // Official Annex2/4 agency-account example:0057/12345-7.
  const value=input();Object.assign(value.profile,{agency:'0057',account:'12345',accountDigit:'7'});
  assert.equal(createBoletoDigits(value).barcode[40],'7');
  value.profile.accountDigit='8';const before=structuredClone(value);
  errorCode(()=>createBoletoDigits(value),'BOLETO_ACCOUNT_DIGIT_MISMATCH');assert.deepEqual(value,before);
});

test('published factor table covers the2025 reset and the next continuous cycle',()=>{
  const cases=[['2000-07-03','1000'],['2000-07-05','1002'],['2002-05-01','1667'],['2010-11-17','4789'],['2025-02-20','9998'],['2025-02-21','9999'],['2025-02-22','1000'],['2025-02-23','1001'],['2025-02-24','1002'],['2026-12-21','1667'],['2035-07-09','4789'],['2049-10-13','9999'],['2049-10-14','1000']];
  //2000–2025: Itaú Annex6 / Inter7.1.2.2026/2035/2049: Caixa published table.
  for(const[dueOn,expected]of cases)assert.equal(calculateDueFactor({dueOn,referenceOn:dueOn}),expected,dueOn);
});

test('explicit reference day bounds the ambiguous factor cycle without reading the clock',()=>{
  for(const dueOn of ['2018-07-30','2041-11-06'])assert.match(calculateDueFactor({dueOn,referenceOn:'2026-10-16'}),/^[1-9][0-9]{3}$/);
  for(const dueOn of ['2018-07-29','2041-11-07'])errorCode(()=>calculateDueFactor({dueOn,referenceOn:'2026-10-16'}),'BOLETO_DUE_DATE_OUTSIDE_WINDOW');
  errorCode(()=>calculateDueFactor({dueOn:'2026-10-16'}),'BOLETO_INPUT_INVALID');
  errorCode(()=>calculateDueFactor({dueOn:'2000-07-02',referenceOn:'2000-07-03'}),'BOLETO_DATE_UNSUPPORTED');
  assert.notEqual(calculateDueFactor({dueOn:'2024-02-28',referenceOn:'2024-02-28'}),calculateDueFactor({dueOn:'2024-02-29',referenceOn:'2024-02-29'}));
  assert.equal(Number(calculateDueFactor({dueOn:'2024-03-01',referenceOn:'2024-02-28'}))-Number(calculateDueFactor({dueOn:'2024-02-28',referenceOn:'2024-02-28'})),2);
});

test('invalid calendar dates, implicit formats and unsupported years fail without normalization',()=>{
  for(const dueOn of ['2025-02-29','2026-02-30','2026-04-31','2026-00-10','2026-13-01','2026-01-00','2026-1-01','2026-01-01T00:00:00Z','22/02/2025','1999-12-31','2100-01-01',null,20250222])
    errorCode(()=>calculateDueFactor({dueOn,referenceOn:'2026-10-16'}),'BOLETO_DATE_INVALID');
});

test('value remains exact in ten cent positions; no overflow borrows the factor field',()=>{
  for(const [amountCents,encoded]of[['1','0000000001'],['12345','0000012345'],['9999999999','9999999999']]){
    const value=input();value.title.amountCents=amountCents;const output=createBoletoDigits(value);
    assert.equal(output.amountCents,amountCents);assert.equal(output.barcode.slice(5,9),'1000');assert.equal(output.barcode.slice(9,19),encoded);
  }
  for(const amountCents of ['0','01','1.00','-1','1e3','1,00','10000000000','9999999999999999999999999999999999999999','１',1,1.23,null]){
    const value=input();value.title.amountCents=amountCents;errorCode(()=>createBoletoDigits(value),'BOLETO_AMOUNT_INVALID');
  }
});

test('contract, collection policy and explicit allocation are required and never treated as bank authentication',()=>{
  for(const [part,key,val,code]of[
    ['profile','contractVerified',false,'BOLETO_CONTRACT_UNCONFIRMED'],['profile','agreementReference','','BOLETO_CONTRACT_UNCONFIRMED'],
    ['profile','simpleCollectionPolicyVerified',false,'BOLETO_POLICY_UNCONFIRMED'],['allocation','confirmed',false,'BOLETO_ALLOCATION_UNCONFIRMED'],
    ['allocation','reference','  ','BOLETO_ALLOCATION_UNCONFIRMED'],['allocation','ourNumber','00000000','BOLETO_OUR_NUMBER_INVALID'],['allocation','ourNumber','1','BOLETO_OUR_NUMBER_INVALID'],
  ]){const value=input();value[part][key]=val;errorCode(()=>createBoletoDigits(value),code);}
  const value=input(),before=structuredClone(value),result=createBoletoDigits(value);
  assert.deepEqual(value,before);assert.deepEqual(result,createBoletoDigits(value));assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.pending));
  for(const[key,expected]of Object.entries(BOLETO_FLAGS))assert.equal(result[key],expected);
  assert.equal(result.bankRegistered,false);assert.equal(result.numberAllocationVerified,false);assert.equal(result.canIssue,false);assert.equal(result.canTransmit,false);
});

test('Inter110 is blocked by the unresolved bank free-field specification even with a confirmed synthetic range',()=>{
  const value=inter();assert.equal(interOurNumberDigit(value.allocation.ourNumber),'1'); // official Inter7.3 example
  errorCode(()=>createBoletoDigits(value),'BOLETO_INTER110_FIELD_LAYOUT_UNCONFIRMED');
  value.allocation.ourNumber='0004309600';errorCode(()=>createBoletoDigits(value),'BOLETO_OUR_NUMBER_OUTSIDE_RANGE');
  value.allocation.ourNumber='0004309540';value.profile.reservedRange.verified=false;errorCode(()=>createBoletoDigits(value),'BOLETO_PROFILE_INVALID');
  const under=inter();under.title.amountCents='249';errorCode(()=>createBoletoDigits(under),'BOLETO_AMOUNT_BELOW_MINIMUM');
  const guessed=inter();guessed.profile.operationNumber='00000001234567';errorCode(()=>createBoletoDigits(guessed),'BOLETO_INPUT_INVALID');
  const alternate=inter();alternate.profile.wallet='112';errorCode(()=>createBoletoDigits(alternate),'BOLETO_WALLET_UNSUPPORTED');
});

test('no real-purpose switch, unknown feature, arbitrary free field or accessor can bypass generation limits',()=>{
  const production=input();production.purpose='production';errorCode(()=>createBoletoDigits(production),'BOLETO_PURPOSE_UNSUPPORTED');
  for(const key of ['interestCents','discountCents','currency','freeField','barcode']){const value=input();value.title[key]='0';errorCode(()=>createBoletoDigits(value),'BOLETO_INPUT_INVALID');}
  const wallet=input();wallet.profile.wallet='110';errorCode(()=>createBoletoDigits(wallet),'BOLETO_PROFILE_INVALID');
  for(const mutate of[value=>{value.profile.account='１２３４５';},value=>{value.profile.account='123456';},value=>{value.profile.cnpj='00000000000000';},value=>{value.profile.companyName='EMPRESA Á';}]){const value=input();mutate(value);errorCode(()=>createBoletoDigits(value),'BOLETO_PROFILE_INVALID');}
  let called=0;const value=input();Object.defineProperty(value.profile,'agency',{enumerable:true,get(){called++;return'1234';}});errorCode(()=>createBoletoDigits(value),'BOLETO_INPUT_INVALID');assert.equal(called,0);
  errorCode(()=>createBoletoDigits(new Proxy({}, {ownKeys(){throw new Error('DO NOT EXPOSE PRIVATE MATERIAL');}})),'BOLETO_INPUT_INVALID');
});

test('invalid general digits and malformed numeric inputs are rejected; layout conversion round-trips exact44digits',()=>{
  const barcode='34196166700000123451101234567880057123457000';
  for(const bad of[barcode.slice(0,4)+'0'+barcode.slice(5),barcode.slice(0,-1)+'1',barcode+'0',' '+barcode,barcode.replace('341','840'),barcode.replace('3419','3410')])assert.throws(()=>barcodeToDigitableLine(bad),BoletoError);
  for(const bad of['1'.repeat(42),'1'.repeat(44),'1'.repeat(42)+'１',123])errorCode(()=>calculateBarcodeDigit(bad),'BOLETO_BARCODE_BASE_INVALID');
  const output=barcodeToDigitableLine(barcode),s=output.digits;
  assert.equal(s.length,47);assert.equal(s.slice(0,4)+s[32]+s.slice(33)+s.slice(4,9)+s.slice(10,20)+s.slice(21,31),barcode);
  assert.ok(Object.isFrozen(output));
});

test('general DAC maps the three exceptional remainders0/1/10 to1',()=>{
  //43-digit arithmetic vectors: last digit has weight2.00=>sum0,
  //06=>sum12(remainder1),05=>sum10(remainder10),01=>sum2=>DAC9.
  for(const [last,expected]of[['00','1'],['06','1'],['05','1'],['01','9']])assert.equal(calculateBarcodeDigit('0'.repeat(41)+last),expected);
});

test('Itaú candidate and existing CNAB generator bind the same synthetic number, nominal value and due date',async()=>{
  const value=input();value.title.dueOn='2026-10-16';value.title.referenceOn='2026-10-15';const candidate=createBoletoDigits(value);
  const remittance=await generateRemittance({profile:value.profile,titles:[cnabTitle({ourNumber:value.allocation.ourNumber,amountCents:value.title.amountCents,dueOn:value.title.dueOn})],generatedOn:value.title.referenceOn,remittanceSequence:'7',purpose:'homologation'});
  assert.equal(remittance.manifest[0].ourNumber,candidate.ourNumberWithDigit);assert.equal(remittance.totalCents,candidate.amountCents);
  const row=new TextDecoder().decode(remittance.bytes).split('\r\n')[1];assert.equal(row.slice(62,70),value.allocation.ourNumber);assert.equal(row.slice(126,139).replace(/^0+/,''),candidate.amountCents);assert.equal(row.slice(120,126),'161026');
});
