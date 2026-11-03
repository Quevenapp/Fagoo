import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginClient } from '../src/client.mjs';
import { collectPriorityStock } from '../src/stock-priority.mjs';
import { syncPage } from '../src/sync.mjs';
import { getResource } from '../src/resources.mjs';

function fixture({ maximum = 120, status, omit = false, count = 100, at = 1000 } = {}) {
  let time = at, checkpoint = {}, calls = 0;
  const rows = Array.from({ length: count }, (_, i) => String(i + 1).padStart(4, '0'));
  const writes = [], releases = [], options = [];
  const repo = {
    async claim() { return { acquired: true, lease_token: 'fixture', checkpoint_version: writes.length, checkpoint: structuredClone(checkpoint) }; },
    async rpc(name, args) {
      assert.equal(name, 'origin_sync_stock_product_page');
      const items = rows.filter(id => args.p_after === null || id > args.p_after).slice(0, args.p_limit);
      const more = items.length > 0 && rows.at(-1) > items.at(-1);
      return { items, has_more: more, next_cursor: more ? items.at(-1) : null, coverage_complete: false };
    },
    async apply(...args) { writes.push(args); checkpoint = structuredClone(args[5]); return { inserted: args[4].length }; },
    async release(...args) { releases.push(args); }, async renew() {},
  };
  const client = new OriginClient('synthetic-stock', { apiOrigin: 'https://api.provider.example', maxRequests: maximum, now: () => time,
    sleep: async ms => { time += ms; }, fetchImpl: async (url, init) => {
      calls++; assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      if (status) return new Response('', { status });
      const query = new URL(url).searchParams;
      return Response.json({ data: omit || query.get('filtroSaldoEstoque') !== '0' ? []
        : query.getAll('idsProdutos[]').map(id => ({ produto: { id }, saldoFisicoTotal: 2, depositos: [] })) });
    } });
  const runPage = (scoped, deadline) => {
    options.push(deadline);
    return syncPage(repo, scoped, getResource('stock_balances'), 'fixture', { SYNC_TIME_ZONE: 'America/Sao_Paulo' }, new Date(time),
      { deadline, clock: () => time, boundDatabase: true });
  };
  return { client, repo, runPage, writes, releases, options, clock: () => time,
    advance: ms => { time += ms; }, calls: () => calls, checkpoint: () => checkpoint };
}

test('priority advances exactly three existing stock pages using nine real GETs and the same cursor', async () => {
  const f = fixture(), result = await collectPriorityStock(f.client, f.runPage, { deadline: 161000, clock: f.clock });
  assert.equal(result.batches, 3); assert.equal(result.requested, 75); assert.equal(result.returned, 75);
  assert.equal(result.requests, 9); assert.equal(f.calls(), 9); assert.equal(f.client.remainingRequests, 111);
  assert.equal(f.checkpoint().unfiltered.after, '0075'); assert.equal(result.coverage_complete, false);
  assert.equal(f.writes.length, 3); assert.equal(f.releases.length, 3);
  assert.ok(f.options.every(v => v === 46000));
  assert.ok(f.writes.every(a => a[6].deadline === 46000));
  assert.ok(f.releases.every(a => a[3].deadline === 46000));
});

test('priority leaves fourteen requests and stops on a completed sweep pause without re-reading', async () => {
  const limited = fixture({ maximum: 17 });
  const one = await collectPriorityStock(limited.client, limited.runPage, { deadline: 161000, clock: limited.clock });
  assert.equal(one.batches, 1); assert.equal(one.requests, 3); assert.equal(limited.client.remainingRequests, 14);
  const end = fixture({ count: 27 });
  const two = await collectPriorityStock(end.client, end.runPage, { deadline: 161000, clock: end.clock });
  assert.equal(two.batches, 2); assert.equal(two.requested, 27); assert.equal(two.requests, 6);
  assert.equal(end.checkpoint().unfiltered, undefined); assert.ok(end.checkpoint().next_attempt_at);
});

test('missing upstream rows advance only the staging cursor and never synthesize stock', async () => {
  const f = fixture({ omit: true });
  const result = await collectPriorityStock(f.client, f.runPage, { deadline: 161000, clock: f.clock });
  assert.equal(result.requested, 75); assert.equal(result.returned, 0); assert.equal(result.unavailable, 75);
  assert.ok(f.writes.every(a => a[4].length === 0)); assert.equal(f.checkpoint().unfiltered.after, '0075');
});

for (const status of [401, 403, 429, 503]) test(`HTTP${status} makes exactly one real attempt and preserves the stock cursor`, async () => {
  const f = fixture({ status });
  const result = await collectPriorityStock(f.client, f.runPage, { deadline: 161000, clock: f.clock });
  assert.equal(f.calls(), 1); assert.equal(result.requests, 1); assert.equal(result.batches, 0);
  assert.equal(result.status, 'partial'); assert.equal(result.stop_json, [401, 429].includes(status));
  assert.equal(result.stop_residual, [401, 403, 429].includes(status));
  assert.equal(f.checkpoint().unfiltered, undefined); assert.equal(f.checkpoint().failure.http_status, status);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][4].length, 0);
});

test('insufficient time or budget performs no resource claim or upstream request', async () => {
  for (const settings of [{ maximum: 16, deadline: 161000 }, { maximum: 120, deadline: 35000 }]) {
    const f = fixture(settings); let claims = 0;
    const result = await collectPriorityStock(f.client, async (...args) => { claims++; return f.runPage(...args); },
      { deadline: settings.deadline, clock: f.clock });
    assert.equal(claims, 0); assert.equal(f.calls(), 0); assert.equal(result.attempted, false);
    assert.match(result.status, /^skipped_(budget|time)$/);
  }
});

test('delayed database work never starts the next stock GET after the phase deadline', async () => {
  const f = fixture(); const read = f.repo.rpc;
  f.repo.rpc = async (...args) => { const result = await read(...args); f.advance(46000); return result; };
  const result = await collectPriorityStock(f.client, f.runPage, { deadline: 161000, clock: f.clock });
  assert.equal(f.calls(), 0); assert.equal(f.writes.length, 0); assert.equal(result.batches, 0);
  assert.equal(f.releases.length, 1); assert.equal(result.status, 'partial');
});

test('an uncertain database acknowledgement stops the phase and all subsequent JSON work', async () => {
  const f = fixture(); let applyCalls = 0;
  f.repo.apply = async () => { applyCalls++; throw new Error('DATABASE_UNAVAILABLE'); };
  const result = await collectPriorityStock(f.client, f.runPage, { deadline: 161000, clock: f.clock });
  assert.equal(applyCalls, 1); assert.equal(f.calls(), 3); assert.equal(result.batches, 0);
  assert.equal(result.stop_json, true); assert.equal(result.stop_residual, true);
  assert.equal(f.releases.length, 1);
});
