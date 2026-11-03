import test from 'node:test';
import assert from 'node:assert/strict';
import { accountScope, parseReturn, planReturnReconciliation } from '../src/index.mjs';
import { PROFILES, returnFile } from './fixtures.mjs';

async function input({bank = '341',events = [{}]} = {}) {
  const profile = bank === '341' ? PROFILES.itau : PROFILES.inter, parsed = await parseReturn(returnFile({bank,events}),{profile});
  const event = parsed.events[0];
  const titles = [{id:'title-1',accountScope:accountScope(profile),control:'SYNTHETIC-0001',documentNumber:'TESTE0001',ourNumber:event.ourNumber,
    amountCents:'12345',outstandingCents:'12345',dueDate:'2026-10-30',status:'open'}];
  const evidence = {source:'authenticated-bank-download',fileHash:parsed.fileHash,accountId:profile.accountId,reviewedBy:'operator-test',referenceId:'private-evidence-1'};
  return {parsed,titles,evidence};
}
const first = data => planReturnReconciliation(data).decisions[0];
test('forged or serialized validated flags cannot bypass the parser attestation', async () => {
  const data = await input();
  assert.throws(() => first({...data,parsed:{...data.parsed,validated:true}}),/CNAB_VALIDATED_RETURN_REQUIRED/);
  assert.throws(() => first({...data,parsed:JSON.parse(JSON.stringify(data.parsed))}),/CNAB_VALIDATED_RETURN_REQUIRED/);
});
test('validated result, event, nested monetary evidence and trailer are immutable', async () => {
  const data = await input();
  assert.throws(() => { data.parsed.events[0].paidCents = '1'; },TypeError);
  assert.throws(() => { data.parsed.events[0].adjustments.fee = '999'; },TypeError);
  assert.throws(() => { data.parsed.events.push({}); },TypeError);
  assert.throws(() => { data.parsed.trailer.fileAmount = '1'; },TypeError);
  assert.equal(first(data).action,'PROPOSE_SETTLEMENT_REVIEW');
});
test('exact matched payment proposes human review and never mutates the title or enables settlement', async () => {
  const data = await input(), original = structuredClone(data.titles); const plan = planReturnReconciliation(data);
  assert.equal(plan.decisions[0].action,'PROPOSE_SETTLEMENT_REVIEW'); assert.equal(plan.decisions[0].titleId,'title-1');
  assert.equal(plan.canSettle,false); assert.equal(plan.financialMutationPerformed,false); assert.equal(plan.decisions[0].canSettle,false);
  assert.deepEqual(data.titles,original);
});
test('requires separate bank-origin evidence: a valid file/hash is not authenticity', async () => {
  const data = await input();
  assert.equal(first({...data,evidence:undefined}).reason,'BANK_ORIGIN_EVIDENCE_REQUIRED');
  assert.equal(first({...data,evidence:{...data.evidence,fileHash:'a'.repeat(64)}}).reason,'BANK_ORIGIN_EVIDENCE_REQUIRED');
  assert.equal(first({...data,evidence:{...data.evidence,accountId:'other-account'}}).reason,'BANK_ORIGIN_EVIDENCE_REQUIRED');
});
test('unmatched, duplicated and conflicting references cannot become settlement proposals', async () => {
  const data = await input();
  assert.equal(first({...data,titles:[]}).reason,'TITLE_NOT_FOUND');
  assert.equal(first({...data,titles:[...data.titles,{...data.titles[0],id:'title-2'}]}).reason,'AMBIGUOUS_TITLE_MATCH');
  assert.equal(first({...data,titles:[{...data.titles[0],ourNumber:'000000009'}]}).reason,'BANK_NUMBER_MISMATCH');
  assert.equal(first({...data,titles:[{...data.titles[0],amountCents:'12346'}]}).reason,'TITLE_AMOUNT_OR_DUE_DATE_MISMATCH');
  assert.equal(first({...data,titles:[{...data.titles[0],status:'settled',outstandingCents:'0'}]}).reason,'TITLE_NOT_FULLY_OPEN');
});
test('duplicate file and semantic event suppress proposals, including duplicates within one file', async () => {
  const data = await input();
  assert.equal(first({...data,seenFileHashes:[data.parsed.fileHash]}).reason,'DUPLICATE_FILE');
  assert.equal(first({...data,seenEventHashes:[data.parsed.events[0].eventHash]}).reason,'DUPLICATE_EVENT');
  const duplicated = planReturnReconciliation(await input({events:[{},{}]}));
  assert.equal(duplicated.decisions[0].action,'PROPOSE_SETTLEMENT_REVIEW'); assert.equal(duplicated.decisions[1].action,'SKIP');
});
test('cancellation and partial payment are distinct review events, never normal settlements', async () => {
  assert.equal(first(await input({events:[{occurrence:'07'}]})).reason,'BANK_EVENT_PARTIAL_PAYMENT');
  assert.equal(first(await input({bank:'077',events:[{occurrence:'07',paid:'0',creditDate:'000000'}]})).reason,'BANK_EVENT_CANCELLED');
});
test('missing credit dates, fees, differences, and already partial ledger balances require review', async () => {
  assert.equal(first(await input({events:[{creditDate:'000000'}]})).reason,'PAYMENT_DATES_MISSING');
  assert.equal(first(await input({events:[{fee:'100'}]})).reason,'PAYMENT_AMOUNTS_REQUIRE_REVIEW');
  assert.equal(first(await input({events:[{paid:'12000'}]})).reason,'PAYMENT_AMOUNTS_REQUIRE_REVIEW');
  const data = await input();
  assert.equal(first({...data,titles:[{...data.titles[0],outstandingCents:'12000'}]}).reason,'TITLE_NOT_FULLY_OPEN');
});
test('Inter112 registration can propose binding a bank number; payment cannot invent that binding', async () => {
  const registration = await input({bank:'077',events:[{occurrence:'02',paid:'0',creditDate:'000000'}]});
  registration.titles[0].ourNumber = null;
  assert.equal(first(registration).action,'PROPOSE_BANK_NUMBER_BINDING_REVIEW');
  const payment = await input({bank:'077'}); payment.titles[0].ourNumber = null;
  assert.equal(first(payment).reason,'UNBOUND_BANK_NUMBER');
});
