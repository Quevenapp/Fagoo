import { CnabError } from './primitives.mjs';
import { isValidatedReturn } from './return.mjs';

const INVALID = 'CNAB_LEGACY_REVIEW_INPUT_INVALID';
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_FIELDS = ['source_id', 'source_hash', 'source_version', 'status_code', 'amount_cents', 'balance_cents',
  'due_on', 'bank_number', 'document_number', 'document_number_complete', 'control', 'account_scope'];
const CLAIM_FIELDS = ['source_id', 'source_hash', 'source_version', 'file_hash', 'event_hash', 'line_hash', 'line'];
const FLAGS = Object.freeze({ read_only: true, persisted: false, can_bind: false, can_settle: false, can_generate: false,
  origin_authenticated: false, bridge_authenticated: false, financial_mutation_performed: false });
const ownErrors = new WeakSet();
function requireCnab(condition, code) {
  if (!condition) { const error = new CnabError(code); ownErrors.add(error); throw error; }
}

function fields(value, names) {
  requireCnab(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), INVALID);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  requireCnab(keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), INVALID);
  return Object.fromEntries(names.map(key => [key, descriptors[key].value]));
}
function list(value, max, min = 0) {
  requireCnab(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, INVALID);
  const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length?.value;
  requireCnab(Number.isInteger(length) && length >= min && length <= max
    && Reflect.ownKeys(descriptors).length === length + 1, INVALID);
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[index];
    requireCnab(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), INVALID);
    return descriptor.value;
  });
}
const text = (value, max = 200) => typeof value === 'string' && value.length <= max * 2
  && [...value].length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const id = value => typeof value === 'string' && /^[0-9]{1,40}$/.test(value) && /[1-9]/.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const version = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const money = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value);
