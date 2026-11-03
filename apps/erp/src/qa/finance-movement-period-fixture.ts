// QA_SYNTHETIC_FINANCE_MOVEMENT_PERIOD — GET ports in memory, no bank or financial writes.
import type { AccessController, AccessState, NativeRequestOptions } from '../lib/real-access';
const uid = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const movementPeriodIds = { actor: uid(100), otherActor: uid(101), account: uid(102), otherAccount: uid(103) };
export function createMovementPeriodFixture() {
  const ids = movementPeriodIds, kinds = ['opening', 'payment', 'reversal', 'transfer_out', 'transfer_in', 'bank_fee', 'bank_fee_reversal'];
  const account = { id: ids.account, name: 'Conta fictícia', kind: 'bank', active: true, opening_recorded: true, version: 1, balance_cents: '123456' };
  const items = Array.from({ length: 30 }, (_, i) => ({ id: uid(i + 1), created_at: '2026-10-17T12:00:00Z', account_id: ids.account,
    settlement_id: null, transfer_id: null, kind: kinds[i % kinds.length], delta_cents: i % 2 ? '-12345' : '12345',
    posted_on: i < 15 ? '2026-10-01' : '2026-10-17', note: `Movimento fictício ${i + 1}` }));
  let state: AccessState = { phase: 'ready', membership: { role: 'consulta', user_id: ids.actor, resources: [], data_mode: 'staging_readonly' }, records: null, listPending: false, loginPending: false, message: null, logoutFailed: false };
  const listeners = new Set<() => void>(), calls: { path: string; options: NativeRequestOptions }[] = [];
  const response = (path: string) => {
    const u = new URL(path, 'https://synthetic.invalid');
    if (u.pathname !== '/v1/financeiro/movements' || u.searchParams.get('parent_id') !== ids.account || u.searchParams.get('limit') !== '25'
      || [...u.searchParams.keys()].some(k => !['parent_id', 'limit', 'from', 'to', 'after'].includes(k))) throw Error('QA_ROUTE_REJECTED');
    const from = u.searchParams.get('from'), to = u.searchParams.get('to'), after = u.searchParams.get('after');
    const found = items.filter(x => (!from || x.posted_on >= from) && (!to || x.posted_on <= to) && (!after || x.id > after));
    const rows = found.slice(0, 25);
    return { entity: 'movements', data_mode: 'erp_native', items: structuredClone(rows), limit: 25, has_more: found.length > 25, next_cursor: found.length > 25 ? rows.at(-1)!.id : null };
  };
  const controller = {
    getSnapshot: () => state, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async finance(path: string, options: NativeRequestOptions = {}) {
      if (options.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      if ((options.method ?? 'GET') !== 'GET' || options.body !== undefined) throw Error('QA_READ_ONLY');
      calls.push({ path, options }); return response(path);
    },
  } as unknown as AccessController;
  return { controller, account, items, calls, response, setSession(next: AccessState) { state = next; for (const fn of listeners) fn(); } };
}
