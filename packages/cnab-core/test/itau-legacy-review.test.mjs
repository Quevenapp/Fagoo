import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReturn } from '../src/return.mjs';
import { reviewItau109Legacy } from '../src/itau-legacy-review.mjs';
import { CnabError } from '../src/primitives.mjs';
import { PROFILES, returnFile } from './fixtures.mjs';

const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
const INPUT_INVALID = { code: 'CNAB_LEGACY_REVIEW_INPUT_INVALID' };
async function fixture(overrides = {}) {
  const parsed = await parseReturn(returnFile(overrides), { profile: overrides.profile ?? (overrides.bank === '077' ? PROFILES.inter : PROFILES.itau) });
  return { parsed, event_hashes: [...new Set(parsed.events.map(event => event.eventHash))], sources: [source(parsed.events[0])], bridge_claims: [] };
}
function source(event, overrides = {}) {
  return { source_id: '1001', source_hash: HASH, source_version: '1', status_code: '1', amount_cents: event.amountCents,
    balance_cents: event.amountCents, due_on: event.dueDate, bank_number: `109/${event.ourNumber.slice(0, 8)}-${event.ourNumber.slice(8)}`,
    document_number: event.documentNumber, document_number_complete: true, control: event.control, account_scope: event.accountScope, ...overrides };
}
function claim(input, overrides = {}) {
  const event = input.parsed.events[0], value = input.sources[0];
  return { source_id: value.source_id, source_hash: value.source_hash, source_version: value.source_version,
    file_hash: input.parsed.fileHash, event_hash: event.eventHash, line_hash: event.lineHash, line: event.line, ...overrides };
}
const first = input => reviewItau109Legacy(input).events[0];

test('equal fields remain unverified; a declared bridge cannot authenticate origin or enable any effect', async () => {
  const input = await fixture({ events: [{ documentNumber: '123456/01' }] });
  let result = reviewItau109Legacy(input);
  assert.equal(result.events[0].status, 'data_equal_unverified');
  assert.equal(result.events[0].comparisons[0].bridge_claim, 'missing');
  input.bridge_claims = [claim(input)];
  result = reviewItau109Legacy(input);
  assert.equal(result.events[0].comparisons[0].bridge_claim, 'declared_unverified');
  assert.equal(result.events[0].comparisons[0].bridge_authenticated, false);
  assert.equal(result.read_only, true);
  for (const key of ['can_bind', 'can_settle', 'can_generate', 'persisted', 'origin_authenticated', 'bridge_authenticated', 'financial_mutation_performed']) assert.equal(result[key], false);
  assert.equal(result.evidence_kind, 'return');
  assert.ok(result.unassessed.includes('REMITTANCE_EVIDENCE'));
  assert.ok(result.unassessed.includes('CONTACT_IDENTITY'));
  assert.ok(result.unassessed.includes('SOURCE_AUTHENTICITY_AND_FRESHNESS'));
  const output = JSON.stringify(result);
  for (const privateValue of [input.sources[0].bank_number, input.sources[0].account_scope, input.sources[0].control, input.sources[0].document_number]) assert.equal(output.includes(privateValue), false);
  assert.equal(output.includes('exact_candidate'), false);
});

test('038-shaped bank/document references can agree while unavailable control and account remain missing', async () => {
  const input = await fixture({ events: [{ documentNumber: '123456/01' }] });
  Object.assign(input.sources[0], { control: null, account_scope: null });
  const result = first(input), comparison = result.comparisons[0];
  assert.equal(result.status, 'missing_evidence');
  assert.equal(comparison.checks.bank_number, 'equal');
  assert.equal(comparison.checks.document_number, 'equal');
  assert.equal(comparison.checks.control, 'missing');
  assert.equal(comparison.checks.account_scope, 'missing');
  input.bridge_claims = [claim(input)];
  assert.equal(first(input).status, 'missing_evidence', 'claim cannot fill absent fields');
});

