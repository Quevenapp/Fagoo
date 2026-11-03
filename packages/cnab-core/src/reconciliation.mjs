import { cents, dateField, requireCnab } from './primitives.mjs';
import { isValidatedReturn } from './return.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

/** Produces review decisions only. It cannot debit, credit, cancel or settle anything. */
export function planReturnReconciliation({ parsed, titles, seenFileHashes = [], seenEventHashes = [], evidence } = {}) {
  requireCnab(isValidatedReturn(parsed) && parsed.validated === true && digest(parsed.fileHash) && Array.isArray(parsed.events), 'CNAB_VALIDATED_RETURN_REQUIRED');
  requireCnab(Array.isArray(titles) && Array.isArray(seenFileHashes) && Array.isArray(seenEventHashes)
    && [...seenFileHashes,...seenEventHashes].every(digest), 'CNAB_RECONCILIATION_INPUT_INVALID');
  const titleIds = new Set();
  for (const title of titles) {
    requireCnab(title && safeId(title.id) && !titleIds.has(title.id) && typeof title.accountScope === 'string'
      && typeof title.control === 'string' && typeof title.documentNumber === 'string'
      && (title.ourNumber === null || typeof title.ourNumber === 'string') && ['open','settled','cancelled'].includes(title.status), 'CNAB_TITLE_SNAPSHOT_INVALID');
    const nominal = cents(title.amountCents), outstanding = cents(title.outstandingCents);
    requireCnab(nominal > 0n && outstanding <= nominal, 'CNAB_TITLE_BALANCE_INVALID');
    dateField(title.dueDate); titleIds.add(title.id);
  }
  const duplicateFile = seenFileHashes.includes(parsed.fileHash);
  const trusted = evidence?.source === 'authenticated-bank-download' && evidence.fileHash === parsed.fileHash
    && evidence.accountId === parsed.accountId && safeId(evidence.reviewedBy) && safeId(evidence.referenceId);
  const seen = new Set(seenEventHashes), results = [];
  for (const event of parsed.events) {
    requireCnab(digest(event.eventHash) && digest(event.lineHash), 'CNAB_VALIDATED_EVENT_REQUIRED');
    const decision = { eventHash: event.eventHash, fileHash: parsed.fileHash, lineHash: event.lineHash, line: event.line, titleId: null, canSettle: false, action: 'REVIEW', reason: null };
    if (duplicateFile || seen.has(event.eventHash)) { decision.action = 'SKIP'; decision.reason = duplicateFile ? 'DUPLICATE_FILE' : 'DUPLICATE_EVENT'; }
    else if (!trusted) decision.reason = 'BANK_ORIGIN_EVIDENCE_REQUIRED';
    else if (event.accountScope !== parsed.accountScope || !event.control.trim() || !event.documentNumber.trim()) decision.reason = 'TITLE_REFERENCE_INCOMPLETE';
    else {
      // Exact internal reference AND bank number when bound; no fuzzy name/value matching.
      const byReference = titles.filter(title => title.accountScope === event.accountScope && title.control === event.control && title.documentNumber === event.documentNumber);
      const byNumber = event.ourNumber ? titles.filter(title => title.accountScope === event.accountScope && title.ourNumber === event.ourNumber) : [];
      if (byReference.length !== 1 || byNumber.length > 1) decision.reason = byReference.length > 1 || byNumber.length > 1 ? 'AMBIGUOUS_TITLE_MATCH' : 'TITLE_NOT_FOUND';
      else {
        const title = byReference[0]; decision.titleId = title.id;
        if ((byNumber.length === 1 && byNumber[0].id !== title.id) || (title.ourNumber !== null && title.ourNumber !== event.ourNumber)) decision.reason = 'BANK_NUMBER_MISMATCH';
        else if (title.amountCents !== event.amountCents || title.dueDate !== event.dueDate) decision.reason = 'TITLE_AMOUNT_OR_DUE_DATE_MISMATCH';
        else if (event.kind === 'REGISTERED' && title.ourNumber === null && event.ourNumber && event.bank === '077' && event.wallet === '112' && title.status === 'open') {
          decision.action = 'PROPOSE_BANK_NUMBER_BINDING_REVIEW'; decision.reason = 'REGISTRATION_MATCH_REQUIRES_REVIEW';
        } else if (title.ourNumber === null || !event.ourNumber) decision.reason = 'UNBOUND_BANK_NUMBER';
        else if (event.kind !== 'PAID') decision.reason = `BANK_EVENT_${event.kind}`;
        else if (title.status !== 'open' || title.outstandingCents !== title.amountCents) decision.reason = 'TITLE_NOT_FULLY_OPEN';
        else if (!event.creditDate || !event.occurrenceDate) decision.reason = 'PAYMENT_DATES_MISSING';
        else if (event.paidCents !== title.outstandingCents || (event.adjustments && Object.values(event.adjustments).some(value => value !== '0'))) decision.reason = 'PAYMENT_AMOUNTS_REQUIRE_REVIEW';
        else if (parsed.warnings.includes('INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION')) decision.reason = 'TRAILER_AGGREGATE_REQUIRES_REVIEW';
        else { decision.action = 'PROPOSE_SETTLEMENT_REVIEW'; decision.reason = 'EXACT_MATCH_REQUIRES_HUMAN_REVIEW'; }
      }
    }
    // This in-memory set prevents duplicate proposals inside this file. Persistence is the caller's responsibility.
    seen.add(event.eventHash); results.push(decision);
  }
  return { fileHash: parsed.fileHash, duplicateFile, financialMutationPerformed: false, canSettle: false, decisions: results,
    persistenceRequired: ['unique(accountScope, eventHash)', 'unique(accountScope, fileHash)', 'transactional-review-and-ledger-commit'] };
}
