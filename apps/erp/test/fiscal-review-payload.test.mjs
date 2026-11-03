import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFiscalReview } from '../../../packages/fiscal-core/src/review.mjs';
import { reviewBasis, reviewIds } from '../../../packages/fiscal-core/test/review-fixtures.mjs';
import { fiscalReviewView } from '../src/lib/fiscal-review-model.ts';

test('250 long lines, 250 distinct UTF-8 catalogs and 120 installments fit the browser four-MiB contract', t => {
  const basis = reviewBasis({ itemCount: 250, item: { description: 'D'.repeat(200), code: 'C'.repeat(100), unit: 'U'.repeat(16), quantity: '1.234567' } });
  const snapshot = basis.draft.record.snapshot;
  snapshot.notes = 'N'.repeat(4000); snapshot.payment_terms = 'P'.repeat(4000); snapshot.delivery_terms = 'E'.repeat(2000);
  const cents = BigInt(snapshot.totals.total.replace('.', ''));
  snapshot.installments = Array.from({ length: 120 }, (_, index) => {
    const value = cents / 120n + (BigInt(index) < cents % 120n ? 1n : 0n);
    return { position: index + 1, due_date: '2026-12-31', amount: `${value / 100n}.${String(value % 100n).padStart(2, '0')}`, method: '文'.repeat(100) };
  });
  basis.draft.pending = basis.draft.pending.filter(code => code !== 'PAYMENT_PLAN_MISSING');
  basis.catalog = snapshot.items.map((item, index) => {
    const id = 'd0000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
    const product = { ...item.product, id, name: '文'.repeat(200), code: '文'.repeat(100), unit: '文'.repeat(16), kind: 'S', format: 'E' };
    item.product_id = id; item.product = product;
    return { product_id: id, record: { ...product, version: 2, active: false, origin: '8', cest: '1234567', gtin_tax: '12345678901234' } };
  });
  basis.draft.pending.push('ITEM_KIND_REQUIRES_REVIEW');
  const report = buildFiscalReview(basis);
  const serialized = JSON.stringify(report), bytes = new TextEncoder().encode(serialized).byteLength;
  assert.equal(report.report.summary.items, 250); assert.equal(report.basis.catalog.length, 250);
  assert.equal(report.basis.draft.record.snapshot.installments.length, 120);
  assert.ok(bytes < 4 * 1024 * 1024, `Synthetic report has ${bytes} bytes`);
  t.diagnostic(`Synthetic fiscal review: ${bytes} UTF-8 bytes / 4194304-byte response limit`);
  // Exercise the same strict boundary used by the UI, including pending codes,
  // exact revision/hash and recomputation of all fiscal findings.
  const view = fiscalReviewView(JSON.parse(serialized), reviewIds.draft, 1, 'a'.repeat(64));
  assert.equal(view.report.items.length, 250); assert.equal(view.can_emit, false);
});