test('number, document, control and scope compare exactly without padding, stripping DV, trimming or approximate money/dates', async () => {
  const input = await fixture({ events: [{ documentNumber: '123456/01' }] }), original = input.sources[0];
  const changes = [
    ['bank_number', input.parsed.events[0].ourNumber], ['bank_number', original.bank_number.replace('00000001', '1')],
    ['bank_number', original.bank_number + ' '], ['bank_number', '112/' + original.bank_number.slice(4)],
    ['bank_number', original.bank_number.slice(0, -1) + (original.bank_number.endsWith('0') ? '1' : '0')],
    ['document_number', '123456/1'], ['document_number', '123456/01 '], ['control', original.control.toLowerCase()],
    ['account_scope', original.account_scope + ' '], ['amount_cents', '12346'], ['due_on', '2026-10-31'],
  ];
  for (const [key, value] of changes) {
    input.sources = [{ ...original, [key]: value }];
    const result = first(input);
    assert.equal(result.comparisons[0].checks[key], 'different', key);
    assert.equal(result.status, 'data_divergence', key);
  }
});

test('missing and truncated projections never count as equal; no sources is missing evidence', async () => {
  const input = await fixture();
  input.sources[0].document_number_complete = false;
  assert.equal(first(input).comparisons[0].checks.document_number, 'missing');
  assert.equal(first(input).status, 'missing_evidence');
  Object.assign(input.sources[0], { document_number: '', bank_number: null, control: null, account_scope: null, due_on: null, amount_cents: null, balance_cents: null, status_code: null });
  assert.deepEqual(Object.values(first(input).comparisons[0].checks), Array(6).fill('missing'));
  assert.equal(first(input).comparisons[0].source_state, 'missing');
  input.sources = [];
  assert.equal(first(input).status, 'missing_evidence');
});

test('partial/paid/outside status, missing balance and zero principal never become fully open', async () => {
  const input = await fixture(), original = input.sources[0];
  for (const status_code of ['2', '3', '4', '5', '6', '7']) {
    input.sources = [{ ...original, status_code }];
    assert.equal(first(input).status, 'source_not_open');
    assert.equal(first(input).comparisons[0].source_state, 'not_fully_open');
  }
  input.sources = [{ ...original, balance_cents: '12344' }];
  assert.equal(first(input).status, 'source_not_open');
  input.sources[0].balance_cents = null;
  assert.equal(first(input).status, 'missing_evidence');
  input.sources = [{ ...original, amount_cents: '0', balance_cents: '0' }];
  assert.equal(first(input).comparisons[0].source_state, 'not_fully_open');
});

test('multiple exact bank references are ambiguous even with different amount or state; claim never chooses a winner', async () => {
  const input = await fixture();
  input.sources.push({ ...input.sources[0], source_id: '1002', amount_cents: '12346', balance_cents: '12346', status_code: '2' });
  input.bridge_claims = [claim(input)];
  assert.equal(first(input).status, 'ambiguous');
  assert.equal(first(input).comparisons.length, 2);
  assert.equal(first(input).comparisons[0].data_status, 'equal');
  assert.equal(first(input).comparisons[1].data_status, 'different');
});

test('equal value/date alone never select an identity among sources', async () => {
  const input = await fixture();
  input.sources = [source(input.parsed.events[0], { bank_number: null, control: null, account_scope: null, document_number: null }),
    source(input.parsed.events[0], { source_id: '1002', bank_number: null, control: null, account_scope: null, document_number: null })];
  assert.equal(first(input).status, 'missing_evidence');
  assert.equal(first(input).comparisons.every(value => value.checks.amount_cents === 'equal' && value.checks.due_on === 'equal'), true);
});

