import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseReturn } from '../src/index.mjs';
import { PROFILES, returnFile, replaceField } from './fixtures.mjs';

// Entirely synthetic. These are fixed padding variants, never copied bank data.
const parse = bytes => parseReturn(bytes, { profile: PROFILES.itau });
const hash = value => createHash('sha256').update(value).digest('hex');
function observedPadding(bytes) {
  bytes = replaceField(bytes, 1, 80, 'BANCO ITAU S.A.');
  bytes = replaceField(bytes, 2, 189, '0'.repeat(26));
  bytes = replaceField(bytes, 2, 306, '000000');
  return replaceField(bytes, 3, 88, ' '.repeat(50) + '0'.repeat(30) + ' '.repeat(10));
}

test('exact Itaú padding alternatives preserve events and hash the untouched original bytes', async () => {
  const standard = returnFile(), alternative = observedPadding(standard), copy = alternative.slice();
  const before = await parse(standard), after = await parse(alternative);
  assert.equal(after.validated, true);
  assert.equal(after.events[0].eventHash, before.events[0].eventHash);
  assert.notEqual(after.events[0].lineHash, before.events[0].lineHash);
  assert.equal(after.events[0].lineHash, hash(new TextDecoder().decode(alternative).split('\r\n')[1]));
  assert.equal(after.fileHash, hash(alternative));
  assert.notEqual(after.fileHash, before.fileHash);
  assert.deepEqual(alternative, copy);
  assert.equal(after.originAuthenticated, false);
  assert.equal(after.financialMutationPerformed, false);
});

test('only the observed bank label and exact reserved zero blocks are accepted', async () => {
  const good = observedPadding(returnFile());
  for (const [line, position, value, code] of [
    [1, 80, 'BANCO ITAU X.A.', 'CNAB_LITERAL_INVALID'],
    [1, 80, 'banco itau s.a.', 'CNAB_LITERAL_INVALID'],
    [2, 189, '1', 'CNAB_RESERVED_FIELD_INVALID'],
    [2, 189, ' ', 'CNAB_RESERVED_FIELD_INVALID'],
    [2, 306, '1', 'CNAB_RESERVED_FIELD_INVALID'],
    [2, 311, ' ', 'CNAB_RESERVED_FIELD_INVALID'],
    [3, 138, '1', 'CNAB_RESERVED_FIELD_INVALID'],
    [3, 137, '0', 'CNAB_RESERVED_FIELD_INVALID'],
    [3, 168, '0', 'CNAB_RESERVED_FIELD_INVALID'],
    [2, 30, '0', 'CNAB_RESERVED_FIELD_INVALID'],
    [2, 294, '0', 'CNAB_RESERVED_FIELD_INVALID'],
  ]) await assert.rejects(parse(replaceField(good, line, position, value)), e => e.code === code);
  for (const [line, position, value, code] of [
    [1, 77, '077', 'CNAB_LITERAL_INVALID'],
    [2, 24, '99999', 'CNAB_ACCOUNT_MISMATCH'],
    [2, 153, ' ', 'CNAB_NUMERIC_INVALID'],
    [2, 147, '310226', 'CNAB_DATE_INVALID'],
    [3, 213, '00000002', 'CNAB_TRAILER_COUNT_MISMATCH'],
  ]) await assert.rejects(parse(replaceField(good, line, position, value)), e => e.code === code);
  const inter = replaceField(returnFile({bank:'077'}), 1, 80, 'BANCO ITAU S.A.');
  await assert.rejects(parseReturn(inter,{profile:PROFILES.inter}), e => e.code === 'CNAB_LITERAL_INVALID');
});

test('Itaú net account credit, fee and combined interest/penalty remain distinct', async () => {
  let bytes = returnFile({events:[{amount:'10000',paid:'10050',fee:'250'}]});
  bytes = replaceField(bytes, 2, 267, '0000000000300');
  const event = (await parse(observedPadding(bytes))).events[0];
  assert.equal(event.amountCents, '10000');
  assert.equal(event.paidCents, '10050');
  assert.equal(event.adjustments.fee, '250');
  assert.equal(event.adjustments.interest, '300');
  assert.equal(BigInt(event.paidCents) + BigInt(event.adjustments.fee), BigInt(event.amountCents) + BigInt(event.adjustments.interest));
  // No guessed gross payment, split penalty, settlement or accounting mutation.
  assert.equal('grossPaidCents' in event, false);
  assert.equal('penaltyCents' in event.adjustments, false);
});