const nullable = (value, check) => value === null || check(value);
function date(value) {
  if (typeof value !== 'string' || !/^(?:19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function source(value) {
  const result = fields(value, SOURCE_FIELDS);
  requireCnab(id(result.source_id) && hash(result.source_hash) && version(result.source_version)
    && nullable(result.status_code, v => typeof v === 'string' && /^[1-7]$/.test(v))
    && nullable(result.amount_cents, money) && nullable(result.balance_cents, money) && nullable(result.due_on, date)
    && ['bank_number', 'document_number', 'control', 'account_scope'].every(key => nullable(result[key], v => text(v)))
    && typeof result.document_number_complete === 'boolean', INVALID);
  return Object.freeze(result);
}
function claim(value) {
  const result = fields(value, CLAIM_FIELDS);
  requireCnab(id(result.source_id) && version(result.source_version)
    && ['source_hash', 'file_hash', 'event_hash', 'line_hash'].every(key => hash(result[key]))
    && Number.isInteger(result.line) && result.line >= 2 && result.line <= 9999, INVALID);
  return Object.freeze(result);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const present = value => value !== null && value !== '';
const compare = (left, right, complete = true) => !complete || !present(left) || !present(right) ? 'missing' : left === right ? 'equal' : 'different';
const aggregate = checks => Object.values(checks).includes('different') ? 'different' : Object.values(checks).includes('missing') ? 'missing' : 'equal';
function sourceState(value) {
  if (value.status_code !== null && value.status_code !== '1') return 'not_fully_open';
  if (value.amount_cents === '0' || value.balance_cents === '0'
    || value.amount_cents !== null && value.balance_cents !== null && value.amount_cents !== value.balance_cents) return 'not_fully_open';
  return value.status_code === null || value.amount_cents === null || value.balance_cents === null ? 'missing' : 'fully_open';
}
function bridgeStatus(value, assertion, parsed, events) {
  if (!assertion) return 'missing';
  if (assertion.source_hash !== value.source_hash || assertion.source_version !== value.source_version) return 'source_changed';
  if (assertion.file_hash !== parsed.fileHash || !events.some(event => event.line === assertion.line && event.lineHash === assertion.line_hash)) return 'evidence_conflict';
  return 'declared_unverified';
}

/**
 * Pure, bounded comparison of a selected Itaú109 RETURN and untrusted source
 * snapshots. This first version does not read or prove remittance evidence.
 *
 * parsed must be the original handle from parseReturn. Sources (max25) carry
 * exact source ID/hash/version (ID:1–40 decimal digits, nonzero, preserving
 * leading zeros), status_code, amount_cents/balance_cents,
 * due_on, bank_number, document_number, document_number_complete, control and
 * account_scope; unavailable data is null. No inferred control/account mapping.
 * document_number_complete must be false for a truncated/unverified projection.
 * Its truth is a caller declaration, not an attestation by this module.
 * bank_number is compared verbatim to "109/NNNNNNNN-D" formed from the parsed,
 * DV-checked number. No stripping, padding, case folding or amount tolerance.
 *
 * event_hashes selects1–100 unique hashes. Duplicate occurrences remain visible
 * and ambiguous. bridge_claims (max100, one per source/event pair) declare
 * source_id/hash/version + file_hash/event_hash/line_hash/line. Even a matching
 * claim is NOT authenticated and cannot establish a bank/native-title bridge.
 * All effects remain false, including for fully equal data and declared claims.
 * No freshness, contact identity, native origin039, cutoff or eligibility proof
 * is provided. There is no API, persistence, numbering or settlement here.
 */
export function reviewItau109Legacy(input) {
  try {
    const captured = fields(input, ['parsed', 'event_hashes', 'sources', 'bridge_claims']);
    const parsed = captured.parsed;
    requireCnab(isValidatedReturn(parsed) && parsed.bank === '341'
      && parsed.events.every(event => event.wallet === '109'), 'CNAB_LEGACY_VALIDATED_ITAU_RETURN_REQUIRED');
    const selected = list(captured.event_hashes, 100, 1);
    requireCnab(selected.every(hash) && new Set(selected).size === selected.length, INVALID);
    const sources = list(captured.sources, 25).map(source), claims = list(captured.bridge_claims, 100).map(claim);
    const ids = new Set(sources.map(value => value.source_id));
    requireCnab(ids.size === sources.length, INVALID);
    const byEvent = new Map(selected.map(value => [value, []]));
    for (const event of parsed.events) byEvent.get(event.eventHash)?.push(event);
    requireCnab([...byEvent.values()].every(events => events.length > 0), 'CNAB_LEGACY_EVENT_NOT_FOUND');
    const claimsByEvent = new Map();
    for (const value of claims) {
      requireCnab(ids.has(value.source_id) && byEvent.has(value.event_hash), INVALID);
      let eventClaims = claimsByEvent.get(value.event_hash);
      if (!eventClaims) { eventClaims = new Map(); claimsByEvent.set(value.event_hash, eventClaims); }
      requireCnab(!eventClaims.has(value.source_id), INVALID);
      eventClaims.set(value.source_id, value);
    }
    const events = [...byEvent].map(([eventHash, occurrences]) => {
      const event = occurrences[0];
      const bankNumber = event.ourNumber === null ? null : `109/${event.ourNumber.slice(0, 8)}-${event.ourNumber.slice(8)}`;
      const comparisons = sources.map(value => {
        const checks = { bank_number: compare(value.bank_number, bankNumber),
          document_number: compare(value.document_number, event.documentNumber, value.document_number_complete),
          control: compare(value.control, event.control), account_scope: compare(value.account_scope, event.accountScope),
          amount_cents: compare(value.amount_cents, event.amountCents), due_on: compare(value.due_on, event.dueDate) };
        return { source: { source_id: value.source_id, source_hash: value.source_hash, source_version: value.source_version },
          checks, data_status: aggregate(checks), source_state: sourceState(value),
          bridge_claim: bridgeStatus(value, claimsByEvent.get(eventHash)?.get(value.source_id), parsed, occurrences),
          bridge_authenticated: false };
      });
      // Only exact bank number or the entire alternative reference tuple can
      // select a comparison for the summary. Value/date alone never identify it.
      const references = comparisons.filter(value => value.checks.bank_number === 'equal'
        || ['document_number', 'control', 'account_scope'].every(key => value.checks[key] === 'equal'));
      const primary = references.length === 1 ? references[0] : comparisons.length === 1 ? comparisons[0] : null;
      let status;
      if (occurrences.length > 1 || references.length > 1) status = 'ambiguous';
      else if (primary?.bridge_claim === 'source_changed') status = 'source_changed';
      else if (primary?.bridge_claim === 'evidence_conflict' || primary?.data_status === 'different') status = 'data_divergence';
      else if (primary?.source_state === 'not_fully_open') status = 'source_not_open';
      else if (primary?.source_state === 'fully_open' && primary.data_status === 'equal') status = 'data_equal_unverified';
      else status = comparisons.length && comparisons.every(value => value.data_status === 'different') ? 'data_divergence' : 'missing_evidence';
      return { event_hash: eventHash, occurrences: occurrences.map(value => ({ line: value.line, line_hash: value.lineHash })),
        occurrence: event.occurrence, event_kind: event.kind, status, comparisons };
    });
    return freeze({ ...FLAGS, profile: 'itau109-legacy-return-review-v1', evidence_kind: 'return', file_hash: parsed.fileHash,
      source_count: sources.length, selected_event_count: selected.length, events,
      unassessed: ['SOURCE_AUTHENTICITY_AND_FRESHNESS', 'CONTACT_IDENTITY', 'BANK_ORIGIN_AUTHENTICITY', 'BRIDGE_AUTHENTICITY',
        'NATIVE_TITLE_AND_ORIGIN', 'CUTOVER_BALANCE', 'FINANCIAL_ELIGIBILITY', 'REMITTANCE_EVIDENCE'] });
  } catch (error) {
    // Reflection traps are untrusted too; never propagate their message/context,
    // even when they throw an instance of the public CnabError class.
    if (ownErrors.has(error)) throw error;
    throw new CnabError(INVALID);
  }
}
