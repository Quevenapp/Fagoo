import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReturn } from '../src/index.mjs';
import * as layouts from '../src/layouts.mjs';
import { PROFILES, returnFile, replaceField } from './fixtures.mjs';

const parse = (bytes,bank = '341') => parseReturn(bytes,{profile:bank === '341' ? PROFILES.itau : PROFILES.inter});
const rejects = (bytes,code,bank) => assert.rejects(parse(bytes,bank),error => error.code === code);
test('all declared return layouts cover each of the 400 positions exactly once', () => {
  for (const layout of Object.values(layouts)) {
    const positions = layout.flatMap(([,start,end]) => Array.from({length:end-start+1},(_,i) => start+i));
    assert.equal(positions.length,400); assert.equal(new Set(positions).size,400);
    assert.equal(Math.min(...positions),1); assert.equal(Math.max(...positions),400);
  }
});
test('both supported banks parse validated full files and preserve exact money as strings', async () => {
  for (const bank of ['341','077']) {
    const parsed = await parse(returnFile({bank}),bank), event = parsed.events[0];
    assert.equal(parsed.validated,true); assert.equal(parsed.originAuthenticated,false); assert.equal(parsed.financialMutationPerformed,false);
    assert.equal(event.kind,'PAID'); assert.equal(event.amountCents,'12345'); assert.equal(event.paidCents,'12345');
    assert.equal(event.dueDate,'2026-10-30'); assert.equal(event.creditDate,'2026-10-19'); assert.equal(event.line,2);
    assert.match(event.eventHash,/^[a-f0-9]{64}$/); assert.match(event.lineHash,/^[a-f0-9]{64}$/);
    // Portfolio and original-remittance counts are deliberately unrelated to return detail count.
    assert.equal(parsed.recordCount,3);
  }
});
test('07 distinguishes Itaú partial payment from Inter cancellation; never guesses same meaning', async () => {
  assert.equal((await parse(returnFile({events:[{occurrence:'07'}]}))).events[0].kind,'PARTIAL_PAYMENT');
  assert.equal((await parse(returnFile({bank:'077',events:[{occurrence:'07',paid:'0',creditDate:'000000'}]}),'077')).events[0].kind,'CANCELLED');
});
test('bank, account, beneficiary, wallet, duplicate bank numbers and DAC must all match', async () => {
  const data = returnFile();
  await rejects(replaceField(data,1,77,'077'),'CNAB_LITERAL_INVALID');
  await rejects(replaceField(data,1,38,'9'),'CNAB_ACCOUNT_MISMATCH');
  await rejects(replaceField(data,2,24,'99999'),'CNAB_ACCOUNT_MISMATCH');
  await rejects(replaceField(data,2,4,'00000000000000'),'CNAB_BENEFICIARY_OR_WALLET_MISMATCH');
  await rejects(replaceField(data,2,83,'110'),'CNAB_BENEFICIARY_OR_WALLET_MISMATCH');
  await rejects(replaceField(data,2,86,'00000002'),'CNAB_OUR_NUMBER_COPIES_MISMATCH');
  const digit = new TextDecoder().decode(data).split('\r\n')[1][93];
  await rejects(replaceField(data,2,94,digit === '0' ? '1' : '0'),'CNAB_OUR_NUMBER_DIGIT_INVALID');
  await rejects(replaceField(returnFile({bank:'077'}),2,87,'110'),'CNAB_WALLET_COPIES_MISMATCH','077');
});
test('strict byte encoding, 400 positions, order, numeric fields and calendar validation', async () => {
  const data = returnFile();
  await rejects(new Uint8Array([239,187,191,...data]),'CNAB_ENCODING_UNSUPPORTED');
  await rejects(replaceField(data,2,325,'É'),'CNAB_ENCODING_UNSUPPORTED');
  await rejects(new TextEncoder().encode(new TextDecoder().decode(data).replace('\r\n','\n')),'CNAB_RECORD_LENGTH_INVALID');
  await rejects(data.slice(1),'CNAB_RECORD_LENGTH_INVALID');
  await rejects(replaceField(data,2,395,'000003'),'CNAB_SEQUENCE_INVALID');
  await rejects(replaceField(data,2,153,'X'),'CNAB_NUMERIC_INVALID');
  await rejects(replaceField(data,2,147,'300226'),'CNAB_DATE_INVALID');
  await rejects(replaceField(data,2,111,'311126'),'CNAB_DATE_INVALID');
  await rejects(replaceField(data,2,30,'X'),'CNAB_RESERVED_FIELD_INVALID');
});
test('no partial event output when trailer totals/counts or file sequence fail', async () => {
  await rejects(replaceField(returnFile(),3,213,'00000002'),'CNAB_TRAILER_COUNT_MISMATCH');
  await rejects(replaceField(returnFile(),3,221,'00000000000001'),'CNAB_TRAILER_AMOUNT_MISMATCH');
  await rejects(replaceField(returnFile(),3,208,'00002'),'CNAB_FILE_SEQUENCE_MISMATCH');
  await rejects(replaceField(returnFile({bank:'077'}),3,116,'00002'),'CNAB_TRAILER_COUNT_MISMATCH','077');
  await rejects(replaceField(returnFile({bank:'077'}),3,121,'000000000001'),'CNAB_TRAILER_AMOUNT_MISMATCH','077');
});
test('reject unsupported record structures, cheque layouts and undocumented Inter occurrences', async () => {
  await rejects(replaceField(returnFile(),2,1,'4'),'CNAB_RECORD_TYPE_UNSUPPORTED');
  await rejects(replaceField(returnFile(),2,109,'69'),'CNAB_CHEQUE_LAYOUT_UNSUPPORTED');
  await rejects(returnFile({bank:'077',events:[{occurrence:'04'}]}),'CNAB_OCCURRENCE_UNSUPPORTED','077');
});
test('file hash changes with metadata/line endings but canonical event hash is stable across redelivery', async () => {
  const first = await parse(returnFile()), redelivered = await parse(returnFile({generatedDate:'201026',fileSequence:'00002'}));
  assert.notEqual(first.fileHash,redelivered.fileHash); assert.equal(first.events[0].eventHash,redelivered.events[0].eventHash);
  const lf = new TextEncoder().encode(new TextDecoder().decode(returnFile()).replaceAll('\r\n','\n'));
  const parsedLf = await parse(lf); assert.notEqual(first.fileHash,parsedLf.fileHash); assert.equal(first.events[0].eventHash,parsedLf.events[0].eventHash);
  const two = await parse(returnFile({events:[{},{}]})); assert.equal(two.events[0].eventHash,two.events[1].eventHash); assert.notEqual(two.events[0].lineHash,two.events[1].lineHash);
});
test('empty Inter return is valid, rejected number may be unassigned, missing credit date remains explicit', async () => {
  assert.deepEqual((await parse(returnFile({bank:'077',events:[]}),'077')).events,[]);
  const rejected = await parse(returnFile({bank:'077',events:[{occurrence:'03',ourNumber:'00000000000',dueDate:'000000',paid:'0',creditDate:'000000'}]}),'077');
  assert.equal(rejected.events[0].ourNumber,null); assert.equal(rejected.events[0].dueDate,null);
  const unpaid = await parse(returnFile({events:[{creditDate:'000000'}]}));
  assert.equal(unpaid.events[0].creditDate,null); assert.ok(unpaid.events[0].warnings.includes('CREDIT_DATE_MISSING'));
});
test('Inter paid aggregate ambiguity is surfaced instead of assigning a guessed formula', async () => {
  const parsed = await parse(returnFile({bank:'077',events:[{paid:'12500'}]}),'077');
  assert.ok(parsed.warnings.includes('INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION'));
  assert.equal(parsed.trailer.paidAmount,'000000012500');
});
