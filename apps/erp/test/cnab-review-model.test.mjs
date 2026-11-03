import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanDetail, humanPage, humanHistory, humanReviewInput, humanSaveResult, reviewMoney, returnReason, HUMAN_REVIEW_LABELS } from '../src/lib/cnab-review-model.ts';
const uuid = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const safety = { purpose: 'homologation', productionReady: false, canSettle: false, financialMutationPerformed: false, originAuthenticated: false };
const hash = 'a'.repeat(64), eventId = uuid(1), fileId = uuid(2), commandId = uuid(9);
const fixture = () => ({ ...safety, event_id: eventId, context_hash: hash, review_version: 0, review: null, bytes_verified: false, context: {
  version: 1, event: { id: eventId, hash, bank: '341', wallet: '109', control: '000001', document_number: 'NF001', our_number: '00000001', occurrence: '06', kind: 'PAID', due_on: '2026-10-16', occurred_on: '2026-10-16', credited_on: '2026-10-16', amount_cents: '12345', paid_cents: '12345', adjustments: { fee: '0', iof: '0', abatement: '0', discount: '0', interest: '0', otherCredits: '0' }, warnings: [] },
  occurrence: { file_id: fileId, file_hash: hash, line: 2, line_hash: hash, duplicate: false, generated_on: '2026-10-16', declared_bank_origin: true, reference_id: 'SYNTHETIC', warnings: [] },
  profile: { id: uuid(3), version: 1, bank: '341', wallet: '109', account_id: uuid(4), account_name: 'Conta fictícia', account_mask: '***123', account_version: 1, account_active: true, contract_verified: true, policy_verified: true },
  billing: { id: uuid(5), remittance_id: uuid(6), remittance_state: 'ready', control: '000001', document_number: 'NF001', our_number: '00000001' },
  title: { id: uuid(7), version: 1, kind: 'receivable', description: 'Título sintético', issued_on: '2026-10-15', due_on: '2026-10-16', amount_cents: '12345', settled_cents: '0', balance_cents: '12345', cancelled: false },
  proposal: { action: 'PROPOSE_SETTLEMENT_REVIEW', reason: 'EXACT_MATCH_REQUIRES_HUMAN_REVIEW' }, comparison: { source_linked: true, reference_matches: true, bank_number_matches: true, amount_matches: true, due_matches: true, fully_open: true, paid_matches_balance: true, has_adjustments: false, reason: 'EXACT_MATCH_HOMOLOGATION_ONLY' },
} });
const preview = () => ({ ...fixture(), bytes_verified: true });
const revision = (version = 1, source = fixture()) => ({ event_id: eventId, version, status: 'confirmed', reason: 'Conferência fictícia.', context_hash: source.context_hash, context: source.context, reviewed_at: '2026-10-16T10:00:00Z' });
const row = (line = 2) => ({ line, event_id: eventId, event_hash: hash, duplicate: false, kind: 'PAID', control: '000001', document_number: 'NF001', amount_cents: '12345', paid_cents: '12345', review_version: 0, review_status: 'pending', context_changed: false });

