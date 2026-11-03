import test from 'node:test';
import assert from 'node:assert/strict';
import { returnAmountRows } from '../src/lib/cnab-return-amounts.ts';
import { parseReturn } from '../../../packages/cnab-core/src/index.mjs';
import { planItau109NetCredit } from '../../../packages/cnab-core/src/itau-net-credit.mjs';
import { returnFile, replaceField, PROFILES } from '../../../packages/cnab-core/test/fixtures.mjs';
const fixture = () => ({ bank: '341', amount_cents: '12345', paid_cents: '12000', adjustments: { fee: '345', iof: '0', abatement: '0', discount: '0', interest: '0', otherCredits: '0' } });

test('literal RET cents are preserved, including zero, without calculating a posting or splitting mora/multa', () => {
  const event = fixture(); event.adjustments.interest = '123'; const before = structuredClone(event), rows = returnAmountRows(event);
  assert.deepEqual(event, before); assert.equal(rows.length, 8);
  assert.deepEqual(rows.find(x => x.field === 'interest'), { field: 'interest', label: 'Mora/multa (agregado)', cents: '123', formatted: 'R$ 1,23' });
  assert.equal(rows.find(x => x.field === 'paid_cents').cents, '12000');
  assert.equal(rows.find(x => x.field === 'discount').formatted, 'R$ 0,00');
  assert.ok(Object.isFrozen(rows)); assert.ok(rows.every(Object.isFrozen));
  event.adjustments.interest = '456'; assert.equal(rows.find(x => x.field === 'interest').cents, '123');
  assert.equal(rows.some(x => /^(interest_cents|penalty_cents|net_cash_cents|posting)$/.test(x.field)), false);
});
test('large cents remain exact and Inter absence is never replaced by zero adjustments', () => {
  const event = fixture(); event.amount_cents = '999999999999999';
  assert.equal(returnAmountRows(event)[0].formatted, 'R$ 9.999.999.999.999,99');
  const inter = returnAmountRows({ ...event, bank: '077', adjustments: null });
  assert.equal(inter.length, 2); assert.equal(inter.some(x => x.field === 'interest'), false);
});
test('incomplete, noncanonical or accessor-backed money is refused rather than displayed as zero', () => {
  for (const change of [x => x.amount_cents = '01', x => x.paid_cents = 12000, x => x.adjustments.fee = '-1', x => x.adjustments.iof = '1e2', x => x.adjustments.interest = '1000000000000000', x => delete x.adjustments.discount, x => x.adjustments.penalty = '0', x => x.adjustments = null, x => x.bank = '077']) {
    const event = fixture(); change(event); assert.throws(() => returnAmountRows(event));
  }
  let reads = 0; const event = fixture(); Object.defineProperty(event.adjustments, 'interest', { enumerable: true, get() { reads++; return '1'; } });
  assert.throws(() => returnAmountRows(event)); assert.equal(reads, 0);
  const badBank = fixture(); Object.defineProperty(badBank, 'bank', { enumerable: true, get() { reads++; return '341'; } });
  assert.throws(() => returnAmountRows(badBank)); assert.equal(reads, 0);
});
test('real RET parser positions flow to display unchanged and positive mora/multa remains blocked by058', async () => {
  let bytes = returnFile({ events: [{ amount: '12345', paid: '12123', fee: '345' }] });
  bytes = replaceField(bytes, 2, 267, '0000000000123');
  const parsed = await parseReturn(bytes, { profile: PROFILES.itau, century: 2000 });
  const event = parsed.events[0];
  const rows = returnAmountRows({ bank: event.bank, amount_cents: event.amountCents, paid_cents: event.paidCents, adjustments: event.adjustments });
  assert.equal(rows.find(x => x.field === 'interest').cents, '123');
  const plan = planItau109NetCredit({ bank: event.bank, wallet: event.wallet, nominal_cents: event.amountCents, credited_cents: event.paidCents, adjustments: event.adjustments, fee_category: { id: '10000000-0000-4000-8000-000000000001', version: 1, name: 'Categoria fictícia', kind: 'payable', active: true }, expected_fee_category_version: 1 });
  assert.ok(plan.issues.includes('MORA_PENALTY_UNSUPPORTED')); assert.equal(plan.posting, null);
});
