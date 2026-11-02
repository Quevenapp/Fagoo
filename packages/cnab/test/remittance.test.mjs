import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRemittance, interOurNumberDigit, itauOurNumberDigit, validateProfile } from '../index.mjs';
import { PROFILES, title } from './fixtures.mjs';

const options = (profile = PROFILES.itau, titles = [title()]) => ({ profile, titles, generatedOn:'2026-10-15', remittanceSequence:'1', purpose:'homologation' });
const rejects = async (data,code) => assert.rejects(generateRemittance(data),error => error.code === code);
const rows = result => new TextDecoder().decode(result.bytes).slice(0,-2).split('\r\n');
const field = (row,from,to) => row.slice(from - 1,to);

test('documented Itaú Annex 4 modulo-10 example and Inter section 7.3 base', () => {
  assert.equal(itauOurNumberDigit({agency:'0057',account:'12345',wallet:'110',ourNumber:'12345678'}),'8');
  // Inter gives the base 00011100004309540, not a final digit. Independently:
  // nonzero weighted digit sums are 1+2+1+8+3+9+1+4=29; 10-(29%10)=1.
  assert.equal(interOurNumberDigit('0004309540'),'1');
});
test('Itaú homologation entry: exact bytes, fields and explicit no-protest/no-interest instructions', async () => {
  const result = await generateRemittance(options()); const [header,detail,trailer] = rows(result);
  assert.equal(result.bytes.length,1206); assert.equal(result.productionReady,false); assert.equal(result.totalCents,'12345');
  assert.equal(field(header,1,26),'01REMESSA01COBRANCA       '); assert.equal(field(header,77,79),'341');
  assert.equal(field(detail,84,86),'109'); assert.equal(field(detail,109,110),'01'); assert.equal(field(detail,127,139),'0000000012345');
  assert.equal(field(detail,157,160),'1047'); assert.equal(field(detail,161,218),'0'.repeat(58));
  assert.equal(field(detail,221,234),'00012345678909'); assert.equal(field(detail,235,264),'PAGADOR FICTICIO TESTE'.padEnd(30));
  assert.equal(field(trailer,1,1),'9'); assert.equal(field(trailer,2,394),' '.repeat(393));
  rows(result).forEach((row,index) => { assert.equal(row.length,400); assert.equal(field(row,395,400),String(index+1).padStart(6,'0')); });
  assert.match(result.fileHash,/^[a-f0-9]{64}$/); assert.equal(result.manifest[0].ourNumber.length,9);
});
test('Inter 112 uses bank-assigned number, correct filename and explicit days after due date', async () => {
  const data = options(PROFILES.inter,[title({ourNumber:undefined,paymentLimitDays:30})]); const result = await generateRemittance(data);
  const [header,detail,trailer] = rows(result);
  assert.equal(result.filename,'CI400_001_0000001.REM'); assert.equal(field(header,111,117),'0000001');
  assert.equal(field(detail,21,37),'11200010001234567'); assert.equal(field(detail,90,100),'00000000000');
  assert.equal(field(detail,140,141),'30'); assert.equal(field(detail,151,156),'      '); assert.equal(field(detail,208,220),' '.repeat(13));
  assert.equal(field(detail,66,66),'0'); assert.equal(field(detail,160,160),'0'); assert.equal(field(detail,184,184),'0');
  assert.equal(field(trailer,2,7),'000001'); assert.equal(result.manifest[0].ourNumber,null);
  await rejects({...data,titles:[title({paymentLimitDays:30})]},'CNAB_INTER_NUMBER_BANK_ASSIGNED');
  await rejects({...data,titles:[title({ourNumber:undefined,paymentLimitDays:61})]},'CNAB_PAYMENT_LIMIT_INVALID');
});
test('Inter 110 requires bank reserved range and computes documented digit', async () => {
  const profile = {...PROFILES.inter,wallet:'110'};
  const data = options(profile,[title({ourNumber:'0004309540',paymentLimitDays:1})]);
  await rejects(data,'CNAB_INTER_RESERVED_RANGE_REQUIRED');
  data.profile = {...profile,reservedRange:{verified:true,start:'0004309500',end:'0004309599'}};
  const result = await generateRemittance(data); assert.equal(field(rows(result)[1],90,100),'00043095401');
  await rejects({...data,titles:[title({ourNumber:'0004309600',paymentLimitDays:1})]},'CNAB_INTER_NUMBER_OUTSIDE_RESERVED_RANGE');
});
test('generation fails closed on production, agreement, monetary ambiguity and unsupported instructions', async () => {
  await rejects({...options(),purpose:'production'},'CNAB_PRODUCTION_GENERATION_UNAVAILABLE');
  await rejects({...options(),profile:{...PROFILES.itau,contractVerified:false}},'CNAB_BANK_AGREEMENT_UNCONFIRMED');
  await rejects({...options(),profile:{...PROFILES.itau,simpleCollectionPolicyVerified:false}},'CNAB_COLLECTION_POLICY_UNCONFIRMED');
  for (const value of ['1.23','00123','-1',12.34,'10000000000000']) await rejects(options(PROFILES.itau,[title({amountCents:value})]),'CNAB_AMOUNT_INVALID');
  await rejects(options(PROFILES.itau,[title({interestCents:'0'})]),'CNAB_TITLE_OR_FEATURE_UNSUPPORTED');
  await rejects(options(PROFILES.inter,[title({ourNumber:undefined,paymentLimitDays:30,amountCents:'249'})]),'CNAB_AMOUNT_BELOW_MINIMUM');
  assert.throws(() => validateProfile({...PROFILES.itau,wallet:'157'}),/CNAB_WALLET_UNSUPPORTED/);
  assert.throws(() => validateProfile({...PROFILES.inter,agency:'0002'}),/CNAB_INTER_AGENCY_INVALID/);
});
test('invalid documents, impossible dates, non-ASCII, truncation and duplicated references are rejected', async () => {
  const data = title();
  await rejects(options(PROFILES.itau,[title({payer:{...data.payer,document:'12345678900'}})]),'CNAB_PAYER_DOCUMENT_INVALID');
  await rejects(options(PROFILES.itau,[title({dueOn:'2026-02-30'})]),'CNAB_DATE_INVALID');
  await rejects(options(PROFILES.itau,[title({dueOn:'2026-10-14'})]),'CNAB_ISSUE_OR_DUE_DATE_INVALID');
  await rejects(options(PROFILES.itau,[title({payer:{...data.payer,name:'JOÃO TESTE'}})]),'CNAB_TEXT_INVALID');
  await rejects(options(PROFILES.itau,[title({control:'A'.repeat(26)})]),'CNAB_TEXT_INVALID');
  await rejects(options(PROFILES.itau,[title(),title()]),'CNAB_DUPLICATE_TITLE_REFERENCE');
  await rejects(options(PROFILES.itau,Array.from({length:31},() => title())),'CNAB_HOMOLOGATION_TITLE_LIMIT');
});