test('Itaú entry messages and unsupported alterations remain evidence, never rejected entries or payments', async () => {
  let bytes = replaceField(returnFile({events:[{occurrence:'02',paid:'0'}]}), 2, 378, '01000000');
  const entry = (await parse(observedPadding(bytes))).events[0];
  assert.equal(entry.kind, 'REGISTERED');
  assert.equal(entry.rejection, '01000000'); // Existing generic evidence field is retained.
  const alteration = (await parse(observedPadding(returnFile({events:[{occurrence:'04',paid:'0'}]})))).events[0];
  assert.equal(alteration.kind, 'UNSUPPORTED_OCCURRENCE');
  assert.deepEqual(alteration.warnings, ['OCCURRENCE_REQUIRES_SEPARATE_REVIEW']);
});

test('two-event return captures caller bytes and profile before the first digest await', async () => {
  const original = returnFile({events:[{control:'SYNTHETIC-A'}, {control:'SYNTHETIC-B',ourNumber:'00000002'}]});
  const expected = await parse(original);
  const bytes = original.slice(), profile = {...PROFILES.itau};
  const pending = parseReturn(bytes,{profile});
  bytes.fill(88);
  Object.assign(profile,{bank:'077',layout:PROFILES.inter.layout,accountId:'changed-after-call',agency:'0001',account:'000123456',accountDigit:'7',cnpj:'00000000000000',wallet:'112'});
  const actual = await pending;
  assert.deepEqual(actual, expected);
  assert.equal(actual.fileHash, hash(original));
  assert.equal(actual.events.length, 2);
  assert.equal(bytes.every(value=>value===88),true); // Never repairs/mutates caller input.
  assert.equal(profile.bank,'077');
});

test('return capture rejects accessors, inherited profiles, custom byte prototypes and shared memory', async () => {
  const bytes = returnFile();
  let getterCalls=0;
  const profile = {...PROFILES.itau};
  Object.defineProperty(profile,'bank',{enumerable:true,get(){getterCalls++;return '341';}});
  await assert.rejects(parseReturn(bytes,{profile}),e=>e.code==='CNAB_PROFILE_INVALID');
  const options = {get profile(){getterCalls++;return PROFILES.itau;}};
  await assert.rejects(parseReturn(bytes,options),e=>e.code==='CNAB_PROFILE_INVALID');
  await assert.rejects(parseReturn(bytes,{profile:Object.create(PROFILES.itau)}),e=>e.code==='CNAB_PROFILE_INVALID');
  const accessorBytes = bytes.slice();
  Object.defineProperty(accessorBytes,'buffer',{get(){getterCalls++;return bytes.buffer;}});
  await assert.rejects(parse(accessorBytes),e=>e.code==='CNAB_FILE_SIZE_INVALID');
  class CustomBytes extends Uint8Array {}
  await assert.rejects(parse(new CustomBytes(bytes)),e=>e.code==='CNAB_FILE_SIZE_INVALID');
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));shared.set(bytes);
  await assert.rejects(parse(shared),e=>e.code==='CNAB_FILE_SIZE_INVALID');
  const detached = bytes.slice();structuredClone(detached.buffer,{transfer:[detached.buffer]});
  await assert.rejects(parse(detached),e=>e.code==='CNAB_FILE_SIZE_INVALID');
  assert.equal(getterCalls,0);
  const buffer=Buffer.concat([Buffer.from('PREFIX'),Buffer.from(bytes),Buffer.from('SUFFIX')]);
  assert.deepEqual(await parse(buffer.subarray(6,-6)),await parse(bytes));
});

test('byte-only mutation during digest cannot replace the attested file hash', async () => {
  const original=returnFile({events:[{},{}]}),bytes=original.slice();
  const pending=parse(bytes);bytes.fill(88);
  const result=await pending;
  assert.equal(result.fileHash,hash(original));
  assert.notEqual(result.fileHash,hash(bytes));
  assert.equal(result.events.length,2);
});