test('duplicate return events remain ambiguous with every physical line visible', async () => {
  const input = await fixture({ events: [{}, {}] });
  assert.equal(input.parsed.events[0].eventHash, input.parsed.events[1].eventHash);
  assert.notEqual(input.parsed.events[0].lineHash, input.parsed.events[1].lineHash);
  input.bridge_claims = [claim(input)];
  const result = first(input);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.occurrences, input.parsed.events.map(event => ({ line: event.line, line_hash: event.lineHash })));
});

test('source hash/version and bank file/line claims are separately compared, never authenticated', async () => {
  const input = await fixture();
  for (const delta of [{ source_hash: OTHER_HASH }, { source_version: '2' }]) {
    input.bridge_claims = [claim(input, delta)];
    assert.equal(first(input).status, 'source_changed');
    assert.equal(first(input).comparisons[0].data_status, 'equal');
    assert.equal(first(input).comparisons[0].bridge_claim, 'source_changed');
  }
  for (const delta of [{ file_hash: OTHER_HASH }, { line_hash: OTHER_HASH }, { line: 3 }]) {
    input.bridge_claims = [claim(input, delta)];
    assert.equal(first(input).status, 'data_divergence');
    assert.equal(first(input).comparisons[0].bridge_claim, 'evidence_conflict');
  }
});

test('only the original attested Itaú handle is accepted; alterations cannot masquerade as parsed evidence', async () => {
  const input = await fixture();
  for (const parsed of [structuredClone(input.parsed), { ...input.parsed, originAuthenticated: true }, null]) {
    assert.throws(() => reviewItau109Legacy({ ...input, parsed }), { code: 'CNAB_LEGACY_VALIDATED_ITAU_RETURN_REQUIRED' });
  }
  assert.throws(() => reviewItau109Legacy({ ...input, event_hashes: [OTHER_HASH] }), { code: 'CNAB_LEGACY_EVENT_NOT_FOUND' });
  const inter = await fixture({ bank: '077' });
  assert.throws(() => reviewItau109Legacy(inter), { code: 'CNAB_LEGACY_VALIDATED_ITAU_RETURN_REQUIRED' });
});

test('source snapshots and results are isolated, deeply frozen and carry no mutable caller references', async () => {
  const input = await fixture(); input.bridge_claims = [claim(input)];
  const result = reviewItau109Legacy(input), serialized = JSON.stringify(result);
  input.sources[0].source_id = 'changed'; input.sources[0].amount_cents = '1'; input.sources.length = 0;
  input.bridge_claims[0].line_hash = OTHER_HASH; input.event_hashes.length = 0;
  assert.equal(JSON.stringify(result), serialized);
  assert.throws(() => { result.events[0].comparisons[0].checks.bank_number = 'different'; }, TypeError);
  assert.throws(() => { result.events[0].occurrences.push({}); }, TypeError);
});

test('strict descriptors reject accessors, inherited/unknown fields, array tricks and forged authentication without invoking getters', async () => {
  const input = await fixture(); let calls = 0;
  const getter = { ...input.sources[0] }; Object.defineProperty(getter, 'bank_number', { enumerable: true, get() { calls++; return 'x'; } });
  const badSources = [getter, Object.assign(Object.create({}), input.sources[0]), { ...input.sources[0], authenticated: true },
    { ...input.sources[0], [Symbol('private')]: 'value' }];
  for (const value of badSources) assert.throws(() => reviewItau109Legacy({ ...input, sources: [value] }), INPUT_INVALID);
  const outer = { ...input }; Object.defineProperty(outer, 'sources', { enumerable: true, get() { calls++; return []; } });
  assert.throws(() => reviewItau109Legacy(outer), INPUT_INVALID);
  const array = [...input.sources]; Object.defineProperty(array, '0', { get() { calls++; return input.sources[0]; } });
  assert.throws(() => reviewItau109Legacy({ ...input, sources: array }), INPUT_INVALID);
  for (const sources of [Array(1), Object.assign([...input.sources], { extra: 1 })]) assert.throws(() => reviewItau109Legacy({ ...input, sources }), INPUT_INVALID);
  assert.throws(() => reviewItau109Legacy({ ...input, bridge_claims: [{ ...claim(input), authenticated: true }] }), INPUT_INVALID);
  assert.equal(calls, 0);
});

