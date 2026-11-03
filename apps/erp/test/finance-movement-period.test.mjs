import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFinanceMovementQuery, financeMovementPath, financeMovementPage } from '../src/lib/finance-movement-period.ts';
import { parseFinanceRoute, executeFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

const id = n => `95000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query = (values = {}) => ({ accountId: id(100), from: '2026-10-01', to: '2026-10-31', after: null, ...values });
const row = (n = 1, values = {}) => ({ id: id(n), created_at: '2026-10-17T12:00:00Z', account_id: id(100), settlement_id: null, transfer_id: null, kind: 'opening', delta_cents: '100', posted_on: '2026-10-17', note: null, ...values });
const page = (items = [row()], values = {}) => ({ entity: 'movements', data_mode: 'erp_native', items, limit: 25, has_more: false, next_cursor: null, ...values });

test('query uses the existing GET contract and inclusive dates, with no kind/status or implicit date', async () => {
  for (const selected of [query(), query({ from: '', to: '' }), query({ from: '', to: '2026-10-31' }), query({ to: '', after: id(12) })]) {
    const captured = captureFinanceMovementQuery(selected), path = financeMovementPath(captured);
    const route = await parseFinanceRoute(new Request(`https://erp.invalid${path}`));
    assert.equal(route.kind, 'list'); assert.equal(route.entity, 'movements'); assert.equal(route.rpc, 'erp_finance_list');
    assert.equal(route.args.p_limit, 25); assert.equal(route.args.p_parent_id, selected.accountId);
    assert.equal(route.args.p_from, selected.from || null); assert.equal(route.args.p_to, selected.to || null);
    assert.equal(route.args.p_after, selected.after); assert.equal(route.args.p_kind, null);
    assert.equal(route.args.p_status, null); assert.equal(route.args.p_query, null);
  }
});
test('dates use the existing validator: leap days and boundaries accepted; impossible/reversed/time-stamped dates refused', () => {
  for (const values of [{ from: '2024-02-29' }, { from: '1900-01-01', to: '2100-12-31' }, { from: '2026-10-17', to: '2026-10-17' }]) assert.doesNotThrow(() => captureFinanceMovementQuery(query(values)));
  for (const values of [{ from: '2026-02-29' }, { to: '2026-04-31' }, { from: '1899-12-31' }, { to: '2101-01-01' }, { from: '2026-11-01' }, { from: '2026-10-01T00:00:00Z' }, { to: ' 2026-10-31' }, { from: null }]) assert.throws(() => captureFinanceMovementQuery(query(values)), /FINANCE_MOVEMENT_PERIOD_INVALID/);
});
test('selection is copied before a request; getters and hidden extra filters cannot change it', () => {
  const input = query(), captured = captureFinanceMovementQuery(input);
  input.accountId = id(101); input.from = '2026-10-30';
  assert.equal(captured.accountId, id(100)); assert.equal(captured.from, '2026-10-01'); assert.ok(Object.isFrozen(captured));
  for (const changes of [{ kind: 'payment' }, { status: 'paid' }, { after: 'bad' }, { accountId: 'bad' }]) assert.throws(() => captureFinanceMovementQuery({ ...query(), ...changes }));
  let reads = 0; const accessor = query(); Object.defineProperty(accessor, 'from', { get() { reads++; return '2026-10-01'; } });
  assert.throws(() => captureFinanceMovementQuery(accessor)); assert.equal(reads, 0);
});
test('HTTP projection and page binding preserve all seven movement kinds, exact signed cents and original UUID order', async () => {
  const kinds = ['opening', 'payment', 'reversal', 'transfer_out', 'transfer_in', 'bank_fee', 'bank_fee_reversal'];
  const items = kinds.map((kind, index) => row(index + 1, { kind, delta_cents: index % 2 ? '-999999999999999999999999999999' : '123', posted_on: index % 2 ? '2026-10-01' : '2026-10-31', actor: id(600) }));
  const selected = captureFinanceMovementQuery(query()), route = await parseFinanceRoute(new Request(`https://erp.invalid${financeMovementPath(selected)}`));
  const projected = await executeFinanceRoute(route, { userId: id(500), rpc: async (rpc, args) => {
    assert.equal(rpc, 'erp_finance_list'); assert.equal(args.p_user_id, id(500)); assert.equal(args.p_kind, null); return page(items);
  } });
  const out = financeMovementPage(projected, selected);
  assert.deepEqual(out.items.map(x => x.kind), kinds); assert.deepEqual(out.items.map(x => x.delta_cents), items.map(x => x.delta_cents));
  assert.deepEqual(out.items.map(x => x.posted_on), items.map(x => x.posted_on));
  assert.ok(out.items.every(x => !Object.hasOwn(x, 'actor'))); assert.ok(Object.isFrozen(out.items)); assert.ok(out.items.every(Object.isFrozen));
  assert.equal(Object.keys(out).some(x => /balance|total|sum|opening|closing/.test(x)), false);
});
test('a page for another account or outside the selected inclusive dates is refused rather than silently filtered', () => {
  const selected = query({ from: '2026-10-17', to: '2026-10-17' });
  assert.equal(financeMovementPage(page(), selected).items.length, 1);
  for (const changes of [{ account_id: id(101) }, { posted_on: '2026-10-16' }, { posted_on: '2026-10-18' }, { posted_on: '2026-02-30' }]) assert.throws(() => financeMovementPage(page([row(1, changes)]), selected), /FINANCE_MOVEMENT_PAGE_INVALID/);
});
test('cursor boundaries, duplicates and next-page metadata bind to the exact request', () => {
  const items = Array.from({ length: 25 }, (_, i) => row(i + 11)), selected = query({ after: id(10) });
  const out = financeMovementPage(page(items, { has_more: true, next_cursor: id(35) }), selected);
  assert.equal(out.next_cursor, id(35)); assert.equal(out.items.length, 25);
  for (const bad of [page([row(10)]), page([row(12), row(11)]), page([row(11), row(11)]), page(items, { has_more: true, next_cursor: id(34) }), page([row(11)], { has_more: true, next_cursor: id(11) }), page(items, { next_cursor: id(35) }), page(items, { limit: 100 })]) assert.throws(() => financeMovementPage(bad, selected));
});
test('empty page means no rows in that query only; page capture has no mutable reference to source records', () => {
  assert.deepEqual(financeMovementPage(page([]), query()).items, []);
  const input = page(), out = financeMovementPage(input, query()); input.items[0].delta_cents = '999'; input.items.push(row(2));
  assert.equal(out.items.length, 1); assert.equal(out.items[0].delta_cents, '100'); assert.equal(out.has_more, false);
});
test('malformed money, unknown operation and accessor-backed response are refused without running accessors', () => {
  for (const changes of [{ delta_cents: 100 }, { delta_cents: '1e2' }, { delta_cents: '1'.repeat(31) }, { kind: 'invented' }, { note: {} }, { transfer_id: 'bad' }]) assert.throws(() => financeMovementPage(page([row(1, changes)]), query()));
  let reads = 0; const input = row(); Object.defineProperty(input, 'delta_cents', { enumerable: true, get() { reads++; return '100'; } });
  assert.throws(() => financeMovementPage(page([input]), query())); assert.equal(reads, 0);
});