test('detail binds selected event, file, occurrence and byte verification without enaorigin finance', () => {
  assert.equal(humanDetail(fixture(), eventId, fileId, 2).canSettle, false);
  assert.equal(humanDetail(preview(), eventId, fileId, 2, true).bytes_verified, true);
  for (const args of [[eventId, uuid(99), 2], [uuid(99), fileId, 2], [eventId, fileId, 3], [eventId, fileId, 2, true]]) assert.throws(() => humanDetail(fixture(), ...args));
  for (const key of ['productionReady', 'canSettle', 'financialMutationPerformed', 'originAuthenticated']) { const d = fixture(); d[key] = true; assert.throws(() => humanDetail(d, eventId, fileId, 2)); }
  assert.throws(() => humanDetail({ ...fixture(), purpose: 'production' }, eventId, fileId, 2));
});
test('context rejects incorrect comparisons, leaked unmasked account and malformed cents/dates', () => {
  const mutations = [d => d.context.event.paid_cents = 12345, d => d.context.event.paid_cents = '1e3', d => d.context.event.due_on = '2026-02-30',
    d => d.context.profile.account_mask = '123456789', d => d.context.profile.bank = '077', d => d.context.title.balance_cents = '12344',
    d => d.context.comparison.bank_number_matches = false, d => d.context.comparison.reference_matches = null,
    d => d.context.event.adjustments.fee = '1', d => d.context.billing = null, d => d.context.event.id = uuid(22),
    d => d.context.occurrence.reference_id = null, d => d.context.event.warnings.push({ code: 'unknown' })];
  for (const mutate of mutations) { const d = fixture(); mutate(d); assert.throws(() => humanDetail(d, eventId, fileId, 2)); }
});
test('an unlinked event remains explicitly unlinked and cannot silently gain comparison results', () => {
  const d = fixture(); d.context.billing = null; d.context.title = null; const c = d.context.comparison; c.source_linked = false; c.reason = 'UNLINKED_EVENT';
  for (const key of ['reference_matches', 'bank_number_matches', 'amount_matches', 'due_matches', 'fully_open', 'paid_matches_balance']) c[key] = null;
  assert.equal(humanDetail(d, eventId, fileId, 2).context.title, null);
  c.reference_matches = true; assert.throws(() => humanDetail(d, eventId, fileId, 2));
});
test('review creation requires verified bytes, explicit decision, reason and confirmation', () => {
  const p = preview(), input = humanReviewInput(p, 'pending_issue', '  Referência precisa de conferência. ', true, commandId);
  assert.deepEqual(input, { command_id: commandId, file_id: fileId, line: 2, expected_review_version: 0, expected_context_hash: hash, status: 'pending_issue', reason: 'Referência precisa de conferência.' });
  for (const args of [[null, 'confirmed', 'Motivo', true, commandId], [fixture(), 'confirmed', 'Motivo', true, commandId], [p, 'settled', 'Motivo', true, commandId],
    [p, 'confirmed', 'ok', true, commandId], [p, 'confirmed', 'Uma\nlinha', true, commandId], [p, 'confirmed', 'x'.repeat(1001), true, commandId], [p, 'confirmed', 'Motivo', false, commandId], [p, 'confirmed', 'Motivo', true, 'bad']]) assert.throws(() => humanReviewInput(...args));
  for (const key of ['title_id', 'our_number', 'amount_cents', 'settlement', 'actor']) assert.equal(Object.hasOwn(input, key), false);
});
test('review save response binds exact command intent while replay remains historical', () => {
  const p = preview(), input = humanReviewInput(p, 'confirmed', 'Conferência fictícia.', true, commandId);
  const saved = { ...safety, event_id: eventId, record: revision(), replayed: true };
  assert.equal(humanSaveResult(saved, eventId, input).record.version, 1);
  for (const mutate of [v => v.record.version = 2, v => v.record.status = 'pending_issue', v => v.record.context_hash = 'b'.repeat(64), v => v.record.context.occurrence.line = 3, v => v.record.reason = 'Outra intenção', v => v.event_id = uuid(22)]) {
    const bad = structuredClone(saved); mutate(bad); assert.throws(() => humanSaveResult(bad, eventId, input));
  }
});
test('redelivery preserves older context and marks differences rather than replacing history', () => {
  const d = fixture(), old = revision(); d.review_version = 1; d.review = { ...old, context_changed: true }; d.context_hash = 'b'.repeat(64); d.context.occurrence.file_id = uuid(10); d.context.occurrence.duplicate = true;
  const result = humanDetail(d, eventId, uuid(10), 2);
  assert.equal(result.review.context.occurrence.file_id, fileId); assert.equal(result.context.occurrence.file_id, uuid(10));
  d.review.context_changed = false; assert.throws(() => humanDetail(d, eventId, uuid(10), 2));
});
test('event pagination is bounded and ordered by occurrence, preserving duplicate canonical events', () => {
  const p = { ...safety, file_id: fileId, items: [row(), { ...row(3), duplicate: true }], limit: 25, has_more: false, next_cursor: null };
  assert.equal(humanPage(p, fileId).items.length, 2);
  for (const mutate of [v => v.items[1].line = 2, v => v.items[0].review_status = 'confirmed', v => v.items[0].context_changed = true, v => v.has_more = true, v => v.next_cursor = 3, v => v.file_id = uuid(5)]) {
    const bad = structuredClone(p); mutate(bad); assert.throws(() => humanPage(bad, fileId));
  }
  const full = { ...p, items: Array.from({ length: 25 }, (_, i) => row(i + 2)), has_more: true, next_cursor: 26 }; assert.equal(humanPage(full, fileId).next_cursor, 26);
  assert.throws(() => humanPage(full, fileId, 2));
});
test('history uses exclusive descending revision cursor and never accepts current-context flags', () => {
  const p = { ...safety, event_id: eventId, items: [revision(2), revision(1)], limit: 25, has_more: false, next_cursor: null };
  assert.equal(humanHistory(p, eventId, 3).items[0].version, 2);
  assert.throws(() => humanHistory(p, eventId, 2)); assert.throws(() => humanHistory({ ...p, items: [...p.items].reverse() }, eventId));
  assert.throws(() => humanHistory({ ...p, items: [{ ...revision(), context_changed: false }] }, eventId));
});
test('money formatting stays exact and human status never implies a posted settlement', () => {
  assert.equal(reviewMoney('999999999999999'), 'R$ 9.999.999.999.999,99'); assert.equal(reviewMoney('1'), 'R$ 0,01'); assert.equal(reviewMoney('0'), 'R$ 0,00');
  for (const value of ['1.2', '-1', '1e3', '001', 12345]) assert.throws(() => reviewMoney(value));
  assert.equal(HUMAN_REVIEW_LABELS.confirmed, 'Conferido para homologação');
  assert.match(returnReason('BANK_NUMBER_UNBOUND'), /não cria o vínculo/); assert.match(returnReason('EXACT_MATCH_HOMOLOGATION_ONLY'), /sem baixa/);
});