test('closed scalar contracts preserve exact IDs/integers and reject malformed dates, aliases or duplicates', async () => {
  const input = await fixture(), original = input.sources[0];
  for (const delta of [{ source_version: '01' }, { source_version: '9223372036854775808' }, { amount_cents: '012345' },
    { amount_cents: 12345 }, { status_code: 1 }, { status_code: 'open' }, { due_on: '2026-02-30' },
    { document_number_complete: undefined }, { bank_number: 'x'.repeat(201) }, { source_id: 'x\n' }, { source_id: '0000' }, { source_id: '1'.repeat(41) }, { source_hash: HASH.toUpperCase() }]) {
    assert.throws(() => reviewItau109Legacy({ ...input, sources: [{ ...original, ...delta }] }), INPUT_INVALID);
  }
  input.sources[0] = { ...original, source_id: '00001', source_version: '9223372036854775807', amount_cents: '9007199254740993', balance_cents: '9007199254740992' };
  const value = first(input).comparisons[0];
  assert.equal(value.source.source_id, '00001');
  assert.equal(value.source_state, 'not_fully_open', 'one cent above Number safe range remains distinct');
  assert.throws(() => reviewItau109Legacy({ ...input, sources: [original, { ...original }] }), INPUT_INVALID);
  assert.throws(() => reviewItau109Legacy({ ...input, event_hashes: [input.event_hashes[0], input.event_hashes[0]] }), INPUT_INVALID);
  input.sources = [original]; input.bridge_claims = [claim(input), claim(input)];
  assert.throws(() => reviewItau109Legacy(input), INPUT_INVALID);
});

test('bounded selection supports100 events and25 sources but refuses arbitrary claims or an expanded scope', async () => {
  const input = await fixture({ events: Array.from({ length: 100 }, (_, index) => ({ ourNumber: String(index + 1).padStart(8, '0'), control: `SYNTHETIC-${index}` })) });
  input.sources = input.parsed.events.slice(0, 25).map((event, index) => source(event, { source_id: String(index + 1001) }));
  const result = reviewItau109Legacy(input);
  assert.equal(result.selected_event_count, 100); assert.equal(result.source_count, 25);
  assert.equal(result.events.length, 100); assert.equal(result.events.every(event => event.comparisons.length === 25), true);
  assert.equal(result.events[0].status, 'data_equal_unverified');
  assert.throws(() => reviewItau109Legacy({ ...input, event_hashes: [...input.event_hashes, OTHER_HASH] }), INPUT_INVALID);
  assert.throws(() => reviewItau109Legacy({ ...input, sources: [...input.sources, { ...input.sources[0], source_id: '9999' }] }), INPUT_INVALID);
  assert.throws(() => reviewItau109Legacy({ ...input, bridge_claims: [claim(input, { source_id: 'unknown' })] }), INPUT_INVALID);
  assert.throws(() => reviewItau109Legacy({ ...input, bridge_claims: [claim(input, { event_hash: OTHER_HASH })] }), INPUT_INVALID);
});

test('external traps cannot expose raw exceptions or bank/source values', async () => {
  const input = await fixture(), sentinel = 'PRIVATE-SENTINEL';
  for (const injected of [new Error(sentinel), Object.assign(new CnabError(INPUT_INVALID.code), { message: sentinel, field: sentinel })]) {
    const proxy = new Proxy(input.sources[0], { ownKeys() { throw injected; } });
    assert.throws(() => reviewItau109Legacy({ ...input, sources: [proxy] }), error => error instanceof CnabError && error.code === INPUT_INVALID.code && !error.message.includes(sentinel) && error.field === undefined);
  }
});
